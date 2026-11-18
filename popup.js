const STORAGE_KEY = 'lqs_reviews_v1';
const SETTINGS_KEY = 'lqs_settings_v2';
const FLIGHT_LOG_KEY = 'lqs_flight_log_v1';

const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:8765',
  aiBaseUrl: 'http://localhost:8083/v1',
  aiApiKey: '',
  aiModel: 'gemini-4-argon',
  preferBrowserGeminiTab: true,
  geminiAccountIndex: 'auto',
  preferredGeminiTabId: null,
  autoRunAiOnProductPage: true,
  autoOpenDrawerOnAi: true,
  autoWarmupGeminiTab: true
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return resp;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

function saveSettingsPatch(patch, callback) {
  chrome.storage.local.get([SETTINGS_KEY], (res) => {
    const current = { ...DEFAULT_SETTINGS, ...(res && res[SETTINGS_KEY] ? res[SETTINGS_KEY] : {}) };
    const next = { ...current, ...patch };
    chrome.storage.local.set({ [SETTINGS_KEY]: next }, () => {
      if (callback) callback(next);
    });
  });
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
    document.getElementById('chk-auto-run-ai').checked = cfg.autoRunAiOnProductPage !== false;
    document.getElementById('chk-auto-open-drawer').checked = cfg.autoOpenDrawerOnAi !== false;
    document.getElementById('chk-auto-warmup').checked = cfg.autoWarmupGeminiTab !== false;
  });
}

// Сохранение тумблеров Zero-Click мгновенно при переключении
['chk-auto-run-ai', 'chk-auto-open-drawer', 'chk-auto-warmup'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('change', () => {
      saveSettingsPatch({
        autoRunAiOnProductPage: document.getElementById('chk-auto-run-ai').checked,
        autoOpenDrawerOnAi: document.getElementById('chk-auto-open-drawer').checked,
        autoWarmupGeminiTab: document.getElementById('chk-auto-warmup').checked
      });
    });
  }
});

document.getElementById('clear-ai-cache-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'LQS_CLEAR_AI_CACHE' }, () => {
    refreshAiRadar();
  });
});

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

function populateAccountSelector(resp) {
  const sel = document.getElementById('gemini-account-select');
  if (!sel || !resp) return;
  const cfg = resp.settings || {};
  const openTabs = Array.isArray(resp.openGeminiTabs) ? resp.openGeminiTabs : [];

  Array.from(sel.querySelectorAll('option[data-dynamic-tab="true"]')).forEach((o) => o.remove());

  openTabs.forEach((t, idx) => {
    const opt = document.createElement('option');
    opt.value = `tab:${t.tabId}:${t.accountIndex}`;
    opt.dataset.dynamicTab = 'true';
    const labelEmail = t.email ? `${t.email} (/u/${t.accountIndex})` : `Вкладка /u/${t.accountIndex} (id:${t.tabId})`;
    opt.textContent = `🟢 Открыта #${idx + 1}: ${labelEmail}`;
    sel.insertBefore(opt, sel.firstChild);
  });

  openTabs.forEach((t) => {
    if (t.email) {
      const staticOpt = sel.querySelector(`option[value="${t.accountIndex}"]`);
      if (staticOpt) {
        staticOpt.textContent = `Аккаунт #${t.accountIndex} — ${t.email} (/u/${t.accountIndex})`;
      }
    }
  });

  if (cfg.preferredGeminiTabId) {
    const dynMatch = sel.querySelector(`option[value^="tab:${cfg.preferredGeminiTabId}:"]`);
    if (dynMatch) {
      sel.value = dynMatch.value;
      return;
    }
  }
  const targetVal = String(cfg.geminiAccountIndex ?? 'auto');
  if (sel.querySelector(`option[value="${targetVal}"]`)) {
    sel.value = targetVal;
  }
}

function getSelectedAccountChoice() {
  const sel = document.getElementById('gemini-account-select');
  const raw = sel ? sel.value : 'auto';
  if (raw.startsWith('tab:')) {
    const parts = raw.split(':');
    return {
      preferredTabId: Number(parts[1]) || null,
      accountIndex: parts[2] || '0'
    };
  }
  return {
    preferredTabId: null,
    accountIndex: raw
  };
}

