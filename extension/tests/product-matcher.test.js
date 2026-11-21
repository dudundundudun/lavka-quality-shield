const test = require('node:test');
const assert = require('node:assert/strict');
const matcher = require('../shared/product-matcher.js');

test('normalizeTitleKey strips HTML, quotes, trailing weight, and normalizes ё to е', () => {
  assert.equal(
    matcher.normalizeTitleKey('<b>Сыр «Российский»</b>, 250 г'),
    'сыр российский'
  );
  assert.equal(
    matcher.normalizeTitleKey('Напиток «Чёрная смородина» 1,5 л'),
    'напиток черная смородина'
  );
  assert.equal(matcher.normalizeTitleKey(''), '');
});

test('parseVolumeOrWeightGrams parses single and multipack weights/volumes accurately', () => {
  assert.equal(matcher.parseVolumeOrWeightGrams('Молоко 930 мл'), 930);
  assert.equal(matcher.parseVolumeOrWeightGrams('Добрый Cola 1,5 л'), 1500);
  assert.equal(matcher.parseVolumeOrWeightGrams('Йогурт 4×125 г'), 500);
  assert.equal(matcher.parseVolumeOrWeightGrams('Хлеб нарезной'), null);
});

test('isSearchResultMatchingProduct enforces sugar-free, flavor modifiers, and volume tolerance', () => {
  const exact = matcher.isSearchResultMatchingProduct(
    'Напиток Добрый Кола без сахара 1.5л — 149 ₽',
    'В наличии в Магните',
    'Добрый Cola без сахара',
    '1,5 л'
  );
  assert.equal(exact.isSameProduct, true);
  assert.equal(exact.isSameVolume, true);
  assert.equal(exact.matchQuality, 'exact');
  assert.equal(exact.mismatchReason, null);

  const sugarMismatch = matcher.isSearchResultMatchingProduct(
    'Добрый Кола 1,5 л — 139 ₽',
    'Классический газированный напиток',
    'Добрый Cola без сахара',
    '1,5 л'
  );
  assert.equal(sugarMismatch.isSameProduct, false);
  assert.equal(sugarMismatch.matchQuality, 'mismatch');

  const flavorMismatch = matcher.isSearchResultMatchingProduct(
    'Добрый Кола Ваниль 1,5 л — 149 ₽',
    '',
    'Добрый Cola',
    '1,5 л'
  );
  assert.equal(flavorMismatch.isSameProduct, false);
  assert.equal(flavorMismatch.matchQuality, 'mismatch');

  const diffVolume = matcher.isSearchResultMatchingProduct(
    'Добрый Кола 0,5 л — 89 ₽',
    '',
    'Добрый Cola',
    '1,5 л'
  );
  assert.equal(diffVolume.isSameProduct, true);
  assert.equal(diffVolume.isSameVolume, false);
  assert.equal(diffVolume.matchQuality, 'similar');
  assert.equal(diffVolume.mismatchReason, 'volume_mismatch');
});

