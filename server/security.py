"""
Lavka Quality Shield — Backend Security & Storage Path Module
Handles %LOCALAPPDATA% storage isolation, Windows DPAPI field protection,
and strict Chrome-extension Origin + X-LQS-Client verification.
"""

import base64
import ctypes
import hmac
import os
import re
import shutil
from ctypes import wintypes
from typing import Optional

from fastapi import HTTPException, Request

APP_DATA_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
    "LavkaQualityShield",
)
os.makedirs(APP_DATA_DIR, exist_ok=True)

DEFAULT_DB_PATH = os.path.join(APP_DATA_DIR, "lavka_ai_cache.db")
DPAPI_PREFIX = "dpapi:"

ALLOWED_EXT_ID = (os.environ.get("LQS_EXTENSION_ID") or "").strip().lower()
EXT_ORIGIN_RE = (
    rf"^chrome-extension://{re.escape(ALLOWED_EXT_ID)}$"
    if ALLOWED_EXT_ID
    else r"^chrome-extension://[a-p]{32}$"
)
EXT_ORIGIN_PATTERN = re.compile(EXT_ORIGIN_RE)


def migrate_legacy_db_if_needed(server_file_path: str, target_db_path: str = DEFAULT_DB_PATH) -> str:
    """One-time migration of an old DB located next to server.py into %LOCALAPPDATA%."""
    legacy_db = os.path.join(os.path.dirname(os.path.abspath(server_file_path)), "lavka_ai_cache.db")
    if not os.path.exists(target_db_path) and os.path.exists(legacy_db):
        shutil.copy2(legacy_db, target_db_path)
    return target_db_path


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def _protect_field(plaintext: str) -> str:
    if not plaintext:
        return ""
    if os.name != "nt":
        return plaintext
    raw = plaintext.encode("utf-8")
    buf = ctypes.create_string_buffer(raw, len(raw))
    in_blob = _DATA_BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    out_blob = _DATA_BLOB()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    if not crypt32.CryptProtectData(ctypes.byref(in_blob), "LQS", None, None, None, 0, ctypes.byref(out_blob)):
        raise RuntimeError("Windows DPAPI CryptProtectData failed")
    try:
        encrypted = ctypes.string_at(out_blob.pbData, out_blob.cbData)
        return DPAPI_PREFIX + base64.b64encode(encrypted).decode("ascii")
    finally:
        kernel32.LocalFree(out_blob.pbData)


def _unprotect_field(stored: Optional[str]) -> str:
    if not stored:
        return ""
    if not stored.startswith(DPAPI_PREFIX):
        return stored
    if os.name != "nt":
        raise RuntimeError("DPAPI-protected record cannot be read outside Windows")
    raw = base64.b64decode(stored[len(DPAPI_PREFIX):])
    buf = ctypes.create_string_buffer(raw, len(raw))
    in_blob = _DATA_BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    out_blob = _DATA_BLOB()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    if not crypt32.CryptUnprotectData(ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)):
        raise RuntimeError("Windows DPAPI CryptUnprotectData failed")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData).decode("utf-8")
    finally:
        kernel32.LocalFree(out_blob.pbData)


def verify_trusted_extension_request(request: Request) -> None:
    """Allows requests to local account storage strictly from the trusted Chrome extension."""
    origin = (request.headers.get("origin") or "").strip().lower()
    lqs_header = (request.headers.get("x-lqs-client") or "").strip().lower()
    if not origin or not EXT_ORIGIN_PATTERN.match(origin):
        raise HTTPException(
            status_code=403,
            detail="Forbidden: invalid or missing Chrome extension Origin.",
        )
    if not hmac.compare_digest(lqs_header, "lavka-quality-shield"):
        raise HTTPException(
            status_code=403,
            detail="Forbidden: missing or invalid X-LQS-Client header.",
        )
