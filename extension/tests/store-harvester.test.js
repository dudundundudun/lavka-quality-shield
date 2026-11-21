const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extDir = path.resolve(__dirname, '..');

function loadHarvesterModule() {
  const sandbox = {
    console,
    URL,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    JSON
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(extDir, 'content', 'store-harvester.js'), 'utf8');
  vm.runInContext(code, ctx);
  return sandbox.LQS_STORE_HARVESTER;
}

test('detectStoreFromHost recognizes all 7 supported grocery store domains', () => {
  const h = loadHarvesterModule();
  assert.equal(h.detectStoreFromHost('kuper.ru')?.store, 'Купер');
  assert.equal(h.detectStoreFromHost('magnit.ru')?.store, 'Магнит');
  assert.equal(h.detectStoreFromHost('www.perekrestok.ru')?.store, 'Перекрёсток');
  assert.equal(h.detectStoreFromHost('www.vprok.ru')?.store, 'Перекрёсток');
  assert.equal(h.detectStoreFromHost('5ka.ru')?.store, 'Пятёрочка');
  assert.equal(h.detectStoreFromHost('vkusvill.ru')?.store, 'ВкусВилл');
  assert.equal(h.detectStoreFromHost('www.auchan.ru')?.store, 'Ашан');
  assert.equal(h.detectStoreFromHost('lenta.com')?.store, 'Лента');
  assert.equal(h.detectStoreFromHost('example.com'), null);
});

test('detectKuperRetailer maps Kuper sub-retailers to canonical Russian store names', () => {
  const h = loadHarvesterModule();
  assert.equal(h.detectKuperRetailer('https://kuper.ru/pyaterochka/products/123', ''), 'Пятёрочка');
  assert.equal(h.detectKuperRetailer('https://kuper.ru/magnit/products/456', ''), 'Магнит');
  assert.equal(h.detectKuperRetailer('https://kuper.ru/products/789', 'Перекрёсток доставка'), 'Перекрёсток');
  assert.equal(h.detectKuperRetailer('https://kuper.ru/auchan/products/1', ''), 'Ашан');
  assert.equal(h.detectKuperRetailer('https://kuper.ru/lenta/products/2', ''), 'Лента');
  assert.equal(h.detectKuperRetailer('https://kuper.ru/metro/products/3', ''), 'МЕТРО');
  assert.equal(h.detectKuperRetailer('https://kuper.ru/vkusvill/products/4', ''), 'ВкусВилл');
  assert.equal(h.detectKuperRetailer('https://kuper.ru/unknown/products/5', ''), 'Купер');
});

test('extractPricePairFromText skips unit prices per kg and extracts main + old price', () => {
  const h = loadHarvesterModule();
  const pr = h.extractPricePairFromText('478 ₽/кг Филе индейки 500г 189 ₽ 239 ₽');
  assert.deepEqual(JSON.parse(JSON.stringify(pr)), { price: 189, oldPrice: 239 });

  const single = h.extractPricePairFromText('Молоко Простоквашино 930 мл 94,90 ₽');
  assert.deepEqual(JSON.parse(JSON.stringify(single)), { price: 95, oldPrice: null });
});

