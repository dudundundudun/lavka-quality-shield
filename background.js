/**
 * Lavka Quality Shield v2.4.0 — Background Service Worker
 * Полный комбайн:
 * 1. Zero-Click Автопилот ИИ + вечный кэш ИИ в браузере (lqs_ai_cache_v1) + очередь запросов к Gemini.
 * 2. Единая база истории цен и мульти-аккаунт матрица (lqs_price_db_v1 + синхронизация с SQLite :8765).
 * 3. Анонимный зонд цен без куки (Incognito Guest Price Probe: credentials: 'omit') против «штрафа за лояльность».
 * 4. Парсер цен конкурентов (ВкусВилл, Перекрёсток, Азбука Вкуса, Ozon, Лента) прямо из поисковой выдачи.
 * 5. Слепок корзины (Cart Snapshot), 2-секундная сверка всей корзины между аккаунтами и Авто-сборщик корзины в 1 клик.
 */

'use strict';

const SETTINGS_KEY = 'lqs_settings_v2';
const AI_CACHE_KEY = 'lqs_ai_cache_v1';
const PRICE_DB_KEY = 'lqs_price_db_v1';
const SAVED_CARTS_KEY = 'lqs_saved_carts_v1';
const CART_LOCKS_KEY = 'lqs_cart_locks_v1';

const MAX_LOCAL_AI_CACHE_ITEMS = 500;
const MAX_LOCAL_PRICE_DB_ITEMS = 1500;

const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:8765',
  aiBaseUrl: 'http://localhost:8083/v1',
  aiApiKey: '',
  aiModel: 'gemini-4-argon',
  preferBrowserGeminiTab: true,
  geminiAccountIndex: 'auto',
  preferredGeminiTabId: null,
  autoRunAiOnProductPage: true,
  autoOpenDrawerOnAi: true,
  autoWarmupGeminiTab: true,
  lavkaAccountLabel: 'Аккаунт #1 (Основной)',
  enableGuestPriceProbe: true
};

const REVIEW_SEARCH_SITES = [
  { domain: 'otzovik.com', name: 'Отзовик' },
  { domain: 'irecommend.ru', name: 'IRecommend' },
  { domain: 'rskrf.ru', name: 'Роскачество' },
  { domain: 'roscontrol.com', name: 'Росконтроль' },
  { domain: 'vkusvill.ru', name: 'ВкусВилл' },
  { domain: 'perekrestok.ru', name: 'Перекрёсток' },
  { domain: 'vprok.ru', name: 'Перекрёсток Впрок' },
  { domain: 'av.ru', name: 'Азбука Вкуса' },
  { domain: 'lenta.com', name: 'Лента' },
  { domain: 'ozon.ru', name: 'Ozon' },
  { domain: 'market.yandex.ru', name: 'Яндекс Маркет' },
  { domain: 'wildberries.ru', name: 'Wildberries' },
  { domain: 'kuper.ru', name: 'Купер' },
  { domain: 'sbermarket.ru', name: 'СберМаркет' },
  { domain: 'eda.yandex.ru', name: 'Яндекс Лавка / Еда' }
];

let geminiTabMutex = Promise.resolve();
const inFlightRequests = new Map();
let lastWarmupCheckTs = 0;
let isWarmingUp = false;

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY], (res) => {
      resolve({ ...DEFAULT_SETTINGS, ...(res && res[SETTINGS_KEY] ? res[SETTINGS_KEY] : {}) });
    });
  });
}

async function saveSettingsPatch(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: next }, () => resolve(next));
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return resp;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

function normalizeCacheKey(slug, title) {
  return String(slug || title || '')
    .trim()
    .toLowerCase();
}

// ============================================================================
// 1. ВСТРОЕННЫЙ КЭШ ИИ-ОБЗОРОВ (lqs_ai_cache_v1)
// ============================================================================
async function getLocalAiCacheMap() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AI_CACHE_KEY], (res) => {
      resolve(res && res[AI_CACHE_KEY] && typeof res[AI_CACHE_KEY] === 'object' ? res[AI_CACHE_KEY] : {});
    });
  });
}

async function getLocalAiCacheEntry(slug, title) {
  const key = normalizeCacheKey(slug, title);
  if (!key) return null;
  const map = await getLocalAiCacheMap();
  const entry = map[key];
  if (entry && entry.verdict && !String(entry.verdict).startsWith('⚠️')) {
    return entry;
  }
  return null;
}

async function saveLocalAiCacheEntry(slug, title, verdict, sources, mode) {
  const key = normalizeCacheKey(slug, title);
  if (!key || !verdict || String(verdict).startsWith('⚠️')) return;
  const map = await getLocalAiCacheMap();
  map[key] = {
    slug: key,
    title: title || key,
    verdict: String(verdict).trim(),
    sources: Array.isArray(sources) ? sources : [],
    mode: mode || 'Автопилот ИИ',
    updatedAt: new Date().toISOString()
  };

  const keys = Object.keys(map);
  if (keys.length > MAX_LOCAL_AI_CACHE_ITEMS) {
    keys
      .sort((a, b) => String(map[a]?.updatedAt || '').localeCompare(String(map[b]?.updatedAt || '')))
      .slice(0, keys.length - MAX_LOCAL_AI_CACHE_ITEMS)
      .forEach((oldKey) => delete map[oldKey]);
  }

  return new Promise((resolve) => {
    chrome.storage.local.set({ [AI_CACHE_KEY]: map }, () => resolve(map[key]));
  });
}

async function clearLocalAiCache() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([AI_CACHE_KEY], () => resolve(true));
  });
}

// ============================================================================
// 2. МУЛЬТИ-АККАУНТ БАЗА ИСТОРИИ ЦЕН И АНОНИМНЫЙ ЗОНД БЕЗ КУКИ
// ============================================================================
async function getLocalPriceDb() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PRICE_DB_KEY], (res) => {
      resolve(res && res[PRICE_DB_KEY] && typeof res[PRICE_DB_KEY] === 'object' ? res[PRICE_DB_KEY] : {});
    });
  });
}

function mergePriceRecordIntoEntry(existing, item, accountId, nowIso) {
  const slug = String(item.slug || '').trim().toLowerCase();
  const acc = String(accountId || 'Аккаунт #1').trim();
  const price = Number(item.price) || 0;
  const oldPrice = item.oldPrice ? Number(item.oldPrice) : null;
  const guestPrice = item.guestPrice ? Number(item.guestPrice) : (existing?.guestPrice || null);
  const compMin = item.competitorMinPrice ? Number(item.competitorMinPrice) : (existing?.competitorMinPrice || null);
  const compSum = item.competitorSummary || existing?.competitorSummary || null;

  const entry = existing || {
    slug,
    title: item.title || slug,
    amount: item.amount || '',
    minPrice: price,
    maxPrice: price,
    avgPrice: price,
    lastPrice: price,
    guestPrice: null,
    competitorMinPrice: null,
    competitorSummary: null,
    accounts: {},
    history: [],
    updatedAt: nowIso
  };

  if (item.title) entry.title = item.title;
  if (item.amount) entry.amount = item.amount;
  if (guestPrice && guestPrice > 0) {
    entry.guestPrice = Math.round(guestPrice);
    entry.accounts['Гость (без куки)'] = {
      price: Math.round(guestPrice),
      oldPrice: null,
      updatedAt: nowIso
    };
  }
  if (compMin && compMin > 0) entry.competitorMinPrice = Math.round(compMin);
  if (compSum) entry.competitorSummary = compSum;

  if (price > 0) {
    const rounded = Math.round(price);
    entry.lastPrice = rounded;
    entry.accounts[acc] = {
      price: rounded,
      oldPrice: oldPrice ? Math.round(oldPrice) : null,
      updatedAt: nowIso
    };
    const lastHist = entry.history[0];
    if (!lastHist || lastHist.price !== rounded || lastHist.accountId !== acc) {
      entry.history.unshift({
        price: rounded,
        oldPrice: oldPrice ? Math.round(oldPrice) : null,
        accountId: acc,
        ts: nowIso
      });
      if (entry.history.length > 20) entry.history.length = 20;
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
    const merged = mergePriceRecordIntoEntry(db[slug], rawItem, acc, nowIso);
    db[slug] = merged;
    updatedSummaries[slug] = merged;
  }

  // LRU trim
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

  // Синхронизируем с локальным FastAPI SQLite (:8765), чтобы другие профили Chrome сразу видели эти цены!
  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  if (backendUrl) {
    try {
      const resp = await fetchWithTimeout(
        `${backendUrl}/api/price/record`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: acc, items })
        },
        2200
      );
      if (resp.ok) {
        const data = await resp.json();
        if (data && data.summaries) {
          for (const [sKey, sVal] of Object.entries(data.summaries)) {
            db[sKey] = { ...db[sKey], ...sVal };
            updatedSummaries[sKey] = db[sKey];
          }
          chrome.storage.local.set({ [PRICE_DB_KEY]: db });
        }
      }
    } catch {
      // backend offline — local storage is already updated
    }
  }

  return updatedSummaries;
}

