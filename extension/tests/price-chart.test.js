const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extDir = path.resolve(__dirname, '..');

function loadPriceChartModule() {
  const sandbox = {
    console,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    JSON
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  const utilsCode = fs.readFileSync(path.join(extDir, 'shared', 'utils.js'), 'utf8');
  const chartCode = fs.readFileSync(path.join(extDir, 'content', 'price-chart.js'), 'utf8');
  vm.runInContext(utilsCode, ctx);
  vm.runInContext(chartCode, ctx);
  return sandbox.LQS_PRICE_CHART;
}

test('aggregateDailyAverages groups observations by calendar date and computes mean', () => {
  const chart = loadPriceChartModule();
  const points = [
    { price: 200, ts: '2026-10-01T08:00:00Z' },
    { price: 220, ts: '2026-10-01T18:00:00Z' },
    { price: 180, ts: '2026-10-05T12:00:00Z' }
  ];
  const daily = chart.aggregateDailyAverages(points);
  assert.equal(daily.length, 2);
  assert.equal(daily[0].date, '2026-10-01');
  assert.equal(daily[0].price, 210);
  assert.equal(daily[0].count, 2);
  assert.equal(daily[1].date, '2026-10-05');
  assert.equal(daily[1].price, 180);
});

test('filterPointsByDays respects rolling window and 0=all', () => {
  const chart = loadPriceChartModule();
  const now = Date.parse('2026-11-20T12:00:00Z');
  const points = [
    { price: 150, ts: '2026-08-01T12:00:00Z' },
    { price: 170, ts: '2026-11-01T12:00:00Z' },
    { price: 160, ts: '2026-11-18T12:00:00Z' }
  ];
  assert.equal(chart.filterPointsByDays(points, 7, now).length, 1);
  assert.equal(chart.filterPointsByDays(points, 30, now).length, 2);
  assert.equal(chart.filterPointsByDays(points, 0, now).length, 3);
});

test('buildPriceChartSvg renders valid SVG with polyline, axis labels, and hit circles', () => {
  const chart = loadPriceChartModule();
  const series = [
    { price: 149, ts: '2026-09-01T10:00:00Z', accountId: 'Аккаунт #1' },
    { price: 199, ts: '2026-10-01T10:00:00Z', accountId: 'Аккаунт #1' },
    { price: 169, ts: '2026-11-15T10:00:00Z', accountId: 'Аккаунт #1' }
  ];
  const svg = chart.buildPriceChartSvg(series);
  assert.match(svg, /<svg class="lqs-price-svg"/);
  assert.match(svg, /<polyline/);
  assert.match(svg, /199 ₽/);
  assert.match(svg, /169 ₽/);
  assert.match(svg, /149 ₽/);
  assert.equal((svg.match(/class="lqs-chart-hit"/g) || []).length, 3);
});

test('buildPriceHistoryCardHtml renders embedded and popover modes with watch button and no inline onclick', () => {
  const chart = loadPriceChartModule();
  const data = {
    slug: 'milk_1l',
    days: 90,
    isWatched: true,
    points: [
      { price: 110, ts: '2026-11-01T10:00:00Z' },
      { price: 99, ts: '2026-11-19T10:00:00Z' }
    ],
    stats: { minPrice: 99, maxPrice: 110, avgPrice: 104.5, lastPrice: 99, count: 2 }
  };
  const inlineHtml = chart.buildPriceHistoryCardHtml(data, { mode: 'exact', days: 90, isPopover: false });
  assert.match(inlineHtml, /История цены/);
  assert.match(inlineHtml, /❤️ Слежу за товаром/);
  assert.match(inlineHtml, /lqs-ph-popout-btn/);
  assert.doesNotMatch(inlineHtml, /\bonclick=/i);

  const popHtml = chart.buildPriceHistoryCardHtml(data, { mode: 'avg', days: 30, isPopover: true });
  assert.match(popHtml, /is-popover/);
  assert.match(popHtml, /lqs-ph-close-btn/);
  assert.doesNotMatch(popHtml, /\bonclick=/i);
});

test('price history inline card uses compact SVG height (~84px), 2-row layout, and full-width CSS', () => {
  const chart = loadPriceChartModule();
  const data = {
    slug: 'cheese_200g',
    days: 90,
    isWatched: false,
    points: [
      { price: 210, ts: '2026-10-01T10:00:00Z' },
      { price: 195, ts: '2026-11-19T10:00:00Z' }
    ],
    stats: { minPrice: 195, maxPrice: 210, avgPrice: 202.5, lastPrice: 195, count: 2 }
  };
  const inlineHtml = chart.buildPriceHistoryCardHtml(data, { mode: 'exact', days: 90, isPopover: false });
  assert.match(inlineHtml, /viewBox="0 0 440 84"/);
  assert.doesNotMatch(inlineHtml, /lqs-ph-mode-row/);
  assert.match(inlineHtml, /lqs-ph-footer[\s\S]*lqs-ph-meta[\s\S]*lqs-ph-watch-btn/);

  const popHtml = chart.buildPriceHistoryCardHtml(data, { mode: 'exact', days: 90, isPopover: true });
  assert.match(popHtml, /viewBox="0 0 320 104"/);
  assert.match(popHtml, /is-popover/);

  const css = fs.readFileSync(path.join(extDir, 'styles.css'), 'utf8');
  assert.match(css, /\.lqs-ph-card\.is-inline\s*\{[^}]*width:\s*100%\s*!important;[^}]*max-width:\s*none\s*!important;/);
  assert.doesNotMatch(css, /\.lqs-ph-card\.is-inline\s*\{[^}]*max-width:\s*360px/);
});
