/**
 * Lavka Quality Shield v2.7.0 — Background Service Worker
 * Что нового и исправлено в v2.7.0:
 * 1. МАТРИЦА ЦЕН 16 КРУПНЕЙШИХ МАГАЗИНОВ + НАТИВНЫЙ ПАРСЕР МАГНИТА (`magnit.ru` по Site Recon):
 *    - Подключены 16 торговых сетей: Магнит, Пятёрочка, Перекрёсток, ВкусВилл, Магнолия, Дикси, Чижик,
 *      Ашан, МЕТРО, Глобус, Лента, О’КЕЙ, Азбука Вкуса, Самокат, Ozon Fresh, Купер / Яндекс Маркет.
 *    - Внедрена база внешних цен сетей (`lqs_ext_store_prices_v1`) + нативный сборщик цен с `magnit.ru`
 *      (`article.unit-catalog-product-preview`, `a.pl-hover-base`, `/ecom/cart`, `#__NUXT_DATA__`, `/webgate/v2/goods/...`)
 *      и живой парсер карточек ВкусВилл (`vkusvill.ru/search/?q=...`) + DuckDuckGo Multi-Store Search.
 * 2. НАДЁЖНОЕ ЧТЕНИЕ ОТВЕТА ИЗ ФОНОВОЙ ВКЛАДКИ GEMINI (`executePromptInsideGeminiTab` v2.6.0):
 *    - Устранён баг, когда ИИ-обзор уже виден во вкладке Gemini, но не появляется на странице товара Лавки.
 *    - Поллинг вынесен из засыпающей фоновой вкладки в Service Worker (короткими импульсами по 800 мс),
 *      а чтение текста переведено с зависящего от вьюпорта `.innerText` на layout-независимый DOM-обходчик
 *      (`extractCleanResponseText`), который читает ответ даже из неактивной/свёрнутой вкладки!
 *    - Добавлен мгновенный перехват уже готового ответа со страницы Gemini (за 0.1 сек без повторного ввода промпта!).
 * 3. ИСПРАВЛЕНО СВОРАЧИВАНИЕ РАЗВЁРНУТОГО ОПИСАНИЯ (СПОЙЛЕРА) НА СТРАНИЦЕ ТОВАРА:
 *    - Ручное закрытие спойлера (`▴ Скрыть`) теперь запоминается в `userManualDrawerStateBySlug` и никогда
 *      самопроизвольно не раскрывается обратно при фоновых синхронизациях DOM.
 */

'use strict';

importScripts('shared/config.js', 'shared/price-parser.js', 'shared/utils.js', 'shared/product-matcher.js');
importScripts('bg/accounts-vault.js');
importScripts('bg/gemini-tab.js');
importScripts('bg/price-radar.js');
importScripts('bg/ai-providers.js');

const {
  fetchWithTimeout,
  getSettings,
  saveSettingsPatch,
  buildFullProductSearchQuery,
  buildDirectStoreSearchLinks
} = globalThis.LQS_UTILS;

const {
  SUGAR_FREE_REGEX,
  FLAVOR_AND_TYPE_MODIFIERS,
  GENERIC_STOP_WORDS,
  normalizeTitleKey,
  parseVolumeOrWeightGrams,
  normalizeSynonymTokens,
  isSearchResultMatchingProduct,
  decodeHtmlEntities
} = globalThis.LQS_MATCHER;


const {
  fetchBackendAccountSecrets,
  getAccountsVaultMap,
  getAccountsVaultStatus,
  saveAccountToVault,
  deleteAccountFromVault,
  autofillYandexPassportTab,
  switchLavkaAccountInOneClick,
  logoutToCleanLavkaSession
} = globalThis.LQS_ACCOUNTS_VAULT;

const {
  inspectGeminiCookies,
  detectTabAccountEmail,
  extractAccountIndexFromUrl,
  buildGeminiUrlForAccount,
  listOpenGeminiTabsWithAccounts,
  findOpenGeminiTab,
  createGeminiTab,
  ensureAutopilotWarmup,
  executePromptInsideGeminiTab,
  enqueueGeminiTabExecution
} = globalThis.LQS_GEMINI_TAB;

const {
  isCaptchaOrBlockHtml,
  isCircuitOpen,
  recordCircuitSuccess,
  recordCircuitFailure,
  resetCircuitBreakers,
  getRadar16StoresStatus,
  getLocalPriceDb,
  findPriceEntryInDb,
  recordPricesBatch,
  parseFullProductCardFromLavkaHtml,
  getProductPriceIntelligence,
  getExternalStoreOffersList,
  recordExternalStoreOffers,
  findMatchingExternalStoreOffersFromList,
  mergeUniqueStoreOffers,
  auditCartCompetitorsAndAccounts,
  scanStoresInBackgroundTabs
} = globalThis.LQS_PRICE_RADAR;

const {
  AI_DIRECT_TIMEOUT_MS,
  normalizeUsageLedger,
  checkPaidAiDailyLimit,
  recordPaidAiUsage,
  resolveProviderConfig,
  formatCostUsd,
  fetchProviderModelsList,
  testProviderConnection,
  callAiProvider
} = globalThis.LQS_AI_PROVIDERS;

const { STORAGE_KEYS, LIMITS, CLIENT_HEADER: LQS_CLIENT_HEADER, TOKEN_HEADER_NAME = 'X-LQS-Token' } = globalThis.LQS_CONFIG;
const AI_CACHE_KEY = STORAGE_KEYS.AI_CACHE;
const AI_USAGE_KEY = STORAGE_KEYS.AI_USAGE || 'lqs_ai_usage_v1';
const SAVED_CARTS_KEY = STORAGE_KEYS.SAVED_CARTS;
const BACKEND_TOKEN_KEY = STORAGE_KEYS.BACKEND_TOKEN || 'lqs_backend_token_v1';

const MAX_LOCAL_AI_CACHE_ITEMS = LIMITS.MAX_LOCAL_AI_CACHE_ITEMS;

const REVIEW_SEARCH_SITES = [
  { domain: 'otzovik.com', name: 'Отзовик' },
  { domain: 'irecommend.ru', name: 'IRecommend' },
  { domain: 'rskrf.ru', name: 'Роскачество' },
  { domain: 'roscontrol.com', name: 'Росконтроль' },
  { domain: 'magnit.ru', name: 'Магнит' },
  { domain: '5ka.ru', name: 'Пятёрочка' },
  { domain: 'perekrestok.ru', name: 'Перекрёсток' },
  { domain: 'vprok.ru', name: 'Перекрёсток Впрок' },
  { domain: 'vkusvill.ru', name: 'ВкусВилл' },
  { domain: 'auchan.ru', name: 'Ашан' },
  { domain: 'metro-cc.ru', name: 'МЕТРО' },
  { domain: 'globus.ru', name: 'Глобус' },
  { domain: 'lenta.com', name: 'Лента' },
  { domain: 'mgnl.ru', name: 'Магнолия' },
  { domain: 'dixy.ru', name: 'Дикси' },
  { domain: 'chizhik.club', name: 'Чижик' },
  { domain: 'okeydostavka.ru', name: 'О’КЕЙ' },
  { domain: 'av.ru', name: 'Азбука Вкуса' },
  { domain: 'samokat.ru', name: 'Самокат' },
  { domain: 'ozon.ru', name: 'Ozon' },
  { domain: 'market.yandex.ru', name: 'Яндекс Маркет' },
  { domain: 'wildberries.ru', name: 'Wildberries' },
  { domain: 'kuper.ru', name: 'Купер' },
  { domain: 'sbermarket.ru', name: 'СберМаркет' },
  { domain: 'eda.yandex.ru', name: 'Яндекс Лавка / Еда' }
];

const inFlightRequests = new Map();
let latestRequestedProductKey = '';

let backendOfflineUntilTs = 0;
let bridgeOfflineUntilTs = 0;

let swKeepAliveActiveTasks = 0;
let swKeepAliveTimer = null;

function startSwKeepAlive() {
  swKeepAliveActiveTasks += 1;
  if (!swKeepAliveTimer) {
    swKeepAliveTimer = setInterval(() => {
      if (swKeepAliveActiveTasks <= 0 && inFlightRequests.size === 0) {
        clearInterval(swKeepAliveTimer);
        swKeepAliveTimer = null;
        return;
      }
      try {
        chrome.runtime.getPlatformInfo(() => {
          if (chrome.runtime.lastError) {
            // ignore
          }
        });
      } catch {
        // ignore
      }
    }, 20000);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    swKeepAliveActiveTasks = Math.max(0, swKeepAliveActiveTasks - 1);
    if (swKeepAliveActiveTasks === 0 && inFlightRequests.size === 0 && swKeepAliveTimer) {
      clearInterval(swKeepAliveTimer);
      swKeepAliveTimer = null;
    }
  };
}

async function getStoredBackendToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get([BACKEND_TOKEN_KEY], (res) => {
      resolve(typeof res?.[BACKEND_TOKEN_KEY] === 'string' ? res[BACKEND_TOKEN_KEY].trim() : '');
    });
  });
}

