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
  assert.deepEqual(exact, { isSameProduct: true, isSameVolume: true });

  const sugarMismatch = matcher.isSearchResultMatchingProduct(
    'Добрый Кола 1,5 л — 139 ₽',
    'Классический газированный напиток',
    'Добрый Cola без сахара',
    '1,5 л'
  );
  assert.equal(sugarMismatch.isSameProduct, false);

  const flavorMismatch = matcher.isSearchResultMatchingProduct(
    'Добрый Кола Ваниль 1,5 л — 149 ₽',
    '',
    'Добрый Cola',
    '1,5 л'
  );
  assert.equal(flavorMismatch.isSameProduct, false);

  const diffVolume = matcher.isSearchResultMatchingProduct(
    'Добрый Кола 0,5 л — 89 ₽',
    '',
    'Добрый Cola',
    '1,5 л'
  );
  assert.deepEqual(diffVolume, { isSameProduct: true, isSameVolume: false });
});

test('decodeHtmlEntities strips tags and decodes common HTML entities', () => {
  assert.equal(
    matcher.decodeHtmlEntities('<span>Молоко &quot;Простоквашино&quot; &amp; Co &#39;2.5%&#39;&nbsp;930мл</span>'),
    'Молоко "Простоквашино" & Co \'2.5%\' 930мл'
  );
  assert.equal(matcher.decodeHtmlEntities(null), '');
});
