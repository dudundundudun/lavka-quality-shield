const STORAGE_KEY = 'lqs_reviews_v1';
const SETTINGS_KEY = 'lqs_settings_v2';
const DIAG_STORAGE_KEY = 'lqs_diag_snapshot_v1';

const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:8765',
  aiBaseUrl: 'http://localhost:8083/v1',
  aiApiKey: '',
  aiModel: 'gemini-4-argon'
};

let currentFilter = 'all';

function escapeHtml(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
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

    const filtered = items.filter((item) => {
      if (currentFilter === 'god') return item.rating >= 4 && !item.banned;
      if (currentFilter === 'trash') return item.banned || (item.rating > 0 && item.rating <= 2);
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
      const safeNote = escapeHtml(item.note || (item.tags || []).join(', ') || 'Без комментария');
      div.innerHTML = `
        <div class="item-header">
          <a href="https://lavka.yandex.ru/good/${safeSlug}" target="_blank" rel="noopener noreferrer">${safeTitle}</a>
          <span>${escapeHtml(badge)}</span>
        </div>
        <div class="item-note">${safeNote}</div>
      `;
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

function switchTab(activeId) {
  const map = {
    'tab-reviews-btn': 'panel-reviews',
    'tab-ai-btn': 'panel-ai',
    'tab-diag-btn': 'panel-diag'
  };
  Object.keys(map).forEach((btnId) => {
    document.getElementById(btnId).classList.toggle('active', btnId === activeId);
    document.getElementById(map[btnId]).style.display = btnId === activeId ? 'block' : 'none';
  });
  if (activeId === 'tab-diag-btn') {
    refreshDiagnosticsView();
  } else if (activeId === 'tab-ai-btn') {
    autoDiscoverAndConnectAi(true);
  }
}

document.getElementById('tab-reviews-btn').addEventListener('click', () => switchTab('tab-reviews-btn'));
document.getElementById('tab-ai-btn').addEventListener('click', () => switchTab('tab-ai-btn'));
document.getElementById('tab-diag-btn').addEventListener('click', () => switchTab('tab-diag-btn'));

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

function refreshDiagnosticsView() {
  const box = document.getElementById('diag-report-box');
  box.textContent = 'Запрашиваю живую телеметрию с открытой вкладки Лавки...';

  if (chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (activeTab && activeTab.id && activeTab.url && activeTab.url.includes('lavka.yandex.ru')) {
        chrome.tabs.sendMessage(activeTab.id, { type: 'LQS_GET_DIAGNOSTICS' }, (resp) => {
          if (!chrome.runtime.lastError && resp && resp.reportText) {
            box.textContent = resp.reportText;
            return;
          }
          loadFallbackDiagFromStorage(box);
        });
      } else {
        loadFallbackDiagFromStorage(box);
      }
    });
  } else {
    loadFallbackDiagFromStorage(box);
  }
}

function loadFallbackDiagFromStorage(box) {
  chrome.storage.local.get([DIAG_STORAGE_KEY], (res) => {
    const snap = res && res[DIAG_STORAGE_KEY];
    if (snap && snap.reportText) {
      box.textContent = snap.reportText;
    } else {
      box.textContent = 'Открой любую страницу https://lavka.yandex.ru/, чтобы собрать телеметрию DOM.';
    }
  });
}

document.getElementById('diag-refresh-btn').addEventListener('click', refreshDiagnosticsView);

document.getElementById('diag-ping-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('diag-ping-status');
  statusEl.textContent = '⏳ Пингую локальный FastAPI (:8765) и ИИ-мост (:8083)...';
  await autoDiscoverAndConnectAi(false, statusEl);
});

document.getElementById('diag-copy-btn').addEventListener('click', async () => {
  const btn = document.getElementById('diag-copy-btn');
  const text = document.getElementById('diag-report-box').textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✅ Отчёт скопирован в буфер!';
  } catch {
    btn.textContent = '⚠️ Не удалось скопировать';
  }
  setTimeout(() => { btn.textContent = '📋 Скопировать диагностический отчёт'; }, 1500);
});

async function autoDiscoverAndConnectAi(silentIfAlreadyConfigured = false, customStatusEl = null) {
  const statusEl = customStatusEl || document.getElementById('auto-connect-status');
  if (!statusEl) return;

  const currentCfg = await new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY], (res) => resolve(res[SETTINGS_KEY] || null));
  });

  if (silentIfAlreadyConfigured && currentCfg && currentCfg.aiApiKey) {
    return;
  }

  statusEl.style.display = 'block';
  statusEl.innerHTML = '⏳ Сканирую локальные порты (:8765, :8083, :11434)...';

  const typedKey = document.getElementById('inp-ai-key').value.trim() || (currentCfg && currentCfg.aiApiKey) || '';

  chrome.runtime.sendMessage({ type: 'LQS_AUTO_DISCOVER_AI', apiKey: typedKey }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      statusEl.innerHTML = '⚠️ Не удалось выполнить фоновое сканирование.';
      return;
    }
    const { report, settings } = res;
    document.getElementById('inp-backend').value = settings.backendUrl;
    document.getElementById('inp-ai-url').value = settings.aiBaseUrl;
    document.getElementById('inp-ai-model').value = settings.aiModel;

    const lines = [];
    if (report.backendOk) {
      lines.push(`✅ Парсер отзывов (:8765): ОК (кэш: ${report.cachedItems} шт.)`);
    } else {
      lines.push(`⚪ Парсер (:8765): выключен (работаем напрямую через ИИ-мост)`);
    }

    if (report.aiOk) {
      lines.push(`✅ ${escapeHtml(report.aiProviderName)}: подключён (модель: <code>${escapeHtml(report.aiModel)}</code>)`);
    } else if (report.aiNeedsKey) {
      lines.push(`🔑 Мост <b>${escapeHtml(report.aiBaseUrl)}</b> найден! Осталось вставить API Key из <a href="http://localhost:8083/admin/" target="_blank">админки :8083/admin/</a>.`);
    } else {
      lines.push(`❌ Локальный ИИ на :8083 и :11434 не откликнулся. Проверь Docker-контейнер.`);
    }

    statusEl.innerHTML = lines.join('<br>');
  });
}

document.getElementById('auto-connect-btn').addEventListener('click', () => autoDiscoverAndConnectAi(false));

loadReviews();
loadSettings();
