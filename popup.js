const STORAGE_KEY = 'lqs_reviews_v1';
const SETTINGS_KEY = 'lqs_settings_v2';
const FLIGHT_LOG_KEY = 'lqs_flight_log_v1';

const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:8765',
  aiBaseUrl: 'http://localhost:8083/v1',
  aiApiKey: '',
  aiModel: 'gemini-4-argon'
};

const DOCKER_POWERSHELL_CMD =
  'docker run -d --name gemini-argon --restart unless-stopped -p 8083:8083 ghcr.io/zexadev/gemini-web2api-go:latest; Start-Sleep -Seconds 2; Write-Host "🚀 Сервер запущен! Админка: http://localhost:8083/admin/" -ForegroundColor Green';

let currentFilter = 'all';
let searchQuery = '';
let lastBackendPingSummary = null;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadReviews() {
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    const db = res[STORAGE_KEY] || {};
    const items = Object.values(db).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const godCount = items.filter((item) => item.rating >= 4 && !item.banned).length;
    const trashCount = items.filter((item) => item.banned || (item.rating > 0 && item.rating <= 2)).length;

    document.getElementById('count-all').textContent = items.length;
    document.getElementById('count-god').textContent = godCount;
    document.getElementById('count-trash').textContent = trashCount;

    const listEl = document.getElementById('reviews-list');
    listEl.innerHTML = '';

    const q = searchQuery.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (currentFilter === 'god' && !(item.rating >= 4 && !item.banned)) return false;
      if (currentFilter === 'trash' && !(item.banned || (item.rating > 0 && item.rating <= 2))) return false;
      if (q) {
        const hay = `${item.title || ''} ${item.slug || ''} ${item.note || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      listEl.innerHTML = '<div style="color:#7a7875;text-align:center;padding:18px;font-size:12px;">Список пуст. Поставь оценку любому товару в Лавке!</div>';
      return;
    }

    filtered.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'item';
      const badge = item.banned || item.rating <= 2 ? `💀 ${item.rating || 1}★` : `⭐ ${item.rating}★`;
      const safeSlug = encodeURIComponent(item.slug || '');
      const safeTitle = escapeHtml(item.title || item.slug || 'Товар');
      const noteOrTags = item.note || (item.tags || []).join(', ') || 'Без комментария';

      div.innerHTML = `
        <div class="item-header">
          <a href="https://lavka.yandex.ru/good/${safeSlug}" target="_blank" rel="noopener noreferrer">${safeTitle}</a>
          <span class="item-right">
            <span>${escapeHtml(badge)}</span>
            <button type="button" class="item-del-btn" data-slug="${escapeHtml(item.slug || '')}" title="Удалить запись">×</button>
          </span>
        </div>
        <div class="item-note">${escapeHtml(noteOrTags)}</div>
      `;

      const delBtn = div.querySelector('.item-del-btn');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetSlug = delBtn.getAttribute('data-slug');
          if (!targetSlug) return;
          delete db[targetSlug];
          chrome.storage.local.set({ [STORAGE_KEY]: db }, loadReviews);
        });
      }

      listEl.appendChild(div);
    });
  });
}

function loadSettings() {
  chrome.storage.local.get([SETTINGS_KEY], (res) => {
    const cfg = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
    document.getElementById('inp-backend').value = cfg.backendUrl;
    document.getElementById('inp-ai-url').value = cfg.aiBaseUrl;
    document.getElementById('inp-ai-key').value = cfg.aiApiKey;
    document.getElementById('inp-ai-model').value = cfg.aiModel;
  });
}

// ==========================================================================
// ЖИВОЙ РАДАР И АВТОПИЛОТ ПОДКЛЮЧЕНИЯ GEMINI
// ==========================================================================
function setRadarPill(pillId, valId, isOk, isWarn, text, title = '') {
  const pill = document.getElementById(pillId);
  const val = document.getElementById(valId);
  if (!pill || !val) return;
  pill.className = 'radar-pill' + (isOk ? ' ok' : (isWarn ? ' warn' : ''));
  if (title) pill.title = title;
  val.textContent = text;
}

function refreshAiRadar() {
  if (!chrome.runtime || !chrome.runtime.sendMessage) return;
  chrome.runtime.sendMessage({ type: 'LQS_CHECK_AI_STATUS' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      setRadarPill('pill-gemini-tab', 'val-gemini-tab', false, true, 'Ошибка');
      return;
    }

    const tabFound = Boolean(resp.geminiTab && resp.geminiTab.found);
    setRadarPill(
      'pill-gemini-tab',
      'val-gemini-tab',
      tabFound,
      !tabFound,
      tabFound ? '✅ Открыта' : '⚪ Нет вкладки',
      tabFound ? 'Найдена открытая вкладка gemini.google.com' : 'Нажми «Авто-подключение», чтобы открыть вкладку Gemini'
    );

    const cookiesOk = Boolean(resp.cookies && resp.cookies.ok);
    setRadarPill(
      'pill-cookies',
      'val-cookies',
      cookiesOk,
      !cookiesOk,
      cookiesOk ? `✅ Активны (${resp.cookies.count})` : '⚠️ Не вошёл',
      cookiesOk ? 'Найдены куки авторизации Google (__Secure-1PSID)' : 'Войди в аккаунт на gemini.google.com'
    );

    const bridgeOk = Boolean(resp.bridge && resp.bridge.ok);
    setRadarPill(
      'pill-bridge',
      'val-bridge',
      bridgeOk,
      false,
      bridgeOk ? '✅ Подключён' : '⚪ Выкл',
      resp.bridge ? resp.bridge.msg : ''
    );

    const backendOk = Boolean(resp.backend && resp.backend.ok);
    setRadarPill(
      'pill-backend',
      'val-backend',
      backendOk,
      false,
      backendOk ? `✅ ОК (${resp.backend.cachedItems})` : '⚪ Выкл',
      resp.backend ? resp.backend.msg : ''
    );
  });
}

document.getElementById('refresh-radar-btn').addEventListener('click', () => {
  refreshAiRadar();
});

document.getElementById('auto-connect-gemini-btn').addEventListener('click', () => {
  const btn = document.getElementById('auto-connect-gemini-btn');
  const statusBox = document.getElementById('autopilot-status-box');
  btn.textContent = '⏳ Ищу вкладку Gemini и проверяю куки...';
  statusBox.style.display = 'block';
  statusBox.textContent = 'Проверяем авторизацию на gemini.google.com...';

  chrome.runtime.sendMessage({ type: 'LQS_AUTO_CONNECT_GEMINI_TAB' }, (resp) => {
    btn.textContent = '⚡ Авто-подключение через вкладку Gemini (1 клик)';
    refreshAiRadar();

    if (chrome.runtime.lastError || !resp) {
      statusBox.textContent = '⚠️ Ошибка связи с фоновым воркером расширения. Перезагрузи расширение в chrome://extensions.';
      return;
    }

    if (resp.cookiesOk && resp.tabOpened) {
      statusBox.innerHTML =
        '✅ <b>Готово! Автопилот подключён.</b> Вкладка <code>gemini.google.com</code> и куки найдены — теперь кнопка «🤖 ИИ-обзор» на странице товара Лавки работает автоматически прямо через браузер!';
    } else if (!resp.cookiesOk) {
      statusBox.innerHTML =
        '⚠️ Я открыл вкладку <code>gemini.google.com</code>, но ты ещё не вошёл в Google-аккаунт. Войди в аккаунт во вкладке Gemini и нажми эту кнопку ещё раз!';
    } else {
      statusBox.textContent = '⚠️ Не удалось автоматически открыть вкладку Gemini.';
    }
  });
});

document.getElementById('copy-gemini-cookies-btn').addEventListener('click', () => {
  const btn = document.getElementById('copy-gemini-cookies-btn');
  const statusBox = document.getElementById('autopilot-status-box');
  statusBox.style.display = 'block';

  chrome.runtime.sendMessage({ type: 'LQS_GET_GEMINI_COOKIE_HEADER' }, async (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok || !resp.headerString) {
      statusBox.innerHTML =
        '⚠️ Куки Google не найдены! Сначала открой <a href="https://gemini.google.com/" target="_blank" rel="noopener noreferrer">gemini.google.com</a> и войди в аккаунт.';
      return;
    }
    try {
      await navigator.clipboard.writeText(resp.headerString);
      btn.textContent = `✅ Скопировано (${resp.cookiesCount} куки)! Вставь в :8083/admin/`;
      statusBox.innerHTML =
        '✅ <b>Header String скопирован в буфер обмена!</b> Теперь открой <a href="http://localhost:8083/admin/" target="_blank" rel="noopener noreferrer">http://localhost:8083/admin/</a> -> <b>Accounts -> Quick Add Cookie</b> и нажми Ctrl+V.';
      setTimeout(() => {
        btn.textContent = '🍪 Скопировать куки Gemini (Header String) без F12';
      }, 3000);
    } catch {
      statusBox.textContent = '⚠️ Не удалось скопировать куки в буфер обмена.';
    }
  });
});

document.getElementById('copy-docker-cmd-btn').addEventListener('click', async () => {
  const btn = document.getElementById('copy-docker-cmd-btn');
  try {
    await navigator.clipboard.writeText(DOCKER_POWERSHELL_CMD);
    btn.textContent = '✅ Команда скопирована! Вставь в PowerShell';
    setTimeout(() => {
      btn.textContent = '📋 Скопировать команду Docker для PowerShell';
    }, 2500);
  } catch {
    btn.textContent = '⚠️ Ошибка копирования';
  }
});

function switchTab(activeId) {
  const map = {
    'tab-reviews-btn': 'panel-reviews',
    'tab-settings-btn': 'panel-settings'
  };
  Object.keys(map).forEach((btnId) => {
    document.getElementById(btnId).classList.toggle('active', btnId === activeId);
    document.getElementById(map[btnId]).style.display = btnId === activeId ? 'block' : 'none';
  });
  if (activeId === 'tab-settings-btn') {
    refreshAiRadar();
  }
}

document.getElementById('tab-reviews-btn').addEventListener('click', () => switchTab('tab-reviews-btn'));
document.getElementById('tab-settings-btn').addEventListener('click', () => switchTab('tab-settings-btn'));

document.getElementById('search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value || '';
  loadReviews();
});

document.getElementById('preset-argon').addEventListener('click', () => {
  document.getElementById('inp-ai-url').value = 'http://localhost:8083/v1';
  document.getElementById('inp-ai-model').value = 'gemini-4-argon';
});

document.getElementById('preset-deepseek').addEventListener('click', () => {
  document.getElementById('inp-ai-url').value = 'https://api.deepseek.com/v1';
  document.getElementById('inp-ai-model').value = 'deepseek-chat';
});

document.getElementById('preset-ollama').addEventListener('click', () => {
  document.getElementById('inp-ai-url').value = 'http://127.0.0.1:11434/v1';
  document.getElementById('inp-ai-model').value = 'qwen2.5:14b';
});

document.getElementById('save-ai-btn').addEventListener('click', () => {
  const cfg = {
    backendUrl: document.getElementById('inp-backend').value.trim() || DEFAULT_SETTINGS.backendUrl,
    aiBaseUrl: document.getElementById('inp-ai-url').value.trim() || DEFAULT_SETTINGS.aiBaseUrl,
    aiApiKey: document.getElementById('inp-ai-key').value.trim(),
    aiModel: document.getElementById('inp-ai-model').value.trim() || DEFAULT_SETTINGS.aiModel
  };
  chrome.storage.local.set({ [SETTINGS_KEY]: cfg }, () => {
    const st = document.getElementById('ai-save-status');
    st.textContent = '✅ Настройки ИИ сохранены!';
    refreshAiRadar();
    setTimeout(() => { st.textContent = ''; }, 2000);
  });
});

document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    loadReviews();
  });
});

document.getElementById('export-btn').addEventListener('click', () => {
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    const blob = new Blob([JSON.stringify(res[STORAGE_KEY] || {}, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lavka-quality-shield-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });
});

document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      chrome.storage.local.set({ [STORAGE_KEY]: data }, loadReviews);
    } catch {
      alert('Ошибка чтения JSON файла');
    }
  };
  reader.readAsText(file);
});

// ==========================================================================
// БОРТОВОЙ ЖУРНАЛ ДЛЯ ИИ (ВНУТРИ СПОЙЛЕРА В НАСТРОЙКАХ)
// ==========================================================================
function renderModulePills(modules) {
  const container = document.getElementById('diag-module-pills');
  if (!container) return;
  if (!modules) {
    container.innerHTML = '';
    return;
  }
  const labels = {
    router: 'Роутер',
    parser: 'Парсер',
    calculator: 'КБЖУ/Цена',
    widget: 'Виджет',
    catalog: 'Каталог',
    cartGuard: 'Корзина',
    storage: 'База',
    aiReviewer: 'ИИ'
  };
  container.innerHTML = Object.keys(labels).map((key) => {
    const m = modules[key] || { status: 'IDLE', summary: '' };
    const st = m.status || 'IDLE';
    const cls = st === 'OK' ? 'ok' : (st === 'WARN' ? 'warn' : (st === 'ERROR' ? 'err' : ''));
    return `<span class="mod-pill ${cls}" title="${escapeHtml(m.summary || '')}">${labels[key]}: ${escapeHtml(st)}</span>`;
  }).join('');
}

async function fetchBackendLogsTail() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY], async (res) => {
      const cfg = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
      const backendUrl = cfg.backendUrl.replace(/\/$/, '');
      try {
        const r = await fetch(`${backendUrl}/api/logs`);
        if (r.ok) {
          const data = await r.json();
          if (data && Array.isArray(data.logs) && data.logs.length > 0) {
            const formatted = [
              ``,
              `## 7. ЛОГ ЛОКАЛЬНОГО FASTAPI СЕРВЕРА (:8765 /api/logs)`,
              ...data.logs.slice(0, 25).map((l) => `${l.ts} [${l.level}] ${l.msg}`)
            ].join('\n');
            resolve(formatted);
            return;
          }
        }
      } catch {
        // Backend offline — ignore
      }
      resolve('');
    });
  });
}

