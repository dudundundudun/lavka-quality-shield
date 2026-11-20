/**
 * Lavka Quality Shield — Universal Multi-Store Price Harvester (content/store-harvester.js)
 * Supports passive harvesting (when user visits store pages) and on-demand background-tab
 * radar scanning (via LQS_HARVEST_STORE_PAGE_NOW) across:
 *   - Купер (kuper.ru — multi-retailer aggregator: Пятёрочка, Магнит, Перекрёсток, Ашан, Лента, МЕТРО, Дикси, ВкусВилл, О’КЕЙ, Глобус, Азбука Вкуса, Чижик)
 *   - Магнит (magnit.ru)
 *   - Перекрёсток / Впрок (perekrestok.ru, vprok.ru)
 *   - Пятёрочка (5ka.ru)
 *   - ВкусВилл (vkusvill.ru)
 *   - Ашан (auchan.ru)
 *   - Лента (lenta.com)
 */
(function (root) {
  'use strict';

  const SUPPORTED_STORES = [
    { id: 'kuper', store: 'Купер', hostPattern: /(^|\.)kuper\.ru$/i },
    { id: 'magnit', store: 'Магнит', hostPattern: /(^|\.)magnit\.ru$/i },
    { id: 'perekrestok', store: 'Перекрёсток', hostPattern: /(^|\.)(perekrestok\.ru|vprok\.ru)$/i },
    { id: 'pyaterochka', store: 'Пятёрочка', hostPattern: /(^|\.)5ka\.ru$/i },
    { id: 'vkusvill', store: 'ВкусВилл', hostPattern: /(^|\.)vkusvill\.ru$/i },
    { id: 'auchan', store: 'Ашан', hostPattern: /(^|\.)auchan\.ru$/i },
    { id: 'lenta', store: 'Лента', hostPattern: /(^|\.)lenta\.com$/i }
  ];

  const KUPER_RETAILER_MAP = [
    { re: /(pyaterochka|5ka|пят[её]рочк)/i, name: 'Пятёрочка' },
    { re: /(magnit|магнит)/i, name: 'Магнит' },
    { re: /(perekrestok|перекр[её]сток|vprok|впрок)/i, name: 'Перекрёсток' },
    { re: /(auchan|ашан)/i, name: 'Ашан' },
    { re: /(lenta|лента)/i, name: 'Лента' },
    { re: /(metro|метро)/i, name: 'МЕТРО' },
    { re: /(dixy|дикси)/i, name: 'Дикси' },
    { re: /(vkusvill|вкусвилл)/i, name: 'ВкусВилл' },
    { re: /(okey|о['’`]?кей)/i, name: 'О’КЕЙ' },
    { re: /(globus|глобус)/i, name: 'Глобус' },
    { re: /(azbukavkusa|azbuka|азбука\s+вкуса)/i, name: 'Азбука Вкуса' },
    { re: /(chizhik|чижик)/i, name: 'Чижик' },
    { re: /(samokat|самокат)/i, name: 'Самокат' },
    { re: /(magnoliya|магнолия)/i, name: 'Магнолия' }
  ];

  function detectStoreFromHost(hostname) {
    const h = String(hostname || '').toLowerCase().trim();
    for (const entry of SUPPORTED_STORES) {
      if (entry.hostPattern.test(h)) return entry;
    }
    return null;
  }

  function detectKuperRetailer(urlOrSlug, contextText = '') {
    const combined = `${urlOrSlug || ''} ${contextText || ''}`;
    for (const r of KUPER_RETAILER_MAP) {
      if (r.re.test(combined)) return r.name;
    }
    return 'Купер';
  }

  function normalizeSpace(text) {
    return String(text || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function extractWeightFromText(text) {
    const m = String(text || '').match(/(\d+(?:[.,]\d+)?\s*(?:г|гр|кг|мл|л|шт)(?![а-яёa-z]))/i);
    return m ? m[1].trim() : '';
  }

  function extractPricePairFromText(text) {
    const clean = normalizeSpace(text);
    // Avoid matching unit prices like "478 ₽/кг" or "120 ₽ за кг" when extracting main shelf price
    const withoutUnit = clean.replace(/\d+(?:[.,]\d{1,2})?\s*(?:₽|руб\.?)\s*(?:\/\s*(?:кг|л|шт|100\s*г)|за\s*(?:кг|л|шт|100\s*г))/gi, ' ');
    const matches = Array.from(withoutUnit.matchAll(/(\d{1,5}(?:\s?\d{3})?(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?)/gi))
      .map((m) => parseFloat(m[1].replace(/\s+/g, '').replace(',', '.')))
      .filter((v) => Number.isFinite(v) && v >= 10 && v <= 25000);

    if (matches.length === 0) return null;
    const price = Math.round(matches[0]);
    const oldPrice = matches.length > 1 && matches[1] > matches[0] && matches[1] <= matches[0] * 3.5
      ? Math.round(matches[1])
      : null;
    return { price, oldPrice };
  }

  function cleanCardTitle(rawTitle, fallbackText) {
    let t = normalizeSpace(rawTitle);
    if (!t || t.length < 3) {
      t = normalizeSpace(fallbackText)
        .replace(/\d+(?:[.,]\d{1,2})?\s*(?:₽|руб\.?).*$/i, '')
        .replace(/^(?:В корзину|Купить|Скидка|Акция|Хит|Новинка|\-\d+%)\s*/gi, '')
        .trim();
    }
    if (t.length > 140) t = t.slice(0, 140).trim();
    return t;
  }

  function parseJsonLdOffers(doc, storeName, originHref) {
    const offers = [];
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    scripts.forEach((sc) => {
      try {
        const parsed = JSON.parse(sc.textContent || '');
        const nodes = Array.isArray(parsed)
          ? parsed
          : (Array.isArray(parsed?.itemListElement)
              ? parsed.itemListElement.map((x) => x?.item || x)
              : [parsed]);
        for (const node of nodes) {
          if (!node || typeof node !== 'object') continue;
          const typeStr = String(node['@type'] || '').toLowerCase();
          if (!typeStr.includes('product')) continue;
          const title = normalizeSpace(node.name || '');
          const offerObj = Array.isArray(node.offers) ? node.offers[0] : node.offers;
          const priceVal = Number(offerObj?.price || offerObj?.lowPrice || 0);
          if (!title || title.length < 3 || !Number.isFinite(priceVal) || priceVal < 10 || priceVal > 25000) continue;
          const url = typeof node.url === 'string' && node.url.startsWith('http') ? node.url : originHref;
          offers.push({
            store: storeName,
            goodId: node.sku ? String(node.sku) : null,
            title,
            amount: extractWeightFromText(title),
            price: Math.round(priceVal),
            oldPrice: null,
            url
          });
        }
      } catch {
        // ignore invalid JSON-LD
      }
    });
    return offers;
  }

  function parseMagnitOffers(doc, winLoc) {
    const offers = [];
    const seen = new Set();

    const catalogCards = doc.querySelectorAll('article.unit-catalog-product-preview, a.pl-hover-base[href*="/product/"]');
    catalogCards.forEach((node) => {
      const card = node.tagName === 'ARTICLE' ? node : (node.closest('article.unit-catalog-product-preview') || node);
      const linkEl = card.tagName === 'A' ? card : card.querySelector('a.pl-hover-base[href*="/product/"], a[href*="/product/"]');
      if (!linkEl) return;
      const href = linkEl.getAttribute('href') || '';
      if (!href.includes('/product/')) return;
      const fullUrl = new URL(href, winLoc.origin).href;
      if (seen.has(fullUrl)) return;

      const imgEl = card.querySelector('div.unit-catalog-product-preview-image img[alt], img[alt]');
      const imgAlt = imgEl ? (imgEl.getAttribute('alt') || '').trim() : '';
      const rawText = normalizeSpace(card.innerText || linkEl.innerText || '');
      const pr = extractPricePairFromText(rawText);
      if (!pr) return;

      const title = imgAlt && imgAlt.length > 4
        ? imgAlt
        : rawText.replace(/^.*?₽\s*(?:-\d+%\s*\d+(?:[.,]\d+)?\s*₽\s*)?/i, '').trim();
      if (!title || title.length < 3) return;

      const idMatch = href.match(/\/product\/(\d+)/);
      seen.add(fullUrl);
      offers.push({
        store: 'Магнит',
        goodId: idMatch ? idMatch[1] : null,
        title,
        amount: extractWeightFromText(title),
        price: pr.price,
        oldPrice: pr.oldPrice,
        url: fullUrl
      });
    });

    const cartLinks = doc.querySelectorAll('a.cart-product-list-item-wrap-content[href*="/product/"]');
    cartLinks.forEach((linkEl) => {
      const href = linkEl.getAttribute('href') || '';
      const fullUrl = new URL(href, winLoc.origin).href;
      if (seen.has(fullUrl)) return;

      const row = linkEl.closest('div.cart-product-item') || linkEl.parentElement;
      const imgEl = row ? row.querySelector('div.cart-product-item__left img[alt], img[alt]') : null;
      const imgAlt = imgEl ? (imgEl.getAttribute('alt') || '').trim() : '';
      const rawText = normalizeSpace((row || linkEl).innerText || '');
      const pr = extractPricePairFromText(rawText);
      if (!pr) return;

      const title = imgAlt && imgAlt.length > 4 ? imgAlt : rawText.split(/Финальная цена|\d+\s*₽/)[0].trim();
      if (!title || title.length < 3) return;

      const idMatch = href.match(/\/product\/(\d+)/);
      seen.add(fullUrl);
      offers.push({
        store: 'Магнит',
        goodId: idMatch ? idMatch[1] : null,
        title,
        amount: extractWeightFromText(title),
        price: pr.price,
        oldPrice: pr.oldPrice,
        url: fullUrl
      });
    });

    if (winLoc.pathname.includes('/product/')) {
      const h1 = doc.querySelector('h1');
      const pageTitle = h1 ? normalizeSpace(h1.textContent || '') : doc.title.split('—')[0].trim();
      const mainScope = doc.querySelector('main') || doc.body;
      const pr = extractPricePairFromText((mainScope?.innerText || '').slice(0, 2000));
      if (pageTitle && pr && !seen.has(winLoc.href)) {
        const idMatch = winLoc.pathname.match(/\/product\/(\d+)/);
        offers.push({
          store: 'Магнит',
          goodId: idMatch ? idMatch[1] : null,
          title: pageTitle,
          amount: extractWeightFromText(pageTitle),
          price: pr.price,
          oldPrice: pr.oldPrice,
          url: winLoc.href
        });
      }
    }

    return offers;
  }

  function parseKuperOffers(doc, winLoc) {
    const offers = [];
    const seen = new Set();

    // Kuper multisearch groups products by retailer sections, or renders product cards with retailer links
    const cardNodes = doc.querySelectorAll(
      '[data-qa*="product"], [class*="ProductCard"], [class*="product-card"], article, a[href*="/products/"]'
    );

    cardNodes.forEach((node) => {
      const card = node.tagName === 'A'
        ? (node.closest('article, [data-qa*="product"], [class*="ProductCard"], [class*="product-card"], li') || node.parentElement || node)
        : node;
      const linkEl = node.tagName === 'A'
        ? node
        : card.querySelector('a[href*="/products/"], a[href*="/product/"], a[href]');
      if (!linkEl) return;

      const href = linkEl.getAttribute('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      let fullUrl;
      try {
        fullUrl = new URL(href, winLoc.origin).href;
      } catch {
        return;
      }

      const rawText = normalizeSpace(card.innerText || card.textContent || '');
      if (!rawText || rawText.length < 6 || rawText.length > 600) return;

      const pr = extractPricePairFromText(rawText);
      if (!pr) return;

      // Determine which retailer inside Kuper owns this card
      const section = card.closest('section, [data-qa*="retailer"], [class*="Retailer"], [class*="StoreGroup"], [class*="SearchGroup"]');
      const sectionHeader = section
        ? normalizeSpace((section.querySelector('h1, h2, h3, [class*="Title"], [class*="Retailer"], img[alt]')?.textContent ||
            section.querySelector('img[alt]')?.getAttribute('alt') || ''))
        : '';
      const storeName = detectKuperRetailer(fullUrl, `${sectionHeader} ${winLoc.pathname}`);

      const titleEl = card.querySelector('[data-qa*="title"], [class*="Title"], [class*="Name"], h3, h4, img[alt]');
      const rawTitle = titleEl
        ? (titleEl.tagName === 'IMG' ? titleEl.getAttribute('alt') : titleEl.textContent)
        : (linkEl.getAttribute('title') || linkEl.textContent || '');
      const title = cleanCardTitle(rawTitle, rawText);
      if (!title || title.length < 4) return;

      const dedupKey = `${storeName}|${title.toLowerCase()}|${pr.price}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);

      offers.push({
        store: storeName,
        goodId: null,
        title,
        amount: extractWeightFromText(`${title} ${rawText}`),
        price: pr.price,
        oldPrice: pr.oldPrice,
        url: fullUrl
      });
    });

    return offers;
  }

  function parseGenericRetailerOffers(doc, winLoc, storeInfo) {
    const offers = [];
    const seen = new Set();
    const storeName = storeInfo.store;

    const cardSelectors = [
      'article',
      'lu-product-card',
      '[data-testid*="product"]',
      '[data-qa*="product"]',
      '[class*="ProductCard"]',
      '[class*="product-card"]',
      '[class*="product_card"]',
      'a[href*="/goods/"]',
      'a[href*="/product/"]',
      'a[href*="/cat/"]'
    ].join(', ');

    const nodes = doc.querySelectorAll(cardSelectors);
    nodes.forEach((node) => {
      const card = node.tagName === 'A'
        ? (node.closest('article, li, [class*="ProductCard"], [class*="product-card"], [data-testid*="product"]') || node.parentElement || node)
        : node;
      const linkEl = node.tagName === 'A'
        ? node
        : card.querySelector('a[href*="/goods/"], a[href*="/product/"], a[href*="/cat/"], a[href]');
      if (!linkEl) return;

      const href = linkEl.getAttribute('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      let fullUrl;
      try {
        fullUrl = new URL(href, winLoc.origin).href;
      } catch {
        return;
      }

      const rawText = normalizeSpace(card.innerText || card.textContent || '');
      if (!rawText || rawText.length < 6 || rawText.length > 650) return;

      const pr = extractPricePairFromText(rawText);
      if (!pr) return;

      const titleEl = card.querySelector(
        '.ProductCard__link, [class*="ProductCard__title"], [class*="product-card__title"], [data-testid*="title"], [class*="Title"], [class*="Name"], h2, h3, h4, img[alt]'
      );
      const rawTitle = titleEl
        ? (titleEl.tagName === 'IMG'
            ? titleEl.getAttribute('alt')
            : (titleEl.getAttribute('title') || titleEl.textContent))
        : (linkEl.getAttribute('title') || linkEl.textContent || '');
      const title = cleanCardTitle(rawTitle, rawText);
      if (!title || title.length < 4) return;

      const dedupKey = `${storeName}|${title.toLowerCase()}|${pr.price}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);

      offers.push({
        store: storeName,
        goodId: null,
        title,
        amount: extractWeightFromText(`${title} ${rawText}`),
        price: pr.price,
        oldPrice: pr.oldPrice,
        url: fullUrl
      });
    });

    // Product detail page fallback (h1 + JSON-LD)
    if (offers.length === 0) {
      const ldOffers = parseJsonLdOffers(doc, storeName, winLoc.href);
      for (const o of ldOffers) {
        const k = `${o.store}|${o.title.toLowerCase()}|${o.price}`;
        if (!seen.has(k)) {
          seen.add(k);
          offers.push(o);
        }
      }
    }

    if (offers.length === 0 && /\/(product|goods|cat)\//i.test(winLoc.pathname)) {
      const h1 = doc.querySelector('h1');
      const pageTitle = h1 ? normalizeSpace(h1.textContent || '') : '';
      const mainScope = doc.querySelector('main') || doc.body;
      const pr = extractPricePairFromText((mainScope?.innerText || '').slice(0, 2200));
      if (pageTitle && pageTitle.length >= 4 && pr) {
        offers.push({
          store: storeName,
          goodId: null,
          title: pageTitle,
          amount: extractWeightFromText(pageTitle),
          price: pr.price,
          oldPrice: pr.oldPrice,
          url: winLoc.href
        });
      }
    }

    return offers;
  }

  function parseOffersFromDocument(doc, winLoc) {
    const storeInfo = detectStoreFromHost(winLoc.hostname);
    if (!storeInfo) return { store: null, offers: [] };

    let offers = [];
    if (storeInfo.id === 'magnit') {
      offers = parseMagnitOffers(doc, winLoc);
    } else if (storeInfo.id === 'kuper') {
      offers = parseKuperOffers(doc, winLoc);
    } else {
      offers = parseGenericRetailerOffers(doc, winLoc, storeInfo);
    }

    return { store: storeInfo.store, offers: offers.slice(0, 80) };
  }

  function showHarvesterToast(storeLabel, count, totalInDb) {
    try {
      let badge = document.querySelector('#lqs-store-harvester-pill');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'lqs-store-harvester-pill';
        badge.style.cssText =
          'position:fixed;bottom:14px;right:14px;z-index:999999;background:#21201f;color:#fce000;border:1px solid #3a3835;padding:7px 12px;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;font-weight:700;box-shadow:0 6px 18px rgba(0,0,0,0.22);pointer-events:none;';
        document.body.appendChild(badge);
      }
      badge.textContent = `🛡️ Lavka Shield: собрано ${count} цен (${storeLabel}, всего в базе: ${totalInDb || count})`;
    } catch {
      // ignore DOM errors
    }
  }

  function initStoreHarvesterIfNeeded() {
    if (typeof window === 'undefined' || !window.location) return false;
    const storeInfo = detectStoreFromHost(window.location.hostname);
    if (!storeInfo) return false;

    let lastHarvestHash = '';

    const runHarvest = (silent = false) => {
      const { store, offers } = parseOffersFromDocument(document, window.location);
      if (!offers || offers.length === 0) return { store: store || storeInfo.store, offers: [] };

      const hash = offers.map((o) => `${o.store}:${o.title}:${o.price}`).join('|');
      if (!silent && hash === lastHarvestHash) {
        return { store: store || storeInfo.store, offers };
      }
      lastHarvestHash = hash;

      if (!silent && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          { type: 'LQS_RECORD_EXTERNAL_STORE_OFFERS', store: store || storeInfo.store, offers },
          (resp) => {
            if (chrome.runtime.lastError || !resp) return;
            const uniqueStores = Array.from(new Set(offers.map((o) => o.store).filter(Boolean)));
            const label = uniqueStores.length > 2
              ? `${uniqueStores.slice(0, 2).join(', ')} +${uniqueStores.length - 2}`
              : (uniqueStores.join(', ') || storeInfo.store);
            showHarvesterToast(label, offers.length, resp.totalExternalOffers);
          }
        );
      }
      return { store: store || storeInfo.store, offers };
    };

    // On-demand harvesting for 1-click background tab radar (works even when tab is hidden)
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.type !== 'LQS_HARVEST_STORE_PAGE_NOW') return false;
        const result = runHarvest(true);
        sendResponse({ ok: true, store: result.store, offers: result.offers });
        return true;
      });
    }

    // Passive harvesting when user actively browses the store
    setTimeout(() => {
      if (!document.hidden) runHarvest(false);
    }, 1000);

    setInterval(() => {
      if (document.hidden) return;
      runHarvest(false);
    }, 3000);

    return true;
  }

  const api = {
    SUPPORTED_STORES,
    detectStoreFromHost,
    detectKuperRetailer,
    extractWeightFromText,
    extractPricePairFromText,
    parseOffersFromDocument,
    initStoreHarvesterIfNeeded,
    initMagnitStoreHarvesterIfNeeded: initStoreHarvesterIfNeeded
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_STORE_HARVESTER = api;
  root.LQS_MAGNIT_PARSER = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