function applyRadarResponse(resp) {
  if (!resp || !resp.ok) return;
  populateAccountSelector(resp);

  const cacheBadge = document.getElementById('ai-cache-badge');
  if (cacheBadge) {
    cacheBadge.textContent = `Кэш ИИ: ${resp.localAiCacheCount ?? 0} тов.`;
  }

  const tabFound = Boolean(resp.geminiTab && resp.geminiTab.found);
  const accTag = resp.geminiTab && resp.geminiTab.email
    ? resp.geminiTab.email.split('@')[0]
    : (resp.geminiTab && resp.geminiTab.accountIndex !== null ? `/u/${resp.geminiTab.accountIndex}` : '');
  setRadarPill(
    'pill-gemini-tab',
    'val-gemini-tab',
    tabFound,
    !tabFound,
    tabFound ? `✅ ${accTag || 'Открыта'}` : '⚪ Авто-старт',
    tabFound
      ? `Подключена вкладка: ${resp.geminiTab.email || resp.geminiTab.url || 'gemini.google.com'}`
      : 'Откроется автоматически при заходе в Лавку'
  );

  const cookiesOk = Boolean(resp.cookies && resp.cookies.ok);
  setRadarPill(
    'pill-cookies',
    'val-cookies',
    cookiesOk,
    !cookiesOk,
    cookiesOk ? `✅ Активны (${resp.cookies.count})` : '⚠️ Не вошёл',
    cookiesOk ? 'Найдены куки авторизации Google' : 'Войди в аккаунт на gemini.google.com'
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
}

function refreshAiRadar() {
  if (!chrome.runtime || !chrome.runtime.sendMessage) return;
  chrome.runtime.sendMessage({ type: 'LQS_CHECK_AI_STATUS' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      setRadarPill('pill-gemini-tab', 'val-gemini-tab', false, true, 'Обнови расш.');
      return;
    }
    applyRadarResponse(resp);
  });
}

document.getElementById('refresh-radar-btn').addEventListener('click', () => {
  refreshAiRadar();
});

document.getElementById('gemini-account-select').addEventListener('change', () => {
  const choice = getSelectedAccountChoice();
  const statusBox = document.getElementById('autopilot-status-box');
  statusBox.style.display = 'block';
  statusBox.textContent = '⏳ Переключаю целевой аккаунт Gemini...';
  chrome.runtime.sendMessage(
    {
      type: 'LQS_SELECT_GEMINI_ACCOUNT',
      accountIndex: choice.accountIndex,
      preferredTabId: choice.preferredTabId,
      openOrFocusTab: false
    },
    (resp) => {
      if (resp && resp.status) {
        applyRadarResponse(resp.status);
        const tabInfo = resp.status.geminiTab;
        statusBox.innerHTML = tabInfo && tabInfo.found
          ? `✅ Выбран аккаунт: <b>${escapeHtml(tabInfo.email || ('/u/' + tabInfo.accountIndex))}</b>`
          : `ℹ️ Выбран аккаунт <b>/u/${escapeHtml(choice.accountIndex)}</b>. Он автоматически откроется при анализе товара.`;
      }
    }
  );
});

document.getElementById('open-selected-gemini-btn').addEventListener('click', () => {
  const choice = getSelectedAccountChoice();
  chrome.runtime.sendMessage(
    {
      type: 'LQS_SELECT_GEMINI_ACCOUNT',
      accountIndex: choice.accountIndex,
      preferredTabId: choice.preferredTabId,
      openOrFocusTab: true,
      makeActive: true
    },
    (resp) => {
      if (resp && resp.status) applyRadarResponse(resp.status);
    }
  );
});

