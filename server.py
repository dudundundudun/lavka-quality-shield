"""
Lavka Quality Shield v2.3.0 — Локальный FastAPI сервер (127.0.0.1:8765)
1. Принимает название, состав, БЖУ, фасовку и расчёт цены товара из расширения Lavka Quality Shield.
2. Ищет реальные отзывы о продукте в сети по списку проверенных площадок (Отзовик, IRecommend,
   Роскачество, Росконтроль, Ozon, ВкусВилл, Яндекс Маркет, Перекрёсток, Лента, Wildberries, Купер).
3. Кэширует результаты в локальной базе SQLite (lavka_ai_cache.db).
4. Отправляет найденные отзывы + состав в локальный мост Gemini 4 Argon (http://localhost:8083/v1)
   или отдаёт найденные отзывы расширению для запуска через открытую вкладку gemini.google.com.
5. Ведёт кольцевой бортовой журнал запросов (GET /api/logs и GET /api/health).
"""

import os
import sys
import shutil

# Chrome блокирует загрузку расширения, если в папке есть каталог __pycache__ (начинается с "_")
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
shutil.rmtree(os.path.join(os.path.dirname(os.path.abspath(__file__)), "__pycache__"), ignore_errors=True)
import re
import json
import sqlite3
import time
import urllib.parse
from collections import deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, List, Optional, Tuple

# Защита от перехвата локальных запросов системным прокси/VPN на Windows
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lavka_ai_cache.db")

