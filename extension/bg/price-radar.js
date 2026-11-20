/**
 * Lavka Quality Shield — Price Radar, 16-Store Matrix, Lavka Card Parser & Circuit Breaker
 * Модуль радара цен, истории цен, парсера карточки Лавки, внешних цен 16 сетей и circuit breaker.
 */
(function (root) {
  'use strict';

  function getBgDeps() {
    return root.LQS_BG_DEPS || {};
  }

  const {
    normalizeTitleKey,
    isSearchResultMatchingProduct,
    decodeHtmlEntities
  } = root.LQS_MATCHER;

  const { STORAGE_KEYS, LIMITS } = root.LQS_CONFIG;
  const {
    fetchWithTimeout,
    getSettings,
    buildFullProductSearchQuery,
    buildDirectStoreSearchLinks
  } = root.LQS_UTILS;

  const PRICE_DB_KEY = STORAGE_KEYS.PRICE_DB;
  const WATCHLIST_KEY = STORAGE_KEYS.WATCHLIST;
  const EXT_STORE_DB_KEY = STORAGE_KEYS.EXT_STORE_DB;
  const CIRCUIT_BREAKER_KEY = STORAGE_KEYS.CIRCUIT_BREAKER || 'lqs_circuit_breaker_v1';
  const MAX_LOCAL_PRICE_DB_ITEMS = LIMITS.MAX_LOCAL_PRICE_DB_ITEMS;

  // Ленивая подгрузка эталонных seed-офферов Магнита из extension/data/seed-magnit.json
  let magnitSeedCache = null;

  async function getMagnitSeedOffers() {
    if (Array.isArray(magnitSeedCache)) return magnitSeedCache;
    try {
      const url = chrome.runtime.getURL('data/seed-magnit.json');
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        const seededAt = data?.seededAt || '';
        const raw = Array.isArray(data?.offers) ? data.offers : [];
        magnitSeedCache = raw.map((o) => ({ ...o, isSeedFallback: true, seededAt }));
        return magnitSeedCache;
      }
    } catch {
      // ignore
    }
    magnitSeedCache = [];
    return magnitSeedCache;
  }

  // Per-provider / per-store Circuit Breaker (3 подряд ошибки или капча -> пауза 15 минут)
  const CIRCUIT_BREAKER_THRESHOLD = 3;
  const CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60 * 1000;
  const RADAR_16_STORES_CATALOG = [
    { name: 'Магнит', provider: 'magnit_dom', mode: 'DOM + Seed' },
    { name: 'ВкусВилл', provider: 'vkusvill', mode: 'Прямой + DDG' },
    { name: 'Пятёрочка', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Перекрёсток', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Ашан', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'МЕТРО', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Глобус', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Лента', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Магнолия', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Дикси', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Чижик', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'О’КЕЙ', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Азбука Вкуса', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Самокат', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Ozon', provider: 'duckduckgo', mode: 'DDG Радар' },
    { name: 'Купер', provider: 'duckduckgo', mode: 'DDG Радар' }
  ];

  async function getCircuitBreakerState() {
    return new Promise((resolve) => {
      chrome.storage.local.get([CIRCUIT_BREAKER_KEY], (res) => {
        resolve(res && res[CIRCUIT_BREAKER_KEY] && typeof res[CIRCUIT_BREAKER_KEY] === 'object' ? { ...res[CIRCUIT_BREAKER_KEY] } : {});
      });
    });
  }

  async function saveCircuitBreakerState(state) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [CIRCUIT_BREAKER_KEY]: state }, () => resolve(state));
    });
  }

  function isCaptchaOrBlockHtml(html) {
    if (!html || typeof html !== 'string') return false;
    return /(captcha|showcaptcha|smartcaptcha|ddos-guard|cloudflare|anomaly-modal|are you a robot|вы не робот|подозрительный трафик)/i.test(
      html.slice(0, 6000)
    );
  }

  async function isCircuitOpen(providerKey) {
    const state = await getCircuitBreakerState();
    const entry = state[providerKey];
    if (!entry || !entry.openUntil) return false;
    if (Date.now() < entry.openUntil) return true;
    // Cooldown expired -> half-open reset
    entry.openUntil = 0;
    entry.failures = 0;
    state[providerKey] = entry;
    await saveCircuitBreakerState(state);
    return false;
  }

  async function recordCircuitSuccess(providerKey) {
    const state = await getCircuitBreakerState();
    state[providerKey] = {
      failures: 0,
      openUntil: 0,
      lastReason: '',
      lastOkAt: new Date().toISOString()
    };
    await saveCircuitBreakerState(state);
  }

  async function recordCircuitFailure(providerKey, reason = 'error', immediateOpen = false) {
    const state = await getCircuitBreakerState();
    const prev = state[providerKey] || { failures: 0, openUntil: 0, lastOkAt: null };
    const failures = immediateOpen ? CIRCUIT_BREAKER_THRESHOLD : (Number(prev.failures || 0) + 1);
    const openUntil = failures >= CIRCUIT_BREAKER_THRESHOLD ? Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS : 0;
    state[providerKey] = {
      ...prev,
      failures,
      openUntil,
      lastReason: String(reason || 'error').slice(0, 80),
      lastFailAt: new Date().toISOString()
    };
    await saveCircuitBreakerState(state);
  }

  async function resetCircuitBreakers() {
    await saveCircuitBreakerState({});
    return await getRadar16StoresStatus();
  }

  async function getRadar16StoresStatus() {
    const cb = await getCircuitBreakerState();
    const extOffers = await getExternalStoreOffersList();
    const now = Date.now();

    const liveCountsByStore = {};
    for (const o of extOffers) {
      if (!o || !o.store || o.isSeedFallback) continue;
      liveCountsByStore[o.store] = (liveCountsByStore[o.store] || 0) + 1;
    }

    const formatProvider = (key, label) => {
      const e = cb[key] || { failures: 0, openUntil: 0, lastOkAt: null, lastReason: '' };
      const pausedMs = e.openUntil && e.openUntil > now ? e.openUntil - now : 0;
      return {
        key,
        label,
        status: pausedMs > 0 ? 'PAUSED' : (e.failures > 0 ? 'WARN' : 'OK'),
        failures: Number(e.failures || 0),
        pausedMin: pausedMs > 0 ? Math.ceil(pausedMs / 60000) : 0,
        lastReason: e.lastReason || '',
        lastOkAt: e.lastOkAt || null
      };
    };

    const providers = [
      formatProvider('duckduckgo', 'DuckDuckGo (14 сетей)'),
      formatProvider('vkusvill', 'ВкусВилл (прямой)'),
      formatProvider('magnit_dom', 'Магнит (DOM-парсер)')
    ];
    const provMap = Object.fromEntries(providers.map((p) => [p.key, p]));

    const stores = RADAR_16_STORES_CATALOG.map((s) => {
      const p = provMap[s.provider] || { status: 'OK', pausedMin: 0 };
      return {
        name: s.name,
        mode: s.mode,
        provider: s.provider,
        status: p.status,
        pausedMin: p.pausedMin,
        cachedOffers: liveCountsByStore[s.name] || 0
      };
    });

    return {
      ok: true,
      activeKeepAliveTasks: getBgDeps().getSwKeepAliveActiveTasks ? getBgDeps().getSwKeepAliveActiveTasks() : 0,
      providers,
      stores
    };
  }

  async function getLocalPriceDb() {
    return new Promise((resolve) => {
      chrome.storage.local.get([PRICE_DB_KEY], (res) => {
        resolve(res && res[PRICE_DB_KEY] && typeof res[PRICE_DB_KEY] === 'object' ? res[PRICE_DB_KEY] : {});
      });
    });
  }

  function findPriceEntryInDb(db, slug, title, imageKey = null) {
    if (!db) return null;
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (cleanSlug && db[cleanSlug]) return db[cleanSlug];
    if (imageKey) {
      const byImg = Object.values(db).find((e) => e && e.imageKey && e.imageKey === imageKey);
      if (byImg) return byImg;
    }
    const normTitle = normalizeTitleKey(title);
    if (normTitle && normTitle.length >= 4) {
      return Object.values(db).find((e) => e && normalizeTitleKey(e.title) === normTitle) || null;
    }
    return null;
  }

  function sanitizeCompetitorOffersForProduct(offers, productTitle, productAmount = '') {
    if (!Array.isArray(offers) || offers.length === 0) return [];
    if (!productTitle) return offers;
    return offers.filter((o) => {
      if (!o) return false;
      const check = isSearchResultMatchingProduct(o.title || '', '', productTitle, productAmount);
      return check.isSameProduct && check.isSameVolume;
    });
  }

  function mergePriceRecordIntoEntry(existing, item, accountId, nowIso) {
    const slug = String(item.slug || '').trim().toLowerCase();
    const acc = String(accountId || 'Аккаунт #1').trim();
    const price = Number(item.price) || 0;
    const oldPrice = item.oldPrice ? Number(item.oldPrice) : null;
    const imageKey = item.imageKey || existing?.imageKey || null;

    // ЗАЩИТА ОТ УРЕЗАННЫХ НАЗВАНИЙ ИЗ КОРЗИНЫ:
    // Если в базе уже сохранено эталонное полное название из оригинальной карточки товара (`isCanonicalCardTitle: true`),
    // то короткое название из корзины (`isCanonicalCardTitle !== true`) НИКОГДА не перезаписывает его!
    let effectiveTitle = existing?.title || item.title || slug;
    let isCanonicalCardTitle = Boolean(existing?.isCanonicalCardTitle || item.isCanonicalCardTitle);

    if (item.title) {
      if (item.isCanonicalCardTitle) {
        effectiveTitle = item.title;
        isCanonicalCardTitle = true;
      } else if (!existing?.title) {
        effectiveTitle = item.title;
      } else if (!existing?.isCanonicalCardTitle && String(item.title).length > String(existing.title).length) {
        effectiveTitle = item.title;
      }
    }

    const effectiveAmount =
      (item.isCanonicalCardTitle && item.amount) ? item.amount : (existing?.amount || item.amount || '');
    const effectiveBrand = item.brand || existing?.brand || '';

    const rawOffers =
      Array.isArray(item.competitorOffers) && item.competitorOffers.length > 0
        ? item.competitorOffers
        : (Array.isArray(existing?.competitorOffers) ? existing.competitorOffers : []);
    const compOffers = sanitizeCompetitorOffersForProduct(rawOffers, effectiveTitle, effectiveAmount);

    let compMin = item.competitorMinPrice ? Number(item.competitorMinPrice) : null;
    let compSum = item.competitorSummary || null;
    if (!compMin && compOffers.length > 0) {
      const priced = compOffers.filter((o) => o.price && o.price > 0);
      if (priced.length > 0) {
        compMin = Math.min(...priced.map((o) => o.price));
        compSum = priced.slice(0, 3).map((o) => `${o.store}: ~${o.price} ₽`).join(', ');
      }
    }

    const entry = existing || {
      slug,
      title: effectiveTitle,
      cleanTitle: normalizeTitleKey(effectiveTitle),
      isCanonicalCardTitle,
      brand: effectiveBrand,
      imageKey,
      amount: effectiveAmount,
      minPrice: price,
      maxPrice: price,
      avgPrice: price,
      lastPrice: price,
      competitorMinPrice: null,
      competitorSummary: null,
      competitorOffers: [],
      accounts: {},
      history: [],
      updatedAt: nowIso
    };

    entry.title = effectiveTitle;
    entry.cleanTitle = normalizeTitleKey(effectiveTitle);
    entry.isCanonicalCardTitle = isCanonicalCardTitle;
    if (effectiveBrand) entry.brand = effectiveBrand;
    if (imageKey) entry.imageKey = imageKey;
    if (effectiveAmount) entry.amount = effectiveAmount;

    if (entry.accounts && entry.accounts['Гость (без куки)']) {
      delete entry.accounts['Гость (без куки)'];
    }
    if ('guestPrice' in entry) delete entry.guestPrice;
    entry.competitorMinPrice = compMin && compMin > 0 ? Math.round(compMin) : null;
    entry.competitorSummary = compSum || null;
    entry.competitorOffers = compOffers;

    if (price > 0) {
      const rounded = Math.round(price);
      entry.lastPrice = rounded;
      entry.accounts[acc] = {
        price: rounded,
        oldPrice: oldPrice ? Math.round(oldPrice) : null,
        updatedAt: nowIso
      };
      const lastHist = entry.history[0];
      const nowDay = String(nowIso || '').slice(0, 10);
      const lastDay = lastHist && lastHist.ts ? String(lastHist.ts).slice(0, 10) : '';
      if (!lastHist || lastHist.price !== rounded || lastHist.accountId !== acc || lastDay !== nowDay) {
        entry.history.unshift({
          price: rounded,
          oldPrice: oldPrice ? Math.round(oldPrice) : null,
          accountId: acc,
          ts: nowIso
        });
        if (entry.history.length > 120) entry.history.length = 120;
      }
    }

    const allPrices = [];
    entry.history.forEach((h) => {
      if (h && h.price > 0) allPrices.push(Number(h.price));
    });
    Object.values(entry.accounts || {}).forEach((a) => {
      if (a && a.price > 0) allPrices.push(Number(a.price));
    });

    if (allPrices.length > 0) {
      entry.minPrice = Math.round(Math.min(...allPrices));
      entry.maxPrice = Math.round(Math.max(...allPrices));
      entry.avgPrice = Math.round(allPrices.reduce((s, v) => s + v, 0) / allPrices.length);
    }
    entry.updatedAt = nowIso;
    return entry;
  }

  async function recordPricesBatch(accountId, items) {
    if (!Array.isArray(items) || items.length === 0) return {};
    const settings = await getSettings();
    const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1';
    const db = await getLocalPriceDb();
    const nowIso = new Date().toISOString();
    const updatedSummaries = {};

    for (const rawItem of items) {
      if (!rawItem || !rawItem.slug) continue;
      const slug = String(rawItem.slug).trim().toLowerCase();
      const existing = findPriceEntryInDb(db, slug, rawItem.title, rawItem.imageKey);
      const merged = mergePriceRecordIntoEntry(existing, rawItem, acc, nowIso);
      merged.slug = slug;
      db[slug] = merged;
      updatedSummaries[slug] = merged;

      // Синхронизируем парные записи (SEO-slug <-> HEX-ID) по imageKey или по полному совпадению названия
      const normTitle = normalizeTitleKey(merged.title);
      for (const [k, v] of Object.entries(db)) {
        if (k === slug || !v) continue;
        const sameImg = merged.imageKey && v.imageKey && merged.imageKey === v.imageKey;
        const sameTitle = normTitle && normTitle.length >= 4 && normalizeTitleKey(v.title) === normTitle;
        if (sameImg || sameTitle) {
          db[k] = { ...merged, slug: k };
        }
      }
    }

    const keys = Object.keys(db);
    if (keys.length > MAX_LOCAL_PRICE_DB_ITEMS) {
      keys
        .sort((a, b) => String(db[a]?.updatedAt || '').localeCompare(String(db[b]?.updatedAt || '')))
        .slice(0, keys.length - MAX_LOCAL_PRICE_DB_ITEMS)
        .forEach((k) => delete db[k]);
    }

    await new Promise((resolve) => {
      chrome.storage.local.set({ [PRICE_DB_KEY]: db }, resolve);
    });

    const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
    if (backendUrl && Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
      try {
        const resp = await fetchWithTimeout(
          `${backendUrl}/api/price/record`,
          {
            method: 'POST',
            headers: await getBgDeps().getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ accountId: acc, items })
          },
          1800
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.summaries) {
            for (const [sKey, sVal] of Object.entries(data.summaries)) {
              const cur = db[sKey];
              // Сохраняем эталонное название из карточки товара!
              const bestTitle = cur?.isCanonicalCardTitle ? cur.title : (sVal.title || cur?.title);
              db[sKey] = {
                ...cur,
                ...sVal,
                title: bestTitle,
                isCanonicalCardTitle: Boolean(cur?.isCanonicalCardTitle)
              };
              updatedSummaries[sKey] = db[sKey];
            }
            chrome.storage.local.set({ [PRICE_DB_KEY]: db });
          }
        }
      } catch {
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }

    return updatedSummaries;
  }

  function parsePriceFromLavkaHtml(html) {
    if (!html) return null;
    const mTestId = html.match(/data-testid="price-text"[^>]*>([\d\s,.]+)</i);
    if (mTestId) {
      const val = parseFloat(mTestId[1].replace(/[^\d.,]/g, '').replace(',', '.'));
      if (val > 0) return Math.round(val);
    }
    const mLd = html.match(/"@type"\s*:\s*"Offer"[\s\S]{0,250}?"price"\s*:\s*"?([\d.]+)"?/i);
    if (mLd) {
      const val = parseFloat(mLd[1]);
      if (val > 0) return Math.round(val);
    }
    const mState = html.match(/"pricing"\s*:\s*\{[^}]*"price"\s*:\s*(\d+(?:\.\d+)?)/i);
    if (mState) {
      const val = parseFloat(mState[1]);
      if (val > 0) return Math.round(val);
    }
    return null;
  }

  /**
   * Извлекает ПОЛНОЕ ОРИГИНАЛЬНОЕ НАЗВАНИЕ, фасовку, бренд, картинку и цену
   * напрямую из HTML оригинальной карточки товара (`https://lavka.yandex.ru/good/<slug>`).
   */
  function parseFullProductCardFromLavkaHtml(html) {
    if (!html) return null;
    const price = parsePriceFromLavkaHtml(html);

    let cardTitle = '';
    let cardAmount = '';
    let cardBrand = '';
    let imageKey = null;

    // 1. Заголовок <h1 data-testid="product-title">...</h1>
    const h1Match = html.match(/<h1[^>]*data-testid="product-title"[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) {
      cardTitle = decodeHtmlEntities(h1Match[1]).replace(/[\u00ad\u200b]/g, '').trim();
    }

    // 2. Фасовка <span data-testid="product-amount">...</span>
    const amtMatch = html.match(/<span[^>]*data-testid="product-amount"[^>]*>([\s\S]*?)<\/span>/i);
    if (amtMatch) {
      cardAmount = decodeHtmlEntities(amtMatch[1]).replace(/[\u00ad\u200b\u00a0]/g, ' ').trim();
    }

    // 3. JSON-LD схема Product (содержит полное название, бренд и описание)
    const ldMatches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    for (const m of ldMatches) {
      try {
        const parsed = JSON.parse(m[1]);
        const graph = parsed['@graph'] || [parsed];
        const prod = graph.find((it) => it && it['@type'] === 'Product');
        if (prod) {
          if (!cardTitle && prod.name) {
            cardTitle = String(prod.name).replace(/[\u00ad\u200b]/g, '').trim();
          }
          if (prod.brand) {
            cardBrand = typeof prod.brand === 'string' ? prod.brand : (prod.brand.name || '');
          }
        }
      } catch {
        // ignore
      }
    }

    // 4. Fallback на <title>, если h1 и JSON-LD не сработали
    if (!cardTitle) {
      const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleTagMatch) {
        const rawT = decodeHtmlEntities(titleTagMatch[1]);
        const splitT = rawT.split(/\s*[—–|]\s*купить|\s*[—–|]\s*Яндекс/i)[0].trim();
        if (splitT && splitT.length > 3) {
          cardTitle = splitT;
        }
      }
    }

    // 5. Ключ изображения (get-grocery-goods/...)
    const imgMatch = html.match(/get-grocery-goods\/(\d+\/[a-f0-9-]+)/i);
    if (imgMatch) {
      imageKey = imgMatch[1].toLowerCase();
    }

    return {
      price,
      cardTitle,
      cardAmount,
      cardBrand,
      imageKey
    };
  }

  /**
   * Запрашивает оригинальную карточку товара `https://lavka.yandex.ru/good/<slug>`
   * строго с реальной сессией пользователя (`credentials: 'include'`) и возвращает
   * актуальную цену, ПОЛНОЕ название и характеристики из карточки товара.
   */
  async function probeProductCardMeta(slug, fallbackTitle = '', currentPrice = null, accountId = null, fallbackAmount = '', fallbackImageKey = null) {
    if (!slug) return null;
    const cleanSlug = String(slug).trim().toLowerCase();
    const url = `https://lavka.yandex.ru/good/${encodeURIComponent(cleanSlug)}`;

    let parsedCard = null;
    try {
      const respAuth = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            'Accept-Language': 'ru-RU,ru;q=0.9'
          }
        },
        4200
      );
      if (respAuth.ok) {
        const htmlAuth = await respAuth.text();
        if (!isCaptchaOrBlockHtml(htmlAuth)) {
          parsedCard = parseFullProductCardFromLavkaHtml(htmlAuth);
        }
      }
    } catch {
      // ignore
    }

    const canonicalTitle = parsedCard?.cardTitle
      ? buildFullProductSearchQuery(parsedCard.cardTitle, parsedCard.cardBrand || '', parsedCard.cardAmount || fallbackAmount)
      : fallbackTitle;
    const canonicalAmount = parsedCard?.cardAmount || fallbackAmount || '';
    const canonicalBrand = parsedCard?.cardBrand || '';
    const canonicalImageKey = parsedCard?.imageKey || fallbackImageKey || null;
    const hasCanonicalTitle = Boolean(parsedCard?.cardTitle);
    const effectivePrice = currentPrice || (parsedCard && parsedCard.price > 0 ? parsedCard.price : 0);

    if (hasCanonicalTitle || effectivePrice > 0) {
      const summaries = await recordPricesBatch(accountId, [
        {
          slug: cleanSlug,
          title: canonicalTitle || cleanSlug,
          isCanonicalCardTitle: hasCanonicalTitle,
          brand: canonicalBrand,
          imageKey: canonicalImageKey,
          amount: canonicalAmount,
          price: effectivePrice
        }
      ]);
      return summaries[cleanSlug] || {
        slug: cleanSlug,
        title: canonicalTitle,
        isCanonicalCardTitle: hasCanonicalTitle,
        brand: canonicalBrand,
        imageKey: canonicalImageKey,
        amount: canonicalAmount,
        lastPrice: effectivePrice || null
      };
    }
    return null;
  }

  async function getProductPriceIntelligence(slug, title = '', currentPrice = null, oldPrice = null, amount = '', accountId = null, isFromProductCard = false, imageKey = null, brand = '') {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!cleanSlug) return null;
    const settings = await getSettings();
    const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1';

    const fullCardTitle = isFromProductCard ? buildFullProductSearchQuery(title, brand, amount) : title;

    if (currentPrice && currentPrice > 0) {
      await recordPricesBatch(acc, [
        {
          slug: cleanSlug,
          title: fullCardTitle,
          isCanonicalCardTitle: Boolean(isFromProductCard && title),
          brand: brand || '',
          imageKey: imageKey || null,
          price: currentPrice,
          oldPrice,
          amount
        }
      ]);
    }

    const db = await getLocalPriceDb();
    let summary = findPriceEntryInDb(db, cleanSlug, fullCardTitle, imageKey);

    const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
    if (backendUrl && Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
      try {
        const qTitle = fullCardTitle ? `?title=${encodeURIComponent(fullCardTitle)}` : '';
        const r = await fetchWithTimeout(
          `${backendUrl}/api/price/product/${encodeURIComponent(cleanSlug)}${qTitle}`,
          { method: 'GET', headers: await getBgDeps().getBackendAuthHeaders(backendUrl) },
          1000
        );
        if (r.ok) {
          const j = await r.json();
          if (j && j.status === 'ok' && j.summary) {
            const keepCanonicalTitle = summary?.isCanonicalCardTitle ? summary.title : (fullCardTitle || j.summary.title);
            summary = {
              ...(summary || {}),
              ...j.summary,
              title: keepCanonicalTitle,
              isCanonicalCardTitle: Boolean(summary?.isCanonicalCardTitle || isFromProductCard),
              accounts: { ...(summary?.accounts || {}), ...(j.summary.accounts || {}) }
            };
            db[cleanSlug] = summary;
            chrome.storage.local.set({ [PRICE_DB_KEY]: db });
          }
        }
      } catch {
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }

    if (!summary || !summary.isCanonicalCardTitle) {
      const probed = await probeProductCardMeta(
        cleanSlug,
        fullCardTitle,
        currentPrice,
        acc,
        amount,
        imageKey
      );
      if (probed) {
        summary = { ...(summary || {}), ...probed };
      }
    }

    if (summary) {
      const authoritativeTitle = summary.title || fullCardTitle || '';
      const authoritativeAmount = summary.amount || amount || '';
      const authoritativeBrand = summary.brand || brand || '';
      const extList = await getExternalStoreOffersList();
      const matchedExt = findMatchingExternalStoreOffersFromList(extList, authoritativeTitle, authoritativeAmount);

      let combinedOffers = mergeUniqueStoreOffers(summary.competitorOffers || [], matchedExt);
      combinedOffers = sanitizeCompetitorOffersForProduct(
        combinedOffers,
        authoritativeTitle,
        authoritativeAmount
      );

      // Если в базе ещё нет цен других магазинов для этого товара, запускаем прямой экспресс-парсинг ВкусВилла и мульти-поиска сетей
      if (combinedOffers.filter((o) => o.price && o.price > 0).length < 2 && authoritativeTitle) {
        try {
          const directStoreOffers = await getBgDeps().probeDirectRetailStoresForProduct(authoritativeTitle, authoritativeBrand, authoritativeAmount, currentPrice);
          if (directStoreOffers.length > 0) {
            combinedOffers = mergeUniqueStoreOffers(combinedOffers, directStoreOffers);
            combinedOffers = sanitizeCompetitorOffersForProduct(combinedOffers, authoritativeTitle, authoritativeAmount);
          }
        } catch {
          // ignore
        }
      }

      summary.competitorOffers = combinedOffers;
      const priced = combinedOffers.filter((o) => o.price && o.price > 0);
      if (priced.length > 0) {
        summary.competitorMinPrice = Math.min(...priced.map((o) => o.price));
        summary.competitorSummary = priced.slice(0, 4).map((o) => `${o.store}: ${o.price} ₽`).join(', ');
      }
      summary.storeSearchLinks = buildDirectStoreSearchLinks(
        authoritativeTitle,
        authoritativeAmount,
        authoritativeBrand
      );

      // Сохраняем обогащённую сводку в локальную БД
      const latestDb = await getLocalPriceDb();
      latestDb[cleanSlug] = summary;
      chrome.storage.local.set({ [PRICE_DB_KEY]: latestDb });
    }

    return summary;
  }

  async function getExternalStoreOffersList() {
    const seedOffers = await getMagnitSeedOffers();
    return new Promise((resolve) => {
      chrome.storage.local.get([EXT_STORE_DB_KEY], (res) => {
        const saved = res && Array.isArray(res[EXT_STORE_DB_KEY]) ? res[EXT_STORE_DB_KEY] : [];
        const combined = [...saved];
        const seenUrls = new Set(combined.map((o) => o.url));
        for (const seed of seedOffers) {
          if (!seenUrls.has(seed.url)) {
            combined.push(seed);
            seenUrls.add(seed.url);
          }
        }
        resolve(combined);
      });
    });
  }

  async function recordExternalStoreOffers(storeName, offers = []) {
    if (!Array.isArray(offers) || offers.length === 0) return { savedCount: 0 };
    const current = await getExternalStoreOffersList();
    const byKey = new Map();
    for (const item of current) {
      if (!item || !item.title || !item.price) continue;
      const k = `${item.store || storeName}|${item.url || normalizeTitleKey(item.title)}`;
      byKey.set(k, item);
    }
    const nowIso = new Date().toISOString();
    let addedOrUpdated = 0;
    for (const raw of offers) {
      if (!raw || !raw.title || !raw.price || Number(raw.price) <= 0) continue;
      const cleanOffer = {
        store: raw.store || storeName || 'Магнит',
        goodId: raw.goodId || null,
        title: String(raw.title).trim(),
        amount: raw.amount || '',
        price: Math.round(Number(raw.price)),
        oldPrice: raw.oldPrice ? Math.round(Number(raw.oldPrice)) : null,
        url: raw.url || `https://magnit.ru/search?term=${encodeURIComponent(raw.title)}`,
        updatedAt: nowIso
      };
      const k = `${cleanOffer.store}|${cleanOffer.url || normalizeTitleKey(cleanOffer.title)}`;
      byKey.set(k, cleanOffer);
      addedOrUpdated += 1;
    }
    const finalArr = Array.from(byKey.values()).slice(-800);
    await new Promise((resolve) => {
      chrome.storage.local.set({ [EXT_STORE_DB_KEY]: finalArr }, resolve);
    });

    // Сразу обогащаем совпадающие товары в базе цен Лавки (lqs_price_db_v1)
    const priceDb = await getLocalPriceDb();
    let dbChanged = false;
    for (const entry of Object.values(priceDb)) {
      if (!entry || !entry.title) continue;
      const matchedOffers = findMatchingExternalStoreOffersFromList(finalArr, entry.title, entry.amount || '');
      if (matchedOffers.length > 0) {
        const mergedOffers = mergeUniqueStoreOffers(entry.competitorOffers || [], matchedOffers);
        entry.competitorOffers = sanitizeCompetitorOffersForProduct(mergedOffers, entry.title, entry.amount || '');
        const priced = entry.competitorOffers.filter((o) => o.price && o.price > 0);
        if (priced.length > 0) {
          entry.competitorMinPrice = Math.min(...priced.map((o) => o.price));
          entry.competitorSummary = priced.slice(0, 4).map((o) => `${o.store}: ${o.price} ₽`).join(', ');
        }
        dbChanged = true;
      }
    }
    if (dbChanged) {
      await new Promise((resolve) => chrome.storage.local.set({ [PRICE_DB_KEY]: priceDb }, resolve));
    }
    return { ok: true, savedCount: addedOrUpdated, totalExternalOffers: finalArr.length };
  }

  function findMatchingExternalStoreOffersFromList(extList, productTitle, productAmount = '') {
    if (!productTitle || !Array.isArray(extList)) return [];
    const matches = [];
    for (const ext of extList) {
      if (!ext || !ext.title || !ext.price) continue;
      const check = isSearchResultMatchingProduct(ext.title, ext.amount || '', productTitle, productAmount);
      if (check.isSameProduct && check.isSameVolume) {
        matches.push({
          store: ext.store || 'Магнит',
          price: Math.round(Number(ext.price)),
          oldPrice: ext.oldPrice ? Math.round(Number(ext.oldPrice)) : null,
          url: ext.url,
          title: ext.title,
          isVerifiedStoreOffer: true
        });
      }
    }
    return matches;
  }

  function mergeUniqueStoreOffers(existingOffers = [], newOffers = []) {
    const map = new Map();
    for (const o of [...newOffers, ...existingOffers]) {
      if (!o || !o.store) continue;
      const key = `${o.store}|${o.price || 'noprice'}`;
      if (!map.has(key)) {
        map.set(key, o);
      }
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => {
      if (a.price && b.price) return a.price - b.price;
      if (a.price) return -1;
      if (b.price) return 1;
      return 0;
    });
    return arr;
  }

  /**
   * Пакетный аудит корзины по конкурентам и гостевым ценам:
   * ГАРАНТИРУЕТ, что для каждого товара корзины название и характеристики берутся
   * СТРОГО ИЗ ОРИГИНАЛЬНОЙ КАРТОЧКИ ТОВАРА (`/good/<slug>`), а не из сокращённого текста в корзине!
   */
  async function auditCartCompetitorsAndAccounts(accountId, items = [], forceNetworkSearch = false) {
    const stopKeepAlive = getBgDeps().startSwKeepAlive ? getBgDeps().startSwKeepAlive() : () => {};
    try {
      const settings = await getSettings();
      const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)';
      let priceDb = await getLocalPriceDb();

      // Шаг 1: Для всех позиций корзины, у которых ещё нет полного названия из оригинальной карточки товара (`isCanonicalCardTitle`),
      // параллельно подтягиваем оригинальную карточку `https://lavka.yandex.ru/good/<slug>`!
      const itemsNeedingCardResolution = items.filter((item) => {
        if (!item || !item.slug) return false;
        const existing = findPriceEntryInDb(priceDb, item.slug, item.title, item.imageKey);
        return !existing || !existing.isCanonicalCardTitle;
      });

      for (let i = 0; i < itemsNeedingCardResolution.length; i += 4) {
        const chunk = itemsNeedingCardResolution.slice(i, i + 4);
        await Promise.all(
          chunk.map((it) =>
            probeProductCardMeta(
              it.slug,
              it.title || it.slug,
              it.price,
              acc,
              it.amount || '',
              it.imageKey || null
            )
          )
        );
      }

      // Перечитываем обновлённую БД после резолва оригинальных карточек
      priceDb = await getLocalPriceDb();

      const enrichedItems = [];
      let totalLavkaPrice = 0;
      let totalOverpayVsCompetitors = 0;
      let totalOverpayVsAltAccount = 0;
      let cheaperAtCompetitorsCount = 0;
      let cheaperOnAltAccountCount = 0;

      const batchUpdates = [];
      let ddgNetworkCallsMade = 0;
      const maxDdgCallsPerPass = forceNetworkSearch ? 10 : 5;

      for (const item of items) {
        if (!item || !item.slug) continue;
        const slug = String(item.slug).trim().toLowerCase();
        const qty = Math.max(1, Number(item.qty) || 1);
        const price = Number(item.price) || 0;

        totalLavkaPrice += price * qty;

        const pEntry = findPriceEntryInDb(priceDb, slug, item.title, item.imageKey);

        // БЕРЁМ НАЗВАНИЕ, ФАСОВКУ И БРЕНД СТРОГО ИЗ ОРИГИНАЛЬНОЙ КАРТОЧКИ ТОВАРА!
        const cardTitle = (pEntry && pEntry.title) ? pEntry.title : (item.title || slug);
        const cardAmount = (pEntry && pEntry.amount) ? pEntry.amount : (item.amount || '');
        const cardBrand = (pEntry && pEntry.brand) ? pEntry.brand : '';
        const cardImageKey = (pEntry && pEntry.imageKey) ? pEntry.imageKey : (item.imageKey || null);
        const fullAuthoritativeTitle = buildFullProductSearchQuery(cardTitle, cardBrand, cardAmount);

        const aiEntry = await getBgDeps().getLocalAiCacheEntry(slug, fullAuthoritativeTitle, cardImageKey);

        const extStoreList = await getExternalStoreOffersList();
        const matchedExtOffers = findMatchingExternalStoreOffersFromList(extStoreList, fullAuthoritativeTitle, cardAmount);
        let compOffers = sanitizeCompetitorOffersForProduct(
          mergeUniqueStoreOffers(pEntry?.competitorOffers || [], matchedExtOffers),
          fullAuthoritativeTitle,
          cardAmount
        );
        let compMin = null;
        let compSum = '';

        if (compOffers.length > 0) {
          const pricedOffers = compOffers.filter((o) => o.price && o.price > 0);
          if (pricedOffers.length > 0) {
            compMin = Math.min(...pricedOffers.map((o) => o.price));
            compSum = pricedOffers.slice(0, 3).map((o) => `${o.store}: ~${o.price} ₽`).join(', ');
          }
        }

        if (compOffers.length === 0 && aiEntry && Array.isArray(aiEntry.sources) && aiEntry.sources.length > 0) {
          const extracted = getBgDeps().extractCompetitorPricesFromSources(
            aiEntry.sources,
            price,
            fullAuthoritativeTitle,
            cardAmount
          );
          if (extracted.competitorMinPrice) compMin = extracted.competitorMinPrice;
          if (extracted.competitorSummary) compSum = extracted.competitorSummary;
          if (extracted.competitorOffers.length > 0) compOffers = extracted.competitorOffers;
        }

        if (
          (forceNetworkSearch || (!compMin && compOffers.length === 0)) &&
          fullAuthoritativeTitle &&
          ddgNetworkCallsMade < maxDdgCallsPerPass
        ) {
          ddgNetworkCallsMade += 1;
          const foundSources = await getBgDeps().searchWebReviewsDirect(fullAuthoritativeTitle, cardBrand, cardAmount);
          const extracted = getBgDeps().extractCompetitorPricesFromSources(
            foundSources,
            price,
            fullAuthoritativeTitle,
            cardAmount
          );
          if (extracted.competitorMinPrice) compMin = extracted.competitorMinPrice;
          if (extracted.competitorSummary) compSum = extracted.competitorSummary;
          if (extracted.competitorOffers.length > 0) {
            compOffers = extracted.competitorOffers;
          } else if (foundSources.length > 0) {
            compOffers = foundSources
              .filter((s) => s.url && !s.url.includes('otzovik.com') && !s.url.includes('irecommend.ru'))
              .filter((s) => isSearchResultMatchingProduct(s.title, s.snippet, fullAuthoritativeTitle, cardAmount).isSameProduct)
              .slice(0, 4)
              .map((s) => ({
                store: s.source || 'Магазин',
                price: null,
                url: s.url,
                title: s.title || s.source
              }));
          }

          batchUpdates.push({
            slug,
            title: fullAuthoritativeTitle,
            isCanonicalCardTitle: Boolean(pEntry?.isCanonicalCardTitle),
            brand: cardBrand,
            imageKey: cardImageKey,
            price,
            oldPrice: item.oldPrice || null,
            amount: cardAmount,
            competitorMinPrice: compMin || null,
            competitorSummary: compSum || null,
            competitorOffers: compOffers
          });
        }

        let bestAltPrice = null;
        let bestAltLabel = '';
        const accountsMap = pEntry?.accounts || {};
        for (const [accName, accVal] of Object.entries(accountsMap)) {
          if (accName !== acc && accVal && accVal.price && accVal.price < price - 2) {
            if (!bestAltPrice || accVal.price < bestAltPrice) {
              bestAltPrice = accVal.price;
              bestAltLabel = accName;
            }
          }
        }
        if (pEntry?.minPrice && pEntry.minPrice < price - 2 && (!bestAltPrice || pEntry.minPrice < bestAltPrice)) {
          bestAltPrice = pEntry.minPrice;
          bestAltLabel = 'Мин. в БД';
        }

        const overpayVsCompetitorPerUnit = compMin && compMin < price - 3 ? Math.round(price - compMin) : 0;
        const overpayVsCompetitorTotal = overpayVsCompetitorPerUnit * qty;
        if (overpayVsCompetitorTotal > 0) {
          totalOverpayVsCompetitors += overpayVsCompetitorTotal;
          cheaperAtCompetitorsCount += 1;
        }

        const overpayVsAltPerUnit = bestAltPrice && bestAltPrice < price - 2 ? Math.round(price - bestAltPrice) : 0;
        const overpayVsAltTotal = overpayVsAltPerUnit * qty;
        if (overpayVsAltTotal > 0) {
          totalOverpayVsAltAccount += overpayVsAltTotal;
          cheaperOnAltAccountCount += 1;
        }

        enrichedItems.push({
          slug,
          title: fullAuthoritativeTitle,
          amount: cardAmount,
          brand: cardBrand,
          imageKey: cardImageKey,
          qty,
          price,
          rowTotal: Math.round(price * qty),
          bestAltPrice: bestAltPrice || null,
          bestAltLabel: bestAltLabel || '',
          overpayVsAltPerUnit,
          overpayVsAltTotal,
          competitorMinPrice: compMin || null,
          competitorSummary: compSum || '',
          competitorOffers: compOffers,
          overpayVsCompetitorPerUnit,
          overpayVsCompetitorTotal,
          storeSearchLinks: buildDirectStoreSearchLinks(fullAuthoritativeTitle, cardAmount, cardBrand)
        });
      }

      if (batchUpdates.length > 0) {
        await recordPricesBatch(acc, batchUpdates);
      }

      return {
        ok: true,
        accountId: acc,
        totalLavkaPrice: Math.round(totalLavkaPrice),
        totalOverpayVsCompetitors: Math.round(totalOverpayVsCompetitors),
        totalOverpayVsAltAccount: Math.round(totalOverpayVsAltAccount),
        cheaperAtCompetitorsCount,
        cheaperOnAltAccountCount,
        items: enrichedItems,
        updatedAt: new Date().toISOString()
      };
    } finally {
      stopKeepAlive();
    }
  }


  async function getLocalWatchlist() {
    return new Promise((resolve) => {
      chrome.storage.local.get([WATCHLIST_KEY], (res) => {
        const map = res[WATCHLIST_KEY];
        resolve(map && typeof map === 'object' ? map : {});
      });
    });
  }

  async function saveLocalWatchlist(map) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [WATCHLIST_KEY]: map || {} }, () => resolve());
    });
  }

  function buildLocalDailyAvg(points) {
    const buckets = new Map();
    for (const pt of Array.isArray(points) ? points : []) {
      if (!pt || !(Number(pt.price) > 0)) continue;
      const dayKey = String(pt.ts || '').slice(0, 10);
      if (!dayKey) continue;
      if (!buckets.has(dayKey)) buckets.set(dayKey, []);
      buckets.get(dayKey).push(Number(pt.price));
    }
    return Array.from(buckets.keys())
      .sort()
      .map((dayKey) => {
        const vals = buckets.get(dayKey);
        const avg = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
        return {
          date: dayKey,
          ts: `${dayKey}T12:00:00.000Z`,
          price: avg,
          minPrice: Math.min(...vals),
          maxPrice: Math.max(...vals),
          count: vals.length
        };
      });
  }

  async function getProductPriceHistory(slug, title = '', days = 90, accountId = null) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!cleanSlug) return null;
    const settings = await getSettings();
    const backendUrl = (settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    const daysNum = Number.isFinite(Number(days)) ? Number(days) : 90;

    if (Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
      try {
        const qs = new URLSearchParams({ days: String(daysNum) });
        if (title) qs.set('title', title);
        if (accountId) qs.set('accountId', accountId);
        const resp = await fetchWithTimeout(
          `${backendUrl}/api/price/history/${encodeURIComponent(cleanSlug)}?${qs.toString()}`,
          { headers: await getBgDeps().buildBackendAuthHeaders(backendUrl) },
          3000
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.status === 'ok') {
            return data;
          }
        }
      } catch {
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }

    // Fallback к локальной базе PRICE_DB + WATCHLIST
    const db = await getLocalPriceDb();
    const wl = await getLocalWatchlist();
    const entry = findPriceEntryInDb(db, cleanSlug, title);
    const canonicalSlug = entry?.slug || cleanSlug;
    const rawHistory = Array.isArray(entry?.history) ? [...entry.history].reverse() : [];
    const cutoff = daysNum > 0 ? Date.now() - daysNum * 24 * 60 * 60 * 1000 : 0;

    const points = rawHistory
      .filter((h) => h && Number(h.price) > 0 && h.accountId !== 'Гость (без куки)')
      .filter((h) => !accountId || h.accountId === accountId)
      .filter((h) => !cutoff || !h.ts || Date.parse(h.ts) >= cutoff)
      .map((h) => ({
        price: Number(h.price),
        oldPrice: h.oldPrice ? Number(h.oldPrice) : null,
        accountId: h.accountId || 'Аккаунт #1',
        ts: h.ts || entry.updatedAt || new Date().toISOString()
      }));

    if (points.length === 0 && entry && entry.lastPrice > 0) {
      points.push({
        price: Number(entry.lastPrice),
        oldPrice: null,
        accountId: settings.lavkaAccountLabel || 'Аккаунт #1',
        ts: entry.updatedAt || new Date().toISOString()
      });
    }

    const prices = points.map((p) => p.price);
    const stats = prices.length > 0
      ? {
          minPrice: Math.min(...prices),
          maxPrice: Math.max(...prices),
          avgPrice: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100,
          lastPrice: prices[prices.length - 1],
          count: prices.length
        }
      : { minPrice: null, maxPrice: null, avgPrice: null, lastPrice: null, count: 0 };

    const wItem = wl[canonicalSlug] || wl[cleanSlug] || null;
    const accounts = Array.from(new Set(points.map((p) => p.accountId).filter(Boolean)));

    return {
      status: 'ok',
      slug: canonicalSlug,
      title: entry?.title || title || canonicalSlug,
      amount: entry?.amount || '',
      days: daysNum,
      points,
      dailyAvg: buildLocalDailyAvg(points),
      stats,
      accounts,
      isWatched: Boolean(wItem),
      targetPrice: wItem?.targetPrice || null
    };
  }

  async function toggleWatchlistItem({ slug, title = '', amount = '', price = null, targetPrice = null, watch = null } = {}) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (!cleanSlug) return { ok: false, error: 'slug is required' };
    const settings = await getSettings();
    const backendUrl = (settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    const wl = await getLocalWatchlist();
    const nowIso = new Date().toISOString();

    let watched = watch === null || watch === undefined ? !Boolean(wl[cleanSlug]) : Boolean(watch);
    let item = null;

    if (Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
      try {
        const resp = await fetchWithTimeout(
          `${backendUrl}/api/watchlist/toggle`,
          {
            method: 'POST',
            headers: await getBgDeps().buildBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ slug: cleanSlug, title, amount, price, targetPrice, watch })
          },
          3000
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.status === 'ok') {
            watched = Boolean(data.watched);
            item = data.item || null;
          }
        }
      } catch {
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }

    if (watched) {
      const existing = wl[cleanSlug] || {};
      const effPrice = price && Number(price) > 0 ? Math.round(Number(price)) : (existing.lastPrice || null);
      wl[cleanSlug] = item || {
        slug: cleanSlug,
        title: title || existing.title || cleanSlug,
        amount: amount || existing.amount || '',
        targetPrice: targetPrice && Number(targetPrice) > 0 ? Math.round(Number(targetPrice)) : (existing.targetPrice || null),
        lastPrice: effPrice,
        baselinePrice: existing.baselinePrice || effPrice,
        lastCheckedAt: nowIso,
        createdAt: existing.createdAt || nowIso,
        updatedAt: nowIso
      };
      item = wl[cleanSlug];
    } else {
      delete wl[cleanSlug];
    }

    await saveLocalWatchlist(wl);
    return { ok: true, watched, slug: cleanSlug, item };
  }

  async function getWatchlistItems() {
    const settings = await getSettings();
    const backendUrl = (settings.backendUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');

    if (Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
      try {
        const resp = await fetchWithTimeout(
          `${backendUrl}/api/watchlist?limit=200`,
          { headers: await getBgDeps().buildBackendAuthHeaders(backendUrl) },
          3000
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.status === 'ok' && Array.isArray(data.items)) {
            const syncMap = {};
            data.items.forEach((it) => {
              if (it && it.slug) syncMap[it.slug] = it;
            });
            await saveLocalWatchlist(syncMap);
            return data.items;
          }
        }
      } catch {
        getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
      }
    }

    const wl = await getLocalWatchlist();
    const db = await getLocalPriceDb();
    return Object.values(wl)
      .map((it) => {
        const pEntry = findPriceEntryInDb(db, it.slug, it.title);
        const lastP = pEntry?.lastPrice ?? it.lastPrice ?? null;
        const baseP = it.baselinePrice ?? lastP;
        return {
          ...it,
          lastPrice: lastP,
          baselinePrice: baseP,
          priceDiff: (lastP != null && baseP != null) ? Math.round((lastP - baseP) * 100) / 100 : 0,
          minPrice: pEntry?.minPrice ?? it.minPrice ?? lastP,
          maxPrice: pEntry?.maxPrice ?? it.maxPrice ?? lastP,
          avgPrice: pEntry?.avgPrice ?? it.avgPrice ?? lastP
        };
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }

  async function checkWatchlistPricesBatch({ maxItems = 12 } = {}) {
    const stopKeepAlive = getBgDeps().startSwKeepAlive ? getBgDeps().startSwKeepAlive() : () => {};
    try {
      const settings = await getSettings();
      const acc = settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)';
      const items = await getWatchlistItems();
      if (!items || items.length === 0) {
        return { ok: true, checked: 0, updated: 0, drops: [] };
      }

      const slice = items.slice(0, Math.max(1, Number(maxItems) || 12));
      const wl = await getLocalWatchlist();
      const drops = [];
      let checked = 0;
      let updated = 0;

      for (const item of slice) {
        if (!item || !item.slug) continue;
        checked += 1;
        try {
          const prevPrice = Number(item.lastPrice) || 0;
          const probed = await probeProductCardMeta(
            item.slug,
            item.title || item.slug,
            null,
            acc,
            item.amount || '',
            null
          );
          const newPrice = probed && Number(probed.lastPrice) > 0 ? Number(probed.lastPrice) : 0;
          if (newPrice > 0) {
            updated += 1;
            if (wl[item.slug]) {
              wl[item.slug].lastPrice = newPrice;
              wl[item.slug].lastCheckedAt = new Date().toISOString();
              wl[item.slug].updatedAt = new Date().toISOString();
            }
            if (prevPrice > 0 && newPrice < prevPrice - 1) {
              drops.push({
                slug: item.slug,
                title: item.title || item.slug,
                oldPrice: prevPrice,
                newPrice,
                diff: Math.round(prevPrice - newPrice)
              });
            }
          }
        } catch {
          // continue next item
        }
        await new Promise((r) => setTimeout(r, 450));
      }

      await saveLocalWatchlist(wl);
      return { ok: true, checked, updated, drops };
    } finally {
      stopKeepAlive();
    }
  }


  const LIVE_RADAR_STORE_URLS = {
    kuper: {
      name: 'Купер',
      buildUrl: (q) => `https://kuper.ru/multisearch?q=${encodeURIComponent(q)}`
    },
    magnit: {
      name: 'Магнит',
      buildUrl: (q) => `https://magnit.ru/search?term=${encodeURIComponent(q)}`
    },
    perekrestok: {
      name: 'Перекрёсток',
      buildUrl: (q) => `https://www.perekrestok.ru/cat/search?search=${encodeURIComponent(q)}`
    },
    pyaterochka: {
      name: 'Пятёрочка',
      buildUrl: (q) => `https://5ka.ru/search/?q=${encodeURIComponent(q)}`
    },
    vkusvill: {
      name: 'ВкусВилл',
      buildUrl: (q) => `https://vkusvill.ru/search/?q=${encodeURIComponent(q)}`
    },
    auchan: {
      name: 'Ашан',
      buildUrl: (q) => `https://www.auchan.ru/search/?q=${encodeURIComponent(q)}`
    },
    lenta: {
      name: 'Лента',
      buildUrl: (q) => `https://lenta.com/search/?searchText=${encodeURIComponent(q)}`
    }
  };

  function waitForTabComplete(tabId, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (chrome.tabs?.onUpdated?.removeListener) {
          chrome.tabs.onUpdated.removeListener(onUpdated);
        }
        resolve();
      };
      const onUpdated = (updatedId, changeInfo) => {
        if (updatedId === tabId && changeInfo && changeInfo.status === 'complete') {
          done();
        }
      };
      timer = setTimeout(done, timeoutMs);
      if (chrome.tabs?.onUpdated?.addListener) {
        chrome.tabs.onUpdated.addListener(onUpdated);
      }
      if (chrome.tabs?.get) {
        chrome.tabs.get(tabId, (tab) => {
          if (!chrome.runtime.lastError && tab && tab.status === 'complete') {
            done();
          }
        });
      }
    });
  }

  function requestHarvestFromTab(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'LQS_HARVEST_STORE_PAGE_NOW' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          resolve({ store: '', offers: [] });
          return;
        }
        resolve({ store: resp.store || '', offers: Array.isArray(resp.offers) ? resp.offers : [] });
      });
    });
  }

  async function harvestSingleStoreInBackgroundTab(storeId, query) {
    const cfg = LIVE_RADAR_STORE_URLS[storeId];
    if (!cfg || !query) return { storeId, store: cfg?.name || storeId, offers: [] };

    const targetUrl = cfg.buildUrl(query);
    let tabId = null;
    try {
      const createdTab = await new Promise((resolve) => {
        chrome.tabs.create({ url: targetUrl, active: false }, (tab) => {
          resolve(chrome.runtime.lastError ? null : tab);
        });
      });
      if (!createdTab || typeof createdTab.id !== 'number') {
        return { storeId, store: cfg.name, offers: [] };
      }
      tabId = createdTab.id;
      await waitForTabComplete(tabId, 7500);

      // Give SPA stores (Kuper, Perekrestok, Magnit, 5ka, Lenta) time to render search results
      let bestOffers = [];
      let detectedStore = cfg.name;
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 1100 : 1000));
        const res = await requestHarvestFromTab(tabId);
        if (res.store) detectedStore = res.store;
        if (res.offers.length > bestOffers.length) {
          bestOffers = res.offers;
        }
        if (bestOffers.length >= 6 || (attempt >= 2 && bestOffers.length > 0)) {
          break;
        }
      }
      return { storeId, store: detectedStore, offers: bestOffers };
    } catch {
      return { storeId, store: cfg.name, offers: [] };
    } finally {
      if (tabId !== null) {
        try {
          chrome.tabs.remove(tabId, () => {
            void chrome.runtime.lastError;
          });
        } catch {
          // ignore
        }
      }
    }
  }

  async function scanStoresInBackgroundTabs(payload = {}) {
    const stopKeepAlive = getBgDeps().startSwKeepAlive ? getBgDeps().startSwKeepAlive() : () => {};
    try {
      const settings = await getSettings();
      const slug = String(payload.slug || '').trim().toLowerCase();
      const title = String(payload.title || '').trim();
      const brand = String(payload.brand || '').trim();
      const amount = String(payload.amount || '').trim();
      const price = payload.price ? Number(payload.price) : null;
      const oldPrice = payload.oldPrice ? Number(payload.oldPrice) : null;
      const accountId = payload.accountId || settings.lavkaAccountLabel || 'Аккаунт #1';
      const imageKey = payload.imageKey || null;

      const fullQuery = buildFullProductSearchQuery(title, brand, amount);
      if (!fullQuery) {
        return { ok: false, error: 'Не удалось определить название товара для поиска' };
      }

      const rawStores = Array.isArray(payload.stores) && payload.stores.length > 0
        ? payload.stores
        : (Array.isArray(settings.liveRadarStores) && settings.liveRadarStores.length > 0
            ? settings.liveRadarStores
            : ['kuper']);
      const selectedStores = rawStores
        .filter((s) => Boolean(LIVE_RADAR_STORE_URLS[s]))
        .slice(0, 3);
      if (selectedStores.length === 0) selectedStores.push('kuper');

      const results = [];
      // Run up to 2 background tabs in parallel for speed without lagging Chrome
      for (let i = 0; i < selectedStores.length; i += 2) {
        const chunk = selectedStores.slice(i, i + 2);
        const chunkRes = await Promise.all(
          chunk.map((storeId) => harvestSingleStoreInBackgroundTab(storeId, fullQuery))
        );
        results.push(...chunkRes);
      }

      let harvestedCount = 0;
      const storesChecked = [];
      for (const r of results) {
        storesChecked.push(r.store);
        if (r.offers.length > 0) {
          harvestedCount += r.offers.length;
          await recordExternalStoreOffers(r.store, r.offers);
        }
      }

      const summary = slug
        ? await getProductPriceIntelligence(slug, title, price, oldPrice, amount, accountId, true, imageKey, brand)
        : null;
      const matchedCount = summary && Array.isArray(summary.competitorOffers)
        ? summary.competitorOffers.filter((o) => o && o.price > 0).length
        : 0;

      return {
        ok: true,
        query: fullQuery,
        storesChecked,
        harvestedCount,
        matchedCount,
        summary
      };
    } finally {
      stopKeepAlive();
    }
  }

  const api = {
    getMagnitSeedOffers,
    RADAR_16_STORES_CATALOG,
    getCircuitBreakerState,
    saveCircuitBreakerState,
    isCaptchaOrBlockHtml,
    isCircuitOpen,
    recordCircuitSuccess,
    recordCircuitFailure,
    resetCircuitBreakers,
    getRadar16StoresStatus,
    getLocalPriceDb,
    findPriceEntryInDb,
    sanitizeCompetitorOffersForProduct,
    mergePriceRecordIntoEntry,
    recordPricesBatch,
    parsePriceFromLavkaHtml,
    parseFullProductCardFromLavkaHtml,
    probeProductCardMeta,
    getLocalWatchlist,
    getProductPriceHistory,
    toggleWatchlistItem,
    getWatchlistItems,
    checkWatchlistPricesBatch,
    getProductPriceIntelligence,
    getExternalStoreOffersList,
    recordExternalStoreOffers,
    findMatchingExternalStoreOffersFromList,
    mergeUniqueStoreOffers,
    auditCartCompetitorsAndAccounts,
    LIVE_RADAR_STORE_URLS,
    scanStoresInBackgroundTabs
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_PRICE_RADAR = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
