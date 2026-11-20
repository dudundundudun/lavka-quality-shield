const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extDir = path.resolve(__dirname, '..');

function loadAssistantStack() {
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

  const files = [
    'shared/config.js',
    'shared/price-parser.js',
    'shared/utils.js',
    'shared/ingredients-guard.js',
    'content/store-harvester.js',
    'content/store-assistant-ui.js'
  ];
  for (const rel of files) {
    const code = fs.readFileSync(path.join(extDir, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }
  return sandbox;
}

function createFakeElement(tagName, text = '', attrs = {}) {
  const listeners = new Map();
  const children = [];
  const classSet = new Set();
  const el = {
    tagName: String(tagName || 'DIV').toUpperCase(),
    textContent: text,
    innerText: text,
    attrs: { ...attrs },
    children,
    parentElement: null,
    nextElementSibling: null,
    shadowRoot: null,
    get id() {
      return this.attrs.id || '';
    },
    set id(v) {
      this.attrs.id = v;
    },
    get className() {
      return Array.from(classSet).join(' ');
    },
    set className(v) {
      classSet.clear();
      String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classSet.add(c));
    },
    classList: {
      contains: (c) => classSet.has(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classSet.has(c)) classSet.delete(c);
          else classSet.add(c);
        } else if (force) {
          classSet.add(c);
        } else {
          classSet.delete(c);
        }
      }
    },
    get firstChild() {
      return children[0] || null;
    },
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null;
    },
    setAttribute(name, val) {
      this.attrs[name] = String(val);
    },
    appendChild(child) {
      if (children.length > 0) {
        children[children.length - 1].nextElementSibling = child;
      }
      child.parentElement = this;
      children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      return child;
    },
    remove() {
      if (this.parentElement) {
        this.parentElement.removeChild(this);
      }
    },
    attachShadow({ mode }) {
      const root = createFakeElement('SHADOW-ROOT');
      root.mode = mode;
      this.shadowRoot = root;
      return root;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    click() {
      for (const fn of (listeners.get('click') || [])) fn();
    }
  };
  return el;
}

function createFakeDocument({ title = '', h1Text = '', mainText = '', priceNodes = [], compositionNodes = [], jsonLd = [] } = {}) {
  const body = createFakeElement('BODY', mainText);
  const h1 = h1Text ? createFakeElement('H1', h1Text) : null;
  const main = createFakeElement('MAIN', mainText);
  const ldScripts = jsonLd.map((obj) => createFakeElement('SCRIPT', JSON.stringify(obj), { type: 'application/ld+json' }));

  const doc = {
    title,
    body,
    createElement: (tag) => createFakeElement(tag),
    getElementById: (id) => body.children.find((c) => c.id === id) || null,
    querySelector: (sel) => {
      if (sel === 'h1') return h1;
      if (sel === 'main') return main;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel.includes('ld+json')) return ldScripts;
      if (sel.toLowerCase().includes('price')) return priceNodes;
      if (sel.toLowerCase().includes('composition') || sel.toLowerCase().includes('ingredient')) return compositionNodes;
      return [];
    }
  };
  return doc;
}

test('detectAssistantStorePage matches Magnit, Pyaterochka, and Perekrestok product pages only', () => {
  const { LQS_STORE_ASSISTANT_UI: ui } = loadAssistantStack();

  assert.deepEqual(
    JSON.parse(JSON.stringify(ui.detectAssistantStorePage({ hostname: 'magnit.ru', pathname: '/product/1000123456-moloko/' }))),
    { id: 'magnit', store: 'Магнит' }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ui.detectAssistantStorePage({ hostname: '5ka.ru', pathname: '/product/moloko-prostokvashino-930ml/' }))),
    { id: 'pyaterochka', store: 'Пятёрочка' }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ui.detectAssistantStorePage({ hostname: 'www.5ka.ru', pathname: '/catalog/molochnye-produkty/3456789/' }))),
    { id: 'pyaterochka', store: 'Пятёрочка' }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ui.detectAssistantStorePage({ hostname: 'www.perekrestok.ru', pathname: '/cat/114/p/moloko-32-930ml-123456' }))),
    { id: 'perekrestok', store: 'Перекрёсток' }
  );

  // Non-product pages and other domains must return null
  assert.equal(ui.detectAssistantStorePage({ hostname: 'magnit.ru', pathname: '/search' }), null);
  assert.equal(ui.detectAssistantStorePage({ hostname: '5ka.ru', pathname: '/catalog/' }), null);
  assert.equal(ui.detectAssistantStorePage({ hostname: 'perekrestok.ru', pathname: '/cat/114' }), null);
  assert.equal(ui.detectAssistantStorePage({ hostname: 'lavka.yandex.ru', pathname: '/good/moloko' }), null);
  assert.equal(ui.detectAssistantStorePage({ hostname: 'kuper.ru', pathname: '/products/123' }), null);
});

