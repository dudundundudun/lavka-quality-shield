"""
Lavka Quality Shield — AI Review Cache & Product Analysis Router
"""

import asyncio
import json
import re
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
from bs4 import BeautifulSoup
from collections import deque
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import db
from matcher import (
    REVIEW_SEARCH_SITES,
    build_full_product_search_query,
    detect_source_label,
    extract_competitor_prices_from_sources,
    is_search_result_matching_product,
    normalize_title_for_match,
)
from security import validate_ai_base_url, verify_trusted_extension_request

router = APIRouter()

ANALYZE_RATE_LIMIT_MAX_REQUESTS = 12
ANALYZE_RATE_LIMIT_WINDOW_SEC = 60.0
_analyze_uncached_timestamps: "deque[float]" = deque()


def reset_analyze_rate_limiter() -> None:
    _analyze_uncached_timestamps.clear()


def _check_and_record_analyze_rate_limit(now: Optional[float] = None) -> None:
    ts = time.monotonic() if now is None else now
    cutoff = ts - ANALYZE_RATE_LIMIT_WINDOW_SEC
    while _analyze_uncached_timestamps and _analyze_uncached_timestamps[0] <= cutoff:
        _analyze_uncached_timestamps.popleft()
    if len(_analyze_uncached_timestamps) >= ANALYZE_RATE_LIMIT_MAX_REQUESTS:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded: max {ANALYZE_RATE_LIMIT_MAX_REQUESTS} uncached AI analyses per minute.",
        )
    _analyze_uncached_timestamps.append(ts)


class AnalyzeRequest(BaseModel):
    slug: Optional[str] = None
    title: str
    brand: Optional[str] = None
    amount: Optional[str] = None
    price: Optional[float] = None
    oldPrice: Optional[float] = None
    accountId: Optional[str] = "Аккаунт #1"
    ingredients: Optional[str] = None
    traits: Optional[str] = None
    pricePerKg: Optional[int] = None
    unitLabel: Optional[str] = None
    pricePerPiece: Optional[int] = None
    pieceUnitLabel: Optional[str] = None
    piecesCount: Optional[int] = None
    proteinPer100g: Optional[float] = None
    pricePer100gProtein: Optional[int] = None
    pricingSummary: Optional[str] = None
    aiBaseUrl: str = "http://localhost:8083/v1"
    aiApiKey: str = ""
    aiModel: str = ""
    forceRefresh: bool = False


class SaveCacheRequest(BaseModel):
    slug: str
    title: str
    verdict: str
    sources: List[Dict[str, Any]] = []



