'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeHtml,
  safeHttpUrl,
  buildFullProductSearchQuery,
  buildDirectStoreSearchLinks
} = require('../shared/utils.js');

test('escapeHtml escapes HTML special characters and handles nullish/non-string input', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(42), '42');
  assert.equal(
    escapeHtml('<script>alert("xss" & \'test\')</script>'),
    '&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;test&#39;)&lt;/script&gt;'
  );
  assert.equal(escapeHtml('Молоко «Домик в деревне» 3,2%'), 'Молоко «Домик в деревне» 3,2%');
});

test('safeHttpUrl allows http/https URLs and rejects unsafe or invalid schemes', () => {
  assert.equal(safeHttpUrl('https://magnit.ru/product/123'), 'https://magnit.ru/product/123');
  assert.equal(safeHttpUrl('  http://127.0.0.1:8765/api/health  '), 'http://127.0.0.1:8765/api/health');
  assert.equal(safeHttpUrl('HTTPS://lavka.yandex.ru/'), 'HTTPS://lavka.yandex.ru/');

  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(safeHttpUrl('file:///etc/passwd'), '');
  assert.equal(safeHttpUrl('/relative/path'), '');
  assert.equal(safeHttpUrl(''), '');
  assert.equal(safeHttpUrl(null), '');
  assert.equal(safeHttpUrl(undefined), '');
  assert.equal(safeHttpUrl(12345), '');
});

test('buildFullProductSearchQuery cleans noise tokens, quotes, and appends brand and amount without duplicating weight', () => {
  assert.equal(
    buildFullProductSearchQuery('Творог БЗМЖ «Вкусный» 5%', 'Из Лавки', '200 г'),
    'Творог Вкусный 5% Из Лавки 200 г'
  );
  assert.equal(
    buildFullProductSearchQuery('Сыр СТМ Российский', 'Брест-Литовск', '200 г'),
    'Сыр Российский Брест-Литовск 200 г'
  );
  // Brand already present (case-insensitive) should not be duplicated
  assert.equal(
    buildFullProductSearchQuery('Молоко Домик в деревне', 'домик в деревне', '930 мл'),
    'Молоко Домик в деревне 930 мл'
  );
  // Equivalent weight already in title (1 л == 1000 мл) should not be duplicated
  assert.equal(
    buildFullProductSearchQuery('Сок яблочный 1 л', 'Добрый', '1000 мл'),
    'Сок яблочный 1 л Добрый'
  );
  // Different weight should be appended
  assert.equal(
    buildFullProductSearchQuery('Набор 6 × 330 мл', '', '500 мл'),
    'Набор 6 × 330 мл 500 мл'
  );
  // Piece count appended if not present
  assert.equal(
    buildFullProductSearchQuery('Яйца куриные С1', '', '10 шт'),
    'Яйца куриные С1 10 шт'
  );
  // Handles empty inputs safely
  assert.equal(buildFullProductSearchQuery('', '', ''), '');
});

test('buildDirectStoreSearchLinks builds 16 store links using full query', () => {
  const links = buildDirectStoreSearchLinks('Молоко 3.2%', '930 мл', 'Простоквашино');
  assert.equal(links.length, 16);
  assert.equal(links[0].store, 'Магнит');
  assert.equal(links[0].query, 'Молоко 3.2% Простоквашино 930 мл');
  assert.ok(links[0].url.startsWith('https://magnit.ru/search?term='));
});