/**
 * Вытаскивает цену товара из HTML-кода страницы Яндекс Лавки
 */
function parsePriceFromLavkaHtml(html) {
  if (!html) return null;
  // 1. data-testid="price-text"
  const mTestId = html.match(/data-testid="price-text"[^>]*>([\d\s,.]+)</i);
  if (mTestId) {
    const val = parseFloat(mTestId[1].replace(/[^\d.,]/g, '').replace(',', '.'));
    if (val > 0) return Math.round(val);
  }
  // 2. JSON-LD Product offers.price
  const mLd = html.match(/"@type"\s*:\s*"Offer"[\s\S]{0,250}?"price"\s*:\s*"?([\d.]+)"?/i);
  if (mLd) {
    const val = parseFloat(mLd[1]);
    if (val > 0) return Math.round(val);
  }
  // 3. SSR state "price":124 or "pricing":{"price":124}
  const mState = html.match(/"pricing"\s*:\s*\{[^}]*"price"\s*:\s*(\d+(?:\.\d+)?)/i);
  if (mState) {
    const val = parseFloat(mState[1]);
    if (val > 0) return Math.round(val);
  }
  return null;
}

/**
 * Анонимный зонд цены без куки (credentials: 'omit') — ловит «штраф за лояльность»!
 */
async function probeGuestPriceWithoutCookies(slug, title = '', currentPrice = null, accountId = null) {
  if (!slug) return null;
  const cleanSlug = String(slug).trim().toLowerCase();
  try {
    const url = `https://lavka.yandex.ru/good/${encodeURIComponent(cleanSlug)}`;
    const resp = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          'Accept-Language': 'ru-RU,ru;q=0.9'
        }
      },
      4500
    );
    if (!resp.ok) return null;
    const html = await resp.text();
    const guestPrice = parsePriceFromLavkaHtml(html);
    if (guestPrice && guestPrice > 0) {
      const summaries = await recordPricesBatch(accountId, [
        {
          slug: cleanSlug,
          title: title || cleanSlug,
          price: currentPrice || guestPrice,
          guestPrice
        }
      ]);
      return summaries[cleanSlug] || { slug: cleanSlug, guestPrice };
    }
  } catch {
    // ignore network error
  }
  return null;
}

async function getProductPriceIntelligence(slug, title = '', currentPrice = null, oldPrice = null, amount = '', accountId = null) {
  const cleanSlug = String(slug || '').trim().toLowerCase();
  if (!cleanSlug) return null;
  const settings = await getSettings();
  const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1';

  // Если передана текущая цена — сразу записываем наблюдение
  if (currentPrice && currentPrice > 0) {
    await recordPricesBatch(acc, [
      {
        slug: cleanSlug,
        title,
        price: currentPrice,
        oldPrice,
        amount
      }
    ]);
  }

  const db = await getLocalPriceDb();
  let summary = db[cleanSlug] || null;

  // Подтягиваем актуальные данные с локального SQLite (:8765), если там есть цены с других профилей Chrome
  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  if (backendUrl) {
    try {
      const r = await fetchWithTimeout(`${backendUrl}/api/price/product/${encodeURIComponent(cleanSlug)}`, { method: 'GET' }, 1200);
      if (r.ok) {
        const j = await r.json();
        if (j && j.status === 'ok' && j.summary) {
          summary = { ...(summary || {}), ...j.summary, accounts: { ...(summary?.accounts || {}), ...(j.summary.accounts || {}) } };
          db[cleanSlug] = summary;
          chrome.storage.local.set({ [PRICE_DB_KEY]: db });
        }
      }
    } catch {
      // ignore offline backend
    }
  }

  // Если гостевая цена без куки ещё не проверялась (или проверялась давно) — запускаем анонимный зонд!
  if (settings.enableGuestPriceProbe !== false && (!summary || !summary.guestPrice)) {
    const probed = await probeGuestPriceWithoutCookies(cleanSlug, title, currentPrice, acc);
    if (probed) {
      summary = { ...(summary || {}), ...probed };
    }
  }

  return summary;
}

// ============================================================================
// 3. КЛОНИРОВАНИЕ, СВЕРКА И АВТО-СБОРКА КОРЗИНЫ МЕЖДУ АККАУНТАМИ
// ============================================================================
async function getSavedCartsState() {
  const settings = await getSettings();
  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');

  const localState = await new Promise((resolve) => {
    chrome.storage.local.get([SAVED_CARTS_KEY], (res) => {
      resolve(res && res[SAVED_CARTS_KEY] ? res[SAVED_CARTS_KEY] : { latest: null, byAccount: {} });
    });
  });

  if (backendUrl) {
    try {
      const r = await fetchWithTimeout(`${backendUrl}/api/cart/latest`, { method: 'GET' }, 1400);
      if (r.ok) {
        const j = await r.json();
        if (j && j.latest) {
          const byAcc = { ...(localState.byAccount || {}) };
          if (Array.isArray(j.cartsByAccount)) {
            j.cartsByAccount.forEach((c) => {
              if (c && c.accountId) byAcc[c.accountId] = c;
            });
          }
          const merged = { latest: j.latest, byAccount: byAcc };
          chrome.storage.local.set({ [SAVED_CARTS_KEY]: merged });
          return merged;
        }
      }
    } catch {
      // backend offline
    }
  }

  return localState;
}

async function saveCartSnapshot(accountId, items, totalPrice = 0) {
  const settings = await getSettings();
  const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1';
  const cleanItems = (Array.isArray(items) ? items : []).filter((i) => i && i.slug);
  const calcTotal = Math.round(cleanItems.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 1), 0));
  const finalTotal = totalPrice > 0 ? Math.round(totalPrice) : calcTotal;
  const nowIso = new Date().toISOString();

  const snapshot = {
    accountId: acc,
    items: cleanItems,
    totalPrice: finalTotal,
    updatedAt: nowIso
  };

  const state = await getSavedCartsState();
  state.latest = snapshot;
  state.byAccount = state.byAccount || {};
  state.byAccount[acc] = snapshot;

  await new Promise((resolve) => {
    chrome.storage.local.set({ [SAVED_CARTS_KEY]: state }, resolve);
  });

  // Записываем цены товаров корзины в базу цен
  await recordPricesBatch(
    acc,
    cleanItems.map((i) => ({
      slug: i.slug,
      title: i.title,
      price: i.price,
      oldPrice: i.oldPrice,
      amount: i.amount
    }))
  );

  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  if (backendUrl) {
    try {
      await fetchWithTimeout(
        `${backendUrl}/api/cart/save`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: acc,
            items: cleanItems,
            totalPrice: finalTotal
          })
        },
        2000
      );
    } catch {
      // ignore
    }
  }

  return snapshot;
}