document.getElementById('auto-connect-gemini-btn').addEventListener('click', () => {
  const btn = document.getElementById('auto-connect-gemini-btn');
  const statusBox = document.getElementById('autopilot-status-box');
  const choice = getSelectedAccountChoice();
  btn.textContent = '⏳ Прогреваю выбранный аккаунт Gemini...';
  statusBox.style.display = 'block';
  statusBox.textContent = 'Проверяем выбранную вкладку gemini.google.com...';

  chrome.runtime.sendMessage(
    {
      type: 'LQS_AUTO_CONNECT_GEMINI_TAB',
      accountIndex: choice.accountIndex,
      preferredTabId: choice.preferredTabId
    },
    (resp) => {
      btn.textContent = '⚡ Проверить / прогреть выбранный Gemini сейчас';

      if (chrome.runtime.lastError || !resp) {
        statusBox.innerHTML =
          '⚠️ <b>Фоновый воркер ещё не перезапущен!</b> Открой <code>chrome://extensions</code>, нажми круговую стрелку <b>🔄 Обновить</b> на карточке Lavka Quality Shield и обнови страницу Лавки (F5).';
        return;
      }

      if (resp.status) {
        applyRadarResponse(resp.status);
      } else {
        refreshAiRadar();
      }

      if (resp.cookiesOk && resp.tabOpened) {
        statusBox.innerHTML =
          `✅ <b>Zero-Click Автопилот готов!</b> Подключён аккаунт <b>${escapeHtml(resp.email || ('/u/' + (resp.accountIndex ?? '0')))}</b> (${resp.wasAlreadyOpen ? 'вкладка уже открыта' : 'закреплена в фоне'}, куки: ${resp.cookiesCount} шт.).<br>` +
          `👉 Просто открывай любые товары в Яндекс Лавке — ИИ-обзор запустится сам!`;
      } else if (!resp.cookiesOk) {
        statusBox.innerHTML =
          '⚠️ Вкладка <code>gemini.google.com</code> открыта, но куки входа не найдены. Перейди на вкладку Gemini и один раз войди в аккаунт Google!';
      } else {
        statusBox.textContent = '⚠️ Не удалось открыть вкладку Gemini: ' + (resp.error || 'неизвестная ошибка');
      }
    }
  );
});

document.getElementById('copy-gemini-cookies-btn').addEventListener('click', () => {
  const btn = document.getElementById('copy-gemini-cookies-btn');
  const statusBox = document.getElementById('autopilot-status-box');
  statusBox.style.display = 'block';

  chrome.runtime.sendMessage({ type: 'LQS_GET_GEMINI_COOKIE_HEADER' }, async (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok || !resp.headerString) {
      statusBox.innerHTML =
        '⚠️ Куки не найдены! Сначала открой <a href="https://gemini.google.com/" target="_blank" rel="noopener noreferrer">gemini.google.com</a>, войди в аккаунт и обнови расширение в chrome://extensions.';
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
  const patch = {
    backendUrl: document.getElementById('inp-backend').value.trim() || DEFAULT_SETTINGS.backendUrl,
    aiBaseUrl: document.getElementById('inp-ai-url').value.trim() || DEFAULT_SETTINGS.aiBaseUrl,
    aiApiKey: document.getElementById('inp-ai-key').value.trim(),
    aiModel: document.getElementById('inp-ai-model').value.trim() || DEFAULT_SETTINGS.aiModel,
    autoRunAiOnProductPage: document.getElementById('chk-auto-run-ai').checked,
    autoOpenDrawerOnAi: document.getElementById('chk-auto-open-drawer').checked,
    autoWarmupGeminiTab: document.getElementById('chk-auto-warmup').checked
  };
  saveSettingsPatch(patch, () => {
    const st = document.getElementById('ai-save-status');
    st.textContent = '✅ Настройки ИИ и Автопилота сохранены!';
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
// БОРТОВОЙ ЖУРНАЛ ДЛЯ ИИ (КОРРЕКТНЫЙ ПРОМИС-СБОРЩИК БЕЗ ОБРЕЗАННЫХ ЛОГОВ)
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
        const r = await fetchWithTimeout(`${backendUrl}/api/logs`, { method: 'GET' }, 1500);
        if (r.ok) {
          const data = await r.json();
          if (data && Array.isArray(data.logs) && data.logs.length > 0) {
            const formatted = [
              ``,
              `## 7. ЛОГ ЛОКАЛЬНОГО FASTAPI СЕРВЕРА (:8765 /api/logs)`,
              ...data.logs.slice(0, 30).map((l) => `${l.ts} [${l.level}] ${l.msg}`)
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

async function fetchAiStatusForDiag() {
  return new Promise((resolve) => {
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      resolve('');
      return;
    }
    chrome.runtime.sendMessage({ type: 'LQS_CHECK_AI_STATUS' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        resolve('\n## 8. СТАТУС АВТОПИЛОТА ИИ\n- Ошибка опроса фонового воркера (требуется обновление расширения в chrome://extensions).');
        return;
      }
      const section = [
        ``,
        `## 8. СТАТУС ZERO-CLICK АВТОПИЛОТА ИИ И КУКИ (BACKGROUND WORKER)`,
        `- **Вкладка Gemini (gemini.google.com)**: ${resp.geminiTab.found ? `✅ Открыта (tabId=${resp.geminiTab.tabId})` : '⚪ Не открыта'}`,
        `- **Куки Google**: ${resp.cookies.ok ? `✅ Найдены (${resp.cookies.count} шт., __Secure-1PSID=${resp.cookies.hasSecure1PSID})` : '⚠️ Не найдены'}`,
        `- **Кэш ИИ в браузере**: ${resp.localAiCacheCount ?? 0} товаров`,
        `- **Локальный мост ИИ (:8083)**: ${resp.bridge.ok ? '✅ ' + resp.bridge.msg : '⚪ ' + resp.bridge.msg}`,
        `- **FastAPI сервер (:8765)**: ${resp.backend.ok ? '✅ ' + resp.backend.msg : '⚪ ' + resp.backend.msg}`
      ].join('\n');
      resolve(section);
    });
  });
}

async function refreshDiagnosticsView() {
  const box = document.getElementById('diag-report-box');
  box.textContent = 'Собираю бортовой журнал со страницы Лавки и локального сервера...';

  const [backendTail, aiStatusSection] = await Promise.all([
    fetchBackendLogsTail(),
    fetchAiStatusForDiag()
  ]);

  const extraTail = (backendTail || '') + (aiStatusSection || '');

  return new Promise((resolve) => {
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
                box.textContent = resp.reportText + extraTail;
                resolve(box.textContent);
                return;
              }
              loadFallbackDiagFromStorage(box, extraTail).then(resolve);
            }
          );
        } else {
          loadFallbackDiagFromStorage(box, extraTail).then(resolve);
        }
      });
    } else {
      loadFallbackDiagFromStorage(box, extraTail).then(resolve);
    }
  });
}

