"""
Lavka Quality Shield v2.2.0 — Локальный FastAPI сервер (127.0.0.1:8765)
1. Принимает название, состав, БЖУ и цену товара из расширения Lavka Quality Shield.
2. Ищет реальные отзывы о продукте в сети (Отзовик, IRecommend, Роскачество, ВкусВилл, Ozon).
3. Кэширует результаты в локальной базе SQLite (lavka_ai_cache.db).
4. Отправляет найденные отзывы + состав в локальный мост Gemini 4 Argon (http://localhost:8083/v1)
   или отдаёт найденные отзывы расширению, чтобы оно само прогнало их через открытую вкладку gemini.google.com
   и сохранило вердикт обратно через POST /api/save-cache!
5. Ведёт кольцевой бортовой журнал запросов (GET /api/logs и GET /api/health) для экспорта в ИИ при отладке.
"""

import os
import re
import json
import sqlite3
import time
import urllib.parse
from collections import deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, List, Optional

# Защита от перехвата локальных запросов системным прокси/VPN на Windows
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lavka_ai_cache.db")

app = FastAPI(title="Lavka Quality Shield Backend", version="2.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Кольцевой буфер серверных событий для бортового журнала расширения
SERVER_LOGS: Deque[Dict[str, str]] = deque(maxlen=80)


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
        conn.commit()
    log_event("INIT", f"SQLite cache initialized at {os.path.basename(DB_PATH)}")


init_db()


class AnalyzeRequest(BaseModel):
    slug: Optional[str] = None
    title: str
    brand: Optional[str] = None
    amount: Optional[str] = None
    price: Optional[float] = None
    ingredients: Optional[str] = None
    traits: Optional[str] = None
    aiBaseUrl: str = "http://localhost:8083/v1"
    aiApiKey: str = ""
    aiModel: str = "gemini-4-argon"
    forceRefresh: bool = False


class SaveCacheRequest(BaseModel):
    slug: str
    title: str
    verdict: str
    sources: List[Dict[str, Any]] = []


@app.get("/api/health")
async def health_check():
    cached_count = 0
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute("SELECT COUNT(*) FROM product_ai_cache").fetchone()
            cached_count = row[0] if row else 0
    except Exception as exc:
        log_event("ERROR", f"Health check DB error: {exc}")
    return {
        "status": "ok",
        "version": "2.2.0",
        "cachedItems": cached_count,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/logs")
async def get_server_logs():
    return {
        "status": "ok",
        "version": "2.2.0",
        "logs": list(SERVER_LOGS),
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


async def search_web_reviews(product_title: str) -> List[dict]:
    """Ищет отзывы на Отзовике, IRecommend, Роскачестве и маркетплейсах через DuckDuckGo HTML."""
    clean_q = re.sub(r"[\u00ad\u200b«»\"']", " ", product_title).strip()
    query = f"{clean_q} отзывы (site:otzovik.com OR site:irecommend.ru OR site:rskrf.ru OR site:vkusvill.ru OR site:ozon.ru)"
    url = f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}"

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        )
    }

    results = []
    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
            dt_ms = int((time.perf_counter() - t0) * 1000)
            if resp.status_code == 200:
                soup = BeautifulSoup(resp.text, "html.parser")
                for block in soup.select(".result")[:5]:
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
                    results.append(
                        {
                            "title": a_el.get_text(" ", strip=True)[:70],
                            "snippet": snip_el.get_text(" ", strip=True) if snip_el else "",
                            "url": real_url,
                        }
                    )
                log_event("SEARCH", f"DDG search for '{clean_q[:35]}' -> {len(results)} snippets in {dt_ms}ms")
            else:
                log_event("WARN", f"DDG HTTP {resp.status_code} for '{clean_q[:35]}' ({dt_ms}ms)")
    except Exception as exc:
        log_event("ERROR", f"DDG search error for '{clean_q[:35]}': {exc}")

    return results


async def call_ai_model(req: AnalyzeRequest, web_snippets: List[dict]) -> str:
    snippets_text = "\n".join(
        [f"- [{s['title']}]({s['url']}): {s['snippet']}" for s in web_snippets]
    ) or "Прямых отзывов в выдаче не найдено — оценивай строго по составу, КБЖУ и цене."

    prompt = (
        f"Ты — безжалостный и ироничный продуктовый ревизор. Дай ультра-короткую сводку (максимум 3 пункта, без воды) "
        f"по продукту из Яндекс Лавки:\n"
        f"Название: {req.title}\n"
        f"Вес/объём: {req.amount or 'не указан'}, Цена: {req.price or '?'} ₽\n"
        f"Состав: {req.ingredients or 'не указан'}\n"
        f"КБЖУ на 100 г: {req.traits or 'не указано'}\n\n"
        f"Найденные отзывы в интернете (Отзовик / IRecommend / Роскачество):\n{snippets_text}\n\n"
        f"Ответь ровно в 3 коротких строчках:\n"
        f"1. **Отзывы в сети**: что пишут люди (вкус, консистенция, косяки).\n"
        f"2. **Состав и КБЖУ**: есть ли скрытый сахар/крахмал/ММО/дешёвые наполнители и адекватна ли цена.\n"
        f"3. **Вердикт**: 🔥 Годнота / 😐 Под пиво сойдёт / 💀 Скипаем."
    )

    base_url = req.aiBaseUrl.rstrip("/")
    is_local = "localhost" in base_url or "127.0.0.1" in base_url

    headers = {"Content-Type": "application/json"}
    if req.aiApiKey:
        headers["Authorization"] = f"Bearer {req.aiApiKey}"

    payload = {
        "model": req.aiModel or "gemini-4-argon",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
    }

    t0 = time.perf_counter()
    async with httpx.AsyncClient(timeout=25.0, trust_env=not is_local) as client:
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

    if not req.forceRefresh:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT verdict, sources_json FROM product_ai_cache WHERE slug = ?",
                (cache_key,),
            ).fetchone()
            if row:
                log_event("CACHE_HIT", f"Returned SQLite cached verdict for '{cache_key}'")
                return {
                    "cached": True,
                    "aiOk": True,
                    "verdict": row[0],
                    "sources": json.loads(row[1] or "[]"),
                }

    sources = await search_web_reviews(req.title)
    ai_ok = True
    try:
        verdict = await call_ai_model(req, sources)
    except Exception as exc:
        ai_ok = False
        log_event("LLM_ERR", f"AI call failed ({req.aiModel} @ {req.aiBaseUrl}): {exc} -> handing off to Browser Gemini Tab")
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
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