/**
 * Мгновенная сверка сохранённой корзины на текущем аккаунте (проверяет живые цены каждого товара на текущем аккаунте и без куки)
 */
async function compareSavedCartOnCurrentAccount(targetAccountId) {
  const settings = await getSettings();
  const currentAcc = targetAccountId || settings.lavkaAccountLabel || 'Текущий аккаунт';
  const cartsState = await getSavedCartsState();
  const latest = cartsState.latest;

  if (!latest || !Array.isArray(latest.items) || latest.items.length === 0) {
    return {
      ok: false,
      error: 'Слепок корзины пока пуст! Добавь товары в корзину Лавки или нажми «📸 Снять слепок корзины».'
    };
  }

  const priceDb = await getLocalPriceDb();
  const comparedItems = [];
  let sourceTotal = 0;
  let currentTotal = 0;
  let guestTotal = 0;
  const batchToRecord = [];

  for (const item of latest.items) {
    const slug = String(item.slug || '').trim().toLowerCase();
    const qty = Number(item.qty) || 1;
    const sourcePrice = Number(item.price) || 0;

    let currentPrice = null;
    let guestPrice = priceDb[slug]?.guestPrice || null;

    // 1. Пробуем запросить страницу товара с куками ТЕКУЩЕГО аккаунта (credentials: 'include')
    try {
      const url = `https://lavka.yandex.ru/good/${encodeURIComponent(slug)}`;
      const resp = await fetchWithTimeout(url, { method: 'GET', credentials: 'include', cache: 'no-store' }, 4000);
      if (resp.ok) {
        const html = await resp.text();
        currentPrice = parsePriceFromLavkaHtml(html);
      }
    } catch {
      // fallback to priceDb
    }

    if (!currentPrice) {
      currentPrice = priceDb[slug]?.accounts?.[currentAcc]?.price || sourcePrice;
    }

    // 2. Пробуем узнать цену без куки (Гость), если ещё не известна
    if (!guestPrice) {
      try {
        const url = `https://lavka.yandex.ru/good/${encodeURIComponent(slug)}`;
        const respG = await fetchWithTimeout(url, { method: 'GET', credentials: 'omit', cache: 'no-store' }, 3500);
        if (respG.ok) {
          const htmlG = await respG.text();
          guestPrice = parsePriceFromLavkaHtml(htmlG);
        }
      } catch {
        // ignore
      }
    }

    const effCurrent = currentPrice || sourcePrice;
    const effGuest = guestPrice || effCurrent;

    sourceTotal += sourcePrice * qty;
    currentTotal += effCurrent * qty;
    guestTotal += effGuest * qty;

    if (currentPrice) {
      batchToRecord.push({
        slug,
        title: item.title || slug,
        price: currentPrice,
        guestPrice: guestPrice || null,
        amount: item.amount || ''
      });
    }

    comparedItems.push({
      slug,
      title: item.title || slug,
      qty,
      sourcePrice,
      currentPrice: effCurrent,
      guestPrice: guestPrice || null,
      diffPerUnit: effCurrent - sourcePrice,
      diffTotal: (effCurrent - sourcePrice) * qty,
      accounts: priceDb[slug]?.accounts || {}
    });
  }

  if (batchToRecord.length > 0) {
    await recordPricesBatch(currentAcc, batchToRecord);
  }

  return {
    ok: true,
    sourceAccount: latest.accountId || 'Аккаунт #1',
    currentAccount: currentAcc,
    sourceTotal: Math.round(sourceTotal),
    currentTotal: Math.round(currentTotal),
    guestTotal: Math.round(guestTotal),
    diffTotal: Math.round(currentTotal - sourceTotal),
    items: comparedItems,
    updatedAt: new Date().toISOString()
  };
}

/**
 * Авто-сборщик корзины в 1 клик: проходит по всем товарам из слепка корзины и добавляет их в корзину текущего аккаунта!
 */
async function autoBuildCartInBrowser(customItems = null) {
  const cartsState = await getSavedCartsState();
  const items = Array.isArray(customItems) && customItems.length > 0
    ? customItems
    : (cartsState.latest && Array.isArray(cartsState.latest.items) ? cartsState.latest.items : []);

  if (items.length === 0) {
    return {
      ok: false,
      error: 'Нет сохранённых товаров в слепке корзины! Сначала собери корзину на первом аккаунте.'
    };
  }

  // Находим открытую вкладку Лавки или создаём новую
  const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
  let targetTab = lavkaTabs && lavkaTabs.length > 0 ? lavkaTabs[0] : null;
  if (!targetTab) {
    targetTab = await chrome.tabs.create({ url: 'https://lavka.yandex.ru/', active: true });
  } else {
    await chrome.tabs.update(targetTab.id, { active: true });
  }

  let addedCount = 0;
  const resultsLog = [];

  for (const item of items) {
    if (!item || !item.slug) continue;
    const targetUrl = `https://lavka.yandex.ru/good/${encodeURIComponent(item.slug)}`;
    const desiredQty = Math.max(1, Math.min(20, Number(item.qty) || 1));

    await chrome.tabs.update(targetTab.id, { url: targetUrl });

    // Ждём загрузки карточки товара
    await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          resolve();
        }
      }, 5500);
      const listener = (tabId, info) => {
        if (tabId === targetTab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          if (!done) {
            done = true;
            clearTimeout(timer);
            setTimeout(resolve, 900);
          }
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    try {
      const execRes = await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        args: [desiredQty],
        func: async (qtyToSet) => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          let addBtn = null;
          for (let i = 0; i < 15; i++) {
            addBtn =
              document.querySelector('main[data-testid="good-page-desktop"] button[data-testid="snippet-control"]') ||
              document.querySelector('button[data-testid="snippet-control"]');
            if (addBtn) break;
            await wait(250);
          }
          if (!addBtn) return { ok: false, reason: 'Кнопка В корзину не найдена (возможно, нет в наличии)' };

          // Первый клик добавляет 1 шт.
          addBtn.click();
          await wait(380);

          // Если нужно больше 1 шт., ищем кнопку "+"
          for (let q = 1; q < qtyToSet; q++) {
            const plusBtn =
              document.querySelector('main[data-testid="good-page-desktop"] button[aria-label*="Увеличить"]') ||
              document.querySelector('main[data-testid="good-page-desktop"] button[data-testid*="plus"]') ||
              Array.from(document.querySelectorAll('main[data-testid="good-page-desktop"] button')).find(
                (b) => (b.textContent || '').trim() === '+'
              );
            if (plusBtn) {
              plusBtn.click();
              await wait(280);
            }
          }

          const priceEl = document.querySelector('span[data-testid="price-text"]');
          const priceVal = priceEl ? parseFloat(priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.')) : null;
          return { ok: true, price: priceVal };
        }
      });

      const r = execRes && execRes[0] ? execRes[0].result : null;
      if (r && r.ok) {
        addedCount += 1;
        resultsLog.push({ slug: item.slug, title: item.title, qty: desiredQty, ok: true, price: r.price });
      } else {
        resultsLog.push({ slug: item.slug, title: item.title, qty: desiredQty, ok: false, reason: r?.reason || 'Ошибка' });
      }
    } catch (err) {
      resultsLog.push({ slug: item.slug, title: item.title, qty: desiredQty, ok: false, reason: err.message });
    }
  }

  return {
    ok: true,
    addedCount,
    totalRequested: items.length,
    results: resultsLog
  };
}

