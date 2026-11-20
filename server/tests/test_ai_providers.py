import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from routers import cache as cache_router


class TestServerAiProviders(unittest.IsolatedAsyncioTestCase):
    def test_parse_moduleapi_cost_header(self):
        self.assertAlmostEqual(cache_router._parse_moduleapi_cost({"x-moduleapi-cost": "0.0018"}), 0.0018)
        self.assertAlmostEqual(cache_router._parse_moduleapi_cost({"x-moduleapi-cost": "$0.02"}), 0.02)
        self.assertIsNone(cache_router._parse_moduleapi_cost({"x-moduleapi-cost": "invalid"}))
        self.assertIsNone(cache_router._parse_moduleapi_cost({}))

    def test_format_provider_http_error(self):
        self.assertIn("402", cache_router._format_provider_http_error("moduleapi", 402))
        self.assertIn("баланс", cache_router._format_provider_http_error("moduleapi", 402))
        self.assertIn("429", cache_router._format_provider_http_error("moduleapi", 429))

    async def test_call_ai_model_anthropic_adapter(self):
        req = cache_router.AnalyzeRequest(
            title="Творог 5%",
            aiProvider="anthropic",
            aiBaseUrl="https://api.anthropic.com/v1",
            aiApiKey="sk-ant-test",
            aiModel="claude-3-5-sonnet-latest",
        )

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {}
        mock_resp.json.return_value = {
            "content": [{"type": "text", "text": "1. Отзывы хорошие. 2. Состав чистый. 3. Отличный выбор."}]
        }

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = False

        with (
            patch.object(cache_router, "validate_ai_base_url", return_value="https://api.anthropic.com/v1"),
            patch.object(cache_router.httpx, "AsyncClient", return_value=mock_client),
            patch.object(cache_router.db, "log_event"),
        ):
            res = await cache_router.call_ai_model(req, [], None)

        self.assertEqual(res["provider"], "anthropic")
        self.assertIn("Отличный выбор", res["verdict"])
        self.assertIsNone(res["costUsd"])
        call_args = mock_client.post.call_args
        self.assertEqual(call_args.args[0], "https://api.anthropic.com/v1/messages")
        self.assertEqual(call_args.kwargs["headers"]["x-api-key"], "sk-ant-test")
        self.assertEqual(call_args.kwargs["headers"]["anthropic-version"], "2023-06-01")
        self.assertEqual(call_args.kwargs["json"]["max_tokens"], 900)

    async def test_call_ai_model_moduleapi_returns_cost_usd(self):
        req = cache_router.AnalyzeRequest(
            title="Йогурт греческий",
            aiProvider="moduleapi",
            aiBaseUrl="https://moduleapi.pro/v1",
            aiApiKey="sk-mod-test",
            aiModel="gpt-4o-mini",
        )

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"x-moduleapi-cost": "0.0012"}
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": "Хороший йогурт с высоким белком."}}]
        }

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = False

        with (
            patch.object(cache_router, "validate_ai_base_url", return_value="https://moduleapi.pro/v1"),
            patch.object(cache_router.httpx, "AsyncClient", return_value=mock_client),
            patch.object(cache_router.db, "log_event"),
        ):
            res = await cache_router.call_ai_model(req, [], None)

        self.assertEqual(res["provider"], "moduleapi")
        self.assertAlmostEqual(res["costUsd"], 0.0012)
        self.assertIn("Хороший йогурт", res["verdict"])


if __name__ == "__main__":
    unittest.main()
