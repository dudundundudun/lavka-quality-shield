/**
 * Lavka Quality Shield — Native Magnit.ru Price Harvester (content/magnit-parser.js)
 * Extracts catalog, cart, and product-page prices on magnit.ru with hidden-tab pause.
 */
(function (root) {
  'use strict';

  function initMagnitStoreHarvesterIfNeeded() {
    const host = window.location.hostname.toLowerCase();
    if (!host.includes('magnit.ru')) return false;

    let lastHarvestHash = '';

    const parseMagnitPageOffers = () => {
      const offers = [];
      const seen = new Set();

      // 1. Карточки каталога и поиска: article.unit-catalog-product-preview / a.pl-hover-base[href*="/product/"]
      const catalogCards = document.querySelectorAll('article.unit-catalog-product-preview, a.pl-hover-base[href*="/product/"]');
      catalogCards.forEach((node) => {
        const card = node.tagName === 'ARTICLE' ? node : (node.closest('article.unit-catalog-product-preview') || node);
        const linkEl = card.tagName === 'A' ? card : card.querySelector('a.pl-hover-base[href*="/product/"], a[href*="/product/"]');
        if (!linkEl) return;
        const href = linkEl.getAttribute('href') || '';
        if (!href.includes('/product/')) return;
        const fullUrl = new URL(href, window.location.origin).href;
        if (seen.has(fullUrl)) return;

        const imgEl = card.querySelector('div.unit-catalog-product-preview-image img[alt], img[alt]');
        const imgAlt = imgEl ? (imgEl.getAttribute('alt') || '').trim() : '';
        const rawText = (card.innerText || linkEl.innerText || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();

        const priceMatches = Array.from(rawText.matchAll(/(\d+(?:[.,]\d{1,2})?)\s*₽/g)).map((m) =>
          parseFloat(m[1].replace(',', '.'))
        );
        if (priceMatches.length === 0) return;

        const price = Math.round(priceMatches[0]);
        const oldPrice = priceMatches.length > 1 && priceMatches[1] > priceMatches[0] ? Math.round(priceMatches[1]) : null;
        const title = imgAlt && imgAlt.length > 4 ? imgAlt : rawText.replace(/^.*?₽\s*(?:-\d+%\s*\d+(?:[.,]\d+)?\s*₽\s*)?/i, '').trim();
        if (!title || title.length < 3 || price <= 0) return;

        const idMatch = href.match(/\/product\/(\d+)/);
        const weightMatch = title.match(/(\d+(?:[.,]\d+)?\s*(?:г|гр|кг|мл|л|шт)(?![а-яa-z]))/i);

        seen.add(fullUrl);
        offers.push({
          store: 'Магнит',
          goodId: idMatch ? idMatch[1] : null,
          title,
          amount: weightMatch ? weightMatch[1] : '',
          price,
          oldPrice,
          url: fullUrl
        });
      });

      // 2. Позиции корзины Магнита (/ecom/cart): a.cart-product-list-item-wrap-content[href*="/product/"]
      const cartLinks = document.querySelectorAll('a.cart-product-list-item-wrap-content[href*="/product/"]');
      cartLinks.forEach((linkEl) => {
        const href = linkEl.getAttribute('href') || '';
        const fullUrl = new URL(href, window.location.origin).href;
        if (seen.has(fullUrl)) return;

        const row = linkEl.closest('div.cart-product-item') || linkEl.parentElement;
        const imgEl = row ? row.querySelector('div.cart-product-item__left img[alt], img[alt]') : null;
        const imgAlt = imgEl ? (imgEl.getAttribute('alt') || '').trim() : '';
        const rawText = ((row || linkEl).innerText || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();

        const priceMatches = Array.from(rawText.matchAll(/(\d+(?:[.,]\d{1,2})?)\s*₽/g)).map((m) =>
          parseFloat(m[1].replace(',', '.'))
        );
        if (priceMatches.length === 0) return;

        const price = Math.round(priceMatches[0]);
        const oldPrice = priceMatches.length > 1 && priceMatches[1] > priceMatches[0] ? Math.round(priceMatches[1]) : null;
        const title = imgAlt && imgAlt.length > 4 ? imgAlt : rawText.split(/Финальная цена|\d+\s*₽/)[0].trim();
        if (!title || title.length < 3 || price <= 0) return;

        const idMatch = href.match(/\/product\/(\d+)/);
        const weightMatch = title.match(/(\d+(?:[.,]\d+)?\s*(?:г|гр|кг|мл|л|шт)(?![а-яa-z]))/i);

        seen.add(fullUrl);
        offers.push({
          store: 'Магнит',
          goodId: idMatch ? idMatch[1] : null,
          title,
          amount: weightMatch ? weightMatch[1] : '',
          price,
          oldPrice,
          url: fullUrl
        });
      });

      // 3. Страница самой карточки товара на magnit.ru (/product/...)
      if (window.location.pathname.includes('/product/')) {
        const h1 = document.querySelector('h1');
        const pageTitle = h1 ? (h1.textContent || '').trim() : document.title.split('—')[0].trim();
        const mainScope = document.querySelector('main') || document.body;
        const priceMatches = Array.from((mainScope.innerText || '').slice(0, 2000).matchAll(/(\d+(?:[.,]\d{1,2})?)\s*₽/g)).map((m) =>
          parseFloat(m[1].replace(',', '.'))
        );
        if (pageTitle && priceMatches.length > 0 && !seen.has(window.location.href)) {
          const idMatch = window.location.pathname.match(/\/product\/(\d+)/);
          const weightMatch = pageTitle.match(/(\d+(?:[.,]\d+)?\s*(?:г|гр|кг|мл|л|шт)(?![а-яa-z]))/i);
          offers.push({
            store: 'Магнит',
            goodId: idMatch ? idMatch[1] : null,
            title: pageTitle,
            amount: weightMatch ? weightMatch[1] : '',
            price: Math.round(priceMatches[0]),
            oldPrice: priceMatches.length > 1 && priceMatches[1] > priceMatches[0] ? Math.round(priceMatches[1]) : null,
            url: window.location.href
          });
        }
      }

      if (offers.length === 0) return;
      const hash = offers.map((o) => `${o.goodId || o.title}:${o.price}`).join('|');
      if (hash === lastHarvestHash) return;
      lastHarvestHash = hash;

      chrome.runtime.sendMessage({ type: 'LQS_RECORD_EXTERNAL_STORE_OFFERS', store: 'Магнит', offers }, (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        let badge = document.querySelector('#lqs-magnit-harvester-pill');
        if (!badge) {
          badge = document.createElement('div');
          badge.id = 'lqs-magnit-harvester-pill';
          badge.style.cssText =
            'position:fixed;bottom:14px;right:14px;z-index:999999;background:#166534;color:#ffffff;padding:7px 12px;border-radius:10px;font-family:sans-serif;font-size:12px;font-weight:700;box-shadow:0 4px 12px rgba(0,0,0,0.2);pointer-events:none;';
          document.body.appendChild(badge);
        }
        badge.textContent = `🛡️ Lavka Shield: собрано ${offers.length} цен Магнита (всего в базе: ${resp.totalExternalOffers || offers.length})`;
      });
    };

    setTimeout(parseMagnitPageOffers, 800);
    setInterval(() => {
      if (document.hidden) return;
      parseMagnitPageOffers();
    }, 2800);
    return true;
  }

  const api = {
    initMagnitStoreHarvesterIfNeeded
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_MAGNIT_PARSER = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