@router.post("/api/save-cache", dependencies=[Depends(verify_trusted_extension_request)])
def save_cache_endpoint(req: SaveCacheRequest):
    cache_key = (req.slug or req.title).strip().lower()
    if not cache_key or not req.verdict.strip():
        return {"status": "ignored"}
    with db.get_db_connection() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO product_ai_cache (slug, title, norm_title, verdict, sources_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                cache_key,
                req.title,
                normalize_title_for_match(req.title),
                req.verdict.strip(),
                json.dumps(req.sources or [], ensure_ascii=False),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
    db.log_event("CACHE_SAVE", f"Saved browser-tab Gemini verdict for '{cache_key}' into SQLite")
    return {"status": "ok"}


# ==============================================================================
# ТОЧНЫЙ ПОИСК ИДЕНТИЧНЫХ ПРОДУКТОВ И ФИЛЬТР МОДИФИКАТОРОВ (БЕЗ САХАРА / ОБЪЁМ)
# ==============================================================================
async def run_ddg_query(client: httpx.AsyncClient, query: str, headers: Dict[str, str]) -> List[Dict[str, Any]]:
    url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
    resp = await client.get(url, headers=headers)
    items: List[Dict[str, Any]] = []
    if resp.status_code != 200:
        return items
    soup = BeautifulSoup(resp.text, "html.parser")
    for block in soup.select(".result")[:10]:
        a_el = block.select_one(".result__a")
        snip_el = block.select_one(".result__snippet")
        if not a_el:
            continue
        raw_href = a_el.get("href", "")
        if "uddg=" in raw_href:
            parsed_qs = urllib.parse.parse_qs(urllib.parse.urlparse(raw_href).query)
            real_url = parsed_qs.get("uddg", [raw_href])[0]
        else:
            real_url = raw_href
        if not real_url.startswith("http"):
            continue
        source_name, is_trusted = detect_source_label(real_url)
        raw_title = a_el.get_text(" ", strip=True)[:95]
        snippet = snip_el.get_text(" ", strip=True) if snip_el else ""
        items.append(
            {
                "title": f"[{source_name}] {raw_title}",
                "source": source_name,
                "trusted": is_trusted,
                "snippet": snippet,
                "url": real_url,
            }
        )
    return items


async def search_web_reviews(
    product_title: str, brand: Optional[str] = None, amount: Optional[str] = None
) -> List[dict]:
    full_q = build_full_product_search_query(product_title, brand, amount)
    if not full_q:
        return []

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6",
    }

    # Если товар «без сахара», фиксируем кавычками обязательное вхождение "без сахара"
    strict_q = full_q
    if re.search(r"без\s+сахара", strict_q, re.IGNORECASE):
        strict_q = re.sub(r"без\s+сахара", '"без сахара"', strict_q, flags=re.IGNORECASE)

    q_sites_primary = (
        f"{strict_q} цена отзывы "
        f"(site:otzovik.com OR site:irecommend.ru OR site:vkusvill.ru OR site:perekrestok.ru OR site:ozon.ru OR site:lenta.com OR site:rskrf.ru)"
    )
    q_fallback = f"{strict_q} купить цена отзывы"

    collected: List[Dict[str, Any]] = []
    seen_urls = set()
    t0 = time.perf_counter()

    try:
        async with httpx.AsyncClient(timeout=7.5, follow_redirects=True) as client:
            primary_hits = await run_ddg_query(client, q_sites_primary, headers)
            for item in primary_hits:
                if item["url"] in seen_urls:
                    continue
                same_prod, same_vol = is_search_result_matching_product(
                    item.get("title", ""), item.get("snippet", ""), product_title, amount
                )
                if not same_prod:
                    continue
                item["sameVolume"] = same_vol
                seen_urls.add(item["url"])
                collected.append(item)

            if len(collected) < 3:
                fallback_hits = await run_ddg_query(client, q_fallback, headers)
                fallback_hits.sort(key=lambda x: (0 if x.get("trusted") else 1))
                for item in fallback_hits:
                    if item["url"] in seen_urls:
                        continue
                    same_prod, same_vol = is_search_result_matching_product(
                        item.get("title", ""), item.get("snippet", ""), product_title, amount
                    )
                    if not same_prod:
                        continue
                    item["sameVolume"] = same_vol
                    seen_urls.add(item["url"])
                    collected.append(item)
                    if len(collected) >= 6:
                        break

            dt_ms = int((time.perf_counter() - t0) * 1000)
            db.log_event(
                "SEARCH",
                f"Exact match search for '{full_q[:42]}' -> {len(collected)} verified sources in {dt_ms}ms",
            )
    except Exception as exc:
        db.log_event("ERROR", f"Review search error for '{full_q[:42]}': {exc}")

    return collected[:6]


