/**
 * Lavka Quality Shield v2.3.0 — Background Service Worker (Zero-Click Full Autopilot)
 * Что нового в v2.3.0 по итогам аудита:
 * 1. Полный Zero-Click Автопилот:
 *    - Авто-прогрев фоновой закреплённой вкладки Gemini при запуске браузера (onStartup/onInstalled)
 *      и при заходе на lavka.yandex.ru (если куки Google есть, а локальный мост :8083 выключен).
 *    - Встроенный постоянный кэш ИИ-обзоров прямо в chrome.storage.local (lqs_ai_cache_v1, до 500 товаров):
 *      теперь вердикты ИИ сохраняются навсегда даже без запущенного локального сервера server.py!
 * 2. Исправления ИИ-пайплайна:
 *    - Добавлена очередь запросов (Mutex geminiTabQueue) и дедупликация inFlightBySlug, чтобы при быстром
 *      открытии нескольких товаров вкладка Gemini не перебивала сама себя.
 *    - Исправлен executePromptInsideGeminiTab: ждёт до 10 секунд появления редактора при холодном старте
 *      SPA-вкладки Gemini и отслеживает кнопку Stop (стриминг), чтобы не обрывать ответ во время Google-поиска.
 *    - Исправлен парсер DuckDuckGo (убран баг раннего закрытия </div></div> до сниппета + добавлен фоллбэк на lite.duckduckgo.com).
 */

'use strict';

const SETTINGS_KEY = 'lqs_settings_v2';
const AI_CACHE_KEY = 'lqs_ai_cache_v1';
const MAX_LOCAL_AI_CACHE_ITEMS = 500;

const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:8765',
  aiBaseUrl: 'http://localhost:8083/v1',
  aiApiKey: '',
  aiModel: 'gemini-4-argon',
  preferBrowserGeminiTab: true,
  geminiAccountIndex: 'auto', // 'auto' | '0' | '1' | '2' | '3' | '4'
  preferredGeminiTabId: null,
  autoRunAiOnProductPage: true, // Zero-Click: сам запускает ИИ при открытии страницы товара
  autoOpenDrawerOnAi: true,     // Zero-Click: сам раскрывает блок с вердиктом ИИ
  autoWarmupGeminiTab: true     // Zero-Click: сам прогревает фоновую вкладку Gemini при старте Лавки
};

/**
 * Приоритетный список сайтов для поиска реальных отзывов о продуктах
 */
const REVIEW_SEARCH_SITES = [
  { domain: 'otzovik.com', name: 'Отзовик' },
  { domain: 'irecommend.ru', name: 'IRecommend' },
  { domain: 'rskrf.ru', name: 'Роскачество' },
  { domain: 'roscontrol.com', name: 'Росконтроль' },
  { domain: 'ozon.ru', name: 'Ozon' },
  { domain: 'vkusvill.ru', name: 'ВкусВилл' },
  { domain: 'market.yandex.ru', name: 'Яндекс Маркет' },
  { domain: 'perekrestok.ru', name: 'Перекрёсток' },
  { domain: 'vprok.ru', name: 'Перекрёсток Впрок' },
  { domain: 'lenta.com', name: 'Лента' },
  { domain: 'wildberries.ru', name: 'Wildberries' },
  { domain: 'kuper.ru', name: 'Купер' },
  { domain: 'sbermarket.ru', name: 'СберМаркет' },
  { domain: 'eda.yandex.ru', name: 'Яндекс Лавка / Еда' }
];

// Очередь для последовательного выполнения запросов во вкладке Gemini (защита от гонок)
let geminiTabMutex = Promise.resolve();
// Дедупликация активных запросов по ключу товара
const inFlightRequests = new Map();
// Защита от частых авто-прогревов
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

// ============================================================================
// ВСТРОЕННЫЙ В БРАУЗЕР КЭШ ИИ-ОБЗОРОВ (РАБОТАЕТ ДАЖЕ БЕЗ SERVER.PY!)
// ============================================================================
function normalizeCacheKey(slug, title) {
  return String(slug || title || '')
    .trim()
    .toLowerCase();
}

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

  // LRU-очистка при превышении лимита MAX_LOCAL_AI_CACHE_ITEMS
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

/**
 * Очищает название товара для поискового запроса (убирает вес в конце и служебные пометки)
 */
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

/**
 * Исправленный парсер DuckDuckGo HTML (разбивает по заголовкам результатов, не обрезая сниппеты на вложенных div)
 */
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
      // Разбиваем по началу каждого блока результата, чтобы вложенные </div> не обрезали result__snippet
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

  // Резервный парсер через lite.duckduckgo.com
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

