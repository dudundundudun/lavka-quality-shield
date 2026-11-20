"""
Lavka Quality Shield v2.9.2 — Локальный FastAPI сервер (127.0.0.1:8765)
Модульная архитектура: db.py + security.py + matcher.py + routers/{health,accounts,prices,cache}.py
"""

import os
from typing import Optional

# Защита от перехвата локальных запросов системным прокси/VPN на Windows
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

from fastapi import FastAPI, Request, Response

import db
import security
from db import APP_VERSION, SCHEMA_VERSION, SERVER_LOGS, log_event
from matcher import (
    build_full_product_search_query,
    is_search_result_matching_product,
    parse_volume_or_weight_grams,
)
from routers import accounts, cache, health, prices
from routers.cache import AnalyzeRequest
from security import (
    ALLOWED_CORS_HEADERS,
    ALLOWED_CORS_METHODS,
    APP_DATA_DIR,
    DEFAULT_DB_PATH,
    is_allowed_extension_origin,
    load_or_create_secret_token,
    migrate_legacy_db_if_needed,
)

# Совместимость с тестами, переопределяющими server.DB_PATH перед вызовом server.init_db()
DB_PATH = migrate_legacy_db_if_needed(__file__, DEFAULT_DB_PATH)
db.DB_PATH = DB_PATH


def get_db_connection(db_path: Optional[str] = None):
    if db_path is None:
        db.DB_PATH = DB_PATH
    return db.get_db_connection(db_path or DB_PATH)


def init_db() -> None:
    db.DB_PATH = DB_PATH
    db.init_db(DB_PATH)


app = FastAPI(title="Lavka Quality Shield Backend", version=APP_VERSION)

# Автогенерация 32-байтного локального секретного токена и инициализация SQLite при старте
load_or_create_secret_token()
init_db()


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


app.include_router(health.router)
app.include_router(accounts.router)
app.include_router(prices.router)
app.include_router(cache.router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
