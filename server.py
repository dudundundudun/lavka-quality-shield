"""
Lavka Quality Shield v2.0.5 — Локальный FastAPI сервер (127.0.0.1:8765)
Исправления по итогам аудита v2.0.5:
1. Защита SQLite-кэша от отравления ошибками (Cache Poisoning Fix):
   если ИИ-мост (:8083) временно выключен или вернул 401, текст ошибки больше НЕ сохраняется в таблицу product_ai_cache.
2. Авто-очистка старых ошибочных записей ("⚠️ Ошибка вызова ИИ...") при старте сервера.
3. При ошибке ИИ сервер возвращает ok=False, но сохраняет найденные ссылки на внешние отзывы (sources),
   чтобы расширение могло показать ссылки и автоматически переключиться на резервный канал.
"""

import os
import re
import json
import sqlite3
import urllib.parse
from datetime import datetime
from typing import List, Optional

# Защита от перехвата локальных запросов системным прокси/VPN на Windows
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lavka_ai_cache.db")

app = FastAPI(title="Lavka Quality Shield Backend", version="2.0.5")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
        # Очищаем кэш от любых старых записей с текстом ошибки подключения
        conn.execute(
            "DELETE FROM product_ai_cache WHERE verdict LIKE '⚠️ Ошибка вызова ИИ%'"
        )
        conn.commit()


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


@app.get("/api/health")
async def health_check():
    cached_count = 0
    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute("SELECT COUNT(*) FROM product_ai_cache").fetchone()
            cached_count = row[0] if row else 0
    except Exception:
        pass
    return {
        "status": "ok",
        "version": "2.0.5",
        "cachedItems": cached_count,
        "timestamp": datetime.utcnow().isoformat()
    }


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
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
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
    except Exception:
        pass

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

    async with httpx.AsyncClient(timeout=25.0, trust_env=not is_local) as client:
        resp = await client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()


@app.post("/api/analyze-product")
async def analyze_product(req: AnalyzeRequest):
    cache_key = (req.slug or req.title).strip().lower()

    if not req.forceRefresh:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT verdict, sources_json FROM product_ai_cache WHERE slug = ?",
                (cache_key,),
            ).fetchone()
            if row and not str(row[0]).startswith("⚠️ Ошибка вызова ИИ"):
                return {
                    "ok": True,
                    "cached": True,
                    "verdict": row[0],
                    "sources": json.loads(row[1] or "[]"),
                }

    sources = await search_web_reviews(req.title)
    try:
        verdict = await call_ai_model(req, sources)
    except Exception as exc:
        # НЕ сохраняем ошибку в SQLite-кэш, чтобы следующая попытка после ввода ключа сработала сразу!
        return {
            "ok": False,
            "cached": False,
            "error": str(exc),
            "sources": sources,
        }

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
                datetime.utcnow().isoformat(),
            ),
        )
        conn.commit()

    return {
        "ok": True,
        "cached": False,
        "verdict": verdict,
        "sources": sources,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
