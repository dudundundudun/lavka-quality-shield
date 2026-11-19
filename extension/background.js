/**
 * Lavka Quality Shield v2.6.0 — Background Service Worker
 * Что нового и исправлено в v2.6.0:
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

importScripts('shared/config.js');

const { STORAGE_KEYS, LIMITS, CLIENT_HEADER: LQS_CLIENT_HEADER, TOKEN_HEADER_NAME = 'X-LQS-Token' } = globalThis.LQS_CONFIG;
const SETTINGS_KEY = STORAGE_KEYS.SETTINGS;
const AI_CACHE_KEY = STORAGE_KEYS.AI_CACHE;
const PRICE_DB_KEY = STORAGE_KEYS.PRICE_DB;
const EXT_STORE_DB_KEY = STORAGE_KEYS.EXT_STORE_DB;
const SAVED_CARTS_KEY = STORAGE_KEYS.SAVED_CARTS;
const CART_LOCKS_KEY = STORAGE_KEYS.CART_LOCKS;
const ACCOUNTS_VAULT_KEY = STORAGE_KEYS.ACCOUNTS_VAULT;
const DELETED_ACCOUNTS_KEY = STORAGE_KEYS.DELETED_ACCOUNTS;
const BACKEND_TOKEN_KEY = STORAGE_KEYS.BACKEND_TOKEN || 'lqs_backend_token_v1';

const MAX_LOCAL_AI_CACHE_ITEMS = LIMITS.MAX_LOCAL_AI_CACHE_ITEMS;
const MAX_LOCAL_PRICE_DB_ITEMS = LIMITS.MAX_LOCAL_PRICE_DB_ITEMS;

const DEFAULT_SETTINGS = { ...globalThis.LQS_CONFIG.DEFAULT_SETTINGS };

const DEFAULT_ACCOUNT_PROFILES = [
  {
    accountId: 'acc_1',
    label: 'Аккаунт #1 (Основной)',
    login: '',
    note: '',
    yandexLogin: '',
    hasPassword: false,
    cookieCount: 0,
    updatedAt: null
  },
  {
    accountId: 'acc_2',
    label: 'Аккаунт #2 (Скидка)',
    login: '',
    note: '',
    yandexLogin: '',
    hasPassword: false,
    cookieCount: 0,
    updatedAt: null
  },
  {
    accountId: 'acc_3',
    label: 'Аккаунт #3 (Запасной)',
    login: '',
    note: '',
    yandexLogin: '',
    hasPassword: false,
    cookieCount: 0,
    updatedAt: null
  }
];

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

// Эталонные цены и прямые карточки из технического дампа Магнита (site-recon-magnit.ru)
const MAGNIT_RECON_SEED_OFFERS = [
  {
    goodId: '1000475610',
    store: 'Магнит',
    title: 'Напиток Добрый Cola без сахара 1,5 л',
    amount: '1,5 л',
    price: 144,
    oldPrice: null,
    url: 'https://magnit.ru/product/1000475610-dobryy_napitok_kola_b_sakh_b_a_s_g_1_5l_pl_but_multon?shopCode=411717&shopType=express'
  },
  {
    goodId: '1000135692',
    store: 'Магнит',
    title: 'Мороженое Магнат Шоколадный трюфель эскимо 67 г',
    amount: '67 г',
    price: 139,
    oldPrice: 190,
    url: 'https://magnit.ru/product/1000135692-morozhenoe_magnat_shokolad_i_tryufel_eskimo_72g?shopCode=411717&shopType=express'
  },
  {
    goodId: '1000484117',
    store: 'Магнит',
    title: 'Газированный напиток Кола Evervess 1 л',
    amount: '1 л',
    price: 100,
    oldPrice: null,
    url: 'https://magnit.ru/product/1000484117-gazirovannyy_napitok_kola_evervess_1l'
  },
  {
    goodId: '1000485813',
    store: 'Магнит',
    title: 'Сосиски Велком с сыром 450 г',
    amount: '450 г',
    price: 240,
    oldPrice: 359,
    url: 'https://magnit.ru/product/1000485813-sosiski_velkom_s_syrom_450g'
  },
  {
    goodId: '2400008824',
    store: 'Магнит',
    title: 'Лапша Доширак Квисти со вкусом курицы 70 г',
    amount: '70 г',
    price: 31,
    oldPrice: null,
    url: 'https://magnit.ru/product/2400008824-lapsha_doshirak_kvisti_so_vkusom_kuritsy_70g'
  },
  {
    goodId: '1000438044',
    store: 'Магнит',
    title: 'Энергетический напиток Adrenaline Rush Silver Energy Zero Sugar без сахара 449 мл',
    amount: '449 мл',
    price: 117,
    oldPrice: null,
    url: 'https://magnit.ru/product/1000438044-energeticheskiy_napitok_adrenaline_rush_silver_energy_zero_sugar_449ml'
  },
  {
    goodId: '1000310698',
    store: 'Магнит',
    title: 'Мороженое Maxiduo Страчателла брикет 92 г',
    amount: '92 г',
    price: 99,
    oldPrice: 120,
    url: 'https://magnit.ru/product/1000310698-morozhenoe_maxiduo_strachatella_briket_92g'
  },
  {
    goodId: '1000320440',
    store: 'Магнит',
    title: 'Мороженое Milka Эскимо Ванильное с молочным шоколадом 62 г',
    amount: '62 г',
    price: 129,
    oldPrice: 150,
    url: 'https://magnit.ru/product/1000320440-morozhenoe_milka_eskimo_vanilnoe_s_molochnym_shokoladom_62g'
  }
];

let geminiTabMutex = Promise.resolve();
const inFlightRequests = new Map();
let latestRequestedProductKey = '';
let lastWarmupCheckTs = 0;
let isWarmingUp = false;

let backendOfflineUntilTs = 0;
let bridgeOfflineUntilTs = 0;

function startSwKeepAlive() {
  const timer = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {
        if (chrome.runtime.lastError) {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  }, 4000);
  return () => clearInterval(timer);
}

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

function sanitizeAccountForLocalStorage(acc) {
  if (!acc || typeof acc !== 'object') return null;
  return {
    accountId: String(acc.accountId || ''),
    label: String(acc.label || ''),
    login: String(acc.login || ''),
    note: String(acc.note || ''),
    yandexLogin: String(acc.yandexLogin || ''),
    hasPassword: Boolean(acc.hasPassword || acc.password),
    cookieCount: Array.isArray(acc.cookies) ? acc.cookies.length : Number(acc.cookieCount || 0),
    updatedAt: acc.updatedAt || null
  };
}

async function fetchBackendVaultAccounts(backendUrl) {
  const cleanUrl = (backendUrl || '').replace(/\/$/, '');
  if (!cleanUrl || Date.now() < backendOfflineUntilTs) return null;
  try {
    const headers = await getBackendAuthHeaders(cleanUrl);
    const r = await fetchWithTimeout(`${cleanUrl}/api/accounts/list`, { method: 'GET', headers }, 1500);
    if (r.ok) {
      const j = await r.json();
      if (j && Array.isArray(j.accounts)) return j.accounts;
    }
  } catch {
    backendOfflineUntilTs = Date.now() + 10000;
  }
  return null;
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

function normalizeTitleKey(rawTitle) {
  if (!rawTitle) return '';
  return String(rawTitle)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u00ad\u200b\u00a0«»"'„“”]/g, ' ')
    .replace(/(?:,\s*|\s+)(?:\d+\s*[×xх*]\s*)?\d+(?:[.,]\d+)?\s*(?:г|гр|грамм|кг|мл|л|шт|уп|пак|рул|капс)\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е');
}

function extractImageKeyFromUrl(src) {
  if (!src) return null;
  const m = String(src).match(/get-grocery-goods\/(\d+\/[a-f0-9-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// ============================================================================
// ТОЧНЫЙ ПОИСК ИДЕНТИЧНЫХ ТОВАРОВ И ФИЛЬТР МОДИФИКАТОРОВ (БЕЗ САХАРА / ОБЪЁМ)
// ============================================================================
const SUGAR_FREE_REGEX =
  /(без\s+сахара|без\s+добавленного\s+сахара|\bzero\b|\bзеро\b|\blight\b|\bлайт\b|\bdiet\b|0\s*%\s*сахара|0\s+сахара|на\s+стевии|подсластител)/i;

const FLAVOR_AND_TYPE_MODIFIERS = [
  'ваниль',
  'вишн',
  'черешн',
  'лимон',
  'лайм',
  'манго',
  'маракуй',
  'апельсин',
  'персик',
  'малин',
  'клубник',
  'земляник',
  'смородин',
  'черник',
  'яблок',
  'груш',
  'ананас',
  'грейпфрут',
  'тархун',
  'дюшес',
  'байкал',
  'буратино',
  'крем-сода',
  'карамел',
  'кокос',
  'миндал',
  'фундук',
  'фисташк',
  'банан',
  'шоколад',
  'какао',
  'кофе',
  'матча',
  'имбир',
  'мята',
  'мятн',
  'солен',
  'копчен',
  'остр',
  'сырн',
  'гриб',
  'сметан',
  'зелен',
  'краб',
  'бекон',
  'паприк',
  'безлактоз',
  'топлен',
  'обезжир'
];

const GENERIC_STOP_WORDS = new Set([
  'напиток',
  'газированный',
  'сильногазированный',
  'среднегазированный',
  'слабогазированный',
  'негазированный',
  'безалкогольный',
  'пастеризованный',
  'ультрапастеризованный',
  'стерилизованный',
  'охлажденный',
  'замороженный',
  'фасованный',
  'нарезка',
  'упаковка',
  'бутылка',
  'банка',
  'пакет',
  'коробка',
  'продукт',
  'товар',
  'купить',
  'цена',
  'отзывы',
  'отзыв',
  'доставка',
  'москва',
  'лавка',
  'яндекс',
  'бзмж',
  'стм',
  'для',
  'или',
  'под',
  'над',
  'при'
]);

function parseVolumeOrWeightGrams(rawStr) {
  if (!rawStr) return null;
  const s = String(rawStr).replace(/[\u00ad\u200b\u00a0]/g, ' ');
  const multi = s.match(
    /(\d+)\s*[×xх*]\s*(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i
  );
  if (multi) {
    const cnt = parseInt(multi[1], 10) || 1;
    const val = parseFloat(multi[2].replace(',', '.'));
    const u = multi[3].toLowerCase();
    const mult = u.startsWith('кг') || u.startsWith('л') ? 1000 : 1;
    if (val > 0) return cnt * val * mult;
  }
  const single = s.match(
    /(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i
  );
  if (single) {
    const val = parseFloat(single[1].replace(',', '.'));
    const u = single[2].toLowerCase();
    const mult = u.startsWith('кг') || u.startsWith('л') ? 1000 : 1;
    if (val > 0) return val * mult;
  }
  return null;
}

function buildFullProductSearchQuery(title, brand = '', amount = '') {
  let q = String(title || '').replace(/[\u00ad\u200b\u00a0«»"'„“”]/g, ' ');
  q = q.replace(/(^|\s)(?:бзмж|стм)(?=\s|$)/gi, ' ');
  q = q.replace(/\s+/g, ' ').trim();

  if (brand) {
    const cleanBrand = String(brand).replace(/[\u00ad\u200b\u00a0«»"']/g, ' ').trim();
    if (cleanBrand && !q.toLowerCase().includes(cleanBrand.toLowerCase())) {
      q = cleanBrand.toLowerCase() === 'из лавки' ? `${q} Из Лавки` : `${q} ${cleanBrand}`;
    }
  }

  if (amount) {
    const cleanAmt = String(amount).replace(/[\u00ad\u200b\u00a0]/g, ' ').trim();
    if (cleanAmt) {
      const targetGrams = parseVolumeOrWeightGrams(cleanAmt);
      const queryGrams = parseVolumeOrWeightGrams(q);
      if (!queryGrams && !q.toLowerCase().includes(cleanAmt.toLowerCase())) {
        q = `${q} ${cleanAmt}`;
      } else if (targetGrams && queryGrams && Math.abs(targetGrams - queryGrams) > 5) {
        q = `${q} ${cleanAmt}`;
      }
    }
  }

  return q.replace(/\s+/g, ' ').trim();
}

function normalizeSynonymTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\bcola\b/g, 'кола')
    .replace(/\bcoca[\s-]*кола\b/g, 'coca-cola кока-кола')
    .replace(/\boriginal\b/g, 'оригинал original')
    .replace(/\bclassic\b/g, 'классик classic')
    .replace(/\bzero\b/g, 'без сахара zero зеро');
}

function isSearchResultMatchingProduct(resTitle, resSnippet, productTitle, productAmount = '') {
  const fullTarget = `${productTitle || ''} ${productAmount || ''}`.trim();
  const targetLower = fullTarget.toLowerCase().replace(/ё/g, 'е');
  const resTitleLower = String(resTitle || '').toLowerCase().replace(/ё/g, 'е');
  const resCombinedLower = `${resTitleLower} ${String(resSnippet || '').toLowerCase().replace(/ё/g, 'е')}`;

  // 1. ЖЁСТКАЯ ПРОВЕРКА «БЕЗ САХАРА / ZERO»
  const targetIsSugarFree = SUGAR_FREE_REGEX.test(targetLower);
  const resIsSugarFree = SUGAR_FREE_REGEX.test(resCombinedLower);
  const resTitleIsSugarFree = SUGAR_FREE_REGEX.test(resTitleLower);

  if (targetIsSugarFree && !resIsSugarFree) {
    return { isSameProduct: false, isSameVolume: false };
  }
  if (!targetIsSugarFree && resTitleIsSugarFree) {
    return { isSameProduct: false, isSameVolume: false };
  }

  // 2. ПРОВЕРКА ВКУСОВЫХ И ВИДОВЫХ МОДИФИКАТОРОВ
  for (const mod of FLAVOR_AND_TYPE_MODIFIERS) {
    const targetHasMod = targetLower.includes(mod);
    const resTitleHasMod = resTitleLower.includes(mod);
    const resAnyHasMod = resCombinedLower.includes(mod);
    if (targetHasMod && !resAnyHasMod) {
      return { isSameProduct: false, isSameVolume: false };
    }
    if (!targetHasMod && resTitleHasMod) {
      return { isSameProduct: false, isSameVolume: false };
    }
  }

  // 3. ПРОВЕРКА ЯДРА НАЗВАНИЯ И БРЕНДА
  const normTarget = normalizeSynonymTokens(targetLower);
  const normRes = normalizeSynonymTokens(resCombinedLower);

  const rawWords = normTarget.match(/[а-яa-z0-9]{3,}/g) || [];
  const coreTokens = [];
  for (const w of rawWords) {
    if (GENERIC_STOP_WORDS.has(w)) continue;
    if (['без', 'сахара', 'сахар', 'zero', 'зеро', 'литр', 'литра', 'литров', 'грамм', 'грамма'].includes(w)) {
      continue;
    }
    if (/^\d+(?:г|гр|кг|мл|л|шт|percent)?$/.test(w)) continue;
    if (!coreTokens.includes(w)) coreTokens.push(w);
  }

  if (coreTokens.length > 0) {
    let matchedCount = 0;
    for (const tok of coreTokens) {
      const stem = tok.length >= 6 ? tok.slice(0, 5) : (tok.length >= 5 ? tok.slice(0, 4) : tok);
      if (normRes.includes(stem)) {
        matchedCount += 1;
      }
    }
    const required = coreTokens.length === 1 ? 1 : Math.max(2, Math.ceil(coreTokens.length * 0.6));
    if (matchedCount < Math.min(required, coreTokens.length)) {
      return { isSameProduct: false, isSameVolume: false };
    }
  }

  // 4. ПРОВЕРКА ОБЪЁМА / ВЕСА
  const targetGrams = parseVolumeOrWeightGrams(productAmount) || parseVolumeOrWeightGrams(productTitle);
  const resGrams = parseVolumeOrWeightGrams(resTitle) || parseVolumeOrWeightGrams(resSnippet);
  let isSameVolume = true;
  if (targetGrams && resGrams) {
    const ratio = resGrams / targetGrams;
    if (ratio < 0.78 || ratio > 1.25) {
      isSameVolume = false;
    }
  }

  return { isSameProduct: true, isSameVolume };
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
// 2. МЕНЕДЖЕР АККАУНТОВ ЛАВКИ (КУКИ-СЕССИИ + ЛОГИНЫ/ПАРОЛИ + 1-КЛИК СВИТЧЕР)
// ============================================================================
async function getDeletedAccountIdsSet() {
  return new Promise((resolve) => {
    chrome.storage.local.get([DELETED_ACCOUNTS_KEY], (res) => {
      const arr = res && Array.isArray(res[DELETED_ACCOUNTS_KEY]) ? res[DELETED_ACCOUNTS_KEY] : [];
      resolve(new Set(arr));
    });
  });
}

async function markAccountIdDeleted(accountId, isDeleted = true) {
  const set = await getDeletedAccountIdsSet();
  if (isDeleted) set.add(accountId);
  else set.delete(accountId);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [DELETED_ACCOUNTS_KEY]: Array.from(set) }, resolve);
  });
}

async function getAccountsVaultMap() {
  const localMap = await new Promise((resolve) => {
    chrome.storage.local.get([ACCOUNTS_VAULT_KEY], (res) => {
      resolve(res && res[ACCOUNTS_VAULT_KEY] && typeof res[ACCOUNTS_VAULT_KEY] === 'object' ? res[ACCOUNTS_VAULT_KEY] : null);
    });
  });

  const map = {};
  let needsScrubWrite = false;
  if (localMap) {
    for (const [k, raw] of Object.entries(localMap)) {
      if (!raw || typeof raw !== 'object') continue;
      if ('password' in raw || 'cookies' in raw || 'localStorageData' in raw) {
        needsScrubWrite = true;
      }
      const clean = sanitizeAccountForLocalStorage(raw);
      if (clean && clean.accountId) map[k] = clean;
    }
  }

  if (Object.keys(map).length === 0) {
    DEFAULT_ACCOUNT_PROFILES.forEach((p) => {
      map[p.accountId] = { ...p };
    });
    needsScrubWrite = true;
  }

  if (needsScrubWrite) {
    await new Promise((r) => chrome.storage.local.set({ [ACCOUNTS_VAULT_KEY]: map }, r));
  }
  return map;
}

async function saveAccountsVaultMap(map) {
  const sanitized = {};
  for (const [k, v] of Object.entries(map || {})) {
    const clean = sanitizeAccountForLocalStorage(v);
    if (clean && clean.accountId) sanitized[k] = clean;
  }
  return new Promise((resolve) => {
    chrome.storage.local.set({ [ACCOUNTS_VAULT_KEY]: sanitized }, () => resolve(sanitized));
  });
}

async function captureCurrentYandexCookies() {
  const allCookies = [];
  const seen = new Set();

  const queries = [
    { domain: 'yandex.ru' },
    { url: 'https://lavka.yandex.ru/' },
    { url: 'https://passport.yandex.ru/' },
    { url: 'https://id.yandex.ru/' }
  ];

  for (const q of queries) {
    try {
      const list = await chrome.cookies.getAll(q);
      for (const c of list || []) {
        if (!c || !c.name) continue;
        const key = `${c.name}|${c.domain}|${c.path}|${c.storeId || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allCookies.push({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          sameSite: c.sameSite || 'unspecified',
          expirationDate: c.expirationDate || null,
          hostOnly: Boolean(c.hostOnly)
        });
      }
    } catch {
      // ignore
    }
  }

  let yandexLogin = '';
  const loginCookie = allCookies.find((c) => c.name === 'yandex_login' && c.value);
  if (loginCookie) {
    try {
      yandexLogin = decodeURIComponent(loginCookie.value);
    } catch {
      yandexLogin = loginCookie.value;
    }
  }
  const hasSessionId = allCookies.some((c) => (c.name === 'Session_id' || c.name === 'sessionid2') && c.value);

  let localStorageData = {};
  try {
    const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
    if (lavkaTabs && lavkaTabs.length > 0 && lavkaTabs[0].id) {
      const res = await chrome.scripting.executeScript({
        target: { tabId: lavkaTabs[0].id },
        func: () => {
          const captured = {};
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && /address|location|cart|user|zone|region|auth/i.test(k)) {
                const v = localStorage.getItem(k);
                if (v && v.length < 4000) captured[k] = v;
              }
            }
          } catch {
            // ignore
          }
          return captured;
        }
      });
      if (res && res[0] && res[0].result) {
        localStorageData = res[0].result;
      }
    }
  } catch {
    // ignore
  }

  return {
    cookies: allCookies,
    cookieCount: allCookies.length,
    yandexLogin,
    isLoggedIn: Boolean(hasSessionId || yandexLogin),
    localStorageData
  };
}

async function clearLavkaTabLocalStorage(newLocalStorageData = null) {
  try {
    const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
    if (lavkaTabs && lavkaTabs.length > 0 && lavkaTabs[0].id) {
      await chrome.scripting.executeScript({
        target: { tabId: lavkaTabs[0].id },
        args: [newLocalStorageData || {}],
        func: (lsMap) => {
          try {
            const keysToRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && /address|location|cart|user|zone|region|auth/i.test(k)) {
                keysToRemove.push(k);
              }
            }
            keysToRemove.forEach((k) => localStorage.removeItem(k));
            for (const [k, v] of Object.entries(lsMap || {})) {
              if (k && typeof v === 'string') {
                localStorage.setItem(k, v);
              }
            }
          } catch {
            // ignore
          }
        }
      });
    }
  } catch {
    // ignore
  }
}

async function clearCurrentYandexAuthCookies() {
  const snap = await captureCurrentYandexCookies();
  for (const c of snap.cookies) {
    try {
      const cleanDomain = String(c.domain || 'lavka.yandex.ru').replace(/^\./, '');
      const proto = c.secure ? 'https://' : 'http://';
      const url = `${proto}${cleanDomain}${c.path || '/'}`;
      await chrome.cookies.remove({ url, name: c.name });
    } catch {
      // ignore
    }
  }
}

async function restoreAccountCookies(cookiesList, localStorageData = {}) {
  if (!Array.isArray(cookiesList) || cookiesList.length === 0) {
    return { restoredCount: 0 };
  }

  await clearCurrentYandexAuthCookies();

  let restoredCount = 0;
  const nowSec = Math.floor(Date.now() / 1000);

  for (const c of cookiesList) {
    if (!c || !c.name) continue;
    try {
      const cleanDomain = String(c.domain || 'lavka.yandex.ru').replace(/^\./, '');
      const isHostPrefix = c.name.startsWith('__Host-');
      const isSecurePrefix = c.name.startsWith('__Secure-') || isHostPrefix;
      const isSameSiteNone = c.sameSite === 'no_restriction';
      const secureFlag = Boolean(c.secure || isSecurePrefix || isSameSiteNone);
      const proto = secureFlag ? 'https://' : 'http://';
      const pathVal = isHostPrefix ? '/' : (c.path || '/');
      const url = `${proto}${cleanDomain}${pathVal}`;

      const details = {
        url,
        name: c.name,
        value: String(c.value ?? ''),
        path: pathVal,
        secure: secureFlag,
        httpOnly: Boolean(c.httpOnly)
      };

      if (!c.hostOnly && !isHostPrefix && c.domain) {
        details.domain = c.domain;
      }

      if (c.sameSite && ['no_restriction', 'lax', 'strict'].includes(c.sameSite)) {
        details.sameSite = c.sameSite;
      }

      if (c.expirationDate && c.expirationDate > nowSec + 60) {
        details.expirationDate = c.expirationDate;
      } else {
        details.expirationDate = nowSec + 30 * 86400;
      }

      await chrome.cookies.set(details);
      restoredCount += 1;
    } catch {
      // ignore
    }
  }

  await clearLavkaTabLocalStorage(localStorageData);

  return { restoredCount };
}

async function getAccountsVaultStatus() {
  const settings = await getSettings();
  const map = await getAccountsVaultMap();
  const deletedSet = await getDeletedAccountIdsSet();

  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  const srvAccounts = await fetchBackendVaultAccounts(backendUrl);
  if (Array.isArray(srvAccounts)) {
    let changed = false;
    for (const srvAcc of srvAccounts) {
      if (!srvAcc || !srvAcc.accountId) continue;
      if (deletedSet.has(srvAcc.accountId)) continue;
      const loc = map[srvAcc.accountId];
      const srvTime = String(srvAcc.updatedAt || '');
      const locTime = String(loc?.updatedAt || '');
      const srvMeta = sanitizeAccountForLocalStorage(srvAcc);
      if (!loc || srvTime >= locTime) {
        map[srvAcc.accountId] = { ...(loc || {}), ...srvMeta };
        changed = true;
      }
    }
    if (changed) await saveAccountsVaultMap(map);
  }

  const liveSession = await captureCurrentYandexCookies();
  const accountsList = Object.values(map).sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));

  return {
    ok: true,
    activeAccountLabel: settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)',
    liveSession: {
      isLoggedIn: liveSession.isLoggedIn,
      yandexLogin: liveSession.yandexLogin,
      cookieCount: liveSession.cookieCount
    },
    accounts: accountsList.map((a) => ({
      accountId: a.accountId,
      label: a.label,
      login: a.login || '',
      hasPassword: Boolean(a.hasPassword),
      note: a.note || '',
      yandexLogin: a.yandexLogin || '',
      cookieCount: Number(a.cookieCount || 0),
      updatedAt: a.updatedAt || null
    }))
  };
}

async function saveAccountToVault(payload = {}) {
  const settings = await getSettings();
  const map = await getAccountsVaultMap();
  const nowIso = new Date().toISOString();

  let accountId = payload.accountId || '';
  const label = (payload.label || settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)').trim();

  if (!accountId) {
    const existingByLabel = Object.values(map).find((a) => a.label === label);
    accountId = existingByLabel ? existingByLabel.accountId : `acc_${Date.now()}`;
  }

  await markAccountIdDeleted(accountId, false);

  const existing = map[accountId] || {
    accountId,
    label,
    login: '',
    note: '',
    yandexLogin: '',
    hasPassword: false,
    cookieCount: 0,
    updatedAt: nowIso
  };

  let capturedCookies = null;
  let capturedLs = null;
  let yandexLogin = existing.yandexLogin || '';

  if (payload.captureCookies !== false) {
    const captured = await captureCurrentYandexCookies();
    if (captured.cookies.length > 0) {
      capturedCookies = captured.cookies;
      capturedLs = captured.localStorageData || {};
      if (captured.yandexLogin) yandexLogin = captured.yandexLogin;
    }
  }

  const hasNewPassword = payload.password !== undefined && String(payload.password).length > 0;
  const wantsSecretSave = hasNewPassword || (capturedCookies && capturedCookies.length > 0);

  const backendPayload = {
    accountId,
    label: label || existing.label,
    login: payload.login !== undefined ? String(payload.login).trim() : (existing.login || yandexLogin || ''),
    note: payload.note !== undefined ? String(payload.note).trim() : (existing.note || ''),
    yandexLogin,
    updatedAt: nowIso
  };
  if (hasNewPassword) backendPayload.password = String(payload.password);
  if (capturedCookies) {
    backendPayload.cookies = capturedCookies;
    backendPayload.cookieCount = capturedCookies.length;
    backendPayload.localStorageData = capturedLs || {};
  }

  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  let backendSaved = false;
  if (backendUrl && Date.now() > backendOfflineUntilTs) {
    try {
      const headers = await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' });
      const r = await fetchWithTimeout(
        `${backendUrl}/api/accounts/save`,
        { method: 'POST', headers, body: JSON.stringify(backendPayload) },
        2000
      );
      backendSaved = r.ok;
    } catch {
      backendOfflineUntilTs = Date.now() + 10000;
    }
  }

  const localMeta = sanitizeAccountForLocalStorage({
    ...existing,
    ...backendPayload,
    hasPassword: backendSaved ? (hasNewPassword || Boolean(existing.hasPassword)) : Boolean(existing.hasPassword),
    cookieCount: backendSaved && capturedCookies ? capturedCookies.length : Number(existing.cookieCount || 0)
  });

  map[accountId] = localMeta;
  await saveAccountsVaultMap(map);
  await saveSettingsPatch({ lavkaAccountLabel: localMeta.label });

  if (wantsSecretSave && !backendSaved) {
    return {
      ok: false,
      error: 'Локальный сервер (:8765) недоступен — метаданные обновлены, но пароли и куки сохраняются только в зашифрованном DPAPI-сейфе сервера.',
      account: localMeta,
      vaultStatus: await getAccountsVaultStatus()
    };
  }

  return {
    ok: true,
    account: localMeta,
    vaultStatus: await getAccountsVaultStatus()
  };
}

async function deleteAccountFromVault(accountId) {
  const settings = await getSettings();
  const map = await getAccountsVaultMap();
  await markAccountIdDeleted(accountId, true);
  if (map[accountId]) {
    delete map[accountId];
    await saveAccountsVaultMap(map);
  }
  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  if (backendUrl && Date.now() > backendOfflineUntilTs) {
    try {
      const headers = await getBackendAuthHeaders(backendUrl);
      await fetchWithTimeout(
        `${backendUrl}/api/accounts/${encodeURIComponent(accountId)}`,
        { method: 'DELETE', headers },
        1500
      );
    } catch {
      backendOfflineUntilTs = Date.now() + 10000;
    }
  }
  return await getAccountsVaultStatus();
}

async function autofillYandexPassportTab(accountId) {
  const settings = await getSettings();
  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  const map = await getAccountsVaultMap();
  const metaAcc = map[accountId] || Object.values(map).find((a) => a.label === accountId);
  const srvAccounts = await fetchBackendVaultAccounts(backendUrl);
  const srvAcc = Array.isArray(srvAccounts)
    ? srvAccounts.find((a) => a.accountId === (metaAcc?.accountId || accountId) || a.label === accountId)
    : null;
  const acc = srvAcc ? { ...(metaAcc || {}), ...srvAcc } : metaAcc;
  if (!acc || (!acc.login && !acc.password)) {
    const hint = !srvAccounts ? ' Убедись, что локальный сервер (:8765) запущен.' : '';
    return { ok: false, error: `Для этого профиля ещё не указаны логин и пароль.${hint}` };
  }

  await saveSettingsPatch({ lavkaAccountLabel: acc.label });

  const passportTabs = await chrome.tabs.query({
    url: ['https://passport.yandex.ru/*', 'https://id.yandex.ru/*']
  });

  let targetTab = passportTabs && passportTabs.length > 0 ? passportTabs[0] : null;
  if (!targetTab) {
    targetTab = await chrome.tabs.create({
      url: 'https://passport.yandex.ru/auth?retpath=https%3A%2F%2Flavka.yandex.ru%2F',
      active: true
    });
    await waitForTabCompleteSafe(targetTab.id, 5500);
  } else {
    await chrome.tabs.update(targetTab.id, { active: true });
  }

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      args: [acc.login || '', acc.password || ''],
      func: async (loginVal, passVal) => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const setReactInputValue = (el, val) => {
          if (!el) return false;
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) {
            setter.call(el, val);
          } else {
            el.value = val;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };

        let filledLogin = false;
        let filledPassword = false;

        if (loginVal) {
          const loginInput =
            document.querySelector('input[name="login"]') ||
            document.querySelector('input#passp-field-login') ||
            document.querySelector('input#passp-field-phone') ||
            document.querySelector('input[autocomplete="username"]') ||
            document.querySelector('input[type="text"], input[type="tel"], input[type="email"]');

          if (loginInput) {
            filledLogin = setReactInputValue(loginInput, loginVal);
            await wait(250);
            const submitBtn =
              document.querySelector('button[id="passp:sign-in"]') ||
              document.querySelector('button[type="submit"]');
            if (submitBtn && passVal) {
              submitBtn.click();
              await wait(900);
            }
          }
        }

        if (passVal) {
          for (let i = 0; i < 8; i++) {
            const passInput =
              document.querySelector('input[name="passwd"]') ||
              document.querySelector('input#passp-field-passwd') ||
              document.querySelector('input[type="password"]');
            if (passInput) {
              filledPassword = setReactInputValue(passInput, passVal);
              break;
            }
            await wait(300);
          }
        }

        return { ok: Boolean(filledLogin || filledPassword), filledLogin, filledPassword };
      }
    });
    const r = res && res[0] ? res[0].result : null;
    return {
      ok: true,
      filledLogin: r?.filledLogin || false,
      filledPassword: r?.filledPassword || false,
      label: acc.label
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function switchLavkaAccountInOneClick(options = {}) {
  const { accountId, label, autoBackupCurrent = true, buildCartAfterSwitch = false } = options;
  const settings = await getSettings();
  const map = await getAccountsVaultMap();

  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  if (autoBackupCurrent) {
    const currentLive = await captureCurrentYandexCookies();
    if (currentLive.isLoggedIn && currentLive.cookies.length > 0) {
      const curLabel = settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)';
      const curEntry = Object.values(map).find(
        (a) => a.label === curLabel || (currentLive.yandexLogin && a.yandexLogin === currentLive.yandexLogin)
      );
      if (curEntry) {
        const nowIso = new Date().toISOString();
        if (backendUrl && Date.now() > backendOfflineUntilTs) {
          try {
            const headers = await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' });
            await fetchWithTimeout(
              `${backendUrl}/api/accounts/save`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  accountId: curEntry.accountId,
                  label: curEntry.label,
                  login: curEntry.login || '',
                  note: curEntry.note || '',
                  yandexLogin: currentLive.yandexLogin || curEntry.yandexLogin || '',
                  cookieCount: currentLive.cookies.length,
                  cookies: currentLive.cookies,
                  localStorageData: currentLive.localStorageData || {},
                  updatedAt: nowIso
                })
              },
              2000
            );
          } catch {
            backendOfflineUntilTs = Date.now() + 10000;
          }
        }
        curEntry.cookieCount = currentLive.cookies.length;
        if (currentLive.yandexLogin) curEntry.yandexLogin = currentLive.yandexLogin;
        curEntry.updatedAt = nowIso;
        map[curEntry.accountId] = sanitizeAccountForLocalStorage(curEntry);
        await saveAccountsVaultMap(map);
      }
    }
  }

  const targetMeta =
    (accountId && map[accountId]) ||
    Object.values(map).find((a) => a.label === label || a.accountId === accountId);
  const srvAccounts = await fetchBackendVaultAccounts(backendUrl);
  const targetSrv = Array.isArray(srvAccounts) && targetMeta
    ? srvAccounts.find((a) => a.accountId === targetMeta.accountId)
    : null;
  const targetAcc = targetSrv ? { ...targetMeta, ...targetSrv } : targetMeta;

  if (!targetAcc) {
    if (label) {
      await saveSettingsPatch({ lavkaAccountLabel: label });
    }
    return {
      ok: false,
      error: 'Профиль не найден в сейфе аккаунтов.',
      vaultStatus: await getAccountsVaultStatus()
    };
  }

  await saveSettingsPatch({ lavkaAccountLabel: targetAcc.label });

  let switchedCookies = false;
  let restoredCount = 0;

  if (Array.isArray(targetAcc.cookies) && targetAcc.cookies.length > 0) {
    const restoreRes = await restoreAccountCookies(targetAcc.cookies, targetAcc.localStorageData || {});
    restoredCount = restoreRes.restoredCount;
    switchedCookies = restoredCount > 0;
  } else {
    await clearCurrentYandexAuthCookies();
    await clearLavkaTabLocalStorage({});
  }

  const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
  if (lavkaTabs && lavkaTabs.length > 0 && lavkaTabs[0].id) {
    if (buildCartAfterSwitch) {
      await chrome.tabs.update(lavkaTabs[0].id, { active: true });
    } else {
      await chrome.tabs.reload(lavkaTabs[0].id);
    }
  }

  let autoBuildResult = null;
  if (buildCartAfterSwitch) {
    await new Promise((r) => setTimeout(r, 900));
    autoBuildResult = await autoBuildCartInBrowser(null);
  }

  let autofillTriggered = false;
  if (!switchedCookies && (targetAcc.login || targetAcc.password)) {
    await autofillYandexPassportTab(targetAcc.accountId);
    autofillTriggered = true;
  }

  return {
    ok: true,
    switchedTo: targetAcc.label,
    switchedCookies,
    restoredCount,
    autofillTriggered,
    autoBuildResult,
    vaultStatus: await getAccountsVaultStatus()
  };
}

async function logoutToCleanLavkaSession() {
  const settings = await getSettings();
  await saveAccountToVault({
    label: settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)',
    captureCookies: true
  });
  await clearCurrentYandexAuthCookies();
  await clearLavkaTabLocalStorage({});

  const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
  if (lavkaTabs && lavkaTabs.length > 0 && lavkaTabs[0].id) {
    await chrome.tabs.reload(lavkaTabs[0].id);
  }

  return {
    ok: true,
    vaultStatus: await getAccountsVaultStatus()
  };
}

// ============================================================================
// 3. МУЛЬТИ-АККАУНТ БАЗА ИСТОРИИ ЦЕН И ПАРСЕР ОРИГИНАЛЬНОЙ КАРТОЧКИ ТОВАРА
// ============================================================================
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
  const guestPrice = item.guestPrice ? Number(item.guestPrice) : (existing?.guestPrice || null);
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
    guestPrice: null,
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

  if (guestPrice && guestPrice > 0) {
    entry.guestPrice = Math.round(guestPrice);
    entry.accounts['Гость (без куки)'] = {
      price: Math.round(guestPrice),
      oldPrice: null,
      updatedAt: nowIso
    };
  }
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
  if (backendUrl && Date.now() > backendOfflineUntilTs) {
    try {
      const resp = await fetchWithTimeout(
        `${backendUrl}/api/price/record`,
        {
          method: 'POST',
          headers: await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
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
      backendOfflineUntilTs = Date.now() + 10000;
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
 * и возвращает как гостевую цену, так и ПОЛНОЕ название и характеристики из карточки товара!
 */