async function refreshDiagnosticsView() {
  const box = document.getElementById('diag-report-box');
  box.textContent = 'Собираю бортовой журнал со страницы Лавки и локального сервера...';

  const backendTail = await fetchBackendLogsTail();

  if (chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (activeTab && activeTab.id && activeTab.url && activeTab.url.includes('lavka.yandex.ru')) {
        chrome.tabs.sendMessage(
          activeTab.id,
          { type: 'LQS_GET_DIAGNOSTICS', backendDiag: lastBackendPingSummary },
          (resp) => {
            if (!chrome.runtime.lastError && resp && resp.reportText) {
              renderModulePills(resp.modules);
              box.textContent = resp.reportText + (backendTail ? '\n' + backendTail : '');
              return;
            }
            loadFallbackDiagFromStorage(box, backendTail);
          }
        );
      } else {
        loadFallbackDiagFromStorage(box, backendTail);
      }
    });
  } else {
    loadFallbackDiagFromStorage(box, backendTail);
  }
}

function loadFallbackDiagFromStorage(box, backendTail = '') {
  chrome.storage.local.get([FLIGHT_LOG_KEY], (res) => {
    const snap = res && res[FLIGHT_LOG_KEY];
    if (snap && snap.reportText) {
      renderModulePills(snap.modules);
      box.textContent = snap.reportText + (backendTail ? '\n' + backendTail : '');
    } else {
      box.textContent = 'Открой любую страницу https://lavka.yandex.ru/, чтобы бортовой самописец записал работу функций.';
    }
  });
}

