"""
Lavka Quality Shield — Health, Pairing & Logs Router
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request

import db
from matcher import REVIEW_SEARCH_SITES
from security import (
    get_pinned_extension_id,
    pair_extension_request,
    verify_trusted_extension_request,
)

router = APIRouter()


@router.get("/api/health")
def health_check():
    cached_count = 0
    tracked_prices = 0
    saved_carts_count = 0
    saved_accounts_count = 0
    schema_version = 0
    journal_mode = "unknown"
    try:
        with db.get_db_connection() as conn:
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
        db.log_event("ERROR", f"Health check DB error: {exc}")
    return {
        "status": "ok",
        "version": db.APP_VERSION,
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


@router.post("/api/auth/pair")
def auth_pair_endpoint(request: Request):
    res = pair_extension_request(request)
    db.log_event("AUTH", f"Extension paired: id={res['extensionId'][:8]}... (already={res['alreadyPaired']})")
    return res


@router.get("/api/logs", dependencies=[Depends(verify_trusted_extension_request)])
def get_server_logs():
    return {
        "status": "ok",
        "version": db.APP_VERSION,
        "logs": list(db.SERVER_LOGS),
    }

