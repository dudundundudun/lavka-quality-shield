const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extDir = path.resolve(__dirname, '..');

test('background.js onMessage uses declared sender parameter and guards sensitive messages', () => {
  const bg = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');
  assert.match(bg, /chrome\.runtime\.onMessage\.addListener\(\(msg,\s*sender,\s*sendResponse\)/);
  assert.doesNotMatch(bg, /chrome\.runtime\.onMessage\.addListener\(\(msg,\s*_sender,/);
  assert.match(bg, /LQS_GET_GEMINI_COOKIE_HEADER'[\s\S]{0,160}isPopupSender\(sender\)/);
  assert.match(bg, /LQS_DELETE_ACCOUNT_FROM_VAULT'[\s\S]{0,160}isPopupSender\(sender\)/);
  assert.doesNotMatch(bg, /headerString:\s*cookieInfo\.headerString/);
  assert.match(bg, /async function fetchBackendAccountSecrets\(backendUrl, accountId\)/);
  assert.match(bg, /\/api\/accounts\/\$\{encodeURIComponent\(accountId\)\}\/secrets/);
});

test('content.js validates competitor href URLs with safeHttpUrl', () => {
  const content = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8');
  assert.match(content, /function safeHttpUrl\(url\)/);
  assert.match(content, /escapeHtml\(safeHttpUrl\(o\.url\)\)/);
  assert.match(content, /escapeHtml\(safeRowUrl\)/);
});
