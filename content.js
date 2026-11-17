/**
 * Lavka Quality Shield v2.0.1 — Content Script
 * - Исправлена верстка и защита от наследования нулевого line-height/height из CSS Яндекс Лавки
 * - Аккуратная двухстрочная панель + выпадающий спойлер + кнопка принудительного пересчета ИИ (🔄)
 * - Поддержка локального FastAPI (127.0.0.1:8765) и прямого подключения к Gemini 4 Argon (localhost:8083/v1)
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'lqs_reviews_v1';
  const SETTINGS_KEY = 'lqs_settings_v2';

  const DEFAULT_SETTINGS = {
    backendUrl: 'http://127.0.0.1:8765',
    aiBaseUrl: 'http://localhost:8083/v1',
    aiApiKey: '',
    aiModel: 'gemini-4-argon',
    useDirectBrowserAiFallback: true
  };

  const PRESET_TAGS = [
    '🔥 Топ',
    '🥩 В аэрогриль / су-вид',
    '🥑 Кето',
    '🧂 Пересолено',
    '💧 Водянистое',
    '🤢 Химоза',
    '💀 Не брать'
  ];

  let isRenderingProduct = false;

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

  function extractImageKey(src) {
    if (!src) return null;
    const m = src.match(/get-grocery-goods\/(\d+\/[a-f0-9-]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  function extractSlugFromUrl(urlStr) {
    if (!urlStr) return null;
    try {
      const u = new URL(urlStr, window.location.origin);
      const match = u.pathname.replace(/\/+$/, '').match(/\/good\/([^/?#]+)/i);
      return match ? decodeURIComponent(match[1]).toLowerCase().trim() : null;
    } catch {
      return null;
    }
  }

  function formatAiTextToHtml(rawText) {
    if (!rawText) return '';
    const escaped = String(rawText)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

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

  async function getSettings() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([SETTINGS_KEY], (res) => {
          resolve({ ...DEFAULT_SETTINGS, ...(res && res[SETTINGS_KEY] ? res[SETTINGS_KEY] : {}) });
        });
      } else {
        resolve(DEFAULT_SETTINGS);
      }
    });
  }

  function findReviewInDB(db, keys) {
    if (!db) return null;
    const { slug, productId, imageKey, cleanTitle } = keys;
    if (slug && db[slug]) return db[slug];

    for (const item of Object.values(db)) {
      if (!item) continue;
      if (slug && item.slug && item.slug.toLowerCase() === slug) return item;
      if (productId && item.productId && item.productId === productId) return item;
      if (imageKey && item.imageKey && item.imageKey === imageKey) return item;
      if (cleanTitle && item.cleanTitle && item.cleanTitle === cleanTitle) return item;
    }
    return null;
  }

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
    document.querySelectorAll('script[data-testid="ldjson"], script[type="application/ld+json"]').forEach((el) => {
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
        // ignore
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

  function analyzeProductQuality(meta) {
    const flags = [];
    let pricePerKg = null;
    let weightGrams = null;
    let proteinPer100g = null;
    let pricePer100gProtein = null;

    if (meta.amountText) {
      const m = meta.amountText.match(/([\d.,]+)\s*(г|кг|мл|л)/i);
      if (m) {
        const val = parseFloat(m[1].replace(',', '.'));
        const unit = m[2].toLowerCase();
        if (val > 0) {
          weightGrams = (unit === 'кг' || unit === 'л') ? val * 1000 : val;
          if (meta.price) {
            pricePerKg = Math.round((meta.price / weightGrams) * 1000);
          }
        }
      }
    }

    if (meta.traitsText) {
      const protMatch = meta.traitsText.match(/([\d.,]+)\s*белк/i) || meta.traitsText.match(/белки[^\d]*([\d.,]+)/i);
      if (protMatch) {
        proteinPer100g = parseFloat(protMatch[1].replace(',', '.'));
        if (proteinPer100g > 0 && pricePerKg) {
          const totalProteinInKg = proteinPer100g * 10;
          pricePer100gProtein = Math.round((pricePerKg / totalProteinInKg) * 100);
        }
      }

      const carbMatch = meta.traitsText.match(/([\d.,]+)\s*углевод/i) || meta.traitsText.match(/углеводы[^\d]*([\d.,]+)/i);
      if (carbMatch) {
        const carbs = parseFloat(carbMatch[1].replace(',', '.'));
        if (!isNaN(carbs)) {
          if (carbs <= 5) {
            flags.push({ type: 'good', text: `🥑 Кето (${carbs}г угл)` });
          } else if (carbs >= 22) {
            flags.push({ type: 'bad', text: `🍞 ${carbs}г угл` });
          }
        }
      }
    }

    const ingLower = (meta.ingredientsText || '').toLowerCase();
    if (ingLower) {
      const badMatchers = [
        { regex: /механической обвалки|ммо/i, label: '⚠️ ММО' },
        { regex: /мальтодекстрин|патока|глюкозно-фруктозный/i, label: '🍬 Сахар/патока' },
        { regex: /заменитель молочного жира|пальмовое масло/i, label: '🛢️ ЗМЖ/пальма' },
        { regex: /соевый белок|соевая мука|клетчатка пшеничная/i, label: '🌾 Соя/клетчатка' },
        { regex: /глутамат|е621|ароматизатор/i, label: '🧪 Ароматизатор' },
        { regex: /крахмал/i, label: '🥔 Крахмал' }
      ];

      badMatchers.forEach((item) => {
        if (item.regex.test(ingLower)) {
          flags.push({ type: 'bad', text: item.label });
        }
      });

      if (flags.length === 0 && ingLower.length > 10) {
        flags.push({ type: 'good', text: '✅ Чистый состав' });
      }
    }

    return { pricePerKg, pricePer100gProtein, flags: flags.slice(0, 4) };
  }

  function syncExistingPanelUI(panel, review, meta) {
    const r = (review && review.rating) ? Number(review.rating) : 0;
    const banned = Boolean(review && review.banned);
    const tags = (review && Array.isArray(review.tags)) ? review.tags : [];
    const note = (review && review.note) ? String(review.note) : '';

    panel.classList.toggle('is-banned', banned || (r > 0 && r <= 2));
    panel.classList.toggle('is-god', !banned && r >= 4);

    panel.querySelectorAll('.lqs-star-btn').forEach((b) => {
      const s = parseInt(b.dataset.star, 10);
      b.classList.toggle('active', r >= s);
    });

    const banBtn = panel.querySelector('#lqs-ban-toggle');
    if (banBtn) {
      banBtn.classList.toggle('ban-active', banned);
      banBtn.textContent = banned ? '💀 В бане' : '🚫';
    }

    const notePill = panel.querySelector('#lqs-inline-note');
    if (notePill) {
      const summaryText = note.trim() || tags.join(' ');
      if (summaryText) {
        notePill.classList.remove('is-hidden');
        notePill.textContent = `💬 ${summaryText}`;
        notePill.title = summaryText;
      } else {
        notePill.classList.add('is-hidden');
        notePill.textContent = '';
      }
    }

    panel.querySelectorAll('.lqs-tag-chip').forEach((chip) => {
      chip.classList.toggle('selected', tags.includes(chip.dataset.tag));
    });

    const noteArea = panel.querySelector('#lqs-note-area');
    if (noteArea && document.activeElement !== noteArea && noteArea.value !== note) {
      noteArea.value = note;
    }

    const row2 = panel.querySelector('#lqs-row-2');
    if (row2 && meta) {
      const smart = analyzeProductQuality(meta);
      row2.innerHTML = `
        <span class="lqs-metric-pill">⚖️ ${smart.pricePerKg ? `~${smart.pricePerKg} ₽/кг` : 'Цена/кг —'}</span>
        ${smart.pricePer100gProtein ? `<span class="lqs-metric-pill">🥩 ~${smart.pricePer100gProtein} ₽ / 100г белка</span>` : ''}
        ${smart.flags.map((f) => `<span class="lqs-flag-${f.type}">${f.text}</span>`).join('')}
      `;
    }
  }

  async function requestAiProductReview(meta, panel, forceRefresh = false) {
    const drawer = panel.querySelector('#lqs-drawer');
    const drawerToggle = panel.querySelector('#lqs-drawer-toggle');
    const aiBox = panel.querySelector('#lqs-ai-box');
    const aiContent = panel.querySelector('#lqs-ai-content');
    const aiSources = panel.querySelector('#lqs-ai-sources');

    drawer.classList.add('open');
    if (drawerToggle) drawerToggle.textContent = '▴ Скрыть';
    aiBox.classList.add('visible');
    aiContent.innerHTML = '⏳ Ищу отзывы в сети и спрашиваю ИИ-ревизора...';
    aiSources.innerHTML = '';

    const settings = await getSettings();

    // 1. Локальный FastAPI сервер (парсинг Отзовик/IRecommend/Роскачество + кэш SQLite)
    try {
      const resp = await fetch(`${settings.backendUrl.replace(/\/$/, '')}/api/analyze-product`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: extractSlugFromUrl(window.location.href),
          title: meta.title,
          brand: meta.brand,
          amount: meta.amountText,
          price: meta.price,
          ingredients: meta.ingredientsText,
          traits: meta.traitsText,
          aiBaseUrl: settings.aiBaseUrl,
          aiApiKey: settings.aiApiKey,
          aiModel: settings.aiModel,
          forceRefresh: Boolean(forceRefresh)
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        aiContent.innerHTML = formatAiTextToHtml(data.verdict || 'Вердикт получен.');
        if (Array.isArray(data.sources) && data.sources.length > 0) {
          aiSources.innerHTML = data.sources
            .map((s) => `<a href="${s.url}" target="_blank" rel="noopener noreferrer">🔗 ${s.title || 'Источник'}</a>`)
            .join('');
        }
        return;
      }
    } catch {
      // Переходим к прямому вызову Cookie-моста
    }

    // 2. Прямой фоллбэк к локальному мосту Gemini 4 Argon (localhost:8083/v1)
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (settings.aiApiKey) {
        headers.Authorization = `Bearer ${settings.aiApiKey}`;
      }
      const prompt = [
        `Сделай ультра-короткий (максимум 3 строчки) разбор продукта из Яндекс Лавки в стиле честного продуктового ревизора:`,
        `Товар: ${meta.title} (${meta.amountText || 'вес не указан'}, цена: ${meta.price || '?'} ₽)`,
        `Состав: ${meta.ingredientsText || 'не указан'}`,
        `КБЖУ: ${meta.traitsText || 'не указано'}`,
        `Формат: 1) Что по составу/белку и реальной цене, 2) Главный подвох или плюс, 3) Вердикт (Брать или Скипать).`
      ].join('\n');

      const directResp = await fetch(`${settings.aiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
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
        const reply = json.choices?.[0]?.message?.content || 'Нет ответа от модели.';
        aiContent.innerHTML = formatAiTextToHtml(reply);
        aiSources.innerHTML = `<span style="color:#75736f;font-size:11.5px;">⚡ Напрямую через ${settings.aiModel} (запусти start_server.bat для поиска отзывов по сайтам)</span>`;
        return;
      }
    } catch {
      // ignore
    }

    aiContent.innerHTML =
      `⚠️ Не удалось подключиться к локальному серверу <code>${settings.backendUrl}</code> или ИИ-мосту <code>${settings.aiBaseUrl}</code>.<br>` +
      `Запусти <code>start_server.bat</code> или проверь API Key в настройках иконки расширения.`;
  }

  async function renderProductPageWidget() {
    if (isRenderingProduct) return;
    const slug = extractSlugFromUrl(window.location.href);
    const mainPage = document.querySelector('main[data-testid="good-page-desktop"]');
    if (!slug || !mainPage) return;

    const oldVerdictBanner = mainPage.querySelector('.lqs-verdict-banner');
    if (oldVerdictBanner) oldVerdictBanner.remove();

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

      guardAddToCartButton(current);

      let existing = mainPage.querySelector('.lqs-product-panel');
      if (existing && existing.dataset.slug === slug) {
        syncExistingPanelUI(existing, current, meta);
        return;
      }
      if (existing) existing.remove();

      const smart = analyzeProductQuality(meta);
      const summaryText = current.note.trim() || current.tags.join(' ');

      const panel = document.createElement('div');
      panel.className = `lqs-product-panel ${current.banned || (current.rating > 0 && current.rating <= 2) ? 'is-banned' : (current.rating >= 4 ? 'is-god' : '')}`;
      panel.dataset.slug = slug;

      panel.innerHTML = `
        <div class="lqs-compact-row-1">
          <div class="lqs-left-group">
            <div class="lqs-stars-inline" id="lqs-stars-box">
              ${[1, 2, 3, 4, 5].map((n) => `
                <button type="button" class="lqs-star-btn ${current.rating >= n ? 'active' : ''}" data-star="${n}" title="Оценить на ${n}">★</button>
              `).join('')}
            </div>

            <span class="lqs-inline-note-pill ${summaryText ? '' : 'is-hidden'}" id="lqs-inline-note" title="${summaryText.replace(/"/g, '&quot;')}">
              💬 ${summaryText}
            </span>
          </div>

          <div class="lqs-actions-inline">
            <button type="button" class="lqs-mini-btn ${current.banned ? 'ban-active' : ''}" id="lqs-ban-toggle" title="В чёрный список">
              ${current.banned ? '💀 В бане' : '🚫'}
            </button>
            <button type="button" class="lqs-mini-btn ai-btn" id="lqs-ai-btn" title="Найти отзывы в сети и спросить ИИ">
              🤖 ИИ-обзор
            </button>
            <button type="button" class="lqs-mini-btn" id="lqs-drawer-toggle" title="Открыть заметку и теги">
              ▾ Отзыв
            </button>
          </div>
        </div>

        <div class="lqs-compact-row-2" id="lqs-row-2">
          <span class="lqs-metric-pill">⚖️ ${smart.pricePerKg ? `~${smart.pricePerKg} ₽/кг` : 'Цена/кг —'}</span>
          ${smart.pricePer100gProtein ? `<span class="lqs-metric-pill">🥩 ~${smart.pricePer100gProtein} ₽ / 100г белка</span>` : ''}
          ${smart.flags.map((f) => `<span class="lqs-flag-${f.type}">${f.text}</span>`).join('')}
        </div>

        <div class="lqs-drawer" id="lqs-drawer">
          <div class="lqs-tags-row">
            ${PRESET_TAGS.map((tag) => `
              <span class="lqs-tag-chip ${current.tags.includes(tag) ? 'selected' : ''}" data-tag="${tag}">${tag}</span>
            `).join('')}
          </div>
          <div class="lqs-note-wrap">
            <textarea class="lqs-note-input" id="lqs-note-area" rows="2" placeholder="Короткая заметка о товаре..."></textarea>
            <button type="button" class="lqs-save-btn" id="lqs-save-btn">💾 Ок</button>
          </div>
          <div class="lqs-ai-box" id="lqs-ai-box">
            <div class="lqs-ai-header">
              <span>🤖 Сводка отзывов + разбор состава</span>
              <button type="button" class="lqs-ai-refresh-btn" id="lqs-ai-refresh" title="Принудительно обновить ИИ-обзор">🔄 Обновить</button>
            </div>
            <div class="lqs-ai-content" id="lqs-ai-content"></div>
            <div class="lqs-ai-sources" id="lqs-ai-sources"></div>
          </div>
        </div>
      `;

      // Вставляем строго как соседний блок после bar-container (снаружи его внутренности), чтобы не ловить чужой flex/grid
      const barContainer = infoBlock.querySelector('div[data-testid="bar-container"]');
      if (barContainer && barContainer.parentNode) {
        barContainer.parentNode.insertBefore(panel, barContainer.nextSibling);
      } else {
        infoBlock.prepend(panel);
      }

      const noteArea = panel.querySelector('#lqs-note-area');
      noteArea.value = current.note;

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
        guardAddToCartButton(updated);
        decorateCatalogCards();
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

      panel.querySelector('#lqs-drawer-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const drawer = panel.querySelector('#lqs-drawer');
        const isOpen = drawer.classList.toggle('open');
        e.currentTarget.textContent = isOpen ? '▴ Скрыть' : '▾ Отзыв';
      });

      panel.querySelector('#lqs-ai-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const latestMeta = extractProductPageMetadata();
        requestAiProductReview(latestMeta, panel, false);
      });

      panel.querySelector('#lqs-ai-refresh').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const latestMeta = extractProductPageMetadata();
        requestAiProductReview(latestMeta, panel, true);
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

      panel.querySelector('#lqs-save-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(noteTimeout);
        persistState();
        const saveBtn = e.currentTarget;
        saveBtn.textContent = '✅ Ок';
        setTimeout(() => { saveBtn.textContent = '💾 Ок'; }, 1200);
      });
    } finally {
      isRenderingProduct = false;
    }
  }

  function guardAddToCartButton(review) {
    const addBtn = document.querySelector('main[data-testid="good-page-desktop"] button[data-testid="snippet-control"]');
    if (!addBtn) return;

    const isBad = review && (review.banned || (review.rating > 0 && review.rating <= 2));
    addBtn.dataset.lqsBad = isBad ? 'true' : 'false';
    addBtn.dataset.lqsNote = (review && review.note) ? review.note : '';
    addBtn.dataset.lqsRating = (review && review.rating) ? String(review.rating) : '1';

    if (isBad) {
      addBtn.style.background = '#fee2e2';
      addBtn.style.color = '#991b1b';
      if (!addBtn.dataset.lqsGuarded) {
        addBtn.dataset.lqsGuarded = 'true';
        addBtn.addEventListener('click', (e) => {
          if (addBtn.dataset.lqsBad === 'true') {
            const ok = window.confirm(
              `⚠️ Этот товар у тебя в чёрном списке (${addBtn.dataset.lqsRating}★).\nЗаметка: "${addBtn.dataset.lqsNote || 'Не брать'}"\n\nВсё равно добавить в корзину?`
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

  function extractCardIdentifiers(card) {
    const linkEl = card.querySelector('a[href*="/good/"]') || card.closest('a[href*="/good/"]');
    const slug = linkEl ? extractSlugFromUrl(linkEl.getAttribute('href')) : null;

    let productId = null;
    const idHolder = card.closest('[data-testid^="product-id-"], [data-testid^="cart_item_"]') ||
                     card.querySelector('[data-testid^="product-id-"], [data-testid^="cart_item_"]');
    if (idHolder) {
      const tid = idHolder.getAttribute('data-testid') || '';
      productId = tid.replace(/^(product-id-|cart_item_)/, '').trim() || null;
    }

    const imgEl = card.querySelector('img[data-testid="product-snippet-thumb-image"], img[data-testid="snippet-image"], img');
    const imageKey = imgEl ? extractImageKey(imgEl.getAttribute('src')) : null;
    const imgAlt = imgEl ? imgEl.getAttribute('alt') : '';
    const cleanTitle = normalizeTitle(imgAlt);

    return { slug, productId, imageKey, cleanTitle };
  }

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
        badge.textContent = `💀 ${review.rating ? review.rating + '★' : 'БАН'}`;
        card.classList.add('lqs-card-dimmed');
      } else if (review.rating >= 4) {
        badge.className = 'lqs-card-badge god';
        badge.textContent = `★ ${review.rating}`;
      } else {
        badge.className = 'lqs-card-badge ok';
        badge.textContent = `★ ${review.rating}`;
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

  let debounceTimer = null;
  function scheduleUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      renderProductPageWidget();
      decorateCatalogCards();
    }, 140);
  }

  function runHydrationResyncWave() {
    [0, 150, 400, 900, 1800, 3000].forEach((delay) => {
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
      if (area === 'local' && (changes[STORAGE_KEY] || changes[SETTINGS_KEY])) {
        renderProductPageWidget();
        decorateCatalogCards();
      }
    });
  }

  window.addEventListener('popstate', runHydrationResyncWave);
  window.addEventListener('load', runHydrationResyncWave);
  runHydrationResyncWave();
})();
