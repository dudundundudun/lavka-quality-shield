/**
 * Lavka Quality Shield — Product Page Metadata Parser & Nutrition/Unit-Price Calculator
 * Вынесено из content.js (Этап 4: модульная декомпозиция).
 */
(function (root) {
  'use strict';

  function extractProductPageMetadata(deps = {}) {
    const normalizeTitle = deps.normalizeTitle || ((s) => String(s || '').toLowerCase().trim());
    const extractImageKey = deps.extractImageKey || (() => null);
    const recorder = deps.recorder || null;
    const mainPage = document.querySelector('main[data-testid="good-page-desktop"]');
    const titleEl = (mainPage && mainPage.querySelector('h1[data-testid="product-title"]')) ||
                    document.querySelector('h1[data-testid="product-title"]');
    const amountEl = (mainPage && mainPage.querySelector('span[data-testid="product-amount"]')) ||
                     document.querySelector('span[data-testid="product-amount"]');
    const priceEl = (mainPage && mainPage.querySelector('span[data-testid="price-text"]')) ||
                    document.querySelector('span[data-testid="price-text"]');
    const oldPriceEl = (mainPage && mainPage.querySelector('span[data-testid="price-old-text"]')) ||
                       document.querySelector('span[data-testid="price-old-text"]');
    const ingredientsEl = document.querySelector('section[data-testid="ingredients-block"]');
    const traitsEl = document.querySelector('section[data-testid="traits-block"]');
    const snippetImg = (mainPage && mainPage.querySelector('img[data-testid="snippet-image"]')) ||
                       document.querySelector('img[data-testid="snippet-image"]');

    let ldData = {};
    document.querySelectorAll('script[data-testid="ldjson"], script[type="application/ld+json"]').forEach((el) => {
      try {
        const parsed = JSON.parse(el.textContent);
        const graph = parsed['@graph'] || [parsed];
        const prod = graph.find((item) => item && item['@type'] === 'Product');
        if (prod) {
          ldData = {
            productId: prod['@id'] || null,
            brand: prod.brand ? (typeof prod.brand === 'string' ? prod.brand : prod.brand.name) : null,
            description: prod.description || ''
          };
        }
      } catch {
        // ignore
      }
    });

    const rawTitle = titleEl ? titleEl.textContent : document.title.split('—')[0];
    const title = rawTitle ? rawTitle.replace(/[\u00ad\u200b]/g, '').trim() : '';
    const cleanTitle = normalizeTitle(title);
    const amountText = amountEl ? amountEl.textContent.replace(/[\u00ad\u200b\u00a0]/g, ' ').trim() : '';
    const priceText = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.') : '';
    const oldPriceText = oldPriceEl ? oldPriceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.') : '';
    const ingredientsText = ingredientsEl ? ingredientsEl.innerText.trim() : '';

    const traitsPairs = [];
    if (traitsEl) {
      const children = traitsEl.querySelectorAll('li, div > div, dl > div');
      children.forEach((node) => {
        const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 45 && /\d/.test(t)) {
          traitsPairs.push(t);
        }
      });
    }
    const traitsText = traitsPairs.length > 0
      ? Array.from(new Set(traitsPairs)).join(' | ')
      : (traitsEl ? traitsEl.innerText.replace(/\n+/g, ' | ').trim() : '');

    const imageKey = snippetImg ? extractImageKey(snippetImg.getAttribute('src')) : null;

    const meta = {
      title,
      cleanTitle,
      amountText,
      price: parseFloat(priceText) || null,
      oldPrice: parseFloat(oldPriceText) || null,
      ingredientsText,
      traitsText,
      imageKey,
      ...ldData
    };

    const parserStatus = (meta.title && meta.price) ? 'OK' : 'WARN';
    if (recorder && typeof recorder.updateModule === 'function') recorder.updateModule(
      'parser',
      parserStatus,
      `Товар: "${meta.title.slice(0, 32)}", цена=${meta.price ?? '?'}₽, вес="${meta.amountText || '?'}"`,
      meta
    );

    return meta;
  }

  function extractNutrientValue(traitsText, keywordRegex, unitHintRegex) {
    if (!traitsText) return null;
    const segments = traitsText.split(/[|\n;]+/);
    for (const seg of segments) {
      if (keywordRegex.test(seg)) {
        const m = seg.match(/([\d]+(?:[.,]\d+)?)/);
        if (m) {
          const val = parseFloat(m[1].replace(',', '.'));
          if (!isNaN(val)) return val;
        }
      }
    }
    const directAfter = new RegExp(keywordRegex.source + '[^\\d|\\n]{0,12}([\\d]+(?:[.,]\\d+)?)', 'i');
    const m1 = traitsText.match(directAfter);
    if (m1) return parseFloat(m1[1].replace(',', '.'));

    const directBefore = new RegExp('([\\d]+(?:[.,]\\d+)?)\\s*' + unitHintRegex.source + '\\s*' + keywordRegex.source, 'i');
    const m2 = traitsText.match(directBefore);
    if (m2) return parseFloat(m2[1].replace(',', '.'));

    return null;
  }

  function normalizePieceUnit(rawUnit) {
    const u = String(rawUnit || '').toLowerCase();
    if (u.startsWith('пакет') || u.startsWith('пак') || u.startsWith('саше')) return 'пак';
    if (u.startsWith('капс')) return 'капс';
    if (u.startsWith('табл')) return 'табл';
    if (u.startsWith('рул')) return 'рул';
    if (u.startsWith('лист')) return 'лист';
    if (u.startsWith('порц')) return 'порц';
    if (u.startsWith('пар')) return 'пар';
    if (u.startsWith('уп')) return 'уп';
    return 'шт';
  }

  function parseWeightAndPiecesFromString(rawStr) {
    if (globalThis.LQS_PRICE_PARSER && typeof globalThis.LQS_PRICE_PARSER.parseWeightAndPieces === 'function') {
      return globalThis.LQS_PRICE_PARSER.parseWeightAndPieces(rawStr);
    }
    if (!rawStr) return { weightGrams: null, unitLabel: 'кг', piecesCount: null, pieceUnitLabel: 'шт' };
    const text = String(rawStr).replace(/[\u00ad\u200b\u00a0]/g, ' ').trim();

    let weightGrams = null;
    let unitLabel = 'кг';
    let piecesCount = null;
    let pieceUnitLabel = 'шт';

    const multiMatch =
      text.match(/(\d+)\s*[×xх*]\s*([\d.,]+)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i) ||
      text.match(/(\d+)\s*(шт|штук[а-я]*|пакет[а-я]*|пак|саше|капс[а-я]*|порц[а-я]*|уп[а-я]*)\.?\s*(?:по|[×xх*]|\s)\s*([\d.,]+)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i);

    if (multiMatch) {
      if (multiMatch.length === 4) {
        const count = parseInt(multiMatch[1], 10) || 1;
        const val = parseFloat(multiMatch[2].replace(',', '.'));
        const unit = multiMatch[3].toLowerCase();
        unitLabel = (unit.startsWith('мл') || unit.startsWith('л')) ? 'л' : 'кг';
        if (val > 0) {
          const singleGrams = (unit.startsWith('кг') || unit.startsWith('л')) ? val * 1000 : val;
          weightGrams = count * singleGrams;
          piecesCount = count;
        }
      } else if (multiMatch.length >= 5) {
        const count = parseInt(multiMatch[1], 10) || 1;
        pieceUnitLabel = normalizePieceUnit(multiMatch[2]);
        const val = parseFloat(multiMatch[3].replace(',', '.'));
        const unit = multiMatch[4].toLowerCase();
        unitLabel = (unit.startsWith('мл') || unit.startsWith('л')) ? 'л' : 'кг';
        if (val > 0) {
          const singleGrams = (unit.startsWith('кг') || unit.startsWith('л')) ? val * 1000 : val;
          weightGrams = count * singleGrams;
          piecesCount = count;
        }
      }
    }

    if (!weightGrams) {
      const singleMatch = text.match(/(?:^|[^\d.,])([\d]+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i);
      if (singleMatch) {
        const val = parseFloat(singleMatch[1].replace(',', '.'));
        const unit = singleMatch[2].toLowerCase();
        unitLabel = (unit.startsWith('мл') || unit.startsWith('л')) ? 'л' : 'кг';
        if (val > 0) {
          weightGrams = (unit.startsWith('кг') || unit.startsWith('л')) ? val * 1000 : val;
        }
      }
    }

    const pieceMatch = text.match(/(?:^|[^\d.,])(\d+)\s*(шт|штук[а-я]*|пакет[а-я]*|пак|саше|капс[а-я]*|табл[а-я]*|рулон[а-я]*|лист[а-я]*|порц[а-я]*|пар[а-я]*|уп[а-я]*)(?![а-яёa-z])/i);
    if (pieceMatch) {
      const cnt = parseInt(pieceMatch[1], 10);
      if (cnt > 0) {
        piecesCount = cnt;
        pieceUnitLabel = normalizePieceUnit(pieceMatch[2]);
      }
    }

    return { weightGrams, unitLabel, piecesCount, pieceUnitLabel };
  }

  function analyzeProductQuality(meta, deps = {}) {
    const recorder = deps.recorder || null;
    const flags = [];
    let pricePerKg = null;
    let weightGrams = null;
    let unitLabel = 'кг';
    let piecesCount = null;
    let pieceUnitLabel = 'шт';
    let pricePerPiece = null;
    let proteinPer100g = null;
    let fatPer100g = null;
    let carbsPer100g = null;
    let kcalPer100g = null;
    let pricePer100gProtein = null;

    const fromAmount = parseWeightAndPiecesFromString(meta.amountText);
    const fromTitle = parseWeightAndPiecesFromString(meta.title);

    if (fromAmount.weightGrams) {
      weightGrams = fromAmount.weightGrams;
      unitLabel = fromAmount.unitLabel;
    } else if (fromTitle.weightGrams) {
      weightGrams = fromTitle.weightGrams;
      unitLabel = fromTitle.unitLabel;
    }

    if (fromAmount.piecesCount) {
      piecesCount = fromAmount.piecesCount;
      pieceUnitLabel = fromAmount.pieceUnitLabel;
    } else if (fromTitle.piecesCount) {
      piecesCount = fromTitle.piecesCount;
      pieceUnitLabel = fromTitle.pieceUnitLabel;
    }

    if (weightGrams && weightGrams > 0 && meta.price) {
      pricePerKg = Math.round((meta.price / weightGrams) * 1000);
    }

    if (piecesCount && piecesCount > 0 && meta.price) {
      pricePerPiece = Math.round(meta.price / piecesCount);
    }

    if (meta.traitsText) {
      proteinPer100g = extractNutrientValue(meta.traitsText, /белк[иао]?/i, /(?:г|гр)\.?/);
      fatPer100g = extractNutrientValue(meta.traitsText, /жир[ыаов]?/i, /(?:г|гр)\.?/);
      carbsPer100g = extractNutrientValue(meta.traitsText, /углевод[ыаов]?/i, /(?:г|гр)\.?/);
      kcalPer100g = extractNutrientValue(meta.traitsText, /(?:ккал|калор)/i, /(?:ккал)?/);

      if (proteinPer100g !== null && proteinPer100g >= 3 && proteinPer100g <= 100 && pricePerKg) {
        const totalProteinInKg = proteinPer100g * 10;
        pricePer100gProtein = Math.round((pricePerKg / totalProteinInKg) * 100);
      }

      if (carbsPer100g !== null && !isNaN(carbsPer100g)) {
        if (carbsPer100g <= 5) {
          flags.push({ type: 'good', text: `🥑 Кето (${carbsPer100g}г угл)` });
        } else if (carbsPer100g >= 22) {
          flags.push({ type: 'bad', text: `🍞 ${carbsPer100g}г угл` });
        }
      }

      if (proteinPer100g !== null && proteinPer100g >= 15) {
        flags.push({ type: 'good', text: `💪 Много белка (${proteinPer100g}г)` });
      }
    }

    const ingLower = (meta.ingredientsText || '').toLowerCase();
    if (ingLower) {
      const badMatchers = [
        { regex: /механической обвалки|ммо/i, label: '⚠️ ММО' },
        { regex: /мальтодекстрин|патока|глюкозно-фруктозный/i, label: '🍬 Сахар/патока' },
        { regex: /заменитель молочного жира|пальмовое масло/i, label: '🛢️ ЗМЖ/пальма' },
        { regex: /соевый белок|соевая мука|клетчатка пшеничная/i, label: '🌾 Соя/клетчатка' },
        { regex: /глутамат|е621|ароматизатор/i, label: '🧪 Ароматизатор' },
        { regex: /крахмал/i, label: '🥔 Крахмал' }
      ];

      badMatchers.forEach((item) => {
        if (item.regex.test(ingLower)) {
          flags.push({ type: 'bad', text: item.label });
        }
      });

      const hasBad = flags.some((f) => f.type === 'bad');
      if (!hasBad && ingLower.length > 10) {
        flags.push({ type: 'good', text: '✅ Чистый состав' });
      }
    }

    const result = {
      weightGrams,
      pricePerKg,
      unitLabel,
      piecesCount,
      pieceUnitLabel,
      pricePerPiece,
      proteinPer100g,
      fatPer100g,
      carbsPer100g,
      kcalPer100g,
      pricePer100gProtein,
      flags: flags.slice(0, 6)
    };

    const unitSummary = pricePerKg
      ? `Цена/${unitLabel}: ~${pricePerKg}₽`
      : (pricePerPiece && piecesCount > 1 ? `Цена/${pieceUnitLabel}: ~${pricePerPiece}₽ (${piecesCount} ${pieceUnitLabel})` : 'Поштучно/без веса');

    if (recorder && typeof recorder.updateModule === 'function') recorder.updateModule(
      'calculator',
      (pricePerKg || pricePerPiece) ? 'OK' : 'WARN',
      `${unitSummary}, Белок/100г: ${proteinPer100g ?? '—'}г (${pricePer100gProtein ? pricePer100gProtein + '₽/100г' : '—'}), Флагов: ${result.flags.length}`,
      result
    );

    return result;
  }

  const api = {
    extractProductPageMetadata,
    extractNutrientValue,
    normalizePieceUnit,
    parseWeightAndPiecesFromString,
    analyzeProductQuality
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_PRODUCT_PARSER = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
