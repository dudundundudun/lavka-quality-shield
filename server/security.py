"""
Lavka Quality Shield — Backend Security & Storage Path Module
Handles %LOCALAPPDATA% storage isolation, fail-closed Windows DPAPI field protection,
32-byte local secret token (secret.key), extension ID pinning, dynamic CORS,
SSRF validation, and strict X-LQS-Client + X-LQS-Token + Origin verification.
"""

import base64
import ctypes
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import urllib.parse
from ctypes import wintypes
from typing import Optional

from fastapi import HTTPException, Request

APP_DATA_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
    "LavkaQualityShield",
)
os.makedirs(APP_DATA_DIR, exist_ok=True)

DEFAULT_DB_PATH = os.path.join(APP_DATA_DIR, "lavka_ai_cache.db")
SECRET_KEY_PATH = os.path.join(APP_DATA_DIR, "secret.key")
PINNED_EXT_PATH = os.path.join(APP_DATA_DIR, "pinned_extension.json")
DPAPI_PREFIX = "dpapi:"

EXT_ID_PATTERN = re.compile(r"^[a-p]{32}$")
EXT_ORIGIN_ANY_PATTERN = re.compile(r"^chrome-extension://([a-p]{32})$")

ALLOWED_CORS_HEADERS = "Content-Type, X-LQS-Client, X-LQS-Token, Authorization"
ALLOWED_CORS_METHODS = "GET, POST, DELETE, OPTIONS"


def _restrict_file_permissions(path: str) -> None:
    if os.name != "nt":
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def load_or_create_secret_token(key_path: Optional[str] = None) -> str:
    """Loads the 32-byte (64-hex) local API token from secret.key, generating it if absent."""
    path = key_path or SECRET_KEY_PATH
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                token = f.read().strip()
            if len(token) >= 32:
                return token
        except OSError:
            pass
    token = secrets.token_hex(32)
    with open(path, "w", encoding="utf-8") as f:
        f.write(token + "\n")
    _restrict_file_permissions(path)
    return token


def get_pinned_extension_id(pinned_path: Optional[str] = None) -> str:
    """Returns pinned Chrome extension ID from env LQS_EXTENSION_ID or pinned_extension.json."""
    env_id = (os.environ.get("LQS_EXTENSION_ID") or "").strip().lower()
    if env_id and EXT_ID_PATTERN.match(env_id):
        return env_id
    path = pinned_path or PINNED_EXT_PATH
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            ext_id = str(data.get("extension_id") or "").strip().lower()
            if EXT_ID_PATTERN.match(ext_id):
                return ext_id
        except (OSError, ValueError, TypeError):
            pass
    return ""


def pin_extension_id(ext_id: str, pinned_path: Optional[str] = None) -> str:
    """Pins the Chrome extension ID on first pairing. Fails if already pinned to another ID."""
    clean_id = (ext_id or "").strip().lower()
    if not EXT_ID_PATTERN.match(clean_id):
        raise ValueError("Invalid Chrome extension ID format.")
    existing = get_pinned_extension_id(pinned_path)
    if existing:
        if hmac.compare_digest(existing, clean_id):
            return existing
        raise PermissionError("Another Chrome extension ID is already pinned.")
    path = pinned_path or PINNED_EXT_PATH
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"extension_id": clean_id}, f, indent=2)
    _restrict_file_permissions(path)
    return clean_id


def extract_extension_id_from_origin(origin: str) -> str:
    m = EXT_ORIGIN_ANY_PATTERN.match((origin or "").strip().lower())
    return m.group(1) if m else ""


def is_allowed_extension_origin(origin: str, pinned_path: Optional[str] = None) -> bool:
    """Checks whether Origin is allowed for CORS: exact pinned ID, or any valid ID before first pairing."""
    ext_id = extract_extension_id_from_origin(origin)
    if not ext_id:
        return False
    pinned_id = get_pinned_extension_id(pinned_path)
    if pinned_id:
        return hmac.compare_digest(ext_id, pinned_id)
    return True


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
    """Encrypts sensitive fields using Windows DPAPI. Fail-closed outside Windows."""
    if not plaintext:
        return ""
    if os.name != "nt":
        raise RuntimeError(
            "Windows DPAPI is required to protect sensitive fields; refusing plaintext storage outside Windows."
        )
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
        if os.name != "nt":
            raise RuntimeError("Unprotected record cannot be read in fail-closed mode outside Windows.")
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


