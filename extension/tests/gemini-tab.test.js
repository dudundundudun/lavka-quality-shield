const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extDir = path.resolve(__dirname, '..');

function loadGeminiTabHarness(initialSettings = {}) {
  const storageData = {};
  const createdWindows = [];
  const removedWindows = [];
  const createdTabs = [];
  const removedTabs = [];
  const createdAlarms = [];
  const clearedAlarms = [];
  let cookiesState = [{ name: '__Secure-1PSID', value: 'valid-session' }];

  const settingsState = {
    aiProvider: 'gemini_tab',
    geminiTabMode: 'stealth_window',
    geminiIdleCloseMinutes: 5,
    autoWarmupGeminiTab: false,
    geminiAccountIndex: 'auto',
    preferredGeminiTabId: null,
    ...initialSettings
  };

  const chromeMock = {
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
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
    windows: {
      create: async (opts) => {
        const win = {
          id: 700 + createdWindows.length,
          state: opts.state,
          focused: opts.focused,
          tabs: [{ id: 800 + createdWindows.length, url: opts.url, windowId: 700 + createdWindows.length }]
        };
        createdWindows.push(opts);
        return win;
      },
      remove: async (windowId) => {
        removedWindows.push(windowId);
      }
    },
    tabs: {
      query: async () => [],
      create: async (opts) => {
        const tab = { id: 900 + createdTabs.length, url: opts.url, active: opts.active, pinned: opts.pinned };
        createdTabs.push(opts);
        return tab;
      },
      update: async (id, opts) => ({ id, ...opts }),
      remove: async (tabId) => {
        removedTabs.push(tabId);
      }
    },
    alarms: {
      create: (name, info) => {
        createdAlarms.push({ name, info });
      },
      clear: async (name) => {
        clearedAlarms.push(name);
      }
    },
    cookies: {
      getAll: async () => cookiesState
    },
    scripting: {
      executeScript: async () => []
    }
  };

  const sandbox = {
    chrome: chromeMock,
    console,
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
    setTimeout,
    clearTimeout,
    LQS_CONFIG: {
      STORAGE_KEYS: { GEMINI_STEALTH_SESSION: 'lqs_gemini_stealth_session_v1' }
    },
    LQS_UTILS: {
      fetchWithTimeout: async () => ({ ok: false, status: 503 }),
      getSettings: async () => ({ ...settingsState })
    },
    LQS_BG_DEPS: {
      waitForTabCompleteSafe: async () => true
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(extDir, 'bg', 'gemini-tab.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'bg/gemini-tab.js' });

  return {
    api: sandbox.LQS_GEMINI_TAB,
    settingsState,
    setCookies: (c) => { cookiesState = c; },
    createdWindows,
    removedWindows,
    createdTabs,
    removedTabs,
    createdAlarms,
    clearedAlarms
  };
}

test('stealth_window creates minimized unfocused window, schedules 5-min idle alarm, and closes window on alarm', async () => {
  const h = loadGeminiTabHarness({ geminiTabMode: 'stealth_window', geminiIdleCloseMinutes: 5 });

  const tab = JSON.parse(JSON.stringify(await h.api.createGeminiTab('https://gemini.google.com/app', false)));
  assert.equal(h.createdWindows.length, 1);
  assert.equal(h.createdWindows[0].state, 'minimized');
  assert.equal(h.createdWindows[0].focused, false);
  assert.equal(h.createdTabs.length, 0);
  assert.equal(tab.id, 800);

  const sched = JSON.parse(JSON.stringify(await h.api.scheduleGeminiIdleCloseTimer()));
  assert.equal(sched.scheduled, true);
  assert.equal(sched.delayInMinutes, 5);
  assert.equal(h.createdAlarms.length, 1);
  assert.equal(h.createdAlarms[0].name, h.api.GEMINI_IDLE_ALARM_NAME);

  const closed = JSON.parse(JSON.stringify(await h.api.closeManagedGeminiSession('idle-alarm')));
  assert.equal(closed.closed, true);
  assert.equal(h.removedWindows[0], 700);
});

test('on_demand_tab creates background unpinned tab and closes tab on idle; keep_open does not auto-close', async () => {
  const h1 = loadGeminiTabHarness({ geminiTabMode: 'on_demand_tab', geminiIdleCloseMinutes: 3 });
  const tab1 = JSON.parse(JSON.stringify(await h1.api.createGeminiTab('https://gemini.google.com/app', false)));
  assert.equal(h1.createdTabs.length, 1);
  assert.equal(h1.createdTabs[0].pinned, false);
  assert.equal(h1.createdTabs[0].active, false);

  const sched1 = JSON.parse(JSON.stringify(await h1.api.scheduleGeminiIdleCloseTimer()));
  assert.equal(sched1.scheduled, true);
  assert.equal(sched1.delayInMinutes, 3);

  await h1.api.closeManagedGeminiSession('idle-alarm');
  assert.equal(h1.removedTabs[0], tab1.id);

  const h2 = loadGeminiTabHarness({ geminiTabMode: 'keep_open' });
  await h2.api.createGeminiTab('https://gemini.google.com/app', false);
  assert.equal(h2.createdTabs[0].pinned, true);
  const sched2 = JSON.parse(JSON.stringify(await h2.api.scheduleGeminiIdleCloseTimer()));
  assert.equal(sched2.scheduled, false);
  assert.equal(h2.createdAlarms.length, 0);
});

test('ensureAutopilotWarmup never opens Gemini tab by default or when an API provider is selected', async () => {
  const hDefault = loadGeminiTabHarness({ autoWarmupGeminiTab: false, aiProvider: 'gemini_tab' });
  await hDefault.api.ensureAutopilotWarmup('onStartup');
  assert.equal(hDefault.createdWindows.length, 0);
  assert.equal(hDefault.createdTabs.length, 0);

  const hPaid = loadGeminiTabHarness({ autoWarmupGeminiTab: true, aiProvider: 'moduleapi', geminiTabMode: 'keep_open' });
  await hPaid.api.ensureAutopilotWarmup('onStartup');
  assert.equal(hPaid.createdWindows.length, 0);
  assert.equal(hPaid.createdTabs.length, 0);
});

test('isGeminiLoginRequired detects missing Google cookies and Google sign-in redirects', () => {
  const h = loadGeminiTabHarness();
  assert.equal(h.api.isGeminiLoginRequired(null, { ok: false }), true);
  assert.equal(h.api.isGeminiLoginRequired({ url: 'https://accounts.google.com/ServiceLogin' }, { ok: true }), true);
  assert.equal(h.api.isGeminiLoginRequired({ url: 'https://gemini.google.com/app' }, { ok: true }), false);
});
