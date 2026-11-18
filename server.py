"""
Lavka Quality Shield v2.4.0 — Локальный FastAPI сервер (127.0.0.1:8765)
1. Принимает название, состав, БЖУ, фасовку и расчёт цены товара из расширения Lavka Quality Shield.
2. Ищет реальные отзывы И ЦЕНЫ КОНКУРЕНТОВ в сети по списку проверенных площадок (Отзовик, IRecommend,
   Роскачество, Росконтроль, ВкусВилл, Перекрёсток, Азбука Вкуса, Ozon, Яндекс Маркет, Лента, Wildberries, Купер).
3. Ведёт единую мульти-аккаунт базу истории цен в SQLite (product_price_summary + price_observations):
   позволяет сравнивать цены между разными аккаунтами и профилями Chrome, а также с ценой Гостя (без куки).
4. Хранит слепки корзин (saved_carts) для мгновенной сверки и авто-сборки корзины между аккаунтами.
5. Кэширует ответы ИИ в SQLite (product_ai_cache) и общается с мостом Gemini (:8083) или вкладкой браузера.
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

app = FastAPI(title="Lavka Quality Shield Backend", version="2.4.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

REVIEW_SEARCH_SITES: List[Dict[str, str]] = [
    {"domain": "otzovik.com", "name": "Отзовик"},
    {"domain": "irecommend.ru", "name": "IRecommend"},
    {"domain": "rskrf.ru", "name": "Роскачество"},
    {"domain": "roscontrol.com", "name": "Росконтроль"},
    {"domain": "vkusvill.ru", "name": "ВкусВилл"},
    {"domain": "perekrestok.ru", "name": "Перекрёсток"},
    {"domain": "vprok.ru", "name": "Перекрёсток Впрок"},
    {"domain": "av.ru", "name": "Азбука Вкуса"},
    {"domain": "lenta.com", "name": "Лента"},
    {"domain": "ozon.ru", "name": "Ozon"},
    {"domain": "market.yandex.ru", "name": "Яндекс Маркет"},
    {"domain": "wildberries.ru", "name": "Wildberries"},
    {"domain": "kuper.ru", "name": "Купер"},
    {"domain": "sbermarket.ru", "name": "СберМаркет"},
    {"domain": "eda.yandex.ru", "name": "Яндекс Лавка / Еда"},
]

SERVER_LOGS: Deque[Dict[str, str]] = deque(maxlen=100)


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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS price_observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slug TEXT,
                title TEXT,
                account_id TEXT,
                price REAL,
                old_price REAL,
                amount TEXT,
                observed_at TEXT
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_price_obs_slug ON price_observations(slug)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_price_summary (
                slug TEXT PRIMARY KEY,
                title TEXT,
                amount TEXT,
                min_price REAL,
                max_price REAL,
                avg_price REAL,
                last_price REAL,
                guest_price REAL,
                competitor_min_price REAL,
                competitor_summary TEXT,
                accounts_json TEXT,
                history_json TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_carts (
                cart_id TEXT PRIMARY KEY,
                account_id TEXT,
                items_json TEXT,
                total_price REAL,
                updated_at TEXT
            )
            """
        )
        conn.execute("DELETE FROM product_ai_cache WHERE verdict LIKE '⚠️ Ошибка вызова ИИ%'")
        conn.commit()
    log_event("INIT", f"SQLite v2.4.0 initialized (AI cache + Multi-Account Price Matrix + Cart Cloner)")


init_db()


class AnalyzeRequest(BaseModel):
    slug: Optional[str] = None
    title: str
    brand: Optional[str] = None
    amount: Optional[str] = None
    price: Optional[float] = None
    oldPrice: Optional[float] = None
    accountId: Optional[str] = "Аккаунт #1"
    guestPrice: Optional[float] = None
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


class PriceItemInput(BaseModel):
    slug: str
    title: Optional[str] = ""
    price: float
    oldPrice: Optional[float] = None
    amount: Optional[str] = ""
    guestPrice: Optional[float] = None
    competitorMinPrice: Optional[float] = None
    competitorSummary: Optional[str] = None


class RecordPricesRequest(BaseModel):
    accountId: str = "Аккаунт #1"
    items: List[PriceItemInput] = []


class CartItemModel(BaseModel):
    slug: str
    title: str
    qty: int = 1
    price: float = 0.0
    oldPrice: Optional[float] = None
    amount: Optional[str] = ""
    imageKey: Optional[str] = None


class SaveCartSnapshotRequest(BaseModel):
    accountId: str = "Аккаунт #1"
    items: List[CartItemModel] = []
    totalPrice: float = 0.0


