import os
import sys
import tempfile
import unittest
from fastapi.testclient import TestClient

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

import server

VALID_ORIGIN = "chrome-extension://" + ("a" * 32)
VALID_HEADERS = {
    "Origin": VALID_ORIGIN,
    "X-LQS-Client": "lavka-quality-shield",
}


class TestBackendSecurityAndVault(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_db = server.DB_PATH
        server.DB_PATH = os.path.join(self._tmp.name, "test_lqs.db")
        server.init_db()
        self.client = TestClient(server.app)

    def tearDown(self):
        server.DB_PATH = self._orig_db
        self._tmp.cleanup()

    def test_health_endpoint_ok(self):
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json().get("status"), "ok")

    def test_vault_rejects_missing_headers(self):
        r = self.client.get("/api/accounts/list")
        self.assertEqual(r.status_code, 403)

    def test_vault_rejects_external_and_yandex_origins(self):
        for bad_origin in [
            "https://evil.example.com",
            "https://lavka.yandex.ru",
            "http://127.0.0.1:9999",
            "http://localhost:3000",
        ]:
            r = self.client.get(
                "/api/accounts/list",
                headers={"Origin": bad_origin, "X-LQS-Client": "lavka-quality-shield"},
            )
            self.assertEqual(r.status_code, 403, f"Origin should be rejected: {bad_origin}")

    def test_vault_rejects_wrong_client_header(self):
        r = self.client.get(
            "/api/accounts/list",
            headers={"Origin": VALID_ORIGIN, "X-LQS-Client": "wrong-client"},
        )
        self.assertEqual(r.status_code, 403)

    def test_vault_save_list_delete_roundtrip(self):
        payload = {
            "accountId": "acc_test_1",
            "label": "Test Account",
            "login": "tester",
            "password": "sample-value",
            "note": "unit test",
            "yandexLogin": "tester@yandex.ru",
            "cookieCount": 1,
            "cookies": [{"name": "sample", "value": "123"}],
            "localStorageData": {"theme": "dark"},
        }
        r_save = self.client.post("/api/accounts/save", json=payload, headers=VALID_HEADERS)
        self.assertEqual(r_save.status_code, 200)

        r_list = self.client.get("/api/accounts/list", headers=VALID_HEADERS)
        self.assertEqual(r_list.status_code, 200)
        accounts = r_list.json().get("accounts", [])
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["accountId"], "acc_test_1")
        self.assertEqual(accounts[0]["cookies"][0]["name"], "sample")

        r_del = self.client.delete("/api/accounts/acc_test_1", headers=VALID_HEADERS)
        self.assertEqual(r_del.status_code, 200)

        r_list_after = self.client.get("/api/accounts/list", headers=VALID_HEADERS)
        self.assertEqual(r_list_after.json().get("accounts", []), [])


if __name__ == "__main__":
    unittest.main()
