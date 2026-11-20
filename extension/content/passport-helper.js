/**
 * Lavka Quality Shield — Yandex Passport Quick-Login Helper (content/passport-helper.js)
 * Renders quick profile autofill & vault save bar on passport.yandex.ru / id.yandex.ru.
 */
(function (root) {
  'use strict';

  const { escapeHtml } = root.LQS_UTILS;

  function initYandexPassportHelperIfNeeded() {
    const host = window.location.hostname.toLowerCase();
    if (!host.includes('passport.yandex.ru') && !host.includes('id.yandex.ru')) return false;

    if (document.querySelector('.lqs-passport-helper')) return true;

    chrome.runtime.sendMessage({ type: 'LQS_GET_ACCOUNTS_VAULT' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !Array.isArray(resp.accounts)) return;
      const box = document.createElement('div');
      box.className = 'lqs-passport-helper';

      const accWithCreds = resp.accounts;
      box.innerHTML = `
        <div style="font-weight:800;font-size:12.5px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
          <span>🔐 Lavka Quality Shield: Быстрый вход</span>
          <button type="button" id="lqs-pass-close" style="border:none;background:transparent;cursor:pointer;font-size:14px;">×</button>
        </div>
        <div style="font-size:11px;color:#57534e;margin-bottom:6px;">
          Выбери профиль для авто-ввода логина и пароля (или сохрани введённые данные в сейф):
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:6px;">
          ${accWithCreds
            .map(
              (a) => `
            <div style="display:flex;gap:4px;align-items:center;">
              <button type="button" class="lqs-pass-fill-btn" data-acc-id="${escapeHtml(a.accountId)}" style="flex:1;text-align:left;padding:5px 8px;border-radius:7px;border:1px solid #d6d3cd;background:#f5f4f2;cursor:pointer;font-size:11px;font-weight:600;">
                🔑 ${escapeHtml(a.label)} ${a.login ? `(${escapeHtml(a.login)})` : '(без пароля)'}
              </button>
            </div>
          `
            )
            .join('')}
        </div>
        <button type="button" id="lqs-pass-save-current" style="width:100%;padding:6px 8px;border-radius:7px;border:1px solid #ebd000;background:#fce000;font-weight:700;font-size:11px;cursor:pointer;">
          💾 Запомнить введённый логин/пароль в активный профиль
        </button>
        <div id="lqs-pass-msg" style="font-size:10.5px;color:#15803d;margin-top:4px;"></div>
      `;

      document.body.appendChild(box);

      box.querySelector('#lqs-pass-close').onclick = () => box.remove();

      box.querySelectorAll('.lqs-pass-fill-btn').forEach((btn) => {
        btn.onclick = () => {
          const accId = btn.getAttribute('data-acc-id');
          chrome.runtime.sendMessage({ type: 'LQS_AUTOFILL_YANDEX_LOGIN', accountId: accId }, (r) => {
            const msgEl = box.querySelector('#lqs-pass-msg');
            if (r && r.ok) {
              msgEl.textContent = `✅ Введены данные для «${r.label}»`;
            } else {
              msgEl.textContent = `⚠️ ${r?.error || 'Заполни логин/пароль для этого профиля в расширении'}`;
            }
          });
        };
      });

      box.querySelector('#lqs-pass-save-current').onclick = () => {
        const loginInp =
          document.querySelector('input[name="login"]') ||
          document.querySelector('input#passp-field-login') ||
          document.querySelector('input[type="text"], input[type="tel"], input[type="email"]');
        const passInp =
          document.querySelector('input[name="passwd"]') ||
          document.querySelector('input#passp-field-passwd') ||
          document.querySelector('input[type="password"]');

        const loginVal = loginInp ? loginInp.value.trim() : '';
        const passVal = passInp ? passInp.value : '';

        chrome.runtime.sendMessage(
          {
            type: 'LQS_SAVE_ACCOUNT_TO_VAULT',
            payload: {
              label: resp.activeAccountLabel || 'Аккаунт #1 (Основной)',
              login: loginVal || undefined,
              password: passVal || undefined,
              captureCookies: true
            }
          },
          () => {
            const msgEl = box.querySelector('#lqs-pass-msg');
            msgEl.textContent = `✅ Сохранено для «${resp.activeAccountLabel}»!`;
          }
        );
      };
    });

    return true;
  }

  const api = {
    initYandexPassportHelperIfNeeded
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_PASSPORT_HELPER = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