def build_pricing_context(req: AnalyzeRequest, price_summary: Optional[Dict[str, Any]] = None) -> Tuple[str, str, str]:
    price_per_kg = req.pricePerKg
    unit_label = req.unitLabel or "кг"
    price_per_piece = req.pricePerPiece
    piece_unit = req.pieceUnitLabel or "шт"
    pieces_count = req.piecesCount
    protein = req.proteinPer100g
    protein_cost = req.pricePer100gProtein

    if price_per_kg is None and price_per_piece is None and req.amount and req.price:
        amt = req.amount.strip()
        m_multi = re.search(
            r"(\d+)\s*(?:[×xх*]|шт\.?\s*по|пакет[а-я]*\s*по)\s*([\d.,]+)\s*(г|гр|грамм|кг|мл|л)(?![а-яёa-z])",
            amt,
            re.IGNORECASE,
        )
        if m_multi:
            cnt = int(m_multi.group(1))
            val = float(m_multi.group(2).replace(",", "."))
            u = m_multi.group(3).lower()
            unit_label = "л" if u in ("мл", "л") else "кг"
            grams = cnt * (val * 1000 if u in ("кг", "л") else val)
            if grams > 0:
                price_per_kg = round((req.price / grams) * 1000)
        else:
            m_single = re.search(
                r"([\d.,]+)\s*(г|гр|грамм|кг|мл|л|литр[а-я]*)(?![а-яёa-z])",
                amt,
                re.IGNORECASE,
            )
            if m_single:
                val = float(m_single.group(1).replace(",", "."))
                u = m_single.group(2).lower()
                unit_label = "л" if u.startswith(("мл", "л")) else "кг"
                grams = val * 1000 if u.startswith(("кг", "л")) else val
                if grams > 0:
                    price_per_kg = round((req.price / grams) * 1000)
            else:
                m_piece = re.search(
                    r"(\d+)\s*(шт|штук[а-я]*|пакет[а-я]*|капс[а-я]*|табл[а-я]*|рулон[а-я]*|порц[а-я]*|пар[а-я]*|уп[а-я]*)(?![а-яёa-z])",
                    amt,
                    re.IGNORECASE,
                )
                if m_piece:
                    pieces_count = int(m_piece.group(1))
                    if pieces_count > 0:
                        price_per_piece = round(req.price / pieces_count)

    extra_intel = []
    if price_summary:
        if price_summary.get("minPrice") and req.price and price_summary["minPrice"] < req.price:
            extra_intel.append(f"исторический минимум в твоей базе: {price_summary['minPrice']} ₽")
        if price_summary.get("competitorSummary"):
            extra_intel.append(f"цены в других сетях: {price_summary['competitorSummary']}")

    intel_str = f" | Радар цен: {'; '.join(extra_intel)}" if extra_intel else ""

    if price_per_kg:
        if protein_cost and protein and protein >= 3:
            calc_line = (
                f"в пересчёте ~{price_per_kg} ₽/{unit_label}; "
                f"стоимость 100 г белка ~{protein_cost} ₽ (белка {protein} г на 100 г){intel_str}"
            )
            eval_hint = f"в пересчёте на 1 {unit_label} (~{price_per_kg} ₽/{unit_label}), стоимости белка (~{protein_cost} ₽ за 100 г) и сравнения с другими магазинами/аккаунтами"
            rule_line = f"Для этого товара известна точная цена за 1 {unit_label} (~{price_per_kg} ₽/{unit_label}) и за 100 г белка (~{protein_cost} ₽) — используй эти цифры при оценке выгоды."
        else:
            calc_line = f"в пересчёте ~{price_per_kg} ₽/{unit_label}{intel_str}"
            eval_hint = f"в пересчёте на 1 {unit_label} (~{price_per_kg} ₽/{unit_label})"
            rule_line = (
                f"Для этого товара известна цена за 1 {unit_label} (~{price_per_kg} ₽/{unit_label}). "
                f"Стоимость белка отдельно не оценивай, если это не белковый продукт."
            )
    elif price_per_piece and pieces_count and pieces_count > 1:
        calc_line = f"поштучная фасовка ({pieces_count} {piece_unit}) — ~{price_per_piece} ₽ за 1 {piece_unit}, вес в граммах не указан{intel_str}"
        eval_hint = f"в пересчёте за 1 {piece_unit} (~{price_per_piece} ₽/{piece_unit}) и за всю упаковку"
        rule_line = (
            f"Товар продаётся поштучно ({pieces_count} {piece_unit}, ~{price_per_piece} ₽/{piece_unit}) без указания веса в граммах — "
            f"НЕ пытайся считать цену за килограмм, оценивай выгоду за 1 {piece_unit} и упаковку."
        )
    else:
        calc_line = f"вес в граммах не указан (оценка за упаковку / 1 шт.){intel_str}"
        eval_hint = "за саму упаковку / штуку (без пересчёта за килограмм)"
        rule_line = (
            "На карточке этого товара не указан вес в граммах или миллилитрах — "
            "НЕ пытайся выдумывать или требовать цену за килограмм, оценивай адекватность цены за саму штуку/упаковку."
        )

    return calc_line, eval_hint, rule_line