document.getElementById('debug-spoiler').addEventListener('toggle', (e) => {
  if (e.target.open) {
    refreshDiagnosticsView();
  }
});

document.getElementById('diag-ping-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('diag-ping-status');
  statusEl.style.display = 'block';
  statusEl.textContent = '⏳ Проверяю связь со всеми источниками ИИ (Вкладка Gemini, :8765, :8083)...';

  chrome.runtime.sendMessage({ type: 'LQS_CHECK_AI_STATUS' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      statusEl.textContent = '⚠️ Ошибка проверки статуса через фоновый воркер.';
      return;
    }
    const lines = [
      `${resp.geminiTab.found ? '✅' : '⚪'} Вкладка Gemini: ${resp.geminiTab.found ? 'Открыта' : 'Не открыта'}`,
      `${resp.cookies.ok ? '✅' : '⚠️'} Куки Google (__Secure-1PSID): ${resp.cookies.ok ? `Найдены (${resp.cookies.count} шт.)` : 'Не найдены'}`,
      `${resp.bridge.ok ? '✅' : '⚪'} Мост ИИ (:8083): ${resp.bridge.msg}`,
      `${resp.backend.ok ? '✅' : '⚪'} FastAPI парсер (:8765): ${resp.backend.msg}`
    ];
    lastBackendPingSummary = lines.join(' | ');
    statusEl.innerHTML = lines.map(escapeHtml).join('<br>');
    refreshAiRadar();
    refreshDiagnosticsView();
  });
});