/**
 * Автономный поиск реальных отзывов напрямую из фонового воркера расширения (если локальный server.py выключен)
 */
async function searchWebReviewsDirect(title, brand) {
  const cleanQ = cleanProductQueryForSearch(title, brand);
  if (!cleanQ) return [];

  const qPrimary = `${cleanQ} отзывы (site:otzovik.com OR site:irecommend.ru OR site:ozon.ru OR site:vkusvill.ru OR site:rskrf.ru OR site:market.yandex.ru)`;
  const qFallback = `${cleanQ} отзывы покупателей`;

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
    // ignore network errors in direct DDG search
  }

  return collected.slice(0, 6);
}

/**
 * Строит умный контекст цены: за 1 кг/л, за 1 шт/упаковку или без пересчёта (если вес не указан)
 */
function buildPricingContext(payload) {
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

  if (pricePerKg) {
    if (proteinCost && protein !== null && protein >= 3) {
      return {
        calcLine: `в пересчёте ~${pricePerKg} ₽/${unitLabel}; стоимость 100 г белка ~${proteinCost} ₽ (белка ${protein} г на 100 г)`,
        evalHint: `в пересчёте на 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel}) и с учётом цены белка (~${proteinCost} ₽ за 100 г)`,
        ruleLine: `Для этого товара рассчитана точная цена за 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel}) и за 100 г белка (~${proteinCost} ₽) — опирайся на эти цифры.`
      };
    }
    return {
      calcLine: `в пересчёте ~${pricePerKg} ₽/${unitLabel}`,
      evalHint: `в пересчёте на 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel})`,
      ruleLine: `Для этого товара рассчитана точная цена за 1 ${unitLabel} (~${pricePerKg} ₽/${unitLabel}). Стоимость белка отдельно не оценивай, если это не белковый продукт.`
    };
  }

  if (pricePerPiece && piecesCount && piecesCount > 1) {
    return {
      calcLine: `поштучная фасовка (${piecesCount} ${pieceUnitLabel}) — ~${pricePerPiece} ₽ за 1 ${pieceUnitLabel}, вес в граммах не указан`,
      evalHint: `за 1 ${pieceUnitLabel} (~${pricePerPiece} ₽/${pieceUnitLabel}) и за упаковку`,
      ruleLine: `Товар продаётся поштучно (${piecesCount} ${pieceUnitLabel}, ~${pricePerPiece} ₽/${pieceUnitLabel}) без указания веса в граммах — НЕ пытайся считать цену за килограмм, оценивай выгоду за штуку/упаковку.`
    };
  }

  return {
    calcLine: 'вес в граммах не указан (оценка за упаковку / 1 шт.)',
    evalHint: 'за саму упаковку / штуку (без пересчёта за килограмм)',
    ruleLine: 'На карточке этого товара не указан вес в граммах или миллилитрах — НЕ пытайся выдумывать или требовать цену за килограмм, оценивай адекватность цены за саму штуку/упаковку.'
  };
}

/**
 * Формирует честный промпт на нормальном разговорном русском языке (без сленга и без галлюцинаций)
 */
