/**
 * Lavka Quality Shield — Pure Unit Price & Weight/Volume Parser (₽/кг, ₽/л, ₽/шт)
 * Works in Chrome MV3 Service Worker (importScripts), content_scripts, and Node.js (node --test).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_PRICE_PARSER = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  function parseWeightAndPieces(rawStr) {
    if (!rawStr) {
      return { weightGrams: null, unitLabel: 'кг', piecesCount: null, pieceUnitLabel: 'шт' };
    }
    const s = String(rawStr).replace(/\u00a0/g, ' ').trim();

    let weightGrams = null;
    let unitLabel = 'кг';
    let piecesCount = null;
    let pieceUnitLabel = 'шт';

    // Multipack with weight/volume: "6 × 330 мл", "4x100 г"
    const multiWeightMatch = s.match(/(\d+)\s*[×xх*]\s*(\d+(?:[.,]\d+)?)\s*(г|гр|грамм|кг|мл|л)(?![а-яёa-z])/i);
    if (multiWeightMatch) {
      const cnt = parseInt(multiWeightMatch[1], 10);
      const val = parseFloat(multiWeightMatch[2].replace(',', '.'));
      const unit = multiWeightMatch[3].toLowerCase();
      if (cnt > 0 && val > 0) {
        if (unit === 'кг') {
          weightGrams = cnt * val * 1000;
          unitLabel = 'кг';
        } else if (unit === 'л') {
          weightGrams = cnt * val * 1000;
          unitLabel = 'л';
        } else if (unit === 'мл') {
          weightGrams = cnt * val;
          unitLabel = 'л';
        } else {
          weightGrams = cnt * val;
          unitLabel = 'кг';
        }
        piecesCount = cnt;
        pieceUnitLabel = 'шт';
      }
    }

    // Single weight/volume: "450 г", "1,5 л", "0.9 кг", "449 мл"
    if (!weightGrams) {
      const singleWeightMatch = s.match(/(\d+(?:[.,]\d+)?)\s*(кг|г|гр|грамм|л|мл)(?![а-яёa-z])/i);
      if (singleWeightMatch) {
        const val = parseFloat(singleWeightMatch[1].replace(',', '.'));
        const unit = singleWeightMatch[2].toLowerCase();
        if (val > 0) {
          if (unit === 'кг') {
            weightGrams = val * 1000;
            unitLabel = 'кг';
          } else if (unit === 'л') {
            weightGrams = val * 1000;
            unitLabel = 'л';
          } else if (unit === 'мл') {
            weightGrams = val;
            unitLabel = 'л';
          } else {
            weightGrams = val;
            unitLabel = 'кг';
          }
        }
      }
    }

    // Piece count: "10 шт", "12 рул", "20 капс", "25 пак"
    if (!piecesCount) {
      const pieceMatch = s.match(/(\d+)\s*(шт|штук|штуки|рул|рулон|рулона|рулонов|пак|пакет|пакетиков|капс|капсул|табл|таблеток|ломт|ломтиков|порц)(?![а-яёa-z])/i);
      if (pieceMatch) {
        const cnt = parseInt(pieceMatch[1], 10);
        const rawUnit = pieceMatch[2].toLowerCase();
        if (cnt > 0) {
          piecesCount = cnt;
          if (rawUnit.startsWith('рул')) pieceUnitLabel = 'рул';
          else if (rawUnit.startsWith('капс')) pieceUnitLabel = 'капс';
          else if (rawUnit.startsWith('табл')) pieceUnitLabel = 'табл';
          else if (rawUnit.startsWith('пак')) pieceUnitLabel = 'пак';
          else pieceUnitLabel = 'шт';
        }
      }
    }

    return { weightGrams, unitLabel, piecesCount, pieceUnitLabel };
  }

  function computeUnitPrices({ price, amountText = '', title = '', proteinPer100g = null } = {}) {
    const numPrice = Number(price);
    const fromAmount = parseWeightAndPieces(amountText);
    const fromTitle = parseWeightAndPieces(title);

    const weightGrams = fromAmount.weightGrams || fromTitle.weightGrams || null;
    const unitLabel = fromAmount.weightGrams ? fromAmount.unitLabel : (fromTitle.weightGrams ? fromTitle.unitLabel : 'кг');
    const piecesCount = fromAmount.piecesCount || fromTitle.piecesCount || null;
    const pieceUnitLabel = fromAmount.piecesCount ? fromAmount.pieceUnitLabel : (fromTitle.piecesCount ? fromTitle.pieceUnitLabel : 'шт');

    let pricePerKg = null;
    let pricePerPiece = null;
    let pricePer100gProtein = null;

    if (Number.isFinite(numPrice) && numPrice > 0) {
      if (weightGrams && weightGrams >= 10) {
        pricePerKg = Math.round((numPrice / weightGrams) * 1000);
      }
      if (piecesCount && piecesCount > 1) {
        pricePerPiece = Math.round(numPrice / piecesCount);
      }
      const numProtein = Number(proteinPer100g);
      if (Number.isFinite(numProtein) && numProtein >= 3 && numProtein <= 100 && pricePerKg) {
        const totalProteinInKg = numProtein * 10;
        pricePer100gProtein = Math.round((pricePerKg / totalProteinInKg) * 100);
      }
    }

    return {
      weightGrams,
      unitLabel,
      pricePerKg,
      piecesCount,
      pieceUnitLabel,
      pricePerPiece,
      pricePer100gProtein
    };
  }

  return Object.freeze({
    parseWeightAndPieces,
    computeUnitPrices
  });
});
