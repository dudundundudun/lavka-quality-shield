/**
 * Lavka Quality Shield — Gemini Tab & Google Cookies Manager
 * Модуль работы с вкладкой Gemini, куками Google, автопрогревом и очередью выполнения промптов.
 */
(function (root) {
  'use strict';

  function getBgDeps() {
    return root.LQS_BG_DEPS || {};
  }

  const { fetchWithTimeout, getSettings } = root.LQS_UTILS;
  const GEMINI_IDLE_ALARM_NAME = 'lqs_gemini_idle_close';
  const GEMINI_STEALTH_SESSION_KEY =
    (root.LQS_CONFIG && root.LQS_CONFIG.STORAGE_KEYS && root.LQS_CONFIG.STORAGE_KEYS.GEMINI_STEALTH_SESSION) ||
    'lqs_gemini_stealth_session_v1';

  let geminiTabMutex = Promise.resolve();
  let lastWarmupCheckTs = 0;
  let isWarmingUp = false;

  function normalizeGeminiTabMode(mode) {
    const clean = String(mode || '').trim().toLowerCase();
    if (clean === 'on_demand_tab' || clean === 'keep_open' || clean === 'stealth_window') {
      return clean;
    }
    return 'stealth_window';
  }

  function getGeminiIdleCloseMinutes(settings = {}) {
    const val = Number(settings && settings.geminiIdleCloseMinutes);
    if (Number.isFinite(val) && val >= 1 && val <= 60) {
      return Math.round(val);
    }
    return 5;
  }

  async function getManagedGeminiSession() {
    return new Promise((resolve) => {
      if (!chrome.storage || !chrome.storage.local) return resolve(null);
      chrome.storage.local.get([GEMINI_STEALTH_SESSION_KEY], (res) => {
        const s = res && res[GEMINI_STEALTH_SESSION_KEY];
        resolve(s && typeof s === 'object' && (s.tabId || s.windowId) ? s : null);
      });
    });
  }

  async function saveManagedGeminiSession(session) {
    return new Promise((resolve) => {
      if (!chrome.storage || !chrome.storage.local) return resolve(session);
      chrome.storage.local.set({ [GEMINI_STEALTH_SESSION_KEY]: session }, () => resolve(session));
    });
  }

  async function clearManagedGeminiSession() {
    return new Promise((resolve) => {
      if (!chrome.storage || !chrome.storage.local) return resolve();
      chrome.storage.local.remove([GEMINI_STEALTH_SESSION_KEY], () => resolve());
    });
  }

  async function cancelGeminiIdleCloseTimer() {
    try {
      if (chrome.alarms && typeof chrome.alarms.clear === 'function') {
        await chrome.alarms.clear(GEMINI_IDLE_ALARM_NAME);
      }
    } catch {
      // ignore
    }
  }

  async function scheduleGeminiIdleCloseTimer(settingsOverride = null) {
    const settings = settingsOverride || (await getSettings());
    const mode = normalizeGeminiTabMode(settings.geminiTabMode);
    if (mode === 'keep_open') {
      await cancelGeminiIdleCloseTimer();
      return { scheduled: false, mode };
    }
    const managed = await getManagedGeminiSession();
    if (!managed) {
      return { scheduled: false, mode };
    }
    const delayInMinutes = getGeminiIdleCloseMinutes(settings);
    try {
      if (chrome.alarms && typeof chrome.alarms.create === 'function') {
        chrome.alarms.create(GEMINI_IDLE_ALARM_NAME, { delayInMinutes });
        return { scheduled: true, mode, delayInMinutes };
      }
    } catch {
      // ignore
    }
    return { scheduled: false, mode };
  }

  async function closeManagedGeminiSession(reason = 'idle') {
    await cancelGeminiIdleCloseTimer();
    const managed = await getManagedGeminiSession();
    if (!managed) {
      return { closed: false, reason };
    }
    await clearManagedGeminiSession();
    let closed = false;
    try {
      if (managed.mode === 'stealth_window' && managed.windowId && chrome.windows && typeof chrome.windows.remove === 'function') {
        await chrome.windows.remove(managed.windowId);
        closed = true;
      } else if (managed.tabId && chrome.tabs && typeof chrome.tabs.remove === 'function') {
        await chrome.tabs.remove(managed.tabId);
        closed = true;
      }
    } catch {
      if (!closed && managed.tabId && chrome.tabs && typeof chrome.tabs.remove === 'function') {
        try {
          await chrome.tabs.remove(managed.tabId);
          closed = true;
        } catch {
          // already closed by user
        }
      }
    }
    return { closed, mode: managed.mode, tabId: managed.tabId || null, windowId: managed.windowId || null, reason };
  }

  function isGeminiLoginRequired(tab, cookies = null) {
    if (cookies && cookies.ok === false) return true;
    const url = String((tab && tab.url) || '').toLowerCase();
    if (url.includes('accounts.google.com') || url.includes('/servicelogin') || url.includes('/signin')) {
      return true;
    }
    return false;
  }

  async function inspectGeminiCookies() {
    try {
      const cookiesGemini = await chrome.cookies.getAll({ url: 'https://gemini.google.com/' });
      const cookiesGoogle = await chrome.cookies.getAll({ domain: 'google.com' });

      const map = new Map();
      [...cookiesGoogle, ...cookiesGemini].forEach((c) => {
        if (c && c.name && c.value) {
          map.set(c.name, c.value);
        }
      });

      const hasSession = map.has('__Secure-1PSID') || map.has('SID') || map.size > 3;
      const headerString = Array.from(map.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

      return {
        ok: hasSession,
        cookiesCount: map.size,
        hasSecure1PSID: map.has('__Secure-1PSID'),
        headerString
      };
    } catch (err) {
      return {
        ok: false,
        cookiesCount: 0,
        error: err.message || String(err),
        headerString: ''
      };
    }
  }

  async function detectTabAccountEmail(tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          try {
            const accNodes = document.querySelectorAll('a[aria-label*="@"], button[aria-label*="@"], img[alt*="@"]');
            for (const el of accNodes) {
              const label = el.getAttribute('aria-label') || el.getAttribute('alt') || '';
              const m = label.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
              if (m) return m[1];
            }
            const html = document.documentElement.innerHTML;
            const mEmail = html.match(/"([a-zA-Z0-9._%+-]+@(?:gmail\.com|googlemail\.com|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))"/);
            if (mEmail) return mEmail[1];
          } catch {
            // ignore
          }
          return null;
        }
      });
      return results && results[0] ? results[0].result : null;
    } catch {
      return null;
    }
  }

  function extractAccountIndexFromUrl(url) {
    if (!url) return '0';
    const m = String(url).match(/\/u\/(\d+)\b/);
    return m ? m[1] : '0';
  }

  function buildGeminiUrlForAccount(accountIndex) {
    if (accountIndex === undefined || accountIndex === null || accountIndex === 'auto' || accountIndex === '') {
      return 'https://gemini.google.com/app';
    }
    return `https://gemini.google.com/u/${accountIndex}/app`;
  }

  async function listOpenGeminiTabsWithAccounts() {
    const tabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*'] });
    const enriched = [];
    for (const t of tabs || []) {
      const accIdx = extractAccountIndexFromUrl(t.url);
      const email = t.id ? await detectTabAccountEmail(t.id) : null;
      enriched.push({
        tabId: t.id,
        url: t.url,
        title: t.title || 'Google Gemini',
        accountIndex: accIdx,
        email: email || null,
        active: Boolean(t.active),
        pinned: Boolean(t.pinned)
      });
    }
    return enriched;
  }

  async function findOpenGeminiTab(autoCreateIfMissing = false, makeActive = false) {
    const settings = await getSettings();
    const targetIdx = String(settings.geminiAccountIndex ?? 'auto');
    const preferredTabId = settings.preferredGeminiTabId ? Number(settings.preferredGeminiTabId) : null;

    if (autoCreateIfMissing) {
      await cancelGeminiIdleCloseTimer();
    }

    const tabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*'] });
    if (tabs && tabs.length > 0) {
      const managed = await getManagedGeminiSession();
      if (preferredTabId) {
        const exactTab = tabs.find((t) => t.id === preferredTabId);
        if (exactTab) {
          if (makeActive) await chrome.tabs.update(exactTab.id, { active: true });
          return exactTab;
        }
      }
      if (managed && managed.tabId) {
        const managedTab = tabs.find((t) => t.id === managed.tabId);
        if (managedTab && (targetIdx === 'auto' || extractAccountIndexFromUrl(managedTab.url) === targetIdx)) {
          if (makeActive) await chrome.tabs.update(managedTab.id, { active: true });
          return managedTab;
        }
      }
      if (targetIdx !== 'auto') {
        const matchingTab = tabs.find((t) => extractAccountIndexFromUrl(t.url) === targetIdx);
        if (matchingTab) {
          if (makeActive) await chrome.tabs.update(matchingTab.id, { active: true });
          return matchingTab;
        }
        if (autoCreateIfMissing) {
          return await createGeminiTab(buildGeminiUrlForAccount(targetIdx), makeActive);
        }
      }
      if (makeActive && tabs[0].id) {
        await chrome.tabs.update(tabs[0].id, { active: true });
      }
      return tabs[0];
    }

    if (!autoCreateIfMissing) {
      return null;
    }

    return await createGeminiTab(buildGeminiUrlForAccount(targetIdx), makeActive);
  }

  async function createGeminiTab(targetUrl, makeActive = false, modeOverride = null) {
    const settings = await getSettings();
    const mode = modeOverride ? normalizeGeminiTabMode(modeOverride) : normalizeGeminiTabMode(settings.geminiTabMode);

    if (makeActive) {
      const created = await chrome.tabs.create({
        url: targetUrl,
        active: true,
        pinned: false
      });
      await getBgDeps().waitForTabCompleteSafe(created.id, 6500);
      return created;
    }

    if (mode === 'stealth_window' && chrome.windows && typeof chrome.windows.create === 'function') {
      const win = await chrome.windows.create({
        url: targetUrl,
        state: 'minimized',
        focused: false
      });
      let createdTab = win && Array.isArray(win.tabs) && win.tabs[0] ? win.tabs[0] : null;
      if (!createdTab && win && win.id && chrome.tabs && typeof chrome.tabs.query === 'function') {
        const winTabs = await chrome.tabs.query({ windowId: win.id });
        createdTab = winTabs && winTabs[0] ? winTabs[0] : null;
      }
      if (createdTab && createdTab.id) {
        await saveManagedGeminiSession({
          tabId: createdTab.id,
          windowId: win ? win.id : null,
          mode: 'stealth_window',
          createdAt: Date.now()
        });
        await getBgDeps().waitForTabCompleteSafe(createdTab.id, 6500);
        return createdTab;
      }
    }

    if (mode === 'on_demand_tab') {
      const created = await chrome.tabs.create({
        url: targetUrl,
        active: false,
        pinned: false
      });
      await saveManagedGeminiSession({
        tabId: created.id,
        windowId: null,
        mode: 'on_demand_tab',
        createdAt: Date.now()
      });
      await getBgDeps().waitForTabCompleteSafe(created.id, 6500);
      return created;
    }

    // Режим keep_open: классическая фоновая закреплённая вкладка без автозакрытия
    const created = await chrome.tabs.create({
      url: targetUrl,
      active: false,
      pinned: true
    });
    await getBgDeps().waitForTabCompleteSafe(created.id, 6500);
    return created;
  }

  async function ensureAutopilotWarmup(reason = 'auto') {
    const now = Date.now();
    if (isWarmingUp || now - lastWarmupCheckTs < 15000) return;
    lastWarmupCheckTs = now;
    isWarmingUp = true;

    try {
      const settings = await getSettings();
      // По умолчанию автопрогрев выключен (v2.9.4), а при выборе любого API-провайдера gemini-tab вообще не трогаем
      if (settings.autoWarmupGeminiTab !== true) return;

      const aiProvider = String(settings.aiProvider || 'gemini_tab').trim().toLowerCase();
      if (aiProvider !== 'gemini_tab') return;

      // В режимах stealth_window и on_demand_tab окно/вкладка открываются строго по запросу
      if (normalizeGeminiTabMode(settings.geminiTabMode) !== 'keep_open') return;

      const existingTab = await findOpenGeminiTab(false, false);
      if (existingTab) return;

      const cookies = await inspectGeminiCookies();
      if (!cookies.ok) return;

      await findOpenGeminiTab(true, false);
      console.log(`[LQS Zero-Click Autopilot] Warmed up background Gemini tab (${reason})`);
    } catch {
      // ignore warmup errors
    } finally {
      isWarmingUp = false;
    }
  }

  /**
   * Надёжное выполнение промпта и чтение ответа из вкладки gemini.google.com (v2.6.0):
   * 1) Не держит один долгий executeScript внутри фоновой вкладки (где Chrome троттлит setTimeout до 1+ сек и может заморозить промис).
   * 2) Вместо .innerText (который в фоновых/скрытых вкладках с content-visibility:auto может возвращать пустую строку)
   *    использует собственный DOM-сериализатор на базе textContent с сохранением **жирного** текста и переносов строк.
   * 3) Если в открытой вкладке Gemini УЖЕ сгенерирован готовый ответ по этому товару (пользователь видит его во вкладке),
   *    мгновенно забирает его за 0.1 сек без повторного ожидания!
   */
  async function executePromptInsideGeminiTab(tabId, promptText, productTitle = '', forceRefresh = false) {
    const stopKeepAlive = getBgDeps().startSwKeepAlive ? getBgDeps().startSwKeepAlive() : () => {};
    const swWait = (ms) => new Promise((r) => setTimeout(r, ms));

    try {
      // ФАЗА 1: Быстрая проверка готового ответа во вкладке ИЛИ ввод промпта и клик «Отправить» (< 450 мс)
      const initResults = await chrome.scripting.executeScript({
        target: { tabId },
        args: [promptText, productTitle || '', Boolean(forceRefresh)],
        func: async (prompt, targetProdTitle, isForce) => {
          try {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));

            // Layout-независимый сериализатор ответа Gemini (работает на 100% даже в свёрнутой/фоновой вкладке!)
            const extractCleanFormattedText = (rootNode) => {
              if (!rootNode) return '';
              const walk = (node) => {
                if (!node) return '';
                if (node.nodeType === Node.TEXT_NODE) {
                  return node.nodeValue || '';
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return '';
                const tag = (node.tagName || '').toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'button' || tag === 'mat-icon') {
                  return '';
                }
                if (tag === 'br') return '\n';
                let inner = '';
                for (const child of node.childNodes) {
                  inner += walk(child);
                }
                if (tag === 'strong' || tag === 'b') {
                  const trimmed = inner.trim();
                  return trimmed ? `**${trimmed}**` : '';
                }
                if (tag === 'li') {
                  return `\n• ${inner.trim()}\n`;
                }
                if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'tr', 'blockquote'].includes(tag)) {
                  return `${inner}\n`;
                }
                return inner;
              };
              const raw = walk(rootNode) || rootNode.textContent || '';
              return raw
                .replace(/\r/g, '')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            };

            const getTopLevelResponseNodes = () => {
              const topModels = Array.from(document.querySelectorAll('model-response'));
              if (topModels.length > 0) {
                return topModels.map((m) => m.querySelector('message-content, .markdown, .model-response-text') || m);
              }
              const msgContents = Array.from(document.querySelectorAll('message-content'));
              if (msgContents.length > 0) return msgContents;
              return Array.from(document.querySelectorAll('.model-response-text, .markdown, [data-message-author-role="model"]'));
            };

            const findStopBtn = () =>
              document.querySelector(
                'button[aria-label*="Stop"], button[aria-label*="Остановить"], button[aria-label*="Прервать"], button.stop-button'
              );

            const isStillGenerating = () => {
              const stopBtn = findStopBtn();
              if (stopBtn && !stopBtn.disabled && stopBtn.getBoundingClientRect().width > 0) return true;
              const busyModels = document.querySelectorAll('model-response[aria-busy="true"], .response-streaming');
              return busyModels.length > 0;
            };

            const existingNodes = getTopLevelResponseNodes();
            const initialCount = existingNodes.length;
            const initialLastText = initialCount > 0 ? extractCleanFormattedText(existingNodes[initialCount - 1]) : '';

            // ПРОВЕРКА: Вдруг во вкладке Gemini УЖЕ лежит готовый ответ для этого товара?
            if (!isForce && initialLastText.length > 80 && !isStillGenerating()) {
              const pageTextLower = (document.body.textContent || '').toLowerCase().replace(/ё/g, 'е');
              const lastTextLower = initialLastText.toLowerCase().replace(/ё/g, 'е');
              const hasVerdictMarkers =
                lastTextLower.includes('вердикт') &&
                (lastTextLower.includes('отзывы') || lastTextLower.includes('состав'));

              if (hasVerdictMarkers && targetProdTitle) {
                const titleWords = String(targetProdTitle)
                  .toLowerCase()
                  .replace(/ё/g, 'е')
                  .match(/[а-яa-z0-9]{4,}/g) || [];
                const significantWords = titleWords.filter(
                  (w) => !['напиток', 'газированный', 'продукт', 'товар', 'купить'].includes(w)
                );
                // Проверяем последний запрос пользователя или сам последний ответ во вкладке
                const userPrompts = Array.from(document.querySelectorAll('user-query, .query-text, [data-message-author-role="user"]'));
                const lastUserPromptText = userPrompts.length > 0
                  ? (userPrompts[userPrompts.length - 1].textContent || '').toLowerCase().replace(/ё/g, 'е')
                  : pageTextLower.slice(-3500);

                const matchedInLastTurn = significantWords.length > 0 && significantWords.every(
                  (w) => lastUserPromptText.includes(w.slice(0, 5)) || lastTextLower.includes(w.slice(0, 5))
                );
                if (matchedInLastTurn) {
                  return {
                    ok: true,
                    alreadyReadyInTab: true,
                    mode: `Вкладка Gemini (${window.location.pathname})`,
                    text: initialLastText
                  };
                }
              }
            }

            const findEditor = () =>
              document.querySelector('rich-textarea div.ql-editor[contenteditable="true"]') ||
              document.querySelector('div[contenteditable="true"][role="textbox"]') ||
              document.querySelector('div[contenteditable="true"]') ||
              document.querySelector('textarea');

            let editor = findEditor();
            for (let waitTick = 0; !editor && waitTick < 12; waitTick++) {
              await wait(250);
              editor = findEditor();
            }

            if (!editor) {
              return {
                ok: false,
                error: 'На вкладке gemini.google.com не найдено поле ввода чата (убедись, что ты вошёл в аккаунт Google).'
              };
            }

            const activeStop = findStopBtn();
            if (activeStop && !activeStop.disabled && activeStop.getBoundingClientRect().width > 0) {
              activeStop.click();
              await wait(350);
            }

            const refreshedNodes = getTopLevelResponseNodes();
            const baselineCount = refreshedNodes.length;
            const baselineText = baselineCount > 0 ? extractCleanFormattedText(refreshedNodes[baselineCount - 1]) : '';

            const fillPromptIntoEditor = () => {
              editor.focus();
              if (editor.tagName === 'TEXTAREA') {
                editor.value = prompt;
                editor.dispatchEvent(new Event('input', { bubbles: true }));
              } else {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(editor);
                sel.removeAllRanges();
                sel.addRange(range);
                const inserted = document.execCommand('insertText', false, prompt);
                if (!inserted || !(editor.textContent || '').trim()) {
                  editor.textContent = prompt;
                  editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt }));
                }
              }
            };

            const triggerSend = () => {
              const sendBtn =
                document.querySelector('button.send-button') ||
                document.querySelector('button[aria-label*="Send"]') ||
                document.querySelector('button[aria-label*="Отправить"]') ||
                document.querySelector('.send-button-container button') ||
                document.querySelector('button.submit');

              if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
                return true;
              }
              editor.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
              );
              return false;
            };

            fillPromptIntoEditor();
            await wait(220);
            const clickedSend = triggerSend();

            return {
              ok: true,
              injected: true,
              clickedSend,
              baselineCount,
              baselineText,
              pathname: window.location.pathname
            };
          } catch (domErr) {
            return {
              ok: false,
              error: `Ошибка ввода в DOM вкладки Gemini: ${domErr.message || domErr}`
            };
          }
        }
      });

      const initRes = initResults && initResults[0] ? initResults[0].result : null;
      if (!initRes || !initRes.ok) {
        return initRes || { ok: false, error: 'Не удалось обратиться к вкладке Gemini.' };
      }

      // Если ответ уже лежал готовым во вкладке Gemini — возвращаем его мгновенно!
      if (initRes.alreadyReadyInTab && initRes.text) {
        return {
          ok: true,
          mode: initRes.mode || 'Вкладка Gemini (готовый ответ)',
          text: initRes.text
        };
      }

      const baselineCount = initRes.baselineCount || 0;
      const baselineText = initRes.baselineText || '';
      let lastText = '';
      let stableTicks = 0;
      let retriedSend = false;

      // ФАЗА 2: Опрос из Service Worker'а (не подвержен фоновому троттлингу вкладки!)
      for (let tick = 0; tick < 44; tick++) {
        await swWait(800);

        const pollResults = await chrome.scripting.executeScript({
          target: { tabId },
          args: [baselineCount, baselineText, promptText, tick === 4 && !retriedSend],
          func: (baseCnt, baseTxt, prompt, shouldRetrySendIfIdle) => {
            const extractCleanFormattedText = (rootNode) => {
              if (!rootNode) return '';
              const walk = (node) => {
                if (!node) return '';
                if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
                if (node.nodeType !== Node.ELEMENT_NODE) return '';
                const tag = (node.tagName || '').toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'button' || tag === 'mat-icon') {
                  return '';
                }
                if (tag === 'br') return '\n';
                let inner = '';
                for (const child of node.childNodes) {
                  inner += walk(child);
                }
                if (tag === 'strong' || tag === 'b') {
                  const trimmed = inner.trim();
                  return trimmed ? `**${trimmed}**` : '';
                }
                if (tag === 'li') {
                  return `\n• ${inner.trim()}\n`;
                }
                if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'tr', 'blockquote'].includes(tag)) {
                  return `${inner}\n`;
                }
                return inner;
              };
              const raw = walk(rootNode) || rootNode.textContent || '';
              return raw
                .replace(/\r/g, '')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            };

            const getTopLevelResponseNodes = () => {
              const topModels = Array.from(document.querySelectorAll('model-response'));
              if (topModels.length > 0) {
                return topModels.map((m) => m.querySelector('message-content, .markdown, .model-response-text') || m);
              }
              const msgContents = Array.from(document.querySelectorAll('message-content'));
              if (msgContents.length > 0) return msgContents;
              return Array.from(document.querySelectorAll('.model-response-text, .markdown, [data-message-author-role="model"]'));
            };

            const findStopBtn = () =>
              document.querySelector(
                'button[aria-label*="Stop"], button[aria-label*="Остановить"], button[aria-label*="Прервать"], button.stop-button'
              );

            const isStillGenerating = () => {
              const stopBtn = findStopBtn();
              if (stopBtn && !stopBtn.disabled && stopBtn.getBoundingClientRect().width > 0) return true;
              const busyModels = document.querySelectorAll('model-response[aria-busy="true"], .response-streaming');
              return busyModels.length > 0;
            };

            const nodes = getTopLevelResponseNodes();
            const currentCount = nodes.length;
            const latestNode = currentCount > 0 ? nodes[currentCount - 1] : null;
            const currentText = latestNode ? extractCleanFormattedText(latestNode) : '';
            const generating = isStillGenerating();
            const isNew = currentCount > baseCnt || (currentText && currentText !== baseTxt);

            let didRetrySend = false;
            if (shouldRetrySendIfIdle && !isNew && !generating) {
              const sendBtn =
                document.querySelector('button.send-button') ||
                document.querySelector('button[aria-label*="Send"]') ||
                document.querySelector('button[aria-label*="Отправить"]') ||
                document.querySelector('.send-button-container button');
              if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
                didRetrySend = true;
              }
            }

            return {
              currentCount,
              currentText,
              generating,
              isNew,
              didRetrySend,
              pathname: window.location.pathname
            };
          }
        });

        const poll = pollResults && pollResults[0] ? pollResults[0].result : null;
        if (!poll) continue;
        if (poll.didRetrySend) retriedSend = true;

        if (poll.isNew && poll.currentText && poll.currentText.length > 35) {
          const hasVerdictWord = /вердикт|стоит брать|хороший вариант|на любителя|не рекомендую/i.test(poll.currentText);
          if (poll.currentText === lastText && !poll.generating) {
            stableTicks += 1;
            if (stableTicks >= 2 || (stableTicks >= 1 && hasVerdictWord)) {
              return {
                ok: true,
                mode: `Вкладка Gemini (${poll.pathname || '/app'})`,
                text: poll.currentText
              };
            }
          } else {
            lastText = poll.currentText;
            stableTicks = (!poll.generating && hasVerdictWord && poll.currentText.length > 140) ? 1 : 0;
          }
        }
      }

      if (lastText && lastText.length > 35) {
        return {
          ok: true,
          mode: `Вкладка Gemini (${initRes.pathname || '/app'})`,
          text: lastText
        };
      }

      return {
        ok: false,
        error: 'Вкладка Gemini ещё генерирует ответ или ожидает вход в аккаунт (нажми «🤖 ИИ-обзор» или «🔄 Обновить» ещё раз, чтобы забрать готовый текст).'
      };
    } catch (err) {
      return {
        ok: false,
        error: `Ошибка доступа к вкладке Gemini: ${err.message || err}`
      };
    } finally {
      stopKeepAlive();
    }
  }

  function enqueueGeminiTabExecution(taskFn) {
    const next = geminiTabMutex.then(() => taskFn(), () => taskFn());
    geminiTabMutex = next.catch(() => {});
    return next;
  }

  const api = {
    GEMINI_IDLE_ALARM_NAME,
    normalizeGeminiTabMode,
    getGeminiIdleCloseMinutes,
    getManagedGeminiSession,
    saveManagedGeminiSession,
    clearManagedGeminiSession,
    scheduleGeminiIdleCloseTimer,
    cancelGeminiIdleCloseTimer,
    closeManagedGeminiSession,
    isGeminiLoginRequired,
    inspectGeminiCookies,
    detectTabAccountEmail,
    extractAccountIndexFromUrl,
    buildGeminiUrlForAccount,
    listOpenGeminiTabsWithAccounts,
    findOpenGeminiTab,
    createGeminiTab,
    ensureAutopilotWarmup,
    executePromptInsideGeminiTab,
    enqueueGeminiTabExecution
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_GEMINI_TAB = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