async function saveStoredBackendToken(token) {
  const clean = String(token || '').trim();
  return new Promise((resolve) => {
    chrome.storage.local.set({ [BACKEND_TOKEN_KEY]: clean }, () => resolve(clean));
  });
}

let pairingInFlightPromise = null;

async function ensureBackendPairedToken(backendUrl) {
  const existing = await getStoredBackendToken();
  if (existing) return existing;
  const cleanUrl = (backendUrl || '').replace(/\/$/, '');
  if (!cleanUrl || Date.now() < backendOfflineUntilTs) return '';
  if (pairingInFlightPromise) return pairingInFlightPromise;

  pairingInFlightPromise = (async () => {
    try {
      const r = await fetchWithTimeout(
        `${cleanUrl}/api/auth/pair`,
        { method: 'POST', headers: { ...LQS_CLIENT_HEADER } },
        1500
      );
      if (r.ok) {
        const data = await r.json();
        if (data && data.token) {
          return await saveStoredBackendToken(data.token);
        }
      }
    } catch {
      backendOfflineUntilTs = Date.now() + 10000;
    } finally {
      pairingInFlightPromise = null;
    }
    return '';
  })();
  return pairingInFlightPromise;
}

async function getBackendAuthHeaders(backendUrl, extraHeaders = {}) {
  const token = await ensureBackendPairedToken(backendUrl);
  const headers = { ...LQS_CLIENT_HEADER, ...extraHeaders };
  if (token) {
    headers[TOKEN_HEADER_NAME] = token;
  }
  return headers;
}

async function fetchAiModelsList(aiBaseUrl, aiApiKey = '', aiProvider = '') {
  const cleanUrl = String(aiBaseUrl || '').trim().replace(/\/$/, '');
  if (!cleanUrl && !aiProvider) return [];
  const provider = aiProvider || (cleanUrl ? 'custom_openai' : 'gemini_tab');
  return await fetchProviderModelsList({ aiProvider: provider, aiBaseUrl: cleanUrl, aiApiKey });
}

function normalizeCacheKey(slug, title) {
  return String(slug || title || '')
    .trim()
    .toLowerCase();
}


function extractImageKeyFromUrl(src) {
  if (!src) return null;
  const m = String(src).match(/get-grocery-goods\/(\d+\/[a-f0-9-]+)/i);
  return m ? m[1].toLowerCase() : null;
}


// ============================================================================
// 1. ВСТРОЕННЫЙ КЭШ ИИ-ОБЗОРОВ (lqs_ai_cache_v1)
// ============================================================================
async function getAiUsageLedger() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AI_USAGE_KEY], (res) => {
      resolve(normalizeUsageLedger(res?.[AI_USAGE_KEY] || {}));
    });
  });
}

async function saveAiUsageLedger(ledger) {
  const normalized = normalizeUsageLedger(ledger);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [AI_USAGE_KEY]: normalized }, () => resolve(normalized));
  });
}

async function getAiUsageStatsWithLimit() {
  const [settings, ledger] = await Promise.all([getSettings(), getAiUsageLedger()]);
  const dailyLimit = Number.isFinite(Number(settings.paidAiDailyLimit))
    ? Math.max(0, Math.floor(Number(settings.paidAiDailyLimit)))
    : (LIMITS.DEFAULT_PAID_AI_DAILY_LIMIT || 25);
  return { ok: true, ...ledger, dailyLimit };
}

async function getLocalAiCacheMap() {
  return new Promise((resolve) => {
    chrome.storage.local.get([AI_CACHE_KEY], (res) => {
      resolve(res && res[AI_CACHE_KEY] && typeof res[AI_CACHE_KEY] === 'object' ? res[AI_CACHE_KEY] : {});
    });
  });
}

async function getLocalAiCacheEntry(slug, title, imageKey = null) {
  const key = normalizeCacheKey(slug, title);
  const normTitle = normalizeTitleKey(title);
  const map = await getLocalAiCacheMap();

  let entry = key ? map[key] : null;
  if (!entry && imageKey) {
    entry = Object.values(map).find(
      (e) => e && e.verdict && !String(e.verdict).startsWith('⚠️') && e.imageKey === imageKey
    );
  }
  if (!entry && normTitle && normTitle.length >= 4) {
    entry = Object.values(map).find(
      (e) => e && e.verdict && !String(e.verdict).startsWith('⚠️') && normalizeTitleKey(e.title) === normTitle
    );
  }

  if (entry && entry.verdict && !String(entry.verdict).startsWith('⚠️')) {
    const refTitle = entry.title || title || '';
    const filteredSources = Array.isArray(entry.sources) && refTitle
      ? entry.sources.filter((s) => isSearchResultMatchingProduct(s.title, s.snippet, refTitle, '').isSameProduct)
      : (entry.sources || []);
    return {
      ...entry,
      sources: filteredSources
    };
  }
  return null;
}

async function saveLocalAiCacheEntry(slug, title, verdict, sources, mode, imageKey = null) {
  const key = normalizeCacheKey(slug, title);
  if (!key || !verdict || String(verdict).startsWith('⚠️')) return null;
  const normTitle = normalizeTitleKey(title);
  const map = await getLocalAiCacheMap();
  const nowIso = new Date().toISOString();

  const record = {
    slug: key,
    title: title || key,
    cleanTitle: normTitle,
    imageKey: imageKey || null,
    verdict: String(verdict).trim(),
    sources: Array.isArray(sources) ? sources : [],
    mode: mode || 'Автопилот ИИ',
    updatedAt: nowIso
  };

  map[key] = record;

  if (normTitle && normTitle.length >= 4) {
    for (const [k, v] of Object.entries(map)) {
      if (k !== key && v && (normalizeTitleKey(v.title) === normTitle || (imageKey && v.imageKey === imageKey))) {
        map[k] = { ...record, slug: k };
      }
    }
  }

  const keys = Object.keys(map);
  if (keys.length > MAX_LOCAL_AI_CACHE_ITEMS) {
    keys
      .sort((a, b) => String(map[a]?.updatedAt || '').localeCompare(String(map[b]?.updatedAt || '')))
      .slice(0, keys.length - MAX_LOCAL_AI_CACHE_ITEMS)
      .forEach((oldKey) => delete map[oldKey]);
  }

  return new Promise((resolve) => {
    chrome.storage.local.set({ [AI_CACHE_KEY]: map }, () => resolve(record));
  });
}

async function clearLocalAiCache() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([AI_CACHE_KEY], () => resolve(true));
  });
}

async function broadcastAiVerdictToLavkaTabs(slug, title, resultObj) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
    for (const t of tabs || []) {
      if (!t.id) continue;
      chrome.tabs.sendMessage(
        t.id,
        {
          type: 'LQS_AI_VERDICT_READY',
          slug: normalizeCacheKey(slug, title),
          cleanTitle: normalizeTitleKey(title),
          result: resultObj
        },
        () => {
          if (chrome.runtime.lastError) {
            // ignore
          }
        }
      );
    }
  } catch {
    // ignore
  }
}

// ============================================================================
// 2. МЕНЕДЖЕР АККАУНТОВ ЛАВКИ (вынесен в extension/bg/accounts-vault.js)
// ============================================================================

// ============================================================================
// 3. МУЛЬТИ-АККАУНТ БАЗА ИСТОРИИ ЦЕН И РАДАР 16 СЕТЕЙ (вынесены в extension/bg/price-radar.js)
// ============================================================================

// ============================================================================
// 4. КЛОНИРОВАНИЕ, СВЕРКА И АВТО-СБОРКА КОРЗИНЫ МЕЖДУ АККАУНТАМИ
// ============================================================================
async function getSavedCartsState() {
  const settings = await getSettings();
  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');

  const localState = await new Promise((resolve) => {
    chrome.storage.local.get([SAVED_CARTS_KEY], (res) => {
      resolve(res && res[SAVED_CARTS_KEY] ? res[SAVED_CARTS_KEY] : { latest: null, byAccount: {} });
    });
  });

  if (backendUrl && Date.now() > backendOfflineUntilTs) {
    try {
      const r = await fetchWithTimeout(
        `${backendUrl}/api/cart/latest`,
        { method: 'GET', headers: await getBackendAuthHeaders(backendUrl) },
        1200
      );
      if (r.ok) {
        const j = await r.json();
        if (j && j.latest) {
          const byAcc = { ...(localState.byAccount || {}) };
          if (Array.isArray(j.cartsByAccount)) {
            j.cartsByAccount.forEach((c) => {
              if (c && c.accountId) byAcc[c.accountId] = c;
            });
          }
          const srvTime = String(j.latest.updatedAt || '');
          const locTime = String(localState.latest?.updatedAt || '');
          const bestLatest = locTime > srvTime ? localState.latest : j.latest;
          const merged = { latest: bestLatest, byAccount: byAcc };
          chrome.storage.local.set({ [SAVED_CARTS_KEY]: merged });
          return merged;
        }
      }
    } catch {
      backendOfflineUntilTs = Date.now() + 10000;
    }
  }

  return localState;
}

