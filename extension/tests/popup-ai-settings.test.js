const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extDir = path.resolve(__dirname, '..');

function loadAiProvidersSandbox() {
  const sandbox = {
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    Promise
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(extDir, 'bg', 'ai-providers.js'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'ai-providers.js' });
  return sandbox.LQS_AI_PROVIDERS;
}

function loadBackgroundWithCustomFetch(fetchImpl) {
  const onMessageListeners = [];
  const storageData = {
    lqs_backend_token_v1: 'a'.repeat(64),
    lqs_settings_v2: {
      backendUrl: 'http://127.0.0.1:8765',
      aiProvider: 'moduleapi',
      aiBaseUrl: 'https://moduleapi.pro/v1',
      aiApiKey: '',
      aiKeyMask: '',
      aiKeyStoredOnServer: false
    }
  };

  const chromeMock = {
    runtime: {
      id: 'test-extension-id-1234567890abcdef',
      lastError: null,
      getURL: (p) => `chrome-extension://test-extension-id-1234567890abcdef/${String(p || '').replace(/^\/+/, '')}`,
      getPlatformInfo: (cb) => cb && cb({ os: 'win' }),
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: (fn) => onMessageListeners.push(fn) }
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      query: (_q, cb) => cb && cb([]),
      create: (_o, cb) => cb && cb({ id: 1 }),
      update: (_id, _o, cb) => cb && cb({ id: 1 }),
      remove: (_id, cb) => cb && cb(),
      sendMessage: (_id, _m, cb) => cb && cb({})
    },
    storage: {
      local: {
        get: (keys, cb) => {
          if (typeof keys === 'function') return keys({ ...storageData });
          const out = {};
          const list = Array.isArray(keys) ? keys : (keys && typeof keys === 'object' ? Object.keys(keys) : [keys]);
          for (const k of list) {
            if (k in storageData) out[k] = storageData[k];
          }
          if (cb) cb(out);
        },
        set: (obj, cb) => {
          Object.assign(storageData, obj || {});
          if (cb) cb();
        },
        remove: (keys, cb) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete storageData[k];
          if (cb) cb();
        }
      }
    },
    cookies: {
      getAll: (_d, cb) => cb && cb([]),
      set: (_d, cb) => cb && cb({}),
      remove: (_d, cb) => cb && cb({})
    },
    scripting: { executeScript: async () => [] },
    alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: () => {} } }
  };

  const sandbox = {
    chrome: chromeMock,
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Promise,
    RegExp,
    Error,
    Array,
    Object,
    Number,
    String,
    Boolean,
    fetch: fetchImpl
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...scripts) => {
    for (const rel of scripts) {
      const fullPath = path.join(extDir, rel);
      vm.runInContext(fs.readFileSync(fullPath, 'utf8'), ctx, { filename: fullPath });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(extDir, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return { listener: onMessageListeners[0], storageData };
}

test('maskApiKey and isMaskedApiKey mask real keys as sk-...1234 and detect masked placeholders', () => {
  const mod = loadAiProvidersSandbox();
  assert.equal(mod.maskApiKey('sk-mod-secret-key-9876'), 'sk-...9876');
  assert.equal(mod.maskApiKey('abc'), '***');
  assert.equal(mod.maskApiKey(''), '');
  assert.equal(mod.isMaskedApiKey('sk-...9876'), true);
  assert.equal(mod.isMaskedApiKey(''), true);
  assert.equal(mod.isMaskedApiKey('sk-mod-secret-key-9876'), false);
});

test('popup.html contains Lavka-styled AI provider block with all 8 presets, Gemini stealth controls, budget bar, and no MV3 CSP violations', () => {
  const html = fs.readFileSync(path.join(extDir, 'popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(extDir, 'popup.js'), 'utf8');

  // All 8 provider presets in dropdown
  for (const prov of ['gemini_tab', 'moduleapi', 'openai', 'anthropic', 'gemini_api', 'deepseek', 'openrouter', 'custom_openai']) {
    assert.match(html, new RegExp(`<option value="${prov}">`), `Missing provider option ${prov} in popup.html`);
  }

  // Required UI controls
  assert.match(html, /id="sel-ai-provider"/);
  assert.match(html, /id="ai-base-url-field"[^>]*hidden/);
  assert.match(html, /<input\b[^>]*type="password"[^>]*id="inp-ai-key"/);
  assert.match(html, /id="test-ai-provider-btn"/);
  assert.match(html, /id="moduleapi-check-link"[^>]*href="https:\/\/www\.moduleapi\.pro\/check"/);
  assert.match(html, /id="sel-gemini-tab-mode"/);
  assert.match(html, /value="stealth_window"/);
  assert.match(html, /value="on_demand_tab"/);
  assert.match(html, /value="keep_open"/);
  assert.match(html, /id="inp-gemini-idle-minutes"/);
  assert.match(html, /id="ai-usage-summary"/);
  assert.match(html, /id="inp-paid-daily-limit"/);
  assert.match(html, /id="ai-key-storage-badge"/);
  assert.match(html, /id="delete-ai-key-btn"/);
  assert.match(html, /<script src="bg\/ai-providers\.js"><\/script>/);

  // JS hooks present
  assert.match(js, /LQS_TEST_AI_PROVIDER/);
  assert.match(js, /LQS_GET_AI_USAGE_STATS/);
  assert.match(js, /LQS_SAVE_AI_KEY/);
  assert.match(js, /LQS_GET_AI_KEY_STATUS/);
  assert.match(js, /LQS_DELETE_AI_KEY/);

  // Strict MV3 CSP: no inline onclick, eval, new Function
  assert.doesNotMatch(html, /\bonclick\s*=/i);
  assert.doesNotMatch(js, /\beval\s*\(/);
  assert.doesNotMatch(js, /\bnew\s+Function\s*\(/);
});

test('LQS_SAVE_AI_KEY stores only mask and storedOnServer=true when backend is online, and falls back locally when offline', async () => {
  const popupSender = {
    id: 'test-extension-id-1234567890abcdef',
    url: 'chrome-extension://test-extension-id-1234567890abcdef/popup.html'
  };
  const evilSender = {
    id: 'test-extension-id-1234567890abcdef',
    url: 'https://evil.example/'
  };

  // 1. Online backend -> DPAPI vault
  const { listener: onlineListener, storageData: onlineStorage } = loadBackgroundWithCustomFetch(async (url) => {
    if (String(url).endsWith('/api/ai-keys/save')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          provider: 'moduleapi',
          hasKey: true,
          mask: 'sk-...4321',
          storedOnServer: true,
          updatedAt: '2026-11-20T09:00:00Z'
        })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  // Untrusted sender must be rejected
  const evilResp = await new Promise((resolve) => {
    onlineListener({ type: 'LQS_SAVE_AI_KEY', aiProvider: 'moduleapi', aiApiKey: 'sk-secret-4321' }, evilSender, resolve);
  });
  assert.deepEqual(JSON.parse(JSON.stringify(evilResp)), { ok: false, error: 'Forbidden' });

  // Popup sender succeeds and clears raw aiApiKey from chrome.storage.local
  const saveResp = await new Promise((resolve) => {
    onlineListener({ type: 'LQS_SAVE_AI_KEY', aiProvider: 'moduleapi', aiApiKey: 'sk-secret-value-4321' }, popupSender, resolve);
  });
  const normSave = JSON.parse(JSON.stringify(saveResp));
  assert.equal(normSave.ok, true);
  assert.equal(normSave.storedOnServer, true);
  assert.equal(normSave.mask, 'sk-...4321');
  assert.equal(onlineStorage.lqs_settings_v2.aiApiKey, '');
  assert.equal(onlineStorage.lqs_settings_v2.aiKeyMask, 'sk-...4321');
  assert.equal(onlineStorage.lqs_settings_v2.aiKeyStoredOnServer, true);

  // 2. Offline backend -> fallback to chrome.storage.local with storedOnServer=false
  const { listener: offlineListener, storageData: offlineStorage } = loadBackgroundWithCustomFetch(async () => {
    throw new Error('ECONNREFUSED');
  });
  const fallbackResp = await new Promise((resolve) => {
    offlineListener({ type: 'LQS_SAVE_AI_KEY', aiProvider: 'openai', aiApiKey: 'sk-local-fallback-7788' }, popupSender, resolve);
  });
  const normFallback = JSON.parse(JSON.stringify(fallbackResp));
  assert.equal(normFallback.ok, true);
  assert.equal(normFallback.storedOnServer, false);
  assert.equal(normFallback.mask, 'sk-...7788');
  assert.equal(offlineStorage.lqs_settings_v2.aiApiKey, 'sk-local-fallback-7788');
  assert.equal(offlineStorage.lqs_settings_v2.aiKeyStoredOnServer, false);
});
