"""
Lavka Quality Shield v2.5.2 — Локальный FastAPI сервер (127.0.0.1:8765)
Что исправлено и улучшено в v2.5.2:
1. Точный поиск идентичных продуктов (Exact Product & Modifier Matcher):
   - Полное сохранение названия товара, включая модификаторы «без сахара» / «Zero», вкус, жирность и объём/вес (например, «1,5 л»).
   - Жёсткая фильтрация результатов DuckDuckGo: обычная Кола с сахаром больше никогда не попадёт в цены/ссылки для «Колы без сахара» (и наоборот), а цены за баночку 0,33 л не смешаются с бутылкой 1,5 л.
2. Защита сейфа аккаунтов и куки (CORS + X-LQS-Client Guard):
   - Запрет доступа сторонних сайтов к /api/accounts/* (защита от кражи Session_id и паролей).
3. Связка SEO-slug и HEX-ID товаров Лавки:
   - Если товар открыт из корзины по внутреннему HEX-ID (/good/4cbf6c0b...), сервер автоматически находит его кэш ИИ и историю цен по нормализованному названию.
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
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lavka_ai_cache.db")

app = FastAPI(title="Lavka Quality Shield Backend", version="2.5.2")

# Разрешаем CORS только для расширения Chrome, страниц Яндекса и локального хоста (защита от чтения куки/паролей сторонними сайтами)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://.*|https://([a-z0-9-]+\.)?yandex\.ru|http://127\.0\.0\.1(:\d+)?|http://localhost(:\d+)?)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def verify_trusted_extension_request(request: Request) -> None:
    """Блокирует запросы к сейфу паролей/куки со сторонних веб-страниц."""
    origin = (request.headers.get("origin") or "").strip().lower()
    lqs_header = (request.headers.get("x-lqs-client") or "").strip().lower()
    if lqs_header == "lavka-quality-shield":
        if not origin or origin.startswith("chrome-extension://") or "yandex.ru" in origin or "127.0.0.1" in origin or "localhost" in origin:
            return
    if origin.startswith("chrome-extension://"):
        return
    if not origin and lqs_header == "lavka-quality-shield":
        return
    raise HTTPException(
        status_code=403,
        detail="Forbidden: access to Account Vault is restricted to Lavka Quality Shield extension.",
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


def normalize_title_for_match(raw: Optional[str]) -> str:
    if not raw:
        return ""
    s = re.sub(r"[\u00ad\u200b\u00a0«»\"'„“”]", " ", str(raw))
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


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
                competitor_offers_json TEXT,
                accounts_json TEXT,
                history_json TEXT,
                updated_at TEXT
            )
            """
        )
        try:
            conn.execute("ALTER TABLE product_price_summary ADD COLUMN competitor_offers_json TEXT")
        except Exception:
            pass

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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS saved_accounts (
                account_id TEXT PRIMARY KEY,
                label TEXT,
                login TEXT,
                password TEXT,
                note TEXT,
                yandex_login TEXT,
                cookie_count INTEGER,
                cookies_json TEXT,
                local_storage_json TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute("DELETE FROM product_ai_cache WHERE verdict LIKE '⚠️ Ошибка вызова ИИ%'")
        conn.commit()
    log_event("INIT", "SQLite v2.5.2 initialized (Exact Product Match + Secure Account Vault)")


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
    competitorOffers: Optional[List[Dict[str, Any]]] = None


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


class AccountVaultItemModel(BaseModel):
    accountId: str
    label: str
    login: Optional[str] = ""
    password: Optional[str] = ""
    note: Optional[str] = ""
    yandexLogin: Optional[str] = ""
    cookieCount: int = 0
    cookies: List[Dict[str, Any]] = []
    localStorageData: Dict[str, Any] = {}
    updatedAt: Optional[str] = None


def find_existing_summary_row_by_slug_or_title(
    conn: sqlite3.Connection, clean_slug: str, title: Optional[str] = None
) -> Optional[Tuple[Any, ...]]:
    row = conn.execute(
        """
        SELECT slug, title, amount, min_price, max_price, avg_price, last_price, guest_price,
               competitor_min_price, competitor_summary, competitor_offers_json, accounts_json, history_json, updated_at
        FROM product_price_summary WHERE slug = ?
        """,
        (clean_slug,),
    ).fetchone()
    if row:
        return row
    norm_title = normalize_title_for_match(title)
    if norm_title and len(norm_title) >= 5:
        rows = conn.execute(
            """
            SELECT slug, title, amount, min_price, max_price, avg_price, last_price, guest_price,
                   competitor_min_price, competitor_summary, competitor_offers_json, accounts_json, history_json, updated_at
            FROM product_price_summary
            WHERE LOWER(title) = ?
            ORDER BY updated_at DESC LIMIT 1
            """,
            (norm_title,),
        ).fetchone()
        if rows:
            return rows
    return None


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
    competitor_offers: Optional[List[Dict[str, Any]]] = None,
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

    row = find_existing_summary_row_by_slug_or_title(conn, clean_slug, title)

    if row:
        cur_title = title or row[1] or clean_slug
        cur_amount = amount or row[2] or ""
        cur_guest = guest_price if (guest_price and guest_price > 0) else row[7]
        cur_comp_min = competitor_min if (competitor_min and competitor_min > 0) else row[8]
        cur_comp_sum = competitor_summary if competitor_summary else row[9]
        try:
            existing_offers = json.loads(row[10] or "[]")
        except Exception:
            existing_offers = []
        cur_comp_offers = competitor_offers if (competitor_offers and len(competitor_offers) > 0) else existing_offers
        try:
            accounts_map = json.loads(row[11] or "{}")
        except Exception:
            accounts_map = {}
        try:
            history_list = json.loads(row[12] or "[]")
        except Exception:
            history_list = []
    else:
        cur_title = title or clean_slug
        cur_amount = amount or ""
        cur_guest = guest_price if (guest_price and guest_price > 0) else None
        cur_comp_min = competitor_min if (competitor_min and competitor_min > 0) else None
        cur_comp_sum = competitor_summary or None
        cur_comp_offers = competitor_offers or []
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
            guest_price, competitor_min_price, competitor_summary, competitor_offers_json,
            accounts_json, history_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            json.dumps(cur_comp_offers, ensure_ascii=False),
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
        "competitorOffers": cur_comp_offers,
        "accounts": accounts_map,
        "history": history_list,
        "updatedAt": now_iso,
    }