def build_ai_prompt(req: AnalyzeRequest, web_snippets: List[dict], price_summary: Optional[Dict[str, Any]] = None) -> str:
    sites_list_str = ", ".join([f"{s['name']} ({s['domain']})" for s in REVIEW_SEARCH_SITES[:12]])
    if web_snippets:
        snippets_text = "\n".join(
            [f"- {s.get('title', 'Источник')} ({s.get('url', '')}): {s.get('snippet', '')}" for s in web_snippets]
        )
    else:
        snippets_text = (
            "Прямых отзывов именно на эту модификацию товара в поисковой выдаче не найдено — "
            "честно сообщи об этом в 1-м пункте и оценивай товар строго по составу, КБЖУ и цене."
        )

    calc_line, eval_hint, pricing_rule = build_pricing_context(req, price_summary)
    brand_suffix = f" (Бренд: {req.brand})" if req.brand else ""

    return (
        f"Ты — опытный, внимательный и объективный продуктовый эксперт. "
        f"Сделай короткий и понятный разбор товара из Яндекс Лавки (ровно 3 пункта, без воды, без молодёжного сленга и без выдумок — нормальным разговорным русским языком).\n\n"
        f"Данные карточки товара:\n"
        f"• Точное название: {req.title}{brand_suffix}\n"
        f"• Фасовка и цена: {req.amount or 'не указана'}, Цена: {req.price or '?'} ₽ ({calc_line})\n"
        f"• Состав: {req.ingredients or 'не указан на странице'}\n"
        f"• КБЖУ на 100 г: {req.traits or 'не указано на странице'}\n\n"
        f"Площадки для поиска отзывов и цен: {sites_list_str}.\n"
        f"Найденные отзывы и цены в интернете (проверены на совпадение модификации):\n{snippets_text}\n\n"
        f"СТРОГИЕ ПРАВИЛА ЧЕСТНОСТИ (ТОЛЬКО ФАКТЫ, БЕЗ ПРИДУМОК):\n"
        f"- Оценивай СТРОГО ИМЕННО ЭТОТ ТОВАР и его точную модификацию («{req.title} {req.amount or ''}»). Не путай версии «без сахара» / «Zero» с обычными сахарными версиями!\n"
        f"- Опирайся ТОЛЬКО на реальные факты из найденных отзывов, состава, КБЖУ и цены.\n"
        f"- Если в блоке «Найденные отзывы и цены в интернете» нет отзывов именно об этом продукте — ЧЕСТНО напиши в 1-м пункте: «Отзывов именно на этот товар в сети не нашлось, поэтому оцениваю по составу и характеристикам». Категорически запрещено выдумывать вкус, консистенцию или якобы существующие мнения покупателей.\n"
        f"- {pricing_rule}\n\n"
        f"Ответь ровно в 3 коротких пунктах (по 1–2 предложения в каждом), обычным живым русским языком без сленга:\n"
        f"1. **Отзывы и репутация**: что реально пишут покупатели на отзовиках и в магазинах именно про эту версию товара (укажи площадки, если отзывы найдены), либо честно отметь, что отзывов в сети не найдено, и скажи, что сразу видно по характеристикам продукта.\n"
        f"2. **Состав, КБЖУ и честность цены**: фактический разбор состава (подсластители/сахар, крахмал, ММО, ЗМЖ, добавки или чистый состав) и насколько адекватна цена ({eval_hint}).\n"
        f"3. **Вердикт**: выбери ОДНУ оценку на нормальном русском языке и кратко поясни вывод:\n"
        f"   • ✅ **Отличный выбор — стоит брать**\n"
        f"   • 👍 **Хороший вариант на каждый день (есть мелкие нюансы)**\n"
        f"   • ⚠️ **На любителя — есть компромиссы по составу или цене**\n"
        f"   • ❌ **Не рекомендую к покупке**"
    )


async def call_ai_model(req: AnalyzeRequest, web_snippets: List[dict], price_summary: Optional[Dict[str, Any]] = None) -> str:
    prompt = build_ai_prompt(req, web_snippets, price_summary)

    base_url = validate_ai_base_url(req.aiBaseUrl)
    is_local = "localhost" in base_url or "127.0.0.1" in base_url

    headers = {"Content-Type": "application/json"}
    if req.aiApiKey:
        headers["Authorization"] = f"Bearer {req.aiApiKey}"

    t0 = time.perf_counter()
    timeout_cfg = httpx.Timeout(18.0, connect=1.5)
    async with httpx.AsyncClient(timeout=timeout_cfg, trust_env=not is_local) as client:
        model_id = (req.aiModel or "").strip()
        if not model_id:
            m_resp = await client.get(f"{base_url}/models", headers=headers)
            m_resp.raise_for_status()
            m_data = m_resp.json()
            models_arr = m_data.get("data", []) if isinstance(m_data, dict) else (m_data if isinstance(m_data, list) else [])
            for m in models_arr:
                cand = m.get("id") if isinstance(m, dict) else (str(m) if isinstance(m, str) else "")
                if cand:
                    model_id = cand
                    break
        if not model_id:
            raise ValueError("AI model is not configured and /models returned an empty list.")

        payload = {
            "model": model_id,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
        }
        resp = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
        dt_ms = int((time.perf_counter() - t0) * 1000)
        resp.raise_for_status()
        data = resp.json()
        reply = data["choices"][0]["message"]["content"].strip()
        db.log_event("LLM_OK", f"Model '{model_id}' @ {base_url} replied in {dt_ms}ms ({len(reply)} chars)")
        return reply