async function saveCartSnapshot(accountId, items, totalPrice = 0) {
  const settings = await getSettings();
  const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1';
  const priceDb = await getLocalPriceDb();

  // Обогащаем позиции корзины полными названиями из оригинальных карточек товаров, если они уже есть в базе
  const cleanItems = (Array.isArray(items) ? items : [])
    .filter((i) => i && i.slug)
    .map((i) => {
      const existing = findPriceEntryInDb(priceDb, i.slug, i.title, i.imageKey);
      const bestTitle = existing?.isCanonicalCardTitle ? existing.title : i.title;
      return {
        ...i,
        title: bestTitle || i.title,
        amount: existing?.amount || i.amount || '',
        imageKey: i.imageKey || existing?.imageKey || null
      };
    });

  const calcTotal = Math.round(cleanItems.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 1), 0));
  const totalUnits = cleanItems.reduce((sum, i) => sum + (Number(i.qty) || 1), 0);
  const finalTotal = totalPrice > 0 ? Math.round(totalPrice) : calcTotal;
  const nowIso = new Date().toISOString();

  const snapshot = {
    accountId: acc,
    items: cleanItems,
    totalUnits,
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

  await recordPricesBatch(
    acc,
    cleanItems.map((i) => ({
      slug: i.slug,
      title: i.title,
      isCanonicalCardTitle: false, // из корзины не перезаписываем эталонный заголовок карточки!
      imageKey: i.imageKey || null,
      price: i.price,
      oldPrice: i.oldPrice,
      amount: i.amount
    }))
  );

  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  if (backendUrl && Date.now() > backendOfflineUntilTs) {
    try {
      await fetchWithTimeout(
        `${backendUrl}/api/cart/save`,
        {
          method: 'POST',
          headers: await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            accountId: acc,
            items: cleanItems,
            totalPrice: finalTotal
          })
        },
        1800
      );
    } catch {
      backendOfflineUntilTs = Date.now() + 10000;
    }
  }

  return snapshot;
}

async function compareSavedCartOnCurrentAccount(targetAccountId) {
  const stopKeepAlive = startSwKeepAlive();
  try {
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
    const batchToRecord = [];

    for (const item of latest.items) {
      const slug = String(item.slug || '').trim().toLowerCase();
      const qty = Number(item.qty) || 1;
      const sourcePrice = Number(item.price) || 0;
      const existingEntry = findPriceEntryInDb(priceDb, slug, item.title, item.imageKey);

      let currentPrice = null;
      let cardTitle = existingEntry?.isCanonicalCardTitle ? existingEntry.title : (item.title || slug);
      let isCanonical = Boolean(existingEntry?.isCanonicalCardTitle);

      try {
        const url = `https://lavka.yandex.ru/good/${encodeURIComponent(slug)}`;
        const resp = await fetchWithTimeout(url, { method: 'GET', credentials: 'include', cache: 'no-store' }, 3800);
        if (resp.ok) {
          const html = await resp.text();
          const parsed = parseFullProductCardFromLavkaHtml(html);
          if (parsed) {
            if (parsed.price > 0) currentPrice = parsed.price;
            if (parsed.cardTitle) {
              cardTitle = buildFullProductSearchQuery(parsed.cardTitle, parsed.cardBrand || '', parsed.cardAmount || item.amount || '');
              isCanonical = true;
            }
          }
        }
      } catch {
        // fallback to priceDb
      }

      if (!currentPrice) {
        currentPrice = existingEntry?.accounts?.[currentAcc]?.price || sourcePrice;
      }

      const effCurrent = currentPrice || sourcePrice;

      sourceTotal += sourcePrice * qty;
      currentTotal += effCurrent * qty;

      if (currentPrice) {
        batchToRecord.push({
          slug,
          title: cardTitle,
          isCanonicalCardTitle: isCanonical,
          imageKey: item.imageKey || existingEntry?.imageKey || null,
          price: currentPrice,
          amount: item.amount || existingEntry?.amount || ''
        });
      }

      comparedItems.push({
        slug,
        title: cardTitle,
        qty,
        sourcePrice,
        currentPrice: effCurrent,
        diffPerUnit: effCurrent - sourcePrice,
        diffTotal: (effCurrent - sourcePrice) * qty,
        accounts: existingEntry?.accounts || {}
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
      diffTotal: Math.round(currentTotal - sourceTotal),
      items: comparedItems,
      updatedAt: new Date().toISOString()
    };
  } finally {
    stopKeepAlive();
  }
}

async function waitForTabCompleteSafe(tabId, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;

    const cleanup = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };

    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        cleanup();
        setTimeout(resolve, 650);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
  });
}

async function addSingleItemOnTab(tabId, item) {
  const desiredQty = Math.max(1, Math.min(30, Number(item.qty) || 1));
  const targetSlug = String(item.slug || '').trim().toLowerCase();
  const targetUrl = `https://lavka.yandex.ru/good/${encodeURIComponent(targetSlug)}`;

  await chrome.tabs.update(tabId, { url: targetUrl });
  await waitForTabCompleteSafe(tabId, 6500);

  try {
    const execRes = await chrome.scripting.executeScript({
      target: { tabId },
      args: [targetSlug, desiredQty],
      func: async (expectedSlug, qtyToSet) => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        window.__lqsAutoBuilding = true;

        try {
          let mainScope = null;
          for (let tick = 0; tick < 26; tick++) {
            const pathNow = decodeURIComponent(window.location.pathname || '').toLowerCase();
            const mainEl = document.querySelector('main[data-testid="good-page-desktop"]') || document.querySelector('main');
            const titleEl = document.querySelector('h1[data-testid="product-title"]') || (mainEl && mainEl.querySelector('h1'));
            if (mainEl && titleEl && (!expectedSlug || pathNow.includes(expectedSlug.slice(0, 16)))) {
              mainScope =
                mainEl.querySelector('div[data-testid="product-info"]') ||
                mainEl.querySelector('div[data-testid="product-card-header"]') ||
                mainEl;
              break;
            }
            await wait(250);
          }

          if (!mainScope) {
            return { ok: false, addedUnits: 0, reason: 'Не удалось дождаться загрузки страницы товара' };
          }

          const barScope = mainScope.querySelector('div[data-testid="bar-container"]') || mainScope;

          const readCurrentQtyInStepper = () => {
            const containers = [barScope, mainScope];
            for (const root of containers) {
              if (!root) continue;
              const candidates = root.querySelectorAll('span, div, input');
              for (const el of candidates) {
                if (el.closest('.lqs-product-panel') || el.closest('div[data-testid="product-card"]')) continue;
                const txt = (el.tagName === 'INPUT' ? el.value : el.textContent || '').trim();
                if (/^\d{1,2}$/.test(txt)) {
                  const parent = el.parentElement;
                  const grand = parent ? parent.parentElement : null;
                  const btnsInParent = parent ? parent.querySelectorAll('button').length : 0;
                  const btnsInGrand = grand ? grand.querySelectorAll('button').length : 0;
                  if (btnsInParent >= 2 || btnsInGrand >= 2) {
                    const n = parseInt(txt, 10);
                    if (n >= 1 && n <= 50) return { qty: n, stepperRoot: btnsInParent >= 2 ? parent : grand };
                  }
                }
              }
            }
            return { qty: 0, stepperRoot: null };
          };

          const findMainAddButton = () => {
            const selectors = [
              'button[data-testid="snippet-control"]',
              'button[data-testid*="add"]',
              'button[aria-label*="В корзину"]'
            ];
            for (const sel of selectors) {
              const btn = barScope.querySelector(sel) || mainScope.querySelector(sel);
              if (btn && !btn.closest('div[data-testid="product-card"]') && !btn.closest('.lqs-product-panel')) {
                return btn;
              }
            }
            const allBtns = Array.from(barScope.querySelectorAll('button')).concat(
              Array.from(mainScope.querySelectorAll('button'))
            );
            for (const b of allBtns) {
              if (b.closest('div[data-testid="product-card"]') || b.closest('.lqs-product-panel')) continue;
              const t = (b.textContent || '').trim().toLowerCase();
              if (t.includes('в корзину') || t.includes('добавить')) {
                return b;
              }
            }
            return null;
          };

          const findPlusButton = () => {
            const stepperInfo = readCurrentQtyInStepper();
            if (stepperInfo.stepperRoot) {
              const stepperBtns = Array.from(stepperInfo.stepperRoot.querySelectorAll('button')).filter(
                (b) => !b.closest('.lqs-product-panel') && !b.disabled
              );
              if (stepperBtns.length >= 2) {
                return stepperBtns[stepperBtns.length - 1];
              }
            }

            const explicitPlus =
              barScope.querySelector(
                'button[aria-label*="Увеличить"], button[aria-label*="Добавить"], button[aria-label*="Ещё"], button[data-testid*="plus"], button[data-testid*="increment"]'
              ) ||
              mainScope.querySelector(
                'button[aria-label*="Увеличить"], button[aria-label*="Добавить"], button[aria-label*="Ещё"], button[data-testid*="plus"], button[data-testid*="increment"]'
              );
            if (explicitPlus && !explicitPlus.closest('div[data-testid="product-card"]') && !explicitPlus.disabled) {
              return explicitPlus;
            }

            const barBtns = Array.from(barScope.querySelectorAll('button')).filter(
              (b) => !b.closest('.lqs-product-panel') && !b.closest('div[data-testid="product-card"]') && !b.disabled
            );
            for (const b of barBtns) {
              if ((b.textContent || '').trim() === '+') return b;
            }
            if (barBtns.length >= 2) {
              return barBtns[barBtns.length - 1];
            }
            return null;
          };

          const findMinusButton = () => {
            const stepperInfo = readCurrentQtyInStepper();
            if (stepperInfo.stepperRoot) {
              const stepperBtns = Array.from(stepperInfo.stepperRoot.querySelectorAll('button')).filter(
                (b) => !b.closest('.lqs-product-panel') && !b.disabled
              );
              if (stepperBtns.length >= 2) {
                return stepperBtns[0];
              }
            }
            return null;
          };

          let addBtn = null;
          let initialStepper = readCurrentQtyInStepper();
          for (let waitIdx = 0; waitIdx < 16; waitIdx++) {
            initialStepper = readCurrentQtyInStepper();
            if (initialStepper.qty > 0) break;
            addBtn = findMainAddButton();
            if (addBtn && !addBtn.disabled) break;
            await wait(250);
          }

          const pageText = (barScope.innerText || mainScope.innerText || '').toLowerCase();
          if (!addBtn && initialStepper.qty === 0) {
            if (/раскупили|нет в наличии|закончил/i.test(pageText)) {
              return { ok: false, addedUnits: 0, reason: 'Нет в наличии (раскупили на этом складе)' };
            }
            return { ok: false, addedUnits: 0, reason: 'Кнопка «В корзину» не найдена на странице' };
          }

          let currentQty = initialStepper.qty;
          if (currentQty === 0 && addBtn) {
            addBtn.click();
            await wait(450);
            for (let retry = 0; retry < 6; retry++) {
              currentQty = readCurrentQtyInStepper().qty;
              if (currentQty >= 1) break;
              const retryBtn = findMainAddButton();
              if (retryBtn && retry === 2) {
                retryBtn.click();
              }
              await wait(250);
            }
          }

          if (currentQty === 0) {
            return { ok: false, addedUnits: 0, reason: 'Степпер количества не появился после клика' };
          }

          let stockLimitReached = false;
          let stalledClicks = 0;
          let safetyClicks = 0;

          while (currentQty < qtyToSet && safetyClicks < qtyToSet + 4) {
            safetyClicks += 1;
            const plusBtn = findPlusButton();
            if (!plusBtn) {
              stockLimitReached = true;
              break;
            }
            plusBtn.click();
            await wait(380);
            const afterStep = readCurrentQtyInStepper().qty;
            if (afterStep > currentQty) {
              currentQty = afterStep;
              stalledClicks = 0;
            } else {
              stalledClicks += 1;
              if (stalledClicks >= 2) {
                stockLimitReached = true;
                break;
              }
            }
          }

          let safetyMinus = 0;
          while (currentQty > qtyToSet && safetyMinus < 20) {
            safetyMinus += 1;
            const minusBtn = findMinusButton();
            if (!minusBtn) break;
            minusBtn.click();
            await wait(320);
            const afterMinus = readCurrentQtyInStepper().qty;
            if (afterMinus > 0 && afterMinus < currentQty) {
              currentQty = afterMinus;
            } else {
              break;
            }
          }

          const priceEl = document.querySelector('span[data-testid="price-text"]');
          const priceVal = priceEl ? parseFloat(priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.')) : null;
          return {
            ok: currentQty >= 1,
            addedUnits: currentQty,
            requestedUnits: qtyToSet,
            stockLimitReached,
            reason: stockLimitReached && currentQty < qtyToSet ? `Остаток на складе: ${currentQty} из ${qtyToSet} шт.` : '',
            price: priceVal
          };
        } finally {
          window.__lqsAutoBuilding = false;
        }
      }
    });

    const r = execRes && execRes[0] ? execRes[0].result : null;
    if (r && r.ok) {
      return {
        slug: item.slug,
        title: item.title,
        qty: desiredQty,
        addedUnits: r.addedUnits || 0,
        stockLimitReached: Boolean(r.stockLimitReached),
        reason: r.reason || '',
        ok: true,
        price: r.price
      };
    }
    return {
      slug: item.slug,
      title: item.title,
      qty: desiredQty,
      addedUnits: r?.addedUnits || 0,
      ok: false,
      reason: r?.reason || 'Не удалось нажать кнопку'
    };
  } catch (err) {
    return {
      slug: item.slug,
      title: item.title,
      qty: desiredQty,
      addedUnits: 0,
      ok: false,
      reason: err.message || String(err)
    };
  }
}

