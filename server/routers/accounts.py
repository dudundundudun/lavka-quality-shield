"""
Lavka Quality Shield — DPAPI-Protected Account Vault Router
"""

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

import db
import security
from security import verify_trusted_extension_request

router = APIRouter()


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



@router.post("/api/accounts/save", dependencies=[Depends(verify_trusted_extension_request)])
async def save_account_vault_endpoint(req: AccountVaultItemModel):
    now_iso = req.updatedAt or datetime.now(timezone.utc).isoformat()
    with db.get_db_connection() as conn:
        existing = conn.execute(
            "SELECT password, cookie_count, cookies_json, local_storage_json FROM saved_accounts WHERE account_id = ?",
            (req.accountId,),
        ).fetchone()

        if req.password is None:
            protected_password = existing[0] if existing else ""
        else:
            protected_password = security._protect_field(req.password)

        if req.cookies is None:
            protected_cookies = existing[2] if existing else ""
            cookie_count = int(req.cookieCount) if req.cookieCount is not None else (existing[1] if existing else 0)
        else:
            protected_cookies = security._protect_field(json.dumps(req.cookies, ensure_ascii=False))
            cookie_count = int(req.cookieCount if req.cookieCount is not None else len(req.cookies))

        if req.localStorageData is None:
            protected_ls = existing[3] if existing else ""
        else:
            protected_ls = security._protect_field(json.dumps(req.localStorageData, ensure_ascii=False))

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
    db.log_event("ACCOUNT_VAULT", f"Saved account profile '{req.label}' ({cookie_count} cookies)")
    return {"status": "ok", "accountId": req.accountId, "cookieCount": cookie_count, "updatedAt": now_iso}


@router.get("/api/accounts/list", dependencies=[Depends(verify_trusted_extension_request)])
async def list_saved_accounts_endpoint():
    accounts = []
    with db.get_db_connection() as conn:
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
                    "password": security._unprotect_field(r[3]),
                    "note": r[4],
                    "yandexLogin": r[5],
                    "cookieCount": r[6],
                    "cookies": json.loads(security._unprotect_field(r[7]) or "[]"),
                    "localStorageData": json.loads(security._unprotect_field(r[8]) or "{}"),
                    "updatedAt": r[9],
                }
            )
    return {"status": "ok", "accounts": accounts}


@router.delete("/api/accounts/{account_id}", dependencies=[Depends(verify_trusted_extension_request)])
async def delete_saved_account_endpoint(account_id: str):
    with db.get_db_connection() as conn:
        conn.execute("DELETE FROM saved_accounts WHERE account_id = ?", (account_id,))
        conn.commit()
    db.log_event("ACCOUNT_VAULT", f"Deleted account profile '{account_id}'")
    return {"status": "ok"}