test('scanStoresInBackgroundTabs opens background tab, harvests offers, and closes tab cleanly', async () => {
  const createdTabs = [];
  const removedTabs = [];
  const storageData = {};

  const chromeMock = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in storageData) out[k] = storageData[k];
          cb(out);
        },
        set: (obj, cb) => {
          Object.assign(storageData, obj || {});
          if (cb) cb();
        }
      }
    },
    tabs: {
      onUpdated: {
        addListener: () => {},
        removeListener: () => {}
      },
      get: (id, cb) => cb({ id, status: 'complete' }),
      create: (opts, cb) => {
        createdTabs.push(opts);
        cb({ id: 777, status: 'complete' });
      },
      sendMessage: (tabId, msg, cb) => {
        assert.equal(tabId, 777);
        assert.equal(msg.type, 'LQS_HARVEST_STORE_PAGE_NOW');
        cb({
          ok: true,
          store: 'Купер',
          offers: [
            {
              store: 'Пятёрочка',
              title: 'Филе грудки индейки Индилайт 500 г',
              amount: '500 г',
              price: 189,
              oldPrice: 239,
              url: 'https://kuper.ru/pyaterochka/products/indilight-500g'
            },
            {
              store: 'Магнит',
              title: 'Филе грудки индейки Индилайт 500 г',
              amount: '500 г',
              price: 199,
              oldPrice: null,
              url: 'https://kuper.ru/magnit/products/indilight-500g'
            },
            { store: 'Лента', title: 'Филе грудки индейки Индилайт 500 г', amount: '500 г', price: 205, url: 'https://kuper.ru/lenta/products/3' },
            { store: 'Ашан', title: 'Филе грудки индейки Индилайт 500 г', amount: '500 г', price: 210, url: 'https://kuper.ru/auchan/products/4' },
            { store: 'МЕТРО', title: 'Филе грудки индейки Индилайт 500 г', amount: '500 г', price: 215, url: 'https://kuper.ru/metro/products/5' },
            { store: 'Дикси', title: 'Филе грудки индейки Индилайт 500 г', amount: '500 г', price: 220, url: 'https://kuper.ru/dixy/products/6' }
          ]
        });
      },
      remove: (id, cb) => {
        removedTabs.push(id);
        if (cb) cb();
      }
    }
  };

  const sandbox = {
    chrome: chromeMock,
    console,
    URL,
    URLSearchParams,
    AbortController,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Promise,
    RegExp,
    Array,
    Object,
    Number,
    String,
    Boolean,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    fetch: async () => ({ ok: false, status: 503, text: async () => '', json: async () => ({}) })
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);

  for (const rel of ['shared/config.js', 'shared/utils.js', 'shared/product-matcher.js', 'bg/price-radar.js']) {
    vm.runInContext(fs.readFileSync(path.join(extDir, rel), 'utf8'), ctx);
  }
  sandbox.LQS_BG_DEPS = {
    startSwKeepAlive: () => () => {},
    getBackendOfflineUntilTs: () => Date.now() + 60000,
    probeDirectRetailStoresForProduct: async () => []
  };

  const res = await sandbox.LQS_PRICE_RADAR.scanStoresInBackgroundTabs({
    slug: 'indilight_500g',
    title: 'Филе грудки индейки Индилайт 500 г',
    amount: '500 г',
    price: 239,
    stores: ['kuper']
  });

  assert.equal(res.ok, true);
  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].active, false);
  assert.match(createdTabs[0].url, /^https:\/\/kuper\.ru\/multisearch\?q=/);
  assert.deepEqual(removedTabs, [777]);
  assert.equal(res.harvestedCount, 6);
  assert.ok(res.matchedCount >= 2);
});

test('parseKuperOffers always saves store as "Купер" and preserves sourceRetailer separately', () => {
  const h = loadHarvesterModule();
  const mockLink = {
    tagName: 'A',
    getAttribute: (attr) => (attr === 'href' ? '/pyaterochka/products/milk-930ml' : attr === 'title' ? 'Молоко Простоквашино 930 мл' : null),
    textContent: 'Молоко Простоквашино 930 мл'
  };
  const mockCard = {
    tagName: 'ARTICLE',
    innerText: 'Молоко Простоквашино 930 мл 109 ₽ 129 ₽',
    textContent: 'Молоко Простоквашино 930 мл 109 ₽ 129 ₽',
    querySelector: (sel) => (sel.includes('a[href') ? mockLink : null),
    closest: () => ({
      querySelector: () => ({ textContent: 'Пятёрочка', getAttribute: () => '' })
    })
  };
  const mockDoc = {
    title: 'Купер — поиск',
    body: { innerText: 'Молоко Простоквашино 930 мл 109 ₽' },
    querySelectorAll: () => [mockCard]
  };
  const res = h.parseOffersFromDocument(mockDoc, {
    hostname: 'kuper.ru',
    origin: 'https://kuper.ru',
    pathname: '/multisearch',
    href: 'https://kuper.ru/multisearch?q=молоко'
  });
  assert.equal(res.store, 'Купер');
  assert.equal(res.offers.length, 1);
  assert.equal(res.offers[0].store, 'Купер');
  assert.equal(res.offers[0].sourceRetailer, 'Пятёрочка');
  assert.equal(res.offers[0].price, 109);
  assert.equal(res.diagnostic.status, 'ok');
});