@app.get("/api/health")
async def health_check():
    cached_count = 0
    tracked_prices = 0
    saved_carts_count = 0
    saved_accounts_count = 0
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row1 = conn.execute("SELECT COUNT(*) FROM product_ai_cache").fetchone()
            cached_count = row1[0] if row1 else 0
            row2 = conn.execute("SELECT COUNT(*) FROM product_price_summary").fetchone()
            tracked_prices = row2[0] if row2 else 0
            row3 = conn.execute("SELECT COUNT(*) FROM saved_carts").fetchone()
            saved_carts_count = row3[0] if row3 else 0
            row4 = conn.execute("SELECT COUNT(*) FROM saved_accounts").fetchone()
            saved_accounts_count = row4[0] if row4 else 0
    except Exception as exc:
        log_event("ERROR", f"Health check DB error: {exc}")
    return {
        "status": "ok",
        "version": "2.5.2",
        "cachedItems": cached_count,
        "trackedPrices": tracked_prices,
        "savedCarts": saved_carts_count,
        "savedAccounts": saved_accounts_count,
        "reviewSites": [s["domain"] for s in REVIEW_SEARCH_SITES],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/logs")
async def get_server_logs():
    return {
        "status": "ok",
        "version": "2.5.2",
        "logs": list(SERVER_LOGS),
    }


@app.post("/api/accounts/save")
async def save_account_vault_endpoint(req: AccountVaultItemModel, request: Request):
    verify_trusted_extension_request(request)
    now_iso = req.updatedAt or datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO saved_accounts (
                account_id, label, login, password, note, yandex_login,
                cookie_count, cookies_json, local_storage_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                req.accountId,
                req.label,
                req.login or "",
                req.password or "",
                req.note or "",
                req.yandexLogin or "",
                int(req.cookieCount or len(req.cookies or [])),
                json.dumps(req.cookies or [], ensure_ascii=False),
                json.dumps(req.localStorageData or {}, ensure_ascii=False),
                now_iso,
            ),
        )
        conn.commit()
    log_event("ACCOUNT_VAULT", f"Saved account profile '{req.label}' ({req.cookieCount} cookies)")
    return {"status": "ok", "accountId": req.accountId, "updatedAt": now_iso}


