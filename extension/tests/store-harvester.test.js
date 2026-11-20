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