test('diagnoseStorePage returns honest reasons: ok, needs_address, captcha, not_found', () => {
  const h = loadHarvesterModule();
  assert.equal(h.diagnoseStorePage({ title: '', body: { innerText: '' } }, { href: 'https://magnit.ru' }, 3).reason, 'ok');
  assert.equal(
    h.diagnoseStorePage({ title: 'Магнит', body: { innerText: 'Укажите адрес доставки, чтобы увидеть цены' } }, { href: 'https://magnit.ru/search' }, 0).reason,
    'needs_address'
  );
  assert.equal(
    h.diagnoseStorePage({ title: 'Проверка браузера', body: { innerText: 'Подтвердите, что вы не робот (SmartCaptcha)' } }, { href: 'https://5ka.ru/search' }, 0).reason,
    'captcha'
  );
  assert.equal(
    h.diagnoseStorePage({ title: 'Поиск', body: { innerText: 'По вашему запросу ничего не найдено' } }, { href: 'https://kuper.ru/multisearch' }, 0).reason,
    'not_found'
  );
});

test('auto-radar enforces 24h cache per slug, manual scan bypasses cache, and returns honest diagnostics', async () => {
  const createdTabs = [];
  const storageData = {};
  let activeTabs = 0;
  let maxConcurrentTabs = 0;
  const sleepCalls = [];

  const chromeMock = {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in storageData) out[k] = storageData[k];
          cb(out);
        },
        set: (obj, cb) => {
          Object.assign(storageData, obj || {});
          if (cb) cb();
        }
      }
    },
    tabs: {
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      get: (id, cb) => cb({ id, status: 'complete' }),
      create: (opts, cb) => {
        activeTabs += 1;
        maxConcurrentTabs = Math.max(maxConcurrentTabs, activeTabs);
        const id = 900 + createdTabs.length;
        createdTabs.push({ id, ...opts });
        cb({ id, status: 'complete' });
      },
      sendMessage: (tabId, msg, cb) => {
        const tab = createdTabs.find((t) => t.id === tabId);
        if (tab && tab.url.includes('magnit.ru')) {
          cb({
            ok: true,
            store: 'Магнит',
            offers: [],
            diagnostic: { status: 'needs_address', reason: 'needs_address', message: 'Нужно 1 раз выбрать адрес доставки' }
          });
          return;
        }
        cb({
          ok: true,
          store: 'Купер',
          offers: [
            {
              store: 'Купер',
              sourceRetailer: 'Пятёрочка',
              title: 'Молоко Простоквашино 930 мл',
              amount: '930 мл',
              price: 109,
              url: 'https://kuper.ru/pyaterochka/products/milk-930'
            }
          ],
          diagnostic: { status: 'ok', reason: 'ok', message: '' }
        });
      },
      remove: (_id, cb) => {
        activeTabs = Math.max(0, activeTabs - 1);
        if (cb) cb();
      }
    }
  };

  const sandbox = {
    chrome: chromeMock,
    console,
    URL,
    URLSearchParams,
    AbortController,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Promise,
    RegExp,
    Array,
    Object,
    Number,
    String,
    Boolean,
    setTimeout: (fn, ms) => { sleepCalls.push(ms); fn(); return 1; },
    clearTimeout: () => {},
    fetch: async () => ({ ok: false, status: 503, text: async () => '', json: async () => ({}) })
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);

  for (const rel of ['shared/config.js', 'shared/utils.js', 'shared/product-matcher.js', 'bg/price-radar.js']) {
    vm.runInContext(fs.readFileSync(path.join(extDir, rel), 'utf8'), ctx);
  }
  sandbox.LQS_BG_DEPS = {
    startSwKeepAlive: () => () => {},
    getBackendOfflineUntilTs: () => Date.now() + 60000,
    probeDirectRetailStoresForProduct: async () => []
  };
  sandbox.LQS_PRICE_RADAR.resetRadarRuntimeState();

  // 1. First auto-scan runs and returns honest diagnostics (magnit needs_address, kuper ok)
  const res1 = await sandbox.LQS_PRICE_RADAR.scanStoresInBackgroundTabs({
    slug: 'milk_930',
    title: 'Молоко Простоквашино 930 мл',
    amount: '930 мл',
    price: 119,
    stores: ['magnit', 'kuper'],
    isAuto: true,
    forceRefresh: false
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.skipped, false);
  assert.equal(maxConcurrentTabs, 1);
  assert.equal(createdTabs.length, 2);
  assert.equal(res1.storeDiagnostics.find((d) => d.storeId === 'magnit')?.reason, 'needs_address');
  assert.equal(res1.storeDiagnostics.find((d) => d.storeId === 'kuper')?.reason, 'ok');
  assert.ok(res1.lastRadarScanAt);

  // 2. Second auto-scan for same slug within 24h is skipped with 0 new tabs
  const res2 = await sandbox.LQS_PRICE_RADAR.scanStoresInBackgroundTabs({
    slug: 'milk_930',
    title: 'Молоко Простоквашино 930 мл',
    amount: '930 мл',
    price: 119,
    stores: ['magnit', 'kuper'],
    isAuto: true,
    forceRefresh: false
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.skipped, true);
  assert.equal(res2.reason, 'cached_24h');
  assert.equal(createdTabs.length, 2);

  // 3. Auto-scan for ANOTHER slug enforces 15s cooldown wait
  sleepCalls.length = 0;
  const res3 = await sandbox.LQS_PRICE_RADAR.scanStoresInBackgroundTabs({
    slug: 'kefir_930',
    title: 'Кефир Простоквашино 930 мл',
    amount: '930 мл',
    price: 115,
    stores: ['kuper'],
    isAuto: true,
    forceRefresh: false,
    cooldownMs: 15000
  });
  assert.equal(res3.ok, true);
  assert.equal(res3.skipped, false);
  assert.ok(sleepCalls.some((ms) => ms >= 14000 && ms <= 15000), `Expected ~15s cooldown wait, got: ${sleepCalls}`);

  // 4. Manual scan bypasses 24h cache for milk_930
  const beforeManualTabs = createdTabs.length;
  const res4 = await sandbox.LQS_PRICE_RADAR.scanStoresInBackgroundTabs({
    slug: 'milk_930',
    title: 'Молоко Простоквашино 930 мл',
    amount: '930 мл',
    price: 119,
    stores: ['kuper'],
    isAuto: false,
    forceRefresh: true
  });
  assert.equal(res4.ok, true);
  assert.equal(res4.skipped, false);
  assert.equal(createdTabs.length, beforeManualTabs + 1);
});