def validate_ai_base_url(url: str) -> str:
    """Validates aiBaseUrl to prevent SSRF to link-local/cloud metadata or non-HTTP schemes."""
    clean = (url or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(clean)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid aiBaseUrl: only http(s) URLs with a host are allowed.")

    host = parsed.hostname.lower()
    if parsed.scheme == "http":
        if host not in ("127.0.0.1", "localhost"):
            raise HTTPException(
                status_code=400,
                detail="Invalid aiBaseUrl: plain http:// is only allowed for localhost/127.0.0.1.",
            )
        return clean

    # https:// — reject private/link-local/loopback/reserved raw IPs and DNS records pointing to them
    def _is_forbidden_ip(ip_obj) -> bool:
        return (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_unspecified
            or ip_obj.is_reserved
        )

    try:
        ip = ipaddress.ip_address(host)
        if _is_forbidden_ip(ip):
            raise HTTPException(status_code=400, detail="Invalid aiBaseUrl: forbidden IP address.")
    except ValueError:
        if host in ("localhost", "localhost.localdomain"):
            raise HTTPException(status_code=400, detail="Invalid aiBaseUrl: localhost is only allowed over http://.")
        try:
            infos = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
            for info in infos:
                resolved_ip = ipaddress.ip_address(info[4][0])
                if _is_forbidden_ip(resolved_ip):
                    raise HTTPException(status_code=400, detail="Invalid aiBaseUrl: host resolves to forbidden IP.")
        except HTTPException:
            raise
        except OSError:
            pass
    return clean


def pair_extension_request(request: Request) -> dict:
    """One-time Zero-Click pairing: pins the first Chrome extension ID and returns the local secret token."""
    origin = (request.headers.get("origin") or "").strip().lower()
    lqs_header = (request.headers.get("x-lqs-client") or "").strip().lower()
    ext_id = extract_extension_id_from_origin(origin)
    if not ext_id:
        raise HTTPException(status_code=403, detail="Forbidden: invalid or missing Chrome extension Origin.")
    if not hmac.compare_digest(lqs_header, "lavka-quality-shield"):
        raise HTTPException(status_code=403, detail="Forbidden: missing or invalid X-LQS-Client header.")

    existing_pinned = get_pinned_extension_id()
    token = load_or_create_secret_token()

    if existing_pinned:
        if not hmac.compare_digest(ext_id, existing_pinned):
            raise HTTPException(
                status_code=403,
                detail="Forbidden: backend is already paired with another extension ID.",
            )
        # Already paired with this extension: require valid token to confirm identity
        req_token = (request.headers.get("x-lqs-token") or "").strip()
        if not req_token or not hmac.compare_digest(req_token, token):
            raise HTTPException(
                status_code=403,
                detail="Forbidden: extension is already paired. Provide X-LQS-Token or reset pinned_extension.json.",
            )
        return {"status": "ok", "extensionId": existing_pinned, "token": token, "alreadyPaired": True}

    pinned_id = pin_extension_id(ext_id)
    return {"status": "ok", "extensionId": pinned_id, "token": token, "alreadyPaired": False}


def verify_trusted_extension_request(request: Request) -> None:
    """Strictly verifies pinned Chrome extension Origin, X-LQS-Client, and 32-byte X-LQS-Token."""
    origin = (request.headers.get("origin") or "").strip().lower()
    lqs_header = (request.headers.get("x-lqs-client") or "").strip().lower()
    req_token = (request.headers.get("x-lqs-token") or "").strip()

    ext_id = extract_extension_id_from_origin(origin)
    if not ext_id:
        raise HTTPException(
            status_code=403,
            detail="Forbidden: invalid or missing Chrome extension Origin.",
        )

    pinned_id = get_pinned_extension_id()
    if not pinned_id:
        raise HTTPException(
            status_code=403,
            detail="Forbidden: extension is not paired yet. Call /api/auth/pair first.",
        )
    if not hmac.compare_digest(ext_id, pinned_id):
        raise HTTPException(
            status_code=403,
            detail="Forbidden: Origin does not match pinned Chrome extension ID.",
        )

    if not hmac.compare_digest(lqs_header, "lavka-quality-shield"):
        raise HTTPException(
            status_code=403,
            detail="Forbidden: missing or invalid X-LQS-Client header.",
        )

    expected_token = load_or_create_secret_token()
    if not req_token or not hmac.compare_digest(req_token, expected_token):
        raise HTTPException(
            status_code=403,
            detail="Forbidden: missing or invalid X-LQS-Token header.",
        )
