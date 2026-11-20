const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extDir = path.resolve(__dirname, '..');

function loadPriceRadarModule() {
  const storageData = {};
  const sandbox = {
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {};
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) {
              if (k in storageData) out[k] = storageData[k];
            }
            cb(out);
          },
          set: (obj, cb) => {
            Object.assign(storageData, obj || {});
            if (cb) cb();
          },
        },
      },
      runtime: {
        getURL: (p) => `chrome-extension://test/${p}`,
      },
    },
    console,
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
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  for (const rel of ['shared/config.js', 'shared/price-parser.js', 'shared/utils.js', 'shared/product-matcher.js', 'bg/price-radar.js']) {
    const fullPath = path.join(extDir, rel);
    vm.runInContext(fs.readFileSync(fullPath, 'utf8'), context, { filename: fullPath });
  }
  return { radar: sandbox.LQS_PRICE_RADAR, storageData };
}

test('circuit breaker opens after 3 failures and resets on success or resetCircuitBreakers', async () => {
  const { radar } = loadPriceRadarModule();

  assert.equal(await radar.isCircuitOpen('vkusvill'), false);

  await radar.recordCircuitFailure('vkusvill', 'timeout');
  assert.equal(await radar.isCircuitOpen('vkusvill'), false);

  await radar.recordCircuitFailure('vkusvill', 'http_502');
  assert.equal(await radar.isCircuitOpen('vkusvill'), false);

  await radar.recordCircuitFailure('vkusvill', 'http_503');
  assert.equal(await radar.isCircuitOpen('vkusvill'), true);

  await radar.recordCircuitSuccess('vkusvill');
  assert.equal(await radar.isCircuitOpen('vkusvill'), false);

  await radar.recordCircuitFailure('duckduckgo', 'captcha', true);
  assert.equal(await radar.isCircuitOpen('duckduckgo'), true);

  await radar.resetCircuitBreakers();
  assert.equal(await radar.isCircuitOpen('duckduckgo'), false);
});

test('isCaptchaOrBlockHtml detects captcha and anti-bot pages and ignores normal HTML', () => {
  const { radar } = loadPriceRadarModule();

  assert.equal(radar.isCaptchaOrBlockHtml('<html><body>Please pass SmartCaptcha check</body></html>'), true);
  assert.equal(radar.isCaptchaOrBlockHtml('<html><title>DDoS-Guard</title></html>'), true);
  assert.equal(radar.isCaptchaOrBlockHtml('<div>Подтвердите, что вы не робот</div>'), true);
  assert.equal(radar.isCaptchaOrBlockHtml('<html><body><h1>Молоко Простоквашино 930 мл — 99 ₽</h1></body></html>'), false);
  assert.equal(radar.isCaptchaOrBlockHtml(''), false);
  assert.equal(radar.isCaptchaOrBlockHtml(null), false);
});

test('mergeUniqueStoreOffers deduplicates by store+price, prefers new offers, and sorts ascending by price', () => {
  const { radar } = loadPriceRadarModule();

  const existing = [
    { store: 'Магнит', price: 149, url: 'https://magnit.ru/old' },
    { store: 'Пятёрочка', price: 139, url: 'https://5ka.ru/item' },
    { store: 'Лента', price: null, url: 'https://lenta.com/search' },
  ];
  const incoming = [
    { store: 'Магнит', price: 149, url: 'https://magnit.ru/fresh' },
    { store: 'ВкусВилл', price: 129, url: 'https://vkusvill.ru/item' },
    { store: 'Магнит', price: 159, url: 'https://magnit.ru/other' },
  ];

  const merged = radar.mergeUniqueStoreOffers(existing, incoming);
  assert.equal(merged.length, 5);
  assert.deepEqual(
    merged.map((o) => [o.store, o.price]),
    [
      ['ВкусВилл', 129],
      ['Пятёрочка', 139],
      ['Магнит', 149],
      ['Магнит', 159],
      ['Лента', null],
    ]
  );
  const magnit149 = merged.find((o) => o.store === 'Магнит' && o.price === 149);
  assert.equal(magnit149.url, 'https://magnit.ru/fresh');
});
