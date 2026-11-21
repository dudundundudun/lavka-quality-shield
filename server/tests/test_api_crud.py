import os
import sys
import base64
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

import security
import server
from routers import cache as cache_router

PINNED_EXT_ID = "c" * 32
VALID_ORIGIN = f"chrome-extension://{PINNED_EXT_ID}"


class TestApiCrudEndpoints(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_db = server.DB_PATH
        self._orig_key = security.SECRET_KEY_PATH
        self._orig_pinned = security.PINNED_EXT_PATH
        self._orig_env_ext = os.environ.pop("LQS_EXTENSION_ID", None)

        server.DB_PATH = os.path.join(self._tmp.name, "test_crud.db")
        security.SECRET_KEY_PATH = os.path.join(self._tmp.name, "secret.key")
        security.PINNED_EXT_PATH = os.path.join(self._tmp.name, "pinned_extension.json")

        server.init_db()
        cache_router.reset_analyze_rate_limiter()
        self.client = TestClient(server.app)

        pair_resp = self.client.post(
            "/api/auth/pair",
            headers={"Origin": VALID_ORIGIN, "X-LQS-Client": "lavka-quality-shield"},
        )
        self.assertEqual(pair_resp.status_code, 200)
        self.headers = {
            "Origin": VALID_ORIGIN,
            "X-LQS-Client": "lavka-quality-shield",
            "X-LQS-Token": pair_resp.json()["token"],
        }

    def tearDown(self):
        server.DB_PATH = self._orig_db
        security.SECRET_KEY_PATH = self._orig_key
        security.PINNED_EXT_PATH = self._orig_pinned
        if self._orig_env_ext is not None:
            os.environ["LQS_EXTENSION_ID"] = self._orig_env_ext
        self._tmp.cleanup()

    def test_price_record_get_by_slug_and_title_and_list(self):
        r1 = self.client.post(
            "/api/price/record",
            json={
                "accountId": "Аккаунт #1",
                "items": [
                    {
                        "slug": "dobry_cola_zero_15",
                        "title": "Напиток Добрый Cola без сахара 1,5 л",
                        "price": 179.0,
                        "oldPrice": 199.0,
                        "amount": "1,5 л",
                        "competitorMinPrice": 144.0,
                        "competitorSummary": "Магнит 144 ₽",
                    }
                ],
            },
            headers=self.headers,
        )
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r1.json()["updated"], 1)

        # Record a second observation on Account #2 with lower price
        r2 = self.client.post(
            "/api/price/record",
            json={
                "accountId": "Аккаунт #2",
                "items": [
                    {
                        "slug": "dobry_cola_zero_15",
                        "title": "Напиток Добрый Cola без сахара 1,5 л",
                        "price": 149.0,
                        "amount": "1,5 л",
                    }
                ],
            },
            headers=self.headers,
        )
        self.assertEqual(r2.status_code, 200)

        # Lookup by exact slug
        r_get = self.client.get("/api/price/product/dobry_cola_zero_15", headers=self.headers)
        self.assertEqual(r_get.status_code, 200)
        summary = r_get.json()["summary"]
        self.assertEqual(summary["minPrice"], 149.0)
        self.assertEqual(summary["maxPrice"], 179.0)
        self.assertEqual(summary["avgPrice"], 164.0)
        self.assertEqual(summary["lastPrice"], 149.0)
        self.assertNotIn("guestPrice", summary)
        self.assertNotIn("Гость (без куки)", summary["accounts"])

        # Lookup by unknown HEX-ID slug with matching title (uses norm_title index)
        r_hex = self.client.get(
            "/api/price/product/4cbf6c0b9999",
            params={"title": "Напиток Добрый Cola без сахара 1,5 л"},
            headers=self.headers,
        )
        self.assertEqual(r_hex.status_code, 200)
        self.assertEqual(r_hex.json()["status"], "ok")
        self.assertEqual(r_hex.json()["summary"]["slug"], "dobry_cola_zero_15")

        # List tracked prices
        r_list = self.client.get("/api/price/list?limit=50", headers=self.headers)
        self.assertEqual(r_list.status_code, 200)
        self.assertEqual(r_list.json()["count"], 1)

    def test_cart_save_and_latest_roundtrip(self):
        r_save = self.client.post(
            "/api/cart/save",
            json={
                "accountId": "Аккаунт #1",
                "items": [
                    {
                        "slug": "milk_prostokvashino_930",
                        "title": "Молоко Простоквашино 2,5% 930 мл",
                        "qty": 2,
                        "price": 109.0,
                        "amount": "930 мл",
                    }
                ],
                "totalPrice": 218.0,
            },
            headers=self.headers,
        )
        self.assertEqual(r_save.status_code, 200)
        self.assertEqual(r_save.json()["itemsCount"], 1)
        self.assertEqual(r_save.json()["totalPrice"], 218.0)

        r_latest = self.client.get("/api/cart/latest", headers=self.headers)
        self.assertEqual(r_latest.status_code, 200)
        data = r_latest.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["latest"]["accountId"], "Аккаунт #1")
        self.assertEqual(len(data["latest"]["items"]), 1)
        self.assertEqual(data["latest"]["items"][0]["minPrice"], 109.0)
        self.assertEqual(len(data["cartsByAccount"]), 1)

    def test_ai_cache_save_and_analyze_cache_hit_by_slug_and_norm_title(self):
        r_save = self.client.post(
            "/api/save-cache",
            json={
                "slug": "tvorog_5_200g",
                "title": "Творог 5% 200 г",
                "verdict": "1. Отзывы хорошие.\n2. Чистый состав.\n3. Отличный выбор.",
                "sources": [{"title": "Отзовик", "url": "https://otzovik.com/example"}],
            },
            headers=self.headers,
        )
        self.assertEqual(r_save.status_code, 200)

        # Cache hit by slug
        r_hit1 = self.client.post(
            "/api/analyze-product",
            json={"slug": "tvorog_5_200g", "title": "Творог 5% 200 г", "forceRefresh": False},
            headers=self.headers,
        )
        self.assertEqual(r_hit1.status_code, 200)
        self.assertTrue(r_hit1.json()["cached"])
        self.assertIn("Чистый состав", r_hit1.json()["verdict"])

        # Cache hit by norm_title when opened via HEX-ID from cart
        r_hit2 = self.client.post(
            "/api/analyze-product",
            json={"slug": "a1b2c3d4e5f6", "title": "Творог 5% 200 г", "forceRefresh": False},
            headers=self.headers,
        )
        self.assertEqual(r_hit2.status_code, 200)
        self.assertTrue(r_hit2.json()["cached"])
        self.assertIn("Отличный выбор", r_hit2.json()["verdict"])

    def test_logs_endpoint_returns_recent_events(self):
        r = self.client.get("/api/logs", headers=self.headers)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "ok")
        self.assertIsInstance(r.json()["logs"], list)

    def test_price_and_cart_validation_limits(self):
        r_low = self.client.get("/api/price/list?limit=0", headers=self.headers)
        self.assertEqual(r_low.status_code, 422)

        r_high = self.client.get("/api/price/list?limit=2001", headers=self.headers)
        self.assertEqual(r_high.status_code, 422)

        too_many_prices = [{"slug": f"item_{i}", "title": f"Item {i}", "price": 100.0} for i in range(501)]
        r_rec = self.client.post(
            "/api/price/record",
            json={"accountId": "Аккаунт #1", "items": too_many_prices},
            headers=self.headers,
        )
        self.assertEqual(r_rec.status_code, 422)

        too_many_cart = [{"slug": f"item_{i}", "title": f"Item {i}", "qty": 1, "price": 100.0} for i in range(501)]
        r_cart = self.client.post(
            "/api/cart/save",
            json={"accountId": "Аккаунт #1", "items": too_many_cart, "totalPrice": 50100.0},
            headers=self.headers,
        )
        self.assertEqual(r_cart.status_code, 422)

    def test_accounts_list_returns_metadata_and_secrets_endpoint_returns_secrets(self):
        def _enc(val: str) -> str:
            return "dpapi:" + base64.b64encode(val.encode("utf-8")).decode("ascii") if val else ""

        def _dec(val):
            if not val:
                return ""
            return base64.b64decode(val[len("dpapi:"):]).decode("utf-8") if val.startswith("dpapi:") else val

        with patch.object(security, "_protect_field", side_effect=_enc), patch.object(
            security, "_unprotect_field", side_effect=_dec
        ):
            r_save = self.client.post(
                "/api/accounts/save",
                json={
                    "accountId": "acc_crud_1",
                    "label": "CRUD Account",
                    "login": "crud_user",
                    "password": "crud-secret-password",
                    "note": "crud test",
                    "yandexLogin": "crud@yandex.ru",
                    "cookies": [{"name": "yandexuid", "value": "999"}],
                    "localStorageData": {"k": "v"},
                },
                headers=self.headers,
            )
            self.assertEqual(r_save.status_code, 200)

            r_list = self.client.get("/api/accounts/list", headers=self.headers)
            self.assertEqual(r_list.status_code, 200)
            accs = r_list.json()["accounts"]
            self.assertEqual(len(accs), 1)
            self.assertEqual(accs[0]["accountId"], "acc_crud_1")
            self.assertEqual(accs[0]["cookieCount"], 1)
            self.assertTrue(accs[0]["hasPassword"])
            self.assertNotIn("password", accs[0])
            self.assertNotIn("cookies", accs[0])
            self.assertNotIn("localStorageData", accs[0])

            r_sec = self.client.get("/api/accounts/acc_crud_1/secrets", headers=self.headers)
            self.assertEqual(r_sec.status_code, 200)
            sec = r_sec.json()
            self.assertEqual(sec["password"], "crud-secret-password")
            self.assertEqual(sec["cookies"], [{"name": "yandexuid", "value": "999"}])
            self.assertEqual(sec["localStorageData"], {"k": "v"})


    def test_analyze_product_rate_limits_uncached_only_not_cache_hits(self):
        cache_router.reset_analyze_rate_limiter()
        # Seed a cached product
        r_save = self.client.post(
            "/api/save-cache",
            json={
                "slug": "cached_milk_1l",
                "title": "Молоко Кэш 1 л",
                "verdict": "1. Хорошие отзывы.\n2. Чистый состав.\n3. Отличный выбор.",
                "sources": [],
            },
            headers=self.headers,
        )
        self.assertEqual(r_save.status_code, 200)

        async def _fake_search(*_args, **_kwargs):
            return []

        async def _fake_ai(*_args, **_kwargs):
            return "1. Отзывов нет.\n2. Состав ок.\n3. Хороший вариант."

        with patch.object(cache_router, "ANALYZE_RATE_LIMIT_MAX_REQUESTS", 2), patch.object(
            cache_router, "search_web_reviews", side_effect=_fake_search
        ), patch.object(cache_router, "call_ai_model", side_effect=_fake_ai):
            # 2 uncached requests allowed
            for idx in range(2):
                r = self.client.post(
                    "/api/analyze-product",
                    json={"slug": f"uncached_{idx}", "title": f"Новый товар {idx}", "forceRefresh": True},
                    headers=self.headers,
                )
                self.assertEqual(r.status_code, 200)
                self.assertFalse(r.json()["cached"])

            # 3rd uncached request -> HTTP 429
            r_limited = self.client.post(
                "/api/analyze-product",
                json={"slug": "uncached_3", "title": "Новый товар 3", "forceRefresh": True},
                headers=self.headers,
            )
            self.assertEqual(r_limited.status_code, 429)

            # Cache hit is still allowed even when uncached limit is exhausted
            r_hit = self.client.post(
                "/api/analyze-product",
                json={"slug": "cached_milk_1l", "title": "Молоко Кэш 1 л", "forceRefresh": False},
                headers=self.headers,
            )
            self.assertEqual(r_hit.status_code, 200)
            self.assertTrue(r_hit.json()["cached"])


    def test_price_history_series_exact_and_daily_avg(self):
        # Record 3 observations across 2 accounts
        self.client.post(
            "/api/price/record",
            json={
                "accountId": "Аккаунт #1",
                "items": [{"slug": "cheese_brie_125", "title": "Сыр Бри 125 г", "price": 249.0, "amount": "125 г"}],
            },
            headers=self.headers,
        )
        self.client.post(
            "/api/price/record",
            json={
                "accountId": "Аккаунт #1",
                "items": [{"slug": "cheese_brie_125", "title": "Сыр Бри 125 г", "price": 219.0, "amount": "125 г"}],
            },
            headers=self.headers,
        )
        self.client.post(
            "/api/price/record",
            json={
                "accountId": "Аккаунт #2",
                "items": [{"slug": "cheese_brie_125", "title": "Сыр Бри 125 г", "price": 229.0, "amount": "125 г"}],
            },
            headers=self.headers,
        )

        r_hist = self.client.get("/api/price/history/cheese_brie_125?days=90", headers=self.headers)
        self.assertEqual(r_hist.status_code, 200)
        data = r_hist.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(len(data["points"]), 3)
        self.assertEqual(data["stats"]["minPrice"], 219.0)
        self.assertEqual(data["stats"]["maxPrice"], 249.0)
        self.assertEqual(data["stats"]["lastPrice"], 229.0)
        self.assertEqual(len(data["dailyAvg"]), 1)
        self.assertAlmostEqual(data["dailyAvg"][0]["price"], round((249 + 219 + 229) / 3, 2), places=2)

        # Filter by accountId
        r_acc = self.client.get(
            "/api/price/history/cheese_brie_125",
            params={"days": 90, "accountId": "Аккаунт #1"},
            headers=self.headers,
        )
        self.assertEqual(r_acc.status_code, 200)
        self.assertEqual(len(r_acc.json()["points"]), 2)

    def test_watchlist_toggle_list_and_delete(self):
        # Add to watchlist
        r_add = self.client.post(
            "/api/watchlist/toggle",
            json={
                "slug": "avocado_hass_2pcs",
                "title": "Авокадо Хасс 2 шт",
                "amount": "2 шт",
                "price": 299.0,
                "targetPrice": 250.0,
            },
            headers=self.headers,
        )
        self.assertEqual(r_add.status_code, 200)
        self.assertTrue(r_add.json()["watched"])
        self.assertEqual(r_add.json()["item"]["baselinePrice"], 299.0)
        self.assertEqual(r_add.json()["item"]["targetPrice"], 250.0)

        # Record a price drop and verify watchlist reflects updated price & diff
        self.client.post(
            "/api/price/record",
            json={
                "accountId": "Аккаунт #1",
                "items": [{"slug": "avocado_hass_2pcs", "title": "Авокадо Хасс 2 шт", "price": 239.0}],
            },
            headers=self.headers,
        )
        r_list = self.client.get("/api/watchlist", headers=self.headers)
        self.assertEqual(r_list.status_code, 200)
        self.assertEqual(r_list.json()["count"], 1)
        w_item = r_list.json()["items"][0]
        self.assertEqual(w_item["lastPrice"], 239.0)
        self.assertEqual(w_item["priceDiff"], -60.0)

        # Toggle off
        r_off = self.client.post(
            "/api/watchlist/toggle",
            json={"slug": "avocado_hass_2pcs"},
            headers=self.headers,
        )
        self.assertEqual(r_off.status_code, 200)
        self.assertFalse(r_off.json()["watched"])

        # Re-add and DELETE
        self.client.post(
            "/api/watchlist/toggle",
            json={"slug": "avocado_hass_2pcs", "title": "Авокадо Хасс 2 шт", "watch": True},
            headers=self.headers,
        )
        r_del = self.client.delete("/api/watchlist/avocado_hass_2pcs", headers=self.headers)
        self.assertEqual(r_del.status_code, 200)
        self.assertTrue(r_del.json()["removed"])
        self.assertEqual(self.client.get("/api/watchlist", headers=self.headers).json()["count"], 0)


    def test_product_store_links_crud_and_auth(self):
        # Unauthenticated request rejected
        unauth = self.client.get("/api/price/links/lamber_230g")
        self.assertIn(unauth.status_code, (401, 403))

        # Save direct links
        r_save = self.client.post(
            "/api/price/links",
            headers=self.headers,
            json={
                "slug": "lamber_230g",
                "links": [
                    {
                        "storeId": "magnit",
                        "storeName": "Магнит",
                        "url": "https://magnit.ru/product/123456-lamber",
                        "title": "Сыр Ламбер 230 г",
                        "lastPrice": 279,
                    },
                    {
                        "storeId": "kuper",
                        "storeName": "Купер",
                        "url": "https://kuper.ru/pyaterochka/products/lamber-230g",
                        "title": "Сыр Ламбер 230 г",
                        "sourceRetailer": "Пятёрочка",
                        "lastPrice": 289,
                    },
                ],
            },
        )
        self.assertEqual(r_save.status_code, 200)
        self.assertEqual(r_save.json().get("saved"), 2)

        # Fetch links
        r_get = self.client.get("/api/price/links/lamber_230g", headers=self.headers)
        self.assertEqual(r_get.status_code, 200)
        links = r_get.json().get("links", {})
        self.assertEqual(links["magnit"]["url"], "https://magnit.ru/product/123456-lamber")
        self.assertEqual(links["kuper"]["sourceRetailer"], "Пятёрочка")

        # Delete stale link
        r_del = self.client.delete("/api/price/links/lamber_230g/magnit", headers=self.headers)
        self.assertEqual(r_del.status_code, 200)
        self.assertTrue(r_del.json().get("deleted"))

        r_get2 = self.client.get("/api/price/links/lamber_230g", headers=self.headers)
        self.assertNotIn("magnit", r_get2.json().get("links", {}))
        self.assertIn("kuper", r_get2.json().get("links", {}))


    def test_external_offers_batch_match_history_and_unlimited_storage(self):
        # Unauthenticated requests must be rejected
        self.assertIn(
            self.client.post("/api/external-offers/batch", json={"store": "Магнит", "offers": []}).status_code,
            (401, 403),
        )
        self.assertIn(
            self.client.post("/api/external-offers/match", json={"title": "Молоко 930 мл"}).status_code,
            (401, 403),
        )
        self.assertIn(
            self.client.get("/api/external-offers/history", params={"title": "Молоко"}).status_code,
            (401, 403),
        )

        # Save > 800 offers across multiple batches to prove there is no 800-item SQLite cap
        batch1 = [
            {
                "store": "Магнит",
                "title": f"Тестовый продукт Магнит #{i} 500 г",
                "brand": "ТестБренд",
                "amount": "500 г",
                "price": 100 + (i % 50),
                "url": f"https://magnit.ru/product/{10000 + i}",
            }
            for i in range(450)
        ]
        batch2 = [
            {
                "store": "Пятёрочка",
                "title": f"Тестовый продукт Пятёрочка #{i} 500 г",
                "brand": "ТестБренд",
                "amount": "500 г",
                "price": 110 + (i % 50),
                "url": f"https://5ka.ru/product/{20000 + i}",
            }
            for i in range(450)
        ]
        r1 = self.client.post("/api/external-offers/batch", json={"store": "Магнит", "offers": batch1}, headers=self.headers)
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r1.json()["savedCount"], 450)
        self.assertEqual(r1.json()["totalInSqlite"], 450)

        r2 = self.client.post("/api/external-offers/batch", json={"store": "Пятёрочка", "offers": batch2}, headers=self.headers)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()["savedCount"], 450)
        self.assertEqual(r2.json()["totalInSqlite"], 900)

        # Save matching offers across stores for Черноголовка Кола 1,5 л
        r_cola = self.client.post(
            "/api/external-offers/batch",
            json={
                "store": "Пятёрочка",
                "offers": [
                    {
                        "store": "Пятёрочка",
                        "title": "Напиток Черноголовка Кола 1,5 л",
                        "brand": "Черноголовка",
                        "amount": "1,5 л",
                        "price": 129,
                        "oldPrice": 159,
                        "url": "https://5ka.ru/product/chernogolovka-cola-15l",
                    },
                    {
                        "store": "Магнит",
                        "title": "Напиток Черноголовка Кола 1,5 л",
                        "brand": "Черноголовка",
                        "amount": "1,5 л",
                        "price": 119,
                        "url": "https://magnit.ru/product/chernogolovka-cola-15l",
                    },
                ],
            },
            headers=self.headers,
        )
        self.assertEqual(r_cola.status_code, 200)
        self.assertEqual(r_cola.json()["totalInSqlite"], 902)

        # Match excluding Пятёрочка -> should return Магнит only
        r_match = self.client.post(
            "/api/external-offers/match",
            json={
                "title": "Напиток Черноголовка Кола 1,5 л",
                "brand": "Черноголовка",
                "amount": "1,5 л",
                "excludeStore": "Пятёрочка",
            },
            headers=self.headers,
        )
        self.assertEqual(r_match.status_code, 200)
        m_data = r_match.json()
        self.assertEqual(m_data["count"], 1)
        self.assertEqual(m_data["offers"][0]["store"], "Магнит")
        self.assertEqual(m_data["offers"][0]["price"], 119)

        # History endpoint by URL returns daily point and stats
        r_hist = self.client.get(
            "/api/external-offers/history",
            params={"url": "https://5ka.ru/product/chernogolovka-cola-15l", "days": 90},
            headers=self.headers,
        )
        self.assertEqual(r_hist.status_code, 200)
        h_data = r_hist.json()
        self.assertEqual(h_data["store"], "Пятёрочка")
        self.assertEqual(len(h_data["points"]), 1)
        self.assertEqual(h_data["stats"]["lastPrice"], 129.0)


    def test_reject_competitor_match_persists_and_filters_match_results(self):
        self.client.post(
            "/api/external-offers/batch",
            json={
                "store": "Магнит",
                "offers": [
                    {
                        "store": "Магнит",
                        "title": "Горошек зелёный молодой Bonduelle 400 г",
                        "amount": "400 г",
                        "price": 129,
                        "url": "https://magnit.ru/product/bonduelle-400",
                    }
                ],
            },
            headers=self.headers,
        )
        r_before = self.client.post(
            "/api/external-offers/match",
            json={"title": "Горошек зелёный молодой Bonduelle 400 г", "amount": "400 г"},
            headers=self.headers,
        )
        self.assertEqual(r_before.json()["count"], 1)

        r_rej = self.client.post(
            "/api/external-offers/reject-match",
            json={
                "sourceTitle": "Горошек зелёный молодой Bonduelle 400 г",
                "rejectedUrl": "https://magnit.ru/product/bonduelle-400",
                "rejectedTitle": "Горошек зелёный молодой Bonduelle 400 г",
            },
            headers=self.headers,
        )
        self.assertEqual(r_rej.status_code, 200)
        self.assertGreaterEqual(r_rej.json()["saved"], 1)

        r_after = self.client.post(
            "/api/external-offers/match",
            json={"title": "Горошек зелёный молодой Bonduelle 400 г", "amount": "400 г"},
            headers=self.headers,
        )
        self.assertEqual(r_after.json()["count"], 0)


if __name__ == "__main__":
    unittest.main()
