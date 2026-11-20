import json
import os
import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(SERVER_DIR)
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

import server


class TestSqliteHardeningAndConfigSync(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_db = server.DB_PATH
        server.DB_PATH = os.path.join(self._tmp.name, "test_step2.db")
        server.init_db()
        self.client = TestClient(server.app)

    def tearDown(self):
        server.DB_PATH = self._orig_db
        self._tmp.cleanup()

    def test_sqlite_wal_busy_timeout_and_user_version(self):
        with server.get_db_connection() as conn:
            journal_mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0]).lower()
            busy_timeout = int(conn.execute("PRAGMA busy_timeout").fetchone()[0])
            user_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        self.assertEqual(journal_mode, "wal")
        self.assertEqual(busy_timeout, 5000)
        self.assertEqual(user_version, server.SCHEMA_VERSION)
        self.assertGreaterEqual(user_version, 2)

    def test_sqlite_indexes_present(self):
        expected_indexes = {
            "idx_price_obs_slug",
            "idx_price_obs_slug_observed",
            "idx_ai_cache_norm_title",
            "idx_ai_cache_updated_at",
            "idx_price_summary_norm_title",
            "idx_price_summary_updated_at",
            "idx_price_watchlist_updated",
        }
        with server.get_db_connection() as conn:
            existing = {
                row[0]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'").fetchall()
            }
        self.assertTrue(expected_indexes.issubset(existing), f"Missing indexes: {expected_indexes - existing}")

    def test_legacy_v0_schema_migrates_and_backfills_norm_title(self):
        legacy_db = os.path.join(self._tmp.name, "legacy_v0.db")
        with sqlite3.connect(legacy_db) as conn:
            conn.execute(
                """
                CREATE TABLE product_ai_cache (
                    slug TEXT PRIMARY KEY,
                    title TEXT,
                    verdict TEXT,
                    sources_json TEXT,
                    updated_at TEXT
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE product_price_summary (
                    slug TEXT PRIMARY KEY,
                    title TEXT,
                    amount TEXT,
                    min_price REAL,
                    max_price REAL,
                    avg_price REAL,
                    last_price REAL,
                    guest_price REAL,
                    competitor_min_price REAL,
                    competitor_summary TEXT,
                    accounts_json TEXT,
                    history_json TEXT,
                    updated_at TEXT
                )
                """
            )
            conn.execute(
                "INSERT INTO product_ai_cache (slug, title, verdict, sources_json, updated_at) VALUES (?, ?, ?, ?, ?)",
                ("cola_zero_15", "Добрый Cola без сахара 1,5 л", "Отличный выбор", "[]", "2026-11-18T10:00:00Z"),
            )
            conn.execute("PRAGMA user_version = 0")
            conn.commit()

        server.DB_PATH = legacy_db
        server.init_db()

        with server.get_db_connection(legacy_db) as conn:
            ver = int(conn.execute("PRAGMA user_version").fetchone()[0])
            row = conn.execute("SELECT norm_title FROM product_ai_cache WHERE slug = 'cola_zero_15'").fetchone()
        self.assertEqual(ver, server.SCHEMA_VERSION)
        self.assertIsNotNone(row)
        self.assertTrue(row[0] and "cola" in row[0])

    def test_health_reports_version_and_schema_metadata(self):
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(data.get("version"), "2.9.4")
        self.assertEqual(data.get("schemaVersion"), server.SCHEMA_VERSION)
        self.assertEqual(str(data.get("journalMode", "")).lower(), "wal")

    def test_version_synchronized_across_project_files(self):
        expected = "2.9.4"
        manifest = json.loads((Path(REPO_ROOT) / "extension" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], expected)
        self.assertIn(f"v{expected}", manifest["action"]["default_title"])

        config_js = (Path(REPO_ROOT) / "extension" / "shared" / "config.js").read_text(encoding="utf-8")
        self.assertIn(f"VERSION: '{expected}'", config_js)

        readme_path = Path(REPO_ROOT) / "README.md"
        if not readme_path.exists():
            readme_path = Path(REPO_ROOT) / "readme.md"
        readme = readme_path.read_text(encoding="utf-8")
        self.assertIn(f"v{expected}", readme)

        self.assertEqual(server.APP_VERSION, expected)

    def test_db_connection_closes_on_context_exit(self):
        with server.get_db_connection() as conn:
            self.assertEqual(conn.execute("SELECT 1").fetchone()[0], 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")

    def test_no_hardcoded_gemini_4_argon_in_defaults(self):
        config_js = (Path(REPO_ROOT) / "extension" / "shared" / "config.js").read_text(encoding="utf-8")
        self.assertNotIn("gemini-4-argon", config_js)
        self.assertEqual(server.AnalyzeRequest(title="Молоко").aiModel, "")


if __name__ == "__main__":
    unittest.main()