test('extractStoreProductFromDoc & buildStoreAssistantModel compute unit prices, traffic light, and comparisons', () => {
  const { LQS_STORE_ASSISTANT_UI: ui } = loadAssistantStack();

  const doc = createFakeDocument({
    title: 'Сырок творожный 50 г — Магнит',
    h1Text: 'Сырок творожный глазированный 50 г',
    mainText: 'Сырок творожный глазированный 50 г\n65 ₽\nБелки: 8,5 г\nСостав: творог, заменитель молочного жира, пальмовое масло, сахар.',
    priceNodes: [createFakeElement('SPAN', '65 ₽')],
    compositionNodes: [createFakeElement('DIV', 'Состав: творог, заменитель молочного жира, пальмовое масло, сахар.')]
  });

  const storeInfo = { id: 'magnit', store: 'Магнит' };
  const product = ui.extractStoreProductFromDoc(doc, { href: 'https://magnit.ru/product/12345' }, storeInfo);
  assert.equal(product.store, 'Магнит');
  assert.equal(product.price, 65);
  assert.equal(product.amount, '50 г');
  assert.equal(product.proteinPer100g, 8.5);
  assert.match(product.ingredients, /пальмовое масло/i);

  const model = ui.buildStoreAssistantModel(product, {
    lavka: { store: 'Яндекс Лавка', price: 79, minPrice: 69, url: 'https://lavka.yandex.ru/good/syrok-50g' },
    otherStores: [
      { store: 'Купер', sourceRetailer: 'Пятёрочка', price: 59, url: 'https://kuper.ru/pyaterochka/products/syrok' },
      { store: 'Перекрёсток', price: 72, url: 'javascript:alert(1)' }
    ]
  });

  assert.equal(model.unitInfo.pricePerKg, 1300);
  assert.ok(model.unitBadges.includes('1300 ₽/кг'));
  assert.equal(model.trafficLight.level, 'red');
  assert.equal(model.comparisonStatus, 'cheaper_elsewhere');
  assert.match(model.comparisonHeadline, /Дешевле в Купер: 59 ₽/);

  // Kuper keeps sourceRetailer in titleHint and unsafe javascript: URL is stripped
  const kuperOffer = model.comparedOffers.find((o) => o.store === 'Купер');
  assert.match(kuperOffer.titleHint, /Пятёрочка/);
  const perekOffer = model.comparedOffers.find((o) => o.store === 'Перекрёсток');
  assert.ok(!perekOffer.url, 'javascript: URL must be stripped');
});

test('renderStoreAssistantWidget mounts isolated Shadow DOM card with working collapse toggle', () => {
  const { LQS_STORE_ASSISTANT_UI: ui } = loadAssistantStack();

  const doc = createFakeDocument({
    h1Text: 'Молоко Простоквашино 930 мл',
    mainText: 'Молоко Простоквашино 930 мл 95 ₽ Состав: молоко нормализованное.',
    priceNodes: [createFakeElement('DIV', '95 ₽')],
    compositionNodes: [createFakeElement('P', 'молоко нормализованное')]
  });

  const product = ui.extractStoreProductFromDoc(
    doc,
    { href: 'https://perekrestok.ru/cat/114/p/moloko-930ml' },
    { id: 'perekrestok', store: 'Перекрёсток' }
  );
  const model = ui.buildStoreAssistantModel(product, {
    lavka: { store: 'Яндекс Лавка', price: 119, url: 'https://lavka.yandex.ru/good/moloko-930' },
    otherStores: []
  });

  assert.equal(model.trafficLight.level, 'green');
  assert.equal(model.comparisonStatus, 'best_here');
  assert.match(model.comparisonHeadline, /Выгоднее, чем в Яндекс Лавка на 24 ₽/);

  const host = ui.renderStoreAssistantWidget(doc, model);
  assert.equal(host.id, ui.HOST_ID);
  assert.ok(host.shadowRoot, 'Widget must use Shadow DOM');
  assert.equal(host.shadowRoot.mode, 'open');

  // Verify collapse toggle button updates state
  const card = host.shadowRoot.children.find((c) => c.tagName === 'SECTION');
  assert.ok(card);
  const header = card.children[0];
  const body = card.children[1];
  const toggleBtn = header.children[1];
  assert.equal(body.classList.contains('is-collapsed'), false);
  toggleBtn.click();
  assert.equal(body.classList.contains('is-collapsed'), true);
  assert.equal(toggleBtn.textContent, 'Показать');
});

