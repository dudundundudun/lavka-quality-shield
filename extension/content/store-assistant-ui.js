/**
 * Lavka Quality Shield — Universal Store Product Assistant UI (content/store-assistant-ui.js)
 * Compact Shadow DOM helper card on product pages of:
 *   - Магнит (magnit.ru/product/...)
 *   - Пятёрочка (5ka.ru/...)
 *   - Перекрёсток (perekrestok.ru/cat/.../p/...)
 *
 * Reuses LQS_PRICE_PARSER (₽/кг, ₽/л, ₽/шт, ₽/100г белка),
 * LQS_INGREDIENTS_GUARD ("Светофор состава"), and local price database comparison
 * (Яндекс Лавка + другие сети) without interfering with passive store harvesting.
 */
(function (root) {
  'use strict';

  const HOST_ID = 'lqs-store-assistant-host';
  const COLLAPSE_STORAGE_KEY = 'lqs_store_assistant_collapsed';

  const ASSISTANT_STORES = Object.freeze([
    {
      id: 'magnit',
      store: 'Магнит',
      hostPattern: /(^|\.)magnit\.ru$/i,
      productPathPattern: /\/product\/[^/?#]+/i
    },
    {
      id: 'pyaterochka',
      store: 'Пятёрочка',
      hostPattern: /(^|\.)5ka\.ru$/i,
      productPathPattern: /\/(?:product|goods|item)\/[^/?#]+|\/catalog\/[^?#]*\d{4,}/i
    },
    {
      id: 'perekrestok',
      store: 'Перекрёсток',
      hostPattern: /(^|\.)perekrestok\.ru$/i,
      productPathPattern: /\/cat\/[^?#]*\/p\/[^/?#]+/i
    }
  ]);

  function normalizeSpace(text) {
    return String(text || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function safeUrl(raw) {
    if (root.LQS_UTILS && typeof root.LQS_UTILS.safeHttpUrl === 'function') {
      return root.LQS_UTILS.safeHttpUrl(raw);
    }
    try {
      const u = new URL(String(raw || ''));
      return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : null;
    } catch (err) {
      void err;
      return null;
    }
  }

  function detectAssistantStorePage(winLoc) {
    if (!winLoc) return null;
    const hostname = String(winLoc.hostname || '').toLowerCase().trim();
    const pathname = String(winLoc.pathname || '').trim();
    if (!hostname || !pathname) return null;
    for (const entry of ASSISTANT_STORES) {
      if (entry.hostPattern.test(hostname) && entry.productPathPattern.test(pathname)) {
        return { id: entry.id, store: entry.store };
      }
    }
    return null;
  }

  function extractPriceFallback(text) {
    if (root.LQS_STORE_HARVESTER && typeof root.LQS_STORE_HARVESTER.extractPricePairFromText === 'function') {
      return root.LQS_STORE_HARVESTER.extractPricePairFromText(text);
    }
    const clean = normalizeSpace(text).replace(
      /\d+(?:[.,]\d{1,2})?\s*(?:₽|руб\.?)\s*(?:\/\s*(?:кг|л|шт|100\s*г)|за\s*(?:кг|л|шт|100\s*г))/gi,
      ' '
    );
    const matches = Array.from(clean.matchAll(/(\d{1,5}(?:\s?\d{3})?(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?)/gi))
      .map((m) => parseFloat(m[1].replace(/\s+/g, '').replace(',', '.')))
      .filter((v) => Number.isFinite(v) && v >= 10 && v <= 25000);
    if (matches.length === 0) return null;
    const price = Math.round(matches[0]);
    const oldPrice = matches.length > 1 && matches[1] > matches[0] && matches[1] <= matches[0] * 3.5
      ? Math.round(matches[1])
      : null;
    return { price, oldPrice };
  }

  function extractWeightFallback(text) {
    if (root.LQS_STORE_HARVESTER && typeof root.LQS_STORE_HARVESTER.extractWeightFromText === 'function') {
      return root.LQS_STORE_HARVESTER.extractWeightFromText(text);
    }
    const m = String(text || '').match(/(\d+(?:[.,]\d+)?\s*(?:г|гр|кг|мл|л|шт)(?![а-яёa-z]))/i);
    return m ? m[1].trim() : '';
  }

  function readJsonLdProduct(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length; i++) {
      const raw = scripts[i]?.textContent || '';
      if (!raw || raw.length > 200000) continue;
      try {
        const parsed = JSON.parse(raw);
        const nodes = Array.isArray(parsed) ? parsed : [parsed];
        for (const node of nodes) {
          if (!node || typeof node !== 'object') continue;
          const t = String(node['@type'] || '').toLowerCase();
          if (!t.includes('product')) continue;
          const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
          const priceNum = Number(offer?.price || offer?.lowPrice || 0);
          return {
            title: normalizeSpace(node.name || ''),
            price: Number.isFinite(priceNum) && priceNum >= 10 && priceNum <= 25000 ? Math.round(priceNum) : null,
            description: normalizeSpace(node.description || '')
          };
        }
      } catch (err) {
        void err;
      }
    }
    return null;
  }

  function extractIngredientsFromStoreDoc(doc) {
    if (!doc) return '';

    // 1. Dedicated semantic containers / attributes
    if (typeof doc.querySelectorAll === 'function') {
      const selectors = [
        '[data-testid*="composition" i]',
        '[data-testid*="ingredient" i]',
        '[data-qa*="composition" i]',
        '[data-qa*="ingredient" i]',
        '[itemprop="ingredients"]',
        '[class*="composition" i]',
        '[class*="ingredient" i]'
      ];
      for (const sel of selectors) {
        const nodes = doc.querySelectorAll(sel);
        for (let i = 0; i < nodes.length; i++) {
          const txt = normalizeSpace(nodes[i]?.textContent || '');
          const cleaned = txt.replace(/^состав\s*[:\-–—]?\s*/i, '').trim();
          if (cleaned.length >= 10 && cleaned.length <= 2000 && !/^(показать|скрыть|подробнее)/i.test(cleaned)) {
            return cleaned;
          }
        }
      }

      // 2. Definition lists / heading + sibling value ("Состав" -> next sibling)
      const labelNodes = doc.querySelectorAll('h2, h3, h4, dt, th, span, div, p');
      const maxScan = Math.min(labelNodes.length, 300);
      for (let i = 0; i < maxScan; i++) {
        const el = labelNodes[i];
        const label = normalizeSpace(el?.textContent || '');
        if (!/^состав:?$/i.test(label)) continue;
        const sib = el.nextElementSibling;
        if (sib) {
          const sibText = normalizeSpace(sib.textContent || '');
          if (sibText.length >= 10 && sibText.length <= 2000) {
            return sibText;
          }
        }
      }
    }

    // 3. Fallback regex on main/body text
    const mainScope = (typeof doc.querySelector === 'function' ? doc.querySelector('main') : null) || doc.body;
    const rawBody = String(mainScope?.innerText || mainScope?.textContent || '');
    const m = rawBody.match(/(?:^|\n|\s)Состав\s*[:\-–—]?\s*\n?\s*([^\n]{10,1200})/i);
    if (m && m[1]) {
      const candidate = normalizeSpace(m[1])
        .split(/\b(?:Условия хранения|Пищевая ценность|Энергетическая ценность|Срок годности|Бренд|Страна|Производитель)\b/i)[0]
        .trim();
      if (candidate.length >= 10) return candidate;
    }

    return '';
  }

  function extractProteinFromStoreDoc(doc) {
    const mainScope = (doc && typeof doc.querySelector === 'function' ? doc.querySelector('main') : null) || doc?.body;
    const text = normalizeSpace((mainScope?.innerText || mainScope?.textContent || '').slice(0, 6000));
    const m = text.match(/белк[иа]\s*[:\-–—]?\s*(\d+(?:[.,]\d+)?)\s*г(?![а-яёa-z])/i);
    if (!m) return null;
    const val = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(val) && val >= 0 && val <= 100 ? val : null;
  }

  function extractStoreProductFromDoc(doc, winLoc, storeInfo) {
    if (!doc || !winLoc || !storeInfo) return null;
    const ld = readJsonLdProduct(doc);
    const h1 = typeof doc.querySelector === 'function' ? doc.querySelector('h1') : null;
    const titleFromH1 = normalizeSpace(h1?.textContent || '');
    const titleFromDoc = normalizeSpace(String(doc.title || '').split(/[—|–]/)[0] || '');
    const title = (titleFromH1.length >= 3 ? titleFromH1 : '') || (ld?.title || '') || titleFromDoc;

    if (!title || title.length < 3) return null;

    // Extract price: targeted price nodes -> JSON-LD -> main text
    let pricePair = null;
    if (typeof doc.querySelectorAll === 'function') {
      const priceSelectors = [
        '[data-testid*="price" i]',
        '[data-qa*="price" i]',
        '[itemprop="price"]',
        '[class*="product-price" i]',
        '[class*="ProductPrice" i]',
        '[class*="price-new" i]',
        '[class*="current-price" i]'
      ];
      for (const sel of priceSelectors) {
        const nodes = doc.querySelectorAll(sel);
        for (let i = 0; i < Math.min(nodes.length, 10); i++) {
          const txt = normalizeSpace(nodes[i]?.textContent || nodes[i]?.getAttribute?.('content') || '');
          const pr = extractPriceFallback(txt);
          if (pr) {
            pricePair = pr;
            break;
          }
        }
        if (pricePair) break;
      }
    }

    if (!pricePair && ld?.price) {
      pricePair = { price: ld.price, oldPrice: null };
    }

    const mainScope = (typeof doc.querySelector === 'function' ? doc.querySelector('main') : null) || doc.body;
    const mainSnippet = normalizeSpace((mainScope?.innerText || mainScope?.textContent || '').slice(0, 2200));

    if (!pricePair) {
      pricePair = extractPriceFallback(mainSnippet);
    }

    if (!pricePair || !pricePair.price) return null;

    let amount = extractWeightFallback(title);
    if (!amount && typeof doc.querySelectorAll === 'function') {
      const weightNodes = doc.querySelectorAll('[class*="weight" i], [class*="volume" i], [data-testid*="weight" i]');
      for (let i = 0; i < Math.min(weightNodes.length, 8); i++) {
        const w = extractWeightFallback(weightNodes[i]?.textContent || '');
        if (w) {
          amount = w;
          break;
        }
      }
    }
    if (!amount) {
      const weightSpec = mainSnippet.match(/(?:вес|масса(?:\s+нетто)?|объ[её]м|фасовка)\s*[:\-–—]?\s*(\d+(?:[.,]\d+)?\s*(?:г|гр|кг|мл|л|шт)(?![а-яёa-z]))/i);
      if (weightSpec) amount = weightSpec[1].trim();
    }

    const ingredients = extractIngredientsFromStoreDoc(doc);
    const proteinPer100g = extractProteinFromStoreDoc(doc);

    return {
      storeId: storeInfo.id,
      store: storeInfo.store,
      title,
      amount,
      price: pricePair.price,
      oldPrice: pricePair.oldPrice || null,
      ingredients,
      proteinPer100g,
      url: String(winLoc.href || '')
    };
  }

  function buildStoreAssistantModel(product, comparisonData = null) {
    if (!product || !product.title || !product.price) return null;

    const parser = root.LQS_PRICE_PARSER;
    const unitInfo = parser && typeof parser.computeUnitPrices === 'function'
      ? parser.computeUnitPrices({
          price: product.price,
          amountText: product.amount || '',
          title: product.title,
          proteinPer100g: product.proteinPer100g
        })
      : { pricePerKg: null, unitLabel: 'кг', pricePerPiece: null, pieceUnitLabel: 'шт', pricePer100gProtein: null };

    const unitBadges = [];
    if (unitInfo.pricePerKg) {
      unitBadges.push(`${unitInfo.pricePerKg} ₽/${unitInfo.unitLabel || 'кг'}`);
    }
    if (unitInfo.pricePerPiece) {
      unitBadges.push(`${unitInfo.pricePerPiece} ₽/${unitInfo.pieceUnitLabel || 'шт'}`);
    }
    if (unitInfo.pricePer100gProtein) {
      unitBadges.push(`${unitInfo.pricePer100gProtein} ₽/100г белка`);
    }

    const guard = root.LQS_INGREDIENTS_GUARD;
    const trafficLight = guard && typeof guard.analyzeIngredientsTrafficLight === 'function'
      ? guard.analyzeIngredientsTrafficLight(product.ingredients || '', product.title)
      : { level: 'none', emoji: '⚪', badgeText: '', summary: 'Состав на карточке не указан', redFlags: [], yellowFlags: [], allFlags: [] };

    const lavkaMatch = comparisonData && comparisonData.lavka ? comparisonData.lavka : null;
    const otherStores = Array.isArray(comparisonData?.otherStores) ? comparisonData.otherStores.slice(0, 3) : [];

    const allCompared = [];
    if (lavkaMatch && lavkaMatch.price > 0) {
      allCompared.push({
        store: 'Яндекс Лавка',
        price: Math.round(lavkaMatch.price),
        url: safeUrl(lavkaMatch.url),
        titleHint: lavkaMatch.minPrice && lavkaMatch.minPrice < lavkaMatch.price
          ? `Мин. цена в Лавке: ${Math.round(lavkaMatch.minPrice)} ₽`
          : 'Цена из локальной базы Яндекс Лавки'
      });
    }
    for (const o of otherStores) {
      if (!o || !o.store || !o.price) continue;
      const hint = o.store === 'Купер' && o.sourceRetailer
        ? `Через Купер (магазин: ${o.sourceRetailer})`
        : `${o.store} — из локальной базы`;
      allCompared.push({
        store: o.store,
        price: Math.round(o.price),
        url: safeUrl(o.url),
        titleHint: hint
      });
    }
    allCompared.sort((a, b) => a.price - b.price);

    let comparisonStatus = 'empty';
    let comparisonHeadline = 'Пока нет в локальной базе — откройте товар в Лавке для сравнения';

    if (allCompared.length > 0) {
      const best = allCompared[0];
      const diff = product.price - best.price;
      if (diff > 2) {
        comparisonStatus = 'cheaper_elsewhere';
        comparisonHeadline = `Дешевле в ${best.store}: ${best.price} ₽ (на ${diff} ₽ ниже)`;
      } else if (diff < -2) {
        comparisonStatus = 'best_here';
        comparisonHeadline = `Выгоднее, чем в ${best.store} на ${Math.abs(diff)} ₽`;
      } else {
        comparisonStatus = 'same_price';
        comparisonHeadline = `Цена как в ${best.store} (${best.price} ₽)`;
      }
    }

    return {
      store: product.store,
      title: product.title,
      price: product.price,
      oldPrice: product.oldPrice,
      amount: product.amount || '',
      unitInfo,
      unitBadges,
      trafficLight,
      comparedOffers: allCompared,
      comparisonStatus,
      comparisonHeadline
    };
  }

  const WIDGET_STYLES = `
    :host {
      --lqs-bg: #ffffff;
      --lqs-surface: #f5f4f2;
      --lqs-border: #e5e2dc;
      --lqs-text: #21201f;
      --lqs-muted: #6e6b66;
      --lqs-accent: #fce000;
      --lqs-accent-text: #21201f;
      --lqs-green-bg: #e9f7ef;
      --lqs-green-text: #146c43;
      --lqs-yellow-bg: #fff8dc;
      --lqs-yellow-text: #856404;
      --lqs-red-bg: #fdecec;
      --lqs-red-text: #b42318;
      --lqs-radius: 14px;
      --lqs-shadow: 0 10px 28px rgba(33, 32, 31, 0.16);
      all: initial;
      position: fixed;
      left: 16px;
      bottom: 16px;
      z-index: 2147483000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--lqs-text);
    }
    .card {
      width: 316px;
      max-width: calc(100vw - 32px);
      background: var(--lqs-bg);
      border: 1px solid var(--lqs-border);
      border-radius: var(--lqs-radius);
      box-shadow: var(--lqs-shadow);
      overflow: hidden;
      font-size: 12.5px;
      line-height: 1.4;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 12px;
      background: var(--lqs-accent);
      color: var(--lqs-accent-text);
      font-weight: 700;
      font-size: 12.5px;
    }
    .header-title {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .toggle-btn {
      appearance: none;
      border: none;
      background: rgba(33, 32, 31, 0.1);
      color: var(--lqs-accent-text);
      border-radius: 8px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .toggle-btn:hover {
      background: rgba(33, 32, 31, 0.18);
    }
    .toggle-btn:focus-visible {
      outline: 2px solid var(--lqs-text);
      outline-offset: 1px;
    }
    .body {
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .body.is-collapsed {
      display: none;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: var(--lqs-surface);
      color: var(--lqs-text);
    }
    .pill-unit {
      background: #21201f;
      color: #fce000;
    }
    .pill-green {
      background: var(--lqs-green-bg);
      color: var(--lqs-green-text);
    }
    .pill-yellow {
      background: var(--lqs-yellow-bg);
      color: var(--lqs-yellow-text);
    }
    .pill-red {
      background: var(--lqs-red-bg);
      color: var(--lqs-red-text);
    }
    .pill-muted {
      background: var(--lqs-surface);
      color: var(--lqs-muted);
      font-weight: 500;
    }
    .compare-box {
      background: var(--lqs-surface);
      border-radius: 10px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .compare-headline {
      font-weight: 700;
      font-size: 12px;
      color: var(--lqs-text);
    }
    .compare-headline.is-best {
      color: var(--lqs-green-text);
    }
    .compare-headline.is-cheaper {
      color: var(--lqs-red-text);
    }
    .compare-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .compare-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
    }
    .compare-link {
      color: var(--lqs-text);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .compare-price {
      font-weight: 700;
      white-space: nowrap;
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        transition: none !important;
        animation: none !important;
      }
    }
  `;

  function applyShadowStyles(shadowRoot, doc) {
    try {
      if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in shadowRoot) {
        const sheet = new CSSStyleSheet();
        if (typeof sheet.replaceSync === 'function') {
          sheet.replaceSync(WIDGET_STYLES);
          shadowRoot.adoptedStyleSheets = [sheet];
          return;
        }
      }
    } catch (err) {
      void err;
    }
    const styleEl = doc.createElement('style');
    styleEl.textContent = WIDGET_STYLES;
    shadowRoot.appendChild(styleEl);
  }

  function removeStoreAssistantWidget(doc) {
    if (!doc || typeof doc.getElementById !== 'function') return;
    const existing = doc.getElementById(HOST_ID);
    if (existing && typeof existing.remove === 'function') {
      existing.remove();
    }
  }

  function renderStoreAssistantWidget(doc, model) {
    if (!doc || !doc.body || !model) return null;

    let host = typeof doc.getElementById === 'function' ? doc.getElementById(HOST_ID) : null;
    let shadow = host ? host.shadowRoot : null;

    if (!host) {
      host = doc.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-lqs-store', model.store || '');
      if (typeof host.attachShadow === 'function') {
        shadow = host.attachShadow({ mode: 'open' });
        applyShadowStyles(shadow, doc);
      } else {
        shadow = host;
      }
      doc.body.appendChild(host);
    }

    // Clear previous content while keeping adoptedStyleSheets
    while (shadow.firstChild) {
      if (shadow.firstChild.tagName === 'STYLE') {
        const next = shadow.firstChild.nextSibling;
        if (!next) break;
        shadow.removeChild(next);
      } else {
        shadow.removeChild(shadow.firstChild);
      }
    }

    let isCollapsed = false;
    try {
      isCollapsed = typeof sessionStorage !== 'undefined' && sessionStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
    } catch (err) {
      void err;
    }

    const card = doc.createElement('section');
    card.className = 'card';
    card.setAttribute('aria-label', 'Помощник Lavka Quality Shield');

    // Header
    const header = doc.createElement('div');
    header.className = 'header';

    const headerTitle = doc.createElement('span');
    headerTitle.className = 'header-title';
    headerTitle.textContent = `🛡️ Lavka Shield · ${model.store}`;

    const toggleBtn = doc.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'toggle-btn';
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    toggleBtn.textContent = isCollapsed ? 'Показать' : 'Свернуть';

    header.appendChild(headerTitle);
    header.appendChild(toggleBtn);
    card.appendChild(header);

    // Body
    const body = doc.createElement('div');
    body.className = isCollapsed ? 'body is-collapsed' : 'body';

    // 1. Unit prices row
    const unitRow = doc.createElement('div');
    unitRow.className = 'row';
    if (model.unitBadges.length > 0) {
      for (const badgeText of model.unitBadges) {
        const pill = doc.createElement('span');
        pill.className = 'pill pill-unit';
        pill.textContent = badgeText;
        unitRow.appendChild(pill);
      }
    } else {
      const pill = doc.createElement('span');
      pill.className = 'pill pill-muted';
      pill.textContent = `${model.price} ₽ · вес не указан`;
      unitRow.appendChild(pill);
    }
    body.appendChild(unitRow);

    // 2. Traffic light row
    const tl = model.trafficLight;
    if (tl && tl.level && tl.level !== 'none') {
      const tlRow = doc.createElement('div');
      tlRow.className = 'row';
      const tlPill = doc.createElement('span');
      tlPill.className = `pill pill-${tl.level}`;
      tlPill.textContent = tl.badgeText || `${tl.emoji} Состав проверен`;
      tlPill.title = tl.summary || '';
      tlRow.appendChild(tlPill);
      body.appendChild(tlRow);
    }

    // 3. Comparison box
    const compareBox = doc.createElement('div');
    compareBox.className = 'compare-box';

    const headline = doc.createElement('div');
    headline.className = 'compare-headline';
    if (model.comparisonStatus === 'best_here') headline.className += ' is-best';
    if (model.comparisonStatus === 'cheaper_elsewhere') headline.className += ' is-cheaper';
    headline.textContent = model.comparisonHeadline;
    compareBox.appendChild(headline);

    if (model.comparedOffers.length > 0) {
      const list = doc.createElement('div');
      list.className = 'compare-list';
      for (const offer of model.comparedOffers) {
        const item = doc.createElement('div');
        item.className = 'compare-item';
        if (offer.titleHint) item.title = offer.titleHint;

        if (offer.url) {
          const link = doc.createElement('a');
          link.className = 'compare-link';
          link.href = offer.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = offer.store;
          item.appendChild(link);
        } else {
          const nameSpan = doc.createElement('span');
          nameSpan.textContent = offer.store;
          item.appendChild(nameSpan);
        }

        const priceSpan = doc.createElement('span');
        priceSpan.className = 'compare-price';
        priceSpan.textContent = `${offer.price} ₽`;
        item.appendChild(priceSpan);

        list.appendChild(item);
      }
      compareBox.appendChild(list);
    }

    body.appendChild(compareBox);
    card.appendChild(body);
    shadow.appendChild(card);

    toggleBtn.addEventListener('click', () => {
      const collapsedNow = !body.classList.contains('is-collapsed');
      body.classList.toggle('is-collapsed', collapsedNow);
      toggleBtn.setAttribute('aria-expanded', String(!collapsedNow));
      toggleBtn.textContent = collapsedNow ? 'Показать' : 'Свернуть';
      try {
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(COLLAPSE_STORAGE_KEY, collapsedNow ? '1' : '0');
        }
      } catch (err) {
        void err;
      }
    });

    return host;
  }

  function initStoreAssistantIfNeeded() {
    if (typeof window === 'undefined' || !window.location) return false;
    const hostMatched = ASSISTANT_STORES.some((s) => s.hostPattern.test(String(window.location.hostname || '').toLowerCase()));
    if (!hostMatched) return false;

    let lastRenderKey = '';
    let lastCheckedHref = '';
    let syncTimer = null;

    const syncWidget = () => {
      const storeInfo = detectAssistantStorePage(window.location);
      if (!storeInfo) {
        removeStoreAssistantWidget(document);
        lastRenderKey = '';
        return;
      }

      const product = extractStoreProductFromDoc(document, window.location, storeInfo);
      if (!product) return;

      const baseKey = `${window.location.href}|${product.title}|${product.price}|${product.amount}|${product.ingredients.length}`;
      if (baseKey === lastRenderKey) return;
      lastRenderKey = baseKey;

      // Render immediately with local unit price + traffic light
      const initialModel = buildStoreAssistantModel(product, null);
      if (initialModel) {
        renderStoreAssistantWidget(document, initialModel);
      }

      // Query background for local DB comparisons (Яндекс Лавка + другие сети)
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        chrome.runtime.sendMessage(
          {
            type: 'LQS_COMPARE_STORE_PRODUCT',
            payload: {
              store: product.store,
              title: product.title,
              amount: product.amount,
              price: product.price
            }
          },
          (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok) return;
            const updatedModel = buildStoreAssistantModel(product, resp);
            if (updatedModel) {
              renderStoreAssistantWidget(document, updatedModel);
            }
          }
        );
      }
    };

    const scheduleSync = (delay = 350) => {
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        if (!document.hidden) syncWidget();
      }, delay);
    };

    // Initial hydration wave for SPA store pages
    [400, 1200, 2600].forEach((ms) => setTimeout(() => {
      if (!document.hidden) syncWidget();
    }, ms));

    // Watch SPA route changes
    setInterval(() => {
      if (document.hidden) return;
      if (window.location.href !== lastCheckedHref) {
        lastCheckedHref = window.location.href;
        scheduleSync(450);
      }
    }, 900);

    window.addEventListener('popstate', () => scheduleSync(350));

    return true;
  }

  const api = {
    HOST_ID,
    ASSISTANT_STORES,
    detectAssistantStorePage,
    extractIngredientsFromStoreDoc,
    extractProteinFromStoreDoc,
    extractStoreProductFromDoc,
    buildStoreAssistantModel,
    renderStoreAssistantWidget,
    removeStoreAssistantWidget,
    initStoreAssistantIfNeeded
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_STORE_ASSISTANT_UI = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
