/**
 * Lavka Quality Shield v1.0.0 — Content Script
 * Работает на реальных селекторах lavka.yandex.ru (React Fiber 18+ SPA)
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'lqs_reviews_v1';
  const PRESET_TAGS = [
    '🔥 Топ за свои деньги',
    '🥩 В аэрогриль / су-вид',
    '🥑 Кето / Мало углей',
    '🧂 Пересолено',
    '💧 Водянистое / Резина',
    '🤢 Химозный состав',
    '💀 Никогда не брать'
  ];

  // Загрузка базы отзывов из chrome.storage.local (с фоллбэком на localStorage)
  async function getReviewsDB() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([STORAGE_KEY], (res) => {
          resolve(res[STORAGE_KEY] || {});
        });
      } else {
        try {
          resolve(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
        } catch {
          resolve({});
        }
      }
    });
  }

  async function saveProductReview(slug, data) {
    const db = await getReviewsDB();
    db[slug] = {
      ...db[slug],
      ...data,
      slug,
      updatedAt: new Date().toISOString()
    };
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [STORAGE_KEY]: db }, () => resolve(db[slug]));
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
        resolve(db[slug]);
      }
    });
  }

  // Извлечение канонического slug товара из URL вида /good/pelmeni-sochnye-...
  function extractSlugFromUrl(urlStr) {
    try {
      const u = new URL(urlStr, window.location.origin);
      const match = u.pathname.match(/\/good\/([^/?#]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  // Извлечение данных из JSON-LD (script[data-testid="ldjson"]) и DOM страницы товара
  function extractProductPageMetadata() {
    const titleEl = document.querySelector('h1[data-testid="product-title"]');
    const amountEl = document.querySelector('span[data-testid="product-amount"]');
    const priceEl = document.querySelector('span[data-testid="price-text"]');
    const oldPriceEl = document.querySelector('span[data-testid="price-old-text"]');
    const ingredientsEl = document.querySelector('section[data-testid="ingredients-block"]');
    const traitsEl = document.querySelector('section[data-testid="traits-block"]');
    const ldJsonEl = document.querySelector('script[data-testid="ldjson"]');

    let ldData = {};
    if (ldJsonEl) {
      try {
        const parsed = JSON.parse(ldJsonEl.textContent);
        const graph = parsed['@graph'] || [];
        const prod = graph.find((item) => item['@type'] === 'Product') || parsed;
        ldData = {
          productId: prod['@id'] || null,
          brand: prod.brand ? prod.brand.name : null,
          description: prod.description || ''
        };
      } catch {
        // Игнорируем ошибки парсинга JSON-LD
      }
    }

    const title = titleEl ? titleEl.textContent.trim() : document.title;
    const amountText = amountEl ? amountEl.textContent.trim() : '';
    const priceText = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.') : '';
    const oldPriceText = oldPriceEl ? oldPriceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.') : '';
    const ingredientsText = ingredientsEl ? ingredientsEl.innerText.trim() : '';
    const traitsText = traitsEl ? traitsEl.innerText.trim() : '';

    return {
      title,
      amountText,
      price: parseFloat(priceText) || null,
      oldPrice: parseFloat(oldPriceText) || null,
      ingredientsText,
      traitsText,
      ...ldData
    };
  }

  // Смарт-анализатор: пересчет цены за 1 кг/л и радар стоп-ингредиентов / БЖУ
  function analyzeProductQuality(meta) {
    const flags = [];
    let pricePerKg = null;

    // 1. Расчет реальной цены за 1 кг или 1 л
    if (meta.price && meta.amountText) {
      const m = meta.amountText.match(/([\d.,]+)\s*(г|кг|мл|л)/i);
      if (m) {
        const val = parseFloat(m[1].replace(',', '.'));
        const unit = m[2].toLowerCase();
        if (val > 0) {
          if (unit === 'г' || unit === 'мл') {
            pricePerKg = Math.round((meta.price / val) * 1000);
          } else if (unit === 'кг' || unit === 'л') {
            pricePerKg = Math.round(meta.price / val);
          }
        }
      }
    }

    // 2. Анализ состава из section[data-testid="ingredients-block"]
    const ingLower = (meta.ingredientsText || '').toLowerCase();
    if (ingLower) {
      const badMatchers = [
        { regex: /механической обвалки|ммо/i, label: '⚠️ Мясо мех. обвалки' },
        { regex: /мальтодекстрин|патока|глюкозно-фруктозный/i, label: '🍬 Скрытые сахара / патока' },
        { regex: /заменитель молочного жира|пальмовое масло/i, label: '🛢️ Заменитель молочного жира' },
        { regex: /соевый белок|соевая мука|клетчатка пшеничная/i, label: '🌾 Дешевый наполнитель (соя/клетчатка)' },
        { regex: /глутамат|е621|ароматизатор/i, label: '🧪 Усилители вкуса / ароматизаторы' },
        { regex: /крахмал/i, label: '🥔 Крахмал в составе' }
      ];

      badMatchers.forEach((item) => {
        if (item.regex.test(ingLower)) {
          flags.push({ type: 'bad', text: item.label });
        }
      });

      if (flags.length === 0 && ingLower.length > 10) {
        flags.push({ type: 'good', text: '✅ Чистый состав без стоп-слов' });
      }
    }

    // 3. Проверка углеводов из section[data-testid="traits-block"] (Кето / Low-Carb радар)
    if (meta.traitsText) {
      const carbMatch = meta.traitsText.match(/([\d.,]+)\s*углевод/i) || meta.traitsText.match(/углеводы[^\d]*([\d.,]+)/i);
      if (carbMatch) {
        const carbs = parseFloat(carbMatch[1].replace(',', '.'));
        if (!isNaN(carbs)) {
          if (carbs <= 5) {
            flags.push({ type: 'good', text: `🥑 Кето-френдли (${carbs} г угл.)` });
          } else if (carbs >= 20) {
            flags.push({ type: 'bad', text: `🍞 Много углеводов (${carbs} г / 100 г)` });
          }
        }
      }
    }

    return { pricePerKg, flags };
  }

  // Рендер смарт-панели на странице товара main[data-testid="good-page-desktop"]
  async function renderProductPageWidget() {
    const slug = extractSlugFromUrl(window.location.href);
    const mainPage = document.querySelector('main[data-testid="good-page-desktop"]');
    if (!slug || !mainPage) return;

    const infoBlock = mainPage.querySelector('div[data-testid="product-info"]') ||
                      mainPage.querySelector('div[data-testid="product-card-header"]');
    if (!infoBlock) return;

    const existing = mainPage.querySelector('.lqs-product-panel');
    if (existing && existing.dataset.slug === slug) return;
    if (existing) existing.remove();

    const db = await getReviewsDB();
    const current = db[slug] || { rating: 0, note: '', tags: [], banned: false };
    const meta = extractProductPageMetadata();
    const smart = analyzeProductQuality(meta);

    const panel = document.createElement('div');
    panel.className = 'lqs-product-panel';
    panel.dataset.slug = slug;

    function getStatusMeta(r, banned) {
      if (banned || (r > 0 && r <= 2)) return { cls: 'lqs-status-trash', text: '💀 ШЛАК / В БАНЕ' };
      if (r >= 4) return { cls: 'lqs-status-god', text: `🔥 ГОДНОТА (${r}/5)` };
      if (r === 3) return { cls: 'lqs-status-ok', text: '😐 СРЕДНЯЧОК (3/5)' };
      return { cls: 'lqs-status-unrated', text: 'ЕЩЁ НЕ ОЦЕНЕНО' };
    }

    const status = getStatusMeta(current.rating, current.banned);

    panel.innerHTML = `
      <div class="lqs-header">
        <div class="lqs-title">🛡️ Lavka Quality Shield</div>
        <span class="lqs-status-pill ${status.cls}" id="lqs-status-badge">${status.text}</span>
      </div>

      <div class="lqs-rating-row">
        <div class="lqs-stars" id="lqs-stars-box">
          ${[1, 2, 3, 4, 5].map((n) => `
            <button type="button" class="lqs-star-btn ${current.rating >= n ? 'active' : ''}" data-star="${n}" title="Оценить на ${n}">
              ${current.rating >= n ? '⭐' : '☆'}
            </button>
          `).join('')}
        </div>
        <button type="button" class="lqs-ban-btn ${current.banned ? 'banned' : ''}" id="lqs-ban-toggle">
          ${current.banned ? '💀 В чёрном списке (разбанить)' : '🚫 В чёрный список'}
        </button>
      </div>

      <div class="lqs-tags-row" id="lqs-tags-box">
        ${PRESET_TAGS.map((tag) => `
          <span class="lqs-tag-chip ${(current.tags || []).includes(tag) ? 'selected' : ''}" data-tag="${tag}">
            ${tag}
          </span>
        `).join('')}
      </div>

      <textarea class="lqs-note-input" id="lqs-note-area" placeholder="Твой личный вердикт (например: «Тесто разваливается, начинка из сои, больше не брать»)...">${current.note || ''}</textarea>

      <div class="lqs-smart-box">
        <div class="lqs-smart-line">
          <span>⚖️ <strong>Реальная цена:</strong></span>
          <span>${smart.pricePerKg ? `<strong>~${smart.pricePerKg} ₽</strong> за 1 кг/л` : 'Вес не указан'}</span>
        </div>
        <div class="lqs-flag-list">
          ${smart.flags.map((f) => `<span class="lqs-flag-${f.type}">${f.text}</span>`).join('')}
        </div>
      </div>
    `;

    const barContainer = infoBlock.querySelector('div[data-testid="bar-container"]');
    if (barContainer && barContainer.parentNode) {
      barContainer.parentNode.insertBefore(panel, barContainer.nextSibling);
    } else {
      infoBlock.prepend(panel);
    }

    // Обработчики событий
    const persistState = async () => {
      const updated = await saveProductReview(slug, {
        title: meta.title,
        brand: meta.brand,
        productId: meta.productId,
        price: meta.price,
        rating: current.rating,
        banned: current.banned,
        tags: current.tags,
        note: current.note
      });
      const st = getStatusMeta(updated.rating, updated.banned);
      const badge = panel.querySelector('#lqs-status-badge');
      badge.className = `lqs-status-pill ${st.cls}`;
      badge.textContent = st.text;
      guardAddToCartButton(updated);
      decorateCatalogCards();
    };

    panel.querySelectorAll('.lqs-star-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = parseInt(btn.dataset.star, 10);
        current.rating = current.rating === val ? 0 : val;
        if (current.rating > 0 && current.rating <= 2) {
          current.banned = true;
        } else if (current.rating >= 4) {
          current.banned = false;
        }
        panel.querySelectorAll('.lqs-star-btn').forEach((b) => {
          const s = parseInt(b.dataset.star, 10);
          b.classList.toggle('active', current.rating >= s);
          b.textContent = current.rating >= s ? '⭐' : '☆';
        });
        const banBtn = panel.querySelector('#lqs-ban-toggle');
        banBtn.classList.toggle('banned', current.banned);
        banBtn.textContent = current.banned ? '💀 В чёрном списке (разбанить)' : '🚫 В чёрный список';
        persistState();
      });
    });

    panel.querySelector('#lqs-ban-toggle').addEventListener('click', (e) => {
      current.banned = !current.banned;
      if (current.banned && current.rating === 0) current.rating = 1;
      e.currentTarget.classList.toggle('banned', current.banned);
      e.currentTarget.textContent = current.banned ? '💀 В чёрном списке (разбанить)' : '🚫 В чёрный список';
      persistState();
    });

    panel.querySelectorAll('.lqs-tag-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        current.tags = current.tags || [];
        if (current.tags.includes(tag)) {
          current.tags = current.tags.filter((t) => t !== tag);
          chip.classList.remove('selected');
        } else {
          current.tags.push(tag);
          chip.classList.add('selected');
        }
        persistState();
      });
    });

    let noteTimeout;
    panel.querySelector('#lqs-note-area').addEventListener('input', (e) => {
      current.note = e.target.value;
      clearTimeout(noteTimeout);
      noteTimeout = setTimeout(persistState, 350);
    });

    guardAddToCartButton(current);
  }

  // Защита кнопки «В корзину» button[data-testid="snippet-control"] от случайной покупки шлака
  function guardAddToCartButton(review) {
    const addBtn = document.querySelector('main[data-testid="good-page-desktop"] button[data-testid="snippet-control"]');
    if (!addBtn) return;

    const isBad = review && (review.banned || (review.rating > 0 && review.rating <= 2));
    if (isBad) {
      addBtn.style.background = '#7f1d1d';
      addBtn.style.color = '#fecaca';
      addBtn.title = `Твой отзыв: ${review.note || 'Не брать!'}`;
      if (!addBtn.dataset.lqsGuarded) {
        addBtn.dataset.lqsGuarded = 'true';
        addBtn.addEventListener('click', (e) => {
          if (review.banned || (review.rating > 0 && review.rating <= 2)) {
            const ok = window.confirm(
              `⚠️ СТОП! Ты сам забанил этот продукт (${review.rating || 1}⭐).\n\nТвоя заметка: "${review.note || 'Плохое качество'}"\n\nТочно хочешь положить его в корзину?`
            );
            if (!ok) {
              e.stopPropagation();
              e.preventDefault();
            }
          }
        }, true);
      }
    } else {
      addBtn.style.background = '';
      addBtn.style.color = '';
    }
  }

  // Разметка всех карточек каталога, поиска и «Вы покупали» div[data-testid="product-card"]
  async function decorateCatalogCards() {
    const db = await getReviewsDB();
    const cards = document.querySelectorAll('div[data-testid="product-card"]');

    cards.forEach((card) => {
      const linkEl = card.querySelector('a[href*="/good/"]') || card.closest('a[href*="/good/"]');
      if (!linkEl) return;

      const slug = extractSlugFromUrl(linkEl.getAttribute('href'));
      if (!slug) return;

      const review = db[slug];
      const oldBadge = card.querySelector('.lqs-card-badge');
      const oldNote = card.querySelector('.lqs-card-note-preview');
      if (oldBadge) oldBadge.remove();
      if (oldNote) oldNote.remove();
      card.classList.remove('lqs-card-dimmed');

      if (!review || (review.rating === 0 && !review.banned && !review.note)) return;

      card.style.position = 'relative';
      const badge = document.createElement('div');

      const isBad = review.banned || (review.rating > 0 && review.rating <= 2);
      if (isBad) {
        badge.className = 'lqs-card-badge trash';
        badge.textContent = `💀 ${review.rating ? review.rating + '★' : 'БАН'} НЕ БРАТЬ`;
        card.classList.add('lqs-card-dimmed');
      } else if (review.rating >= 4) {
        badge.className = 'lqs-card-badge god';
        badge.textContent = `🔥 ${review.rating}★ ТОП`;
      } else {
        badge.className = 'lqs-card-badge ok';
        badge.textContent = `😐 ${review.rating}★ НОРМ`;
      }

      card.appendChild(badge);

      if (review.note) {
        const notePreview = document.createElement('div');
        notePreview.className = 'lqs-card-note-preview';
        notePreview.textContent = `💬 ${review.note}`;
        card.appendChild(notePreview);
      }
    });
  }

  // Инициализация и слежение за React Fiber SPA-навигацией
  let debounceTimer = null;
  function scheduleUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      renderProductPageWidget();
      decorateCatalogCards();
    }, 180);
  }

  const observer = new MutationObserver(() => {
    scheduleUpdate();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener('popstate', scheduleUpdate);
  scheduleUpdate();
})();