// ============================================================================
// 4. ПОИСК ОТЗЫВОВ И ЦЕН КОНКУРЕНТОВ В DUCKDUCKGO
// ============================================================================
function cleanProductQueryForSearch(title, brand) {
  let q = String(title || '').replace(/[\u00ad\u200b\u00a0«»"'„“”]/g, ' ');
  q = q.replace(
    /(?:,\s*|\s+)(?:\d+\s*[×xх*]\s*)?\d+(?:[.,]\d+)?\s*(?:г|гр|грамм|кг|мл|л|шт|уп|пак|рул|капс)\.?$/i,
    ''
  );
  q = q.replace(/(^|\s)(?:бзмж|стм)(?=\s|$)/gi, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  if (brand) {
    const cleanBrand = String(brand).replace(/[\u00ad\u200b\u00a0«»"']/g, ' ').trim();
    if (cleanBrand && !q.toLowerCase().includes(cleanBrand.toLowerCase())) {
      q = cleanBrand.toLowerCase() === 'из лавки' ? `${q} Из Лавки` : `${q} ${cleanBrand}`;
    }
  }
  return q.trim();
}

function detectSourceSite(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    for (const s of REVIEW_SEARCH_SITES) {
      if (host === s.domain || host.endsWith('.' + s.domain)) {
        return { name: s.name, trusted: true };
      }
    }
    return { name: host.replace(/^www\./, '') || 'Веб', trusted: false };
  } catch {
    return { name: 'Веб', trusted: false };
  }
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapDdgUrl(rawHref) {
  let href = String(rawHref || '').trim();
  if (!href) return '';
  if (href.includes('uddg=')) {
    try {
      const u = new URL(href, 'https://html.duckduckgo.com');
      href = u.searchParams.get('uddg') || href;
    } catch {
      // ignore
    }
  }
  return /^https?:\/\//i.test(href) ? href : '';
}

function extractCompetitorPricesFromSources(sources, lavkaPrice = null) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return { competitorMinPrice: null, competitorSummary: '' };
  }
  const found = [];
  const priceRegex = /(?:от\s+|цена\s+|за\s+)?(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|р\.)(?![а-яa-z])/gi;
  for (const s of sources) {
    const text = `${s.title || ''} ${s.snippet || ''}`;
    const storeName = s.source || 'Магазин';
    for (const m of text.matchAll(priceRegex)) {
      const val = parseFloat(m[1].replace(',', '.'));
      if (val >= 20 && val <= 9500) {
        if (lavkaPrice && (val < lavkaPrice * 0.22 || val > lavkaPrice * 3.5)) continue;
        found.push({ store: storeName, price: Math.round(val) });
      }
    }
  }
  if (found.length === 0) return { competitorMinPrice: null, competitorSummary: '' };
  found.sort((a, b) => a.price - b.price);
  const minP = found[0].price;
  const seen = new Set();
  const parts = [];
  for (const item of found) {
    if (!seen.has(item.store)) {
      seen.add(item.store);
      parts.push(`${item.store}: ~${item.price} ₽`);
    }
    if (parts.length >= 3) break;
  }
  return { competitorMinPrice: minP, competitorSummary: parts.join(', ') };
}

async function parseDdgHtmlSearch(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const resp = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.7'
        }
      },
      6500
    );
    if (resp.ok) {
      const html = await resp.text();
      const results = [];
      const chunks = html.split(/<h2[^>]+class="[^"]*result__title[^"]*"[^>]*>/i).slice(1, 10);
      for (const chunk of chunks) {
        const aMatch = chunk.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!aMatch) continue;
        const cleanUrl = unwrapDdgUrl(aMatch[1]);
        if (!cleanUrl) continue;

        const rawTitle = decodeHtmlEntities(aMatch[2]);
        const snipMatch =
          chunk.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
          chunk.match(/<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        const snippet = snipMatch ? decodeHtmlEntities(snipMatch[1]) : '';
        const siteInfo = detectSourceSite(cleanUrl);

        results.push({
          title: `[${siteInfo.name}] ${rawTitle.slice(0, 85)}`,
          source: siteInfo.name,
          trusted: siteInfo.trusted,
          snippet,
          url: cleanUrl
        });
      }
      if (results.length > 0) return results;
    }
  } catch {
    // fallback to lite below
  }

  try {
    const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const respLite = await fetchWithTimeout(
      liteUrl,
      {
        method: 'GET',
        headers: {
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.7'
        }
      },
      6500
    );
    if (!respLite.ok) return [];
    const htmlLite = await respLite.text();
    const results = [];
    const linkRegex = /<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippets = Array.from(
      htmlLite.matchAll(/<td[^>]+class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi)
    ).map((m) => decodeHtmlEntities(m[1]));

    let idx = 0;
    for (const match of htmlLite.matchAll(linkRegex)) {
      if (results.length >= 8) break;
      const cleanUrl = unwrapDdgUrl(match[1]);
      const rawTitle = decodeHtmlEntities(match[2]);
      const snippet = snippets[idx] || '';
      idx += 1;
      if (!cleanUrl) continue;
      const siteInfo = detectSourceSite(cleanUrl);
      results.push({
        title: `[${siteInfo.name}] ${rawTitle.slice(0, 85)}`,
        source: siteInfo.name,
        trusted: siteInfo.trusted,
        snippet,
        url: cleanUrl
      });
    }
    return results;
  } catch {
    return [];
  }
}

async function searchWebReviewsDirect(title, brand) {
  const cleanQ = cleanProductQueryForSearch(title, brand);
  if (!cleanQ) return [];

  const qPrimary = `${cleanQ} отзывы цена (site:otzovik.com OR site:irecommend.ru OR site:vkusvill.ru OR site:perekrestok.ru OR site:ozon.ru OR site:rskrf.ru)`;
  const qFallback = `${cleanQ} отзывы покупателей цена`;

  const collected = [];
  const seen = new Set();

  try {
    const primaryHits = await parseDdgHtmlSearch(qPrimary);
    for (const item of primaryHits) {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        collected.push(item);
      }
    }
    if (collected.length < 3) {
      const fallbackHits = await parseDdgHtmlSearch(qFallback);
      fallbackHits.sort((a, b) => (a.trusted === b.trusted ? 0 : a.trusted ? -1 : 1));
      for (const item of fallbackHits) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          collected.push(item);
          if (collected.length >= 6) break;
        }
      }
    }
  } catch {
    // ignore network errors
  }

  return collected.slice(0, 6);
}

