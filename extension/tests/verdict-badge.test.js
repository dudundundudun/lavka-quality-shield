const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extDir = path.resolve(__dirname, '..');

function loadVerdictExtractor() {
  const src = fs.readFileSync(path.join(extDir, 'content', 'verdict-badge.js'), 'utf8');
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(src, sandbox);
  return sandbox.LQS_VERDICT_BADGE.extractVerdictBadgeFromText;
}

test('extractVerdictBadgeFromText extracts short reason for new "С оговорками" format and preserves full title', () => {
  const extract = loadVerdictExtractor();
  const verdict = '1. Отзывы нормальные.\n2. Состав с сахаром.\n3. **Вердикт**: ⚠️ **С оговорками: много сахара** — лучше брать по акции.';
  const badge = extract(verdict);
  assert.equal(badge.cls, 'verdict-warn');
  assert.equal(badge.text, '🤖 ⚠️ С оговорками: много сахара');
  assert.equal(badge.shortCatalog, '🤖⚠️');
  assert.ok(badge.title.includes('С оговорками: много сахара'));
  assert.ok(!badge.title.includes('**'));
});

test('extractVerdictBadgeFromText supports legacy "На любителя" cache with concrete keyword fallback', () => {
  const extract = loadVerdictExtractor();
  const legacyWithPalm = '2. Состав: есть пальмовое масло и сахар.\n3. **Вердикт**: ⚠️ **На любителя — есть компромиссы по составу или цене**.';
  const badge1 = extract(legacyWithPalm);
  assert.equal(badge1.cls, 'verdict-warn');
  assert.equal(badge1.text, '🤖 ⚠️ С оговорками: пальмовое масло / ЗМЖ');
  assert.ok(badge1.title.includes('На любителя'));

  const legacyGeneric = '⚠️ **На любителя — есть компромиссы по составу или цене**';
  const badge2 = extract(legacyGeneric);
  assert.equal(badge2.cls, 'verdict-warn');
  assert.equal(badge2.text, '🤖 ⚠️ С оговорками: состав или цена');

  const legacySpecific = '⚠️ **На любителя — слишком сладкий**';
  const badge3 = extract(legacySpecific);
  assert.equal(badge3.cls, 'verdict-warn');
  assert.equal(badge3.text, '🤖 ⚠️ С оговорками: слишком сладкий');
});

test('extractVerdictBadgeFromText trims overly long reasons and keeps other verdicts working', () => {
  const extract = loadVerdictExtractor();
  const longWarn = '⚠️ **С оговорками: очень высокая цена за килограмм и лишний крахмал в составе**';
  const warnBadge = extract(longWarn);
  assert.equal(warnBadge.cls, 'verdict-warn');
  assert.ok(warnBadge.text.startsWith('🤖 ⚠️ С оговорками: '));
  assert.ok(warnBadge.text.endsWith('…'));
  assert.ok(warnBadge.title.includes('очень высокая цена за килограмм'));

  assert.equal(extract('✅ **Отличный выбор — стоит брать**').text, '🤖 ✅ Стоит брать');
  assert.equal(extract('👍 **Хороший вариант на каждый день**').text, '🤖 👍 Хороший');
  assert.equal(extract('❌ **Не рекомендую к покупке**').text, '🤖 ❌ Не брать');
});

test('background.js AI prompt uses concrete "С оговорками:" verdict instead of "На любителя"', () => {
  const bg = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');
  assert.match(bg, /⚠️ \*\*С оговорками:/);
  assert.doesNotMatch(bg, /На любителя — есть компромиссы/);
});

test('Stage 4 cleanup: dead magnit-parser.js removed, port 8083 removed from manifest, and extracted modules registered', () => {
  assert.equal(fs.existsSync(path.join(extDir, 'content', 'magnit-parser.js')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  const hosts = manifest.host_permissions || [];
  assert.equal(hosts.some((h) => h.includes(':8083')), false);
  const jsList = manifest.content_scripts[0].js;
  assert.ok(jsList.includes('content/verdict-badge.js'));
  assert.ok(jsList.includes('content/product-parser.js'));
  assert.equal(fs.existsSync(path.join(extDir, 'bg', 'cart-sync.js')), true);
});