test('direct product URL memory: first scan searches and remembers URL, next scan visits direct URL, stale link falls back to search', async () => {
  const openedUrls = [];
  const backendCalls = [];
  const storageData = {};
  let simulateStaleDirect = false;

  const chromeMock = {
    runtime: { lastError: null, getURL: (p) => `chrome-extension://test/${p}` },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in storageData) out[k] = storageData[k];
          cb(out);
        },
        set: (obj, cb) => {
          Object.assign(storageData, obj || {});
          if (cb) cb();
        }
      }
    },
    tabs: {
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      get: (id, cb) => cb({ id, status: 'complete' }),
      create: (opts, cb) => {
        const id = 1200 + openedUrls.length;
        openedUrls.push({ id, url: opts.url });
        cb({ id, status: 'complete' });
      },
      sendMessage: (tabId, _msg, cb) => {
        const tab = openedUrls.find((t) => t.id === tabId);
        if (simulateStaleDirect && tab && tab.url.includes('/product/123456')) {
          cb({
            ok: true,
            store: 'Магнит',
            offers: [],
            diagnostic: { status: 'not_found', reason: 'not_found', message: 'Товар не найден' }
          });
          return;
        }
        cb({
          ok: true,
          store: 'Магнит',
          offers: [
            {
              store: 'Магнит',
              title: 'Сыр Ламбер 230 г',
              amount: '230 г',
              price: simulateStaleDirect ? 299 : 279,
              url: simulateStaleDirect
                ? 'https://magnit.ru/product/999888-syr-lamber-230g'
                : 'https://magnit.ru/product/123456-syr-lamber-230g'
            }
          ],
          diagnostic: { status: 'ok', reason: 'ok', message: '' }
        });
      },
      remove: (_id, cb) => { if (cb) cb(); }
    }
  };

  const sandbox = {
    chrome: chromeMock,
    console,
    URL,
    URLSearchParams,
    AbortController,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Promise,
    RegExp,
    Array,
    Object,
    Number,
    String,
    Boolean,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    fetch: async (url, opts = {}) => {
      backendCalls.push({ url, method: opts.method || 'GET', body: opts.body || null });
      if (String(url).includes('/api/price/links') && (opts.method || 'GET') === 'GET') {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', links: {} }) };
      }
      if (String(url).includes('/api/price/links')) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', saved: 1 }) };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);

  for (const rel of ['shared/config.js', 'shared/utils.js', 'shared/product-matcher.js', 'bg/price-radar.js']) {
    vm.runInContext(fs.readFileSync(path.join(extDir, rel), 'utf8'), ctx);
  }
  sandbox.LQS_BG_DEPS = {
    startSwKeepAlive: () => () => {},
    getBackendOfflineUntilTs: () => 0,
    getBackendAuthHeaders: async (_u, extra = {}) => ({ 'X-LQS-Token': 'test-tok', ...extra }),
    probeDirectRetailStoresForProduct: async () => []
  };
  const radar = sandbox.LQS_PRICE_RADAR;
  radar.resetRadarRuntimeState();

  // Check URL classifier
  assert.equal(radar.isDirectProductUrl('https://magnit.ru/product/123456-syr', 'magnit'), true);
  assert.equal(radar.isDirectProductUrl('https://kuper.ru/pyaterochka/products/milk-1l', 'kuper'), true);
  assert.equal(radar.isDirectProductUrl('https://magnit.ru/search?term=сыр', 'magnit'), false);
  assert.equal(radar.isDirectProductUrl('https://kuper.ru/multisearch?q=сыр', 'kuper'), false);

  // 1. First scan uses search and saves direct link to storage + backend
  const res1 = await radar.scanStoresInBackgroundTabs({
    slug: 'lamber_230g',
    title: 'Сыр Ламбер 230 г',
    amount: '230 г',
    price: 319,
    stores: ['magnit'],
    isAuto: false,
    forceRefresh: true
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.directLinksUsedCount, 0);
  assert.match(openedUrls[0].url, /^https:\/\/magnit\.ru\/search\?term=/);
  assert.ok(backendCalls.some((c) => c.method === 'POST' && c.url.includes('/api/price/links')));

  // 2. Second scan opens remembered direct product URL directly (skipping search!)
  const res2 = await radar.scanStoresInBackgroundTabs({
    slug: 'lamber_230g',
    title: 'Сыр Ламбер 230 г',
    amount: '230 г',
    price: 319,
    stores: ['magnit'],
    isAuto: false,
    forceRefresh: true
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.directLinksUsedCount, 1);
  assert.equal(openedUrls[1].url, 'https://magnit.ru/product/123456-syr-lamber-230g');

  // 3. Stale direct URL returns not_found -> deletes stale link and falls back to search, saving new URL
  simulateStaleDirect = true;
  const res3 = await radar.scanStoresInBackgroundTabs({
    slug: 'lamber_230g',
    title: 'Сыр Ламбер 230 г',
    amount: '230 г',
    price: 319,
    stores: ['magnit'],
    isAuto: false,
    forceRefresh: true
  });
  assert.equal(res3.ok, true);
  assert.equal(openedUrls[2].url, 'https://magnit.ru/product/123456-syr-lamber-230g');
  assert.match(openedUrls[3].url, /^https:\/\/magnit\.ru\/search\?term=/);
  assert.ok(backendCalls.some((c) => c.method === 'DELETE' && c.url.includes('/api/price/links/lamber_230g/magnit')));
  const savedAfter = await radar.getRememberedProductLinks('lamber_230g');
  assert.equal(savedAfter.magnit.url, 'https://magnit.ru/product/999888-syr-lamber-230g');
});

test('parseGenericRetailerOffers always extracts open product from h1 FIRST even when similar product cards exist', () => {
  const h = loadHarvesterModule();

  const similarLink = {
    tagName: 'A',
    getAttribute: (attr) => (attr === 'href' ? '/product/similar-999' : attr === 'title' ? 'Напиток Добрый Кола 1,5 л' : null),
    textContent: 'Напиток Добрый Кола 1,5 л'
  };
  const similarCard = {
    tagName: 'ARTICLE',
    innerText: 'Напиток Добрый Кола 1,5 л 139 ₽',
    textContent: 'Напиток Добрый Кола 1,5 л 139 ₽',
    querySelector: (sel) => (sel.includes('a[href') ? similarLink : null),
    closest: () => null
  };

  const mockDoc = {
    title: 'Черноголовка Кола 1,5 л — Пятёрочка',
    body: { innerText: 'Напиток Черноголовка Кола 1,5 л 129 ₽ 159 ₽ Похожие товары' },
    querySelector: (sel) => {
      if (sel === 'h1') return { textContent: 'Напиток Черноголовка Кола 1,5 л' };
      if (sel === 'main') return { innerText: 'Напиток Черноголовка Кола 1,5 л 129 ₽ 159 ₽' };
      if (sel.includes('brand')) return { textContent: 'Черноголовка', getAttribute: () => null };
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel.includes('ld+json')) return [];
      return [similarCard];
    }
  };

  const res = h.parseOffersFromDocument(mockDoc, {
    hostname: '5ka.ru',
    origin: 'https://5ka.ru',
    pathname: '/product/chernogolovka-cola-15l/',
    href: 'https://5ka.ru/product/chernogolovka-cola-15l/'
  });

  assert.equal(res.store, 'Пятёрочка');
  assert.equal(res.offers.length, 2);
  assert.equal(res.offers[0].title, 'Напиток Черноголовка Кола 1,5 л');
  assert.equal(res.offers[0].brand, 'Черноголовка');
  assert.equal(res.offers[0].price, 129);
  assert.equal(res.offers[0].url, 'https://5ka.ru/product/chernogolovka-cola-15l/');
  assert.equal(res.offers[1].title, 'Напиток Добрый Кола 1,5 л');
});

test('recordExternalStoreOffers raises local cache above 800, syncs batch to SQLite, and returns totalInSqlite', async () => {
  const storageData = {};
  const backendRequests = [];

  const chromeMock = {
    runtime: { lastError: null, getURL: (p) => `chrome-extension://test/${p}` },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in storageData) out[k] = storageData[k];
          cb(out);
        },
        set: (obj, cb) => {
          Object.assign(storageData, obj || {});
          if (cb) cb();
        }
      }
    }
  };

  const sandbox = {
    chrome: chromeMock,
    console,
    URL,
    URLSearchParams,
    AbortController,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Promise,
    RegExp,
    Array,
    Object,
    Number,
    String,
    Boolean,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    fetch: async (url, opts = {}) => {
      backendRequests.push({ url: String(url), method: opts.method || 'GET', body: opts.body || null });
      if (String(url).includes('/api/external-offers/batch')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', savedCount: 5, totalInSqlite: 1520 })
        };
      }
      if (String(url).includes('/api/external-offers/match')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'ok',
            count: 1,
            offers: [
              {
                store: 'Ашан',
                title: 'Напиток Черноголовка Кола 1,5 л',
                amount: '1,5 л',
                price: 115,
                url: 'https://auchan.ru/product/cola-15l'
              }
            ]
          })
        };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);

  for (const rel of ['shared/config.js', 'shared/utils.js', 'shared/product-matcher.js', 'bg/price-radar.js']) {
    vm.runInContext(fs.readFileSync(path.join(extDir, rel), 'utf8'), ctx);
  }
  sandbox.LQS_BG_DEPS = {
    getBackendOfflineUntilTs: () => 0,
    getBackendAuthHeaders: async (_u, extra = {}) => ({ 'X-LQS-Token': 'test-tok', ...extra }),
    setBackendOfflineUntilTs: () => {}
  };

  // Pre-seed 950 offers in local cache to verify > 800 cap is removed (limit is now 3000)
  storageData.lqs_ext_store_prices_v1 = Array.from({ length: 950 }, (_, idx) => ({
    store: 'Магнит',
    title: `Товар Магнит ${idx} 500 г`,
    price: 100 + idx,
    url: `https://magnit.ru/product/${idx}`
  }));

  const res = await sandbox.LQS_PRICE_RADAR.recordExternalStoreOffers('Пятёрочка', [
    {
      store: 'Пятёрочка',
      title: 'Напиток Черноголовка Кола 1,5 л',
      brand: 'Черноголовка',
      amount: '1,5 л',
      price: 129,
      url: 'https://5ka.ru/product/chernogolovka-cola-15l'
    }
  ]);

  assert.equal(res.ok, true);
  assert.equal(res.storedInSqlite, true);
  assert.equal(res.totalExternalOffers, 1520);
  assert.equal(storageData.lqs_ext_store_prices_v1.length, 951);
  assert.ok(backendRequests.some((r) => r.method === 'POST' && r.url.includes('/api/external-offers/batch')));

  // Verify findLocalComparisonsForStoreProduct merges matches from SQLite /api/external-offers/match
  const cmp = await sandbox.LQS_PRICE_RADAR.findLocalComparisonsForStoreProduct({
    store: 'Пятёрочка',
    title: 'Напиток Черноголовка Кола 1,5 л',
    brand: 'Черноголовка',
    amount: '1,5 л',
    price: 129
  });
  assert.equal(cmp.ok, true);
  assert.ok(cmp.otherStores.some((o) => o.store === 'Ашан' && o.price === 115));
});