def upsert_price_observation_sync(
    conn: sqlite3.Connection,
    slug: str,
    title: str,
    account_id: str,
    price: float,
    old_price: Optional[float] = None,
    amount: Optional[str] = "",
    guest_price: Optional[float] = None,
    competitor_min: Optional[float] = None,
    competitor_summary: Optional[str] = None,
) -> Dict[str, Any]:
    clean_slug = slug.strip().lower()
    now_iso = datetime.now(timezone.utc).isoformat()
    acc = (account_id or "Аккаунт #1").strip()

    if price and price > 0:
        conn.execute(
            """
            INSERT INTO price_observations (slug, title, account_id, price, old_price, amount, observed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (clean_slug, title or clean_slug, acc, float(price), old_price, amount or "", now_iso),
        )

    row = conn.execute(
        """
        SELECT title, amount, min_price, max_price, avg_price, last_price, guest_price,
               competitor_min_price, competitor_summary, accounts_json, history_json
        FROM product_price_summary WHERE slug = ?
        """,
        (clean_slug,),
    ).fetchone()

    if row:
        cur_title = title or row[0] or clean_slug
        cur_amount = amount or row[1] or ""
        cur_guest = guest_price if (guest_price and guest_price > 0) else row[6]
        cur_comp_min = competitor_min if (competitor_min and competitor_min > 0) else row[7]
        cur_comp_sum = competitor_summary if competitor_summary else row[8]
        try:
            accounts_map = json.loads(row[9] or "{}")
        except Exception:
            accounts_map = {}
        try:
            history_list = json.loads(row[10] or "[]")
        except Exception:
            history_list = []
    else:
        cur_title = title or clean_slug
        cur_amount = amount or ""
        cur_guest = guest_price if (guest_price and guest_price > 0) else None
        cur_comp_min = competitor_min if (competitor_min and competitor_min > 0) else None
        cur_comp_sum = competitor_summary or None
        accounts_map = {}
        history_list = []

    if price and price > 0:
        accounts_map[acc] = {
            "price": round(float(price), 2),
            "oldPrice": round(float(old_price), 2) if old_price else None,
            "updatedAt": now_iso,
        }
        if not history_list or history_list[0].get("price") != round(float(price), 2) or history_list[0].get("accountId") != acc:
            history_list.insert(
                0,
                {
                    "price": round(float(price), 2),
                    "oldPrice": round(float(old_price), 2) if old_price else None,
                    "accountId": acc,
                    "ts": now_iso,
                },
            )
            history_list = history_list[:20]

    if cur_guest and cur_guest > 0:
        accounts_map["Гость (без куки)"] = {
            "price": round(float(cur_guest), 2),
            "oldPrice": None,
            "updatedAt": now_iso,
        }

    all_prices = [float(h["price"]) for h in history_list if h.get("price") and float(h["price"]) > 0]
    for a_val in accounts_map.values():
        if isinstance(a_val, dict) and a_val.get("price"):
            all_prices.append(float(a_val["price"]))
    if price and price > 0:
        all_prices.append(float(price))

    if all_prices:
        min_p = round(min(all_prices), 2)
        max_p = round(max(all_prices), 2)
        avg_p = round(sum(all_prices) / len(all_prices), 2)
        last_p = round(float(price), 2) if (price and price > 0) else round(all_prices[0], 2)
    else:
        min_p = max_p = avg_p = last_p = 0.0

    conn.execute(
        """
        INSERT OR REPLACE INTO product_price_summary (
            slug, title, amount, min_price, max_price, avg_price, last_price,
            guest_price, competitor_min_price, competitor_summary,
            accounts_json, history_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            clean_slug,
            cur_title,
            cur_amount,
            min_p,
            max_p,
            avg_p,
            last_p,
            cur_guest,
            cur_comp_min,
            cur_comp_sum,
            json.dumps(accounts_map, ensure_ascii=False),
            json.dumps(history_list, ensure_ascii=False),
            now_iso,
        ),
    )

    return {
        "slug": clean_slug,
        "title": cur_title,
        "amount": cur_amount,
        "minPrice": min_p,
        "maxPrice": max_p,
        "avgPrice": avg_p,
        "lastPrice": last_p,
        "guestPrice": cur_guest,
        "competitorMinPrice": cur_comp_min,
        "competitorSummary": cur_comp_sum,
        "accounts": accounts_map,
        "history": history_list,
        "updatedAt": now_iso,
    }