document.getElementById('diag-copy-btn').addEventListener('click', async () => {
  const btn = document.getElementById('diag-copy-btn');
  await refreshDiagnosticsView();
  const text = document.getElementById('diag-report-box').textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✅ Лог для ИИ скопирован в буфер!';
  } catch {
    btn.textContent = '⚠️ Не удалось скопировать';
  }
  setTimeout(() => { btn.textContent = '📋 Скопировать полный лог для ИИ (Markdown)'; }, 1800);
});

document.getElementById('diag-download-btn').addEventListener('click', async () => {
  await refreshDiagnosticsView();
  const text = document.getElementById('diag-report-box').textContent;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lavka-quality-shield-ai-debug-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`;
  a.click();
});

document.getElementById('diag-clear-btn').addEventListener('click', () => {
  if (chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (activeTab && activeTab.id && activeTab.url && activeTab.url.includes('lavka.yandex.ru')) {
        chrome.tabs.sendMessage(activeTab.id, { type: 'LQS_CLEAR_DIAGNOSTICS' }, () => {
          refreshDiagnosticsView();
        });
      } else {
        chrome.storage.local.remove([FLIGHT_LOG_KEY], () => {
          refreshDiagnosticsView();
        });
      }
    });
  }
});

loadReviews();
loadSettings();
refreshAiRadar();
