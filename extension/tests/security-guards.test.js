const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extDir = path.resolve(__dirname, '..');

function loadBackgroundInSandbox() {
  const onMessageListeners = [];
  const storageData = {};

  const chromeMock = {
    runtime: {
      id: 'test-extension-id-1234567890abcdef',
      lastError: null,
      getURL: (p) => `chrome-extension://test-extension-id-1234567890abcdef/${String(p || '').replace(/^\/+/, '')}`,
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: {
        addListener: (fn) => {
          onMessageListeners.push(fn);
        },
      },
    },
    tabs: {
      onUpdated: { addListener: () => {} },
      query: (_q, cb) => cb && cb([]),
      create: (_opts, cb) => cb && cb({ id: 1 }),
      update: (_id, _opts, cb) => cb && cb({ id: 1 }),
      remove: (_id, cb) => cb && cb(),
      sendMessage: (_id, _msg, cb) => cb && cb({}),
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
        },
      },
    },
    cookies: {
      getAll: (_details, cb) => cb && cb([]),
      set: (_details, cb) => cb && cb({}),
      remove: (_details, cb) => cb && cb({}),
    },
    scripting: {
      executeScript: async () => [],
    },
    alarms: {
      create: () => {},
      clear: () => {},
      onAlarm: { addListener: () => {} },
    },
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
    fetch: async () => ({ ok: false, status: 503, text: async () => '', json: async () => ({}) }),
  };

  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...scripts) => {
    for (const rel of scripts) {
      const fullPath = path.join(extDir, rel);
      const code = fs.readFileSync(fullPath, 'utf8');
      vm.runInContext(code, context, { filename: fullPath });
    }
  };

  const bgPath = path.join(extDir, 'background.js');
  const bgCode = fs.readFileSync(bgPath, 'utf8');
  vm.runInContext(bgCode, context, { filename: bgPath });

  return { sandbox, onMessageListeners };
}

