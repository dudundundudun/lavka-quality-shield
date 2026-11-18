/**
 * Lavka Quality Shield v2.5.1 — Background Service Worker
 * Что исправлено и улучшено в v2.5.1:
 * 1. Точный поиск идентичных товаров (Exact Product & Modifier Matcher):
 *    - Полное сохранение названия товара вместе с «без сахара» / «Zero», вкусом, брендом и объёмом/весом («1,5 л»).
 *    - Строгий фильтр релевантности: обычная Кола с сахаром никогда не попадёт в цены/ссылки для «Колы без сахара» (и наоборот),
 *      а цены за 0,33 л / 0,5 л не смешиваются с ценой за 1,5 л.
 *    - Автоматическая очистка старых нерелевантных офферов конкурентов из кэша.
 * 2. Устранение ошибки «message channel closed before a response was received» и зависания окна ИИ:
 *    - Keep-Alive пинг Service Worker'а во время генерации ответа ИИ.
 *    - Авто-отмена устаревших фоновых запросов в очереди Gemini при переходе на другой товар.
 *    - Push-рассылка готового вердикта (`LQS_AI_VERDICT_READY`) во все вкладки Лавки + синхронизация по `slug` и `cleanTitle`.
 * 3. Связка двух типов URL одного товара в Лавке (SEO-slug `/good/napitok-cola-...` <-> HEX-ID `/good/4cbf6c0b...`):
 *    - Кэш ИИ, база цен и аудит корзины автоматически связывают товар по нормализованному названию.
 * 4. Безопасность сейфа аккаунтов (`X-LQS-Client`), чистая смена `localStorage` при переключении куки и честный учёт лимита остатков в авто-сборщике.
 */

'use strict';

const SETTINGS_KEY = 'lqs_settings_v2';
const AI_CACHE_KEY = 'lqs_ai_cache_v1';
const PRICE_DB_KEY = 'lqs_price_db_v1';
const SAVED_CARTS_KEY = 'lqs_saved_carts_v1';
const CART_LOCKS_KEY = 'lqs_cart_locks_v1';
const ACCOUNTS_VAULT_KEY = 'lqs_accounts_vault_v1';
const DELETED_ACCOUNTS_KEY = 'lqs_deleted_accounts_v1';

const MAX_LOCAL_AI_CACHE_ITEMS = 500;
const MAX_LOCAL_PRICE_DB_ITEMS = 1500;

const LQS_CLIENT_HEADER = { 'X-LQS-Client': 'lavka-quality-shield' };

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

const DEFAULT_ACCOUNT_PROFILES = [
  {
    accountId: 'acc_1',
    label: 'Аккаунт #1 (Основной)',
    login: '',
    password: '',
    note: 'Основной профиль',
    yandexLogin: '',
    cookieCount: 0,
    cookies: [],
    localStorageData: {},
    updatedAt: null
  },
  {
    accountId: 'acc_2',
    label: 'Аккаунт #2 (Новичок / Семья)',
    login: '',
    password: '',
    note: 'Второй аккаунт для проверки скидок',
    yandexLogin: '',
    cookieCount: 0,
    cookies: [],
    localStorageData: {},
    updatedAt: null
  },
  {
    accountId: 'acc_3',
    label: 'Аккаунт #3 (Запасной)',
    login: '',
    password: '',
    note: 'Запасной профиль',
    yandexLogin: '',
    cookieCount: 0,
    cookies: [],
    localStorageData: {},
    updatedAt: null
  }
];

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
let latestRequestedProductKey = '';
let lastWarmupCheckTs = 0;
let isWarmingUp = false;

// Кэш доступности локальных серверов (:8765 и :8083), чтобы не ждать 12с при выключенном сервере
let backendOfflineUntilTs = 0;
let bridgeOfflineUntilTs = 0;

/**
 * Удерживает Service Worker в активном состоянии во время долгих операций (защита от закрытия message channel в MV3)
 */
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

/**
 * Нормализует название товара для связки SEO-slug (`/good/napitok-cola-...`) и HEX-ID (`/good/4cbf6c0b...`)
 */
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