@app.get("/api/accounts/list")
async def list_saved_accounts_endpoint(request: Request):
    verify_trusted_extension_request(request)
    accounts = []
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT account_id, label, login, password, note, yandex_login,
                   cookie_count, cookies_json, local_storage_json, updated_at
            FROM saved_accounts
            ORDER BY updated_at DESC
            """
        ).fetchall()
        for r in rows:
            accounts.append(
                {
                    "accountId": r[0],
                    "label": r[1],
                    "login": r[2],
                    "password": r[3],
                    "note": r[4],
                    "yandexLogin": r[5],
                    "cookieCount": r[6],
                    "cookies": json.loads(r[7] or "[]"),
                    "localStorageData": json.loads(r[8] or "{}"),
                    "updatedAt": r[9],
                }
            )
    return {"status": "ok", "accounts": accounts}


@app.delete("/api/accounts/{account_id}")
async def delete_saved_account_endpoint(account_id: str, request: Request):
    verify_trusted_extension_request(request)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM saved_accounts WHERE account_id = ?", (account_id,))
        conn.commit()
    log_event("ACCOUNT_VAULT", f"Deleted account profile '{account_id}'")
    return {"status": "ok"}


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
                competitor_offers=item.competitorOffers,
            )
            summaries[summary["slug"]] = summary
        conn.commit()
    log_event("PRICE_DB", f"Recorded {len(summaries)} price(s) for account '{req.accountId}'")
    return {"status": "ok", "updated": len(summaries), "summaries": summaries}


@app.get("/api/price/product/{slug}")
async def get_product_price_summary(slug: str, title: Optional[str] = None):
    clean_slug = slug.strip().lower()
    with sqlite3.connect(DB_PATH) as conn:
        row = find_existing_summary_row_by_slug_or_title(conn, clean_slug, title)
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
                "competitorOffers": json.loads(row[10] or "[]"),
                "accounts": json.loads(row[11] or "{}"),
                "history": json.loads(row[12] or "[]"),
                "updatedAt": row[13],
            },
        }


@app.get("/api/price/list")
async def list_tracked_prices(limit: int = 200):
    items = []
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT slug, title, amount, min_price, max_price, avg_price, last_price,
                   guest_price, competitor_min_price, competitor_summary, competitor_offers_json,
                   accounts_json, updated_at
            FROM product_price_summary
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        for r in rows:
            accounts = json.loads(r[11] or "{}")
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
                    "competitorOffers": json.loads(r[10] or "[]"),
                    "accounts": accounts,
                    "updatedAt": r[12],
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
        for it in items:
            s_row = find_existing_summary_row_by_slug_or_title(
                conn, str(it.get("slug", "")).lower(), it.get("title")
            )
            if s_row:
                it["minPrice"] = s_row[3]
                it["avgPrice"] = s_row[5]
                it["guestPrice"] = s_row[7]
                it["competitorMinPrice"] = s_row[8]
                it["competitorSummary"] = s_row[9]
                it["competitorOffers"] = json.loads(s_row[10] or "[]")
                it["accounts"] = json.loads(s_row[11] or "{}")

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


# ==============================================================================
# ТОЧНЫЙ ПОИСК ИДЕНТИЧНЫХ ПРОДУКТОВ И ФИЛЬТР МОДИФИКАТОРОВ (БЕЗ САХАРА / ОБЪЁМ)
# ==============================================================================
SUGAR_FREE_REGEX = re.compile(
    r"(без\s+сахара|без\s+добавленного\s+сахара|\bzero\b|\bзеро\b|\blight\b|\bлайт\b|\bdiet\b|0\s*%\s*сахара|0\s+сахара|на\s+стевии|подсластител)",
    re.IGNORECASE,
)

FLAVOR_AND_TYPE_MODIFIERS = [
    "ваниль",
    "вишн",
    "черешн",
    "лимон",
    "лайм",
    "манго",
    "маракуй",
    "апельсин",
    "персик",
    "малин",
    "клубник",
    "земляник",
    "смородин",
    "черник",
    "яблок",
    "груш",
    "ананас",
    "грейпфрут",
    "тархун",
    "дюшес",
    "байкал",
    "буратино",
    "крем-сода",
    "карамел",
    "кокос",
    "миндал",
    "фундук",
    "фисташк",
    "банан",
    "шоколад",
    "какао",
    "кофе",
    "матча",
    "имбир",
    "мята",
    "мятн",
    "солен",
    "копчен",
    "остр",
    "сырн",
    "гриб",
    "сметан",
    "зелен",
    "краб",
    "бекон",
    "паприк",
    "безлактоз",
    "топлен",
    "обезжир",
    "классич",
    "original",
    "classic",
]

GENERIC_STOP_WORDS = {
    "напиток",
    "газированный",
    "сильногазированный",
    "среднегазированный",
    "слабогазированный",
    "негазированный",
    "безалкогольный",
    "пастеризованный",
    "ультрапастеризованный",
    "стерилизованный",
    "охлажденный",
    "замороженный",
    "фасованный",
    "нарезка",
    "упаковка",
    "бутылка",
    "банка",
    "пакет",
    "коробка",
    "продукт",
    "товар",
    "купить",
    "цена",
    "отзывы",
    "отзыв",
    "доставка",
    "москва",
    "лавка",
    "яндекс",
    "бзмж",
    "стм",
    "для",
    "или",
    "под",
    "над",
    "при",
}


def parse_volume_or_weight_grams(text: Optional[str]) -> Optional[float]:
    """Извлекает объём/вес в граммах или миллилитрах (например '1,5 л' -> 1500, '330 мл' -> 330)."""
    if not text:
        return None
    s = re.sub(r"[\u00ad\u200b\u00a0]", " ", str(text))
    m_multi = re.search(
        r"(\d+)\s*[×xх*]\s*(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])",
        s,
        re.IGNORECASE,
    )
    if m_multi:
        cnt = int(m_multi.group(1))
        val = float(m_multi.group(2).replace(",", "."))
        u = m_multi.group(3).lower()
        mult = 1000.0 if u.startswith(("кг", "л")) else 1.0
        return cnt * val * mult

    m_single = re.search(
        r"(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])",
        s,
        re.IGNORECASE,
    )
    if m_single:
        val = float(m_single.group(1).replace(",", "."))
        u = m_single.group(2).lower()
        mult = 1000.0 if u.startswith(("кг", "л")) else 1.0
        return val * mult
    return None


def build_full_product_search_query(
    title: str, brand: Optional[str] = None, amount: Optional[str] = None
) -> str:
    """
    Формирует ПОЛНЫЙ поисковый запрос товара без потери «без сахара», вкуса и объёма/веса!
    Если вес/объём (amount, например '1,5 л') не входит в title, добавляет его в конец.
    """
    q = re.sub(r"[\u00ad\u200b\u00a0«»\"'„“”]", " ", title or "")
    q = re.sub(r"\b(?:бзмж|стм)\b", " ", q, flags=re.IGNORECASE)
    q = re.sub(r"\s+", " ", q).strip()

    if brand:
        clean_brand = re.sub(r"[\u00ad\u200b\u00a0«»\"']", " ", brand).strip()
        if clean_brand and clean_brand.lower() not in q.lower():
            if clean_brand.lower() == "из лавки":
                q = f"{q} Из Лавки"
            else:
                q = f"{q} {clean_brand}"

    if amount:
        clean_amt = re.sub(r"[\u00ad\u200b\u00a0]", " ", amount).strip()
        if clean_amt:
            # Проверяем, есть ли уже этот вес/объём в строке запроса
            target_grams = parse_volume_or_weight_grams(clean_amt)
            query_grams = parse_volume_or_weight_grams(q)
            if not query_grams and clean_amt.lower() not in q.lower():
                q = f"{q} {clean_amt}"
            elif target_grams and query_grams and abs(target_grams - query_grams) > 5:
                q = f"{q} {clean_amt}"

    return re.sub(r"\s+", " ", q).strip()


def normalize_synonym_tokens(text: str) -> str:
    """Приводит частые англо-русские продуктовые синонимы к единому виду для точного сопоставления."""
    s = text.lower().replace("ё", "е")
    s = re.sub(r"\bcola\b", "кола", s)
    s = re.sub(r"\bcoca[\s-]*кола\b", "coca-cola кока-кола", s)
    s = re.sub(r"\boriginal\b", "оригинал original", s)
    s = re.sub(r"\bclassic\b", "классик classic", s)
    s = re.sub(r"\bzero\b", "без сахара zero зеро", s)
    return s


def is_search_result_matching_product(
    res_title: str,
    res_snippet: str,
    product_title: str,
    product_amount: Optional[str] = None,
) -> Tuple[bool, bool]:
    """
    Проверяет, относится ли найденный результат поиска ИМЕННО К ЭТОМУ ПРОДУКТУ.
    Возвращает кортеж: (is_same_product, is_same_volume).
    """
    full_target = f"{product_title or ''} {product_amount or ''}".strip()
    target_lower = full_target.lower().replace("ё", "е")
    res_title_lower = (res_title or "").lower().replace("ё", "е")
    res_combined_lower = f"{res_title_lower} {(res_snippet or '').lower().replace('ё', 'е')}"

    # 1. ЖЁСТКАЯ ПРОВЕРКА МОДИФИКАТОРА «БЕЗ САХАРА / ZERO»
    target_is_sugar_free = bool(SUGAR_FREE_REGEX.search(target_lower))
    res_is_sugar_free = bool(SUGAR_FREE_REGEX.search(res_combined_lower))
    res_title_is_sugar_free = bool(SUGAR_FREE_REGEX.search(res_title_lower))

    if target_is_sugar_free and not res_is_sugar_free:
        # Ищем товар БЕЗ САХАРА, а в результате — обычный товар с сахаром -> ОТБРАСЫВАЕМ!
        return False, False

    if not target_is_sugar_free and res_title_is_sugar_free:
        # Ищем обычный товар С САХАРОМ, а в заголовке результата — версия БЕЗ САХАРА -> ОТБРАСЫВАЕМ!
        return False, False

    # 2. ПРОВЕРКА ВКУСОВЫХ И ВИДОВЫХ МОДИФИКАТОРОВ (ваниль, вишня, лайм, безлактозное и т.д.)
    for mod in FLAVOR_AND_TYPE_MODIFIERS:
        if mod in ("original", "classic", "классич"):
            continue
        target_has_mod = mod in target_lower
        res_title_has_mod = mod in res_title_lower
        res_any_has_mod = mod in res_combined_lower
        if target_has_mod and not res_any_has_mod:
            return False, False
        if not target_has_mod and res_title_has_mod:
            return False, False

    # 3. ПРОВЕРКА КЛЮЧЕВЫХ СЛОВ НАЗВАНИЯ И БРЕНДА
    norm_target = normalize_synonym_tokens(target_lower)
    norm_res = normalize_synonym_tokens(res_combined_lower)

    raw_words = re.findall(r"[а-яa-z0-9]{3,}", norm_target)
    core_tokens = []
    for w in raw_words:
        if w in GENERIC_STOP_WORDS:
            continue
        if w in ("без", "сахара", "сахар", "zero", "зеро", "литр", "литра", "литров", "грамм", "грамма"):
            continue
        if re.match(r"^\d+(?:г|гр|кг|мл|л|шт|percent)?$", w):
            continue
        if w not in core_tokens:
            core_tokens.append(w)

    if core_tokens:
        matched_tokens = 0
        for tok in core_tokens:
            stem = tok[:5] if len(tok) >= 6 else (tok[:4] if len(tok) >= 5 else tok)
            if stem in norm_res:
                matched_tokens += 1
        required = 1 if len(core_tokens) == 1 else max(2, int(len(core_tokens) * 0.6))
        if matched_tokens < min(required, len(core_tokens)):
            return False, False

    # 4. ПРОВЕРКА СОВПАДЕНИЯ ОБЪЁМА / ВЕСА (чтобы не сравнивать цену 1.5 л с баночкой 0.33 л)
    target_grams = parse_volume_or_weight_grams(product_amount) or parse_volume_or_weight_grams(product_title)
    res_grams = parse_volume_or_weight_grams(res_title) or parse_volume_or_weight_grams(res_snippet)

    is_same_volume = True
    if target_grams and res_grams:
        ratio = res_grams / target_grams if target_grams > 0 else 1.0
        if ratio < 0.78 or ratio > 1.25:
            is_same_volume = False

    return True, is_same_volume


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


def extract_competitor_prices_from_sources(
    sources: List[Dict[str, Any]],
    lavka_price: Optional[float] = None,
    product_title: str = "",
    product_amount: Optional[str] = None,
) -> Tuple[Optional[float], str, List[Dict[str, Any]]]:
    """
    Извлекает цены в рублях и ссылки ТОЛЬКО из тех сниппетов конкурентов,
    которые прошли проверку полного совпадения продукта (включая «без сахара» и объём/вес).
    """
    if not sources:
        return None, "", []
    found: List[Dict[str, Any]] = []
    for s in sources:
        raw_title = s.get("title") or ""
        snippet = s.get("snippet") or ""
        if product_title:
            same_prod, same_vol = is_search_result_matching_product(
                raw_title, snippet, product_title, product_amount
            )
            if not same_prod or not same_vol:
                continue

        text = f"{raw_title} {snippet}"
        source_name = s.get("source") or "Магазин"
        url = s.get("url") or ""
        for m in re.finditer(
            r"(?:от\s+|цена\s+|за\s+)?(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|р\.)(?![а-яa-z])",
            text,
            re.IGNORECASE,
        ):
            try:
                val = float(m.group(1).replace(",", "."))
                if 20 <= val <= 9500:
                    if lavka_price and (val < lavka_price * 0.35 or val > lavka_price * 3.0):
                        continue
                    found.append(
                        {
                            "store": source_name,
                            "price": int(round(val)),
                            "url": url,
                            "title": (raw_title or source_name)[:90],
                        }
                    )
            except Exception:
                pass
    if not found:
        return None, "", []
    found.sort(key=lambda x: x["price"])
    min_p = float(found[0]["price"])
    seen_stores = set()
    parts = []
    unique_offers: List[Dict[str, Any]] = []
    for item in found:
        st = item["store"]
        if st not in seen_stores:
            seen_stores.add(st)
            parts.append(f"{st}: ~{item['price']} ₽")
            unique_offers.append(item)
        if len(unique_offers) >= 5:
            break
    return min_p, ", ".join(parts[:3]), unique_offers


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
            log_event(
                "SEARCH",
                f"Exact match search for '{full_q[:42]}' -> {len(collected)} verified sources in {dt_ms}ms",
            )
    except Exception as exc:
        log_event("ERROR", f"Review search error for '{full_q[:42]}': {exc}")

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
    timeout_cfg = httpx.Timeout(18.0, connect=1.5)
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
    norm_title = normalize_title_for_match(req.title)
    log_event("REQ", f"Analyze request for slug='{cache_key}' title='{req.title[:35]}' (force={req.forceRefresh})")

    # Сначала проверяем кэш ИИ (включая поиск по нормализованному названию для связки SEO-slug <-> HEX-ID)
    if not req.forceRefresh:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT verdict, sources_json FROM product_ai_cache WHERE slug = ?",
                (cache_key,),
            ).fetchone()
            if not row and norm_title:
                row = conn.execute(
                    "SELECT verdict, sources_json FROM product_ai_cache WHERE LOWER(title) = ? ORDER BY updated_at DESC LIMIT 1",
                    (norm_title,),
                ).fetchone()
            if row and row[0] and not str(row[0]).startswith("⚠️"):
                s_row = find_existing_summary_row_by_slug_or_title(conn, cache_key, req.title)
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
                        "guestPrice": s_row[7],
                        "competitorMinPrice": s_row[8],
                        "competitorSummary": s_row[9],
                        "competitorOffers": json.loads(s_row[10] or "[]"),
                        "accounts": json.loads(s_row[11] or "{}"),
                        "history": json.loads(s_row[12] or "[]"),
                        "updatedAt": s_row[13],
                    }
                log_event("CACHE_HIT", f"Returned SQLite cached verdict for '{cache_key}'")
                return {
                    "cached": True,
                    "aiOk": True,
                    "verdict": row[0],
                    "sources": json.loads(row[1] or "[]"),
                    "priceSummary": cached_summary,
                }

    sources = await search_web_reviews(req.title, req.brand, req.amount)
    comp_min, comp_sum, comp_offers = extract_competitor_prices_from_sources(
        sources, req.price, req.title, req.amount
    )

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
                competitor_offers=comp_offers,
            )
            conn.commit()

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