function buildPricingContext(payload, priceIntel = null) {
  let pricePerKg = payload.pricePerKg || null;
  let unitLabel = payload.unitLabel || 'кг';
  let pricePerPiece = payload.pricePerPiece || null;
  let pieceUnitLabel = payload.pieceUnitLabel || 'шт';
  let piecesCount = payload.piecesCount || null;
  const protein = payload.proteinPer100g ?? null;
  const proteinCost = payload.pricePer100gProtein ?? null;
  const price = payload.price ? Number(payload.price) : null;
  const amount = String(payload.amount || '').trim();

  if (!pricePerKg && !pricePerPiece && amount && price) {
    const multiMatch = amount.match(
      /(\d+)\s*(?:[×xх*]|шт\.?\s*по|пакет[а-я]*\s*по)\s*([\d.,]+)\s*(г|гр|грамм|кг|мл|л)(?![а-яёa-z])/i
    );
    if (multiMatch) {
      const cnt = parseInt(multiMatch[1], 10) || 1;
      const val = parseFloat(multiMatch[2].replace(',', '.'));
      const u = multiMatch[3].toLowerCase();
      unitLabel = u === 'мл' || u === 'л' ? 'л' : 'кг';
      const grams = cnt * (u === 'кг' || u === 'л' ? val * 1000 : val);
      if (grams > 0) pricePerKg = Math.round((price / grams) * 1000);
    } else {
      const singleMatch = amount.match(/([\d.,]+)\s*(г|гр|грамм|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i);
      if (singleMatch) {
        const val = parseFloat(singleMatch[1].replace(',', '.'));
        const u = singleMatch[2].toLowerCase();
        unitLabel = u.startsWith('мл') || u.startsWith('л') ? 'л' : 'кг';
        const grams = u.startsWith('кг') || u.startsWith('л') ? val * 1000 : val;
        if (grams > 0) pricePerKg = Math.round((price / grams) * 1000);
      } else {
        const pieceMatch = amount.match(
          /(\d+)\s*(шт|штук[а-я]*|пакет[а-я]*|капс[а-я]*|табл[а-я]*|рулон[а-я]*|порц[а-я]*|пар[а-я]*|уп[а-я]*)(?![а-яёa-z])/i
        );
        if (pieceMatch) {
          piecesCount = parseInt(pieceMatch[1], 10) || 1;
          if (piecesCount > 0) pricePerPiece = Math.round(price / piecesCount);
        }
      }
    }
  }

  const radarNotes = [];
  if (priceIntel) {
    if (priceIntel.guestPrice && price && priceIntel.guestPrice < price - 2) {
      radarNotes.push(`ВНИМАНИЕ: цена без куки (для гостя) ниже на ${Math.round(price - priceIntel.guestPrice)} ₽ (${priceIntel.guestPrice} ₽)`);
    }
    if (priceIntel.minPrice && price && priceIntel.minPrice < price - 2) {
      radarNotes.push(`минимальная цена в твоей базе была ${priceIntel.minPrice} ₽`);
    }
    if (priceIntel.competitorSummary) {
      radarNotes.push(`цены у конкурентов: ${priceIntel.competitorSummary}`);
    }
  }
  const radarSuffix = radarNotes.length ? ` | Радар цен: ${radarNotes.join('; ')}` : '';

  if (pricePerKg) {
    if (proteinCost && protein !== null && protein >= 3) {
      return {
        calcLine: `в пересчёте ~${pricePerKg} ₽/${unitLabel}; стоимость 100 г белка ~${proteinCost} ₽ (белка ${protein} г на 100 г)${radarSuffix}`,
        evalHint: `в пересчёте на 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel}), с учётом цены белка (~${proteinCost} ₽ за 100 г) и данных радара цен`,
        ruleLine: `Для этого товара рассчитана точная цена за 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel}) и за 100 г белка (~${proteinCost} ₽) — опирайся на эти цифры.`
      };
    }
    return {
      calcLine: `в пересчёте ~${pricePerKg} ₽/${unitLabel}${radarSuffix}`,
      evalHint: `в пересчёте на 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel}) и по данным радара цен`,
      ruleLine: `Для этого товара рассчитана точная цена за 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel}). Стоимость белка отдельно не оценивай, если это не белковый продукт.`
    };
  }

  if (pricePerPiece && piecesCount && piecesCount > 1) {
    return {
      calcLine: `поштучная фасовка (${piecesCount} ${pieceUnitLabel}) — ~${pricePerPiece} ₽ за 1 ${pieceUnitLabel}, вес в граммах не указан${radarSuffix}`,
      evalHint: `за 1 ${pieceUnitLabel} (~${pricePerPiece} ₽/${pieceUnitLabel}) и за упаковку`,
      ruleLine: `Товар продаётся поштучно (${piecesCount} ${pieceUnitLabel}, ~${pricePerPiece} ₽/${pieceUnitLabel}) без указания веса в граммах — НЕ пытайся считать цену за килограмм, оценивай выгоду за штуку/упаковку.`
    };
  }

  return {
    calcLine: `вес в граммах не указан (оценка за упаковку / 1 шт.)${radarSuffix}`,
    evalHint: 'за саму упаковку / штуку (без пересчёта за килограмм)',
    ruleLine: 'На карточке этого товара не указан вес в граммах или миллилитрах — НЕ пытайся выдумывать или требовать цену за килограмм, оценивай адекватность цены за саму штуку/упаковку.'
  };
}

function buildProductReviewPrompt(payload, webSources, isBrowserGeminiTab = false, priceIntel = null) {
  const sitesListStr = REVIEW_SEARCH_SITES.slice(0, 12)
    .map((s) => `${s.name} (${s.domain})`)
    .join(', ');

  let snippetsText = '';
  if (Array.isArray(webSources) && webSources.length > 0) {
    snippetsText = webSources
      .map((s) => `- ${s.title || 'Отзыв'} (${s.url || ''}): ${s.snippet || ''}`)
      .join('\n');
  } else if (isBrowserGeminiTab) {
    snippetsText =
      'Предварительный парсер не нашёл прямых сниппетов — пожалуйста, проверь наличие реальных отзывов и цен об этом товаре через поиск Google по площадкам выше. Если отзывов именно на этот товар нет — честно напиши об этом и оценивай строго по составу, КБЖУ и цене.';
  } else {
    snippetsText =
      'Прямых отзывов именно на этот товар в поисковой выдаче не найдено — честно сообщи об этом в 1-м пункте и оценивай товар строго по составу, КБЖУ и цене.';
  }

  const pricing = buildPricingContext(payload, priceIntel);
  const brandSuffix = payload.brand ? ` (Бренд: ${payload.brand})` : '';

  return [
    `Ты — опытный, внимательный и объективный продуктовый эксперт. Сделай короткий и понятный разбор товара из Яндекс Лавки (ровно 3 пункта, без воды, без молодёжного сленга и без выдумок — нормальным разговорным русским языком).`,
    ``,
    `Данные карточки товара:`,
    `• Название: ${payload.title}${brandSuffix}`,
    `• Фасовка и цена: ${payload.amount || 'не указана'}, Цена: ${payload.price || '?'} ₽ (${pricing.calcLine})`,
    `• Состав: ${payload.ingredients || 'не указан на странице'}`,
    `• КБЖУ на 100 г: ${payload.traits || 'не указано на странице'}`,
    ``,
    `Площадки для проверки отзывов и цен: ${sitesListStr}.`,
    `Найденные отзывы и цены в интернете:\n${snippetsText}`,
    ``,
    `СТРОГИЕ ПРАВИЛА ЧЕСТНОСТИ (ТОЛЬКО ФАКТЫ, БЕЗ ПРИДУМОК):`,
    `- Пиши ТОЛЬКО подтверждённые факты из реальных отзывов, состава, КБЖУ и цены.`,
    `- Если реальных отзывов именно об этом продукте нет — ЧЕСТНО напиши в 1-м пункте: «Отзывов именно на этот товар в сети не нашлось, поэтому оцениваю по составу и характеристикам». Категорически запрещено придумывать вкус, консистенцию или несуществующие мнения покупателей.`,
    `- ${pricing.ruleLine}`,
    ``,
    `Ответь ровно в 3 коротких пунктах (по 1–2 предложения в каждом), обычным живым русским языком без сленга:`,
    `1. **Отзывы и репутация**: что реально пишут покупатели на отзовиках и в магазинах (укажи площадки, если отзывы найдены), либо честно отметь, что отзывов в сети не найдено, и скажи, что сразу видно по характеристикам продукта.`,
    `2. **Состав, КБЖУ и честность цены**: фактический разбор состава (есть ли скрытый сахар, крахмал, ММО, заменители молочного жира, дешёвые наполнители или состав чистый) и насколько адекватна цена (${pricing.evalHint}).`,
    `3. **Вердикт**: выбери ОДНУ оценку на нормальном русском языке и кратко поясни вывод:`,
    `   • ✅ **Отличный выбор — стоит брать**`,
    `   • 👍 **Хороший вариант на каждый день (есть мелкие нюансы)**`,
    `   • ⚠️ **На любителя — есть компромиссы по составу или цене**`,
    `   • ❌ **Не рекомендую к покупке**`
  ].join('\n');
}

// ============================================================================
// 5. РАБОТА С ВКЛАДКОЙ GEMINI И КУКАМИ
// ============================================================================
async function inspectGeminiCookies() {
  try {
    const cookiesGemini = await chrome.cookies.getAll({ url: 'https://gemini.google.com/' });
    const cookiesGoogle = await chrome.cookies.getAll({ domain: 'google.com' });

    const map = new Map();
    [...cookiesGoogle, ...cookiesGemini].forEach((c) => {
      if (c && c.name && c.value) {
        map.set(c.name, c.value);
      }
    });

    const hasSession = map.has('__Secure-1PSID') || map.has('SID') || map.size > 3;
    const headerString = Array.from(map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    return {
      ok: hasSession,
      cookiesCount: map.size,
      hasSecure1PSID: map.has('__Secure-1PSID'),
      headerString
    };
  } catch (err) {
    return {
      ok: false,
      cookiesCount: 0,
      error: err.message || String(err),
      headerString: ''
    };
  }
}

async function detectTabAccountEmail(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const accNodes = document.querySelectorAll('a[aria-label*="@"], button[aria-label*="@"], img[alt*="@"]');
          for (const el of accNodes) {
            const label = el.getAttribute('aria-label') || el.getAttribute('alt') || '';
            const m = label.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
            if (m) return m[1];
          }
          const html = document.documentElement.innerHTML;
          const mEmail = html.match(/"([a-zA-Z0-9._%+-]+@(?:gmail\.com|googlemail\.com|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))"/);
          if (mEmail) return mEmail[1];
        } catch {
          // ignore
        }
        return null;
      }
    });
    return results && results[0] ? results[0].result : null;
  } catch {
    return null;
  }
}