/**
 * Извлекает вес или объём в граммах/миллилитрах (например "1,5 л" -> 1500, "330 мл" -> 330)
 */
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

/**
 * Формирует ПОЛНОЕ название товара для поиска в магазинах и поисковиках
 * (СОХРАНЯЯ «без сахара», вкус, бренд и объём/вес вроде «1,5 л»!).
 */
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

/**
 * Проверяет, соответствует ли найденный результат в поисковике ИМЕННО ЭТОМУ ТОВАРУ:
 * 1) Строго проверяет модификатор «без сахара» / «Zero» (никогда не путает обычную колу и колу без сахара).
 * 2) Строго проверяет вкусовые и видовые модификаторы (ваниль, вишня, лайм, безлактозное и т.д.).
 * 3) Проверяет ключевые слова названия и бренда.
 * 4) Проверяет совпадение объёма/веса (чтобы цена баночки 0,33 л не выдавалась за цену бутылки 1,5 л).
 */
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
// 1. ВСТРОЕННЫЙ КЭШ ИИ-ОБЗОРОВ (lqs_ai_cache_v1) СО СВЯЗКОЙ SEO-SLUG И HEX-ID
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
  const normTitle = normalizeTitleKey(title);
  const map = await getLocalAiCacheMap();

  let entry = key ? map[key] : null;
  if (!entry && normTitle && normTitle.length >= 4) {
    entry = Object.values(map).find(
      (e) => e && e.verdict && !String(e.verdict).startsWith('⚠️') && normalizeTitleKey(e.title) === normTitle
    );
  }

  if (entry && entry.verdict && !String(entry.verdict).startsWith('⚠️')) {
    const filteredSources = Array.isArray(entry.sources) && title
      ? entry.sources.filter((s) => isSearchResultMatchingProduct(s.title, s.snippet, title, '').isSameProduct)
      : (entry.sources || []);
    return {
      ...entry,
      sources: filteredSources
    };
  }
  return null;
}

async function saveLocalAiCacheEntry(slug, title, verdict, sources, mode) {
  const key = normalizeCacheKey(slug, title);
  if (!key || !verdict || String(verdict).startsWith('⚠️')) return null;
  const normTitle = normalizeTitleKey(title);
  const map = await getLocalAiCacheMap();
  const nowIso = new Date().toISOString();

  const record = {
    slug: key,
    title: title || key,
    cleanTitle: normTitle,
    verdict: String(verdict).trim(),
    sources: Array.isArray(sources) ? sources : [],
    mode: mode || 'Автопилот ИИ',
    updatedAt: nowIso
  };

  map[key] = record;

  // Если в кэше уже была запись для этого же товара под другим slug (например SEO-slug vs HEX-ID из корзины), синхронизируем оба ключа!
  if (normTitle && normTitle.length >= 4) {
    for (const [k, v] of Object.entries(map)) {
      if (k !== key && v && normalizeTitleKey(v.title) === normTitle) {
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

/**
 * Активно пушит готовый вердикт ИИ во все открытые вкладки Лавки (даже если исходный sendMessage закрылся)
 */
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

  const map = localMap ? { ...localMap } : {};
  if (Object.keys(map).length === 0) {
    DEFAULT_ACCOUNT_PROFILES.forEach((p) => {
      map[p.accountId] = { ...p };
    });
    await new Promise((r) => chrome.storage.local.set({ [ACCOUNTS_VAULT_KEY]: map }, r));
  }
  return map;
}

async function saveAccountsVaultMap(map) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [ACCOUNTS_VAULT_KEY]: map }, () => resolve(map));
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
      // ignore domain permission error if any
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

/**
 * Очищает ключи сессии/корзины/адреса в localStorage на открытой вкладке Лавки
 */
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
      // ignore individual cookie restriction
    }
  }

  // Сначала очищаем старый localStorage и записываем данные целевого аккаунта
  await clearLavkaTabLocalStorage(localStorageData);

  return { restoredCount };
}