test('background.js onMessage uses declared sender parameter and guards sensitive messages', () => {
  const bg = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');
  assert.match(bg, /chrome\.runtime\.onMessage\.addListener\(\(msg,\s*sender,\s*sendResponse\)/);
  assert.doesNotMatch(bg, /chrome\.runtime\.onMessage\.addListener\(\(msg,\s*_sender,/);
  assert.match(bg, /LQS_GET_GEMINI_COOKIE_HEADER'[\s\S]{0,160}isPopupSender\(sender\)/);
  assert.match(bg, /LQS_DELETE_ACCOUNT_FROM_VAULT'[\s\S]{0,160}isPopupSender\(sender\)/);
  assert.doesNotMatch(bg, /headerString:\s*cookieInfo\.headerString/);
  const accountsVault = fs.readFileSync(path.join(extDir, 'bg', 'accounts-vault.js'), 'utf8');
  assert.match(bg, /importScripts\(['"]bg\/accounts-vault\.js['"]\)/);
  assert.match(accountsVault, /async function fetchBackendAccountSecrets\(backendUrl, accountId\)/);
  assert.match(accountsVault, /\/api\/accounts\/\$\{encodeURIComponent\(accountId\)\}\/secrets/);
});

test('background.js guards all onMessage commands with explicit sender checks', () => {
  const bg = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');
  const listenerStart = bg.indexOf('chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {');
  assert.notEqual(listenerStart, -1, 'onMessage.addListener not found');
  const listenerBlock = bg.slice(listenerStart);

  // Explicit checks for key sensitive and external-store commands
  const requiredLavkaOrPopup = [
    'LQS_GET_ACCOUNTS_VAULT',
    'LQS_CLEAR_AI_CACHE',
    'LQS_RESET_CIRCUIT_BREAKER',
    'LQS_SELECT_GEMINI_ACCOUNT',
    'LQS_AUTO_CONNECT_GEMINI_TAB',
  ];
  for (const cmd of requiredLavkaOrPopup) {
    const re = new RegExp(`msg\\.type === '${cmd}'\\)[\\s\\S]{0,160}isTrustedLavkaOrPopupSender\\(sender\\)`);
    assert.match(listenerBlock, re, `${cmd} must be guarded by isTrustedLavkaOrPopupSender(sender)`);
  }

  assert.match(
    listenerBlock,
    /msg\.type === 'LQS_RECORD_EXTERNAL_STORE_OFFERS'\)[\s\S]{0,160}isTrustedExternalStoreSender\(sender\)/,
    'LQS_RECORD_EXTERNAL_STORE_OFFERS must be guarded by isTrustedExternalStoreSender(sender)'
  );
  assert.match(bg, /function isTrustedExternalStoreSender\(sender\)/);
  assert.match(bg, /TRUSTED_EXTERNAL_STORE_DOMAINS/);

  // Ensure every LQS_* command in onMessage has a sender guard
  const handlerMatches = [...listenerBlock.matchAll(/if\s*\(msg\.type === '(LQS_[A-Z0-9_]+)'\)\s*\{/g)];
  assert.ok(handlerMatches.length >= 20, 'Expected at least 20 message handlers in onMessage');
  for (const m of handlerMatches) {
    const cmd = m[1];
    const snippet = listenerBlock.slice(m.index, m.index + 200);
    assert.match(
      snippet,
      /if\s*\(!is(?:Popup|TrustedLavkaOrPopup|PassportOrPopup|TrustedExternalStore)Sender\(sender\)\)/,
      `Handler ${cmd} is missing a sender guard`
    );
  }
});

test('popup.html masks AI API key input and diagnostics/flight log redact secrets', () => {
  const popupHtml = fs.readFileSync(path.join(extDir, 'popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(extDir, 'popup.js'), 'utf8');
  const contentJs = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8');

  assert.match(popupHtml, /<input\b[^>]*type="password"[^>]*id="inp-ai-key"/);
  assert.match(popupJs, /function sanitizeDiagnosticsText\(text,\s*aiApiKey/);
  assert.match(popupJs, /sanitizeDiagnosticsText\(/);
  assert.match(contentJs, /redactSecrets\(text\)/);
  assert.doesNotMatch(contentJs, /LQS_RECORDER\.record\([^)]*aiApiKey/);
});

test('content.js validates competitor href URLs with safeHttpUrl from shared/utils.js', () => {
  const utils = fs.readFileSync(path.join(extDir, 'shared', 'utils.js'), 'utf8');
  const manifest = fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8');
  const content = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8');
  const cartAudit = fs.readFileSync(path.join(extDir, 'content', 'cart-audit.js'), 'utf8');
  assert.match(utils, /function safeHttpUrl\(url\)/);
  assert.match(manifest, /"shared\/utils\.js",[\s\S]*?"content\/store-harvester\.js",[\s\S]*?"content\/passport-helper\.js",[\s\S]*?"content\/cart-audit\.js",[\s\S]*?"content\/price-chart\.js",[\s\S]*?"content\.js"/);
  assert.match(content, /safeHttpUrl[\s\S]*?=\s*globalThis\.LQS_UTILS/);
  assert.match(cartAudit, /escapeHtml\(safeHttpUrl\(o\.url\)\)/);
  assert.match(content, /escapeHtml\(safeRowUrl\)/);
});

test('Service Worker loads background.js with all importScripts and exports all LQS_* modules', () => {
  const { sandbox, onMessageListeners } = loadBackgroundInSandbox();
  const expectedGlobals = [
    'LQS_CONFIG',
    'LQS_PRICE_PARSER',
    'LQS_UTILS',
    'LQS_MATCHER',
    'LQS_BG_DEPS',
    'LQS_ACCOUNTS_VAULT',
    'LQS_GEMINI_TAB',
    'LQS_PRICE_RADAR',
  ];
  for (const name of expectedGlobals) {
    assert.ok(sandbox[name] && typeof sandbox[name] === 'object', `Expected globalThis.${name} to be exported`);
  }
  assert.equal(onMessageListeners.length, 1, 'Expected exactly one chrome.runtime.onMessage listener');
});

test('onMessage rejects sensitive vault commands from untrusted external sender URL', () => {
  const { onMessageListeners } = loadBackgroundInSandbox();
  const listener = onMessageListeners[0];
  const evilSender = {
    id: 'test-extension-id-1234567890abcdef',
    url: 'https://evil.example/phishing',
    tab: { url: 'https://evil.example/phishing' },
  };

  for (const type of ['LQS_DELETE_ACCOUNT_FROM_VAULT', 'LQS_GET_ACCOUNTS_VAULT']) {
    let response = null;
    listener({ type, accountId: 'acc_1' }, evilSender, (res) => {
      response = res;
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(response)),
      { ok: false, error: 'Forbidden' },
      `Expected ${type} from https://evil.example/ to return Forbidden`
    );
  }
});