test('findLocalComparisonsForStoreProduct matches Lavka and other stores while excluding current store and wrong volume', async () => {
  const storageData = {
    lqs_price_db_v1: {
      'cola-zero-15': {
        slug: 'cola-zero-15',
        title: 'Добрый Cola без сахара 1,5 л',
        amount: '1,5 л',
        lastPrice: 149,
        minPrice: 129
      },
      'cola-regular-15': {
        slug: 'cola-regular-15',
        title: 'Добрый Cola 1,5 л',
        amount: '1,5 л',
        lastPrice: 119,
        minPrice: 109
      }
    },
    lqs_ext_store_prices_v1: [
      {
        store: 'Магнит',
        title: 'Добрый Cola без сахара 1,5 л',
        amount: '1,5 л',
        price: 135,
        url: 'https://magnit.ru/product/111'
      },
      {
        store: 'Пятёрочка',
        title: 'Добрый Cola без сахара 1,5 л',
        amount: '1,5 л',
        price: 129,
        url: 'https://5ka.ru/product/222'
      },
      {
        store: 'Купер',
        sourceRetailer: 'Ашан',
        title: 'Добрый Cola без сахара 1,5 л',
        amount: '1,5 л',
        price: 139,
        url: 'https://kuper.ru/auchan/products/333'
      },
      {
        store: 'Перекрёсток',
        title: 'Добрый Cola без сахара 0,5 л',
        amount: '0,5 л',
        price: 75,
        url: 'https://perekrestok.ru/cat/1/p/444'
      }
    ]
  };

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
    JSON,
    Promise,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    chrome: {
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
      }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);

  for (const rel of ['shared/config.js', 'shared/utils.js', 'shared/product-matcher.js', 'bg/price-radar.js']) {
    const code = fs.readFileSync(path.join(extDir, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }

  const res = await sandbox.LQS_PRICE_RADAR.findLocalComparisonsForStoreProduct({
    store: 'Магнит',
    title: 'Добрый Cola без сахара 1,5 л',
    amount: '1,5 л',
    price: 135
  });

  assert.equal(res.ok, true);
  assert.equal(res.lavka.slug, 'cola-zero-15');
  assert.equal(res.lavka.price, 149);

  // Current store (Магнит) and wrong volume (Перекрёсток 0,5 л) must be excluded
  const storeNames = res.otherStores.map((o) => o.store);
  assert.deepEqual(storeNames, ['Пятёрочка', 'Купер']);
  assert.equal(res.otherStores[1].sourceRetailer, 'Ашан');
});

test('store-assistant-ui.js is MV3 CSP clean, registered in manifest, and guarded in background.js', () => {
  const uiCode = fs.readFileSync(path.join(extDir, 'content', 'store-assistant-ui.js'), 'utf8');
  assert.doesNotMatch(uiCode, /onclick\s*=/i);
  assert.doesNotMatch(uiCode, /\beval\s*\(/);
  assert.doesNotMatch(uiCode, /new\s+Function\s*\(/);
  assert.doesNotMatch(uiCode, /catch\s*\{\s*\}/);

  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  const jsList = manifest.content_scripts[0].js;
  assert.ok(jsList.includes('content/store-assistant-ui.js'), 'store-assistant-ui.js must be registered in manifest.json');

  const bgCode = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');
  assert.match(
    bgCode,
    /msg\.type === 'LQS_COMPARE_STORE_PRODUCT'\)[\s\S]{0,160}isTrustedExternalStoreSender\(sender\)/,
    'LQS_COMPARE_STORE_PRODUCT must be guarded by isTrustedExternalStoreSender(sender)'
  );
});