async function probeGuestPriceAndCardMeta(slug, fallbackTitle = '', currentPrice = null, accountId = null, fallbackAmount = '', fallbackImageKey = null) {
  if (!slug) return null;
  const cleanSlug = String(slug).trim().toLowerCase();
  const url = `https://lavka.yandex.ru/good/${encodeURIComponent(cleanSlug)}`;

  let parsedCard = null;
  let guestPrice = null;

  // Сначала пробуем без куки (получаем и гостевую цену, и полное название из оригинальной карточки!)
  try {
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
      3800
    );
    if (resp.ok) {
      const html = await resp.text();
      parsedCard = parseFullProductCardFromLavkaHtml(html);
      if (parsedCard && parsedCard.price > 0) {
        guestPrice = parsedCard.price;
      }
    }
  } catch {
    // ignore
  }

  // Если без куки Лавка не отдала заголовок h1 карточки (например, редирект локации), запрашиваем с куками пользователя!
  if (!parsedCard || !parsedCard.cardTitle) {
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
        3800
      );
      if (respAuth.ok) {
        const htmlAuth = await respAuth.text();
        const parsedAuth = parseFullProductCardFromLavkaHtml(htmlAuth);
        if (parsedAuth && parsedAuth.cardTitle) {
          parsedCard = {
            ...parsedAuth,
            price: guestPrice || parsedAuth.price
          };
        }
      }
    } catch {
      // ignore
    }
  }

  const canonicalTitle = parsedCard?.cardTitle
    ? buildFullProductSearchQuery(parsedCard.cardTitle, parsedCard.cardBrand || '', parsedCard.cardAmount || fallbackAmount)
    : fallbackTitle;
  const canonicalAmount = parsedCard?.cardAmount || fallbackAmount || '';
  const canonicalBrand = parsedCard?.cardBrand || '';
  const canonicalImageKey = parsedCard?.imageKey || fallbackImageKey || null;
  const hasCanonicalTitle = Boolean(parsedCard?.cardTitle);

  if (guestPrice || hasCanonicalTitle || currentPrice) {
    const summaries = await recordPricesBatch(accountId, [
      {
        slug: cleanSlug,
        title: canonicalTitle || cleanSlug,
        isCanonicalCardTitle: hasCanonicalTitle,
        brand: canonicalBrand,
        imageKey: canonicalImageKey,
        amount: canonicalAmount,
        price: currentPrice || guestPrice || 0,
        guestPrice: guestPrice || null
      }
    ]);
    return summaries[cleanSlug] || {
      slug: cleanSlug,
      title: canonicalTitle,
      isCanonicalCardTitle: hasCanonicalTitle,
      brand: canonicalBrand,
      imageKey: canonicalImageKey,
      amount: canonicalAmount,
      guestPrice
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
  if (backendUrl && Date.now() > backendOfflineUntilTs) {
    try {
      const qTitle = fullCardTitle ? `?title=${encodeURIComponent(fullCardTitle)}` : '';
      const r = await fetchWithTimeout(
        `${backendUrl}/api/price/product/${encodeURIComponent(cleanSlug)}${qTitle}`,
        { method: 'GET', headers: await getBackendAuthHeaders(backendUrl) },
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
      backendOfflineUntilTs = Date.now() + 10000;
    }
  }

  if (
    (settings.enableGuestPriceProbe !== false && (!summary || !summary.guestPrice)) ||
    (!summary || !summary.isCanonicalCardTitle)
  ) {
    const probed = await probeGuestPriceAndCardMeta(
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
        const directStoreOffers = await probeDirectRetailStoresForProduct(authoritativeTitle, authoritativeBrand, authoritativeAmount, currentPrice);
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

function buildDirectStoreSearchLinks(rawTitle, amount = '', brand = '') {
  const fullQuery = buildFullProductSearchQuery(rawTitle, brand, amount);
  const enc = encodeURIComponent(fullQuery || rawTitle || '');
  return [
    // У дома и экспресс
    { store: 'Магнит', category: 'У дома', url: `https://magnit.ru/search?term=${enc}`, query: fullQuery },
    { store: 'Пятёрочка', category: 'У дома', url: `https://5ka.ru/catalog/?q=${enc}`, query: fullQuery },
    { store: 'Перекрёсток', category: 'Супермаркет', url: `https://www.perekrestok.ru/cat/search?search=${enc}`, query: fullQuery },
    { store: 'ВкусВилл', category: 'У дома', url: `https://vkusvill.ru/search/?q=${enc}`, query: fullQuery },
    { store: 'Магнолия', category: 'У дома', url: `https://shop.mgnl.ru/catalog/?q=${enc}`, query: fullQuery },
    { store: 'Дикси', category: 'У дома', url: `https://dixy.ru/catalog/?q=${enc}`, query: fullQuery },
    { store: 'Чижик', category: 'Дискаунтер', url: `https://chizhik.club/search?query=${enc}`, query: fullQuery },
    // Гипермаркеты
    { store: 'Ашан', category: 'Гипермаркет', url: `https://www.auchan.ru/search/?q=${enc}`, query: fullQuery },
    { store: 'МЕТРО', category: 'Гипермаркет', url: `https://online.metro-cc.ru/search?q=${enc}`, query: fullQuery },
    { store: 'Глобус', category: 'Гипермаркет', url: `https://online.globus.ru/search/?q=${enc}`, query: fullQuery },
    { store: 'Лента', category: 'Гипермаркет', url: `https://lenta.com/search/?searchText=${enc}`, query: fullQuery },
    { store: 'О’КЕЙ', category: 'Гипермаркет', url: `https://www.okeydostavka.ru/webapp/wcs/stores/servlet/SearchDisplay?searchTerm=${enc}`, query: fullQuery },
    { store: 'Азбука Вкуса', category: 'Супермаркет', url: `https://av.ru/search/?text=${enc}`, query: fullQuery },
    // Маркетплейсы и агрегаторы
    { store: 'Ozon Fresh', category: 'Маркетплейс', url: `https://www.ozon.ru/search/?text=${enc}`, query: fullQuery },
    { store: 'Купер', category: 'Агрегатор', url: `https://kuper.ru/multisearch?q=${enc}`, query: fullQuery },
    { store: 'Я.Маркет', category: 'Маркетплейс', url: `https://market.yandex.ru/search?text=${enc}`, query: fullQuery }
  ];
}

async function getExternalStoreOffersList() {
  return new Promise((resolve) => {
    chrome.storage.local.get([EXT_STORE_DB_KEY], (res) => {
      const saved = res && Array.isArray(res[EXT_STORE_DB_KEY]) ? res[EXT_STORE_DB_KEY] : [];
      const combined = [...saved];
      const seenUrls = new Set(combined.map((o) => o.url));
      for (const seed of MAGNIT_RECON_SEED_OFFERS) {
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
  const stopKeepAlive = startSwKeepAlive();
  try {
    const settings = await getSettings();
    const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)';
    let priceDb = await getLocalPriceDb();

    // Шаг 1: Для всех позиций корзины, у которых ещё нет полного названия из оригинальной карточки товара (`isCanonicalCardTitle`),
    // параллельно подтягиваем оригинальную карточку `https://lavka.yandex.ru/good/<slug>`!
    const itemsNeedingCardResolution = items.filter((item) => {
      if (!item || !item.slug) return false;
      const existing = findPriceEntryInDb(priceDb, item.slug, item.title, item.imageKey);
      return !existing || !existing.isCanonicalCardTitle || (settings.enableGuestPriceProbe !== false && !existing.guestPrice);
    });

    for (let i = 0; i < itemsNeedingCardResolution.length; i += 4) {
      const chunk = itemsNeedingCardResolution.slice(i, i + 4);
      await Promise.all(
        chunk.map((it) =>
          probeGuestPriceAndCardMeta(
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

      const aiEntry = await getLocalAiCacheEntry(slug, fullAuthoritativeTitle, cardImageKey);
      const guestPrice = pEntry?.guestPrice || null;

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
        const extracted = extractCompetitorPricesFromSources(
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
        const foundSources = await searchWebReviewsDirect(fullAuthoritativeTitle, cardBrand, cardAmount);
        const extracted = extractCompetitorPricesFromSources(
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
          guestPrice: guestPrice || null,
          competitorMinPrice: compMin || null,
          competitorSummary: compSum || null,
          competitorOffers: compOffers
        });
      }

      let bestAltPrice = null;
      let bestAltLabel = '';
      if (guestPrice && guestPrice < price - 2) {
        bestAltPrice = guestPrice;
        bestAltLabel = 'Без куки (Гость)';
      }
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
        guestPrice: guestPrice || null,
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
    let guestTotal = 0;
    const batchToRecord = [];

    for (const item of latest.items) {
      const slug = String(item.slug || '').trim().toLowerCase();
      const qty = Number(item.qty) || 1;
      const sourcePrice = Number(item.price) || 0;
      const existingEntry = findPriceEntryInDb(priceDb, slug, item.title, item.imageKey);

      let currentPrice = null;
      let guestPrice = existingEntry?.guestPrice || null;
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

      if (!guestPrice) {
        try {
          const url = `https://lavka.yandex.ru/good/${encodeURIComponent(slug)}`;
          const respG = await fetchWithTimeout(url, { method: 'GET', credentials: 'omit', cache: 'no-store' }, 3500);
          if (respG.ok) {
            const htmlG = await respG.text();
            const parsedG = parseFullProductCardFromLavkaHtml(htmlG);
            if (parsedG) {
              if (parsedG.price > 0) guestPrice = parsedG.price;
              if (!isCanonical && parsedG.cardTitle) {
                cardTitle = buildFullProductSearchQuery(parsedG.cardTitle, parsedG.cardBrand || '', parsedG.cardAmount || item.amount || '');
                isCanonical = true;
              }
            }
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
          title: cardTitle,
          isCanonicalCardTitle: isCanonical,
          imageKey: item.imageKey || existingEntry?.imageKey || null,
          price: currentPrice,
          guestPrice: guestPrice || null,
          amount: item.amount || existingEntry?.amount || ''
        });
      }

      comparedItems.push({
        slug,
        title: cardTitle,
        qty,
        sourcePrice,
        currentPrice: effCurrent,
        guestPrice: guestPrice || null,
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
      guestTotal: Math.round(guestTotal),
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
    if (resp.ok) {
      const html = await resp.text();
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
      5500
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
    return results;
  } catch {
    return [];
  }
}

async function probeVkusVillSearchDirect(fullQuery, productTitle, productAmount = '', lavkaPrice = null) {
  if (!fullQuery) return [];
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
    if (!resp.ok) return [];
    const html = await resp.text();
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
    return offers;
  } catch {
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

// ============================================================================
// 6. РАБОТА С ВКЛАДКОЙ GEMINI И КУКАМИ GOOGLE
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
  await waitForTabCompleteSafe(created.id, 6500);
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
    if (aiBaseUrl && Date.now() > bridgeOfflineUntilTs) {
      try {
        const headers = settings.aiApiKey ? { Authorization: `Bearer ${settings.aiApiKey}` } : {};
        const bridgeResp = await fetchWithTimeout(`${aiBaseUrl}/models`, { method: 'GET', headers }, 900);
        if (bridgeResp.ok) return;
      } catch {
        bridgeOfflineUntilTs = Date.now() + 15000;
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

/**
 * Надёжное выполнение промпта и чтение ответа из вкладки gemini.google.com (v2.6.0):
 * 1) Не держит один долгий executeScript внутри фоновой вкладки (где Chrome троттлит setTimeout до 1+ сек и может заморозить промис).
 * 2) Вместо .innerText (который в фоновых/скрытых вкладках с content-visibility:auto может возвращать пустую строку)
 *    использует собственный DOM-сериализатор на базе textContent с сохранением **жирного** текста и переносов строк.
 * 3) Если в открытой вкладке Gemini УЖЕ сгенерирован готовый ответ по этому товару (пользователь видит его во вкладке),
 *    мгновенно забирает его за 0.1 сек без повторного ожидания!
 */
async function executePromptInsideGeminiTab(tabId, promptText, productTitle = '', forceRefresh = false) {
  const stopKeepAlive = startSwKeepAlive();
  const swWait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // ФАЗА 1: Быстрая проверка готового ответа во вкладке ИЛИ ввод промпта и клик «Отправить» (< 450 мс)
    const initResults = await chrome.scripting.executeScript({
      target: { tabId },
      args: [promptText, productTitle || '', Boolean(forceRefresh)],
      func: async (prompt, targetProdTitle, isForce) => {
        try {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));

          // Layout-независимый сериализатор ответа Gemini (работает на 100% даже в свёрнутой/фоновой вкладке!)
          const extractCleanFormattedText = (rootNode) => {
            if (!rootNode) return '';
            const walk = (node) => {
              if (!node) return '';
              if (node.nodeType === Node.TEXT_NODE) {
                return node.nodeValue || '';
              }
              if (node.nodeType !== Node.ELEMENT_NODE) return '';
              const tag = (node.tagName || '').toLowerCase();
              if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'button' || tag === 'mat-icon') {
                return '';
              }
              if (tag === 'br') return '\n';
              let inner = '';
              for (const child of node.childNodes) {
                inner += walk(child);
              }
              if (tag === 'strong' || tag === 'b') {
                const trimmed = inner.trim();
                return trimmed ? `**${trimmed}**` : '';
              }
              if (tag === 'li') {
                return `\n• ${inner.trim()}\n`;
              }
              if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'tr', 'blockquote'].includes(tag)) {
                return `${inner}\n`;
              }
              return inner;
            };
            const raw = walk(rootNode) || rootNode.textContent || '';
            return raw
              .replace(/\r/g, '')
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
          };

          const getTopLevelResponseNodes = () => {
            const topModels = Array.from(document.querySelectorAll('model-response'));
            if (topModels.length > 0) {
              return topModels.map((m) => m.querySelector('message-content, .markdown, .model-response-text') || m);
            }
            const msgContents = Array.from(document.querySelectorAll('message-content'));
            if (msgContents.length > 0) return msgContents;
            return Array.from(document.querySelectorAll('.model-response-text, .markdown, [data-message-author-role="model"]'));
          };

          const findStopBtn = () =>
            document.querySelector(
              'button[aria-label*="Stop"], button[aria-label*="Остановить"], button[aria-label*="Прервать"], button.stop-button'
            );

          const isStillGenerating = () => {
            const stopBtn = findStopBtn();
            if (stopBtn && !stopBtn.disabled && stopBtn.getBoundingClientRect().width > 0) return true;
            const busyModels = document.querySelectorAll('model-response[aria-busy="true"], .response-streaming');
            return busyModels.length > 0;
          };

          const existingNodes = getTopLevelResponseNodes();
          const initialCount = existingNodes.length;
          const initialLastText = initialCount > 0 ? extractCleanFormattedText(existingNodes[initialCount - 1]) : '';

          // ПРОВЕРКА: Вдруг во вкладке Gemini УЖЕ лежит готовый ответ для этого товара?
          if (!isForce && initialLastText.length > 80 && !isStillGenerating()) {
            const pageTextLower = (document.body.textContent || '').toLowerCase().replace(/ё/g, 'е');
            const lastTextLower = initialLastText.toLowerCase().replace(/ё/g, 'е');
            const hasVerdictMarkers =
              lastTextLower.includes('вердикт') &&
              (lastTextLower.includes('отзывы') || lastTextLower.includes('состав'));

            if (hasVerdictMarkers && targetProdTitle) {
              const titleWords = String(targetProdTitle)
                .toLowerCase()
                .replace(/ё/g, 'е')
                .match(/[а-яa-z0-9]{4,}/g) || [];
              const significantWords = titleWords.filter(
                (w) => !['напиток', 'газированный', 'продукт', 'товар', 'купить'].includes(w)
              );
              // Проверяем последний запрос пользователя или сам последний ответ во вкладке
              const userPrompts = Array.from(document.querySelectorAll('user-query, .query-text, [data-message-author-role="user"]'));
              const lastUserPromptText = userPrompts.length > 0
                ? (userPrompts[userPrompts.length - 1].textContent || '').toLowerCase().replace(/ё/g, 'е')
                : pageTextLower.slice(-3500);

              const matchedInLastTurn = significantWords.length > 0 && significantWords.every(
                (w) => lastUserPromptText.includes(w.slice(0, 5)) || lastTextLower.includes(w.slice(0, 5))
              );
              if (matchedInLastTurn) {
                return {
                  ok: true,
                  alreadyReadyInTab: true,
                  mode: `Вкладка Gemini (${window.location.pathname})`,
                  text: initialLastText
                };
              }
            }
          }

          const findEditor = () =>
            document.querySelector('rich-textarea div.ql-editor[contenteditable="true"]') ||
            document.querySelector('div[contenteditable="true"][role="textbox"]') ||
            document.querySelector('div[contenteditable="true"]') ||
            document.querySelector('textarea');

          let editor = findEditor();
          for (let waitTick = 0; !editor && waitTick < 12; waitTick++) {
            await wait(250);
            editor = findEditor();
          }

          if (!editor) {
            return {
              ok: false,
              error: 'На вкладке gemini.google.com не найдено поле ввода чата (убедись, что ты вошёл в аккаунт Google).'
            };
          }

          const activeStop = findStopBtn();
          if (activeStop && !activeStop.disabled && activeStop.getBoundingClientRect().width > 0) {
            activeStop.click();
            await wait(350);
          }

          const refreshedNodes = getTopLevelResponseNodes();
          const baselineCount = refreshedNodes.length;
          const baselineText = baselineCount > 0 ? extractCleanFormattedText(refreshedNodes[baselineCount - 1]) : '';

          const fillPromptIntoEditor = () => {
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
              if (!inserted || !(editor.textContent || '').trim()) {
                editor.textContent = prompt;
                editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt }));
              }
            }
          };

          const triggerSend = () => {
            const sendBtn =
              document.querySelector('button.send-button') ||
              document.querySelector('button[aria-label*="Send"]') ||
              document.querySelector('button[aria-label*="Отправить"]') ||
              document.querySelector('.send-button-container button') ||
              document.querySelector('button.submit');

            if (sendBtn && !sendBtn.disabled) {
              sendBtn.click();
              return true;
            }
            editor.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
            );
            return false;
          };

          fillPromptIntoEditor();
          await wait(220);
          const clickedSend = triggerSend();

          return {
            ok: true,
            injected: true,
            clickedSend,
            baselineCount,
            baselineText,
            pathname: window.location.pathname
          };
        } catch (domErr) {
          return {
            ok: false,
            error: `Ошибка ввода в DOM вкладки Gemini: ${domErr.message || domErr}`
          };
        }
      }
    });

    const initRes = initResults && initResults[0] ? initResults[0].result : null;
    if (!initRes || !initRes.ok) {
      return initRes || { ok: false, error: 'Не удалось обратиться к вкладке Gemini.' };
    }

    // Если ответ уже лежал готовым во вкладке Gemini — возвращаем его мгновенно!
    if (initRes.alreadyReadyInTab && initRes.text) {
      return {
        ok: true,
        mode: initRes.mode || 'Вкладка Gemini (готовый ответ)',
        text: initRes.text
      };
    }

    const baselineCount = initRes.baselineCount || 0;
    const baselineText = initRes.baselineText || '';
    let lastText = '';
    let stableTicks = 0;
    let retriedSend = false;

    // ФАЗА 2: Опрос из Service Worker'а (не подвержен фоновому троттлингу вкладки!)
    for (let tick = 0; tick < 44; tick++) {
      await swWait(800);

      const pollResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [baselineCount, baselineText, promptText, tick === 4 && !retriedSend],
        func: (baseCnt, baseTxt, prompt, shouldRetrySendIfIdle) => {
          const extractCleanFormattedText = (rootNode) => {
            if (!rootNode) return '';
            const walk = (node) => {
              if (!node) return '';
              if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
              if (node.nodeType !== Node.ELEMENT_NODE) return '';
              const tag = (node.tagName || '').toLowerCase();
              if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'button' || tag === 'mat-icon') {
                return '';
              }
              if (tag === 'br') return '\n';
              let inner = '';
              for (const child of node.childNodes) {
                inner += walk(child);
              }
              if (tag === 'strong' || tag === 'b') {
                const trimmed = inner.trim();
                return trimmed ? `**${trimmed}**` : '';
              }
              if (tag === 'li') {
                return `\n• ${inner.trim()}\n`;
              }
              if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'tr', 'blockquote'].includes(tag)) {
                return `${inner}\n`;
              }
              return inner;
            };
            const raw = walk(rootNode) || rootNode.textContent || '';
            return raw
              .replace(/\r/g, '')
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
          };

          const getTopLevelResponseNodes = () => {
            const topModels = Array.from(document.querySelectorAll('model-response'));
            if (topModels.length > 0) {
              return topModels.map((m) => m.querySelector('message-content, .markdown, .model-response-text') || m);
            }
            const msgContents = Array.from(document.querySelectorAll('message-content'));
            if (msgContents.length > 0) return msgContents;
            return Array.from(document.querySelectorAll('.model-response-text, .markdown, [data-message-author-role="model"]'));
          };

          const findStopBtn = () =>
            document.querySelector(
              'button[aria-label*="Stop"], button[aria-label*="Остановить"], button[aria-label*="Прервать"], button.stop-button'
            );

          const isStillGenerating = () => {
            const stopBtn = findStopBtn();
            if (stopBtn && !stopBtn.disabled && stopBtn.getBoundingClientRect().width > 0) return true;
            const busyModels = document.querySelectorAll('model-response[aria-busy="true"], .response-streaming');
            return busyModels.length > 0;
          };

          const nodes = getTopLevelResponseNodes();
          const currentCount = nodes.length;
          const latestNode = currentCount > 0 ? nodes[currentCount - 1] : null;
          const currentText = latestNode ? extractCleanFormattedText(latestNode) : '';
          const generating = isStillGenerating();
          const isNew = currentCount > baseCnt || (currentText && currentText !== baseTxt);

          let didRetrySend = false;
          if (shouldRetrySendIfIdle && !isNew && !generating) {
            const sendBtn =
              document.querySelector('button.send-button') ||
              document.querySelector('button[aria-label*="Send"]') ||
              document.querySelector('button[aria-label*="Отправить"]') ||
              document.querySelector('.send-button-container button');
            if (sendBtn && !sendBtn.disabled) {
              sendBtn.click();
              didRetrySend = true;
            }
          }

          return {
            currentCount,
            currentText,
            generating,
            isNew,
            didRetrySend,
            pathname: window.location.pathname
          };
        }
      });

      const poll = pollResults && pollResults[0] ? pollResults[0].result : null;
      if (!poll) continue;
      if (poll.didRetrySend) retriedSend = true;

      if (poll.isNew && poll.currentText && poll.currentText.length > 35) {
        const hasVerdictWord = /вердикт|стоит брать|хороший вариант|на любителя|не рекомендую/i.test(poll.currentText);
        if (poll.currentText === lastText && !poll.generating) {
          stableTicks += 1;
          if (stableTicks >= 2 || (stableTicks >= 1 && hasVerdictWord)) {
            return {
              ok: true,
              mode: `Вкладка Gemini (${poll.pathname || '/app'})`,
              text: poll.currentText
            };
          }
        } else {
          lastText = poll.currentText;
          stableTicks = (!poll.generating && hasVerdictWord && poll.currentText.length > 140) ? 1 : 0;
        }
      }
    }

    if (lastText && lastText.length > 35) {
      return {
        ok: true,
        mode: `Вкладка Gemini (${initRes.pathname || '/app'})`,
        text: lastText
      };
    }

    return {
      ok: false,
      error: 'Вкладка Gemini ещё генерирует ответ или ожидает вход в аккаунт (нажми «🤖 ИИ-обзор» или «🔄 Обновить» ещё раз, чтобы забрать готовый текст).'
    };
  } catch (err) {
    return {
      ok: false,
      error: `Ошибка доступа к вкладке Gemini: ${err.message || err}`
    };
  } finally {
    stopKeepAlive();
  }
}

function enqueueGeminiTabExecution(taskFn) {
  const next = geminiTabMutex.then(() => taskFn(), () => taskFn());
  geminiTabMutex = next.catch(() => {});
  return next;
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
  const aiBaseUrl = settings.aiBaseUrl.replace(/\/$/, '');

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

  let bridgeStatus = { ok: false, msg: 'Выкл (работает вкладка)' };
  try {
    const headers = settings.aiApiKey ? { Authorization: `Bearer ${settings.aiApiKey}` } : {};
    const r2 = await fetchWithTimeout(`${aiBaseUrl}/models`, { method: 'GET', headers }, 1000);
    if (r2.ok) {
      bridgeOfflineUntilTs = 0;
      bridgeStatus = { ok: true, msg: `ОК (${settings.aiModel})` };
    } else {
      bridgeStatus = { ok: false, msg: `HTTP ${r2.status} (проверь ключ)` };
    }
  } catch {
    bridgeOfflineUntilTs = Date.now() + 12000;
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
    const aiBaseUrl = settings.aiBaseUrl.replace(/\/$/, '');
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
                guestPrice: priceIntel?.guestPrice || null,
                aiBaseUrl: settings.aiBaseUrl,
                aiApiKey: settings.aiApiKey,
                aiModel: settings.aiModel
              })
            },
            9500
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
              const modeLabel = data.cached ? 'FastAPI SQLite Cache (:8765)' : `FastAPI (:8765) + ${settings.aiModel}`;
              await saveLocalAiCacheEntry(payload.slug, authoritativeTitle, data.verdict, webSources, modeLabel, payload.imageKey);
              const resObj = {
                ok: true,
                cached: Boolean(data.cached),
                mode: modeLabel,
                verdict: data.verdict,
                sources: webSources,
                priceSummary: priceIntel
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

    if (aiBaseUrl && Date.now() > bridgeOfflineUntilTs) {
      try {
        const promptForBridge = buildProductReviewPrompt({ ...payload, title: authoritativeTitle }, webSources, false, priceIntel);
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
          6000
        );

        if (directResp.ok) {
          bridgeOfflineUntilTs = 0;
          const json = await directResp.json();
          const reply = json.choices?.[0]?.message?.content;
          if (reply) {
            const cleanReply = reply.trim();
            const modeLabel = `Мост ${settings.aiModel} (${aiBaseUrl})`;
            await saveLocalAiCacheEntry(payload.slug, authoritativeTitle, cleanReply, webSources, modeLabel, payload.imageKey);
            if (backendOnline) {
              saveVerdictToBackendCache(backendUrl, payload.slug, authoritativeTitle, cleanReply, webSources);
            }
            const resObj = {
              ok: true,
              cached: false,
              mode: modeLabel,
              verdict: cleanReply,
              sources: webSources,
              priceSummary: priceIntel
            };
            broadcastAiVerdictToLavkaTabs(payload.slug, authoritativeTitle, resObj);
            return resObj;
          }
        }
      } catch {
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
    if (existingEntry && Date.now() - existingEntry.startedAt < 12000) {
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
chrome.runtime.onInstalled.addListener(() => {
  ensureAutopilotWarmup('onInstalled');
  getAccountsVaultMap();
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

  if (msg.type === 'LQS_RECORD_EXTERNAL_STORE_OFFERS') {
    recordExternalStoreOffers(msg.store || 'Магнит', msg.offers || [])
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_PRICE_INTEL') {
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
    auditCartCompetitorsAndAccounts(msg.accountId, msg.items || [], Boolean(msg.forceNetworkSearch))
      .then((res) => sendResponse(res))
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

  if (msg.type === 'LQS_GET_ACCOUNT_SECRET_FOR_POPUP') {
    const popupPrefix = chrome.runtime.getURL('popup.html');
    if (!sender || !sender.url || !sender.url.startsWith(popupPrefix)) {
      sendResponse({ ok: false, error: 'Доступ к секретам сейфа разрешён только из popup расширения.' });
      return true;
    }
    (async () => {
      const settings = await getSettings();
      const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
      const srvAccounts = await fetchBackendVaultAccounts(backendUrl);
      if (!Array.isArray(srvAccounts)) {
        return { ok: false, error: 'Локальный сервер (:8765) недоступен.' };
      }
      const found = srvAccounts.find((a) => a.accountId === msg.accountId);
      return { ok: true, password: found?.password || '' };
    })()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SET_BACKEND_TOKEN') {
    const popupPrefix = chrome.runtime.getURL('popup.html');
    if (!sender || !sender.url || !sender.url.startsWith(popupPrefix)) {
      sendResponse({ ok: false, error: 'Forbidden' });
      return true;
    }
    saveStoredBackendToken(msg.token || '')
      .then((tok) => sendResponse({ ok: true, hasToken: Boolean(tok) }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_ACCOUNTS_VAULT') {
    getAccountsVaultStatus()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SAVE_ACCOUNT_TO_VAULT') {
    saveAccountToVault(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_DELETE_ACCOUNT_FROM_VAULT') {
    deleteAccountFromVault(msg.accountId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_SWITCH_LAVKA_ACCOUNT') {
    switchLavkaAccountInOneClick(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_LOGOUT_CLEAN_LAVKA_SESSION') {
    logoutToCleanLavkaSession()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_AUTOFILL_YANDEX_LOGIN') {
    autofillYandexPassportTab(msg.accountId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_GET_CACHED_AI_VERDICT') {
    getLocalAiCacheEntry(msg.slug, msg.title, msg.imageKey || null)
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
