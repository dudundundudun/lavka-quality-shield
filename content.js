/**
 * Lavka Quality Shield v2.0.3 — Content Script (Zero-Thrash & Built-in Diagnostics)
 * Что исправлено в v2.0.3:
 * 1. Устранён бесконечный цикл MutationObserver (каждые 140 мс):
 *    - Мутации внутри собственных элементов расширения (.lqs-*) полностью игнорируются наблюдателем.
 *    - Кнопка «▾ Подробнее» больше НЕ перезаписывает свой innerHTML при фоновых синхронизациях,
 *      благодаря чему дочерний <span> не уничтожается между mousedown и mouseup (клики срабатывают с 1-го раза 100% времени).
 *    - Все дочерние элементы внутри кнопок получили pointer-events: none !important.
 *    - Метрики, флаги и бейджи каталога обновляются только при реальном изменении данных (проверка хеша состояния).
 * 2. Сохранение состояния открытого спойлера (drawerOpenBySlug) даже при полном пересоздании DOM-контейнера React-ом Лавки.
 * 3. Встроенная система диагностики и телеметрии (LQS Diagnostics):
 *    - Отслеживает мутации DOM, сэкономленные перезаписи, задержку кликов (pointerdown -> click), осиротевшие клики,
 *      найденные селекторы Лавки и статус связи с FastAPI (:8765) и Gemini Argon (:8083).
 *    - Открывается кнопкой «🩺 Диаг.» внутри спойлера, хоткеем Alt+Shift+D или из popup-окна расширения.
 */