function buildProductReviewPrompt(payload, webSources, isBrowserGeminiTab = false) {
  const sitesListStr = REVIEW_SEARCH_SITES.slice(0, 11)
    .map((s) => `${s.name} (${s.domain})`)
    .join(', ');

  let snippetsText = '';
  if (Array.isArray(webSources) && webSources.length > 0) {
    snippetsText = webSources
      .map((s) => `- ${s.title || 'Отзыв'} (${s.url || ''}): ${s.snippet || ''}`)
      .join('\n');
  } else if (isBrowserGeminiTab) {
    snippetsText =
      'Предварительный парсер не нашёл прямых сниппетов — пожалуйста, проверь наличие реальных отзывов об этом товаре через поиск Google по площадкам выше. Если отзывов именно на этот товар нет — честно напиши об этом и оценивай строго по составу, КБЖУ и цене.';
  } else {
    snippetsText =
      'Прямых отзывов именно на этот товар в поисковой выдаче не найдено — честно сообщи об этом в 1-м пункте и оценивай товар строго по составу, КБЖУ и цене.';
  }

  const pricing = buildPricingContext(payload);
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
    `Площадки для проверки отзывов: ${sitesListStr}.`,
    `Найденные отзывы в интернете:\n${snippetsText}`,
    ``,
    `СТРОГИЕ ПРАВИЛА ЧЕСТНОСТИ (ТОЛЬКО ФАКТЫ, БЕЗ ПРИДУМОК):`,
    `- Пиши ТОЛЬКО подтверждённые факты из реальных отзывов, состава, КБЖУ и цены.`,
    `- Если реальных отзывов именно об этом продукте нет — ЧЕСТНО напиши в 1-м пункте: «Отзывов именно на этот товар в сети не нашлось, поэтому оцениваю по составу и характеристикам». Категорически запрещено придумывать вкус, консистенцию или несуществующие мнения покупателей.`,
    `- ${pricing.ruleLine}`,
    ``,
    `Ответь ровно в 3 коротких пунктах (по 1–2 предложения в каждом), обычным живым русским языком без сленга:`,
    `1. **Отзывы и репутация**: что реально пишут покупатели на отзовиках и в магазинах (укажи площадки, если отзывы найдены), либо честно отметь, что отзывов в сети не найдено, и скажи, что сразу видно по характеристикам продукта.`,
    `2. **Состав, КБЖУ и цена**: фактический разбор состава (есть ли скрытый сахар, крахмал, ММО, заменители молочного жира, дешёвые наполнители или состав чистый) и насколько адекватна цена (${pricing.evalHint}).`,
    `3. **Вердикт**: выбери ОДНУ оценку на нормальном русском языке и кратко поясни вывод:`,
    `   • ✅ **Отличный выбор — стоит брать**`,
    `   • 👍 **Хороший вариант на каждый день (есть мелкие нюансы)**`,
    `   • ⚠️ **На любителя — есть компромиссы по составу или цене**`,
    `   • ❌ **Не рекомендую к покупке**`
  ].join('\n');
}

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

/**
 * Определяет email/имя аккаунта Google внутри открытой вкладки Gemini
 */
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

/**
 * Возвращает список всех открытых вкладок Gemini с их tabId, URL, индексом /u/N и email аккаунта
 */
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

/**
 * Находит подходящую вкладку Gemini с учётом выбранного пользователем аккаунта
 */
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
    pinned: !makeActive // Закрепляем компактной иконкой в фоне, чтобы не мешала вкладкам пользователя!
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

/**
 * АВТО-ПРОГРЕВ ZERO-CLICK:
 * Когда пользователь запускает браузер или открывает Яндекс Лавку, расширение САМО тихо проверяет:
 * если мост :8083 не запущен, но есть куки Google — заранее открывает компактную закреплённую вкладку Gemini в фоне,
 * чтобы при открытии любого товара ИИ-обзор срабатывал мгновенно и без единого клика!
 */
async function ensureAutopilotWarmup(reason = 'auto') {
  const now = Date.now();
  if (isWarmingUp || now - lastWarmupCheckTs < 15000) return;
  lastWarmupCheckTs = now;
  isWarmingUp = true;

  try {
    const settings = await getSettings();
    if (settings.autoWarmupGeminiTab === false) return;

    // 1. Если уже открыта вкладка Gemini — ничего открывать не нужно
    const existingTab = await findOpenGeminiTab(false, false);
    if (existingTab) return;

    // 2. Если работает локальный мост :8083 — вкладка не нужна
    const aiBaseUrl = (settings.aiBaseUrl || '').replace(/\/$/, '');
    if (aiBaseUrl) {
      try {
        const headers = settings.aiApiKey ? { Authorization: `Bearer ${settings.aiApiKey}` } : {};
        const bridgeResp = await fetchWithTimeout(`${aiBaseUrl}/models`, { method: 'GET', headers }, 1000);
        if (bridgeResp.ok) return;
      } catch {
        // мост выключен
      }
    }

    // 3. Проверяем наличие авторизованных куки Google, чтобы не открывать пустую страницу логина
    const cookies = await inspectGeminiCookies();
    if (!cookies.ok) return;

    // 4. Тихо создаём закреплённую фоновую вкладку Gemini (pinned: true, active: false)
    await findOpenGeminiTab(true, false);
    console.log(`[LQS Zero-Click Autopilot] Warmed up background Gemini tab (${reason})`);
  } catch {
    // ignore warmup errors
  } finally {
    isWarmingUp = false;
  }
}

/**
 * Устойчивый инжектор промпта во вкладку Gemini:
 * - Ждёт появления поля ввода до 10 секунд (если вкладка только что открылась в фоне)
 * - Контролирует индикатор генерации (кнопку Stop), чтобы не возвращать оборванный текст во время Google-поиска
 */
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
            const busyModels = document.querySelectorAll('model-response[ aria-busy="true" ], .response-streaming');
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

