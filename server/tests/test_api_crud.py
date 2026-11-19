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
                        "guestPrice": 159.0,
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
        self.assertEqual(summary["guestPrice"], 159.0)

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


if __name__ == "__main__":
    unittest.main()