function extractAccountIndexFromUrl(url) {
  if (!url) return '0';
  const m = String(url).match(/\/u\/(\d+)\b/);
  return m ? m[1] : '0';
}

function buildGeminiUrlForAccount(accountIndex) {
  if (accountIndex === undefined || accountIndex === null || accountIndex === 'auto' || accountIndex === '') {
    return 'https://gemini.google.com/app';
  }
  return `https://gemini.google.com/u/${accountIndex}/app`;
}

async function listOpenGeminiTabsWithAccounts() {
  const tabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*'] });
  const enriched = [];
  for (const t of tabs || []) {
    const accIdx = extractAccountIndexFromUrl(t.url);
    const email = t.id ? await detectTabAccountEmail(t.id) : null;
    enriched.push({
      tabId: t.id,
      url: t.url,
      title: t.title || 'Google Gemini',
      accountIndex: accIdx,
      email: email || null,
      active: Boolean(t.active),
      pinned: Boolean(t.pinned)
    });
  }
  return enriched;
}

async function findOpenGeminiTab(autoCreateIfMissing = false, makeActive = false) {
  const settings = await getSettings();
  const targetIdx = String(settings.geminiAccountIndex ?? 'auto');
  const preferredTabId = settings.preferredGeminiTabId ? Number(settings.preferredGeminiTabId) : null;

  const tabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*'] });
  if (tabs && tabs.length > 0) {
    if (preferredTabId) {
      const exactTab = tabs.find((t) => t.id === preferredTabId);
      if (exactTab) {
        if (makeActive) await chrome.tabs.update(exactTab.id, { active: true });
        return exactTab;
      }
    }
    if (targetIdx !== 'auto') {
      const matchingTab = tabs.find((t) => extractAccountIndexFromUrl(t.url) === targetIdx);
      if (matchingTab) {
        if (makeActive) await chrome.tabs.update(matchingTab.id, { active: true });
        return matchingTab;
      }
      if (autoCreateIfMissing) {
        return await createGeminiTab(buildGeminiUrlForAccount(targetIdx), makeActive);
      }
    }
    if (makeActive && tabs[0].id) {
      await chrome.tabs.update(tabs[0].id, { active: true });
    }
    return tabs[0];
  }

  if (!autoCreateIfMissing) {
    return null;
  }

  return await createGeminiTab(buildGeminiUrlForAccount(targetIdx), makeActive);
}

async function createGeminiTab(targetUrl, makeActive = false) {
  const created = await chrome.tabs.create({
    url: targetUrl,
    active: makeActive,
    pinned: !makeActive
  });
  await new Promise((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        resolve();
      }
    }, 6500);
    const listener = (tabId, info) => {
      if (tabId === created.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        if (!done) {
          done = true;
          clearTimeout(timeout);
          setTimeout(resolve, 1400);
        }
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return created;
}

async function ensureAutopilotWarmup(reason = 'auto') {
  const now = Date.now();
  if (isWarmingUp || now - lastWarmupCheckTs < 15000) return;
  lastWarmupCheckTs = now;
  isWarmingUp = true;

  try {
    const settings = await getSettings();
    if (settings.autoWarmupGeminiTab === false) return;

    const existingTab = await findOpenGeminiTab(false, false);
    if (existingTab) return;

    const aiBaseUrl = (settings.aiBaseUrl || '').replace(/\/$/, '');
    if (aiBaseUrl) {
      try {
        const headers = settings.aiApiKey ? { Authorization: `Bearer ${settings.aiApiKey}` } : {};
        const bridgeResp = await fetchWithTimeout(`${aiBaseUrl}/models`, { method: 'GET', headers }, 1000);
        if (bridgeResp.ok) return;
      } catch {
        // bridge offline
      }
    }

    const cookies = await inspectGeminiCookies();
    if (!cookies.ok) return;

    await findOpenGeminiTab(true, false);
    console.log(`[LQS Zero-Click Autopilot] Warmed up background Gemini tab (${reason})`);
  } catch {
    // ignore warmup errors
  } finally {
    isWarmingUp = false;
  }
}

async function executePromptInsideGeminiTab(tabId, promptText) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [promptText],
      func: async (prompt) => {
        try {
          const findEditor = () =>
            document.querySelector('rich-textarea div.ql-editor[contenteditable="true"]') ||
            document.querySelector('div[contenteditable="true"][role="textbox"]') ||
            document.querySelector('div[contenteditable="true"]') ||
            document.querySelector('textarea');

          let editor = findEditor();
          for (let waitTick = 0; !editor && waitTick < 25; waitTick++) {
            await new Promise((r) => setTimeout(r, 400));
            editor = findEditor();
          }

          if (!editor) {
            return {
              ok: false,
              error: 'На вкладке gemini.google.com не найдено поле ввода чата (убедись, что ты вошёл в аккаунт Google).'
            };
          }

          const responseSelector = 'message-content, model-response .markdown, .model-response-text';
          const initialNodes = document.querySelectorAll(responseSelector);
          const initialCount = initialNodes.length;
          const initialLastText = initialCount > 0 ? (initialNodes[initialCount - 1].innerText || '').trim() : '';

          editor.focus();
          if (editor.tagName === 'TEXTAREA') {
            editor.value = prompt;
            editor.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(range);
            const inserted = document.execCommand('insertText', false, prompt);
            if (!inserted) {
              editor.textContent = prompt;
              editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt }));
            }
          }

          await new Promise((r) => setTimeout(r, 350));

          const sendBtn =
            document.querySelector('button.send-button') ||
            document.querySelector('button[aria-label*="Send"]') ||
            document.querySelector('button[aria-label*="Отправить"]') ||
            document.querySelector('button.submit');

          if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
          } else {
            editor.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
            );
          }

          const isStillGenerating = () => {
            const stopBtn = document.querySelector(
              'button[aria-label*="Stop"], button[aria-label*="Остановить"], button[aria-label*="Прервать"], .stop-icon, mat-icon[data-mat-icon-name="stop"]'
            );
            if (stopBtn && stopBtn.offsetParent !== null) return true;
            const busyModels = document.querySelectorAll('model-response[aria-busy="true"], .response-streaming');
            return busyModels.length > 0;
          };

          let lastText = '';
          let stableTicks = 0;
          for (let i = 0; i < 75; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const nodes = document.querySelectorAll(responseSelector);
            if (nodes.length > 0) {
              const latestNode = nodes[nodes.length - 1];
              const currentText = (latestNode.innerText || '').trim();
              const isNew = nodes.length > initialCount || (currentText && currentText !== initialLastText);
              if (isNew && currentText.length > 25) {
                if (currentText === lastText && !isStillGenerating()) {
                  stableTicks += 1;
                  if (stableTicks >= 4) {
                    return {
                      ok: true,
                      mode: `Вкладка Gemini (${window.location.pathname})`,
                      text: currentText
                    };
                  }
                } else {
                  lastText = currentText;
                  stableTicks = 0;
                }
              }
            }
          }

          if (lastText && lastText.length > 25) {
            return {
              ok: true,
              mode: `Вкладка Gemini (${window.location.pathname})`,
              text: lastText
            };
          }

          return {
            ok: false,
            error: 'Вкладка Gemini не успела ответить за 37 секунд (проверь открытую вкладку gemini.google.com).'
          };
        } catch (domErr) {
          return {
            ok: false,
            error: `Ошибка в DOM вкладки Gemini: ${domErr.message || domErr}`
          };
        }
      }
    });

    const first = results && results[0] ? results[0].result : null;
    return first || { ok: false, error: 'Не удалось выполнить скрипт во вкладке Gemini.' };
  } catch (err) {
    return {
      ok: false,
      error: `Ошибка доступа к вкладке Gemini: ${err.message || err}`
    };
  }
}