test('scanStoresInBackgroundTabs respects excludeStore, checks Lavka DB, and rejectCompetitorMatch hides rejected offers', async () => {
  const openedUrls = [];
  const storageData = {
    lqs_price_db_v1: {
      bonduelle_young_400: {
        slug: 'bonduelle_young_400',
        title: 'Горошек зелёный молодой Bonduelle 400 г',
        amount: '400 г',
        lastPrice: 149,
        minPrice: 139
      }
    }
  };

  const chromeMock = {
    runtime: { lastError: null, getURL: (p) => `chrome-extension://test/${p}` },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) if (k in storageData) out[k] = storageData[k];
          cb(out);
        },
        set: (obj, cb) => {
          Object.assign(storageData, obj || {});
          if (cb) cb();
        }
      }
    },
    tabs: {
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      get: (id, cb) => cb({ id, status: 'complete' }),
      create: (opts, cb) => {
        const id = 1500 + openedUrls.length;
        openedUrls.push({ id, url: opts.url });
        cb({ id, status: 'complete' });
      },
      sendMessage: (_tabId, _msg, cb) => {
        cb({
          ok: true,
          store: 'Пятёрочка',
          offers: [
            {
              store: 'Пятёрочка',
              title: 'Горошек зелёный молодой Bonduelle 400 г',
              amount: '400 г',
              price: 135,
              url: 'https://5ka.ru/product/bonduelle-young-400'
            }
          ],
          diagnostic: { status: 'ok', reason: 'ok', message: '' }
        });
      },
      remove: (_id, cb) => { if (cb) cb(); }
    }
  };

  const sandbox = {
    chrome: chromeMock,
    console,
    URL,
    URLSearchParams,
    AbortController,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Promise,
    RegExp,
    Array,
    Object,
    Number,
    String,
    Boolean,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    fetch: async () => ({ ok: false, status: 503, text: async () => '', json: async () => ({}) })
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);

  for (const rel of ['shared/config.js', 'shared/utils.js', 'shared/product-matcher.js', 'bg/price-radar.js']) {
    vm.runInContext(fs.readFileSync(path.join(extDir, rel), 'utf8'), ctx);
  }
  sandbox.LQS_BG_DEPS = {
    startSwKeepAlive: () => () => {},
    getBackendOfflineUntilTs: () => Date.now() + 60000,
    probeDirectRetailStoresForProduct: async () => []
  };
  const radar = sandbox.LQS_PRICE_RADAR;
  radar.resetRadarRuntimeState();

  // Launch scan from Магнит -> must NOT open magnit.ru, should open pyaterochka & return Lavka + Пятёрочка
  const res = await radar.scanStoresInBackgroundTabs({
    title: 'Горошек зелёный молодой Bonduelle 400 г',
    amount: '400 г',
    price: 159,
    excludeStore: 'Магнит',
    stores: ['magnit', 'pyaterochka'],
    forceRefresh: true
  });
  assert.equal(res.ok, true);
  assert.equal(res.excludeStore, 'magnit');
  assert.equal(openedUrls.some((u) => u.url.includes('magnit.ru')), false);
  assert.equal(openedUrls.some((u) => u.url.includes('5ka.ru')), true);
  assert.equal(res.comparisons.lavka?.price, 149);
  assert.ok(res.comparisons.otherStores.some((o) => o.store === 'Пятёрочка' && o.price === 135));

  // Reject Пятёрочка offer -> should disappear from findLocalComparisonsForStoreProduct
  const rej = await radar.rejectCompetitorMatch({
    sourceTitle: 'Горошек зелёный молодой Bonduelle 400 г',
    rejectedUrl: 'https://5ka.ru/product/bonduelle-young-400',
    rejectedTitle: 'Горошек зелёный молодой Bonduelle 400 г'
  });
  assert.equal(rej.ok, true);

  const cmpAfter = await radar.findLocalComparisonsForStoreProduct({
    store: 'Магнит',
    title: 'Горошек зелёный молодой Bonduelle 400 г',
    amount: '400 г',
    price: 159
  });
  assert.equal(cmpAfter.otherStores.some((o) => o.store === 'Пятёрочка'), false);
});