/**
 * Обёртка с очередью (Mutex), чтобы параллельные запросы не печатали во вкладку Gemini одновременно
 */
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

  const backendUrl = settings.backendUrl.replace(/\/$/, '');
  const aiBaseUrl = settings.aiBaseUrl.replace(/\/$/, '');

  let backendStatus = { ok: false, cachedItems: 0, msg: 'Выкл' };
  try {
    const r1 = await fetchWithTimeout(`${backendUrl}/api/health`, { method: 'GET' }, 1200);
    if (r1.ok) {
      const j = await r1.json().catch(() => ({}));
      backendStatus = { ok: true, cachedItems: j.cachedItems ?? 0, msg: `ОК (кэш: ${j.cachedItems ?? 0})` };
    } else {
      backendStatus = { ok: false, cachedItems: 0, msg: `HTTP ${r1.status}` };
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

  // 0. МГНОВЕННАЯ ПРОВЕРКА ВСТРОЕННОГО БРАУЗЕРНОГО КЭША (0 мс, работает без server.py!)
  if (!payload.forceRefresh) {
    const localCached = await getLocalAiCacheEntry(payload.slug, payload.title);
    if (localCached && localCached.verdict) {
      return {
        ok: true,
        cached: true,
        mode: `Кэш браузера (${localCached.mode || 'ИИ'})`,
        verdict: localCached.verdict,
        sources: localCached.sources || []
      };
    }
  }

  let webSources = [];
  let backendOnline = false;

  // 1. Запрашиваем локальный FastAPI (:8765) для проверки SQLite-кэша и поиска отзывов в интернете
  try {
    const resp = await fetchWithTimeout(
      `${backendUrl}/api/analyze-product`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
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
      if (data.verdict && data.aiOk !== false && !data.verdict.startsWith('⚠️')) {
        const modeLabel = data.cached ? 'FastAPI SQLite Cache (:8765)' : `FastAPI (:8765) + ${settings.aiModel}`;
        await saveLocalAiCacheEntry(payload.slug, payload.title, data.verdict, webSources, modeLabel);
        return {
          ok: true,
          cached: Boolean(data.cached),
          mode: modeLabel,
          verdict: data.verdict,
          sources: webSources
        };
      }
    }
  } catch {
    // FastAPI (:8765) выключен или не ответил — продолжаем автономно
  }

  // 1b. Если локальный сервер выключен или не вернул отзывы — ищем отзывы напрямую из Service Worker по списку сайтов!
  if (!webSources || webSources.length === 0) {
    webSources = await searchWebReviewsDirect(payload.title, payload.brand);
  }

  // 2. Пробуем прямой запрос в OpenAI-совместимый мост (:8083 / DeepSeek / Ollama), если он запущен
  try {
    const promptForBridge = buildProductReviewPrompt(payload, webSources, false);
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
          sources: webSources
        };
      }
    }
  } catch {
    // Мост :8083 выключен — переходим к Автопилоту через выбранный аккаунт Gemini
  }

  // 3. АВТОПИЛОТ ЧЕРЕЗ ВЫБРАННЫЙ АККАУНТ / ВКЛАДКУ GEMINI В БРАУЗЕРЕ (ЧЕРЕЗ ОЧЕРЕДЬ БЕЗ ГОНОК)
  return await enqueueGeminiTabExecution(async () => {
    const geminiTab = await findOpenGeminiTab(true, false);
    if (geminiTab && geminiTab.id) {
      const email = await detectTabAccountEmail(geminiTab.id);
      const accIdx = extractAccountIndexFromUrl(geminiTab.url);
      const promptForTab = buildProductReviewPrompt(payload, webSources, true);
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
          sources: webSources
        };
      }
      return {
        ok: false,
        mode: 'Gemini Tab Error',
        error:
          tabResult && tabResult.error
            ? tabResult.error
            : 'Не удалось получить ответ от вкладки gemini.google.com.',
        sources: webSources
      };
    }

    return {
      ok: false,
      mode: 'All AI methods unreachable',
      error: 'Не удалось найти или открыть вкладку gemini.google.com и локальный мост :8083 выключен.',
      sources: webSources
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
// ЖИЗНЕННЫЙ ЦИКЛ SERVICE WORKER: ZERO-CLICK АВТОЗАПУСК И ПРОГРЕВ
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