function enqueueGeminiTabExecution(taskFn) {
  const next = geminiTabMutex.then(() => taskFn(), () => taskFn());
  geminiTabMutex = next.catch(() => {});
  return next;
}

async function checkAllConnections() {
  const settings = await getSettings();
  const cookieInfo = await inspectGeminiCookies();
  const openGeminiTabs = await listOpenGeminiTabsWithAccounts();
  const selectedTab = await findOpenGeminiTab(false, false);
  const localCacheMap = await getLocalAiCacheMap();
  const localCacheCount = Object.keys(localCacheMap).length;
  const priceDb = await getLocalPriceDb();
  const trackedPricesCount = Object.keys(priceDb).length;

  const backendUrl = settings.backendUrl.replace(/\/$/, '');
  const aiBaseUrl = settings.aiBaseUrl.replace(/\/$/, '');

  let backendStatus = { ok: false, cachedItems: 0, trackedPrices: trackedPricesCount, msg: 'Выкл (локальная БД)' };
  try {
    const r1 = await fetchWithTimeout(`${backendUrl}/api/health`, { method: 'GET' }, 1200);
    if (r1.ok) {
      const j = await r1.json().catch(() => ({}));
      backendStatus = {
        ok: true,
        cachedItems: j.cachedItems ?? 0,
        trackedPrices: j.trackedPrices ?? trackedPricesCount,
        msg: `ОК (кэш: ${j.cachedItems ?? 0}, цен: ${j.trackedPrices ?? 0})`
      };
    } else {
      backendStatus = { ok: false, cachedItems: 0, trackedPrices: trackedPricesCount, msg: `HTTP ${r1.status}` };
    }
  } catch {
    // offline
  }

  let bridgeStatus = { ok: false, msg: 'Выкл (работает вкладка)' };
  try {
    const headers = settings.aiApiKey ? { Authorization: `Bearer ${settings.aiApiKey}` } : {};
    const r2 = await fetchWithTimeout(`${aiBaseUrl}/models`, { method: 'GET', headers }, 1200);
    if (r2.ok) {
      bridgeStatus = { ok: true, msg: `ОК (${settings.aiModel})` };
    } else {
      bridgeStatus = { ok: false, msg: `HTTP ${r2.status} (проверь ключ)` };
    }
  } catch {
    // offline
  }

  const matchedTabInfo = selectedTab
    ? openGeminiTabs.find((t) => t.tabId === selectedTab.id) || {
        tabId: selectedTab.id,
        url: selectedTab.url,
        accountIndex: extractAccountIndexFromUrl(selectedTab.url),
        email: null
      }
    : null;

  return {
    ok: true,
    geminiTab: {
      found: Boolean(selectedTab),
      tabId: selectedTab ? selectedTab.id : null,
      url: selectedTab ? selectedTab.url : null,
      accountIndex: matchedTabInfo ? matchedTabInfo.accountIndex : null,
      email: matchedTabInfo ? matchedTabInfo.email : null
    },
    openGeminiTabs,
    cookies: {
      ok: cookieInfo.ok,
      count: cookieInfo.cookiesCount,
      hasSecure1PSID: cookieInfo.hasSecure1PSID,
      headerString: cookieInfo.headerString
    },
    backend: backendStatus,
    bridge: bridgeStatus,
    localAiCacheCount: localCacheCount,
    trackedPricesCount,
    settings
  };
}

async function saveVerdictToBackendCache(backendUrl, slug, title, verdict, sources) {
  try {
    await fetchWithTimeout(
      `${backendUrl}/api/save-cache`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: slug || title,
          title,
          verdict,
          sources: Array.isArray(sources) ? sources : []
        })
      },
      2500
    );
  } catch {
    // ignore if backend is offline
  }
}

