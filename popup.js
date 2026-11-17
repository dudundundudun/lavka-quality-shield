const STORAGE_KEY = 'lqs_reviews_v1';
const SETTINGS_KEY = 'lqs_settings_v2';

const DEFAULT_SETTINGS = {
  backendUrl: 'http://127.0.0.1:8765',
  aiBaseUrl: 'http://localhost:8083/v1',
  aiApiKey: '',
  aiModel: 'gemini-4-argon'
};

let currentFilter = 'all';

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
      div.innerHTML = `
        <div class="item-header">
          <a href="https://lavka.yandex.ru/good/${item.slug}" target="_blank">${item.title || item.slug}</a>
          <span>${badge}</span>
        </div>
        <div class="item-note">${item.note || (item.tags || []).join(', ') || 'Без комментария'}</div>
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

document.getElementById('tab-reviews-btn').addEventListener('click', () => {
  document.getElementById('tab-reviews-btn').classList.add('active');
  document.getElementById('tab-ai-btn').classList.remove('active');
  document.getElementById('panel-reviews').style.display = 'block';
  document.getElementById('panel-ai').style.display = 'none';
});

document.getElementById('tab-ai-btn').addEventListener('click', () => {
  document.getElementById('tab-ai-btn').classList.add('active');
  document.getElementById('tab-reviews-btn').classList.remove('active');
  document.getElementById('panel-reviews').style.display = 'none';
  document.getElementById('panel-ai').style.display = 'block';
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

loadReviews();
loadSettings();
