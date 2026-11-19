/**
 * Lavka Quality Shield — Accounts Vault & Cookie Switcher
 * Модуль сейфа аккаунтов, куки-сессий, автозаполнения Яндекс Паспорта и 1-клик переключения.
 */
(function (root) {
  'use strict';

  const { STORAGE_KEYS } = root.LQS_CONFIG;
  const { fetchWithTimeout, getSettings, saveSettingsPatch } = root.LQS_UTILS;

  const ACCOUNTS_VAULT_KEY = STORAGE_KEYS.ACCOUNTS_VAULT;
  const DELETED_ACCOUNTS_KEY = STORAGE_KEYS.DELETED_ACCOUNTS;

  const DEFAULT_ACCOUNT_PROFILES = [
    {
      accountId: 'acc_1',
      label: 'Аккаунт #1 (Основной)',
      login: '',
      note: '',
      yandexLogin: '',
      hasPassword: false,
      cookieCount: 0,
      updatedAt: null
    },
    {
      accountId: 'acc_2',
      label: 'Аккаунт #2 (Скидка)',
      login: '',
      note: '',
      yandexLogin: '',
      hasPassword: false,
      cookieCount: 0,
      updatedAt: null
    },
    {
      accountId: 'acc_3',
      label: 'Аккаунт #3 (Запасной)',
      login: '',
      note: '',
      yandexLogin: '',
      hasPassword: false,
      cookieCount: 0,
      updatedAt: null
    }
  ];

  function sanitizeAccountForLocalStorage(acc) {
    if (!acc || typeof acc !== 'object') return null;
    return {
      accountId: String(acc.accountId || ''),
      label: String(acc.label || ''),
      login: String(acc.login || ''),
      note: String(acc.note || ''),
      yandexLogin: String(acc.yandexLogin || ''),
      hasPassword: Boolean(acc.hasPassword || acc.password),
      cookieCount: Array.isArray(acc.cookies) ? acc.cookies.length : Number(acc.cookieCount || 0),
      updatedAt: acc.updatedAt || null
    };
  }

  async function fetchBackendVaultAccounts(backendUrl) {
    const cleanUrl = (backendUrl || '').replace(/\/$/, '');
    if (!cleanUrl || Date.now() < backendOfflineUntilTs) return null;
    try {
      const headers = await getBackendAuthHeaders(cleanUrl);
      const r = await fetchWithTimeout(`${cleanUrl}/api/accounts/list`, { method: 'GET', headers }, 1500);
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.accounts)) return j.accounts;
      }
    } catch {
      backendOfflineUntilTs = Date.now() + 10000;
    }
    return null;
  }

  async function fetchBackendAccountSecrets(backendUrl, accountId) {
    const cleanUrl = (backendUrl || '').replace(/\/$/, '');
    if (!cleanUrl || !accountId || Date.now() < backendOfflineUntilTs) return null;
    try {
      const headers = await getBackendAuthHeaders(cleanUrl);
      const r = await fetchWithTimeout(
        `${cleanUrl}/api/accounts/${encodeURIComponent(accountId)}/secrets`,
        { method: 'GET', headers },
        1500
      );
      if (r.ok) {
        const j = await r.json();
        if (j && j.status === 'ok') {
          return {
            accountId: j.accountId || accountId,
            password: j.password || '',
            cookies: Array.isArray(j.cookies) ? j.cookies : [],
            localStorageData: j.localStorageData && typeof j.localStorageData === 'object' ? j.localStorageData : {}
          };
        }
      }
    } catch {
      backendOfflineUntilTs = Date.now() + 10000;
    }
    return null;
  }

  // ============================================================================
  // 2. МЕНЕДЖЕР АККАУНТОВ ЛАВКИ (КУКИ-СЕССИИ + ЛОГИНЫ/ПАРОЛИ + 1-КЛИК СВИТЧЕР)
  // ============================================================================
  async function getDeletedAccountIdsSet() {
    return new Promise((resolve) => {
      chrome.storage.local.get([DELETED_ACCOUNTS_KEY], (res) => {
        const arr = res && Array.isArray(res[DELETED_ACCOUNTS_KEY]) ? res[DELETED_ACCOUNTS_KEY] : [];
        resolve(new Set(arr));
      });
    });
  }

  async function markAccountIdDeleted(accountId, isDeleted = true) {
    const set = await getDeletedAccountIdsSet();
    if (isDeleted) set.add(accountId);
    else set.delete(accountId);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [DELETED_ACCOUNTS_KEY]: Array.from(set) }, resolve);
    });
  }

  async function getAccountsVaultMap() {
    const localMap = await new Promise((resolve) => {
      chrome.storage.local.get([ACCOUNTS_VAULT_KEY], (res) => {
        resolve(res && res[ACCOUNTS_VAULT_KEY] && typeof res[ACCOUNTS_VAULT_KEY] === 'object' ? res[ACCOUNTS_VAULT_KEY] : null);
      });
    });

    const map = {};
    let needsScrubWrite = false;
    if (localMap) {
      for (const [k, raw] of Object.entries(localMap)) {
        if (!raw || typeof raw !== 'object') continue;
        if ('password' in raw || 'cookies' in raw || 'localStorageData' in raw) {
          needsScrubWrite = true;
        }
        const clean = sanitizeAccountForLocalStorage(raw);
        if (clean && clean.accountId) map[k] = clean;
      }
    }

    if (Object.keys(map).length === 0) {
      DEFAULT_ACCOUNT_PROFILES.forEach((p) => {
        map[p.accountId] = { ...p };
      });
      needsScrubWrite = true;
    }

    if (needsScrubWrite) {
      await new Promise((r) => chrome.storage.local.set({ [ACCOUNTS_VAULT_KEY]: map }, r));
    }
    return map;
  }

  async function saveAccountsVaultMap(map) {
    const sanitized = {};
    for (const [k, v] of Object.entries(map || {})) {
      const clean = sanitizeAccountForLocalStorage(v);
      if (clean && clean.accountId) sanitized[k] = clean;
    }
    return new Promise((resolve) => {
      chrome.storage.local.set({ [ACCOUNTS_VAULT_KEY]: sanitized }, () => resolve(sanitized));
    });
  }

  async function captureCurrentYandexCookies() {
    const allCookies = [];
    const seen = new Set();

    const queries = [
      { domain: 'yandex.ru' },
      { url: 'https://lavka.yandex.ru/' },
      { url: 'https://passport.yandex.ru/' },
      { url: 'https://id.yandex.ru/' }
    ];

    for (const q of queries) {
      try {
        const list = await chrome.cookies.getAll(q);
        for (const c of list || []) {
          if (!c || !c.name) continue;
          const key = `${c.name}|${c.domain}|${c.path}|${c.storeId || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          allCookies.push({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            secure: Boolean(c.secure),
            httpOnly: Boolean(c.httpOnly),
            sameSite: c.sameSite || 'unspecified',
            expirationDate: c.expirationDate || null,
            hostOnly: Boolean(c.hostOnly)
          });
        }
      } catch {
        // ignore
      }
    }

    let yandexLogin = '';
    const loginCookie = allCookies.find((c) => c.name === 'yandex_login' && c.value);
    if (loginCookie) {
      try {
        yandexLogin = decodeURIComponent(loginCookie.value);
      } catch {
        yandexLogin = loginCookie.value;
      }
    }
    const hasSessionId = allCookies.some((c) => (c.name === 'Session_id' || c.name === 'sessionid2') && c.value);

    let localStorageData = {};
    try {
      const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
      if (lavkaTabs && lavkaTabs.length > 0 && lavkaTabs[0].id) {
        const res = await chrome.scripting.executeScript({
          target: { tabId: lavkaTabs[0].id },
          func: () => {
            const captured = {};
            try {
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && /address|location|cart|user|zone|region|auth/i.test(k)) {
                  const v = localStorage.getItem(k);
                  if (v && v.length < 4000) captured[k] = v;
                }
              }
            } catch {
              // ignore
            }
            return captured;
          }
        });
        if (res && res[0] && res[0].result) {
          localStorageData = res[0].result;
        }
      }
    } catch {
      // ignore
    }

    return {
      cookies: allCookies,
      cookieCount: allCookies.length,
      yandexLogin,
      isLoggedIn: Boolean(hasSessionId || yandexLogin),
      localStorageData
    };
  }

  async function clearLavkaTabLocalStorage(newLocalStorageData = null) {
    try {
      const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
      if (lavkaTabs && lavkaTabs.length > 0 && lavkaTabs[0].id) {
        await chrome.scripting.executeScript({
          target: { tabId: lavkaTabs[0].id },
          args: [newLocalStorageData || {}],
          func: (lsMap) => {
            try {
              const keysToRemove = [];
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && /address|location|cart|user|zone|region|auth/i.test(k)) {
                  keysToRemove.push(k);
                }
              }
              keysToRemove.forEach((k) => localStorage.removeItem(k));
              for (const [k, v] of Object.entries(lsMap || {})) {
                if (k && typeof v === 'string') {
                  localStorage.setItem(k, v);
                }
              }
            } catch {
              // ignore
            }
          }
        });
      }
    } catch {
      // ignore
    }
  }

  async function clearCurrentYandexAuthCookies() {
    const snap = await captureCurrentYandexCookies();
    for (const c of snap.cookies) {
      try {
        const cleanDomain = String(c.domain || 'lavka.yandex.ru').replace(/^\./, '');
        const proto = c.secure ? 'https://' : 'http://';
        const url = `${proto}${cleanDomain}${c.path || '/'}`;
        await chrome.cookies.remove({ url, name: c.name });
      } catch {
        // ignore
      }
    }
  }

  async function restoreAccountCookies(cookiesList, localStorageData = {}) {
    if (!Array.isArray(cookiesList) || cookiesList.length === 0) {
      return { restoredCount: 0 };
    }

    await clearCurrentYandexAuthCookies();

    let restoredCount = 0;
    const nowSec = Math.floor(Date.now() / 1000);

    for (const c of cookiesList) {
      if (!c || !c.name) continue;
      try {
        const cleanDomain = String(c.domain || 'lavka.yandex.ru').replace(/^\./, '');
        const isHostPrefix = c.name.startsWith('__Host-');
        const isSecurePrefix = c.name.startsWith('__Secure-') || isHostPrefix;
        const isSameSiteNone = c.sameSite === 'no_restriction';
        const secureFlag = Boolean(c.secure || isSecurePrefix || isSameSiteNone);
        const proto = secureFlag ? 'https://' : 'http://';
        const pathVal = isHostPrefix ? '/' : (c.path || '/');
        const url = `${proto}${cleanDomain}${pathVal}`;

        const details = {
          url,
          name: c.name,
          value: String(c.value ?? ''),
          path: pathVal,
          secure: secureFlag,
          httpOnly: Boolean(c.httpOnly)
        };

        if (!c.hostOnly && !isHostPrefix && c.domain) {
          details.domain = c.domain;
        }

        if (c.sameSite && ['no_restriction', 'lax', 'strict'].includes(c.sameSite)) {
          details.sameSite = c.sameSite;
        }

        if (c.expirationDate && c.expirationDate > nowSec + 60) {
          details.expirationDate = c.expirationDate;
        } else {
          details.expirationDate = nowSec + 30 * 86400;
        }

        await chrome.cookies.set(details);
        restoredCount += 1;
      } catch {
        // ignore
      }
    }

    await clearLavkaTabLocalStorage(localStorageData);

    return { restoredCount };
  }

  async function getAccountsVaultStatus() {
    const settings = await getSettings();
    const map = await getAccountsVaultMap();
    const deletedSet = await getDeletedAccountIdsSet();

    const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
    const srvAccounts = await fetchBackendVaultAccounts(backendUrl);
    if (Array.isArray(srvAccounts)) {
      let changed = false;
      for (const srvAcc of srvAccounts) {
        if (!srvAcc || !srvAcc.accountId) continue;
        if (deletedSet.has(srvAcc.accountId)) continue;
        const loc = map[srvAcc.accountId];
        const srvTime = String(srvAcc.updatedAt || '');
        const locTime = String(loc?.updatedAt || '');
        const srvMeta = sanitizeAccountForLocalStorage(srvAcc);
        if (!loc || srvTime >= locTime) {
          map[srvAcc.accountId] = { ...(loc || {}), ...srvMeta };
          changed = true;
        }
      }
      if (changed) await saveAccountsVaultMap(map);
    }

    const liveSession = await captureCurrentYandexCookies();
    const accountsList = Object.values(map).sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)));

    return {
      ok: true,
      activeAccountLabel: settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)',
      liveSession: {
        isLoggedIn: liveSession.isLoggedIn,
        yandexLogin: liveSession.yandexLogin,
        cookieCount: liveSession.cookieCount
      },
      accounts: accountsList.map((a) => ({
        accountId: a.accountId,
        label: a.label,
        login: a.login || '',
        hasPassword: Boolean(a.hasPassword),
        note: a.note || '',
        yandexLogin: a.yandexLogin || '',
        cookieCount: Number(a.cookieCount || 0),
        updatedAt: a.updatedAt || null
      }))
    };
  }

  async function saveAccountToVault(payload = {}) {
    const settings = await getSettings();
    const map = await getAccountsVaultMap();
    const nowIso = new Date().toISOString();

    let accountId = payload.accountId || '';
    const label = (payload.label || settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)').trim();

    if (!accountId) {
      const existingByLabel = Object.values(map).find((a) => a.label === label);
      accountId = existingByLabel ? existingByLabel.accountId : `acc_${Date.now()}`;
    }

    await markAccountIdDeleted(accountId, false);

    const existing = map[accountId] || {
      accountId,
      label,
      login: '',
      note: '',
      yandexLogin: '',
      hasPassword: false,
      cookieCount: 0,
      updatedAt: nowIso
    };

    let capturedCookies = null;
    let capturedLs = null;
    let yandexLogin = existing.yandexLogin || '';

    if (payload.captureCookies !== false) {
      const captured = await captureCurrentYandexCookies();
      if (captured.cookies.length > 0) {
        capturedCookies = captured.cookies;
        capturedLs = captured.localStorageData || {};
        if (captured.yandexLogin) yandexLogin = captured.yandexLogin;
      }
    }

    const hasNewPassword = payload.password !== undefined && String(payload.password).length > 0;
    const wantsSecretSave = hasNewPassword || (capturedCookies && capturedCookies.length > 0);

    const backendPayload = {
      accountId,
      label: label || existing.label,
      login: payload.login !== undefined ? String(payload.login).trim() : (existing.login || yandexLogin || ''),
      note: payload.note !== undefined ? String(payload.note).trim() : (existing.note || ''),
      yandexLogin,
      updatedAt: nowIso
    };
    if (hasNewPassword) backendPayload.password = String(payload.password);
    if (capturedCookies) {
      backendPayload.cookies = capturedCookies;
      backendPayload.cookieCount = capturedCookies.length;
      backendPayload.localStorageData = capturedLs || {};
    }

    const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
    let backendSaved = false;
    if (backendUrl && Date.now() > backendOfflineUntilTs) {
      try {
        const headers = await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' });
        const r = await fetchWithTimeout(
          `${backendUrl}/api/accounts/save`,
          { method: 'POST', headers, body: JSON.stringify(backendPayload) },
          2000
        );
        backendSaved = r.ok;
      } catch {
        backendOfflineUntilTs = Date.now() + 10000;
      }
    }

    const localMeta = sanitizeAccountForLocalStorage({
      ...existing,
      ...backendPayload,
      hasPassword: backendSaved ? (hasNewPassword || Boolean(existing.hasPassword)) : Boolean(existing.hasPassword),
      cookieCount: backendSaved && capturedCookies ? capturedCookies.length : Number(existing.cookieCount || 0)
    });

    map[accountId] = localMeta;
    await saveAccountsVaultMap(map);
    await saveSettingsPatch({ lavkaAccountLabel: localMeta.label });

    if (wantsSecretSave && !backendSaved) {
      return {
        ok: false,
        error: 'Локальный сервер (:8765) недоступен — метаданные обновлены, но пароли и куки сохраняются только в зашифрованном DPAPI-сейфе сервера.',
        account: localMeta,
        vaultStatus: await getAccountsVaultStatus()
      };
    }

    return {
      ok: true,
      account: localMeta,
      vaultStatus: await getAccountsVaultStatus()
    };
  }

  async function deleteAccountFromVault(accountId) {
    const settings = await getSettings();
    const map = await getAccountsVaultMap();
    await markAccountIdDeleted(accountId, true);
    if (map[accountId]) {
      delete map[accountId];
      await saveAccountsVaultMap(map);
    }
    const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
    if (backendUrl && Date.now() > backendOfflineUntilTs) {
      try {
        const headers = await getBackendAuthHeaders(backendUrl);
        await fetchWithTimeout(
          `${backendUrl}/api/accounts/${encodeURIComponent(accountId)}`,
          { method: 'DELETE', headers },
          1500
        );
      } catch {
        backendOfflineUntilTs = Date.now() + 10000;
      }
    }
    return await getAccountsVaultStatus();
  }

  async function autofillYandexPassportTab(accountId) {
    const settings = await getSettings();
    const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
    const map = await getAccountsVaultMap();
    let metaAcc = map[accountId] || Object.values(map).find((a) => a.label === accountId);
    if (!metaAcc) {
      const srvAccounts = await fetchBackendVaultAccounts(backendUrl);
      if (Array.isArray(srvAccounts)) {
        metaAcc = srvAccounts.find((a) => a.accountId === accountId || a.label === accountId) || null;
      }
    }
    const targetAccountId = metaAcc?.accountId || accountId;
    const secrets = await fetchBackendAccountSecrets(backendUrl, targetAccountId);
    const acc = secrets ? { ...(metaAcc || {}), ...secrets } : metaAcc;
    if (!acc || (!acc.login && !acc.password)) {
      const hint = !secrets ? ' Убедись, что локальный сервер (:8765) запущен.' : '';
      return { ok: false, error: `Для этого профиля ещё не указаны логин и пароль.${hint}` };
    }

    await saveSettingsPatch({ lavkaAccountLabel: acc.label });

    const passportTabs = await chrome.tabs.query({
      url: ['https://passport.yandex.ru/*', 'https://id.yandex.ru/*']
    });

    let targetTab = passportTabs && passportTabs.length > 0 ? passportTabs[0] : null;
    if (!targetTab) {
      targetTab = await chrome.tabs.create({
        url: 'https://passport.yandex.ru/auth?retpath=https%3A%2F%2Flavka.yandex.ru%2F',
        active: true
      });
      await waitForTabCompleteSafe(targetTab.id, 5500);
    } else {
      await chrome.tabs.update(targetTab.id, { active: true });
    }

    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        args: [acc.login || '', acc.password || ''],
        func: async (loginVal, passVal) => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const setReactInputValue = (el, val) => {
            if (!el) return false;
            el.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) {
              setter.call(el, val);
            } else {
              el.value = val;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          };

          let filledLogin = false;
          let filledPassword = false;

          if (loginVal) {
            const loginInput =
              document.querySelector('input[name="login"]') ||
              document.querySelector('input#passp-field-login') ||
              document.querySelector('input#passp-field-phone') ||
              document.querySelector('input[autocomplete="username"]') ||
              document.querySelector('input[type="text"], input[type="tel"], input[type="email"]');

            if (loginInput) {
              filledLogin = setReactInputValue(loginInput, loginVal);
              await wait(250);
              const submitBtn =
                document.querySelector('button[id="passp:sign-in"]') ||
                document.querySelector('button[type="submit"]');
              if (submitBtn && passVal) {
                submitBtn.click();
                await wait(900);
              }
            }
          }

          if (passVal) {
            for (let i = 0; i < 8; i++) {
              const passInput =
                document.querySelector('input[name="passwd"]') ||
                document.querySelector('input#passp-field-passwd') ||
                document.querySelector('input[type="password"]');
              if (passInput) {
                filledPassword = setReactInputValue(passInput, passVal);
                break;
              }
              await wait(300);
            }
          }

          return { ok: Boolean(filledLogin || filledPassword), filledLogin, filledPassword };
        }
      });
      const r = res && res[0] ? res[0].result : null;
      return {
        ok: true,
        filledLogin: r?.filledLogin || false,
        filledPassword: r?.filledPassword || false,
        label: acc.label
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  async function switchLavkaAccountInOneClick(options = {}) {
    const { accountId, label, autoBackupCurrent = true, buildCartAfterSwitch = false } = options;
    const settings = await getSettings();
    const map = await getAccountsVaultMap();

    const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
    if (autoBackupCurrent) {
      const currentLive = await captureCurrentYandexCookies();
      if (currentLive.isLoggedIn && currentLive.cookies.length > 0) {
        const curLabel = settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)';
        const curEntry = Object.values(map).find(
          (a) => a.label === curLabel || (currentLive.yandexLogin && a.yandexLogin === currentLive.yandexLogin)
        );
        if (curEntry) {
          const nowIso = new Date().toISOString();
          if (backendUrl && Date.now() > backendOfflineUntilTs) {
            try {
              const headers = await getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' });
              await fetchWithTimeout(
                `${backendUrl}/api/accounts/save`,
                {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({
                    accountId: curEntry.accountId,
                    label: curEntry.label,
                    login: curEntry.login || '',
                    note: curEntry.note || '',
                    yandexLogin: currentLive.yandexLogin || curEntry.yandexLogin || '',
                    cookieCount: currentLive.cookies.length,
                    cookies: currentLive.cookies,
                    localStorageData: currentLive.localStorageData || {},
                    updatedAt: nowIso
                  })
                },
                2000
              );
            } catch {
              backendOfflineUntilTs = Date.now() + 10000;
            }
          }
          curEntry.cookieCount = currentLive.cookies.length;
          if (currentLive.yandexLogin) curEntry.yandexLogin = currentLive.yandexLogin;
          curEntry.updatedAt = nowIso;
          map[curEntry.accountId] = sanitizeAccountForLocalStorage(curEntry);
          await saveAccountsVaultMap(map);
        }
      }
    }

    let targetMeta =
      (accountId && map[accountId]) ||
      Object.values(map).find((a) => a.label === label || a.accountId === accountId);
    if (!targetMeta) {
      const srvAccounts = await fetchBackendVaultAccounts(backendUrl);
      if (Array.isArray(srvAccounts)) {
        targetMeta = srvAccounts.find((a) => a.accountId === accountId || (label && a.label === label)) || null;
      }
    }
    const targetSecrets = targetMeta
      ? await fetchBackendAccountSecrets(backendUrl, targetMeta.accountId)
      : null;
    const targetAcc = targetSecrets ? { ...targetMeta, ...targetSecrets } : targetMeta;

    if (!targetAcc) {
      if (label) {
        await saveSettingsPatch({ lavkaAccountLabel: label });
      }
      return {
        ok: false,
        error: 'Профиль не найден в сейфе аккаунтов.',
        vaultStatus: await getAccountsVaultStatus()
      };
    }

    await saveSettingsPatch({ lavkaAccountLabel: targetAcc.label });

    let switchedCookies = false;
    let restoredCount = 0;

    if (Array.isArray(targetAcc.cookies) && targetAcc.cookies.length > 0) {
      const restoreRes = await restoreAccountCookies(targetAcc.cookies, targetAcc.localStorageData || {});
      restoredCount = restoreRes.restoredCount;
      switchedCookies = restoredCount > 0;
    } else {
      await clearCurrentYandexAuthCookies();
      await clearLavkaTabLocalStorage({});
    }

    const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
    if (lavkaTabs && lavkaTabs.length > 0 && lavkaTabs[0].id) {
      if (buildCartAfterSwitch) {
        await chrome.tabs.update(lavkaTabs[0].id, { active: true });
      } else {
        await chrome.tabs.reload(lavkaTabs[0].id);
      }
    }

    let autoBuildResult = null;
    if (buildCartAfterSwitch) {
      await new Promise((r) => setTimeout(r, 900));
      autoBuildResult = await autoBuildCartInBrowser(null);
    }

    let autofillTriggered = false;
    if (!switchedCookies && (targetAcc.login || targetAcc.password)) {
      await autofillYandexPassportTab(targetAcc.accountId);
      autofillTriggered = true;
    }

    return {
      ok: true,
      switchedTo: targetAcc.label,
      switchedCookies,
      restoredCount,
      autofillTriggered,
      autoBuildResult,
      vaultStatus: await getAccountsVaultStatus()
    };
  }

  async function logoutToCleanLavkaSession() {
    const settings = await getSettings();
    await saveAccountToVault({
      label: settings.lavkaAccountLabel || 'Аккаунт #1 (Основной)',
      captureCookies: true
    });
    await clearCurrentYandexAuthCookies();
    await clearLavkaTabLocalStorage({});

    const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
    if (lavkaTabs && lavkaTabs.length > 0 && lavkaTabs[0].id) {
      await chrome.tabs.reload(lavkaTabs[0].id);
    }

    return {
      ok: true,
      vaultStatus: await getAccountsVaultStatus()
    };
  }

  const api = {
    DEFAULT_ACCOUNT_PROFILES,
    sanitizeAccountForLocalStorage,
    fetchBackendVaultAccounts,
    fetchBackendAccountSecrets,
    getDeletedAccountIdsSet,
    markAccountIdDeleted,
    getAccountsVaultMap,
    saveAccountsVaultMap,
    captureCurrentYandexCookies,
    clearLavkaTabLocalStorage,
    clearCurrentYandexAuthCookies,
    restoreAccountCookies,
    getAccountsVaultStatus,
    saveAccountToVault,
    deleteAccountFromVault,
    autofillYandexPassportTab,
    switchLavkaAccountInOneClick,
    logoutToCleanLavkaSession
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_ACCOUNTS_VAULT = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