test('smart matcher distinguishes grades/lines, processing, brands, volume 0.88-1.14, and price anomalies', () => {
  // 1. Stop words cleaned of meaningful product distinctions
  for (const w of ['замороженный', 'охлажденный', 'нарезка', 'банка', 'бутылка', 'стерилизованный', 'пастеризованный', 'ультрапастеризованный']) {
    assert.equal(matcher.GENERIC_STOP_WORDS.has(w), false, `Stop word should be removed: ${w}`);
  }

  // 2. Молодой vs Нежный горошек Bonduelle -> NOT exact (similar)
  const gradeDiff = matcher.isSearchResultMatchingProduct(
    'Горошек зелёный нежный Bonduelle 400г',
    '',
    'Горошек зелёный молодой Bonduelle',
    '400г'
  );
  assert.equal(gradeDiff.isSameProduct, false);
  assert.equal(gradeDiff.matchQuality, 'similar');
  assert.match(String(gradeDiff.mismatchReason), /^grade_mismatch:/);

  // 3. Молодой vs Замороженный горошек -> mismatch
  const procDiff = matcher.isSearchResultMatchingProduct(
    'Горошек зелёный замороженный 400г',
    '',
    'Горошек зелёный молодой',
    '400г'
  );
  assert.equal(procDiff.isSameProduct, false);
  assert.equal(procDiff.matchQuality, 'mismatch');
  assert.match(String(procDiff.mismatchReason), /^processing_mismatch:/);

  // 4. Bonduelle vs Красная цена -> mismatch
  const brandDiff = matcher.isSearchResultMatchingProduct(
    'Горошек Красная цена 400г',
    '',
    'Горошек Bonduelle',
    '400г'
  );
  assert.equal(brandDiff.isSameProduct, false);
  assert.equal(brandDiff.matchQuality, 'mismatch');
  assert.equal(brandDiff.mismatchReason, 'brand_mismatch');

  // 5. Latin vs Cyrillic brand + same grade -> exact
  const exactPeas = matcher.isSearchResultMatchingProduct(
    'Бондюэль горошек зелёный молодой 400г',
    '',
    'Горошек зелёный молодой Bonduelle',
    '400 г'
  );
  assert.equal(exactPeas.isSameProduct, true);
  assert.equal(exactPeas.isSameVolume, true);
  assert.equal(exactPeas.matchQuality, 'exact');
  assert.equal(exactPeas.mismatchReason, null);

  // 6. Narrowed volume tolerance: 400г vs 310г (ratio 0.775 < 0.88) -> not same volume, computes pricePerKgOrL
  const narrowVol = matcher.isSearchResultMatchingProduct(
    'Горошек зелёный молодой Bonduelle 310г',
    '',
    'Горошек зелёный молодой Bonduelle',
    '400 г',
    { candidatePrice: 124 }
  );
  assert.equal(narrowVol.isSameVolume, false);
  assert.equal(narrowVol.matchQuality, 'similar');
  assert.equal(narrowVol.pricePerKgOrL, 400);

  // 7. Price anomaly (> 2.2x at same weight) -> downgraded to similar with warning
  const anomaly = matcher.isSearchResultMatchingProduct(
    'Горошек зелёный молодой Bonduelle 400г',
    '',
    'Горошек зелёный молодой Bonduelle',
    '400 г',
    { targetPrice: 220, candidatePrice: 89 }
  );
  assert.equal(anomaly.isSameProduct, false);
  assert.equal(anomaly.isSameVolume, true);
  assert.equal(anomaly.matchQuality, 'similar');
  assert.equal(anomaly.mismatchReason, 'price_anomaly');
  assert.equal(anomaly.warning, 'проверьте сорт');
});

test('decodeHtmlEntities strips tags and decodes common HTML entities', () => {
  assert.equal(
    matcher.decodeHtmlEntities('<span>Молоко &quot;Простоквашино&quot; &amp; Co &#39;2.5%&#39;&nbsp;930мл</span>'),
    'Молоко "Простоквашино" & Co \'2.5%\' 930мл'
  );
  assert.equal(matcher.decodeHtmlEntities(null), '');
});

test('field recon regression: separates chicken vs beef flavors and matches unsalted butter across stores', () => {
  // Doshirak chicken vs beef must be mismatch, not exact
  const diffMeat = matcher.isSearchResultMatchingProduct(
    'Лапша быстрого приготовления Доширак Квисти со вкусом говядины 70 г',
    '',
    'Лапша Доширак Квисти со вкусом курицы 70г',
    '70 г'
  );
  assert.equal(diffMeat.isSameProduct, false);
  assert.equal(diffMeat.matchQuality, 'mismatch');
  assert.match(String(diffMeat.mismatchReason), /^flavor_mismatch:/);

  // Same chicken flavor with different wording -> exact
  const sameChicken = matcher.isSearchResultMatchingProduct(
    'Лапша быстрого приготовления Доширак Квисти с курицей 70 г',
    '',
    'Лапша Доширак Квисти со вкусом курицы 70г',
    '70 г'
  );
  assert.equal(sameChicken.isSameProduct, true);
  assert.equal(sameChicken.matchQuality, 'exact');

  // Unsalted butter on Kuper vs default butter on 5ka/Lavka -> exact
  const butterExact = matcher.isSearchResultMatchingProduct(
    'Масло сливочное Экомилк 82,5% 180г',
    '',
    'Сливочное масло несоленое Экомилк 82,5% БЗМЖ 180 г',
    '180 г'
  );
  assert.equal(butterExact.isSameProduct, true);
  assert.equal(butterExact.matchQuality, 'exact');

  // Salted butter vs unsalted butter -> still mismatch via 'солен'
  const saltedButter = matcher.isSearchResultMatchingProduct(
    'Масло сливочное соленое Экомилк 82,5% 180г',
    '',
    'Сливочное масло несоленое Экомилк 82,5% БЗМЖ 180 г',
    '180 г'
  );
  assert.equal(saltedButter.isSameProduct, false);
  assert.equal(saltedButter.matchQuality, 'mismatch');
});