@app.get("/api/health")
async def health_check():
    cached_count = 0
    tracked_prices = 0
    saved_carts_count = 0
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row1 = conn.execute("SELECT COUNT(*) FROM product_ai_cache").fetchone()
            cached_count = row1[0] if row1 else 0
            row2 = conn.execute("SELECT COUNT(*) FROM product_price_summary").fetchone()
            tracked_prices = row2[0] if row2 else 0
            row3 = conn.execute("SELECT COUNT(*) FROM saved_carts").fetchone()
            saved_carts_count = row3[0] if row3 else 0
    except Exception as exc:
        log_event("ERROR", f"Health check DB error: {exc}")
    return {
        "status": "ok",
        "version": "2.4.0",
        "cachedItems": cached_count,
        "trackedPrices": tracked_prices,
        "savedCarts": saved_carts_count,
        "reviewSites": [s["domain"] for s in REVIEW_SEARCH_SITES],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/logs")
async def get_server_logs():
    return {
        "status": "ok",
        "version": "2.4.0",
        "logs": list(SERVER_LOGS),
    }


@app.post("/api/price/record")
async def record_prices_endpoint(req: RecordPricesRequest):
    if not req.items:
        return {"status": "empty", "updated": 0, "summaries": {}}
    summaries: Dict[str, Any] = {}
    with sqlite3.connect(DB_PATH) as conn:
        for item in req.items:
            if not item.slug or item.price <= 0:
                continue
            summary = upsert_price_observation_sync(
                conn=conn,
                slug=item.slug,
                title=item.title or item.slug,
                account_id=req.accountId,
                price=item.price,
                old_price=item.oldPrice,
                amount=item.amount,
                guest_price=item.guestPrice,
                competitor_min=item.competitorMinPrice,
                competitor_summary=item.competitorSummary,
            )
            summaries[summary["slug"]] = summary
        conn.commit()
    log_event("PRICE_DB", f"Recorded {len(summaries)} price(s) for account '{req.accountId}'")
    return {"status": "ok", "updated": len(summaries), "summaries": summaries}


@app.get("/api/price/product/{slug}")
async def get_product_price_summary(slug: str):
    clean_slug = slug.strip().lower()
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            """
            SELECT slug, title, amount, min_price, max_price, avg_price, last_price,
                   guest_price, competitor_min_price, competitor_summary,
                   accounts_json, history_json, updated_at
            FROM product_price_summary WHERE slug = ?
            """,
            (clean_slug,),
        ).fetchone()
        if not row:
            return {"status": "not_found", "slug": clean_slug}
        return {
            "status": "ok",
            "summary": {
                "slug": row[0],
                "title": row[1],
                "amount": row[2],
                "minPrice": row[3],
                "maxPrice": row[4],
                "avgPrice": row[5],
                "lastPrice": row[6],
                "guestPrice": row[7],
                "competitorMinPrice": row[8],
                "competitorSummary": row[9],
                "accounts": json.loads(row[10] or "{}"),
                "history": json.loads(row[11] or "[]"),
                "updatedAt": row[12],
            },
        }


@app.get("/api/price/list")
async def list_tracked_prices(limit: int = 200):
    items = []
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT slug, title, amount, min_price, max_price, avg_price, last_price,
                   guest_price, competitor_min_price, competitor_summary,
                   accounts_json, updated_at
            FROM product_price_summary
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        for r in rows:
            accounts = json.loads(r[10] or "{}")
            items.append(
                {
                    "slug": r[0],
                    "title": r[1],
                    "amount": r[2],
                    "minPrice": r[3],
                    "maxPrice": r[4],
                    "avgPrice": r[5],
                    "lastPrice": r[6],
                    "guestPrice": r[7],
                    "competitorMinPrice": r[8],
                    "competitorSummary": r[9],
                    "accounts": accounts,
                    "updatedAt": r[11],
                }
            )
    return {"status": "ok", "count": len(items), "items": items}


