"""
Lavka Quality Shield v2.7.0 — Локальный FastAPI сервер (127.0.0.1:8765)
Что исправлено и улучшено в v2.7.0:
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
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel

from security import (
    ALLOWED_CORS_HEADERS,
    ALLOWED_CORS_METHODS,
    APP_DATA_DIR,
    DEFAULT_DB_PATH,
    _protect_field,
    _unprotect_field,
    get_pinned_extension_id,
    is_allowed_extension_origin,
    load_or_create_secret_token,
    migrate_legacy_db_if_needed,
    pair_extension_request,
    validate_ai_base_url,
    verify_trusted_extension_request,
)
from matcher import (
    FLAVOR_AND_TYPE_MODIFIERS,
    GENERIC_STOP_WORDS,
    REVIEW_SEARCH_SITES,
    SUGAR_FREE_REGEX,
    build_full_product_search_query,
    detect_source_label,
    extract_competitor_prices_from_sources,
    is_search_result_matching_product,
    normalize_synonym_tokens,
    normalize_title_for_match,
    parse_volume_or_weight_grams,
)

APP_VERSION = "2.7.0"
SCHEMA_VERSION = 2
DB_PATH = migrate_legacy_db_if_needed(__file__, DEFAULT_DB_PATH)

app = FastAPI(title="Lavka Quality Shield Backend", version=APP_VERSION)

# Автогенерация 32-байтного локального секретного токена при старте сервера
load_or_create_secret_token()


# Динамический строгий CORS: разрешает только закреплённый Origin расширения (или любой валидный до первого /api/auth/pair)
@app.middleware("http")
async def dynamic_extension_cors_middleware(request: Request, call_next):
    origin = (request.headers.get("origin") or "").strip()
    origin_allowed = is_allowed_extension_origin(origin) if origin else False

    if request.method == "OPTIONS":
        if origin and not origin_allowed:
            return Response(status_code=403, content="Forbidden CORS origin")
        resp = Response(status_code=204)
        if origin_allowed:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Methods"] = ALLOWED_CORS_METHODS
            resp.headers["Access-Control-Allow-Headers"] = ALLOWED_CORS_HEADERS
            resp.headers["Vary"] = "Origin"
        return resp

    response = await call_next(request)
    if origin_allowed:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = ALLOWED_CORS_METHODS
        response.headers["Access-Control-Allow-Headers"] = ALLOWED_CORS_HEADERS
        response.headers["Vary"] = "Origin"
    return response
SERVER_LOGS: Deque[Dict[str, str]] = deque(maxlen=100)


def log_event(level: str, msg: str) -> None:
    now_str = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    SERVER_LOGS.appendleft({"ts": now_str, "level": level, "msg": msg})


def get_db_connection(db_path: Optional[str] = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or DB_PATH, timeout=5.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, col_type: str) -> None:
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")


def init_db() -> None:
    with get_db_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_ai_cache (
                slug TEXT PRIMARY KEY,
                title TEXT,
                norm_title TEXT,
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
            """
            CREATE TABLE IF NOT EXISTS product_price_summary (
                slug TEXT PRIMARY KEY,
                title TEXT,
                norm_title TEXT,
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

        # Schema migrations via PRAGMA user_version
        current_version = int(conn.execute("PRAGMA user_version").fetchone()[0] or 0)
        if current_version < 1:
            _ensure_column(conn, "product_price_summary", "competitor_offers_json", "TEXT")
            conn.execute("PRAGMA user_version = 1")
            current_version = 1

        if current_version < 2:
            _ensure_column(conn, "product_ai_cache", "norm_title", "TEXT")
            _ensure_column(conn, "product_price_summary", "norm_title", "TEXT")

            # Backfill norm_title for existing rows
            for table in ("product_ai_cache", "product_price_summary"):
                rows = conn.execute(
                    f"SELECT slug, title FROM {table} WHERE norm_title IS NULL OR norm_title = ''"
                ).fetchall()
                for slug_val, title_val in rows:
                    nt = normalize_title_for_match(title_val or "")
                    conn.execute(f"UPDATE {table} SET norm_title = ? WHERE slug = ?", (nt, slug_val))

            conn.execute("PRAGMA user_version = 2")

        # Indexes for fast cache & price lookups
        conn.execute("CREATE INDEX IF NOT EXISTS idx_price_obs_slug ON price_observations(slug)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_price_obs_slug_observed ON price_observations(slug, observed_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ai_cache_norm_title ON product_ai_cache(norm_title, updated_at DESC)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ai_cache_updated_at ON product_ai_cache(updated_at DESC)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_price_summary_norm_title ON product_price_summary(norm_title, updated_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_price_summary_updated_at ON product_price_summary(updated_at DESC)"
        )

        conn.execute("DELETE FROM product_ai_cache WHERE verdict LIKE '⚠️ Ошибка вызова ИИ%'")
        conn.commit()
    log_event("INIT", f"SQLite v{APP_VERSION} (schema v{SCHEMA_VERSION}, WAL) initialized")


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
    aiModel: str = ""
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
    password: Optional[str] = None
    note: Optional[str] = ""
    yandexLogin: Optional[str] = ""
    cookieCount: Optional[int] = None
    cookies: Optional[List[Dict[str, Any]]] = None
    localStorageData: Optional[Dict[str, Any]] = None
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
            WHERE norm_title = ? OR LOWER(title) = ?
            ORDER BY updated_at DESC LIMIT 1
            """,
            (norm_title, norm_title),
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
            slug, title, norm_title, amount, min_price, max_price, avg_price, last_price,
            guest_price, competitor_min_price, competitor_summary, competitor_offers_json,
            accounts_json, history_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            clean_slug,
            cur_title,
            normalize_title_for_match(cur_title),
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
    schema_version = 0
    journal_mode = "unknown"
    try:
        with get_db_connection() as conn:
            row1 = conn.execute("SELECT COUNT(*) FROM product_ai_cache").fetchone()
            cached_count = row1[0] if row1 else 0
            row2 = conn.execute("SELECT COUNT(*) FROM product_price_summary").fetchone()
            tracked_prices = row2[0] if row2 else 0
            row3 = conn.execute("SELECT COUNT(*) FROM saved_carts").fetchone()
            saved_carts_count = row3[0] if row3 else 0
            row4 = conn.execute("SELECT COUNT(*) FROM saved_accounts").fetchone()
            saved_accounts_count = row4[0] if row4 else 0
            schema_version = int(conn.execute("PRAGMA user_version").fetchone()[0] or 0)
            journal_mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0] or "unknown")
    except Exception as exc:
        log_event("ERROR", f"Health check DB error: {exc}")
    return {
        "status": "ok",
        "version": APP_VERSION,
        "schemaVersion": schema_version,
        "journalMode": journal_mode,
        "cachedItems": cached_count,
        "trackedPrices": tracked_prices,
        "savedCarts": saved_carts_count,
        "savedAccounts": saved_accounts_count,
        "paired": bool(get_pinned_extension_id()),
        "reviewSites": [s["domain"] for s in REVIEW_SEARCH_SITES],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/api/auth/pair")
async def auth_pair_endpoint(request: Request):
    res = pair_extension_request(request)
    log_event("AUTH", f"Extension paired: id={res['extensionId'][:8]}... (already={res['alreadyPaired']})")
    return res


@app.get("/api/logs", dependencies=[Depends(verify_trusted_extension_request)])
async def get_server_logs():
    return {
        "status": "ok",
        "version": APP_VERSION,
        "logs": list(SERVER_LOGS),
    }


@app.post("/api/accounts/save", dependencies=[Depends(verify_trusted_extension_request)])
async def save_account_vault_endpoint(req: AccountVaultItemModel):
    now_iso = req.updatedAt or datetime.now(timezone.utc).isoformat()
    with get_db_connection() as conn:
        existing = conn.execute(
            "SELECT password, cookie_count, cookies_json, local_storage_json FROM saved_accounts WHERE account_id = ?",
            (req.accountId,),
        ).fetchone()

        if req.password is None:
            protected_password = existing[0] if existing else ""
        else:
            protected_password = _protect_field(req.password)

        if req.cookies is None:
            protected_cookies = existing[2] if existing else ""
            cookie_count = int(req.cookieCount) if req.cookieCount is not None else (existing[1] if existing else 0)
        else:
            protected_cookies = _protect_field(json.dumps(req.cookies, ensure_ascii=False))
            cookie_count = int(req.cookieCount if req.cookieCount is not None else len(req.cookies))

        if req.localStorageData is None:
            protected_ls = existing[3] if existing else ""
        else:
            protected_ls = _protect_field(json.dumps(req.localStorageData, ensure_ascii=False))

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
                protected_password,
                req.note or "",
                req.yandexLogin or "",
                cookie_count,
                protected_cookies,
                protected_ls,
                now_iso,
            ),
        )
        conn.commit()
    log_event("ACCOUNT_VAULT", f"Saved account profile '{req.label}' ({cookie_count} cookies)")
    return {"status": "ok", "accountId": req.accountId, "cookieCount": cookie_count, "updatedAt": now_iso}


@app.get("/api/accounts/list", dependencies=[Depends(verify_trusted_extension_request)])
async def list_saved_accounts_endpoint():
    accounts = []
    with get_db_connection() as conn:
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
                    "password": _unprotect_field(r[3]),
                    "note": r[4],
                    "yandexLogin": r[5],
                    "cookieCount": r[6],
                    "cookies": json.loads(_unprotect_field(r[7]) or "[]"),
                    "localStorageData": json.loads(_unprotect_field(r[8]) or "{}"),
                    "updatedAt": r[9],
                }
            )
    return {"status": "ok", "accounts": accounts}


@app.delete("/api/accounts/{account_id}", dependencies=[Depends(verify_trusted_extension_request)])
async def delete_saved_account_endpoint(account_id: str):
    with get_db_connection() as conn:
        conn.execute("DELETE FROM saved_accounts WHERE account_id = ?", (account_id,))
        conn.commit()
    log_event("ACCOUNT_VAULT", f"Deleted account profile '{account_id}'")
    return {"status": "ok"}


@app.post("/api/price/record", dependencies=[Depends(verify_trusted_extension_request)])
async def record_prices_endpoint(req: RecordPricesRequest):
    if not req.items:
        return {"status": "empty", "updated": 0, "summaries": {}}
    summaries: Dict[str, Any] = {}
    with get_db_connection() as conn:
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


@app.get("/api/price/product/{slug}", dependencies=[Depends(verify_trusted_extension_request)])
async def get_product_price_summary(slug: str, title: Optional[str] = None):
    clean_slug = slug.strip().lower()
    with get_db_connection() as conn:
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


@app.get("/api/price/list", dependencies=[Depends(verify_trusted_extension_request)])
async def list_tracked_prices(limit: int = 200):
    items = []
    with get_db_connection() as conn:
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


@app.post("/api/cart/save", dependencies=[Depends(verify_trusted_extension_request)])
async def save_cart_snapshot_endpoint(req: SaveCartSnapshotRequest):
    now_iso = datetime.now(timezone.utc).isoformat()
    acc = (req.accountId or "Аккаунт #1").strip()
    items_list = [i.model_dump() for i in req.items]
    calc_total = round(sum((i.price or 0) * (i.qty or 1) for i in req.items), 2)
    final_total = req.totalPrice if req.totalPrice > 0 else calc_total

    with get_db_connection() as conn:
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


@app.get("/api/cart/latest", dependencies=[Depends(verify_trusted_extension_request)])
async def get_latest_cart_snapshot():
    with get_db_connection() as conn:
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


@app.post("/api/save-cache", dependencies=[Depends(verify_trusted_extension_request)])
async def save_cache_endpoint(req: SaveCacheRequest):
    cache_key = (req.slug or req.title).strip().lower()
    if not cache_key or not req.verdict.strip():
        return {"status": "ignored"}
    with get_db_connection() as conn:
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
    log_event("CACHE_SAVE", f"Saved browser-tab Gemini verdict for '{cache_key}' into SQLite")
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
        log_event("LLM_OK", f"Model '{model_id}' @ {base_url} replied in {dt_ms}ms ({len(reply)} chars)")
        return reply


@app.post("/api/analyze-product", dependencies=[Depends(verify_trusted_extension_request)])
async def analyze_product(req: AnalyzeRequest):
    validate_ai_base_url(req.aiBaseUrl)
    cache_key = (req.slug or req.title).strip().lower()
    norm_title = normalize_title_for_match(req.title)
    log_event("REQ", f"Analyze request for slug='{cache_key}' title='{req.title[:35]}' (force={req.forceRefresh})")

    # Сначала проверяем кэш ИИ (включая поиск по нормализованному названию для связки SEO-slug <-> HEX-ID)
    if not req.forceRefresh:
        with get_db_connection() as conn:
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
    with get_db_connection() as conn:
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
        with get_db_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO product_ai_cache (slug, title, norm_title, verdict, sources_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    cache_key,
                    req.title,
                    norm_title,
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