async function autoBuildCartInBrowser(customItems = null) {
  const stopKeepAlive = startSwKeepAlive();
  try {
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

    const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
    let targetTab = lavkaTabs && lavkaTabs.length > 0 ? lavkaTabs[0] : null;
    if (!targetTab) {
      targetTab = await chrome.tabs.create({ url: 'https://lavka.yandex.ru/', active: true });
      await waitForTabCompleteSafe(targetTab.id, 5000);
    } else {
      await chrome.tabs.update(targetTab.id, { active: true });
    }

    const resultsLog = [];
    const failedItemsForRetry = [];

    for (const item of items) {
      if (!item || !item.slug) continue;
      const res = await addSingleItemOnTab(targetTab.id, item);
      if ((!res.ok || res.addedUnits < res.qty) && !res.stockLimitReached) {
        failedItemsForRetry.push({ item, firstResult: res });
      } else {
        resultsLog.push(res);
      }
    }

    for (const { item, firstResult } of failedItemsForRetry) {
      if (firstResult.reason && firstResult.reason.includes('раскупили')) {
        resultsLog.push(firstResult);
        continue;
      }
      const retryRes = await addSingleItemOnTab(targetTab.id, item);
      resultsLog.push(retryRes);
    }

    await chrome.tabs.update(targetTab.id, { url: 'https://lavka.yandex.ru/cart' });

    const addedCount = resultsLog.filter((r) => r.ok).length;
    const totalRequestedUnits = items.reduce((s, i) => s + (Math.max(1, Number(i.qty) || 1)), 0);
    const totalAddedUnits = resultsLog.reduce((s, r) => s + (Number(r.addedUnits) || 0), 0);

    return {
      ok: true,
      addedCount,
      totalRequested: items.length,
      totalAddedUnits,
      totalRequestedUnits,
      results: resultsLog
    };
  } finally {
    stopKeepAlive();
  }
}

// ============================================================================
// 5. ПОИСК ОТЗЫВОВ И ЦЕН КОНКУРЕНТОВ В DUCKDUCKGO (ТОЧНОЕ СОВПАДЕНИЕ ТОВАРА)
// ============================================================================
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

function extractCompetitorPricesFromSources(sources, lavkaPrice = null, productTitle = '', productAmount = '') {
  if (!Array.isArray(sources) || sources.length === 0) {
    return { competitorMinPrice: null, competitorSummary: '', competitorOffers: [] };
  }
  const found = [];
  const priceRegex = /(?:от\s+|цена\s+|за\s+)?(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|р\.)(?![а-яa-z])/gi;
  for (const s of sources) {
    const rawTitle = s.title || '';
    const snippet = s.snippet || '';
    if (productTitle) {
      const matchCheck = isSearchResultMatchingProduct(rawTitle, snippet, productTitle, productAmount);
      if (!matchCheck.isSameProduct || !matchCheck.isSameVolume) {
        continue;
      }
    }

    const text = `${rawTitle} ${snippet}`;
    const storeName = s.source || 'Магазин';
    const url = s.url || '';
    for (const m of text.matchAll(priceRegex)) {
      const val = parseFloat(m[1].replace(',', '.'));
      if (val >= 20 && val <= 9500) {
        if (lavkaPrice && (val < lavkaPrice * 0.35 || val > lavkaPrice * 3.0)) continue;
        found.push({
          store: storeName,
          price: Math.round(val),
          url,
          title: (rawTitle || storeName).slice(0, 90)
        });
      }
    }
  }
  if (found.length === 0) return { competitorMinPrice: null, competitorSummary: '', competitorOffers: [] };
  found.sort((a, b) => a.price - b.price);
  const minP = found[0].price;
  const seen = new Set();
  const parts = [];
  const uniqueOffers = [];
  for (const item of found) {
    if (!seen.has(item.store)) {
      seen.add(item.store);
      parts.push(`${item.store}: ~${item.price} ₽`);
      uniqueOffers.push(item);
    }
    if (uniqueOffers.length >= 5) break;
  }
  return {
    competitorMinPrice: minP,
    competitorSummary: parts.slice(0, 3).join(', '),
    competitorOffers: uniqueOffers
  };
}

