/**
 * Lavka Quality Shield v2.2.0 — Background Service Worker (Автопилот подключения к Gemini)
 * Что делает этот модуль:
 * 1. Сам находит открытую вкладку https://gemini.google.com/* в браузере (или открывает её по запросу).
 * 2. Сам считывает куки авторизации Google/Gemini через chrome.cookies.getAll() и собирает готовый
 *    Header String (SID=...; __Secure-1PSID=...) без F12 и без стороннего Cookie-Editor!
 * 3. Выполняет запросы к ИИ в режиме полного автопилота (каскад из 4 уровней):
 *    - Уровень 1: Если запущен локальный FastAPI (:8765), сначала ищет реальные отзывы (Отзовик/IRecommend)
 *      и проверяет SQLite-кэш.
 *    - Уровень 2: Если настроен и отвечает мост Gemini Argon (:8083) или облачный API (DeepSeek/Ollama),
 *      запрашивает сводку через него.
 *    - Уровень 3 (ПРЯМОЙ АВТОПИЛОТ ЧЕРЕЗ ВКЛАДКУ GEMINI): Если :8083 не запущен или не настроен,
 *      фоновый воркер сам обращается к открытой вкладке https://gemini.google.com/*, берёт живой
 *      CSRF-токен (SNlM0e) и отправляет запрос напрямую через сессию браузера (RPC StreamGenerate,
 *      а при необходимости — через DOM-автоматизацию чата Gemini).
 *    - Уровень 4: Если сервер :8765 запущен (спарсил отзывы), а ответ сгенерировала вкладка Gemini —
 *      сохраняет готовый вердикт обратно в SQLite-кэш сервера :8765 (/api/save-cache)!
 */

'use strict';

const SETTINGS_KEY = 'lqs_settings_v2';
const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:8765',
  aiBaseUrl: 'http://localhost:8083/v1',
  aiApiKey: '',
  aiModel: 'gemini-4-argon',
  preferBrowserGeminiTab: true
};

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY], (res) => {
      resolve({ ...DEFAULT_SETTINGS, ...(res && res[SETTINGS_KEY] ? res[SETTINGS_KEY] : {}) });
    });
  });
}

/**
 * Считывает все куки для gemini.google.com и google.com напрямую из браузера
 * и возвращает как статус авторизации, так и готовую строку Header String для моста :8083.
 */