@app.post("/api/cart/save")
async def save_cart_snapshot_endpoint(req: SaveCartSnapshotRequest):
    now_iso = datetime.now(timezone.utc).isoformat()
    acc = (req.accountId or "Аккаунт #1").strip()
    items_list = [i.model_dump() for i in req.items]
    calc_total = round(sum((i.price or 0) * (i.qty or 1) for i in req.items), 2)
    final_total = req.totalPrice if req.totalPrice > 0 else calc_total

    with sqlite3.connect(DB_PATH) as conn:
        for cid in ("latest", f"cart_{acc}"):
            conn.execute(
                """
                INSERT OR REPLACE INTO saved_carts (cart_id, account_id, items_json, total_price, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (cid, acc, json.dumps(items_list, ensure_ascii=False), final_total, now_iso),
            )
        # Также попутно записываем цены всех товаров корзины в общую базу цен!
        for item in req.items:
            if item.slug and item.price > 0:
                upsert_price_observation_sync(
                    conn=conn,
                    slug=item.slug,
                    title=item.title,
                    account_id=acc,
                    price=item.price,
                    old_price=item.oldPrice,
                    amount=item.amount,
                )
        conn.commit()
    log_event("CART_SAVE", f"Saved cart snapshot for '{acc}' ({len(items_list)} items, {final_total} ₽)")
    return {"status": "ok", "accountId": acc, "itemsCount": len(items_list), "totalPrice": final_total}


@app.get("/api/cart/latest")
async def get_latest_cart_snapshot():
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            "SELECT cart_id, account_id, items_json, total_price, updated_at FROM saved_carts WHERE cart_id = 'latest'"
        ).fetchone()
        all_rows = conn.execute(
            "SELECT cart_id, account_id, items_json, total_price, updated_at FROM saved_carts WHERE cart_id != 'latest' ORDER BY updated_at DESC"
        ).fetchall()

        if not row:
            return {"status": "empty", "latest": None, "cartsByAccount": []}

        items = json.loads(row[2] or "[]")
        # Обогащаем каждый товар корзины известными ценами с других аккаунтов из product_price_summary
        for it in items:
            s_row = conn.execute(
                "SELECT min_price, avg_price, guest_price, competitor_min_price, competitor_summary, accounts_json FROM product_price_summary WHERE slug = ?",
                (str(it.get("slug", "")).lower(),),
            ).fetchone()
            if s_row:
                it["minPrice"] = s_row[0]
                it["avgPrice"] = s_row[1]
                it["guestPrice"] = s_row[2]
                it["competitorMinPrice"] = s_row[3]
                it["competitorSummary"] = s_row[4]
                it["accounts"] = json.loads(s_row[5] or "{}")

        carts_by_account = [
            {
                "cartId": r[0],
                "accountId": r[1],
                "items": json.loads(r[2] or "[]"),
                "totalPrice": r[3],
                "updatedAt": r[4],
            }
            for r in all_rows
        ]

        return {
            "status": "ok",
            "latest": {
                "accountId": row[1],
                "items": items,
                "totalPrice": row[3],
                "updatedAt": row[4],
            },
            "cartsByAccount": carts_by_account,
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
    q = re.sub(r"[\u00ad\u200b\u00a0«»\"'„“”]", " ", title or "")
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
    try:
        host = urllib.parse.urlparse(url).netloc.lower()
    except Exception:
        host = ""
    for site in REVIEW_SEARCH_SITES:
        dom = site["domain"]
        if host == dom or host.endswith("." + dom):
            return site["name"], True
    return host.replace("www.", "") or "Веб", False


def extract_competitor_prices_from_sources(sources: List[Dict[str, Any]], lavka_price: Optional[float] = None) -> Tuple[Optional[float], str]:
    """Извлекает упоминания цен в рублях из сниппетов и заголовков магазинов-конкурентов."""
    found: List[Tuple[str, float]] = []
    for s in sources:
        text = f"{s.get('title', '')} {s.get('snippet', '')}"
        source_name = s.get("source") or "Магазин"
        for m in re.finditer(r"(?:от\s+|цена\s+|за\s+)?(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|р\.)(?![а-яa-z])", text, re.IGNORECASE):
            try:
                val = float(m.group(1).replace(",", "."))
                if 20 <= val <= 9500:
                    if lavka_price and (val < lavka_price * 0.22 or val > lavka_price * 3.5):
                        continue
                    found.append((source_name, round(val)))
            except Exception:
                pass
    if not found:
        return None, ""
    found.sort(key=lambda x: x[1])
    min_p = float(found[0][1])
    seen_stores = set()
    parts = []
    for store, p in found:
        if store not in seen_stores:
            seen_stores.add(store)
            parts.append(f"{store}: ~{int(p)} ₽")
        if len(parts) >= 3:
            break
    return min_p, ", ".join(parts)


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

    q_sites_primary = (
        f"{clean_q} отзывы цена "
        f"(site:otzovik.com OR site:irecommend.ru OR site:vkusvill.ru OR site:perekrestok.ru OR site:ozon.ru OR site:rskrf.ru)"
    )
    q_fallback = f"{clean_q} отзывы покупателей цена"

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
                f"Review+Price search for '{clean_q[:38]}' -> {len(collected)} sources in {dt_ms}ms",
            )
    except Exception as exc:
        log_event("ERROR", f"Review search error for '{clean_q[:38]}': {exc}")

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
        if price_summary.get("guestPrice") and req.price and price_summary["guestPrice"] < req.price:
            diff = round(req.price - price_summary["guestPrice"])
            extra_intel.append(f"ВНИМАНИЕ: без куки (для гостя) цена ниже на {diff} ₽ ({price_summary['guestPrice']} ₽)!")
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
            "Прямых отзывов именно на этот товар в поисковой выдаче не найдено — "
            "честно сообщи об этом в 1-м пункте и оценивай товар строго по составу, КБЖУ и цене."
        )

    calc_line, eval_hint, pricing_rule = build_pricing_context(req, price_summary)
    brand_suffix = f" (Бренд: {req.brand})" if req.brand else ""

    return (
        f"Ты — опытный, внимательный и объективный продуктовый эксперт. "
        f"Сделай короткий и понятный разбор товара из Яндекс Лавки (ровно 3 пункта, без воды, без молодёжного сленга и без выдумок — нормальным разговорным русским языком).\n\n"
        f"Данные карточки товара:\n"
        f"• Название: {req.title}{brand_suffix}\n"
        f"• Фасовка и цена: {req.amount or 'не указана'}, Цена: {req.price or '?'} ₽ ({calc_line})\n"
        f"• Состав: {req.ingredients or 'не указан на странице'}\n"
        f"• КБЖУ на 100 г: {req.traits or 'не указано на странице'}\n\n"
        f"Площадки для поиска отзывов и цен: {sites_list_str}.\n"
        f"Найденные отзывы и цены в интернете:\n{snippets_text}\n\n"
        f"СТРОГИЕ ПРАВИЛА ЧЕСТНОСТИ (ТОЛЬКО ФАКТЫ, БЕЗ ПРИДУМОК):\n"
        f"- Опирайся ТОЛЬКО на реальные факты из найденных отзывов, состава, КБЖУ и цены.\n"
        f"- Если в блоке «Найденные отзывы и цены в интернете» нет отзывов именно об этом продукте — ЧЕСТНО напиши в 1-м пункте: «Отзывов именно на этот товар в сети не нашлось, поэтому оцениваю по составу и характеристикам». Категорически запрещено выдумывать вкус, консистенцию или якобы существующие мнения покупателей.\n"
        f"- {pricing_rule}\n\n"
        f"Ответь ровно в 3 коротких пунктах (по 1–2 предложения в каждом), обычным живым русским языком без сленга:\n"
        f"1. **Отзывы и репутация**: что реально пишут покупатели на отзовиках и в магазинах (укажи площадки, если отзывы найдены), либо честно отметь, что отзывов в сети не найдено, и скажи, что сразу видно по характеристикам продукта.\n"
        f"2. **Состав, КБЖУ и честность цены**: фактический разбор состава (есть ли скрытый сахар, крахмал, ММО, заменители молочного жира, дешёвые наполнители или состав чистый) и насколько адекватна цена ({eval_hint}).\n"
        f"3. **Вердикт**: выбери ОДНУ оценку на нормальном русском языке и кратко поясни вывод:\n"
        f"   • ✅ **Отличный выбор — стоит брать**\n"
        f"   • 👍 **Хороший вариант на каждый день (есть мелкие нюансы)**\n"
        f"   • ⚠️ **На любителя — есть компромиссы по составу или цене**\n"
        f"   • ❌ **Не рекомендую к покупке**"
    )


async def call_ai_model(req: AnalyzeRequest, web_snippets: List[dict], price_summary: Optional[Dict[str, Any]] = None) -> str:
    prompt = build_ai_prompt(req, web_snippets, price_summary)

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

    sources = await search_web_reviews(req.title, req.brand)
    comp_min, comp_sum = extract_competitor_prices_from_sources(sources, req.price)

    price_summary = None
    with sqlite3.connect(DB_PATH) as conn:
        if req.price and req.price > 0:
            price_summary = upsert_price_observation_sync(
                conn=conn,
                slug=cache_key,
                title=req.title,
                account_id=req.accountId or "Аккаунт #1",
                price=req.price,
                old_price=req.oldPrice,
                amount=req.amount or "",
                guest_price=req.guestPrice,
                competitor_min=comp_min,
                competitor_summary=comp_sum,
            )
            conn.commit()

        if not req.forceRefresh:
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
                    "priceSummary": price_summary,
                }

    ai_ok = True
    try:
        verdict = await call_ai_model(req, sources, price_summary)
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
        "priceSummary": price_summary,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