def _lookup_cached_analysis_sync(cache_key: str, norm_title: str, title: str) -> Optional[Dict[str, Any]]:
    with db.get_db_connection() as conn:
        row = conn.execute(
            "SELECT verdict, sources_json FROM product_ai_cache WHERE slug = ?",
            (cache_key,),
        ).fetchone()
        if not row and norm_title:
            row = conn.execute(
                "SELECT verdict, sources_json FROM product_ai_cache WHERE norm_title = ? OR LOWER(title) = ? ORDER BY updated_at DESC LIMIT 1",
                (norm_title, norm_title),
            ).fetchone()
        if row and row[0] and not str(row[0]).startswith("⚠️"):
            s_row = db.find_existing_summary_row_by_slug_or_title(conn, cache_key, title)
            cached_summary = None
            if s_row:
                cached_summary = {
                    "slug": s_row[0],
                    "title": s_row[1],
                    "amount": s_row[2],
                    "minPrice": s_row[3],
                    "maxPrice": s_row[4],
                    "avgPrice": s_row[5],
                    "lastPrice": s_row[6],
                    "competitorMinPrice": s_row[8],
                    "competitorSummary": s_row[9],
                    "competitorOffers": json.loads(s_row[10] or "[]"),
                    "accounts": json.loads(s_row[11] or "{}"),
                    "history": json.loads(s_row[12] or "[]"),
                    "updatedAt": s_row[13],
                }
            db.log_event("CACHE_HIT", f"Returned SQLite cached verdict for '{cache_key}'")
            return {
                "cached": True,
                "aiOk": True,
                "verdict": row[0],
                "sources": json.loads(row[1] or "[]"),
                "priceSummary": cached_summary,
            }
    return None


def _record_analysis_price_sync(
    cache_key: str,
    req: AnalyzeRequest,
    comp_min: Optional[float],
    comp_sum: Optional[str],
    comp_offers: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    if not (req.price and req.price > 0):
        return None
    with db.get_db_connection() as conn:
        price_summary = db.upsert_price_observation_sync(
            conn=conn,
            slug=cache_key,
            title=req.title,
            account_id=req.accountId or "Аккаунт #1",
            price=req.price,
            old_price=req.oldPrice,
            amount=req.amount or "",
            competitor_min=comp_min,
            competitor_summary=comp_sum,
            competitor_offers=comp_offers,
        )
        conn.commit()
        return price_summary


def _save_ai_cache_sync(
    cache_key: str, title: str, norm_title: str, verdict: str, sources: List[Dict[str, Any]]
) -> None:
    with db.get_db_connection() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO product_ai_cache (slug, title, norm_title, verdict, sources_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                cache_key,
                title,
                norm_title,
                verdict,
                json.dumps(sources, ensure_ascii=False),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()


@router.post("/api/analyze-product", dependencies=[Depends(verify_trusted_extension_request)])
async def analyze_product(req: AnalyzeRequest):
    validate_ai_base_url(req.aiBaseUrl)
    cache_key = (req.slug or req.title).strip().lower()
    norm_title = normalize_title_for_match(req.title)
    await asyncio.to_thread(
        db.log_event,
        "REQ",
        f"Analyze request for slug='{cache_key}' title='{req.title[:35]}' (force={req.forceRefresh})",
    )

    # Сначала проверяем кэш ИИ (включая поиск по нормализованному названию для связки SEO-slug <-> HEX-ID)
    if not req.forceRefresh:
        cached_resp = await asyncio.to_thread(_lookup_cached_analysis_sync, cache_key, norm_title, req.title)
        if cached_resp:
            return cached_resp

    _check_and_record_analyze_rate_limit()

    sources = await search_web_reviews(req.title, req.brand, req.amount)
    comp_min, comp_sum, comp_offers = extract_competitor_prices_from_sources(
        sources, req.price, req.title, req.amount
    )

    price_summary = await asyncio.to_thread(
        _record_analysis_price_sync, cache_key, req, comp_min, comp_sum, comp_offers
    )

    ai_ok = True
    try:
        verdict = await call_ai_model(req, sources, price_summary)
    except Exception as exc:
        ai_ok = False
        await asyncio.to_thread(
            db.log_event,
            "LLM_ERR",
            f"AI call failed ({req.aiModel} @ {req.aiBaseUrl}): {exc} -> handing off to Browser Gemini Tab",
        )
        verdict = (
            f"⚠️ Ошибка вызова ИИ ({req.aiModel} @ {req.aiBaseUrl}): {exc}\n"
            f"Переключаюсь на автопилот через открытую вкладку gemini.google.com..."
        )

    if ai_ok:
        await asyncio.to_thread(_save_ai_cache_sync, cache_key, req.title, norm_title, verdict, sources)

    return {
        "cached": False,
        "aiOk": ai_ok,
        "verdict": verdict,
        "sources": sources,
        "priceSummary": price_summary,
    }
