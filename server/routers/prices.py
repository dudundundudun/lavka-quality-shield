"""
Lavka Quality Shield — Price History & Cart Snapshot Router
"""

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

import db
from security import verify_trusted_extension_request

router = APIRouter()


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



@router.post("/api/price/record", dependencies=[Depends(verify_trusted_extension_request)])
def record_prices_endpoint(req: RecordPricesRequest):
    if not req.items:
        return {"status": "empty", "updated": 0, "summaries": {}}
    summaries: Dict[str, Any] = {}
    with db.get_db_connection() as conn:
        for item in req.items:
            if not item.slug or item.price <= 0:
                continue
            summary = db.upsert_price_observation_sync(
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
    db.log_event("PRICE_DB", f"Recorded {len(summaries)} price(s) for account '{req.accountId}'")
    return {"status": "ok", "updated": len(summaries), "summaries": summaries}


@router.get("/api/price/product/{slug}", dependencies=[Depends(verify_trusted_extension_request)])
def get_product_price_summary(slug: str, title: Optional[str] = None):
    clean_slug = slug.strip().lower()
    with db.get_db_connection() as conn:
        row = db.find_existing_summary_row_by_slug_or_title(conn, clean_slug, title)
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


@router.get("/api/price/list", dependencies=[Depends(verify_trusted_extension_request)])
def list_tracked_prices(limit: int = 200):
    items = []
    with db.get_db_connection() as conn:
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


@router.post("/api/cart/save", dependencies=[Depends(verify_trusted_extension_request)])
def save_cart_snapshot_endpoint(req: SaveCartSnapshotRequest):
    now_iso = datetime.now(timezone.utc).isoformat()
    acc = (req.accountId or "Аккаунт #1").strip()
    items_list = [i.model_dump() if hasattr(i, 'model_dump') else i.dict() for i in req.items]
    calc_total = round(sum((i.price or 0) * (i.qty or 1) for i in req.items), 2)
    final_total = req.totalPrice if req.totalPrice > 0 else calc_total

    with db.get_db_connection() as conn:
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
                db.upsert_price_observation_sync(
                    conn=conn,
                    slug=item.slug,
                    title=item.title,
                    account_id=acc,
                    price=item.price,
                    old_price=item.oldPrice,
                    amount=item.amount,
                )
        conn.commit()
    db.log_event("CART_SAVE", f"Saved cart snapshot for '{acc}' ({len(items_list)} items, {final_total} ₽)")
    return {"status": "ok", "accountId": acc, "itemsCount": len(items_list), "totalPrice": final_total}


@router.get("/api/cart/latest", dependencies=[Depends(verify_trusted_extension_request)])
def get_latest_cart_snapshot():
    with db.get_db_connection() as conn:
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
            s_row = db.find_existing_summary_row_by_slug_or_title(
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

