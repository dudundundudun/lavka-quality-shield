/**
 * Lavka Quality Shield — Pure Product Normalization & Matching Module (shared/product-matcher.js)
 * Works in Chrome Extension Service Worker (importScripts), Content Scripts, and Node.js tests.
 */
(function (root) {
  'use strict';

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

  const api = {
    SUGAR_FREE_REGEX,
    FLAVOR_AND_TYPE_MODIFIERS,
    GENERIC_STOP_WORDS,
    normalizeTitleKey,
    parseVolumeOrWeightGrams,
    normalizeSynonymTokens,
    isSearchResultMatchingProduct,
    decodeHtmlEntities
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_MATCHER = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
