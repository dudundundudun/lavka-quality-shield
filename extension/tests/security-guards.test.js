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

test('background.js guards all onMessage commands with explicit sender checks', () => {
  const bg = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');
  const listenerStart = bg.indexOf('chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {');
  assert.notEqual(listenerStart, -1, 'onMessage.addListener not found');
  const listenerBlock = bg.slice(listenerStart);

  // Explicit checks for key sensitive and external-store commands
  const requiredLavkaOrPopup = [
    'LQS_GET_ACCOUNTS_VAULT',
    'LQS_CLEAR_AI_CACHE',
    'LQS_RESET_CIRCUIT_BREAKER',
    'LQS_SELECT_GEMINI_ACCOUNT',
    'LQS_AUTO_CONNECT_GEMINI_TAB',
  ];
  for (const cmd of requiredLavkaOrPopup) {
    const re = new RegExp(`msg\\.type === '${cmd}'\\)[\\s\\S]{0,160}isTrustedLavkaOrPopupSender\\(sender\\)`);
    assert.match(listenerBlock, re, `${cmd} must be guarded by isTrustedLavkaOrPopupSender(sender)`);
  }

  assert.match(
    listenerBlock,
    /msg\.type === 'LQS_RECORD_EXTERNAL_STORE_OFFERS'\)[\s\S]{0,160}isTrustedExternalStoreSender\(sender\)/,
    'LQS_RECORD_EXTERNAL_STORE_OFFERS must be guarded by isTrustedExternalStoreSender(sender)'
  );
  assert.match(bg, /function isTrustedMagnitSender\(sender\)/);
  assert.match(bg, /parsed\.hostname === 'magnit\.ru' \|\| parsed\.hostname\.endsWith\('\.magnit\.ru'\)/);

  // Ensure every LQS_* command in onMessage has a sender guard
  const handlerMatches = [...listenerBlock.matchAll(/if\s*\(msg\.type === '(LQS_[A-Z0-9_]+)'\)\s*\{/g)];
  assert.ok(handlerMatches.length >= 20, 'Expected at least 20 message handlers in onMessage');
  for (const m of handlerMatches) {
    const cmd = m[1];
    const snippet = listenerBlock.slice(m.index, m.index + 200);
    assert.match(
      snippet,
      /if\s*\(!is(?:Popup|TrustedLavkaOrPopup|PassportOrPopup|TrustedExternalStore)Sender\(sender\)\)/,
      `Handler ${cmd} is missing a sender guard`
    );
  }
});

test('popup.html masks AI API key input and diagnostics/flight log redact secrets', () => {
  const popupHtml = fs.readFileSync(path.join(extDir, 'popup.html'), 'utf8');
  const popupJs = fs.readFileSync(path.join(extDir, 'popup.js'), 'utf8');
  const contentJs = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8');

  assert.match(popupHtml, /<input\b[^>]*type="password"[^>]*id="inp-ai-key"/);
  assert.match(popupJs, /function sanitizeDiagnosticsText\(text,\s*aiApiKey/);
  assert.match(popupJs, /sanitizeDiagnosticsText\(/);
  assert.match(contentJs, /redactSecrets\(text\)/);
  assert.doesNotMatch(contentJs, /LQS_RECORDER\.record\([^)]*aiApiKey/);
});

test('content.js validates competitor href URLs with safeHttpUrl', () => {
  const content = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8');
  assert.match(content, /function safeHttpUrl\(url\)/);
  assert.match(content, /escapeHtml\(safeHttpUrl\(o\.url\)\)/);
  assert.match(content, /escapeHtml\(safeRowUrl\)/);
});