async function inspectGeminiCookies() {
  try {
    const cookiesGemini = await chrome.cookies.getAll({ url: 'https://gemini.google.com/' });
    const cookiesGoogle = await chrome.cookies.getAll({ domain: '.google.com' });

    const map = new Map();
    [...cookiesGoogle, ...cookiesGemini].forEach((c) => {
      if (c && c.name && c.value) {
        map.set(c.name, c.value);
      }
    });

    const hasPsid = map.has('__Secure-1PSID') || map.has('SID');
    const headerString = Array.from(map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    return {
      ok: hasPsid,
      cookiesCount: map.size,
      hasSecure1PSID: map.has('__Secure-1PSID'),
      hasSecure1PSIDTS: map.has('__Secure-1PSIDTS'),
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

/**
 * Ищет открытую вкладку с чатом Google Gemini (https://gemini.google.com/*)
 */
async function findOpenGeminiTab(autoCreateIfMissing = false) {
  const tabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*'] });
  if (tabs && tabs.length > 0) {
    return tabs[0];
  }
  if (!autoCreateIfMissing) {
    return null;
  }
  const created = await chrome.tabs.create({
    url: 'https://gemini.google.com/app',
    active: false
  });
  await new Promise((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        resolve();
      }
    }, 6500);
    const listener = (tabId, info) => {
      if (tabId === created.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        if (!done) {
          done = true;
          clearTimeout(timeout);
          setTimeout(resolve, 1200);
        }
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return created;
}

/**
 * Выполняется ВНУТРИ открытой вкладки https://gemini.google.com/* (в контексте MAIN world),
 * используя живую авторизацию пользователя, токен SNlM0e и актуальную версию интерфейса cfb2h.
 */
async function executePromptInsideGeminiTab(tabId, promptText) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [promptText],
    func: async (prompt) => {
      // 1. Быстрый внутренний RPC-запрос StreamGenerate используя живой токен WIZ_global_data.SNlM0e
      try {
        const wiz = window.WIZ_global_data || {};
        let atToken = wiz.SNlM0e;
        let blVersion = wiz.cfb2h;

        if (!atToken) {
          const html = document.documentElement.innerHTML;
          const mAt = html.match(/"SNlM0e":"([^"]+)"/);
          const mBl = html.match(/"cfb2h":"([^"]+)"/);
          if (mAt) atToken = mAt[1];
          if (mBl) blVersion = mBl[1];
        }

        if (atToken) {
          const reqId = String(Math.floor(100000 + Math.random() * 900000));
          const innerPayload = JSON.stringify([
            [prompt, 0, null, null, null, null, 0],
            ['ru'],
            ['', '', '', null, null, null, null, null, null, '']
          ]);
          const fReq = JSON.stringify([null, innerPayload]);

          const params = new URLSearchParams({
            bl: blVersion || 'boq_assistant-bard-web-server_20260301.00_p0',
            _reqid: reqId,
            rt: 'c'
          });

          const body = new URLSearchParams({
            'f.req': fReq,
            at: atToken
          });

          const resp = await fetch(
            `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params.toString()}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'X-Same-Domain': '1'
              },
              body: body.toString(),
              credentials: 'include'
            }
          );

          if (resp.ok) {
            const rawText = await resp.text();
            const lines = rawText.split('\n');
            let bestCandidate = '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('[["wrb.fr"')) continue;
              try {
                const parsedLine = JSON.parse(trimmed);
                const innerJsonStr = parsedLine?.[0]?.[2];
                if (!innerJsonStr) continue;
                const innerData = JSON.parse(innerJsonStr);
                const candidateText =
                  innerData?.[4]?.[0]?.[1]?.[0] ||
                  innerData?.[0]?.[0]?.[1]?.[0] ||
                  '';
                if (candidateText && candidateText.length > bestCandidate.length) {
                  bestCandidate = candidateText;
                }
              } catch {
                // continue scanning chunks
              }
            }

            if (bestCandidate && bestCandidate.trim().length > 10) {
              return {
                ok: true,
                mode: 'Вкладка Gemini (Прямой RPC без Docker)',
                text: bestCandidate.trim()
              };
            }
          }
        }
      } catch {
        // Если внутренний RPC-формат изменился — бесшовно переходим к DOM-отправке в открытом чате
      }

      // 2. Фоллбэк: отправка через интерфейс открытой вкладки Gemini (DOM-автоматизация)
      try {
        const editor =
          document.querySelector('rich-textarea div.ql-editor[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][role="textbox"]') ||
          document.querySelector('textarea');

        if (!editor) {
          return {
            ok: false,
            error: 'Вкладка Gemini открыта, но поле ввода чата не найдено (убедись, что ты вошёл в аккаунт Google на gemini.google.com).'
          };
        }

        const existingResponses = document.querySelectorAll('message-content, model-response, .model-response-text').length;

        editor.focus();
        if (editor.tagName === 'TEXTAREA') {
          editor.value = prompt;
          editor.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          editor.innerHTML = `<p>${prompt.replace(/\n/g, '</p><p>')}</p>`;
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: prompt }));
        }

        await new Promise((r) => setTimeout(r, 250));

        const sendBtn =
          document.querySelector('button.send-button') ||
          document.querySelector('button[aria-label*="Send"]') ||
          document.querySelector('button[aria-label*="Отправить"]') ||
          document.querySelector('button.submit');

        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        } else {
          editor.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
          );
        }

        let lastText = '';
        let stableTicks = 0;
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const nodes = document.querySelectorAll('message-content, .model-response-text');
          if (nodes.length > existingResponses || (nodes.length > 0 && i > 4)) {
            const latestNode = nodes[nodes.length - 1];
            const currentText = (latestNode.innerText || '').trim();
            if (currentText && currentText.length > 15) {
              if (currentText === lastText) {
                stableTicks += 1;
                if (stableTicks >= 3) {
                  return {
                    ok: true,
                    mode: 'Вкладка Gemini (Live Chat DOM)',
                    text: currentText
                  };
                }
              } else {
                lastText = currentText;
                stableTicks = 0;
              }
            }
          }
        }

        if (lastText) {
          return {
            ok: true,
            mode: 'Вкладка Gemini (Live Chat DOM)',
            text: lastText
          };
        }
      } catch (domErr) {
        return {
          ok: false,
          error: `Ошибка выполнения во вкладке Gemini: ${domErr.message || domErr}`
        };
      }

      return {
        ok: false,
        error: 'Не удалось получить ответ от вкладки gemini.google.com.'
      };
    }
  });

  const first = results && results[0] ? results[0].result : null;
  return first || { ok: false, error: 'Пустой ответ от scripting.executeScript' };
}

/**
 * Полная диагностика всех способов подключения ИИ для отображения статуса в попапе
 */
async function checkAllConnections() {
  const settings = await getSettings();
  const cookieInfo = await inspectGeminiCookies();
  const geminiTab = await findOpenGeminiTab(false);

  const backendUrl = settings.backendUrl.replace(/\/$/, '');
  const aiBaseUrl = settings.aiBaseUrl.replace(/\/$/, '');

  let backendStatus = { ok: false, cachedItems: 0, msg: 'Выкл (необязателен)' };
  try {
    const r1 = await fetch(`${backendUrl}/api/health`, { method: 'GET' });
    if (r1.ok) {
      const j = await r1.json().catch(() => ({}));
      backendStatus = { ok: true, cachedItems: j.cachedItems ?? 0, msg: `ОК (кэш: ${j.cachedItems ?? 0})` };
    } else {
      backendStatus = { ok: false, cachedItems: 0, msg: `HTTP ${r1.status}` };
    }
  } catch {
    // offline
  }

  let bridgeStatus = { ok: false, msg: 'Выкл (работает вкладка)' };
  try {
    const headers = settings.aiApiKey ? { Authorization: `Bearer ${settings.aiApiKey}` } : {};
    const r2 = await fetch(`${aiBaseUrl}/models`, { method: 'GET', headers });
    if (r2.ok) {
      bridgeStatus = { ok: true, msg: `ОК (${settings.aiModel})` };
    } else {
      bridgeStatus = { ok: false, msg: `HTTP ${r2.status} (проверь ключ)` };
    }
  } catch {
    // offline
  }

  return {
    ok: true,
    geminiTab: {
      found: Boolean(geminiTab),
      tabId: geminiTab ? geminiTab.id : null,
      url: geminiTab ? geminiTab.url : null
    },
    cookies: {
      ok: cookieInfo.ok,
      count: cookieInfo.cookiesCount,
      hasSecure1PSID: cookieInfo.hasSecure1PSID,
      headerString: cookieInfo.headerString
    },
    backend: backendStatus,
    bridge: bridgeStatus,
    settings
  };
}

/**
 * Сохраняет полученный через вкладку браузера вердикт обратно в SQLite-кэш FastAPI (:8765), если сервер запущен
 */
async function saveVerdictToBackendCache(backendUrl, slug, title, verdict, sources) {
  try {
    await fetch(`${backendUrl}/api/save-cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: slug || title,
        title,
        verdict,
        sources: Array.isArray(sources) ? sources : []
      })
    });
  } catch {
    // ignore if backend is offline
  }
}

/**
 * Главный оркестратор ИИ-обзора товара (вызывается из content.js при клике на «🤖 ИИ-обзор»)
 */
async function orchestrateProductAnalysis(payload) {
  const settings = await getSettings();
  const backendUrl = settings.backendUrl.replace(/\/$/, '');
  const aiBaseUrl = settings.aiBaseUrl.replace(/\/$/, '');

  let webSources = [];
  let backendOnline = false;

  // 1. Сначала пробуем локальный FastAPI (:8765) — он умеет брать из SQLite-кэша и парсить Отзовик/IRecommend
  try {
    const resp = await fetch(`${backendUrl}/api/analyze-product`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        aiBaseUrl: settings.aiBaseUrl,
        aiApiKey: settings.aiApiKey,
        aiModel: settings.aiModel
      })
    });

    if (resp.ok) {
      backendOnline = true;
      const data = await resp.json();
      if (Array.isArray(data.sources)) {
        webSources = data.sources;
      }
      // Если FastAPI вернул успешный ответ от ИИ или из SQLite-кэша — сразу отдаём его!
      if (data.verdict && data.aiOk !== false && !data.verdict.startsWith('⚠️ Ошибка вызова ИИ')) {
        return {
          ok: true,
          cached: Boolean(data.cached),
          mode: data.cached ? 'FastAPI SQLite Cache (:8765)' : `FastAPI (:8765) + ${settings.aiModel}`,
          verdict: data.verdict,
          sources: webSources
        };
      }
    }
  } catch {
    // FastAPI (:8765) выключен — продолжаем работу автономно!
  }

  const snippetsText = webSources.length > 0
    ? webSources.map((s) => `- ${s.title}: ${s.snippet}`).join('\n')
    : 'Прямых отзывов из поисковика нет — оцени строго по составу, КБЖУ и честной цене.';

  const prompt = [
    `Ты — безжалостный и ироничный продуктовый ревизор. Дай ультра-короткую сводку (максимум 3 пункта, без воды) по продукту из Яндекс Лавки:`,
    `Название: ${payload.title}`,
    `Вес/объём: ${payload.amount || 'не указан'}, Цена: ${payload.price || '?'} ₽`,
    `Состав: ${payload.ingredients || 'не указан'}`,
    `КБЖУ на 100 г: ${payload.traits || 'не указано'}`,
    `Найденные отзывы в сети:\n${snippetsText}`,
    `Ответь ровно в 3 коротких строчках:`,
    `1. **Отзывы и репутация**: что говорят люди или что сразу видно по продукту.`,
    `2. **Состав и КБЖУ**: есть ли скрытый сахар/крахмал/ММО/дешёвые наполнители и адекватна ли цена за кг и белок.`,
    `3. **Вердикт**: 🔥 Годнота / 😐 Под пиво сойдёт / 💀 Скипаем.`
  ].join('\n');

  // 2. Пробуем прямой запрос в OpenAI-совместимый мост (:8083 / DeepSeek / Ollama), если он запущен
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (settings.aiApiKey) {
      headers.Authorization = `Bearer ${settings.aiApiKey}`;
    }
    const directResp = await fetch(`${aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: settings.aiModel || 'gemini-4-argon',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3
      })
    });

    if (directResp.ok) {
      const json = await directResp.json();
      const reply = json.choices?.[0]?.message?.content;
      if (reply) {
        const cleanReply = reply.trim();
        if (backendOnline) {
          saveVerdictToBackendCache(backendUrl, payload.slug, payload.title, cleanReply, webSources);
        }
        return {
          ok: true,
          cached: false,
          mode: `Мост ${settings.aiModel} (${aiBaseUrl})`,
          verdict: cleanReply,
          sources: webSources
        };
      }
    }
  } catch {
    // Мост :8083 выключен — переходим к Автопилоту через открытую вкладку Gemini!
  }

  // 3. АВТОПИЛОТ ЧЕРЕЗ ВКЛАДКУ GEMINI В БРАУЗЕРЕ (БЕЗ DOCKER И БЕЗ API KEY!)
  const cookieCheck = await inspectGeminiCookies();
  if (cookieCheck.ok) {
    const geminiTab = await findOpenGeminiTab(true);
    if (geminiTab && geminiTab.id) {
      const tabResult = await executePromptInsideGeminiTab(geminiTab.id, prompt);
      if (tabResult && tabResult.ok && tabResult.text) {
        if (backendOnline) {
          saveVerdictToBackendCache(backendUrl, payload.slug, payload.title, tabResult.text, webSources);
        }
        return {
          ok: true,
          cached: false,
          mode: tabResult.mode || 'Автопилот через вкладку Gemini',
          verdict: tabResult.text,
          sources: webSources
        };
      }
    }
  }

  return {
    ok: false,
    mode: 'All AI methods unreachable',
    error: cookieCheck.ok
      ? 'Не удалось получить ответ ни от локального моста (:8083), ни от вкладки gemini.google.com.'
      : 'Ты ещё не вошёл в аккаунт на gemini.google.com и не запустил локальный мост (:8083). Открой окно расширения -> ⚙️ Настройки и ИИ -> нажми «⚡ Авто-подключение через вкладку Gemini»!'
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'LQS_ANALYZE_PRODUCT') {
    orchestrateProductAnalysis(msg.payload || {})
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_CHECK_AI_STATUS') {
    checkAllConnections()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'LQS_AUTO_CONNECT_GEMINI_TAB') {
    (async () => {
      const cookies = await inspectGeminiCookies();
      const tab = await findOpenGeminiTab(true);
      const status = await checkAllConnections();
      sendResponse({
        ok: Boolean(cookies.ok && tab),
        tabOpened: Boolean(tab),
        cookiesOk: cookies.ok,
        status
      });
    })();
    return true;
  }

  if (msg.type === 'LQS_GET_GEMINI_COOKIE_HEADER') {
    inspectGeminiCookies()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  return false;
});
