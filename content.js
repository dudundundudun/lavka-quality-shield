/**
 * Lavka Quality Shield v1.0.1 — Content Script
 * Устойчив к React 18 Hydration (F5 refresh), поддерживает мульти-ключевой поиск
 * (URL slug + productId + imageKey + нормализованное название без мягких переносов)
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

  let isRenderingProduct = false;

  // Очистка строки от мягких переносов (\u00ad), неразрывных пробелов, тегов и лишних кавычек
  function normalizeTitle(raw) {
    if (!raw) return '';
    return raw
      .replace(/<[^>]*>/g, '')
      .replace(/&laquo;|&raquo;|&quot;|&nbsp;/gi, ' ')
      .replace(/[\u00ad\u200b\u00a0]/g, '')
      .replace(/[«»"„“”]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // Извлечение уникального ключа картинки вида "6247604/609844f8-3e8a-4172-9f44-b26854ac51e5"
  function extractImageKey(src) {
    if (!src) return null;
    const m = src.match(/get-grocery-goods\/(\d+\/[a-f0-9-]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  // Извлечение канонического slug товара из URL вида /good/pelmeni-sochnye-...
  function extractSlugFromUrl(urlStr) {
    if (!urlStr) return null;
    try {
      const u = new URL(urlStr, window.location.origin);
      const match = u.pathname.match(/\/good\/([^/?#]+)/i);
      return match ? decodeURIComponent(match[1]).toLowerCase().trim() : null;
    } catch {
      return null;
    }
  }

  // Чтение базы отзывов из chrome.storage.local
  async function getReviewsDB() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([STORAGE_KEY], (res) => {
          resolve((res && res[STORAGE_KEY]) ? res[STORAGE_KEY] : {});
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

  // Универсальный поиск отзыва в базе по любому совпадению: slug, productId, imageKey или cleanTitle
  function findReviewInDB(db, keys) {
    if (!db) return null;
    const { slug, productId, imageKey, cleanTitle } = keys;

    if (slug && db[slug]) return db[slug];

    const entries = Object.values(db);
    for (const item of entries) {
      if (!item) continue;
      if (slug && item.slug && item.slug.toLowerCase() === slug) return item;
      if (productId && item.productId && item.productId === productId) return item;
      if (imageKey && item.imageKey && item.imageKey === imageKey) return item;
      if (cleanTitle && item.cleanTitle && item.cleanTitle === cleanTitle) return item;
    }
    return null;
  }

  // Сохранение отзыва в chrome.storage.local
  async function saveProductReview(slug, data) {
    const db = await getReviewsDB();
    const existing = findReviewInDB(db, {
      slug,
      productId: data.productId,
      imageKey: data.imageKey,
      cleanTitle: data.cleanTitle
    });
    const canonicalKey = (existing && existing.slug) ? existing.slug : slug;

    db[canonicalKey] = {
      ...(existing || {}),
      ...data,
      slug: canonicalKey,
      updatedAt: new Date().toISOString()
    };

    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [STORAGE_KEY]: db }, () => resolve(db[canonicalKey]));
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
        resolve(db[canonicalKey]);
      }
    });
  }

  // Извлечение актуальных метаданных со страницы товара
  function extractProductPageMetadata() {
    const mainPage = document.querySelector('main[data-testid="good-page-desktop"]');
    const titleEl = (mainPage && mainPage.querySelector('h1[data-testid="product-title"]')) ||
                    document.querySelector('h1[data-testid="product-title"]');
    const amountEl = (mainPage && mainPage.querySelector('span[data-testid="product-amount"]')) ||
                     document.querySelector('span[data-testid="product-amount"]');
    const priceEl = (mainPage && mainPage.querySelector('span[data-testid="price-text"]')) ||
                    document.querySelector('span[data-testid="price-text"]');
    const oldPriceEl = (mainPage && mainPage.querySelector('span[data-testid="price-old-text"]')) ||
                       document.querySelector('span[data-testid="price-old-text"]');
    const ingredientsEl = document.querySelector('section[data-testid="ingredients-block"]');
    const traitsEl = document.querySelector('section[data-testid="traits-block"]');
    const snippetImg = (mainPage && mainPage.querySelector('img[data-testid="snippet-image"]')) ||
                       document.querySelector('img[data-testid="snippet-image"]');

    let ldData = {};
    const ldJsonEls = document.querySelectorAll('script[data-testid="ldjson"], script[type="application/ld+json"]');
    ldJsonEls.forEach((el) => {
      try {
        const parsed = JSON.parse(el.textContent);
        const graph = parsed['@graph'] || [parsed];
        const prod = graph.find((item) => item && item['@type'] === 'Product');
        if (prod) {
          ldData = {
            productId: prod['@id'] || null,
            brand: prod.brand ? prod.brand.name : null,
            description: prod.description || ''
          };
        }
      } catch {
        // Игнорируем невалидный JSON
      }
    });

    const rawTitle = titleEl ? titleEl.textContent : document.title.split('—')[0];
    const title = rawTitle ? rawTitle.replace(/[\u00ad\u200b]/g, '').trim() : '';
    const cleanTitle = normalizeTitle(title);
    const amountText = amountEl ? amountEl.textContent.trim() : '';
    const priceText = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.') : '';
    const oldPriceText = oldPriceEl ? oldPriceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.') : '';
    const ingredientsText = ingredientsEl ? ingredientsEl.innerText.trim() : '';
    const traitsText = traitsEl ? traitsEl.innerText.trim() : '';
    const imageKey = snippetImg ? extractImageKey(snippetImg.getAttribute('src')) : null;

    return {
      title,
      cleanTitle,
      amountText,
      price: parseFloat(priceText) || null,
      oldPrice: parseFloat(oldPriceText) || null,
      ingredientsText,
      traitsText,
      imageKey,
      ...ldData
    };
  }

  // Смарт-анализатор: пересчет цены за 1 кг/л и радар стоп-ингредиентов / БЖУ
  function analyzeProductQuality(meta) {
    const flags = [];
    let pricePerKg = null;

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

  function getStatusMeta(r, banned) {
    if (banned || (r > 0 && r <= 2)) return { cls: 'lqs-status-trash', bannerCls: 'trash', text: `💀 ШЛАК / В БАНЕ (${r || 1}/5)` };
    if (r >= 4) return { cls: 'lqs-status-god', bannerCls: 'god', text: `🔥 ГОДНОТА (${r}/5)` };
    if (r === 3) return { cls: 'lqs-status-ok', bannerCls: 'ok', text: '😐 СРЕДНЯЧОК (3/5)' };
    return { cls: 'lqs-status-unrated', bannerCls: '', text: 'ЕЩЁ НЕ ОЦЕНЕНО' };
  }

  // Отрисовка наглядного баннера с твоим сохраненным отзывом прямо под заголовком товара h1[data-testid="product-title"]
  function renderVerdictBanner(mainPage, review) {
    const headerBlock = mainPage.querySelector('div[data-testid="product-card-header"]') ||
                        mainPage.querySelector('h1[data-testid="product-title"]')?.parentElement;
    if (!headerBlock) return;

    let banner = mainPage.querySelector('.lqs-verdict-banner');
    const hasVerdict = review && (review.rating > 0 || review.banned || (review.note && review.note.trim()) || (review.tags && review.tags.length > 0));

    if (!hasVerdict) {
      if (banner) banner.remove();
      return;
    }

    const st = getStatusMeta(review.rating, review.banned);
    const starsStr = review.rating > 0 ? '⭐'.repeat(review.rating) + '☆'.repeat(5 - review.rating) : (review.banned ? '💀 ЧЁРНЫЙ СПИСОК' : '');

    if (!banner) {
      banner = document.createElement('div');
      headerBlock.insertAdjacentElement('afterend', banner);
    }

    banner.className = `lqs-verdict-banner ${st.bannerCls || 'ok'}`;
    banner.innerHTML = `
      <div class="lqs-verdict-top">
        <span>🛡️ Твой вердикт: ${st.text}</span>
        <span>${starsStr}</span>
      </div>
      ${review.note && review.note.trim() ? `<div class="lqs-verdict-note">💬 ${review.note.replace(/</g, '&lt;')}</div>` : ''}
      ${review.tags && review.tags.length ? `
        <div class="lqs-verdict-tags">
          ${review.tags.map((t) => `<span class="lqs-verdict-tag">${t}</span>`).join('')}
        </div>
      ` : ''}
    `;
  }

  // Синхронизация значений уже вставленной формы с базой (защита от сброса при React 18 Hydration после F5)
  function syncExistingPanelUI(panel, review, meta) {
    const r = (review && review.rating) ? Number(review.rating) : 0;
    const banned = Boolean(review && review.banned);
    const tags = (review && Array.isArray(review.tags)) ? review.tags : [];
    const note = (review && review.note) ? String(review.note) : '';

    const st = getStatusMeta(r, banned);
    const badge = panel.querySelector('#lqs-status-badge');
    if (badge) {
      badge.className = `lqs-status-pill ${st.cls}`;
      badge.textContent = st.text;
    }

    panel.querySelectorAll('.lqs-star-btn').forEach((b) => {
      const s = parseInt(b.dataset.star, 10);
      const isActive = r >= s;
      b.classList.toggle('active', isActive);
      b.textContent = isActive ? '⭐' : '☆';
    });

    const banBtn = panel.querySelector('#lqs-ban-toggle');
    if (banBtn) {
      banBtn.classList.toggle('banned', banned);
      banBtn.textContent = banned ? '💀 В чёрном списке (разбанить)' : '🚫 В чёрный список';
    }

    panel.querySelectorAll('.lqs-tag-chip').forEach((chip) => {
      const t = chip.dataset.tag;
      chip.classList.toggle('selected', tags.includes(t));
    });

    const noteArea = panel.querySelector('#lqs-note-area');
    if (noteArea && document.activeElement !== noteArea) {
      if (noteArea.value !== note) {
        noteArea.value = note;
      }
    }

    // Обновляем смарт-бокс, если подгрузились цена/вес/состав
    const smartBox = panel.querySelector('#lqs-smart-box');
    if (smartBox && meta) {
      const smart = analyzeProductQuality(meta);
      smartBox.innerHTML = `
        <div class="lqs-smart-line">
          <span>⚖️ <strong>Реальная цена:</strong></span>
          <span>${smart.pricePerKg ? `<strong>~${smart.pricePerKg} ₽</strong> за 1 кг/л` : 'Вес уточняется...'}</span>
        </div>
        <div class="lqs-flag-list">
          ${smart.flags.map((f) => `<span class="lqs-flag-${f.type}">${f.text}</span>`).join('')}
        </div>
      `;
    }
  }

  // Рендер смарт-панели на странице товара main[data-testid="good-page-desktop"]
  async function renderProductPageWidget() {
    if (isRenderingProduct) return;
    const slug = extractSlugFromUrl(window.location.href);
    const mainPage = document.querySelector('main[data-testid="good-page-desktop"]');
    if (!slug || !mainPage) return;

    const infoBlock = mainPage.querySelector('div[data-testid="product-info"]') ||
                      mainPage.querySelector('div[data-testid="product-card-header"]');
    if (!infoBlock) return;

    isRenderingProduct = true;
    try {
      const db = await getReviewsDB();
      const meta = extractProductPageMetadata();
      const savedReview = findReviewInDB(db, {
        slug,
        productId: meta.productId,
        imageKey: meta.imageKey,
        cleanTitle: meta.cleanTitle
      });

      const current = {
        rating: (savedReview && savedReview.rating) ? Number(savedReview.rating) : 0,
        note: (savedReview && savedReview.note) ? String(savedReview.note) : '',
        tags: (savedReview && Array.isArray(savedReview.tags)) ? [...savedReview.tags] : [],
        banned: Boolean(savedReview && savedReview.banned)
      };

      // Всегда рисуем/обновляем верхний баннер вердикта под заголовком товара
      renderVerdictBanner(mainPage, current);
      guardAddToCartButton(current);

      let existing = mainPage.querySelector('.lqs-product-panel');
      if (existing && existing.dataset.slug === slug) {
        syncExistingPanelUI(existing, current, meta);
        return;
      }
      if (existing) existing.remove();

      const smart = analyzeProductQuality(meta);
      const status = getStatusMeta(current.rating, current.banned);

      const panel = document.createElement('div');
      panel.className = 'lqs-product-panel';
      panel.dataset.slug = slug;

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
            <span class="lqs-tag-chip ${current.tags.includes(tag) ? 'selected' : ''}" data-tag="${tag}">
              ${tag}
            </span>
          `).join('')}
        </div>

        <div class="lqs-note-wrap">
          <textarea class="lqs-note-input" id="lqs-note-area" placeholder="Твой личный вердикт (например: «Тесто разваливается, начинка из сои, больше не брать»)..."></textarea>
          <div class="lqs-save-row">
            <span class="lqs-save-toast" id="lqs-save-toast">✅ Сохранено в базу!</span>
            <button type="button" class="lqs-save-btn" id="lqs-save-btn">💾 Сохранить отзыв</button>
          </div>
        </div>

        <div class="lqs-smart-box" id="lqs-smart-box">
          <div class="lqs-smart-line">
            <span>⚖️ <strong>Реальная цена:</strong></span>
            <span>${smart.pricePerKg ? `<strong>~${smart.pricePerKg} ₽</strong> за 1 кг/л` : 'Вес уточняется...'}</span>
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

      // Явно выставляем .value для textarea после вставки в DOM (чтобы React Hydration не сбрасывал текст)
      const noteArea = panel.querySelector('#lqs-note-area');
      noteArea.value = current.note;

      let toastTimer = null;
      const showSavedToast = () => {
        const toast = panel.querySelector('#lqs-save-toast');
        if (!toast) return;
        toast.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
      };

      const persistState = async () => {
        const latestMeta = extractProductPageMetadata();
        current.note = noteArea.value;
        const updated = await saveProductReview(slug, {
          title: latestMeta.title || meta.title,
          cleanTitle: latestMeta.cleanTitle || meta.cleanTitle,
          brand: latestMeta.brand || meta.brand,
          productId: latestMeta.productId || meta.productId,
          imageKey: latestMeta.imageKey || meta.imageKey,
          price: latestMeta.price || meta.price,
          rating: current.rating,
          banned: current.banned,
          tags: current.tags,
          note: current.note
        });

        syncExistingPanelUI(panel, updated, latestMeta);
        renderVerdictBanner(mainPage, updated);
        guardAddToCartButton(updated);
        decorateCatalogCards();
        showSavedToast();
      };

      panel.querySelectorAll('.lqs-star-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const val = parseInt(btn.dataset.star, 10);
          current.rating = current.rating === val ? 0 : val;
          if (current.rating > 0 && current.rating <= 2) {
            current.banned = true;
          } else if (current.rating >= 4) {
            current.banned = false;
          }
          persistState();
        });
      });

      panel.querySelector('#lqs-ban-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        current.banned = !current.banned;
        if (current.banned && current.rating === 0) current.rating = 1;
        persistState();
      });

      panel.querySelectorAll('.lqs-tag-chip').forEach((chip) => {
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const tag = chip.dataset.tag;
          if (current.tags.includes(tag)) {
            current.tags = current.tags.filter((t) => t !== tag);
          } else {
            current.tags.push(tag);
          }
          persistState();
        });
      });

      let noteTimeout = null;
      noteArea.addEventListener('input', () => {
        current.note = noteArea.value;
        clearTimeout(noteTimeout);
        noteTimeout = setTimeout(persistState, 400);
      });

      noteArea.addEventListener('change', persistState);

      panel.querySelector('#lqs-save-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(noteTimeout);
        persistState();
      });
    } finally {
      isRenderingProduct = false;
    }
  }

  // Защита кнопки «В корзину» button[data-testid="snippet-control"] от случайной покупки шлака
  function guardAddToCartButton(review) {
    const addBtn = document.querySelector('main[data-testid="good-page-desktop"] button[data-testid="snippet-control"]');
    if (!addBtn) return;

    const isBad = review && (review.banned || (review.rating > 0 && review.rating <= 2));
    addBtn.dataset.lqsBad = isBad ? 'true' : 'false';
    addBtn.dataset.lqsNote = (review && review.note) ? review.note : '';
    addBtn.dataset.lqsRating = (review && review.rating) ? String(review.rating) : '1';

    if (isBad) {
      addBtn.style.background = '#7f1d1d';
      addBtn.style.color = '#fecaca';
      addBtn.title = `Твой отзыв: ${review.note || 'Не брать!'}`;
      if (!addBtn.dataset.lqsGuarded) {
        addBtn.dataset.lqsGuarded = 'true';
        addBtn.addEventListener('click', (e) => {
          if (addBtn.dataset.lqsBad === 'true') {
            const ok = window.confirm(
              `⚠️ СТОП! Ты сам забанил этот продукт (${addBtn.dataset.lqsRating}⭐).\n\nТвоя заметка: "${addBtn.dataset.lqsNote || 'Плохое качество'}"\n\nТочно хочешь положить его в корзину?`
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

  // Извлечение ключей карточки каталога (работает и для карточек со ссылкой /good/, и для карточек в /recents с product-id-...)
  function extractCardIdentifiers(card) {
    const linkEl = card.querySelector('a[href*="/good/"]') || card.closest('a[href*="/good/"]');
    const slug = linkEl ? extractSlugFromUrl(linkEl.getAttribute('href')) : null;

    let productId = null;
    const idHolder = card.closest('[data-testid^="product-id-"]') || card.querySelector('[data-testid^="product-id-"]');
    if (idHolder) {
      const tid = idHolder.getAttribute('data-testid') || '';
      productId = tid.replace(/^product-id-/, '').trim() || null;
    }

    const imgEl = card.querySelector('img[data-testid="product-snippet-thumb-image"], img');
    const imageKey = imgEl ? extractImageKey(imgEl.getAttribute('src')) : null;
    const imgAlt = imgEl ? imgEl.getAttribute('alt') : '';
    const cleanTitle = normalizeTitle(imgAlt);

    return { slug, productId, imageKey, cleanTitle };
  }

  // Разметка всех карточек каталога, поиска, апсейла и «Вы покупали» div[data-testid="product-card"]
  async function decorateCatalogCards() {
    const db = await getReviewsDB();
    const cards = document.querySelectorAll('div[data-testid="product-card"]');

    cards.forEach((card) => {
      const ids = extractCardIdentifiers(card);
      const review = findReviewInDB(db, ids);

      const oldBadge = card.querySelector('.lqs-card-badge');
      const oldNote = card.querySelector('.lqs-card-note-preview');
      if (oldBadge) oldBadge.remove();
      if (oldNote) oldNote.remove();
      card.classList.remove('lqs-card-dimmed');

      if (!review || (review.rating === 0 && !review.banned && (!review.note || !review.note.trim()))) return;

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

      if (review.note && review.note.trim()) {
        const notePreview = document.createElement('div');
        notePreview.className = 'lqs-card-note-preview';
        notePreview.textContent = `💬 ${review.note}`;
        card.appendChild(notePreview);
      }
    });
  }

  // Запуск и серия контрольных синхронизаций после гидратации React 18 (при F5 и SPA-переходах)
  let debounceTimer = null;
  function scheduleUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      renderProductPageWidget();
      decorateCatalogCards();
    }, 150);
  }

  function runHydrationResyncWave() {
    [100, 400, 900, 1800].forEach((delay) => {
      setTimeout(() => {
        renderProductPageWidget();
        decorateCatalogCards();
      }, delay);
    });
  }

  const observer = new MutationObserver(() => {
    scheduleUpdate();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        renderProductPageWidget();
        decorateCatalogCards();
      }
    });
  }

  window.addEventListener('popstate', runHydrationResyncWave);
  window.addEventListener('load', runHydrationResyncWave);
  runHydrationResyncWave();
})();
