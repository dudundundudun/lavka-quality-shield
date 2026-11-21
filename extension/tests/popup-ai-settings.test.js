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
  const popupJs = fs.readFileSync(path.join(extDir, 'popup.js'), 'utf8');
  const aiSettingsJs = fs.readFileSync(path.join(extDir, 'popup', 'ai-settings.js'), 'utf8');

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
  assert.match(html, /<script src="popup\/ai-settings\.js"><\/script>\s*<script src="popup\.js"><\/script>/);

  // JS hooks present in extracted popup/ai-settings.js module
  assert.match(aiSettingsJs, /LQS_TEST_AI_PROVIDER/);
  assert.match(aiSettingsJs, /LQS_GET_AI_USAGE_STATS/);
  assert.match(aiSettingsJs, /LQS_SAVE_AI_KEY/);
  assert.match(aiSettingsJs, /LQS_GET_AI_KEY_STATUS/);
  assert.match(aiSettingsJs, /LQS_DELETE_AI_KEY/);
  assert.match(popupJs, /LQS_POPUP_AI_SETTINGS/);

  // Strict MV3 CSP: no inline onclick, eval, new Function
  assert.doesNotMatch(html, /\bonclick\s*=/i);
  assert.doesNotMatch(popupJs, /\beval\s*\(/);
  assert.doesNotMatch(popupJs, /\bnew\s+Function\s*\(/);
  assert.doesNotMatch(aiSettingsJs, /\beval\s*\(/);
  assert.doesNotMatch(aiSettingsJs, /\bnew\s+Function\s*\(/);
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

test('popup/ai-settings.js formats USD, syncs provider UI, and renders DPAPI badge states cleanly', () => {
  const elements = {};
  const makeEl = (id, init = {}) => {
    const el = { id, value: '', hidden: false, className: '', textContent: '', placeholder: '', innerHTML: '', classList: { add(c) { el.className = (el.className + ' ' + c).trim(); } }, ...init };
    elements[id] = el;
    return el;
  };
  makeEl('sel-ai-provider', { value: 'gemini_tab' });
  makeEl('ai-gemini-config-box');
  makeEl('ai-api-config-box');
  makeEl('ai-base-url-field');
  makeEl('moduleapi-check-link');
  makeEl('ai-provider-mode-badge');
  makeEl('inp-ai-url');
  makeEl('inp-ai-model');
  makeEl('inp-ai-key');
  makeEl('sel-gemini-tab-mode', { value: 'keep_open' });
  makeEl('gemini-idle-minutes-row');
  makeEl('ai-key-storage-badge');
  makeEl('delete-ai-key-btn');

  const sentMessages = [];
  const sandbox = {
    console,
    document: { getElementById: (id) => elements[id] || null },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          sentMessages.push(msg);
          if (cb) cb({ ok: true, hasKey: true, storedOnServer: true, mask: 'sk-...9876' });
        }
      }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(extDir, 'shared', 'config.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(extDir, 'shared', 'utils.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(extDir, 'bg', 'ai-providers.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(extDir, 'popup', 'ai-settings.js'), 'utf8'), sandbox);

  const mod = sandbox.LQS_POPUP_AI_SETTINGS;
  assert.ok(mod, 'LQS_POPUP_AI_SETTINGS must be exported');
  assert.equal(mod.formatUsdShort(0), '$0.00');
  assert.equal(mod.formatUsdShort(0.0042), '$0.0042');
  assert.equal(mod.formatUsdShort(1.256), '$1.26');

  mod.syncGeminiTabModeUi();
  assert.equal(elements['gemini-idle-minutes-row'].hidden, true);

  mod.syncAiProviderUi('moduleapi', { autoFillUrl: true, autoFillModel: true });
  assert.equal(elements['ai-gemini-config-box'].hidden, true);
  assert.equal(elements['ai-api-config-box'].hidden, false);
  assert.equal(elements['moduleapi-check-link'].hidden, false);
  assert.equal(elements['ai-base-url-field'].hidden, true);
  assert.equal(elements['inp-ai-url'].value, 'https://api.moduleapi.pro/v1');
  assert.equal(elements['ai-key-storage-badge'].className, 'lqs-key-status secure');
  assert.equal(elements['delete-ai-key-btn'].hidden, false);
  assert.ok(sentMessages.some((m) => m.type === 'LQS_GET_AI_KEY_STATUS' && m.aiProvider === 'moduleapi'));
});