async function parseDdgHtmlSearch(query) {
  if (await isCircuitOpen('duckduckgo')) return [];
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
      5500
    );
    if (resp.status === 429 || resp.status === 403) {
      await recordCircuitFailure('duckduckgo', `HTTP ${resp.status}`, true);
      return [];
    }
    if (resp.ok) {
      const html = await resp.text();
      if (isCaptchaOrBlockHtml(html)) {
        await recordCircuitFailure('duckduckgo', 'captcha', true);
        return [];
      }
      const results = [];
      const chunks = html.split(/<h2[^>]+class="[^"]*result__title[^"]*"[^>]*>/i).slice(1, 11);
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
          title: `[${siteInfo.name}] ${rawTitle.slice(0, 95)}`,
          source: siteInfo.name,
          trusted: siteInfo.trusted,
          snippet,
          url: cleanUrl
        });
      }
      if (results.length > 0) {
        await recordCircuitSuccess('duckduckgo');
        return results;
      }
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
      5500
    );
    if (!respLite.ok) {
      await recordCircuitFailure('duckduckgo', `Lite HTTP ${respLite.status}`, respLite.status === 429 || respLite.status === 403);
      return [];
    }
    const htmlLite = await respLite.text();
    if (isCaptchaOrBlockHtml(htmlLite)) {
      await recordCircuitFailure('duckduckgo', 'lite captcha', true);
      return [];
    }
    const results = [];
    const linkRegex = /<a[^>]+class="[^"]*result-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippets = Array.from(
      htmlLite.matchAll(/<td[^>]+class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi)
    ).map((m) => decodeHtmlEntities(m[1]));

    let idx = 0;
    for (const match of htmlLite.matchAll(linkRegex)) {
      if (results.length >= 9) break;
      const cleanUrl = unwrapDdgUrl(match[1]);
      const rawTitle = decodeHtmlEntities(match[2]);
      const snippet = snippets[idx] || '';
      idx += 1;
      if (!cleanUrl) continue;
      const siteInfo = detectSourceSite(cleanUrl);
      results.push({
        title: `[${siteInfo.name}] ${rawTitle.slice(0, 95)}`,
        source: siteInfo.name,
        trusted: siteInfo.trusted,
        snippet,
        url: cleanUrl
      });
    }
    if (results.length > 0) await recordCircuitSuccess('duckduckgo');
    return results;
  } catch (err) {
    await recordCircuitFailure('duckduckgo', err?.message || 'network error');
    return [];
  }
}

async function probeVkusVillSearchDirect(fullQuery, productTitle, productAmount = '', lavkaPrice = null) {
  if (!fullQuery) return [];
  if (await isCircuitOpen('vkusvill')) return [];
  try {
    const url = `https://vkusvill.ru/search/?q=${encodeURIComponent(fullQuery)}`;
    const resp = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        credentials: 'omit',
        headers: { 'Accept-Language': 'ru-RU,ru;q=0.9' }
      },
      3200
    );
    if (!resp.ok) {
      await recordCircuitFailure('vkusvill', `HTTP ${resp.status}`, resp.status === 429 || resp.status === 403);
      return [];
    }
    const html = await resp.text();
    if (isCaptchaOrBlockHtml(html)) {
      await recordCircuitFailure('vkusvill', 'captcha', true);
      return [];
    }
    const offers = [];
    const cardChunks = html.split(/class="[^"]*ProductCard[^"]*"/i).slice(1, 8);
    for (const chunk of cardChunks) {
      const titleMatch =
        chunk.match(/class="[^"]*ProductCard__link[^"]*"[^>]*title="([^"]+)"/i) ||
        chunk.match(/class="[^"]*ProductCard__link[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
      const hrefMatch = chunk.match(/href="(\/goods\/[^"]+)"/i);
      const priceMatch =
        chunk.match(/class="[^"]*Price--label[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
        chunk.match(/(\d{2,4})\s*(?:₽|руб)/i);
      if (!titleMatch || !priceMatch) continue;
      const itemTitle = decodeHtmlEntities(titleMatch[1]);
      const priceVal = parseFloat(decodeHtmlEntities(priceMatch[1]).replace(/[^\d.,]/g, '').replace(',', '.'));
      if (!priceVal || priceVal < 15 || priceVal > 9500) continue;
      if (lavkaPrice && (priceVal < lavkaPrice * 0.35 || priceVal > lavkaPrice * 3.0)) continue;

      const weightMatch = chunk.match(/class="[^"]*ProductCard__weight[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const weightStr = weightMatch ? decodeHtmlEntities(weightMatch[1]) : '';
      const check = isSearchResultMatchingProduct(`${itemTitle} ${weightStr}`, '', productTitle, productAmount);
      if (check.isSameProduct && check.isSameVolume) {
        offers.push({
          store: 'ВкусВилл',
          price: Math.round(priceVal),
          url: hrefMatch ? `https://vkusvill.ru${hrefMatch[1]}` : url,
          title: `${itemTitle} ${weightStr}`.trim(),
          isVerifiedStoreOffer: true
        });
      }
    }
    await recordCircuitSuccess('vkusvill');
    return offers;
  } catch (err) {
    await recordCircuitFailure('vkusvill', err?.message || 'network error');
    return [];
  }
}

async function probeDirectRetailStoresForProduct(productTitle, brand = '', amount = '', lavkaPrice = null) {
  const fullQ = buildFullProductSearchQuery(productTitle, brand, amount);
  if (!fullQ) return [];

  const extList = await getExternalStoreOffersList();
  const matchedSeedOrHarvested = findMatchingExternalStoreOffersFromList(extList, fullQ, amount);

  const vvOffers = await probeVkusVillSearchDirect(fullQ, fullQ, amount, lavkaPrice);

  let strictQ = fullQ;
  if (/без\s+сахара/i.test(strictQ)) {
    strictQ = strictQ.replace(/без\s+сахара/i, '"без сахара"');
  }
  const qStores = `${strictQ} цена ₽ (site:magnit.ru OR site:perekrestok.ru OR site:5ka.ru OR site:lenta.com OR site:auchan.ru OR site:online.metro-cc.ru OR site:globus.ru OR site:ozon.ru OR site:kuper.ru OR site:vprok.ru)`;
  const ddgHits = await parseDdgHtmlSearch(qStores);
  const extractedDdg = extractCompetitorPricesFromSources(ddgHits, lavkaPrice, fullQ, amount);

  return mergeUniqueStoreOffers(
    [...matchedSeedOrHarvested, ...vvOffers],
    extractedDdg.competitorOffers || []
  );
}