async function getAccountsVaultStatus() {
  const settings = await getSettings();
  const map = await getAccountsVaultMap();
  const deletedSet = await getDeletedAccountIdsSet();

  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  if (backendUrl && Date.now() > backendOfflineUntilTs) {
    try {
      const r = await fetchWithTimeout(
        `${backendUrl}/api/accounts/list`,
        { method: 'GET', headers: LQS_CLIENT_HEADER },
        1100
      );
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.accounts)) {
          let changed = false;
          for (const srvAcc of j.accounts) {
            if (!srvAcc || !srvAcc.accountId) continue;
            if (deletedSet.has(srvAcc.accountId)) continue;
            const loc = map[srvAcc.accountId];
            const srvTime = String(srvAcc.updatedAt || '');
            const locTime = String(loc?.updatedAt || '');
            if (!loc || (srvTime > locTime && srvAcc.cookieCount >= (loc.cookieCount || 0))) {
              map[srvAcc.accountId] = { ...(loc || {}), ...srvAcc };
              changed = true;
            }
          }
          if (changed) await saveAccountsVaultMap(map);
        }
      }
    } catch {
      backendOfflineUntilTs = Date.now() + 10000;
    }
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
      password: a.password || '',
      note: a.note || '',
      yandexLogin: a.yandexLogin || '',
      cookieCount: Array.isArray(a.cookies) ? a.cookies.length : (a.cookieCount || 0),
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
    password: '',
    note: '',
    yandexLogin: '',
    cookieCount: 0,
    cookies: [],
    localStorageData: {},
    updatedAt: nowIso
  };

  let cookies = existing.cookies || [];
  let localStorageData = existing.localStorageData || {};
  let yandexLogin = existing.yandexLogin || '';

  if (payload.captureCookies !== false) {
    const captured = await captureCurrentYandexCookies();
    if (captured.cookies.length > 0) {
      cookies = captured.cookies;
      localStorageData = captured.localStorageData || {};
      if (captured.yandexLogin) yandexLogin = captured.yandexLogin;
    }
  }

  const updated = {
    ...existing,
    accountId,
    label: label || existing.label,
    login: payload.login !== undefined ? String(payload.login).trim() : (existing.login || yandexLogin || ''),
    password: payload.password !== undefined ? String(payload.password) : (existing.password || ''),
    note: payload.note !== undefined ? String(payload.note).trim() : (existing.note || ''),
    yandexLogin,
    cookieCount: cookies.length,
    cookies,
    localStorageData,
    updatedAt: nowIso
  };

  map[accountId] = updated;
  await saveAccountsVaultMap(map);
  await saveSettingsPatch({ lavkaAccountLabel: updated.label });

  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  if (backendUrl && Date.now() > backendOfflineUntilTs) {
    try {
      await fetchWithTimeout(
        `${backendUrl}/api/accounts/save`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...LQS_CLIENT_HEADER },
          body: JSON.stringify(updated)
        },
        2000
      );
    } catch {
      backendOfflineUntilTs = Date.now() + 10000;
    }
  }

  return {
    ok: true,
    account: {
      ...updated,
      cookies: undefined
    },
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
      await fetchWithTimeout(
        `${backendUrl}/api/accounts/${encodeURIComponent(accountId)}`,
        { method: 'DELETE', headers: LQS_CLIENT_HEADER },
        1500
      );
    } catch {
      backendOfflineUntilTs = Date.now() + 10000;
    }
  }
  return await getAccountsVaultStatus();
}