function loadFallbackDiagFromStorage(box, extraTail = '') {
  return new Promise((resolve) => {
    chrome.storage.local.get([FLIGHT_LOG_KEY], (res) => {
      const snap = res && res[FLIGHT_LOG_KEY];
      if (snap && snap.reportText) {
        renderModulePills(snap.modules);
        box.textContent = snap.reportText + extraTail;
      } else {
        box.textContent =
          '# 🛠️ LAVKA QUALITY SHIELD v2.3.0 — AI DIAGNOSTIC LOG\n' +
          '⚠️ Активная вкладка Яндекс Лавки ещё не перезагружена после обновления расширения.\n' +
          'Нажми F5 на странице https://lavka.yandex.ru/, чтобы бортовой самописец записал телеметрию DOM.\n' +
          extraTail;
      }
      resolve(box.textContent);
    });
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
  statusEl.textContent = '⏳ Проверяю связь со всеми источниками ИИ...';

  chrome.runtime.sendMessage({ type: 'LQS_CHECK_AI_STATUS' }, async (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      statusEl.textContent = '⚠️ Ошибка проверки статуса. Нажми Обновить в chrome://extensions.';
      return;
    }
    const lines = [
      `${resp.geminiTab.found ? '✅' : '⚪'} Вкладка Gemini: ${resp.geminiTab.found ? 'Открыта' : 'Не открыта'}`,
      `${resp.cookies.ok ? '✅' : '⚠️'} Куки Google: ${resp.cookies.ok ? `Найдены (${resp.cookies.count} шт.)` : 'Не найдены'}`,
      `💾 Кэш ИИ в браузере: ${resp.localAiCacheCount ?? 0} тов.`,
      `${resp.bridge.ok ? '✅' : '⚪'} Мост ИИ (:8083): ${resp.bridge.msg}`,
      `${resp.backend.ok ? '✅' : '⚪'} FastAPI парсер (:8765): ${resp.backend.msg}`
    ];
    lastBackendPingSummary = lines.join(' | ');
    statusEl.innerHTML = lines.map(escapeHtml).join('<br>');
    applyRadarResponse(resp);
    await refreshDiagnosticsView();
  });
});

document.getElementById('diag-copy-btn').addEventListener('click', async () => {
  const btn = document.getElementById('diag-copy-btn');
  const text = await refreshDiagnosticsView();
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✅ Лог для ИИ скопирован в буфер!';
  } catch {
    btn.textContent = '⚠️ Не удалось скопировать';
  }
  setTimeout(() => { btn.textContent = '📋 Скопировать полный лог для ИИ (Markdown)'; }, 1800);
});

document.getElementById('diag-download-btn').addEventListener('click', async () => {
  const text = await refreshDiagnosticsView();
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