async function searchWebReviewsDirect(title, brand = '', amount = '') {
  const fullQ = buildFullProductSearchQuery(title, brand, amount);
  if (!fullQ) return [];

  let strictQ = fullQ;
  if (/без\s+сахара/i.test(strictQ)) {
    strictQ = strictQ.replace(/без\s+сахара/i, '"без сахара"');
  }

  const qPrimary = `${strictQ} цена отзывы (site:otzovik.com OR site:irecommend.ru OR site:magnit.ru OR site:5ka.ru OR site:perekrestok.ru OR site:vkusvill.ru OR site:auchan.ru OR site:online.metro-cc.ru OR site:globus.ru OR site:lenta.com OR site:ozon.ru OR site:kuper.ru OR site:rskrf.ru)`;
  const qFallback = `${strictQ} купить цена отзывы`;

  const collected = [];
  const seen = new Set();

  try {
    const primaryHits = await parseDdgHtmlSearch(qPrimary);
    for (const item of primaryHits) {
      if (seen.has(item.url)) continue;
      const matchCheck = isSearchResultMatchingProduct(item.title, item.snippet, title, amount);
      if (!matchCheck.isSameProduct) continue;
      item.sameVolume = matchCheck.isSameVolume;
      seen.add(item.url);
      collected.push(item);
    }
    if (collected.length < 3) {
      const fallbackHits = await parseDdgHtmlSearch(qFallback);
      fallbackHits.sort((a, b) => (a.trusted === b.trusted ? 0 : a.trusted ? -1 : 1));
      for (const item of fallbackHits) {
        if (seen.has(item.url)) continue;
        const matchCheck = isSearchResultMatchingProduct(item.title, item.snippet, title, amount);
        if (!matchCheck.isSameProduct) continue;
        item.sameVolume = matchCheck.isSameVolume;
        seen.add(item.url);
        collected.push(item);
        if (collected.length >= 6) break;
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
      'Предварительный парсер не нашёл прямых сниппетов — пожалуйста, проверь наличие реальных отзывов и цен ИМЕННО об этой модификации товара через поиск Google по площадкам выше. Если отзывов именно на этот товар нет — честно напиши об этом и оценивай строго по составу, КБЖУ и цене.';
  } else {
    snippetsText =
      'Прямых отзывов именно на эту модификацию товара в поисковой выдаче не найдено — честно сообщи об этом в 1-м пункте и оценивай товар строго по составу, КБЖУ и цене.';
  }

  const pricing = buildPricingContext(payload, priceIntel);
  const brandSuffix = payload.brand ? ` (Бренд: ${payload.brand})` : '';

  return [
    `Ты — опытный, внимательный и объективный продуктовый эксперт. Сделай короткий и понятный разбор товара из Яндекс Лавки (ровно 3 пункта, без воды, без молодёжного сленга и без выдумок — нормальным разговорным русским языком).`,
    ``,
    `Данные карточки товара:`,
    `• Точное название: ${payload.title}${brandSuffix}`,
    `• Фасовка и цена: ${payload.amount || 'не указана'}, Цена: ${payload.price || '?'} ₽ (${pricing.calcLine})`,
    `• Состав: ${payload.ingredients || 'не указан на странице'}`,
    `• КБЖУ на 100 г: ${payload.traits || 'не указано на странице'}`,
    ``,
    `Площадки для проверки отзывов и цен: ${sitesListStr}.`,
    `Найденные отзывы и цены в интернете (проверены на совпадение модификации):\n${snippetsText}`,
    ``,
    `СТРОГИЕ ПРАВИЛА ЧЕСТНОСТИ (ТОЛЬКО ФАКТЫ, БЕЗ ПРИДУМОК):`,
    `- Оценивай СТРОГО ИМЕННО ЭТОТ ТОВАР и его модификацию («${payload.title} ${payload.amount || ''}»). Не путай товары «без сахара» / «Zero» с обычными сахарными версиями!`,
    `- Пиши ТОЛЬКО подтверждённые факты из реальных отзывов, состава, КБЖУ и цены.`,
    `- Если реальных отзывов именно об этом продукте нет — ЧЕСТНО напиши в 1-м пункте: «Отзывов именно на этот товар в сети не нашлось, поэтому оцениваю по составу и характеристикам». Категорически запрещено придумывать вкус, консистенцию или несуществующие мнения покупателей.`,
    `- ${pricing.ruleLine}`,
    ``,
    `Ответь ровно в 3 коротких пунктах (по 1–2 предложения в каждом), обычным живым русским языком без сленга:`,
    `1. **Отзывы и репутация**: что реально пишут покупатели на отзовиках и в магазинах именно про этот товар (укажи площадки, если отзывы найдены), либо честно отметь, что отзывов в сети не найдено, и скажи, что сразу видно по характеристикам продукта.`,
    `2. **Состав, КБЖУ и честность цены**: фактический разбор состава (подсластители/сахар, крахмал, ММО, заменители молочного жира, добавки или чистый состав) и насколько адекватна цена (${pricing.evalHint}).`,
    `3. **Вердикт**: выбери ОДНУ оценку на нормальном русском языке и кратко поясни вывод:`,
    `   • ✅ **Отличный выбор — стоит брать**`,
    `   • 👍 **Хороший вариант на каждый день (есть мелкие нюансы)**`,
    `   • ⚠️ **На любителя — есть компромиссы по составу или цене**`,
    `   • ❌ **Не рекомендую к покупке**`
  ].join('\n');
}

async function isProductStillRelevantForUser(slug, title, forceRefresh = false, isManualUserClick = false) {
  if (forceRefresh || isManualUserClick) return true;
  const reqKey = normalizeCacheKey(slug, title);
  if (reqKey && reqKey === latestRequestedProductKey) return true;
  try {
    const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
    for (const t of lavkaTabs || []) {
      const u = decodeURIComponent(t.url || '').toLowerCase();
      if (slug && u.includes(String(slug).toLowerCase())) return true;
    }
  } catch {
    return true;
  }
  return false;
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
  const providerCfg = resolveProviderConfig(settings);
  const aiBaseUrl = (providerCfg.protocol === 'gemini_tab' ? settings.aiBaseUrl : providerCfg.baseUrl || settings.aiBaseUrl).replace(/\/$/, '');

  let backendStatus = { ok: false, cachedItems: 0, trackedPrices: trackedPricesCount, msg: 'Выкл (локальная БД)' };
  try {
    const r1 = await fetchWithTimeout(`${backendUrl}/api/health`, { method: 'GET', headers: await getBackendAuthHeaders(backendUrl) }, 1000);
    if (r1.ok) {
      backendOfflineUntilTs = 0;
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
    backendOfflineUntilTs = Date.now() + 10000;
  }

  let bridgeStatus = { ok: false, msg: providerCfg.protocol === 'gemini_tab' ? 'Выкл (работает вкладка)' : `${providerCfg.label}: не проверен` };
  if (providerCfg.protocol === 'gemini_tab') {
    try {
      const headers = settings.aiApiKey ? { Authorization: `Bearer ${settings.aiApiKey}` } : {};
      const r2 = await fetchWithTimeout(`${aiBaseUrl}/models`, { method: 'GET', headers }, 1000);
      if (r2.ok) {
        bridgeOfflineUntilTs = 0;
        let activeModelLabel = settings.aiModel || 'авто';
        try {
          const mJson = await r2.json();
          const firstId = Array.isArray(mJson?.data) && mJson.data[0]?.id ? mJson.data[0].id : '';
          if (!settings.aiModel && firstId) activeModelLabel = firstId;
        } catch {
          // ignore
        }
        bridgeStatus = { ok: true, msg: `ОК (${activeModelLabel})` };
      } else {
        bridgeStatus = { ok: false, msg: `HTTP ${r2.status} (проверь ключ)` };
      }
    } catch {
      bridgeOfflineUntilTs = Date.now() + 12000;
    }
  } else {
    const connTest = await testProviderConnection({
      aiProvider: providerCfg.providerId,
      aiBaseUrl: providerCfg.baseUrl,
      aiApiKey: settings.aiApiKey,
      timeoutMs: 3500
    });
    if (connTest.ok) {
      bridgeOfflineUntilTs = 0;
      const activeModelLabel = settings.aiModel || connTest.models[0] || providerCfg.model || 'авто';
      bridgeStatus = { ok: true, msg: `ОК (${providerCfg.label}: ${activeModelLabel})` };
    } else {
      bridgeStatus = { ok: false, msg: connTest.error || `Ошибка подключения (${providerCfg.label})` };
    }
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
    },
    backend: backendStatus,
    bridge: bridgeStatus,
    localAiCacheCount: localCacheCount,
    trackedPricesCount,
    settings
  };
}

async function saveVerdictToBackendCache(backendUrl, slug, title, verdict, sources) {
  if (!backendUrl || Date.now() < backendOfflineUntilTs) return;
  try {
    await fetchWithTimeout(
      `${backendUrl}/api/save-cache`,
      {
        method: 'POST',
        headers: await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          slug: slug || title,
          title,
          verdict,
          sources: Array.isArray(sources) ? sources : []
        })
      },
      2000
    );
  } catch {
    backendOfflineUntilTs = Date.now() + 10000;
  }
}

