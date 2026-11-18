/**
 * Lavka Quality Shield v2.0.5 — Background Service Worker (MV3)
 * Зачем нужен этот сервис-воркер:
 * 1. Обход блокировок Chrome Private Network Access (PNA), Mixed Content и CORS:
 *    Когда скрипт на странице https://lavka.yandex.ru стучится напрямую на http://localhost:8083 или http://127.0.0.1:8765,
 *    браузер может заблокировать запрос из-за политики безопасности публичного HTTPS-домена.
 *    Запросы из background.js идут от привилегированного контекста chrome-extension:// и проходят со 100% надёжностью.
 * 2. Фоновое авто-обнаружение локальных серверов ИИ (:8765, :8083, :11434) при установке/запуске.
 */

const SETTINGS_KEY = 'lqs_settings_v2';
const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:8765',
  aiBaseUrl: 'http://localhost:8083/v1',
  aiApiKey: '',
  aiModel: 'gemini-4-argon',
  useDirectBrowserAiFallback: true
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function discoverLocalEndpoints(customApiKey = null) {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  const current = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  const apiKey = customApiKey !== null ? customApiKey : (current.aiApiKey || '');

  const report = {
    backendOk: false,
    backendUrl: current.backendUrl,
    cachedItems: 0,
    aiOk: false,
    aiNeedsKey: false,
    aiBaseUrl: current.aiBaseUrl,
    aiModel: current.aiModel,
    aiProviderName: null,
    models: []
  };

  // 1. Check FastAPI (:8765)
  for (const bUrl of ['http://127.0.0.1:8765', 'http://localhost:8765']) {
    try {
      const r = await fetchWithTimeout(`${bUrl}/api/health`, { method: 'GET' }, 2000);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        report.backendOk = true;
        report.backendUrl = bUrl;
        report.cachedItems = j.cachedItems ?? 0;
        break;
      }
    } catch {
      // ignore
    }
  }

  // 2. Check Gemini Argon bridge (:8083)
  for (const aUrl of ['http://localhost:8083/v1', 'http://127.0.0.1:8083/v1']) {
    try {
      const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      const r = await fetchWithTimeout(`${aUrl}/models`, { method: 'GET', headers }, 2200);
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        const models = Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
        const preferred =
          models.find((id) => id.includes('argon')) ||
          models.find((id) => id.includes('gemini')) ||
          models[0] ||
          'gemini-4-argon';
        report.aiOk = true;
        report.aiBaseUrl = aUrl;
        report.aiModel = preferred;
        report.aiProviderName = 'Gemini Argon (:8083)';
        report.models = models;
        break;
      } else if (r.status === 401 || r.status === 403) {
        report.aiNeedsKey = true;
        report.aiBaseUrl = aUrl;
        report.aiModel = 'gemini-4-argon';
        report.aiProviderName = 'Gemini Argon (:8083)';
        break;
      }
    } catch {
      // ignore
    }
  }

  // 3. Check Ollama (:11434) if :8083 was not found
  if (!report.aiOk && !report.aiNeedsKey) {
    for (const oUrl of ['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1']) {
      try {
        const r = await fetchWithTimeout(`${oUrl}/models`, { method: 'GET' }, 2000);
        if (r.ok) {
          const data = await r.json().catch(() => ({}));
          const models = Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
          const preferred = models[0] || 'qwen2.5:14b';
          report.aiOk = true;
          report.aiBaseUrl = oUrl;
          report.aiModel = preferred;
          report.aiProviderName = 'Ollama (:11434)';
          report.models = models;
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  const nextSettings = {
    ...current,
    backendUrl: report.backendUrl,
    aiBaseUrl: report.aiBaseUrl,
    aiModel: report.aiModel,
    aiApiKey: apiKey
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });

  return { report, settings: nextSettings };
}

chrome.runtime.onInstalled.addListener(() => {
  discoverLocalEndpoints().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'LQS_PROXY_FETCH') {
    (async () => {
      const t0 = performance.now();
      try {
        const resp = await fetchWithTimeout(
          msg.url,
          {
            method: msg.method || 'GET',
            headers: msg.headers || {},
            body: msg.body ? (typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body)) : undefined
          },
          msg.timeoutMs || 28000
        );
        const dt = Math.round(performance.now() - t0);
        const text = await resp.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // non-json body
        }
        sendResponse({
          ok: resp.ok,
          status: resp.status,
          latencyMs: dt,
          json,
          text
        });
      } catch (err) {
        const dt = Math.round(performance.now() - t0);
        sendResponse({
          ok: false,
          status: 0,
          latencyMs: dt,
          error: err && err.message ? err.message : String(err)
        });
      }
    })();
    return true; // async response
  }

  if (msg.type === 'LQS_AUTO_DISCOVER_AI') {
    (async () => {
      try {
        const res = await discoverLocalEndpoints(msg.apiKey !== undefined ? msg.apiKey : null);
        sendResponse({ ok: true, ...res });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  return false;
});