(function () {
  'use strict';

  const VERSION = '2.0.4';
  const STORAGE_KEY = 'lqs_reviews_v1';
  const SETTINGS_KEY = 'lqs_settings_v2';
  const DIAG_STORAGE_KEY = 'lqs_diag_snapshot_v1';

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

  // Память открытых спойлеров по slug товара, чтобы React-ререндер Лавки не захлопывал меню
  const drawerOpenBySlug = new Map();

  let isRenderingProduct = false;
  let pendingProductRender = false;
  let currentReviewCache = null;

  // ==========================================================================
  // ВСТРОЕННАЯ СИСТЕМА ДИАГНОСТИКИ И ТЕЛЕМЕТРИИ (LQS_DIAG)
  // ==========================================================================
  const LQS_DIAG = {
    version: VERSION,
    startedAt: new Date().toISOString(),
    counters: {
      extMutations: 0,
      selfMutationsIgnored: 0,
      scheduleCalls: 0,
      panelMounts: 0,
      panelSyncs: 0,
      domWritesExecuted: 0,
      domWritesSkipped: 0,
      catalogPasses: 0,
      catalogBadgesUpdated: 0,
      catalogBadgesSkipped: 0,
      clicksTotal: 0,
      drawerToggles: 0,
      missedClicks: 0,
      errors: 0
    },
    lastClickLatencyMs: null,
    lastAiCall: {
      time: null,
      mode: 'none',
      status: 'idle',
      latencyMs: null,
      error: null
    },
    lastDomAudit: {},
    logs: [],

    log(type, msg, extra = null) {
      const now = new Date();
      const ts = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
      const entry = {
        ts,
        type,
        msg,
        extra: extra ? (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''
      };
      this.logs.unshift(entry);
      if (this.logs.length > 45) {
        this.logs.length = 45;
      }
      this.refreshDiagnosticBoxUI();
      this.persistSnapshotThrottled();
    },

    error(where, err) {
      this.counters.errors += 1;
      const errMsg = err && err.message ? err.message : String(err);
      this.log('ERROR', `[${where}] ${errMsg}`);
    },

    auditCurrentPageSelectors() {
      const slug = extractSlugFromUrl(window.location.href);
      const mainPage = document.querySelector('main[data-testid="good-page-desktop"]');
      const infoBlock = mainPage
        ? (mainPage.querySelector('div[data-testid="product-info"]') || mainPage.querySelector('div[data-testid="product-card-header"]'))
        : null;
      const barContainer = infoBlock ? infoBlock.querySelector('div[data-testid="bar-container"]') : null;
      const titleEl = document.querySelector('h1[data-testid="product-title"]');
      const priceEl = document.querySelector('span[data-testid="price-text"]');
      const amountEl = document.querySelector('span[data-testid="product-amount"]');
      const ingredientsEl = document.querySelector('section[data-testid="ingredients-block"]');
      const traitsEl = document.querySelector('section[data-testid="traits-block"]');
      const panelEl = document.querySelector('.lqs-product-panel');
      const drawerEl = panelEl ? panelEl.querySelector('#lqs-drawer') : null;
      const catalogCardsCount = document.querySelectorAll('div[data-testid="product-card"]').length;

      this.lastDomAudit = {
        url: window.location.href,
        slug: slug || null,
        isProductPage: Boolean(slug && mainPage),
        selectors: {
          mainPage: Boolean(mainPage),
          infoBlock: Boolean(infoBlock),
          barContainer: Boolean(barContainer),
          titleEl: Boolean(titleEl),
          priceEl: Boolean(priceEl),
          amountEl: Boolean(amountEl),
          ingredientsEl: Boolean(ingredientsEl),
          traitsEl: Boolean(traitsEl),
          panelMounted: Boolean(panelEl),
          drawerOpen: Boolean(drawerEl && drawerEl.classList.contains('open'))
        },
        catalogCardsCount
      };
      return this.lastDomAudit;
    },

    buildTextReport() {
      const audit = this.auditCurrentPageSelectors();
      const c = this.counters;
      const s = audit.selectors || {};
      const flag = (v) => (v ? 'OK' : 'MISS');

      const lines = [
        `=== LAVKA QUALITY SHIELD v${this.version} DIAGNOSTIC REPORT ===`,
        `Time: ${new Date().toISOString()}`,
        `URL: ${audit.url}`,
        `Slug: ${audit.slug || 'N/A (каталог)'} | Карточек в каталоге: ${audit.catalogCardsCount}`,
        ``,
        `[DOM SELECTORS AUDIT]`,
        `mainPage: ${flag(s.mainPage)} | infoBlock: ${flag(s.infoBlock)} | barContainer: ${flag(s.barContainer)}`,
        `title: ${flag(s.titleEl)} | price: ${flag(s.priceEl)} | amount: ${flag(s.amountEl)} | ingredients: ${flag(s.ingredientsEl)} | traits: ${flag(s.traitsEl)}`,
        `panelMounted: ${flag(s.panelMounted)} | drawerOpen: ${s.drawerOpen ? 'OPEN' : 'CLOSED'}`,
        ``,
        `[TELEMETRY & ANTI-LOOP COUNTERS]`,
        `Panel Mounts: ${c.panelMounts} | Panel Syncs: ${c.panelSyncs}`,
        `DOM Writes Executed: ${c.domWritesExecuted} | DOM Writes Skipped (cached): ${c.domWritesSkipped}`,
        `Observer External Mutations: ${c.extMutations} | Self-Mutations Ignored: ${c.selfMutationsIgnored}`,
        `Catalog Passes: ${c.catalogPasses} (Updated: ${c.catalogBadgesUpdated}, Skipped: ${c.catalogBadgesSkipped})`,
        `Clicks Total: ${c.clicksTotal} | Drawer Toggles: ${c.drawerToggles} | Missed Clicks: ${c.missedClicks} | Last Click Latency: ${this.lastClickLatencyMs !== null ? this.lastClickLatencyMs + 'ms' : 'N/A'}`,
        `Errors: ${c.errors}`,
        ``,
        `[AI & BACKEND STATUS]`,
        `Last Call: ${this.lastAiCall.time || 'never'} | Mode: ${this.lastAiCall.mode} | Status: ${this.lastAiCall.status} | Latency: ${this.lastAiCall.latencyMs ? this.lastAiCall.latencyMs + 'ms' : 'N/A'}`,
        this.lastAiCall.error ? `Last AI Error: ${this.lastAiCall.error}` : `Last AI Error: none`,
        ``,
        `[RECENT EVENT LOG (latest 20)]`,
        ...this.logs.slice(0, 20).map((l) => `${l.ts} [${l.type}] ${l.msg}${l.extra ? ' -> ' + l.extra : ''}`)
      ];
      return lines.join('\n');
    },

    refreshDiagnosticBoxUI() {
      const box = document.querySelector('#lqs-diag-box');
      if (!box || !box.classList.contains('visible')) return;

      const audit = this.auditCurrentPageSelectors();
      const s = audit.selectors || {};
      const c = this.counters;

      const metricsEl = box.querySelector('#lqs-diag-metrics');
      if (metricsEl) {
        const badge = (ok, label) =>
          `<span class="lqs-diag-pill ${ok ? 'ok' : 'warn'}">${ok ? '✅' : '⚠️'} ${label}</span>`;

        metricsEl.innerHTML = `
          <div class="lqs-diag-pills-row">
            ${badge(s.mainPage && s.infoBlock, 'DOM Лавки')}
            ${badge(s.titleEl && s.priceEl, 'Цена/Название')}
            ${badge(s.amountEl, 'Вес')}
            ${badge(s.ingredientsEl, 'Состав')}
            ${badge(s.traitsEl, 'КБЖУ')}
            ${badge(c.missedClicks === 0 && c.errors === 0, `Ошибок: ${c.errors}, Потерь клика: ${c.missedClicks}`)}
          </div>
          <div class="lqs-diag-stats-grid">
            <div><b>Маунтов панели:</b> ${c.panelMounts} (синков: ${c.panelSyncs})</div>
            <div><b>Записей в DOM:</b> ${c.domWritesExecuted} (пропущено дублей: ${c.domWritesSkipped})</div>
            <div><b>Мутаций Лавки:</b> ${c.extMutations} (отсечено своих: ${c.selfMutationsIgnored})</div>
            <div><b>Кликов / Спойлер:</b> ${c.clicksTotal} / ${c.drawerToggles} (${this.lastClickLatencyMs !== null ? this.lastClickLatencyMs + ' мс' : '—'})</div>
          </div>
        `;
      }

      const logEl = box.querySelector('#lqs-diag-log');
      if (logEl) {
        logEl.textContent = this.logs
          .slice(0, 15)
          .map((l) => `${l.ts} [${l.type}] ${l.msg}${l.extra ? ' ' + l.extra : ''}`)
          .join('\n') || 'Лог пуст';
      }
    },

    _saveTimer: null,
    persistSnapshotThrottled() {
      if (this._saveTimer) return;
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const snapshot = {
            updatedAt: new Date().toISOString(),
            counters: this.counters,
            lastClickLatencyMs: this.lastClickLatencyMs,
            lastAiCall: this.lastAiCall,
            lastDomAudit: this.auditCurrentPageSelectors(),
            reportText: this.buildTextReport()
          };
          chrome.storage.local.set({ [DIAG_STORAGE_KEY]: snapshot });
        }
      }, 600);
    }
  };

  // Перехватчик «осиротевших» кликов (если pointerdown на кнопке LQS был, а click за 400 мс не произошёл)
  let pendingPointerDown = null;
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.lqs-product-panel button, .lqs-product-panel .lqs-tag-chip') : null;
    if (!btn) return;
    const role = btn.id || btn.className;
    const t0 = performance.now();
    if (pendingPointerDown && pendingPointerDown.timer) {
      clearTimeout(pendingPointerDown.timer);
    }
    const timer = setTimeout(() => {
      LQS_DIAG.counters.missedClicks += 1;
      LQS_DIAG.log('WARN', `Потерян click после pointerdown на [${role}]! Выполняю авто-восстановление.`);
      // Если по какой-то внешней причине Лавка перебила нативный click на кнопке спойлера — дожимаем программно:
      if (btn.id === 'lqs-drawer-toggle') {
        toggleDrawerState(btn.closest('.lqs-product-panel'), 'auto-recovery');
      }
      pendingPointerDown = null;
    }, 420);
    pendingPointerDown = { role, t0, timer };
  }, true);

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.lqs-product-panel button, .lqs-product-panel .lqs-tag-chip') : null;
    if (!btn) return;
    LQS_DIAG.counters.clicksTotal += 1;
    if (pendingPointerDown) {
      clearTimeout(pendingPointerDown.timer);
      const dt = Math.round(performance.now() - pendingPointerDown.t0);
      LQS_DIAG.lastClickLatencyMs = dt;
      pendingPointerDown = null;
    }
  }, true);

  // Горячая клавиша Alt + Shift + D для быстрого открытия диагностики
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.code === 'KeyD' || e.key === 'D' || e.key === 'd' || e.key === 'в' || e.key === 'В')) {
      e.preventDefault();
      const panel = document.querySelector('.lqs-product-panel');
      if (panel) {
        const drawer = panel.querySelector('#lqs-drawer');
        if (drawer && !drawer.classList.contains('open')) {
          toggleDrawerState(panel, 'hotkey-AltShiftD');
        }
        toggleDiagnosticsPanel(panel);
      } else {
        const report = LQS_DIAG.buildTextReport();
        navigator.clipboard.writeText(report).catch(() => {});
        alert('🩺 Lavka Quality Shield v' + VERSION + '\nДиагностический отчёт скопирован в буфер обмена!\n\n' + report.slice(0, 600));
      }
    }
  });

  // Ответ на запросы из popup.js (живой пинг вкладки)
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === 'LQS_GET_DIAGNOSTICS') {
        sendResponse({
          ok: true,
          reportText: LQS_DIAG.buildTextReport(),
          counters: LQS_DIAG.counters,
          audit: LQS_DIAG.auditCurrentPageSelectors(),
          lastAiCall: LQS_DIAG.lastAiCall
        });
        return true;
      }
    });
  }

  // ==========================================================================
  // УТИЛИТЫ И РАБОТА С БАЗОЙ ОТЗЫВОВ
  // ==========================================================================
  function setHtmlIfChanged(el, nextHtml, tagKey = '') {
    if (!el) return false;
    if (el.dataset.lqsHtmlCache === nextHtml) {
      LQS_DIAG.counters.domWritesSkipped += 1;
      return false;
    }
    el.dataset.lqsHtmlCache = nextHtml;
    el.innerHTML = nextHtml;
    LQS_DIAG.counters.domWritesExecuted += 1;
    if (tagKey) {
      LQS_DIAG.log('DOM_WRITE', `Updated ${tagKey}`);
    }
    return true;
  }

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

    LQS_DIAG.log('STORAGE_SAVE', `Saved review for ${canonicalKey}`, {
      rating: data.rating,
      banned: data.banned,
      tagsCount: (data.tags || []).length
    });

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
    let unitLabel = 'кг';

    if (meta.amountText) {
      const m = meta.amountText.match(/([\d.,]+)\s*(г|кг|мл|л)/i);
      if (m) {
        const val = parseFloat(m[1].replace(',', '.'));
        const unit = m[2].toLowerCase();
        unitLabel = (unit === 'мл' || unit === 'л') ? 'л' : 'кг';
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

    return { pricePerKg, unitLabel, pricePer100gProtein, flags: flags.slice(0, 5) };
  }

  /**
   * Безопасное обновление кнопки «▾ Подробнее» БЕЗ пересоздания innerHTML!
   * Дочерние узлы #lqs-drawer-dot и #lqs-drawer-label остаются в DOM всегда,
   * поэтому клик мышью никогда не срывается между mousedown и mouseup.
   */
  function updateDrawerToggleButton(panel, isOpen, review, smart) {
    if (!panel) return;
    const dotEl = panel.querySelector('#lqs-drawer-dot');
    const labelEl = panel.querySelector('#lqs-drawer-label');
    if (!dotEl || !labelEl) return;

    const hasBadFlags = smart && Array.isArray(smart.flags) && smart.flags.some((f) => f.type === 'bad');
    const hasNoteOrTags = Boolean(
      review && ((review.note && review.note.trim()) || (Array.isArray(review.tags) && review.tags.length > 0))
    );

    let nextDotClass = 'lqs-dot-indicator is-hidden';
    let nextDotTitle = '';
    if (hasBadFlags) {
      nextDotClass = 'lqs-dot-indicator has-warn';
      nextDotTitle = 'Есть замечания к составу';
    } else if (hasNoteOrTags) {
      nextDotClass = 'lqs-dot-indicator has-note';
      nextDotTitle = 'Есть сохранённая заметка';
    }

    if (dotEl.className !== nextDotClass) {
      dotEl.className = nextDotClass;
      LQS_DIAG.counters.domWritesExecuted += 1;
    } else {
      LQS_DIAG.counters.domWritesSkipped += 1;
    }
    if (dotEl.title !== nextDotTitle) {
      dotEl.title = nextDotTitle;
    }

    const nextText = isOpen ? '▴ Скрыть' : '▾ Подробнее';
    if (labelEl.textContent !== nextText) {
      labelEl.textContent = nextText;
      LQS_DIAG.counters.domWritesExecuted += 1;
    } else {
      LQS_DIAG.counters.domWritesSkipped += 1;
    }
  }

  function toggleDrawerState(panel, source = 'click') {
    if (!panel) return false;
    const drawer = panel.querySelector('#lqs-drawer');
    if (!drawer) return false;

    const isOpen = drawer.classList.toggle('open');
    const slug = panel.dataset.slug || extractSlugFromUrl(window.location.href);
    if (slug) {
      drawerOpenBySlug.set(slug, isOpen);
    }

    const latestMeta = extractProductPageMetadata();
    const latestSmart = analyzeProductQuality(latestMeta);
    updateDrawerToggleButton(panel, isOpen, currentReviewCache, latestSmart);

    LQS_DIAG.counters.drawerToggles += 1;
    LQS_DIAG.log('DRAWER_TOGGLE', `Drawer ${isOpen ? 'OPENED' : 'CLOSED'} via ${source}`, { slug });
    return isOpen;
  }

  function toggleDiagnosticsPanel(panel) {
    if (!panel) return;
    const diagBox = panel.querySelector('#lqs-diag-box');
    if (!diagBox) return;
    const isVisible = diagBox.classList.toggle('visible');
    LQS_DIAG.log('DIAG_UI', `Diagnostics box ${isVisible ? 'opened' : 'closed'}`);
    if (isVisible) {
      LQS_DIAG.refreshDiagnosticBoxUI();
    }
  }

  async function runConnectionHealthCheck(panel) {
    const statusEl = panel ? panel.querySelector('#lqs-diag-conn-status') : null;
    if (statusEl) {
      statusEl.textContent = '⏳ Проверяю связь с FastAPI (:8765) и ИИ-мостом (:8083)...';
    }
    const settings = await getSettings();
    const backendUrl = settings.backendUrl.replace(/\/$/, '');
    const aiBaseUrl = settings.aiBaseUrl.replace(/\/$/, '');

    const results = [];

    // 1. Проверка локального FastAPI
    const t0 = performance.now();
    try {
      const r = await fetch(`${backendUrl}/api/health`, { method: 'GET' });
      const dt = Math.round(performance.now() - t0);
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        results.push(`✅ FastAPI (${backendUrl}): ОК (${dt} мс, кэш: ${j.cachedItems ?? '?'} шт.)`);
      } else {
        results.push(`⚠️ FastAPI (${backendUrl}): HTTP ${r.status} (${dt} мс)`);
      }
    } catch (err) {
      results.push(`❌ FastAPI (${backendUrl}): недоступен (${err.message || 'запусти start_server.bat'})`);
    }

    // 2. Проверка ИИ-моста (:8083/v1/models)
    const t1 = performance.now();
    try {
      const headers = {};
      if (settings.aiApiKey) headers.Authorization = `Bearer ${settings.aiApiKey}`;
      const r2 = await fetch(`${aiBaseUrl}/models`, { method: 'GET', headers });
      const dt2 = Math.round(performance.now() - t1);
      if (r2.ok) {
        results.push(`✅ ИИ-мост (${aiBaseUrl}): ОК (${dt2} мс, модель: ${settings.aiModel})`);
      } else {
        results.push(`⚠️ ИИ-мост (${aiBaseUrl}): HTTP ${r2.status} (${dt2} мс)`);
      }
    } catch (err) {
      results.push(`❌ ИИ-мост (${aiBaseUrl}): недоступен (${err.message || 'проверь контейнер'})`);
    }

    const summary = results.join(' | ');
    LQS_DIAG.log('HEALTH_CHECK', summary);
    if (statusEl) {
      statusEl.textContent = summary;
    }
  }

  function syncExistingPanelUI(panel, review, meta) {
    LQS_DIAG.counters.panelSyncs += 1;
    currentReviewCache = review;

    const r = (review && review.rating) ? Number(review.rating) : 0;
    const banned = Boolean(review && review.banned);
    const tags = (review && Array.isArray(review.tags)) ? review.tags : [];
    const note = (review && review.note) ? String(review.note) : '';

    const shouldBeBanned = banned || (r > 0 && r <= 2);
    const shouldBeGod = !banned && r >= 4;

    if (panel.classList.contains('is-banned') !== shouldBeBanned) {
      panel.classList.toggle('is-banned', shouldBeBanned);
    }
    if (panel.classList.contains('is-god') !== shouldBeGod) {
      panel.classList.toggle('is-god', shouldBeGod);
    }

    panel.querySelectorAll('.lqs-star-btn').forEach((b) => {
      const s = parseInt(b.dataset.star, 10);
      const isActive = r >= s;
      if (b.classList.contains('active') !== isActive) {
        b.classList.toggle('active', isActive);
      }
    });

    const smart = meta ? analyzeProductQuality(meta) : null;

    const metricsBox = panel.querySelector('#lqs-metrics-inline');
    if (metricsBox && smart) {
      const nextMetricsHtml = `
        <span class="lqs-metric-pill" title="Честная цена за 1 ${smart.unitLabel}">⚖️ ${smart.pricePerKg ? `~${smart.pricePerKg} ₽/${smart.unitLabel}` : `Цена/${smart.unitLabel} —`}</span>
        ${smart.pricePer100gProtein ? `<span class="lqs-metric-pill protein-pill" title="Стоимость 100 г чистого белка">🥩 ~${smart.pricePer100gProtein} ₽ / 100г белка</span>` : ''}
      `.trim();
      setHtmlIfChanged(metricsBox, nextMetricsHtml, 'metrics-inline');
    }

    const flagsBox = panel.querySelector('#lqs-drawer-flags');
    if (flagsBox && smart) {
      const nextFlagsHtml = smart.flags.map((f) => `<span class="lqs-flag-${f.type}">${f.text}</span>`).join('');
      setHtmlIfChanged(flagsBox, nextFlagsHtml, 'drawer-flags');
    }

    const banBtn = panel.querySelector('#lqs-ban-toggle');
    if (banBtn) {
      if (banBtn.classList.contains('ban-active') !== banned) {
        banBtn.classList.toggle('ban-active', banned);
      }
      const nextBanText = banned ? '💀 В бане' : '🚫 В бан';
      if (banBtn.textContent !== nextBanText) {
        banBtn.textContent = nextBanText;
      }
    }

    const drawer = panel.querySelector('#lqs-drawer');
    if (drawer) {
      const isOpen = drawer.classList.contains('open');
      updateDrawerToggleButton(panel, isOpen, review, smart);
    }

    panel.querySelectorAll('.lqs-tag-chip').forEach((chip) => {
      const isSelected = tags.includes(chip.dataset.tag);
      if (chip.classList.contains('selected') !== isSelected) {
        chip.classList.toggle('selected', isSelected);
      }
    });

    const noteArea = panel.querySelector('#lqs-note-area');
    if (noteArea && document.activeElement !== noteArea && noteArea.value !== note) {
      noteArea.value = note;
    }
  }

  async function requestAiProductReview(meta, panel, forceRefresh = false) {
    const drawer = panel.querySelector('#lqs-drawer');
    const aiBox = panel.querySelector('#lqs-ai-box');
    const aiContent = panel.querySelector('#lqs-ai-content');
    const aiSources = panel.querySelector('#lqs-ai-sources');

    const slug = panel.dataset.slug || extractSlugFromUrl(window.location.href);
    drawer.classList.add('open');
    if (slug) drawerOpenBySlug.set(slug, true);

    const smart = analyzeProductQuality(meta);
    updateDrawerToggleButton(panel, true, currentReviewCache, smart);

    aiBox.classList.add('visible');
    aiContent.innerHTML = '⏳ Ищу отзывы в сети и спрашиваю ИИ-ревизора...';
    aiSources.innerHTML = '';

    const settings = await getSettings();
    const t0 = performance.now();
    LQS_DIAG.log('AI_REQ_START', `Requesting AI review for "${meta.title}" (force=${forceRefresh})`);

    // 1. Локальный FastAPI сервер (парсинг Отзовик/IRecommend/Роскачество + кэш SQLite)
    try {
      const resp = await fetch(`${settings.backendUrl.replace(/\/$/, '')}/api/analyze-product`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
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
        const dt = Math.round(performance.now() - t0);
        LQS_DIAG.lastAiCall = {
          time: new Date().toLocaleTimeString(),
          mode: data.cached ? 'FastAPI (SQLite Cache)' : 'FastAPI (:8765)',
          status: 'OK',
          latencyMs: dt,
          error: null
        };
        LQS_DIAG.log('AI_REQ_OK', `FastAPI response in ${dt}ms (cached=${Boolean(data.cached)})`);

        aiContent.innerHTML = formatAiTextToHtml(data.verdict || 'Вердикт получен.');
        if (Array.isArray(data.sources) && data.sources.length > 0) {
          aiSources.innerHTML = data.sources
            .map((s) => `<a href="${s.url}" target="_blank" rel="noopener noreferrer">🔗 ${s.title || 'Источник'}</a>`)
            .join('');
        }
        return;
      } else {
        LQS_DIAG.log('AI_FASTAPI_HTTP_ERR', `FastAPI HTTP ${resp.status}`);
      }
    } catch (err) {
      LQS_DIAG.log('AI_FASTAPI_SKIP', `FastAPI unreachable, trying direct bridge (:8083)`, err.message || String(err));
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
        const dt = Math.round(performance.now() - t0);
        const reply = json.choices?.[0]?.message?.content || 'Нет ответа от модели.';
        LQS_DIAG.lastAiCall = {
          time: new Date().toLocaleTimeString(),
          mode: `Direct Bridge (${settings.aiModel})`,
          status: 'OK',
          latencyMs: dt,
          error: null
        };
        LQS_DIAG.log('AI_DIRECT_OK', `Direct AI response in ${dt}ms`);

        aiContent.innerHTML = formatAiTextToHtml(reply);
        aiSources.innerHTML = `<span style="color:#75736f;font-size:11.5px;">⚡ Напрямую через ${settings.aiModel} (запусти start_server.bat для поиска отзывов по сайтам)</span>`;
        return;
      } else {
        throw new Error(`HTTP ${directResp.status}`);
      }
    } catch (err) {
      const dt = Math.round(performance.now() - t0);
      LQS_DIAG.lastAiCall = {
        time: new Date().toLocaleTimeString(),
        mode: 'Failed',
        status: 'ERROR',
        latencyMs: dt,
        error: err.message || String(err)
      };
      LQS_DIAG.error('requestAiProductReview', err);
    }

    const isAuthErr = LQS_DIAG.lastAiCall && String(LQS_DIAG.lastAiCall.error || '').includes('401');
    aiContent.innerHTML = isAuthErr
      ? `🔑 Мост <code>${settings.aiBaseUrl}</code> работает, но требует <b>API Key</b>.<br>` +
        `1) Открой <a href="http://localhost:8083/admin/" target="_blank" style="color:#1d4ed8;font-weight:600;">админку :8083/admin/</a> и скопируй ключ.<br>` +
        `2) Нажми на иконку расширения → вкладка <b>🤖 ИИ</b> → вставь ключ и сохрани.`
      : `⚠️ Не удалось подключиться к локальному серверу <code>${settings.backendUrl}</code> или ИИ-мосту <code>${settings.aiBaseUrl}</code>.<br>` +
        `Проверь, что запущен Docker-контейнер Gemini Argon (<code>:8083</code>) или <code>start_server.bat</code>, либо открой вкладку <b>🤖 ИИ</b> в иконке расширения и нажми «⚡ Найти и подключить ИИ автоматически».`;
  }

  async function renderProductPageWidget() {
    if (isRenderingProduct) {
      pendingProductRender = true;
      return;
    }

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
      currentReviewCache = current;

      guardAddToCartButton(current);

      let existing = mainPage.querySelector('.lqs-product-panel');
      if (existing && existing.dataset.slug === slug) {
        syncExistingPanelUI(existing, current, meta);
        return;
      }
      if (existing) existing.remove();

      const smart = analyzeProductQuality(meta);
      const isDrawerInitiallyOpen = Boolean(drawerOpenBySlug.get(slug));

      const panel = document.createElement('div');
      panel.className = `lqs-product-panel ${current.banned || (current.rating > 0 && current.rating <= 2) ? 'is-banned' : (current.rating >= 4 ? 'is-god' : '')}`;
      panel.dataset.slug = slug;

      const initialMetricsHtml = `
        <span class="lqs-metric-pill" title="Честная цена за 1 ${smart.unitLabel}">⚖️ ${smart.pricePerKg ? `~${smart.pricePerKg} ₽/${smart.unitLabel}` : `Цена/${smart.unitLabel} —`}</span>
        ${smart.pricePer100gProtein ? `<span class="lqs-metric-pill protein-pill" title="Стоимость 100 г чистого белка">🥩 ~${smart.pricePer100gProtein} ₽ / 100г белка</span>` : ''}
      `.trim();

      const initialFlagsHtml = smart.flags.map((f) => `<span class="lqs-flag-${f.type}">${f.text}</span>`).join('');

      panel.innerHTML = `
        <!-- ЕДИНСТВЕННАЯ ОСНОВНАЯ СТРОКА: Звёзды + Цена/кг + Цена/100г белка + кнопка «▾ Подробнее» -->
        <div class="lqs-main-bar">
          <div class="lqs-core-left">
            <div class="lqs-stars-inline" id="lqs-stars-box">
              ${[1, 2, 3, 4, 5].map((n) => `
                <button type="button" class="lqs-star-btn ${current.rating >= n ? 'active' : ''}" data-star="${n}" title="Оценить на ${n}">★</button>
              `).join('')}
            </div>

            <div class="lqs-metrics-inline" id="lqs-metrics-inline">${initialMetricsHtml}</div>
          </div>

          <button type="button" class="lqs-drawer-toggle-btn" id="lqs-drawer-toggle" title="Открыть заметку, состав и ИИ-обзор">
            <span class="lqs-dot-indicator is-hidden" id="lqs-drawer-dot"></span>
            <span class="lqs-toggle-label" id="lqs-drawer-label">${isDrawerInitiallyOpen ? '▴ Скрыть' : '▾ Подробнее'}</span>
          </button>
        </div>

        <!-- ВЫПАДАЮЩЕЕ МЕНЮ ПОД КАПОТОМ (открывается по клику на «▾ Подробнее») -->
        <div class="lqs-drawer ${isDrawerInitiallyOpen ? 'open' : ''}" id="lqs-drawer">
          <div class="lqs-drawer-toolbar">
            <div class="lqs-drawer-actions">
              <button type="button" class="lqs-mini-btn ai-btn" id="lqs-ai-btn" title="Найти отзывы в сети и спросить ИИ">
                🤖 ИИ-обзор
              </button>
              <button type="button" class="lqs-mini-btn ${current.banned ? 'ban-active' : ''}" id="lqs-ban-toggle" title="В чёрный список">
                ${current.banned ? '💀 В бане' : '🚫 В бан'}
              </button>
              <button type="button" class="lqs-mini-btn diag-btn" id="lqs-diag-toggle" title="Встроенная диагностика и отлов багов (Alt+Shift+D)">
                🩺 Диаг.
              </button>
            </div>

            <div class="lqs-drawer-flags" id="lqs-drawer-flags">${initialFlagsHtml}</div>
          </div>

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

          <!-- ВСТРОЕННАЯ ПАНЕЛЬ ДИАГНОСТИКИ (LQS DIAGNOSTICS v2.0.3) -->
          <div class="lqs-diag-box" id="lqs-diag-box">
            <div class="lqs-diag-header">
              <span>🩺 LQS Диагностика v${VERSION} (Alt+Shift+D)</span>
              <div class="lqs-diag-btn-group">
                <button type="button" class="lqs-diag-action-btn" id="lqs-diag-ping">🔌 Проверить связь</button>
                <button type="button" class="lqs-diag-action-btn primary" id="lqs-diag-copy">📋 Скопировать отчёт</button>
              </div>
            </div>
            <div class="lqs-diag-conn-status" id="lqs-diag-conn-status">Нажми «🔌 Проверить связь» для теста FastAPI (:8765) и Gemini Argon (:8083).</div>
            <div class="lqs-diag-metrics" id="lqs-diag-metrics"></div>
            <pre class="lqs-diag-log" id="lqs-diag-log"></pre>
          </div>
        </div>
      `;

      // Записываем начальные хеши HTML, чтобы syncExistingPanelUI не перезаписывал DOM вхолостую
      const metricsEl = panel.querySelector('#lqs-metrics-inline');
      if (metricsEl) metricsEl.dataset.lqsHtmlCache = initialMetricsHtml;
      const flagsEl = panel.querySelector('#lqs-drawer-flags');
      if (flagsEl) flagsEl.dataset.lqsHtmlCache = initialFlagsHtml;

      updateDrawerToggleButton(panel, isDrawerInitiallyOpen, current, smart);

      const barContainer = infoBlock.querySelector('div[data-testid="bar-container"]');
      if (barContainer && barContainer.parentNode) {
        barContainer.parentNode.insertBefore(panel, barContainer.nextSibling);
      } else {
        infoBlock.prepend(panel);
      }

      LQS_DIAG.counters.panelMounts += 1;
      LQS_DIAG.log('PANEL_MOUNT', `Mounted widget for ${slug}`, {
        price: meta.price,
        amount: meta.amountText,
        pricePerKg: smart.pricePerKg
      });

      const noteArea = panel.querySelector('#lqs-note-area');
      noteArea.value = current.note;

      const persistState = async () => {
        const latestMeta = extractProductPageMetadata();
        current.note = noteArea.value;
        currentReviewCache = current;
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
          LQS_DIAG.log('STAR_CLICK', `Star set to ${current.rating}`);
          persistState();
        });
      });

      panel.querySelector('#lqs-ban-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        current.banned = !current.banned;
        if (current.banned && current.rating === 0) current.rating = 1;
        LQS_DIAG.log('BAN_CLICK', `Ban toggled to ${current.banned}`);
        persistState();
      });

      panel.querySelector('#lqs-drawer-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleDrawerState(panel, 'button-click');
      });

      panel.querySelector('#lqs-diag-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleDiagnosticsPanel(panel);
      });

      panel.querySelector('#lqs-diag-ping').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        runConnectionHealthCheck(panel);
      });

      panel.querySelector('#lqs-diag-copy').addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const btn = e.currentTarget;
        const report = LQS_DIAG.buildTextReport();
        try {
          await navigator.clipboard.writeText(report);
          btn.textContent = '✅ Скопировано!';
        } catch {
          btn.textContent = '⚠️ Ошибка буфера';
        }
        setTimeout(() => { btn.textContent = '📋 Скопировать отчёт'; }, 1500);
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
          LQS_DIAG.log('TAG_CLICK', `Toggled tag "${tag}"`);
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
    } catch (err) {
      LQS_DIAG.error('renderProductPageWidget', err);
    } finally {
      isRenderingProduct = false;
      if (pendingProductRender) {
        pendingProductRender = false;
        setTimeout(renderProductPageWidget, 50);
      }
    }
  }

  function guardAddToCartButton(review) {
    const addBtn = document.querySelector('main[data-testid="good-page-desktop"] button[data-testid="snippet-control"]');
    if (!addBtn) return;

    const isBad = Boolean(review && (review.banned || (review.rating > 0 && review.rating <= 2)));
    const nextBadStr = isBad ? 'true' : 'false';
    const nextNoteStr = (review && review.note) ? review.note : '';
    const nextRatingStr = (review && review.rating) ? String(review.rating) : '1';

    if (
      addBtn.dataset.lqsBad === nextBadStr &&
      addBtn.dataset.lqsNote === nextNoteStr &&
      addBtn.dataset.lqsRating === nextRatingStr
    ) {
      return;
    }

    addBtn.dataset.lqsBad = nextBadStr;
    addBtn.dataset.lqsNote = nextNoteStr;
    addBtn.dataset.lqsRating = nextRatingStr;

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

  /**
   * Декорирование карточек каталога БЕЗ лишних удалений/вставок DOM,
   * если рейтинг карточки не изменился.
   */
  async function decorateCatalogCards() {
    LQS_DIAG.counters.catalogPasses += 1;
    const db = await getReviewsDB();
    const cards = document.querySelectorAll('div[data-testid="product-card"]');

    cards.forEach((card) => {
      const ids = extractCardIdentifiers(card);
      const review = findReviewInDB(db, ids);

      const oldNote = card.querySelector('.lqs-card-note-preview');
      if (oldNote) oldNote.remove();

      const hasReview = Boolean(review && (review.rating > 0 || review.banned));
      if (!hasReview) {
        if (card.dataset.lqsBadgeKey) {
          delete card.dataset.lqsBadgeKey;
          const oldBadge = card.querySelector('.lqs-card-badge');
          if (oldBadge) oldBadge.remove();
          card.classList.remove('lqs-card-dimmed');
          LQS_DIAG.counters.catalogBadgesUpdated += 1;
        } else {
          LQS_DIAG.counters.catalogBadgesSkipped += 1;
        }
        return;
      }

      const isBad = Boolean(review.banned || (review.rating > 0 && review.rating <= 2));
      const tier = isBad ? 'trash' : (review.rating >= 4 ? 'god' : 'ok');
      const text = isBad ? `💀 ${review.rating ? review.rating + '★' : 'БАН'}` : `★ ${review.rating}`;
      const titleText = (review.note && review.note.trim()) ? review.note.trim() : '';
      const badgeKey = `${tier}|${text}|${titleText}`;

      let badge = card.querySelector('.lqs-card-badge');
      if (card.dataset.lqsBadgeKey === badgeKey && badge) {
        LQS_DIAG.counters.catalogBadgesSkipped += 1;
        return;
      }

      card.dataset.lqsBadgeKey = badgeKey;
      if (card.style.position !== 'relative') {
        card.style.position = 'relative';
      }
      if (card.classList.contains('lqs-card-dimmed') !== isBad) {
        card.classList.toggle('lqs-card-dimmed', isBad);
      }

      if (!badge) {
        badge = document.createElement('div');
        card.appendChild(badge);
      }
      badge.className = `lqs-card-badge ${tier}`;
      badge.textContent = text;
      badge.title = titleText;
      LQS_DIAG.counters.catalogBadgesUpdated += 1;
    });
  }

  let debounceTimer = null;
  function scheduleUpdate() {
    LQS_DIAG.counters.scheduleCalls += 1;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      renderProductPageWidget();
      decorateCatalogCards();
    }, 120);
  }

  function runHydrationResyncWave() {
    LQS_DIAG.log('HYDRATION_WAVE', `Triggered resync wave on ${window.location.pathname}`);
    [0, 180, 500, 1200, 2500].forEach((delay) => {
      setTimeout(() => {
        renderProductPageWidget();
        decorateCatalogCards();
      }, delay);
    });
  }

  /**
   * Проверка: относится ли узел или запись мутации исключительно к нашим собственным элементам .lqs-*
   * Это на 100% разрывает порочный круг самовозбуждения MutationObserver.
   */
  function isOwnLqsNode(node) {
    if (!node) return false;
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (
        node.classList &&
        (node.classList.contains('lqs-product-panel') ||
         node.classList.contains('lqs-card-badge') ||
         node.classList.contains('lqs-card-note-preview'))
      ) {
        return true;
      }
      if (node.closest && node.closest('.lqs-product-panel, .lqs-card-badge')) {
        return true;
      }
    } else if (node.parentElement && node.parentElement.closest('.lqs-product-panel, .lqs-card-badge')) {
      return true;
    }
    return false;
  }

  function hasExternalMutation(mutations) {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (isOwnLqsNode(m.target)) {
        continue;
      }
      let hasNonLqsChild = false;
      for (let j = 0; j < m.addedNodes.length; j++) {
        if (!isOwnLqsNode(m.addedNodes[j])) {
          hasNonLqsChild = true;
          break;
        }
      }
      if (!hasNonLqsChild) {
        for (let j = 0; j < m.removedNodes.length; j++) {
          if (!isOwnLqsNode(m.removedNodes[j])) {
            hasNonLqsChild = true;
            break;
          }
        }
      }
      if (hasNonLqsChild) {
        return true;
      }
    }
    return false;
  }

  const observer = new MutationObserver((mutations) => {
    if (hasExternalMutation(mutations)) {
      LQS_DIAG.counters.extMutations += 1;
      scheduleUpdate();
    } else {
      LQS_DIAG.counters.selfMutationsIgnored += 1;
    }
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