async function orchestrateProductAnalysisInternal(payload) {
  const stopKeepAlive = startSwKeepAlive();
  try {
    const settings = await getSettings();
    const backendUrl = settings.backendUrl.replace(/\/$/, '');
    const providerCfg = resolveProviderConfig(settings);
    const aiBaseUrl = (providerCfg.baseUrl || settings.aiBaseUrl || '').replace(/\/$/, '');
    const backendAnalyzeTimeoutMs = LIMITS.BACKEND_ANALYZE_TIMEOUT_MS || 35000;
    const directAiTimeoutMs = LIMITS.AI_DIRECT_TIMEOUT_MS || AI_DIRECT_TIMEOUT_MS || 28000;
    const acc = payload.accountId || settings.lavkaAccountLabel || 'Аккаунт #1';

    let priceIntel = await getProductPriceIntelligence(
      payload.slug,
      payload.title,
      payload.price,
      payload.oldPrice,
      payload.amount,
      acc,
      true, // вызов со страницы оригинальной карточки товара!
      payload.imageKey || null,
      payload.brand || ''
    );

    const authoritativeTitle = buildFullProductSearchQuery(payload.title, payload.brand, payload.amount);

    if (!payload.forceRefresh) {
      const localCached = await getLocalAiCacheEntry(payload.slug, authoritativeTitle, payload.imageKey);
      if (localCached && localCached.verdict) {
        const resObj = {
          ok: true,
          cached: true,
          mode: `Кэш браузера (${localCached.mode || 'ИИ'})`,
          verdict: localCached.verdict,
          sources: localCached.sources || [],
          priceSummary: priceIntel
        };
        broadcastAiVerdictToLavkaTabs(payload.slug, authoritativeTitle, resObj);
        return resObj;
      }
    }

    let webSources = [];
    let backendOnline = false;
    const paidDailyLimit = Number.isFinite(Number(settings.paidAiDailyLimit))
      ? Math.max(0, Math.floor(Number(settings.paidAiDailyLimit)))
      : (LIMITS.DEFAULT_PAID_AI_DAILY_LIMIT || 25);

    if (providerCfg.isPaid) {
      const currentLedger = await getAiUsageLedger();
      const limitCheck = checkPaidAiDailyLimit(currentLedger, paidDailyLimit);
      if (!limitCheck.allowed) {
        return {
          ok: false,
          limitReached: true,
          mode: providerCfg.label,
          error: limitCheck.error,
          sources: webSources,
          priceSummary: priceIntel,
          usageStats: { ...currentLedger, dailyLimit: paidDailyLimit }
        };
      }
    }

    if (backendUrl && Date.now() > backendOfflineUntilTs) {
      try {
        const healthResp = await fetchWithTimeout(
          `${backendUrl}/api/health`,
          { method: 'GET', headers: await getBackendAuthHeaders(backendUrl) },
          800
        );
        if (healthResp.ok) {
          backendOnline = true;
          const resp = await fetchWithTimeout(
            `${backendUrl}/api/analyze-product`,
            {
              method: 'POST',
              headers: await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
              body: JSON.stringify({
                ...payload,
                title: authoritativeTitle,
                accountId: acc,
                aiProvider: providerCfg.providerId,
                aiBaseUrl: providerCfg.baseUrl || settings.aiBaseUrl,
                aiApiKey: settings.aiApiKey,
                aiModel: settings.aiModel || providerCfg.model
              })
            },
            backendAnalyzeTimeoutMs
          );

          if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data.sources)) {
              webSources = data.sources;
            }
            if (data.priceSummary) {
              priceIntel = { ...(priceIntel || {}), ...data.priceSummary };
            }
            if (data.verdict && data.aiOk !== false && !data.verdict.startsWith('⚠️')) {
              const costUsd = typeof data.costUsd === 'number' ? data.costUsd : null;
              const costSuffix = costUsd !== null ? ` · ${formatCostUsd(costUsd)}` : '';
              const modelTag = data.aiModel || settings.aiModel || providerCfg.model || providerCfg.label;
              const modeLabel = data.cached
                ? 'FastAPI SQLite Cache (:8765)'
                : `FastAPI (:8765) + ${modelTag}${costSuffix}`;
              await saveLocalAiCacheEntry(payload.slug, authoritativeTitle, data.verdict, webSources, modeLabel, payload.imageKey);
              let updatedUsage = null;
              if (providerCfg.isPaid && !data.cached) {
                const prevLedger = await getAiUsageLedger();
                updatedUsage = await saveAiUsageLedger(
                  recordPaidAiUsage(prevLedger, {
                    costUsd,
                    providerId: providerCfg.providerId,
                    model: modelTag
                  })
                );
              }
              const resObj = {
                ok: true,
                cached: Boolean(data.cached),
                mode: modeLabel,
                verdict: data.verdict,
                sources: webSources,
                priceSummary: priceIntel,
                costUsd,
                usageStats: updatedUsage ? { ...updatedUsage, dailyLimit: paidDailyLimit } : null
              };
              broadcastAiVerdictToLavkaTabs(payload.slug, authoritativeTitle, resObj);
              return resObj;
            }
          }
        }
      } catch {
        backendOfflineUntilTs = Date.now() + 12000;
      }
    }

    if (!webSources || webSources.length === 0) {
      webSources = await searchWebReviewsDirect(authoritativeTitle, payload.brand, payload.amount);
    }

    const comp = extractCompetitorPricesFromSources(webSources, payload.price, authoritativeTitle, payload.amount);
    if (comp.competitorMinPrice || comp.competitorSummary || comp.competitorOffers.length > 0) {
      const updatedMap = await recordPricesBatch(acc, [
        {
          slug: payload.slug,
          title: authoritativeTitle,
          isCanonicalCardTitle: true,
          brand: payload.brand || '',
          imageKey: payload.imageKey || null,
          price: payload.price || 0,
          oldPrice: payload.oldPrice || null,
          amount: payload.amount || '',
          competitorMinPrice: comp.competitorMinPrice,
          competitorSummary: comp.competitorSummary,
          competitorOffers: comp.competitorOffers
        }
      ]);
      const cleanSlug = String(payload.slug || '').trim().toLowerCase();
      if (updatedMap[cleanSlug]) {
        priceIntel = updatedMap[cleanSlug];
      }
    }

    if (providerCfg.protocol !== 'gemini_tab' && aiBaseUrl && (providerCfg.isPaid || Date.now() > bridgeOfflineUntilTs)) {
      try {
        const promptForBridge = buildProductReviewPrompt({ ...payload, title: authoritativeTitle }, webSources, false, priceIntel);
        const aiResult = await callAiProvider(
          {
            aiProvider: providerCfg.providerId,
            aiBaseUrl: providerCfg.baseUrl,
            aiApiKey: settings.aiApiKey,
            aiModel: settings.aiModel,
            timeoutMs: directAiTimeoutMs
          },
          promptForBridge
        );
        if (aiResult && aiResult.ok && aiResult.text) {
          bridgeOfflineUntilTs = 0;
          const cleanReply = aiResult.text.trim();
          const costUsd = typeof aiResult.costUsd === 'number' ? aiResult.costUsd : null;
          const costSuffix = costUsd !== null ? ` · ${formatCostUsd(costUsd)}` : '';
          const modeLabel = `${aiResult.providerLabel} · ${aiResult.model}${costSuffix}`;
          await saveLocalAiCacheEntry(payload.slug, authoritativeTitle, cleanReply, webSources, modeLabel, payload.imageKey);
          if (backendOnline) {
            saveVerdictToBackendCache(backendUrl, payload.slug, authoritativeTitle, cleanReply, webSources);
          }
          let updatedUsage = null;
          if (providerCfg.isPaid) {
            const prevLedger = await getAiUsageLedger();
            updatedUsage = await saveAiUsageLedger(
              recordPaidAiUsage(prevLedger, {
                costUsd,
                usage: aiResult.usage || null,
                providerId: providerCfg.providerId,
                model: aiResult.model
              })
            );
          }
          const resObj = {
            ok: true,
            cached: false,
            mode: modeLabel,
            verdict: cleanReply,
            sources: webSources,
            priceSummary: priceIntel,
            costUsd,
            usage: aiResult.usage || null,
            usageStats: updatedUsage ? { ...updatedUsage, dailyLimit: paidDailyLimit } : null
          };
          broadcastAiVerdictToLavkaTabs(payload.slug, authoritativeTitle, resObj);
          return resObj;
        }
      } catch (err) {
        if (providerCfg.isPaid) {
          return {
            ok: false,
            mode: providerCfg.label,
            error: err && err.message ? err.message : String(err),
            sources: webSources,
            priceSummary: priceIntel
          };
        }
        bridgeOfflineUntilTs = Date.now() + 15000;
      }
    }

    return await enqueueGeminiTabExecution(async () => {
      if (!payload.forceRefresh) {
        const alreadyCached = await getLocalAiCacheEntry(payload.slug, authoritativeTitle, payload.imageKey);
        if (alreadyCached && alreadyCached.verdict) {
          const resObj = {
            ok: true,
            cached: true,
            mode: `Кэш браузера (${alreadyCached.mode || 'ИИ'})`,
            verdict: alreadyCached.verdict,
            sources: alreadyCached.sources || [],
            priceSummary: priceIntel
          };
          broadcastAiVerdictToLavkaTabs(payload.slug, authoritativeTitle, resObj);
          return resObj;
        }
      }

      const stillRelevant = await isProductStillRelevantForUser(
        payload.slug,
        authoritativeTitle,
        payload.forceRefresh,
        Boolean(payload.isManualUserClick)
      );
      if (!stillRelevant) {
        return {
          ok: false,
          skippedStale: true,
          error: 'Запрос отменён, так как открыт другой товар.',
          sources: webSources,
          priceSummary: priceIntel
        };
      }

      const geminiTab = await findOpenGeminiTab(true, false);
      if (geminiTab && geminiTab.id) {
        const email = await detectTabAccountEmail(geminiTab.id);
        const accIdx = extractAccountIndexFromUrl(geminiTab.url);
        const promptForTab = buildProductReviewPrompt({ ...payload, title: authoritativeTitle }, webSources, true, priceIntel);
        const tabResult = await executePromptInsideGeminiTab(
          geminiTab.id,
          promptForTab,
          authoritativeTitle,
          Boolean(payload.forceRefresh)
        );
        if (tabResult && tabResult.ok && tabResult.text) {
          const accLabel = email ? `${email} (/u/${accIdx})` : `/u/${accIdx}`;
          const modeLabel = `Вкладка Gemini [${accLabel}]`;
          await saveLocalAiCacheEntry(payload.slug, authoritativeTitle, tabResult.text, webSources, modeLabel, payload.imageKey);
          if (backendOnline) {
            saveVerdictToBackendCache(backendUrl, payload.slug, authoritativeTitle, tabResult.text, webSources);
          }
          const resObj = {
            ok: true,
            cached: false,
            mode: modeLabel,
            verdict: tabResult.text,
            sources: webSources,
            priceSummary: priceIntel
          };
          broadcastAiVerdictToLavkaTabs(payload.slug, authoritativeTitle, resObj);
          return resObj;
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
  } finally {
    stopKeepAlive();
  }
}

async function orchestrateProductAnalysis(payload) {
  const key = normalizeCacheKey(payload.slug, payload.title);
  if (key) {
    latestRequestedProductKey = key;
  }
  if (key && !payload.forceRefresh && !payload.isManualUserClick && inFlightRequests.has(key)) {
    const existingEntry = inFlightRequests.get(key);
    if (existingEntry && Date.now() - existingEntry.startedAt < 35000) {
      return existingEntry.promise;
    }
    inFlightRequests.delete(key);
  }
  const promise = orchestrateProductAnalysisInternal(payload).finally(() => {
    if (key) inFlightRequests.delete(key);
  });
  if (key) {
    inFlightRequests.set(key, { promise, startedAt: Date.now() });
  }
  return promise;
}

// ============================================================================
// 7. СОБЫТИЯ ЖИЗНЕННОГО ЦИКЛА И ОБРАБОТЧИК СООБЩЕНИЙ
// ============================================================================

// Единый явный мост зависимостей background.js для вынесенных модулей bg/*.js
globalThis.LQS_BG_DEPS = {
  getBackendOfflineUntilTs: () => backendOfflineUntilTs,
  setBackendOfflineUntilTs: (ts) => {
    backendOfflineUntilTs = ts;
  },
  getBridgeOfflineUntilTs: () => bridgeOfflineUntilTs,
  setBridgeOfflineUntilTs: (ts) => {
    bridgeOfflineUntilTs = ts;
  },
  getSwKeepAliveActiveTasks: () => swKeepAliveActiveTasks,
  getBackendAuthHeaders,
  startSwKeepAlive,
  waitForTabCompleteSafe,
  autoBuildCartInBrowser,
  getLocalAiCacheEntry,
  searchWebReviewsDirect,
  extractCompetitorPricesFromSources,
  probeDirectRetailStoresForProduct
};

const WATCHLIST_ALARM_NAME = 'lqs_watchlist_price_check';

async function syncWatchlistAlarm() {
  try {
    if (!chrome.alarms) return;
    const settings = await getSettings();
    const hours = Number(settings.watchlistCheckIntervalHours ?? 6);
    if (!hours || hours <= 0) {
      chrome.alarms.clear(WATCHLIST_ALARM_NAME);
      return;
    }
    chrome.alarms.create(WATCHLIST_ALARM_NAME, {
      delayInMinutes: Math.max(15, Math.round(hours * 60)),
      periodInMinutes: Math.max(60, Math.round(hours * 60))
    });
  } catch {
    // ignore
  }
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === WATCHLIST_ALARM_NAME) {
      checkWatchlistPricesBatch({ maxItems: 12 }).catch(() => {});
    }
  });
}