test('field recon regression: parses 5ka split-kopeck prices, Kuper spaced decimals, and web.kuper.ru /product/ PDP + aria-label cards', () => {
  const h = loadHarvesterModule();

  // 5ka.ru split-kopeck prices and "Старая цена ... Цена ..." ordering
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.extractPricePairFromText('4,77 Фарш говяжий Рестория 400г 400 г Цена 279 99 ₽'))),
    { price: 280, oldPrice: null }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.extractPricePairFromText('-24% 4,73 Ананас спелый Цена за 1 кг Старая цена 349 99 ₽ Цена 264 99 ₽'))),
    { price: 265, oldPrice: 350 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.extractPricePairFromText('712 96 ₽'))),
    { price: 713, oldPrice: null }
  );

  // web.kuper.ru spaced decimals and aria-label full price
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.extractPricePairFromText('144 ,00 ₽ Газированный напиток Добрый Cola без сахара 1,5 л'))),
    { price: 144, oldPrice: null }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.extractPricePairFromText('199 ,99 ₽ 249 ,99 ₽'))),
    { price: 200, oldPrice: 250 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(h.extractPricePairFromText('Мука Makfa пшеничная 2 кг. Полная цена - 129.99 рублей'))),
    { price: 130, oldPrice: null }
  );

  // web.kuper.ru /product/ PDP + breadcrumb retailer + recommendations aria-label card
  const crumb = {
    getAttribute: (a) => (a === 'href' ? '/5ka?sid=194031' : null),
    textContent: 'Пятёрочка'
  };
  const h1 = { textContent: 'Сливочное масло несоленое Экомилк 82,5% БЗМЖ 180 г' };
  const main = { innerText: 'Сливочное масло несоленое Экомилк 82,5% БЗМЖ 180 г 199 ,99 ₽ 249 ,99 ₽' };
  const recLink = {
    tagName: 'A',
    getAttribute: (a) => {
      if (a === 'href') return '/product/muka-makfa-pshenichnaya-2-kg-4d69609?sid=194031';
      if (a === 'aria-label') return 'Мука Makfa пшеничная высший сорт 2 кг. Полная цена - 129.99 рублей';
      return null;
    },
    textContent: '129 ,99 ₽',
    closest: () => null,
    querySelector: () => null
  };
  const kuperDoc = {
    querySelector: (sel) => {
      if (sel.includes('product_breadcrumb_link_0')) return crumb;
      if (sel === 'h1') return h1;
      if (sel === 'main') return main;
      return null;
    },
    querySelectorAll: () => [recLink],
    body: main
  };
  const kuperLoc = new URL('https://web.kuper.ru/product/slivochnoe-maslo-nesolenoe-ekomilk-82-5-bzmzh-180-g-94f842e?sid=194031');
  const kuperOffers = h.parseKuperOffers(kuperDoc, kuperLoc);

  assert.equal(kuperOffers.length, 2);
  assert.equal(kuperOffers[0].store, 'Купер');
  assert.equal(kuperOffers[0].sourceRetailer, 'Пятёрочка');
  assert.equal(kuperOffers[0].price, 200);
  assert.equal(kuperOffers[0].oldPrice, 250);
  assert.match(kuperOffers[0].title, /Экомилк/i);

  assert.equal(kuperOffers[1].store, 'Купер');
  assert.equal(kuperOffers[1].sourceRetailer, 'Пятёрочка');
  assert.equal(kuperOffers[1].price, 130);
  assert.equal(kuperOffers[1].title, 'Мука Makfa пшеничная высший сорт 2 кг');
});
