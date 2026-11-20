/**
 * Lavka Quality Shield — Shared Configuration & Storage Keys
 * Single source of truth for background.js, content.js, and popup.js.
 */
(function (root) {
  'use strict';

  const LQS_CONFIG = Object.freeze({
    VERSION: '2.9.5',
    STORAGE_KEYS: Object.freeze({
      REVIEWS: 'lqs_reviews_v1',
      SETTINGS: 'lqs_settings_v2',
      FLIGHT_LOG: 'lqs_flight_log_v1',
      AI_CACHE: 'lqs_ai_cache_v1',
      AI_USAGE: 'lqs_ai_usage_v1',
      GEMINI_STEALTH_SESSION: 'lqs_gemini_stealth_session_v1',
      PRICE_DB: 'lqs_price_db_v1',
      WATCHLIST: 'lqs_watchlist_v1',
      EXT_STORE_DB: 'lqs_ext_store_prices_v1',
      SAVED_CARTS: 'lqs_saved_carts_v1',
      CART_LOCKS: 'lqs_cart_locks_v1',
      ACCOUNTS_VAULT: 'lqs_accounts_vault_v1',
      DELETED_ACCOUNTS: 'lqs_deleted_accounts_v1',
      BACKEND_TOKEN: 'lqs_backend_token_v1',
      CIRCUIT_BREAKER: 'lqs_circuit_breaker_v1'
    }),
    LIMITS: Object.freeze({
      MAX_LOCAL_AI_CACHE_ITEMS: 500,
      MAX_LOCAL_PRICE_DB_ITEMS: 1500,
      AI_DIRECT_TIMEOUT_MS: 28000,
      BACKEND_ANALYZE_TIMEOUT_MS: 35000,
      DEFAULT_PAID_AI_DAILY_LIMIT: 25,
      DEFAULT_GEMINI_IDLE_CLOSE_MINUTES: 5
    }),
    CLIENT_HEADER: Object.freeze({
      'X-LQS-Client': 'lavka-quality-shield'
    }),
    TOKEN_HEADER_NAME: 'X-LQS-Token',
    DEFAULT_SETTINGS: Object.freeze({
      backendUrl: 'http://127.0.0.1:8765',
      aiProvider: 'gemini_tab',
      aiBaseUrl: 'http://localhost:8083/v1',
      aiApiKey: '',
      aiKeyMask: '',
      aiKeyStoredOnServer: false,
      aiModel: '',
      paidAiDailyLimit: 25,
      preferBrowserGeminiTab: true,
      useDirectBrowserAiFallback: true,
      geminiAccountIndex: 'auto',
      preferredGeminiTabId: null,
      geminiTabMode: 'stealth_window',
      geminiIdleCloseMinutes: 5,
      autoRunAiOnProductPage: true,
      autoOpenDrawerOnAi: true,
      autoWarmupGeminiTab: false,
      lavkaAccountLabel: 'Аккаунт #1 (Основной)',
      priceChartWindowMode: false,
      watchlistCheckIntervalHours: 6,
      liveRadarStores: ['kuper']
    })
  });

  root.LQS_CONFIG = LQS_CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : self);