if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes && changes[LQS_CONFIG.STORAGE_KEYS.SETTINGS]) {
      syncWatchlistAlarm();
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAutopilotWarmup('onInstalled');
  getAccountsVaultMap();
  syncWatchlistAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAutopilotWarmup('onStartup');
  syncWatchlistAlarm();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab && tab.url && tab.url.startsWith('https://lavka.yandex.ru/')) {
    ensureAutopilotWarmup('lavka-tab-opened');
  }
});

function isPopupSender(sender) {
  const popupPrefix = chrome.runtime.getURL('popup.html');
  return Boolean(sender && typeof sender.url === 'string' && sender.url.startsWith(popupPrefix));
}

function isTrustedLavkaOrPopupSender(sender) {
  if (isPopupSender(sender)) return true;
  const u = sender && typeof sender.url === 'string' ? sender.url : '';
  return (
    u.startsWith('https://lavka.yandex.ru/') ||
    u.startsWith('https://passport.yandex.ru/') ||
    u.startsWith('https://id.yandex.ru/')
  );
}

function isPassportOrPopupSender(sender) {
  if (isPopupSender(sender)) return true;
  const u = sender && typeof sender.url === 'string' ? sender.url : '';
  return u.startsWith('https://passport.yandex.ru/') || u.startsWith('https://id.yandex.ru/');
}

const TRUSTED_EXTERNAL_STORE_DOMAINS = [
  'magnit.ru',
  'kuper.ru',
  'perekrestok.ru',
  'vprok.ru',
  '5ka.ru',
  'vkusvill.ru',
  'auchan.ru',
  'lenta.com'
];

function isTrustedRetailStoreSender(sender) {
  const u = sender && typeof sender.url === 'string' ? sender.url : '';
  if (!u) return false;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:') return false;
    const h = parsed.hostname.toLowerCase();
    return TRUSTED_EXTERNAL_STORE_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function isTrustedExternalStoreSender(sender) {
  return isTrustedLavkaOrPopupSender(sender) || isTrustedRetailStoreSender(sender);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'LQS_ANALYZE_PRODUCT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    orchestrateProductAnalysis(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_RECORD_PRICES') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    recordPricesBatch(msg.accountId, msg.items || [])
      .then((summaries) => sendResponse({ ok: true, summaries }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SCAN_STORES_LIVE') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    scanStoresInBackgroundTabs(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_RECORD_EXTERNAL_STORE_OFFERS') {
    if (!isTrustedExternalStoreSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    recordExternalStoreOffers(msg.store || 'Магнит', msg.offers || [])
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_PRICE_INTEL') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getProductPriceIntelligence(
      msg.slug,
      msg.title,
      msg.price,
      msg.oldPrice,
      msg.amount,
      msg.accountId,
      Boolean(msg.isFromProductCard),
      msg.imageKey || null,
      msg.brand || ''
    )
      .then((summary) => sendResponse({ ok: Boolean(summary), summary }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_AUDIT_CART_COMPETITORS') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    auditCartCompetitorsAndAccounts(msg.accountId, msg.items || [], Boolean(msg.forceNetworkSearch))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SAVE_CART_SNAPSHOT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    saveCartSnapshot(msg.accountId, msg.items || [], msg.totalPrice || 0)
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_SAVED_CARTS') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getSavedCartsState()
      .then((state) => sendResponse({ ok: true, ...state }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_COMPARE_CART_PRICES') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    compareSavedCartOnCurrentAccount(msg.accountId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_AUTO_BUILD_CART') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    autoBuildCartInBrowser(msg.items || null)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_ACCOUNT_SECRET_FOR_POPUP') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Доступ к секретам сейфа разрешён только из popup расширения.' });
      return true;
    }
    (async () => {
      const settings = await getSettings();
      const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
      const secrets = await fetchBackendAccountSecrets(backendUrl, msg.accountId);
      if (!secrets) {
        return { ok: false, error: 'Не удалось получить секрет с локального сервера (:8765).' };
      }
      return { ok: true, password: secrets.password || '' };
    })()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_RADAR_STATUS') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getRadar16StoresStatus()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_RESET_CIRCUIT_BREAKER') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    resetCircuitBreakers()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_FETCH_AI_MODELS') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, models: [], error: 'Forbidden' });
      return true;
    }
    fetchAiModelsList(msg.aiBaseUrl, msg.aiApiKey, msg.aiProvider || '')
      .then((models) => sendResponse({ ok: true, models }))
      .catch((err) => sendResponse({ ok: false, models: [], error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_TEST_AI_PROVIDER') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, models: [], error: 'Forbidden' });
      return true;
    }
    testProviderConnection({
      aiProvider: msg.aiProvider || '',
      aiBaseUrl: msg.aiBaseUrl || '',
      aiApiKey: msg.aiApiKey || ''
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, models: [], error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_AI_USAGE_STATS') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getAiUsageStatsWithLimit()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SET_BACKEND_TOKEN') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    saveStoredBackendToken(msg.token || '')
      .then((tok) => sendResponse({ ok: true, hasToken: Boolean(tok) }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_ACCOUNTS_VAULT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getAccountsVaultStatus()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SAVE_ACCOUNT_TO_VAULT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    saveAccountToVault(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_DELETE_ACCOUNT_FROM_VAULT') {
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    deleteAccountFromVault(msg.accountId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SWITCH_LAVKA_ACCOUNT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    switchLavkaAccountInOneClick(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_LOGOUT_CLEAN_LAVKA_SESSION') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    logoutToCleanLavkaSession()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_AUTOFILL_YANDEX_LOGIN') {
    if (!isPassportOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    autofillYandexPassportTab(msg.accountId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_CACHED_AI_VERDICT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getLocalAiCacheEntry(msg.slug, msg.title, msg.imageKey || null)
      .then((entry) => sendResponse({ ok: Boolean(entry), entry: entry || null }))
      .catch(() => sendResponse({ ok: false, entry: null }));
    return true;
  }

  if (msg.type === 'LQS_CLEAR_AI_CACHE') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    clearLocalAiCache()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_WARMUP_AUTOPILOT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    ensureAutopilotWarmup('content-script-boot')
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'LQS_CHECK_AI_STATUS') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    checkAllConnections()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SELECT_GEMINI_ACCOUNT') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
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
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
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
    if (!isPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Доступ к куки Google разрешён только из popup расширения.' });
      return true;
    }
    inspectGeminiCookies()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_PRICE_HISTORY') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getProductPriceHistory(msg.slug, msg.title || '', msg.days ?? 90, msg.accountId || null)
      .then((data) => sendResponse({ ok: Boolean(data), data }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_TOGGLE_WATCHLIST') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    toggleWatchlistItem({
      slug: msg.slug,
      title: msg.title || '',
      amount: msg.amount || '',
      price: msg.price || null,
      targetPrice: msg.targetPrice || null,
      watch: msg.watch
    })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_WATCHLIST') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    getWatchlistItems()
      .then((items) => sendResponse({ ok: true, items }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_CHECK_WATCHLIST_NOW') {
    if (!isTrustedLavkaOrPopupSender(sender)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    checkWatchlistPricesBatch({ maxItems: msg.maxItems || 15 })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  return false;
});
