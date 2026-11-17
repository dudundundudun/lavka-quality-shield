const STORAGE_KEY = 'lqs_reviews_v1';
let currentFilter = 'all';

function loadReviews() {
  chrome.storage.local.get([STORAGE_KEY], (res) => {
    const db = res[STORAGE_KEY] || {};
    const items = Object.values(db).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const godCount = items.filter((i) => i.rating >= 4 && !i.banned).length;
    const trashCount = items.filter((i) => i.banned || (i.rating > 0 && i.rating <= 2)).length;

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
      listEl.innerHTML = '<div style="color:#71717a;text-align:center;padding:20px;font-size:12px;">Список пуст. Оцени любой продукт на lavka.yandex.ru!</div>';
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
