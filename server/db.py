"""
Lavka Quality Shield — SQLite Database, Schema Migrations & Logging Module
"""

import json
import sqlite3
from collections import deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, List, Optional, Tuple

from matcher import normalize_title_for_match
from security import DEFAULT_DB_PATH, migrate_legacy_db_if_needed

APP_VERSION = "2.7.0"
SCHEMA_VERSION = 2
DB_PATH = migrate_legacy_db_if_needed(__file__, DEFAULT_DB_PATH)
SERVER_LOGS: Deque[Dict[str, str]] = deque(maxlen=100)


def log_event(level: str, msg: str) -> None:
    now_str = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    SERVER_LOGS.appendleft({"ts": now_str, "level": level, "msg": msg})


class _ClosingConnection(sqlite3.Connection):
    """sqlite3.Connection subclass that commits/rolls back AND closes on context exit."""

    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            return super().__exit__(exc_type, exc_val, exc_tb)
        finally:
            self.close()


def get_db_connection(db_path: Optional[str] = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or DB_PATH, timeout=5.0, factory=_ClosingConnection)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, col_type: str) -> None:
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")


def init_db(db_path: Optional[str] = None) -> None:
    global DB_PATH
    if db_path:
        DB_PATH = db_path
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
    if not all_prices:
        for a_val in accounts_map.values():
            if isinstance(a_val, dict) and a_val.get("price") and float(a_val["price"]) > 0:
                all_prices.append(float(a_val["price"]))
        if not all_prices and price and price > 0:
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