async function autofillYandexPassportTab(accountId) {
  const map = await getAccountsVaultMap();
  const acc = map[accountId] || Object.values(map).find((a) => a.label === accountId);
  if (!acc || (!acc.login && !acc.password)) {
    return { ok: false, error: 'Для этого профиля ещё не указаны логин и пароль.' };
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

  if (autoBackupCurrent) {
    const currentLive = await captureCurrentYandexCookies();
    if (currentLive.isLoggedIn && currentLive.cookies.length > 0) {
      const curLabel = settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)';
      const curEntry = Object.values(map).find(
        (a) => a.label === curLabel || (currentLive.yandexLogin && a.yandexLogin === currentLive.yandexLogin)
      );
      if (curEntry) {
        curEntry.cookies = currentLive.cookies;
        curEntry.cookieCount = currentLive.cookies.length;
        curEntry.localStorageData = currentLive.localStorageData || {};
        if (currentLive.yandexLogin) curEntry.yandexLogin = currentLive.yandexLogin;
        curEntry.updatedAt = new Date().toISOString();
        map[curEntry.accountId] = curEntry;
        await saveAccountsVaultMap(map);
      }
    }
  }

  const targetAcc =
    (accountId && map[accountId]) ||
    Object.values(map).find((a) => a.label === label || a.accountId === accountId);

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
// 3. МУЛЬТИ-АККАУНТ БАЗА ИСТОРИИ ЦЕН И АНОНИМНЫЙ ЗОНД БЕЗ КУКИ
// ============================================================================
async function getLocalPriceDb() {
  return new Promise((resolve) => {
    chrome.storage.local.get([PRICE_DB_KEY], (res) => {
      resolve(res && res[PRICE_DB_KEY] && typeof res[PRICE_DB_KEY] === 'object' ? res[PRICE_DB_KEY] : {});
    });
  });
}

function findPriceEntryInDb(db, slug, title) {
  if (!db) return null;
  const cleanSlug = String(slug || '').trim().toLowerCase();
  if (cleanSlug && db[cleanSlug]) return db[cleanSlug];
  const normTitle = normalizeTitleKey(title);
  if (normTitle && normTitle.length >= 4) {
    return Object.values(db).find((e) => e && normalizeTitleKey(e.title) === normTitle) || null;
  }
  return null;
}

/**
 * Очищает офферы конкурентов от несовпадающих модификаций (например, обычной колы для колы без сахара)
 */
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
  const effectiveTitle = item.title || existing?.title || slug;
  const effectiveAmount = item.amount || existing?.amount || '';

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

  if (item.title) {
    entry.title = item.title;
    entry.cleanTitle = normalizeTitleKey(item.title);
  }
  if (item.amount) entry.amount = item.amount;
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
    const existing = findPriceEntryInDb(db, slug, rawItem.title);
    const merged = mergePriceRecordIntoEntry(existing, rawItem, acc, nowIso);
    merged.slug = slug;
    db[slug] = merged;
    updatedSummaries[slug] = merged;

    // Синхронизируем парные записи (SEO-slug <-> HEX-ID) с тем же cleanTitle
    const normTitle = normalizeTitleKey(merged.title);
    if (normTitle && normTitle.length >= 4) {
      for (const [k, v] of Object.entries(db)) {
        if (k !== slug && v && normalizeTitleKey(v.title) === normTitle) {
          db[k] = { ...merged, slug: k };
        }
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
          headers: { 'Content-Type': 'application/json', ...LQS_CLIENT_HEADER },
          body: JSON.stringify({ accountId: acc, items })
        },
        1800
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
      3800
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
  let summary = findPriceEntryInDb(db, cleanSlug, title);

  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  if (backendUrl && Date.now() > backendOfflineUntilTs) {
    try {
      const qTitle = title ? `?title=${encodeURIComponent(title)}` : '';
      const r = await fetchWithTimeout(
        `${backendUrl}/api/price/product/${encodeURIComponent(cleanSlug)}${qTitle}`,
        { method: 'GET', headers: LQS_CLIENT_HEADER },
        1000
      );
      if (r.ok) {
        const j = await r.json();
        if (j && j.status === 'ok' && j.summary) {
          summary = {
            ...(summary || {}),
            ...j.summary,
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

  if (settings.enableGuestPriceProbe !== false && (!summary || !summary.guestPrice)) {
    const probed = await probeGuestPriceWithoutCookies(cleanSlug, title, currentPrice, acc);
    if (probed) {
      summary = { ...(summary || {}), ...probed };
    }
  }

  if (summary) {
    summary.competitorOffers = sanitizeCompetitorOffersForProduct(
      summary.competitorOffers || [],
      title || summary.title || '',
      amount || summary.amount || ''
    );
    summary.storeSearchLinks = buildDirectStoreSearchLinks(
      title || summary.title || '',
      amount || summary.amount || ''
    );
  }

  return summary;
}

/**
 * Генерирует прямые ссылки для быстрого поиска ПОЛНОГО названия товара (с «без сахара», вкусом и объёмом!) в магазинах-конкурентах
 */
function buildDirectStoreSearchLinks(rawTitle, amount = '', brand = '') {
  const fullQuery = buildFullProductSearchQuery(rawTitle, brand, amount);
  const enc = encodeURIComponent(fullQuery || rawTitle || '');
  return [
    { store: 'Ozon', url: `https://www.ozon.ru/search/?text=${enc}`, query: fullQuery },
    { store: 'Перекрёсток', url: `https://www.perekrestok.ru/cat/search?search=${enc}`, query: fullQuery },
    { store: 'ВкусВилл', url: `https://vkusvill.ru/search/?q=${enc}`, query: fullQuery },
    { store: 'Я.Маркет', url: `https://market.yandex.ru/search?text=${enc}`, query: fullQuery },
    { store: 'Лента', url: `https://lenta.com/search/?searchText=${enc}`, query: fullQuery },
    { store: 'Купер', url: `https://kuper.ru/multisearch?q=${enc}`, query: fullQuery }
  ];
}

/**
 * Пакетный аудит корзины по конкурентам и гостевым ценам:
 * - Сохраняет полное название + объём (например «Напиток Cola «Добрый» газированный без сахара 1,5 л»)
 * - Отсекает нерелевантные товары (обычную колу с сахаром или баночки другого объёма)
 * - Защищает DuckDuckGo от сетевого шторма при больших корзинах
 */
async function auditCartCompetitorsAndAccounts(accountId, items = [], forceNetworkSearch = false) {
  const stopKeepAlive = startSwKeepAlive();
  try {
    const settings = await getSettings();
    const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)';
    const priceDb = await getLocalPriceDb();
    const aiCache = await getLocalAiCacheMap();

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
      const rawTitle = item.title || slug;
      const amount = item.amount || '';
      const fullDisplayTitle = buildFullProductSearchQuery(rawTitle, '', amount);

      totalLavkaPrice += price * qty;

      let pEntry = findPriceEntryInDb(priceDb, slug, rawTitle);
      const aiEntry = await getLocalAiCacheEntry(slug, rawTitle);

      let guestPrice = pEntry?.guestPrice || null;
      if (!guestPrice && settings.enableGuestPriceProbe !== false) {
        const probed = await probeGuestPriceWithoutCookies(slug, fullDisplayTitle, price, acc);
        if (probed && probed.guestPrice) {
          guestPrice = probed.guestPrice;
          pEntry = { ...(pEntry || {}), ...probed };
        }
      }

      let compOffers = sanitizeCompetitorOffersForProduct(
        pEntry?.competitorOffers || [],
        rawTitle,
        amount
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
        const extracted = extractCompetitorPricesFromSources(aiEntry.sources, price, rawTitle, amount);
        if (extracted.competitorMinPrice) compMin = extracted.competitorMinPrice;
        if (extracted.competitorSummary) compSum = extracted.competitorSummary;
        if (extracted.competitorOffers.length > 0) compOffers = extracted.competitorOffers;
      }

      if ((forceNetworkSearch || (!compMin && compOffers.length === 0)) && rawTitle && ddgNetworkCallsMade < maxDdgCallsPerPass) {
        ddgNetworkCallsMade += 1;
        const foundSources = await searchWebReviewsDirect(rawTitle, '', amount);
        const extracted = extractCompetitorPricesFromSources(foundSources, price, rawTitle, amount);
        if (extracted.competitorMinPrice) compMin = extracted.competitorMinPrice;
        if (extracted.competitorSummary) compSum = extracted.competitorSummary;
        if (extracted.competitorOffers.length > 0) {
          compOffers = extracted.competitorOffers;
        } else if (foundSources.length > 0) {
          compOffers = foundSources
            .filter((s) => s.url && !s.url.includes('otzovik.com') && !s.url.includes('irecommend.ru'))
            .filter((s) => isSearchResultMatchingProduct(s.title, s.snippet, rawTitle, amount).isSameProduct)
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
          title: fullDisplayTitle,
          price,
          oldPrice: item.oldPrice || null,
          amount,
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
        title: fullDisplayTitle,
        amount,
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
        storeSearchLinks: buildDirectStoreSearchLinks(rawTitle, amount)
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
        { method: 'GET', headers: LQS_CLIENT_HEADER },
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
  const cleanItems = (Array.isArray(items) ? items : []).filter((i) => i && i.slug);
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
          headers: { 'Content-Type': 'application/json', ...LQS_CLIENT_HEADER },
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
      const existingEntry = findPriceEntryInDb(priceDb, slug, item.title);

      let currentPrice = null;
      let guestPrice = existingEntry?.guestPrice || null;

      try {
        const url = `https://lavka.yandex.ru/good/${encodeURIComponent(slug)}`;
        const resp = await fetchWithTimeout(url, { method: 'GET', credentials: 'include', cache: 'no-store' }, 3800);
        if (resp.ok) {
          const html = await resp.text();
          currentPrice = parsePriceFromLavkaHtml(html);
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

/**
 * Добавляет один товар в нужном количестве (desiredQty) на открытой вкладке Лавки:
 * - Честно учитывает лимит остатка на складе (не завышает addedUnits при нехватке товара).
 * - Умеет как увеличивать (+), так и уменьшать (-), если в корзине уже лежало больше единиц.
 */
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

          // Если в корзине на этом аккаунте уже лежало БОЛЬШЕ штук, чем нужно — уменьшаем кнопкой «-»
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

/**
 * Извлекает цены конкурентов ТОЛЬКО из тех источников, которые прошли проверку
 * точного совпадения модификации («без сахара» / вкус / бренд / объём).
 */
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

async function searchWebReviewsDirect(title, brand = '', amount = '') {
  const fullQ = buildFullProductSearchQuery(title, brand, amount);
  if (!fullQ) return [];

  // Если товар «без сахара», берём "без сахара" в кавычки, чтобы поисковик не подсовывал обычную колу с сахаром
  let strictQ = fullQ;
  if (/без\s+сахара/i.test(strictQ)) {
    strictQ = strictQ.replace(/без\s+сахара/i, '"без сахара"');
  }

  const qPrimary = `${strictQ} цена отзывы (site:otzovik.com OR site:irecommend.ru OR site:vkusvill.ru OR site:perekrestok.ru OR site:ozon.ru OR site:lenta.com OR site:rskrf.ru)`;
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
// 6. РАБОТА С ВКЛАДКОЙ GEMINI И КУКАМИ GOOGLE (С ЗАЩИТОЙ ОТ ЗАВИСАНИЯ)
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

async function executePromptInsideGeminiTab(tabId, promptText) {
  const stopKeepAlive = startSwKeepAlive();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [promptText],
      func: async (prompt) => {
        try {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const findEditor = () =>
            document.querySelector('rich-textarea div.ql-editor[contenteditable="true"]') ||
            document.querySelector('div[contenteditable="true"][role="textbox"]') ||
            document.querySelector('div[contenteditable="true"]') ||
            document.querySelector('textarea');

          let editor = findEditor();
          for (let waitTick = 0; !editor && waitTick < 20; waitTick++) {
            await wait(350);
            editor = findEditor();
          }

          if (!editor) {
            return {
              ok: false,
              error: 'На вкладке gemini.google.com не найдено поле ввода чата (убедись, что ты вошёл в аккаунт Google).'
            };
          }

          // Если во вкладке Gemini ещё генерируется предыдущий ответ — аккуратно останавливаем его перед новым запросом
          const findStopBtn = () =>
            document.querySelector(
              'button[aria-label*="Stop"], button[aria-label*="Остановить"], button[aria-label*="Прервать"], button.stop-button'
            );
          const activeStop = findStopBtn();
          if (activeStop && activeStop.offsetParent !== null) {
            activeStop.click();
            await wait(450);
          }

          const responseSelector = 'message-content, model-response .markdown, .model-response-text';
          const initialNodes = document.querySelectorAll(responseSelector);
          const initialCount = initialNodes.length;
          const initialLastText = initialCount > 0 ? (initialNodes[initialCount - 1].innerText || '').trim() : '';

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
              if (!inserted || !(editor.innerText || '').trim()) {
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
          await wait(300);
          triggerSend();

          const isStillGenerating = () => {
            const stopBtn = findStopBtn();
            if (stopBtn && stopBtn.offsetParent !== null) return true;
            const busyModels = document.querySelectorAll('model-response[aria-busy="true"], .response-streaming');
            return busyModels.length > 0;
          };

          let lastText = '';
          let stableTicks = 0;
          let retriedSend = false;

          // Максимум 52 тика по 450 мс (~23.4 сек), чтобы гарантированно уложиться до 30-сек лимита MV3
          for (let i = 0; i < 52; i++) {
            await wait(450);
            const nodes = document.querySelectorAll(responseSelector);
            const hasNewNode = nodes.length > initialCount;
            const latestNode = nodes.length > 0 ? nodes[nodes.length - 1] : null;
            const currentText = latestNode ? (latestNode.innerText || '').trim() : '';
            const isNew = hasNewNode || (currentText && currentText !== initialLastText);

            // Если через 2.5 секунды отправка не сработала и текст остался в поле ввода — пробуем нажать ещё раз
            if (i === 5 && !isNew && !isStillGenerating() && !retriedSend) {
              retriedSend = true;
              if ((editor.innerText || editor.value || '').trim().length > 10) {
                triggerSend();
              } else {
                fillPromptIntoEditor();
                await wait(200);
                triggerSend();
              }
            }

            if (isNew && currentText.length > 25) {
              if (currentText === lastText && !isStillGenerating()) {
                stableTicks += 1;
                if (stableTicks >= 3) {
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

          if (lastText && lastText.length > 25) {
            return {
              ok: true,
              mode: `Вкладка Gemini (${window.location.pathname})`,
              text: lastText
            };
          }

          return {
            ok: false,
            error: 'Вкладка Gemini ещё генерирует ответ или ожидает вход в аккаунт (проверь открытую вкладку gemini.google.com).'
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
  } finally {
    stopKeepAlive();
  }
}

function enqueueGeminiTabExecution(taskFn) {
  const next = geminiTabMutex.then(() => taskFn(), () => taskFn());
  geminiTabMutex = next.catch(() => {});
  return next;
}

/**
 * Проверяет, открыт ли ещё этот товар хотя бы на одной вкладке Яндекс Лавки (чтобы не тратить очередь Gemini на закрытые товары)
 */
async function isProductStillRelevantForUser(slug, title, forceRefresh = false) {
  if (forceRefresh) return true;
  const reqKey = normalizeCacheKey(slug, title);
  if (reqKey && reqKey === latestRequestedProductKey) return true;
  try {
    const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/good/*'] });
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
    const r1 = await fetchWithTimeout(`${backendUrl}/api/health`, { method: 'GET', headers: LQS_CLIENT_HEADER }, 1000);
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
        headers: { 'Content-Type': 'application/json', ...LQS_CLIENT_HEADER },
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
      acc
    );

    if (!payload.forceRefresh) {
      const localCached = await getLocalAiCacheEntry(payload.slug, payload.title);
      if (localCached && localCached.verdict) {
        const resObj = {
          ok: true,
          cached: true,
          mode: `Кэш браузера (${localCached.mode || 'ИИ'})`,
          verdict: localCached.verdict,
          sources: localCached.sources || [],
          priceSummary: priceIntel
        };
        broadcastAiVerdictToLavkaTabs(payload.slug, payload.title, resObj);
        return resObj;
      }
    }

    let webSources = [];
    let backendOnline = false;

    if (backendUrl && Date.now() > backendOfflineUntilTs) {
      try {
        const healthResp = await fetchWithTimeout(
          `${backendUrl}/api/health`,
          { method: 'GET', headers: LQS_CLIENT_HEADER },
          800
        );
        if (healthResp.ok) {
          backendOnline = true;
          const resp = await fetchWithTimeout(
            `${backendUrl}/api/analyze-product`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...LQS_CLIENT_HEADER },
              body: JSON.stringify({
                ...payload,
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
              await saveLocalAiCacheEntry(payload.slug, payload.title, data.verdict, webSources, modeLabel);
              const resObj = {
                ok: true,
                cached: Boolean(data.cached),
                mode: modeLabel,
                verdict: data.verdict,
                sources: webSources,
                priceSummary: priceIntel
              };
              broadcastAiVerdictToLavkaTabs(payload.slug, payload.title, resObj);
              return resObj;
            }
          }
        }
      } catch {
        backendOfflineUntilTs = Date.now() + 12000;
      }
    }

    if (!webSources || webSources.length === 0) {
      webSources = await searchWebReviewsDirect(payload.title, payload.brand, payload.amount);
    }

    const comp = extractCompetitorPricesFromSources(webSources, payload.price, payload.title, payload.amount);
    if (comp.competitorMinPrice || comp.competitorSummary || comp.competitorOffers.length > 0) {
      const updatedMap = await recordPricesBatch(acc, [
        {
          slug: payload.slug,
          title: payload.title,
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
          6000
        );

        if (directResp.ok) {
          bridgeOfflineUntilTs = 0;
          const json = await directResp.json();
          const reply = json.choices?.[0]?.message?.content;
          if (reply) {
            const cleanReply = reply.trim();
            const modeLabel = `Мост ${settings.aiModel} (${aiBaseUrl})`;
            await saveLocalAiCacheEntry(payload.slug, payload.title, cleanReply, webSources, modeLabel);
            if (backendOnline) {
              saveVerdictToBackendCache(backendUrl, payload.slug, payload.title, cleanReply, webSources);
            }
            const resObj = {
              ok: true,
              cached: false,
              mode: modeLabel,
              verdict: cleanReply,
              sources: webSources,
              priceSummary: priceIntel
            };
            broadcastAiVerdictToLavkaTabs(payload.slug, payload.title, resObj);
            return resObj;
          }
        }
      } catch {
        bridgeOfflineUntilTs = Date.now() + 15000;
      }
    }

    return await enqueueGeminiTabExecution(async () => {
      // Если пока запрос ждал в очереди, ответ уже появился в кэше (например по парному slug/title) — отдаём сразу!
      if (!payload.forceRefresh) {
        const alreadyCached = await getLocalAiCacheEntry(payload.slug, payload.title);
        if (alreadyCached && alreadyCached.verdict) {
          const resObj = {
            ok: true,
            cached: true,
            mode: `Кэш браузера (${alreadyCached.mode || 'ИИ'})`,
            verdict: alreadyCached.verdict,
            sources: alreadyCached.sources || [],
            priceSummary: priceIntel
          };
          broadcastAiVerdictToLavkaTabs(payload.slug, payload.title, resObj);
          return resObj;
        }
      }

      // Если пользователь уже закрыл или ушёл с этого товара — не блокируем вкладку Gemini!
      const stillRelevant = await isProductStillRelevantForUser(payload.slug, payload.title, payload.forceRefresh);
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
        const promptForTab = buildProductReviewPrompt(payload, webSources, true, priceIntel);
        const tabResult = await executePromptInsideGeminiTab(geminiTab.id, promptForTab);
        if (tabResult && tabResult.ok && tabResult.text) {
          const accLabel = email ? `${email} (/u/${accIdx})` : `/u/${accIdx}`;
          const modeLabel = `Вкладка Gemini [${accLabel}]`;
          await saveLocalAiCacheEntry(payload.slug, payload.title, tabResult.text, webSources, modeLabel);
          if (backendOnline) {
            saveVerdictToBackendCache(backendUrl, payload.slug, payload.title, tabResult.text, webSources);
          }
          const resObj = {
            ok: true,
            cached: false,
            mode: modeLabel,
            verdict: tabResult.text,
            sources: webSources,
            priceSummary: priceIntel
          };
          broadcastAiVerdictToLavkaTabs(payload.slug, payload.title, resObj);
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

  if (msg.type === 'LQS_GET_PRICE_INTEL') {
    getProductPriceIntelligence(msg.slug, msg.title, msg.price, msg.oldPrice, msg.amount, msg.accountId)
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