app = FastAPI(title="Lavka Quality Shield Backend", version="2.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Приоритетный список сайтов для поиска реальных отзывов о продуктах
REVIEW_SEARCH_SITES: List[Dict[str, str]] = [
    {"domain": "otzovik.com", "name": "Отзовик"},
    {"domain": "irecommend.ru", "name": "IRecommend"},
    {"domain": "rskrf.ru", "name": "Роскачество"},
    {"domain": "roscontrol.com", "name": "Росконтроль"},
    {"domain": "ozon.ru", "name": "Ozon"},
    {"domain": "vkusvill.ru", "name": "ВкусВилл"},
    {"domain": "market.yandex.ru", "name": "Яндекс Маркет"},
    {"domain": "perekrestok.ru", "name": "Перекрёсток"},
    {"domain": "vprok.ru", "name": "Перекрёсток Впрок"},
    {"domain": "lenta.com", "name": "Лента"},
    {"domain": "wildberries.ru", "name": "Wildberries"},
    {"domain": "kuper.ru", "name": "Купер"},
    {"domain": "sbermarket.ru", "name": "СберМаркет"},
    {"domain": "eda.yandex.ru", "name": "Яндекс Лавка / Еда"},
]

# Кольцевой буфер серверных событий для бортового журнала расширения
SERVER_LOGS: Deque[Dict[str, str]] = deque(maxlen=80)


def log_event(level: str, msg: str) -> None:
    now_str = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    SERVER_LOGS.appendleft({"ts": now_str, "level": level, "msg": msg})


def init_db() -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_ai_cache (
                slug TEXT PRIMARY KEY,
                title TEXT,
                verdict TEXT,
                sources_json TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute("DELETE FROM product_ai_cache WHERE verdict LIKE '⚠️ Ошибка вызова ИИ%'")
        conn.commit()
    log_event("INIT", f"SQLite cache initialized at {os.path.basename(DB_PATH)}")


init_db()


class AnalyzeRequest(BaseModel):
    slug: Optional[str] = None
    title: str
    brand: Optional[str] = None
    amount: Optional[str] = None
    price: Optional[float] = None
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
    aiModel: str = "gemini-4-argon"
    forceRefresh: bool = False


class SaveCacheRequest(BaseModel):
    slug: str
    title: str
    verdict: str
    sources: List[Dict[str, Any]] = []


@app.get("/api/health")
async def health_check():
    cached_count = 0
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute("SELECT COUNT(*) FROM product_ai_cache").fetchone()
            cached_count = row[0] if row else 0
    except Exception as exc:
        log_event("ERROR", f"Health check DB error: {exc}")
    return {
        "status": "ok",
        "version": "2.3.0",
        "cachedItems": cached_count,
        "reviewSites": [s["domain"] for s in REVIEW_SEARCH_SITES],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/logs")
async def get_server_logs():
    return {
        "status": "ok",
        "version": "2.3.0",
        "logs": list(SERVER_LOGS),
    }


@app.post("/api/save-cache")
async def save_cache_endpoint(req: SaveCacheRequest):
    cache_key = (req.slug or req.title).strip().lower()
    if not cache_key or not req.verdict.strip():
        return {"status": "ignored"}
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO product_ai_cache (slug, title, verdict, sources_json, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                cache_key,
                req.title,
                req.verdict.strip(),
                json.dumps(req.sources or [], ensure_ascii=False),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
    log_event("CACHE_SAVE", f"Saved browser-tab Gemini verdict for '{cache_key}' into SQLite")
    return {"status": "ok"}


def clean_product_query_for_search(title: str, brand: Optional[str] = None) -> str:
    """Очищает название товара от служебного шума и граммовок для точного поиска отзывов."""
    q = re.sub(r"[\u00ad\u200b\u00a0«»\"'„“”]", " ", title or "")
    # Убираем хвосты с весом/объёмом/количеством в конце заголовка, которые мешают поисковику
    q = re.sub(
        r"(?:,\s*|\s+)(?:\d+\s*[×xх*]\s*)?\d+(?:[.,]\d+)?\s*(?:г|гр|грамм|кг|мл|л|шт|уп|пак|рул|капс)\.?$",
        "",
        q,
        flags=re.IGNORECASE,
    )
    q = re.sub(r"\b(?:бзмж|стм)\b", "", q, flags=re.IGNORECASE)
    q = re.sub(r"\s+", " ", q).strip()
    if brand:
        clean_brand = re.sub(r"[\u00ad\u200b\u00a0«»\"']", " ", brand).strip()
        if clean_brand and clean_brand.lower() not in q.lower():
            if clean_brand.lower() == "из лавки":
                q = f"{q} Из Лавки"
            else:
                q = f"{q} {clean_brand}"
    return q.strip()


def detect_source_label(url: str) -> Tuple[str, bool]:
    """Определяет площадку по URL и проверяет, входит ли она в белый список отзовиков/магазинов."""
    try:
        host = urllib.parse.urlparse(url).netloc.lower()
    except Exception:
        host = ""
    for site in REVIEW_SEARCH_SITES:
        dom = site["domain"]
        if host == dom or host.endswith("." + dom):
            return site["name"], True
    return host.replace("www.", "") or "Веб", False


async def run_ddg_query(client: httpx.AsyncClient, query: str, headers: Dict[str, str]) -> List[Dict[str, Any]]:
    url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"
    resp = await client.get(url, headers=headers)
    items: List[Dict[str, Any]] = []
    if resp.status_code != 200:
        return items
    soup = BeautifulSoup(resp.text, "html.parser")
    for block in soup.select(".result")[:8]:
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
        raw_title = a_el.get_text(" ", strip=True)[:85]
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


async def search_web_reviews(product_title: str, brand: Optional[str] = None) -> List[dict]:
    """
    Двухэтапный поиск реальных отзывов:
    1) Прицельный поиск по отзовикам (Otzovik, IRecommend, Роскачество, Росконтроль) и магазинам (Ozon, ВкусВилл, Маркет, Перекрёсток, Лента, WB, Купер).
    2) Если прицельный запрос дал < 2 результатов — широкий поиск «<товар> отзывы покупателей» с приоритетом площадок из списка.
    """
    clean_q = clean_product_query_for_search(product_title, brand)
    if not clean_q:
        return []

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6",
    }

    # Группа 1: Главные отзовики и магазины (умеренное число OR, чтобы DDG не сбрасывал выдачу)
    q_sites_primary = (
        f"{clean_q} отзывы "
        f"(site:otzovik.com OR site:irecommend.ru OR site:ozon.ru OR site:vkusvill.ru OR site:rskrf.ru OR site:market.yandex.ru)"
    )
    # Группа 2: Ритейлеры и общий поиск отзывов покупателей
    q_fallback = f"{clean_q} отзывы покупателей"

    collected: List[Dict[str, Any]] = []
    seen_urls = set()
    t0 = time.perf_counter()

    try:
        async with httpx.AsyncClient(timeout=8.5, follow_redirects=True) as client:
            primary_hits = await run_ddg_query(client, q_sites_primary, headers)
            for item in primary_hits:
                if item["url"] not in seen_urls:
                    seen_urls.add(item["url"])
                    collected.append(item)

            if len(collected) < 3:
                fallback_hits = await run_ddg_query(client, q_fallback, headers)
                # Сначала добавляем совпадения из нашего белого списка площадок, затем остальные релевантные страницы с отзывами
                fallback_hits.sort(key=lambda x: (0 if x.get("trusted") else 1))
                for item in fallback_hits:
                    if item["url"] not in seen_urls:
                        seen_urls.add(item["url"])
                        collected.append(item)
                        if len(collected) >= 6:
                            break

            dt_ms = int((time.perf_counter() - t0) * 1000)
            log_event(
                "SEARCH",
                f"Review search for '{clean_q[:38]}' -> {len(collected)} sources in {dt_ms}ms",
            )
    except Exception as exc:
        log_event("ERROR", f"Review search error for '{clean_q[:38]}': {exc}")

    return collected[:6]


def build_pricing_context(req: AnalyzeRequest) -> Tuple[str, str, str]:
    """
    Формирует понятное описание цены (за кг/л, за шт или за упаковку) и правило для ИИ,
    чтобы ИИ не пытался считать цену за кг там, где товар поштучный или вес не указан.
    """
    price_per_kg = req.pricePerKg
    unit_label = req.unitLabel or "кг"
    price_per_piece = req.pricePerPiece
    piece_unit = req.pieceUnitLabel or "шт"
    pieces_count = req.piecesCount
    protein = req.proteinPer100g
    protein_cost = req.pricePer100gProtein

    # Если клиент не передал предрасчёт, пробуем вычислить на сервере из amount и price
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

    if price_per_kg:
        if protein_cost and protein and protein >= 3:
            calc_line = (
                f"в пересчёте ~{price_per_kg} ₽/{unit_label}; "
                f"стоимость 100 г белка ~{protein_cost} ₽ (белка {protein} г на 100 г)"
            )
            eval_hint = f"в пересчёте на 1 {unit_label} (~{price_per_kg} ₽/{unit_label}) и с учётом стоимости белка (~{protein_cost} ₽ за 100 г)"
            rule_line = f"Для этого товара известна точная цена за 1 {unit_label} (~{price_per_kg} ₽/{unit_label}) и за 100 г белка (~{protein_cost} ₽) — используй эти цифры при оценке выгоды."
        else:
            calc_line = f"в пересчёте ~{price_per_kg} ₽/{unit_label}"
            eval_hint = f"в пересчёте на 1 {unit_label} (~{price_per_kg} ₽/{unit_label})"
            rule_line = (
                f"Для этого товара известна цена за 1 {unit_label} (~{price_per_kg} ₽/{unit_label}). "
                f"Стоимость белка отдельно не оценивай, если это не белковый продукт."
            )
    elif price_per_piece and pieces_count and pieces_count > 1:
        calc_line = f"поштучная фасовка ({pieces_count} {piece_unit}) — ~{price_per_piece} ₽ за 1 {piece_unit}, вес в граммах не указан"
        eval_hint = f"в пересчёте за 1 {piece_unit} (~{price_per_piece} ₽/{piece_unit}) и за всю упаковку"
        rule_line = (
            f"Товар продаётся поштучно ({pieces_count} {piece_unit}, ~{price_per_piece} ₽/{piece_unit}) без указания веса в граммах — "
            f"НЕ пытайся считать цену за килограмм, оценивай выгоду за 1 {piece_unit} и упаковку."
        )
    else:
        calc_line = "вес в граммах не указан (оценка за упаковку / 1 шт.)"
        eval_hint = "за саму упаковку / штуку (без пересчёта за килограмм)"
        rule_line = (
            "На карточке этого товара не указан вес в граммах или миллилитрах — "
            "НЕ пытайся выдумывать или требовать цену за килограмм, оценивай адекватность цены за саму штуку/упаковку."
        )

    return calc_line, eval_hint, rule_line


def build_ai_prompt(req: AnalyzeRequest, web_snippets: List[dict]) -> str:
    sites_list_str = ", ".join([f"{s['name']} ({s['domain']})" for s in REVIEW_SEARCH_SITES[:11]])
    if web_snippets:
        snippets_text = "\n".join(
            [f"- {s.get('title', 'Источник')} ({s.get('url', '')}): {s.get('snippet', '')}" for s in web_snippets]
        )
    else:
        snippets_text = (
            "Прямых отзывов именно на этот товар в поисковой выдаче не найдено — "
            "честно сообщи об этом в 1-м пункте и оценивай товар строго по составу, КБЖУ и цене."
        )

    calc_line, eval_hint, pricing_rule = build_pricing_context(req)
    brand_suffix = f" (Бренд: {req.brand})" if req.brand else ""

    return (
        f"Ты — опытный, внимательный и объективный продуктовый эксперт. "
        f"Сделай короткий и понятный разбор товара из Яндекс Лавки (ровно 3 пункта, без воды, без молодёжного сленга и без выдумок — нормальным разговорным русским языком).\n\n"
        f"Данные карточки товара:\n"
        f"• Название: {req.title}{brand_suffix}\n"
        f"• Фасовка и цена: {req.amount or 'не указана'}, Цена: {req.price or '?'} ₽ ({calc_line})\n"
        f"• Состав: {req.ingredients or 'не указан на странице'}\n"
        f"• КБЖУ на 100 г: {req.traits or 'не указано на странице'}\n\n"
        f"Площадки для поиска отзывов: {sites_list_str}.\n"
        f"Найденные отзывы в интернете:\n{snippets_text}\n\n"
        f"СТРОГИЕ ПРАВИЛА ЧЕСТНОСТИ (ТОЛЬКО ФАКТЫ, БЕЗ ПРИДУМОК):\n"
        f"- Опирайся ТОЛЬКО на реальные факты из найденных отзывов, состава, КБЖУ и цены.\n"
        f"- Если в блоке «Найденные отзывы в интернете» нет отзывов именно об этом продукте (и у тебя нет доступа к реальным отзывам на него в поиске) — ЧЕСТНО напиши в 1-м пункте: «Отзывов именно на этот товар в сети не нашлось, поэтому оцениваю по составу и характеристикам». Категорически запрещено выдумывать вкус, консистенцию или якобы существующие мнения покупателей.\n"
        f"- {pricing_rule}\n\n"
        f"Ответь ровно в 3 коротких пунктах (по 1–2 предложения в каждом), обычным живым русским языком без сленга:\n"
        f"1. **Отзывы и репутация**: что реально пишут покупатели на отзовиках и в магазинах (укажи площадки, если отзывы найдены), либо честно отметь, что отзывов в сети не найдено, и скажи, что сразу видно по характеристикам продукта.\n"
        f"2. **Состав, КБЖУ и цена**: фактический разбор состава (есть ли скрытый сахар, крахмал, ММО, заменители молочного жира, дешёвые наполнители или состав чистый) и насколько адекватна цена ({eval_hint}).\n"
        f"3. **Вердикт**: выбери ОДНУ оценку на нормальном русском языке и кратко поясни вывод:\n"
        f"   • ✅ **Отличный выбор — стоит брать**\n"
        f"   • 👍 **Хороший вариант на каждый день (есть мелкие нюансы)**\n"
        f"   • ⚠️ **На любителя — есть компромиссы по составу или цене**\n"
        f"   • ❌ **Не рекомендую к покупке**"
    )


async def call_ai_model(req: AnalyzeRequest, web_snippets: List[dict]) -> str:
    prompt = build_ai_prompt(req, web_snippets)

    base_url = req.aiBaseUrl.rstrip("/")
    is_local = "localhost" in base_url or "127.0.0.1" in base_url

    headers = {"Content-Type": "application/json"}
    if req.aiApiKey:
        headers["Authorization"] = f"Bearer {req.aiApiKey}"

    payload = {
        "model": req.aiModel or "gemini-4-argon",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
    }

    t0 = time.perf_counter()
    timeout_cfg = httpx.Timeout(20.0, connect=2.5)
    async with httpx.AsyncClient(timeout=timeout_cfg, trust_env=not is_local) as client:
        resp = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
        dt_ms = int((time.perf_counter() - t0) * 1000)
        resp.raise_for_status()
        data = resp.json()
        reply = data["choices"][0]["message"]["content"].strip()
        log_event("LLM_OK", f"Model '{req.aiModel}' @ {base_url} replied in {dt_ms}ms ({len(reply)} chars)")
        return reply


@app.post("/api/analyze-product")
async def analyze_product(req: AnalyzeRequest):
    cache_key = (req.slug or req.title).strip().lower()
    log_event("REQ", f"Analyze request for slug='{cache_key}' (force={req.forceRefresh})")

    if not req.forceRefresh:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT verdict, sources_json FROM product_ai_cache WHERE slug = ?",
                (cache_key,),
            ).fetchone()
            if row and row[0] and not str(row[0]).startswith("⚠️"):
                log_event("CACHE_HIT", f"Returned SQLite cached verdict for '{cache_key}'")
                return {
                    "cached": True,
                    "aiOk": True,
                    "verdict": row[0],
                    "sources": json.loads(row[1] or "[]"),
                }

    sources = await search_web_reviews(req.title, req.brand)
    ai_ok = True
    try:
        verdict = await call_ai_model(req, sources)
    except Exception as exc:
        ai_ok = False
        log_event(
            "LLM_ERR",
            f"AI call failed ({req.aiModel} @ {req.aiBaseUrl}): {exc} -> handing off to Browser Gemini Tab",
        )
        verdict = (
            f"⚠️ Ошибка вызова ИИ ({req.aiModel} @ {req.aiBaseUrl}): {exc}\n"
            f"Переключаюсь на автопилот через открытую вкладку gemini.google.com..."
        )

    if ai_ok:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO product_ai_cache (slug, title, verdict, sources_json, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    cache_key,
                    req.title,
                    verdict,
                    json.dumps(sources, ensure_ascii=False),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            conn.commit()

    return {
        "cached": False,
        "aiOk": ai_ok,
        "verdict": verdict,
        "sources": sources,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