async function orchestrateProductAnalysisInternal(payload) {
  const settings = await getSettings();
  const backendUrl = settings.backendUrl.replace(/\/$/, '');
  const aiBaseUrl = settings.aiBaseUrl.replace(/\/$/, '');
  const acc = payload.accountId || settings.lavkaAccountLabel || 'Аккаунт #1';

  // Сначала получаем разведку по ценам (включая проверку без куки и историю)
  let priceIntel = await getProductPriceIntelligence(
    payload.slug,
    payload.title,
    payload.price,
    payload.oldPrice,
    payload.amount,
    acc
  );

  // 0. Проверяем встроенный браузерный кэш ИИ
  if (!payload.forceRefresh) {
    const localCached = await getLocalAiCacheEntry(payload.slug, payload.title);
    if (localCached && localCached.verdict) {
      return {
        ok: true,
        cached: true,
        mode: `Кэш браузера (${localCached.mode || 'ИИ'})`,
        verdict: localCached.verdict,
        sources: localCached.sources || [],
        priceSummary: priceIntel
      };
    }
  }

  let webSources = [];
  let backendOnline = false;

  // 1. Запрашиваем локальный FastAPI (:8765)
  try {
    const resp = await fetchWithTimeout(
      `${backendUrl}/api/analyze-product`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          accountId: acc,
          guestPrice: priceIntel?.guestPrice || null,
          aiBaseUrl: settings.aiBaseUrl,
          aiApiKey: settings.aiApiKey,
          aiModel: settings.aiModel
        })
      },
      12000
    );

    if (resp.ok) {
      backendOnline = true;
      const data = await resp.json();
      if (Array.isArray(data.sources)) {
        webSources = data.sources;
      }
      if (data.priceSummary) {
        priceIntel = { ...(priceIntel || {}), ...data.priceSummary };
      }
      if (data.verdict && data.aiOk !== false && !data.verdict.startsWith('⚠️')) {
        const modeLabel = data.cached ? 'FastAPI SQLite Cache (:8765)' : `FastAPI (:8765) + ${settings.aiModel}`;
        await saveLocalAiCacheEntry(payload.slug, payload.title, data.verdict, webSources, modeLabel);
        return {
          ok: true,
          cached: Boolean(data.cached),
          mode: modeLabel,
          verdict: data.verdict,
          sources: webSources,
          priceSummary: priceIntel
        };
      }
    }
  } catch {
    // FastAPI (:8765) выключен — работаем автономно
  }

  // 1b. Автономный поиск отзывов и цен конкурентов в DuckDuckGo
  if (!webSources || webSources.length === 0) {
    webSources = await searchWebReviewsDirect(payload.title, payload.brand);
  }

  const comp = extractCompetitorPricesFromSources(webSources, payload.price);
  if (comp.competitorMinPrice || comp.competitorSummary) {
    const updatedMap = await recordPricesBatch(acc, [
      {
        slug: payload.slug,
        title: payload.title,
        price: payload.price || 0,
        oldPrice: payload.oldPrice || null,
        amount: payload.amount || '',
        competitorMinPrice: comp.competitorMinPrice,
        competitorSummary: comp.competitorSummary
      }
    ]);
    const cleanSlug = String(payload.slug || '').trim().toLowerCase();
    if (updatedMap[cleanSlug]) {
      priceIntel = updatedMap[cleanSlug];
    }
  }

  // 2. Пробуем прямой запрос в мост (:8083 / DeepSeek / Ollama)
  try {
    const promptForBridge = buildProductReviewPrompt(payload, webSources, false, priceIntel);
    const headers = { 'Content-Type': 'application/json' };
    if (settings.aiApiKey) {
      headers.Authorization = `Bearer ${settings.aiApiKey}`;
    }
    const directResp = await fetchWithTimeout(
      `${aiBaseUrl}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.aiModel || 'gemini-4-argon',
          messages: [{ role: 'user', content: promptForBridge }],
          temperature: 0.2
        })
      },
      12000
    );

    if (directResp.ok) {
      const json = await directResp.json();
      const reply = json.choices?.[0]?.message?.content;
      if (reply) {
        const cleanReply = reply.trim();
        const modeLabel = `Мост ${settings.aiModel} (${aiBaseUrl})`;
        await saveLocalAiCacheEntry(payload.slug, payload.title, cleanReply, webSources, modeLabel);
        if (backendOnline) {
          saveVerdictToBackendCache(backendUrl, payload.slug, payload.title, cleanReply, webSources);
        }
        return {
          ok: true,
          cached: false,
          mode: modeLabel,
          verdict: cleanReply,
          sources: webSources,
          priceSummary: priceIntel
        };
      }
    }
  } catch {
    // мост :8083 выключен
  }

  // 3. Автопилот через вкладку Gemini
  return await enqueueGeminiTabExecution(async () => {
    const geminiTab = await findOpenGeminiTab(true, false);
    if (geminiTab && geminiTab.id) {
      const email = await detectTabAccountEmail(geminiTab.id);
      const accIdx = extractAccountIndexFromUrl(geminiTab.url);
      const promptForTab = buildProductReviewPrompt(payload, webSources, true, priceIntel);
      const tabResult = await executePromptInsideGeminiTab(geminiTab.id, promptForTab);
      if (tabResult && tabResult.ok && tabResult.text) {
        const accLabel = email ? `${email} (/u/${accIdx})` : `/u/${accIdx}`;
        const modeLabel = `Вкладка Gemini [${accLabel}]`;
        await saveLocalAiCacheEntry(payload.slug, payload.title, tabResult.text, webSources, modeLabel);
        if (backendOnline) {
          saveVerdictToBackendCache(backendUrl, payload.slug, payload.title, tabResult.text, webSources);
        }
        return {
          ok: true,
          cached: false,
          mode: modeLabel,
          verdict: tabResult.text,
          sources: webSources,
          priceSummary: priceIntel
        };
      }
      return {
        ok: false,
        mode: 'Gemini Tab Error',
        error:
          tabResult && tabResult.error
            ? tabResult.error
            : 'Не удалось получить ответ от вкладки gemini.google.com.',
        sources: webSources,
        priceSummary: priceIntel
      };
    }

    return {
      ok: false,
      mode: 'All AI methods unreachable',
      error: 'Не удалось найти или открыть вкладку gemini.google.com и локальный мост :8083 выключен.',
      sources: webSources,
      priceSummary: priceIntel
    };
  });
}

async function orchestrateProductAnalysis(payload) {
  const key = normalizeCacheKey(payload.slug, payload.title);
  if (key && !payload.forceRefresh && inFlightRequests.has(key)) {
    return inFlightRequests.get(key);
  }
  const promise = orchestrateProductAnalysisInternal(payload).finally(() => {
    if (key) inFlightRequests.delete(key);
  });
  if (key) {
    inFlightRequests.set(key, promise);
  }
  return promise;
}

// ============================================================================
// 6. СОБЫТИЯ ЖИЗНЕННОГО ЦИКЛА И ОБРАБОТЧИК СООБЩЕНИЙ
// ============================================================================
chrome.runtime.onInstalled.addListener(() => {
  ensureAutopilotWarmup('onInstalled');
});

chrome.runtime.onStartup.addListener(() => {
  ensureAutopilotWarmup('onStartup');
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab && tab.url && tab.url.startsWith('https://lavka.yandex.ru/')) {
    ensureAutopilotWarmup('lavka-tab-opened');
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'LQS_ANALYZE_PRODUCT') {
    orchestrateProductAnalysis(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_RECORD_PRICES') {
    recordPricesBatch(msg.accountId, msg.items || [])
      .then((summaries) => sendResponse({ ok: true, summaries }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_PRICE_INTEL') {
    getProductPriceIntelligence(msg.slug, msg.title, msg.price, msg.oldPrice, msg.amount, msg.accountId)
      .then((summary) => sendResponse({ ok: Boolean(summary), summary }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SAVE_CART_SNAPSHOT') {
    saveCartSnapshot(msg.accountId, msg.items || [], msg.totalPrice || 0)
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_SAVED_CARTS') {
    getSavedCartsState()
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_COMPARE_CART_PRICES') {
    compareSavedCartOnCurrentAccount(msg.accountId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_AUTO_BUILD_CART') {
    autoBuildCartInBrowser(msg.items || null)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_CACHED_AI_VERDICT') {
    getLocalAiCacheEntry(msg.slug, msg.title)
      .then((entry) => sendResponse({ ok: Boolean(entry), entry: entry || null }))
      .catch(() => sendResponse({ ok: false, entry: null }));
    return true;
  }

  if (msg.type === 'LQS_CLEAR_AI_CACHE') {
    clearLocalAiCache()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_WARMUP_AUTOPILOT') {
    ensureAutopilotWarmup('content-script-boot')
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'LQS_CHECK_AI_STATUS') {
    checkAllConnections()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SELECT_GEMINI_ACCOUNT') {
    (async () => {
      try {
        const patch = {
          geminiAccountIndex: msg.accountIndex ?? 'auto',
          preferredGeminiTabId: msg.preferredTabId ? Number(msg.preferredTabId) : null
        };
        await saveSettingsPatch(patch);
        let tab = null;
        if (msg.openOrFocusTab) {
          if (patch.preferredGeminiTabId) {
            tab = await chrome.tabs
              .update(patch.preferredGeminiTabId, { active: Boolean(msg.makeActive) })
              .catch(() => null);
          } else {
            const targetUrl = buildGeminiUrlForAccount(patch.geminiAccountIndex);
            const existing = await findOpenGeminiTab(false, Boolean(msg.makeActive));
            tab = existing || (await createGeminiTab(targetUrl, Boolean(msg.makeActive)));
          }
        }
        const status = await checkAllConnections();
        sendResponse({ ok: true, tab, status });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'LQS_AUTO_CONNECT_GEMINI_TAB') {
    (async () => {
      try {
        if (msg.accountIndex !== undefined || msg.preferredTabId !== undefined) {
          await saveSettingsPatch({
            geminiAccountIndex: msg.accountIndex ?? 'auto',
            preferredGeminiTabId: msg.preferredTabId ? Number(msg.preferredTabId) : null
          });
        }
        const existingTab = await findOpenGeminiTab(false, false);
        const tab = existingTab || (await findOpenGeminiTab(true, false));
        const email = tab && tab.id ? await detectTabAccountEmail(tab.id) : null;
        const cookies = await inspectGeminiCookies();
        const status = await checkAllConnections();
        sendResponse({
          ok: Boolean(tab),
          wasAlreadyOpen: Boolean(existingTab),
          tabOpened: Boolean(tab),
          tabId: tab ? tab.id : null,
          accountIndex: tab ? extractAccountIndexFromUrl(tab.url) : '0',
          email: email || null,
          cookiesOk: cookies.ok,
          cookiesCount: cookies.cookiesCount,
          status
        });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err.message || String(err)
        });
      }
    })();
    return true;
  }

  if (msg.type === 'LQS_GET_GEMINI_COOKIE_HEADER') {
    inspectGeminiCookies()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  return false;
});
