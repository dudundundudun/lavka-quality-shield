'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWeightAndPieces, computeUnitPrices } = require('../shared/price-parser.js');

test('parseWeightAndPieces parses grams and kilograms as кг', () => {
  assert.deepEqual(parseWeightAndPieces('450 г'), {
    weightGrams: 450,
    unitLabel: 'кг',
    piecesCount: null,
    pieceUnitLabel: 'шт'
  });
  assert.deepEqual(parseWeightAndPieces('1,5 кг'), {
    weightGrams: 1500,
    unitLabel: 'кг',
    piecesCount: null,
    pieceUnitLabel: 'шт'
  });
});

test('parseWeightAndPieces parses milliliters and liters as л', () => {
  assert.deepEqual(parseWeightAndPieces('449 мл'), {
    weightGrams: 449,
    unitLabel: 'л',
    piecesCount: null,
    pieceUnitLabel: 'шт'
  });
  assert.deepEqual(parseWeightAndPieces('0,9 л'), {
    weightGrams: 900,
    unitLabel: 'л',
    piecesCount: null,
    pieceUnitLabel: 'шт'
  });
});

test('parseWeightAndPieces parses multipacks and piece counts', () => {
  const multi = parseWeightAndPieces('6 × 330 мл');
  assert.equal(multi.weightGrams, 1980);
  assert.equal(multi.unitLabel, 'л');
  assert.equal(multi.piecesCount, 6);

  const rolls = parseWeightAndPieces('12 рул.');
  assert.equal(rolls.weightGrams, null);
  assert.equal(rolls.piecesCount, 12);
  assert.equal(rolls.pieceUnitLabel, 'рул');

  const caps = parseWeightAndPieces('20 капсул');
  assert.equal(caps.piecesCount, 20);
  assert.equal(caps.pieceUnitLabel, 'капс');
});

test('computeUnitPrices computes ₽/кг, ₽/л, ₽/шт and ₽/100g protein', () => {
  const resKg = computeUnitPrices({ price: 240, amountText: '450 г', proteinPer100g: 12 });
  assert.equal(resKg.pricePerKg, 533);
  assert.equal(resKg.unitLabel, 'кг');
  assert.equal(resKg.pricePer100gProtein, 444);

  const resL = computeUnitPrices({ price: 144, amountText: '1,5 л' });
  assert.equal(resL.pricePerKg, 96);
  assert.equal(resL.unitLabel, 'л');

  const resPcs = computeUnitPrices({ price: 150, amountText: '10 шт' });
  assert.equal(resPcs.pricePerKg, null);
  assert.equal(resPcs.pricePerPiece, 15);
  assert.equal(resPcs.pieceUnitLabel, 'шт');
});

test('computeUnitPrices falls back to title when amountText is empty and handles invalid input', () => {
  const fromTitle = computeUnitPrices({ price: 117, amountText: '', title: 'Adrenaline Rush Zero 449 мл' });
  assert.equal(fromTitle.weightGrams, 449);
  assert.equal(fromTitle.unitLabel, 'л');
  assert.equal(fromTitle.pricePerKg, 261);

  const invalid = computeUnitPrices({ price: 0, amountText: 'без веса', title: '' });
  assert.equal(invalid.pricePerKg, null);
  assert.equal(invalid.pricePerPiece, null);
  assert.equal(invalid.pricePer100gProtein, null);
});
