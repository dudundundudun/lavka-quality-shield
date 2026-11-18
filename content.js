/**
 * Lavka Quality Shield v2.3.0 — Content Script (Zero-Click Full Autopilot Edition)
 * Что нового в v2.3.0:
 * 1. Полный Zero-Click Автопилот на странице товара:
 *    - При открытии любой карточки товара (/good/...) расширение САМО проверяет встроенный кэш ИИ-обзоров
 *      в браузере (lqs_ai_cache_v1) и мгновенно показывает готовый вердикт.
 *    - Если товар открыт впервые и включён режим Zero-Click (по умолчанию ВКЛ) — расширение САМО через 550 мс
 *      запускает ИИ-разбор состава, КБЖУ, цены и отзывов без единого клика со стороны пользователя!
 *    - На главной однострочной панели отображается компактный живой индикатор вердикта ИИ
 *      («🤖 ⏳ ИИ-разбор...» -> «🤖 ✅ Стоит брать» / «🤖 👍 Хороший» / «🤖 ⚠️ На любителя» / «🤖 ❌ Не брать»).
 * 2. Надёжный детектор SPA-переходов (таймер URL + popstate + MutationObserver) и авто-прогрев Gemini при старте.
 */

(function () {
  'use strict';

  const VERSION = '2.3.0';
  const STORAGE_KEY = 'lqs_reviews_v1';
  const SETTINGS_KEY = 'lqs_settings_v2';
  const FLIGHT_LOG_KEY = 'lqs_flight_log_v1';
  const AI_CACHE_KEY = 'lqs_ai_cache_v1';

  const DEFAULT_SETTINGS = {
    backendUrl: 'http://127.0.0.1:8765',
    aiBaseUrl: 'http://localhost:8083/v1',
    aiApiKey: '',
    aiModel: 'gemini-4-argon',
    useDirectBrowserAiFallback: true,
    autoRunAiOnProductPage: true,
    autoOpenDrawerOnAi: true,
    autoWarmupGeminiTab: true
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
  // Память уже запущенных авто-разборов ИИ в текущей сессии по slug, чтобы не спамить повторно
  const autoAiTriggeredSlugs = new Set();
  const lastAiResultBySlug = new Map();
  let autoAiDebounceTimer = null;

  // Синхронный кэш базы отзывов в памяти для мгновенной отрисовки каталога
  let reviewsDbCache = null;
  let aiCacheMemory = null;
  let isRenderingProduct = false;
  let pendingProductRender = false;
  let currentReviewCache = null;
  let lastObservedUrl = window.location.href;

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Извлекает короткий бейдж вердикта из текста ответа ИИ для показа на главной панели в 1 строку
   */
  function extractVerdictBadgeFromText(verdictText) {
    if (!verdictText) return null;
    const t = String(verdictText);
    if (t.includes('Отличный выбор') || t.includes('✅')) {
      return { cls: 'verdict-good', text: '🤖 ✅ Стоит брать', shortCatalog: '🤖✅' };
    }
    if (t.includes('Хороший вариант') || t.includes('👍')) {
      return { cls: 'verdict-ok', text: '🤖 👍 Хороший', shortCatalog: '🤖👍' };
    }
    if (t.includes('Не рекомендую') || t.includes('❌')) {
      return { cls: 'verdict-bad', text: '🤖 ❌ Не брать', shortCatalog: '🤖❌' };
    }
    if (t.includes('На любителя') || t.includes('⚠️')) {
      return { cls: 'verdict-warn', text: '🤖 ⚠️ На любителя', shortCatalog: '🤖⚠️' };
    }
    return { cls: 'verdict-ok', text: '🤖 ИИ-вердикт готов', shortCatalog: '🤖' };
  }

  // ==========================================================================
  // БОРТОВОЙ САМОПИСЕЦ (LQS FLIGHT RECORDER) — ЛОГ ДЛЯ ДЕБАГГИНГА ЧЕРЕЗ ИИ
  // ==========================================================================
  const LQS_RECORDER = {
    version: VERSION,
    sessionStartedAt: new Date().toISOString(),
    counters: {
      spaTransitions: 0,
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
      missedClicksRecovered: 0,
      autoAiRuns: 0,
      errors: 0
    },
    lastClickLatencyMs: null,
    modules: {
      router: { status: 'INIT', lastRun: null, summary: 'Ожидание инициализации роутера' },
      parser: { status: 'IDLE', lastRun: null, summary: 'Страница товара ещё не открывалась', data: null },
      calculator: { status: 'IDLE', lastRun: null, summary: 'Расчёт КБЖУ и цены ещё не выполнялся', data: null },
      widget: { status: 'IDLE', lastRun: null, summary: 'Виджет не смонтирован' },
      catalog: { status: 'IDLE', lastRun: null, summary: 'Каталог ещё не сканировался' },
      cartGuard: { status: 'IDLE', lastRun: null, summary: 'Перехватчик корзины в режиме ожидания' },
      storage: { status: 'INIT', lastRun: null, summary: 'Загрузка базы отзывов...' },
      aiReviewer: { status: 'IDLE', lastRun: null, summary: 'Готов к Zero-Click Автопилоту', lastCall: null }
    },
    events: [],
    _initialized: false,
    _saveTimer: null,

    init() {
      if (this._initialized) return;
      this._initialized = true;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([FLIGHT_LOG_KEY], (res) => {
          const saved = res && res[FLIGHT_LOG_KEY];
          if (saved && Array.isArray(saved.events)) {
            const combined = [...this.events, ...saved.events];
            this.events = combined.slice(0, 120);
          }
          this.record('INIT', 'Session started on ' + window.location.pathname, {
            ua: navigator.userAgent.slice(0, 90),
            viewport: `${window.innerWidth}x${window.innerHeight}`
          });
        });
      }
    },

    updateModule(moduleName, status, summary, data = undefined) {
      if (!this.modules[moduleName]) return;
      const now = new Date();
      const ts = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
      this.modules[moduleName].status = status;
      this.modules[moduleName].lastRun = ts;
      this.modules[moduleName].summary = summary;
      if (data !== undefined) {
        this.modules[moduleName].data = data;
      }
      this.persistThrottled();
    },

    record(category, message, payload = null) {
      const now = new Date();
      const ts = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
      let cleanPayload = '';
      if (payload !== null && payload !== undefined) {
        if (typeof payload === 'string') {
          cleanPayload = payload;
        } else {
          try {
            cleanPayload = JSON.stringify(payload);
          } catch {
            cleanPayload = String(payload);
          }
        }
      }
      if (cleanPayload.length > 360) {
        cleanPayload = cleanPayload.slice(0, 360) + '…';
      }

      this.events.unshift({
        ts,
        url: window.location.pathname,
        cat: category,
        msg: message,
        data: cleanPayload
      });

      if (this.events.length > 120) {
        this.events.length = 120;
      }
      this.persistThrottled();
    },

    error(where, err, extraContext = null) {
      this.counters.errors += 1;
      const errMsg = err && err.stack ? err.stack.split('\n').slice(0, 2).join(' | ') : (err && err.message ? err.message : String(err));
      this.record('ERROR', `[${where}] ${errMsg}`, extraContext);
    },

    clearLogs() {
      this.events = [];
      this.counters.errors = 0;
      this.record('INIT', 'Лог очищен пользователем вручную');
      this.persistNow();
    },

    auditDomSelectors() {
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
      const addBtnEl = document.querySelector('main[data-testid="good-page-desktop"] button[data-testid="snippet-control"]');
      const panelEl = document.querySelector('.lqs-product-panel');
      const drawerEl = panelEl ? panelEl.querySelector('#lqs-drawer') : null;
      const catalogCardsCount = document.querySelectorAll('div[data-testid="product-card"]').length;

      let discoveredTestIds = [];
      if (slug && (!mainPage || !infoBlock || !titleEl || !priceEl)) {
        const allTestIdNodes = document.querySelectorAll('[data-testid]');
        const set = new Set();
        allTestIdNodes.forEach((n) => {
          const tid = n.getAttribute('data-testid');
          if (tid && !tid.startsWith('product-id-') && set.size < 35) {
            set.add(`${n.tagName.toLowerCase()}[data-testid="${tid}"]`);
          }
        });
        discoveredTestIds = Array.from(set);
      }

      return {
        url: window.location.href,
        pathname: window.location.pathname,
        slug: slug || null,
        pageType: slug ? 'PRODUCT_PAGE' : 'CATALOG_OR_HOME',
        selectors: {
          mainPage: Boolean(mainPage),
          infoBlock: Boolean(infoBlock),
          barContainer: Boolean(barContainer),
          titleEl: Boolean(titleEl),
          priceEl: Boolean(priceEl),
          amountEl: Boolean(amountEl),
          ingredientsEl: Boolean(ingredientsEl),
          traitsEl: Boolean(traitsEl),
          addBtnEl: Boolean(addBtnEl),
          panelMounted: Boolean(panelEl),
          drawerOpen: Boolean(drawerEl && drawerEl.classList.contains('open'))
        },
        catalogCardsCount,
        discoveredTestIds
      };
    },

    buildAiDebugReport(backendDiag = null) {
      const dom = this.auditDomSelectors();
      const s = dom.selectors;
      const c = this.counters;
      const m = this.modules;
      const flag = (v) => (v ? '✅ OK' : '❌ MISS');

      const lines = [
        `# 🛠️ LAVKA QUALITY SHIELD v${this.version} — AI DIAGNOSTIC & FLIGHT RECORDER LOG`,
        `> **Инструкция для ИИ-ассистента**: Ниже представлена полная телеметрия работы расширения Lavka Quality Shield (Manifest V3) на сайте Яндекс Лавки. Изучи матрицу состояния всех 8 функций, распарсенные метаданные, аудит селекторов DOM и хронологический стек событий, чтобы точно локализовать любую проблему.`,
        ``,
        `## 1. СВОДКА ОКРУЖЕНИЯ И СТРАНИЦЫ`,
        `- **Timestamp**: ${new Date().toISOString()} (сессия с ${this.sessionStartedAt})`,
        `- **URL**: ${dom.url}`,
        `- **Тип страницы**: ${dom.pageType} (Slug: \`${dom.slug || 'нет'}\`, Карточек в каталоге: ${dom.catalogCardsCount})`,
        `- **База отзывов в памяти**: ${reviewsDbCache ? Object.keys(reviewsDbCache).length : 0} записей | **Кэш ИИ в памяти**: ${aiCacheMemory ? Object.keys(aiCacheMemory).length : 0} товаров`,
        ``,
        `## 2. МАТРИЦА ФУНКЦИОНИРОВАНИЯ МОДУЛЕЙ (FUNCTION HEALTH MATRIX)`,
        `1. **[ROUTER] SPA-навигация и гидратация**: \`${m.router.status}\` (${m.router.lastRun || '—'}) — ${m.router.summary}`,
        `2. **[PARSER] Парсер метаданных и JSON-LD**: \`${m.parser.status}\` (${m.parser.lastRun || '—'}) — ${m.parser.summary}`,
        `3. **[CALCULATOR] Расчёт цены/кг, белка и КБЖУ**: \`${m.calculator.status}\` (${m.calculator.lastRun || '—'}) — ${m.calculator.summary}`,
        `4. **[WIDGET] Панель товара и спойлер**: \`${m.widget.status}\` (${m.widget.lastRun || '—'}) — ${m.widget.summary}`,
        `5. **[CATALOG] Разметка карточек каталога**: \`${m.catalog.status}\` (${m.catalog.lastRun || '—'}) — ${m.catalog.summary}`,
        `6. **[CART_GUARD] Защита от покупки бана**: \`${m.cartGuard.status}\` (${m.cartGuard.lastRun || '—'}) — ${m.cartGuard.summary}`,
        `7. **[STORAGE] Хранилище chrome.storage.local**: \`${m.storage.status}\` (${m.storage.lastRun || '—'}) — ${m.storage.summary}`,
        `8. **[AI_REVIEWER] Zero-Click ИИ Автопилот**: \`${m.aiReviewer.status}\` (${m.aiReviewer.lastRun || '—'}) — ${m.aiReviewer.summary}`
      ];

      if (backendDiag) {
        lines.push(`   - **Пинг серверов из Popup**: ${backendDiag}`);
      }

      lines.push(
        ``,
        `## 3. АУДИТ DOM-СЕЛЕКТОРОВ ЯНДЕКС ЛАВКИ`,
        `- \`main[data-testid="good-page-desktop"]\`: ${flag(s.mainPage)}`,
        `- \`div[data-testid="product-info" | "product-card-header"]\`: ${flag(s.infoBlock)}`,
        `- \`div[data-testid="bar-container"]\`: ${flag(s.barContainer)}`,
        `- \`h1[data-testid="product-title"]\`: ${flag(s.titleEl)}`,
        `- \`span[data-testid="price-text"]\`: ${flag(s.priceEl)}`,
        `- \`span[data-testid="product-amount"]\`: ${flag(s.amountEl)}`,
        `- \`section[data-testid="ingredients-block"]\`: ${flag(s.ingredientsEl)}`,
        `- \`section[data-testid="traits-block"]\`: ${flag(s.traitsEl)}`,
        `- \`button[data-testid="snippet-control"]\`: ${flag(s.addBtnEl)}`,
        `- **Статус нашего виджета (.lqs-product-panel)**: ${s.panelMounted ? '✅ Смонтирован' : '⚪ Не смонтирован'} (Спойлер: ${s.drawerOpen ? 'ОТКРЫТ' : 'ЗАКРЫТ'})`
      );

      if (dom.discoveredTestIds && dom.discoveredTestIds.length > 0) {
        lines.push(
          `- **⚠️ ВНИМАНИЕ (Подсказка для ИИ — обнаруженные data-testid на странице)**:`,
          `  \`${dom.discoveredTestIds.join('`, `')}\``
        );
      }

      if (m.parser.data) {
        const pd = m.parser.data;
        lines.push(
          ``,
          `## 4. ПОСЛЕДНИЕ РАСПАРСЕННЫЕ ДАННЫЕ ТОВАРА (PARSER & CALCULATOR DUMP)`,
          `- **Title**: "${pd.title || ''}" (clean: "${pd.cleanTitle || ''}")`,
          `- **Цена / Старая цена / Вес**: ${pd.price ?? 'null'} ₽ / ${pd.oldPrice ?? 'null'} ₽ / "${pd.amountText || ''}"`,
          `- **ProductId / ImageKey / Brand**: \`${pd.productId || 'null'}\` / \`${pd.imageKey || 'null'}\` / "${pd.brand || ''}"`,
          `- **Текст КБЖУ (traitsText)**: "${(pd.traitsText || '').replace(/\s+/g, ' ').slice(0, 180)}"`,
          `- **Текст состава (ingredientsText)**: "${(pd.ingredientsText || '').replace(/\s+/g, ' ').slice(0, 220)}"`
        );
      }

      if (m.calculator.data) {
        const cd = m.calculator.data;
        lines.push(
          `- **Результат калькулятора**: Вес=${cd.weightGrams ?? 'null'}г (${cd.unitLabel}), Цена/кг=${cd.pricePerKg ?? 'null'}₽, Белки=${cd.proteinPer100g ?? 'null'}г, Жиры=${cd.fatPer100g ?? 'null'}г, Угли=${cd.carbsPer100g ?? 'null'}г, Ккал=${cd.kcalPer100g ?? 'null'}, Цена/100г белка=${cd.pricePer100gProtein ?? 'null'}₽`,
          `- **Флаги состава**: ${cd.flags && cd.flags.length ? cd.flags.map((f) => `[${f.type.toUpperCase()}] ${f.text}`).join(', ') : 'нет'}`
        );
      }

      lines.push(
        ``,
        `## 5. СЧЁТЧИКИ ПРОИЗВОДИТЕЛЬНОСТИ И СТАБИЛЬНОСТИ DOM`,
        `- **SPA переходов**: ${c.spaTransitions} | **Маунтов панели**: ${c.panelMounts} | **Синхронизаций UI**: ${c.panelSyncs} | **Zero-Click ИИ-запусков**: ${c.autoAiRuns}`,
        `- **Записей в DOM выполнено**: ${c.domWritesExecuted} | **Пропущено дублей (кэш хеша)**: ${c.domWritesSkipped}`,
        `- **Мутаций Лавки обработано**: ${c.extMutations} | **Собственных мутаций .lqs-* отсечено**: ${c.selfMutationsIgnored}`,
        `- **Проходов каталога**: ${c.catalogPasses} (обновлено бейджей: ${c.catalogBadgesUpdated}, пропущено без изменений: ${c.catalogBadgesSkipped})`,
        `- **Кликов по виджету**: ${c.clicksTotal} | **Переключений спойлера**: ${c.drawerToggles} | **Задержка клика**: ${this.lastClickLatencyMs !== null ? this.lastClickLatencyMs + ' мс' : '—'} | **Авто-восстановлений сорванных кликов**: ${c.missedClicksRecovered}`,
        `- **Перехвачено ошибок (Errors)**: ${c.errors}`,
        ``,
        `## 6. ХРОНОЛОГИЧЕСКИЙ БОРТОВОЙ ЖУРНАЛ (ПОСЛЕДНИЕ ${Math.min(this.events.length, 60)} СОБЫТИЙ)`,
        ...(this.events.slice(0, 60).map((e) => `${e.ts} [${e.cat}] (${e.url}) ${e.msg}${e.data ? ' -> ' + e.data : ''}`))
      );

      return lines.join('\n');
    },

    persistNow() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const payload = {
          updatedAt: new Date().toISOString(),
          version: this.version,
          counters: this.counters,
          modules: this.modules,
          events: this.events.slice(0, 120),
          reportText: this.buildAiDebugReport()
        };
        chrome.storage.local.set({ [FLIGHT_LOG_KEY]: payload });
      }
    },

    persistThrottled() {
      if (this._saveTimer) return;
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        this.persistNow();
      }, 500);
    }
  };

  LQS_RECORDER.init();

  // Сигнализируем фоновому воркеру прогреть Автопилот сразу при заходе на Лавку
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ type: 'LQS_WARMUP_AUTOPILOT' }, () => {
      if (chrome.runtime.lastError) {
        // ignore
      }
    });
  }

  window.addEventListener('error', (ev) => {
    if (ev && ev.error) {
      LQS_RECORDER.error('window.onerror', ev.error);
    }
  });

  window.addEventListener('unhandledrejection', (ev) => {
    if (ev && ev.reason) {
      LQS_RECORDER.error('unhandledrejection', ev.reason);
    }
  });

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
      LQS_RECORDER.counters.missedClicksRecovered += 1;
      LQS_RECORDER.record('WIDGET', `Orphaned pointerdown on [${role}], running click recovery`);
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
    LQS_RECORDER.counters.clicksTotal += 1;
    if (pendingPointerDown) {
      clearTimeout(pendingPointerDown.timer);
      const dt = Math.round(performance.now() - pendingPointerDown.t0);
      LQS_RECORDER.lastClickLatencyMs = dt;
      pendingPointerDown = null;
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.code === 'KeyD' || e.key === 'D' || e.key === 'd' || e.key === 'в' || e.key === 'В')) {
      e.preventDefault();
      LQS_RECORDER.record('USER_ACTION', 'Triggered Alt+Shift+D AI log copy');
      const report = LQS_RECORDER.buildAiDebugReport();
      navigator.clipboard.writeText(report).catch(() => {});
    }
  });

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return false;
      if (msg.type === 'LQS_GET_DIAGNOSTICS') {
        sendResponse({
          ok: true,
          reportText: LQS_RECORDER.buildAiDebugReport(msg.backendDiag || null),
          counters: LQS_RECORDER.counters,
          modules: LQS_RECORDER.modules,
          audit: LQS_RECORDER.auditDomSelectors()
        });
        return true;
      }
      if (msg.type === 'LQS_CLEAR_DIAGNOSTICS') {
        LQS_RECORDER.clearLogs();
        sendResponse({
          ok: true,
          reportText: LQS_RECORDER.buildAiDebugReport()
        });
        return true;
      }
      return false;
    });
  }

  // ==========================================================================
  // УТИЛИТЫ И РАБОТА С БАЗОЙ ОТЗЫВОВ И КЭШЕМ ИИ
  // ==========================================================================
  function setHtmlIfChanged(el, nextHtml, tagKey = '') {
    if (!el) return false;
    if (el.dataset.lqsHtmlCache === nextHtml) {
      LQS_RECORDER.counters.domWritesSkipped += 1;
      return false;
    }
    el.dataset.lqsHtmlCache = nextHtml;
    el.innerHTML = nextHtml;
    LQS_RECORDER.counters.domWritesExecuted += 1;
    if (tagKey) {
      LQS_RECORDER.record('WIDGET', `DOM write executed for ${tagKey}`);
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
    const escaped = escapeHtml(rawText);
    return escaped
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  async function getReviewsDB(forceReload = false) {
    if (reviewsDbCache && !forceReload) {
      return reviewsDbCache;
    }
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([STORAGE_KEY, AI_CACHE_KEY], (res) => {
          reviewsDbCache = (res && res[STORAGE_KEY]) ? res[STORAGE_KEY] : {};
          aiCacheMemory = (res && res[AI_CACHE_KEY]) ? res[AI_CACHE_KEY] : {};
          const count = Object.keys(reviewsDbCache).length;
          LQS_RECORDER.updateModule('storage', 'OK', `База загружена в память (${count} оценок, ${Object.keys(aiCacheMemory).length} ИИ-обзоров)`);
          resolve(reviewsDbCache);
        });
      } else {
        try {
          reviewsDbCache = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        } catch {
          reviewsDbCache = {};
        }
        resolve(reviewsDbCache);
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
    if (slug && db[slug]) {
      return { item: db[slug], matchedBy: 'slug_exact' };
    }

    for (const item of Object.values(db)) {
      if (!item) continue;
      if (slug && item.slug && item.slug.toLowerCase() === slug) return { item, matchedBy: 'slug_case' };
      if (productId && item.productId && item.productId === productId) return { item, matchedBy: 'productId' };
      if (imageKey && item.imageKey && item.imageKey === imageKey) return { item, matchedBy: 'imageKey' };
      if (cleanTitle && item.cleanTitle && item.cleanTitle === cleanTitle) return { item, matchedBy: 'cleanTitle' };
    }
    return null;
  }

  async function saveProductReview(slug, data) {
    const db = await getReviewsDB();
    const match = findReviewInDB(db, {
      slug,
      productId: data.productId,
      imageKey: data.imageKey,
      cleanTitle: data.cleanTitle
    });
    const existing = match ? match.item : null;
    const canonicalKey = (existing && existing.slug) ? existing.slug : slug;

    const isEmpty = !data.rating && !data.banned && (!data.tags || data.tags.length === 0) && (!data.note || !data.note.trim());

    if (isEmpty) {
      delete db[canonicalKey];
      reviewsDbCache = db;
      LQS_RECORDER.record('STORAGE', `Deleted empty review for ${canonicalKey}`);
      LQS_RECORDER.updateModule('storage', 'OK', `Удалён сброшенный отзыв ${canonicalKey} (всего: ${Object.keys(db).length})`);
      return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ [STORAGE_KEY]: db }, () => resolve(null));
        } else {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
          resolve(null);
        }
      });
    }

    db[canonicalKey] = {
      ...(existing || {}),
      ...data,
      slug: canonicalKey,
      updatedAt: new Date().toISOString()
    };
    reviewsDbCache = db;

    LQS_RECORDER.record('STORAGE', `Saved review for ${canonicalKey}`, {
      rating: data.rating,
      banned: data.banned,
      tags: data.tags,
      noteLen: (data.note || '').length
    });
    LQS_RECORDER.updateModule(
      'storage',
      'OK',
      `Сохранён ${canonicalKey}: ${data.rating}★, бан=${Boolean(data.banned)} (всего: ${Object.keys(db).length})`
    );

    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [STORAGE_KEY]: db }, () => resolve(db[canonicalKey]));
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
        resolve(db[canonicalKey]);
      }
    });
  }

  // ==========================================================================
  // ПАРСЕР СТРАНИЦЫ ТОВАРА И ТОЧНЫЙ КАЛЬКУЛЯТОР КБЖУ / ЦЕНЫ ЗА КГ
  // ==========================================================================
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
            brand: prod.brand ? (typeof prod.brand === 'string' ? prod.brand : prod.brand.name) : null,
            description: prod.description || ''
          };
        }
      } catch {
        // ignore malformed JSON-LD
      }
    });

    const rawTitle = titleEl ? titleEl.textContent : document.title.split('—')[0];
    const title = rawTitle ? rawTitle.replace(/[\u00ad\u200b]/g, '').trim() : '';
    const cleanTitle = normalizeTitle(title);
    const amountText = amountEl ? amountEl.textContent.replace(/[\u00ad\u200b\u00a0]/g, ' ').trim() : '';
    const priceText = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.') : '';
    const oldPriceText = oldPriceEl ? oldPriceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.') : '';
    const ingredientsText = ingredientsEl ? ingredientsEl.innerText.trim() : '';

    const traitsPairs = [];
    if (traitsEl) {
      const children = traitsEl.querySelectorAll('li, div > div, dl > div');
      children.forEach((node) => {
        const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 45 && /\d/.test(t)) {
          traitsPairs.push(t);
        }
      });
    }
    const traitsText = traitsPairs.length > 0
      ? Array.from(new Set(traitsPairs)).join(' | ')
      : (traitsEl ? traitsEl.innerText.replace(/\n+/g, ' | ').trim() : '');

    const imageKey = snippetImg ? extractImageKey(snippetImg.getAttribute('src')) : null;

    const meta = {
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

    const parserStatus = (meta.title && meta.price) ? 'OK' : 'WARN';
    LQS_RECORDER.updateModule(
      'parser',
      parserStatus,
      `Товар: "${meta.title.slice(0, 32)}", цена=${meta.price ?? '?'}₽, вес="${meta.amountText || '?'}"`,
      meta
    );

    return meta;
  }

  function extractNutrientValue(traitsText, keywordRegex, unitHintRegex) {
    if (!traitsText) return null;
    const segments = traitsText.split(/[|\n;]+/);
    for (const seg of segments) {
      if (keywordRegex.test(seg)) {
        const m = seg.match(/([\d]+(?:[.,]\d+)?)/);
        if (m) {
          const val = parseFloat(m[1].replace(',', '.'));
          if (!isNaN(val)) return val;
        }
      }
    }
    const directAfter = new RegExp(keywordRegex.source + '[^\\d|\\n]{0,12}([\\d]+(?:[.,]\\d+)?)', 'i');
    const m1 = traitsText.match(directAfter);
    if (m1) return parseFloat(m1[1].replace(',', '.'));

    const directBefore = new RegExp('([\\d]+(?:[.,]\\d+)?)\\s*' + unitHintRegex.source + '\\s*' + keywordRegex.source, 'i');
    const m2 = traitsText.match(directBefore);
    if (m2) return parseFloat(m2[1].replace(',', '.'));

    return null;
  }

  function normalizePieceUnit(rawUnit) {
    const u = String(rawUnit || '').toLowerCase();
    if (u.startsWith('пакет') || u.startsWith('пак') || u.startsWith('саше')) return 'пак';
    if (u.startsWith('капс')) return 'капс';
    if (u.startsWith('табл')) return 'табл';
    if (u.startsWith('рул')) return 'рул';
    if (u.startsWith('лист')) return 'лист';
    if (u.startsWith('порц')) return 'порц';
    if (u.startsWith('пар')) return 'пар';
    if (u.startsWith('уп')) return 'уп';
    return 'шт';
  }

  function parseWeightAndPiecesFromString(rawStr) {
    if (!rawStr) return { weightGrams: null, unitLabel: 'кг', piecesCount: null, pieceUnitLabel: 'шт' };
    const text = String(rawStr).replace(/[\u00ad\u200b\u00a0]/g, ' ').trim();

    let weightGrams = null;
    let unitLabel = 'кг';
    let piecesCount = null;
    let pieceUnitLabel = 'шт';

    const multiMatch =
      text.match(/(\d+)\s*[×xх*]\s*([\d.,]+)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i) ||
      text.match(/(\d+)\s*(шт|штук[а-я]*|пакет[а-я]*|пак|саше|капс[а-я]*|порц[а-я]*|уп[а-я]*)\.?\s*(?:по|[×xх*]|\s)\s*([\d.,]+)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i);

    if (multiMatch) {
      if (multiMatch.length === 4) {
        const count = parseInt(multiMatch[1], 10) || 1;
        const val = parseFloat(multiMatch[2].replace(',', '.'));
        const unit = multiMatch[3].toLowerCase();
        unitLabel = (unit.startsWith('мл') || unit.startsWith('л')) ? 'л' : 'кг';
        if (val > 0) {
          const singleGrams = (unit.startsWith('кг') || unit.startsWith('л')) ? val * 1000 : val;
          weightGrams = count * singleGrams;
          piecesCount = count;
        }
      } else if (multiMatch.length >= 5) {
        const count = parseInt(multiMatch[1], 10) || 1;
        pieceUnitLabel = normalizePieceUnit(multiMatch[2]);
        const val = parseFloat(multiMatch[3].replace(',', '.'));
        const unit = multiMatch[4].toLowerCase();
        unitLabel = (unit.startsWith('мл') || unit.startsWith('л')) ? 'л' : 'кг';
        if (val > 0) {
          const singleGrams = (unit.startsWith('кг') || unit.startsWith('л')) ? val * 1000 : val;
          weightGrams = count * singleGrams;
          piecesCount = count;
        }
      }
    }

    if (!weightGrams) {
      const singleMatch = text.match(/(?:^|[^\d.,])([\d]+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i);
      if (singleMatch) {
        const val = parseFloat(singleMatch[1].replace(',', '.'));
        const unit = singleMatch[2].toLowerCase();
        unitLabel = (unit.startsWith('мл') || unit.startsWith('л')) ? 'л' : 'кг';
        if (val > 0) {
          weightGrams = (unit.startsWith('кг') || unit.startsWith('л')) ? val * 1000 : val;
        }
      }
    }

    const pieceMatch = text.match(/(?:^|[^\d.,])(\d+)\s*(шт|штук[а-я]*|пакет[а-я]*|пак|саше|капс[а-я]*|табл[а-я]*|рулон[а-я]*|лист[а-я]*|порц[а-я]*|пар[а-я]*|уп[а-я]*)(?![а-яёa-z])/i);
    if (pieceMatch) {
      const cnt = parseInt(pieceMatch[1], 10);
      if (cnt > 0) {
        piecesCount = cnt;
        pieceUnitLabel = normalizePieceUnit(pieceMatch[2]);
      }
    }

    return { weightGrams, unitLabel, piecesCount, pieceUnitLabel };
  }

  function analyzeProductQuality(meta) {
    const flags = [];
    let pricePerKg = null;
    let weightGrams = null;
    let unitLabel = 'кг';
    let piecesCount = null;
    let pieceUnitLabel = 'шт';
    let pricePerPiece = null;
    let proteinPer100g = null;
    let fatPer100g = null;
    let carbsPer100g = null;
    let kcalPer100g = null;
    let pricePer100gProtein = null;

    const fromAmount = parseWeightAndPiecesFromString(meta.amountText);
    const fromTitle = parseWeightAndPiecesFromString(meta.title);

    if (fromAmount.weightGrams) {
      weightGrams = fromAmount.weightGrams;
      unitLabel = fromAmount.unitLabel;
    } else if (fromTitle.weightGrams) {
      weightGrams = fromTitle.weightGrams;
      unitLabel = fromTitle.pieceUnitLabel && !fromTitle.weightGrams ? 'кг' : fromTitle.unitLabel;
    }

    if (fromAmount.piecesCount) {
      piecesCount = fromAmount.piecesCount;
      pieceUnitLabel = fromAmount.pieceUnitLabel;
    } else if (fromTitle.piecesCount) {
      piecesCount = fromTitle.piecesCount;
      pieceUnitLabel = fromTitle.pieceUnitLabel;
    }

    if (weightGrams && weightGrams > 0 && meta.price) {
      pricePerKg = Math.round((meta.price / weightGrams) * 1000);
    }

    if (piecesCount && piecesCount > 0 && meta.price) {
      pricePerPiece = Math.round(meta.price / piecesCount);
    }

    if (meta.traitsText) {
      proteinPer100g = extractNutrientValue(meta.traitsText, /белк[иао]?/i, /(?:г|гр)\.?/);
      fatPer100g = extractNutrientValue(meta.traitsText, /жир[ыаов]?/i, /(?:г|гр)\.?/);
      carbsPer100g = extractNutrientValue(meta.traitsText, /углевод[ыаов]?/i, /(?:г|гр)\.?/);
      kcalPer100g = extractNutrientValue(meta.traitsText, /(?:ккал|калор)/i, /(?:ккал)?/);

      if (proteinPer100g !== null && proteinPer100g >= 3 && proteinPer100g <= 100 && pricePerKg) {
        const totalProteinInKg = proteinPer100g * 10;
        pricePer100gProtein = Math.round((pricePerKg / totalProteinInKg) * 100);
      }

      if (carbsPer100g !== null && !isNaN(carbsPer100g)) {
        if (carbsPer100g <= 5) {
          flags.push({ type: 'good', text: `🥑 Кето (${carbsPer100g}г угл)` });
        } else if (carbsPer100g >= 22) {
          flags.push({ type: 'bad', text: `🍞 ${carbsPer100g}г угл` });
        }
      }

      if (proteinPer100g !== null && proteinPer100g >= 15) {
        flags.push({ type: 'good', text: `💪 Много белка (${proteinPer100g}г)` });
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

      const hasBad = flags.some((f) => f.type === 'bad');
      if (!hasBad && ingLower.length > 10) {
        flags.push({ type: 'good', text: '✅ Чистый состав' });
      }
    }

    const result = {
      weightGrams,
      pricePerKg,
      unitLabel,
      piecesCount,
      pieceUnitLabel,
      pricePerPiece,
      proteinPer100g,
      fatPer100g,
      carbsPer100g,
      kcalPer100g,
      pricePer100gProtein,
      flags: flags.slice(0, 6)
    };

    const unitSummary = pricePerKg
      ? `Цена/${unitLabel}: ~${pricePerKg}₽`
      : (pricePerPiece && piecesCount > 1 ? `Цена/${pieceUnitLabel}: ~${pricePerPiece}₽ (${piecesCount} ${pieceUnitLabel})` : 'Поштучно/без веса');

    LQS_RECORDER.updateModule(
      'calculator',
      (pricePerKg || pricePerPiece) ? 'OK' : 'WARN',
      `${unitSummary}, Белок/100г: ${proteinPer100g ?? '—'}г (${pricePer100gProtein ? pricePer100gProtein + '₽/100г' : '—'}), Флагов: ${result.flags.length}`,
      result
    );

    return result;
  }

  function buildMetricsInlineHtml(smart, meta, slug) {
    if (!smart) return '';
    let primaryPill = '';
    if (smart.pricePerKg) {
      const pieceHint = (smart.pricePerPiece && smart.piecesCount > 1)
        ? ` (~${smart.pricePerPiece} ₽/${smart.pieceUnitLabel})`
        : '';
      primaryPill = `<span class="lqs-metric-pill" title="Честная цена за 1 ${smart.unitLabel}${pieceHint}">⚖️ ~${smart.pricePerKg} ₽/${smart.unitLabel}</span>`;
    } else if (smart.pricePerPiece && smart.piecesCount && smart.piecesCount > 1) {
      primaryPill = `<span class="lqs-metric-pill" title="Товар продаётся поштучно (${smart.piecesCount} ${smart.pieceUnitLabel} в упаковке)">🔢 ~${smart.pricePerPiece} ₽/${smart.pieceUnitLabel}</span>`;
    } else if (meta && meta.price) {
      primaryPill = `<span class="lqs-metric-pill" title="Товар продаётся поштучно (вес в граммах не указан)">🔢 ${Math.round(meta.price)} ₽/шт</span>`;
    } else {
      primaryPill = `<span class="lqs-metric-pill" title="Вес или объём не указан на карточке">⚖️ Поштучно</span>`;
    }

    const proteinPill = smart.pricePer100gProtein
      ? `<span class="lqs-metric-pill protein-pill" title="Стоимость 100 г чистого белка (${smart.proteinPer100g}г белка на 100г)">🥩 ~${smart.pricePer100gProtein} ₽ / 100г белка</span>`
      : '';

    let aiVerdictPill = '';
    const cachedAi = (slug && lastAiResultBySlug.get(slug)) || (slug && aiCacheMemory && aiCacheMemory[slug]);
    if (cachedAi && cachedAi.loading) {
      aiVerdictPill = `<span class="lqs-metric-pill ai-pill-loading" title="Zero-Click Автопилот анализирует товар...">🤖 ⏳ ИИ...</span>`;
    } else if (cachedAi && cachedAi.verdict) {
      const vBadge = extractVerdictBadgeFromText(cachedAi.verdict);
      if (vBadge) {
        aiVerdictPill = `<span class="lqs-metric-pill ${vBadge.cls}" title="Вердикт ИИ-ревизора (нажми Подробнее)">${escapeHtml(vBadge.text)}</span>`;
      }
    }

    return `${primaryPill} ${proteinPill} ${aiVerdictPill}`.trim();
  }

  // ==========================================================================
  // ОТРИСОВКА И СИНХРОНИЗАЦИЯ ВИДЖЕТА НА СТРАНИЦЕ ТОВАРА
  // ==========================================================================
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
      LQS_RECORDER.counters.domWritesExecuted += 1;
    } else {
      LQS_RECORDER.counters.domWritesSkipped += 1;
    }
    if (dotEl.title !== nextDotTitle) {
      dotEl.title = nextDotTitle;
    }

    const nextText = isOpen ? '▴ Скрыть' : '▾ Подробнее';
    if (labelEl.textContent !== nextText) {
      labelEl.textContent = nextText;
      LQS_RECORDER.counters.domWritesExecuted += 1;
    } else {
      LQS_RECORDER.counters.domWritesSkipped += 1;
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

    LQS_RECORDER.counters.drawerToggles += 1;
    LQS_RECORDER.record('USER_ACTION', `Spoiler drawer ${isOpen ? 'OPENED' : 'CLOSED'} (${source})`, { slug });
    return isOpen;
  }

  function renderAiVerdictIntoPanel(panel, slug, meta, resultObj, shouldOpenDrawer = true) {
    if (!panel || !resultObj || !resultObj.verdict) return;
    const drawer = panel.querySelector('#lqs-drawer');
    const aiBox = panel.querySelector('#lqs-ai-box');
    const aiContent = panel.querySelector('#lqs-ai-content');
    const aiSources = panel.querySelector('#lqs-ai-sources');
    if (!aiBox || !aiContent || !aiSources) return;

    lastAiResultBySlug.set(slug, {
      verdict: resultObj.verdict,
      sources: resultObj.sources || [],
      mode: resultObj.mode || 'Автопилот ИИ',
      loading: false
    });

    if (shouldOpenDrawer && drawer && !drawer.classList.contains('open')) {
      drawer.classList.add('open');
      if (slug) drawerOpenBySlug.set(slug, true);
    }

    const smart = analyzeProductQuality(meta);
    updateDrawerToggleButton(panel, Boolean(drawer && drawer.classList.contains('open')), currentReviewCache, smart);

    const metricsBox = panel.querySelector('#lqs-metrics-inline');
    if (metricsBox) {
      setHtmlIfChanged(metricsBox, buildMetricsInlineHtml(smart, meta, slug), 'metrics-inline-ai');
    }

    aiBox.classList.add('visible');
    aiContent.innerHTML = formatAiTextToHtml(resultObj.verdict);
    const sourceLinks = Array.isArray(resultObj.sources)
      ? resultObj.sources
          .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
          .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">🔗 ${escapeHtml(s.title || 'Источник')}</a>`)
          .join('')
      : '';

    const modeBadge = `<span style="color:#0369a1;font-size:11px;font-weight:600;">⚡ ${escapeHtml(resultObj.mode || 'Автопилот ИИ')}</span>`;
    aiSources.innerHTML = sourceLinks ? `${modeBadge} ${sourceLinks}` : modeBadge;
  }

  function syncExistingPanelUI(panel, review, meta) {
    LQS_RECORDER.counters.panelSyncs += 1;
    currentReviewCache = review;
    const slug = panel.dataset.slug || extractSlugFromUrl(window.location.href);

    const r = (review && review.rating) ? Number(review.rating) : 0;
    const banned = Boolean(review && review.banned);
    const tags = (review && Array.isArray(review.tags)) ? review.tags : [];
    const note = (review && review.note) ? String(review.note) : '';
    const hasAnyReviewData = Boolean(r > 0 || banned || tags.length > 0 || note.trim());

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
      const nextMetricsHtml = buildMetricsInlineHtml(smart, meta, slug);
      setHtmlIfChanged(metricsBox, nextMetricsHtml, 'metrics-inline');
    }

    const flagsBox = panel.querySelector('#lqs-drawer-flags');
    if (flagsBox && smart) {
      const nextFlagsHtml = smart.flags.map((f) => `<span class="lqs-flag-${f.type}">${escapeHtml(f.text)}</span>`).join('');
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

    const resetBtn = panel.querySelector('#lqs-reset-review');
    if (resetBtn) {
      resetBtn.classList.toggle('is-hidden', !hasAnyReviewData);
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

  async function requestAiProductReview(meta, panel, forceRefresh = false, isZeroClickAuto = false) {
    const drawer = panel.querySelector('#lqs-drawer');
    const aiBox = panel.querySelector('#lqs-ai-box');
    const aiContent = panel.querySelector('#lqs-ai-content');
    const aiSources = panel.querySelector('#lqs-ai-sources');

    const slug = panel.dataset.slug || extractSlugFromUrl(window.location.href);
    const settings = await getSettings();

    if (!isZeroClickAuto || settings.autoOpenDrawerOnAi !== false) {
      drawer.classList.add('open');
      if (slug) drawerOpenBySlug.set(slug, true);
    }

    lastAiResultBySlug.set(slug, { loading: true });
    const smart = analyzeProductQuality(meta);
    updateDrawerToggleButton(panel, drawer.classList.contains('open'), currentReviewCache, smart);

    const metricsBox = panel.querySelector('#lqs-metrics-inline');
    if (metricsBox) {
      setHtmlIfChanged(metricsBox, buildMetricsInlineHtml(smart, meta, slug), 'metrics-inline-loading');
    }

    aiBox.classList.add('visible');
    aiContent.innerHTML = isZeroClickAuto
      ? '⏳ <b>Zero-Click Автопилот:</b> автоматически проверяю отзывы по 14 площадкам и запускаю ИИ-разбор состава...'
      : '⏳ Ищу отзывы в сети и спрашиваю ИИ-ревизора (Автопилот)...';
    aiSources.innerHTML = '';

    const t0 = performance.now();
    if (isZeroClickAuto) {
      LQS_RECORDER.counters.autoAiRuns += 1;
    }
    LQS_RECORDER.record('AI', `Started AI review for "${meta.title}" (force=${forceRefresh}, auto=${isZeroClickAuto})`);
    LQS_RECORDER.updateModule('aiReviewer', 'RUNNING', `Запрос ИИ-ревизора для "${meta.title.slice(0, 30)}"...`);

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        const bgResult = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            {
              type: 'LQS_ANALYZE_PRODUCT',
              payload: {
                slug,
                title: meta.title,
                brand: meta.brand,
                amount: meta.amountText,
                price: meta.price,
                ingredients: meta.ingredientsText,
                traits: meta.traitsText,
                pricePerKg: smart.pricePerKg,
                unitLabel: smart.unitLabel,
                pricePerPiece: smart.pricePerPiece,
                pieceUnitLabel: smart.pieceUnitLabel,
                piecesCount: smart.piecesCount,
                proteinPer100g: smart.proteinPer100g,
                pricePer100gProtein: smart.pricePer100gProtein,
                forceRefresh: Boolean(forceRefresh)
              }
            },
            (resp) => {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(resp || { ok: false, error: 'Empty response from background service worker' });
              }
            }
          );
        });

        if (bgResult && bgResult.ok && bgResult.verdict) {
          const dt = Math.round(performance.now() - t0);
          const modeLabel = bgResult.mode || 'Автопилот Gemini';
          LQS_RECORDER.updateModule(
            'aiReviewer',
            'OK',
            `Ответ через [${modeLabel}] за ${dt} мс (источников: ${(bgResult.sources || []).length})`
          );
          LQS_RECORDER.record('AI', `Orchestrator success via [${modeLabel}] in ${dt}ms`, {
            cached: Boolean(bgResult.cached),
            sourcesCount: (bgResult.sources || []).length
          });

          renderAiVerdictIntoPanel(panel, slug, meta, bgResult, !isZeroClickAuto || settings.autoOpenDrawerOnAi !== false);
          return;
        } else if (bgResult && bgResult.error) {
          lastAiResultBySlug.delete(slug);
          if (metricsBox) {
            setHtmlIfChanged(metricsBox, buildMetricsInlineHtml(smart, meta, slug), 'metrics-inline-err');
          }
          LQS_RECORDER.record('AI', `Background orchestrator reported: ${bgResult.error}`);
          const dt = Math.round(performance.now() - t0);
          LQS_RECORDER.updateModule('aiReviewer', 'WARN', `Ответ оркестратора (${dt} мс): ${bgResult.error}`);
          aiContent.innerHTML = `⚠️ <b>${escapeHtml(bgResult.error)}</b>`;
          if (Array.isArray(bgResult.sources) && bgResult.sources.length > 0) {
            aiSources.innerHTML = bgResult.sources
              .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
              .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">🔗 ${escapeHtml(s.title || 'Отзыв в сети')}</a>`)
              .join('');
          }
          return;
        }
      } catch (bgErr) {
        LQS_RECORDER.record('AI', `Background orchestrator exception: ${bgErr.message || bgErr}`);
      }
    }

    lastAiResultBySlug.delete(slug);
    if (metricsBox) {
      setHtmlIfChanged(metricsBox, buildMetricsInlineHtml(smart, meta, slug), 'metrics-inline-fallback');
    }

    const dt = Math.round(performance.now() - t0);
    LQS_RECORDER.updateModule(
      'aiReviewer',
      'ERROR',
      `ИИ не подключён (${dt} мс) — войди в аккаунт на gemini.google.com`
    );

    aiContent.innerHTML =
      `⚠️ <b>Для запуска Автопилота ИИ нужно один раз войти в аккаунт Google на <a href="https://gemini.google.com/" target="_blank" rel="noopener noreferrer">gemini.google.com</a>!</b>`;
  }

  /**
   * Планирует автоматический Zero-Click запуск ИИ при открытии карточки товара
   */
  function scheduleZeroClickAiForProduct(slug, panel) {
    if (!slug || !panel) return;

    // 1. Если для этого slug уже есть вердикт в памяти или в локальном кэше браузера — рендерим мгновенно (0 мс)!
    const cachedEntry = lastAiResultBySlug.get(slug) || (aiCacheMemory && aiCacheMemory[slug]);
    if (cachedEntry && cachedEntry.verdict) {
      const latestMeta = extractProductPageMetadata();
      getSettings().then((settings) => {
        renderAiVerdictIntoPanel(panel, slug, latestMeta, cachedEntry, settings.autoOpenDrawerOnAi !== false);
      });
      return;
    }

    if (autoAiTriggeredSlugs.has(slug)) return;

    clearTimeout(autoAiDebounceTimer);
    autoAiDebounceTimer = setTimeout(async () => {
      const currentSlug = extractSlugFromUrl(window.location.href);
      if (currentSlug !== slug) return;

      const settings = await getSettings();
      if (settings.autoRunAiOnProductPage === false) return;

      const activePanel = document.querySelector(`.lqs-product-panel[data-slug="${CSS.escape(slug)}"]`) || panel;
      const latestMeta = extractProductPageMetadata();
      if (!latestMeta || !latestMeta.title) return;

      autoAiTriggeredSlugs.add(slug);
      requestAiProductReview(latestMeta, activePanel, false, true);
    }, 550);
  }

  async function renderProductPageWidget() {
    if (isRenderingProduct) {
      pendingProductRender = true;
      return;
    }

    const slug = extractSlugFromUrl(window.location.href);
    const mainPage = document.querySelector('main[data-testid="good-page-desktop"]');
    if (!slug || !mainPage) {
      if (slug && !mainPage) {
        LQS_RECORDER.updateModule('widget', 'WARN', `URL товара (${slug}), но main[data-testid="good-page-desktop"] ещё не найден в DOM`);
      }
      return;
    }

    const infoBlock = mainPage.querySelector('div[data-testid="product-info"]') ||
                      mainPage.querySelector('div[data-testid="product-card-header"]');
    if (!infoBlock) {
      LQS_RECORDER.updateModule('widget', 'WARN', `Не найден контейнер product-info / product-card-header для ${slug}`);
      return;
    }

    isRenderingProduct = true;
    try {
      const db = await getReviewsDB();
      const meta = extractProductPageMetadata();
      const match = findReviewInDB(db, {
        slug,
        productId: meta.productId,
        imageKey: meta.imageKey,
        cleanTitle: meta.cleanTitle
      });
      const savedReview = match ? match.item : null;

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
        scheduleZeroClickAiForProduct(slug, existing);
        LQS_RECORDER.updateModule(
          'widget',
          'OK',
          `Виджет синхронизирован для ${slug} (${current.rating}★, match=${match ? match.matchedBy : 'new'})`
        );
        return;
      }
      if (existing) existing.remove();

      const smart = analyzeProductQuality(meta);
      const isDrawerInitiallyOpen = Boolean(drawerOpenBySlug.get(slug));
      const hasAnyReviewData = Boolean(current.rating > 0 || current.banned || current.tags.length > 0 || current.note.trim());

      const panel = document.createElement('div');
      panel.className = `lqs-product-panel ${current.banned || (current.rating > 0 && current.rating <= 2) ? 'is-banned' : (current.rating >= 4 ? 'is-god' : '')}`;
      panel.dataset.slug = slug;

      const initialMetricsHtml = buildMetricsInlineHtml(smart, meta, slug);
      const initialFlagsHtml = smart.flags.map((f) => `<span class="lqs-flag-${f.type}">${escapeHtml(f.text)}</span>`).join('');

      panel.innerHTML = `
        <!-- ЕДИНСТВЕННАЯ ОСНОВНАЯ СТРОКА: Звёзды + Цена/кг + Цена/100г белка + Живой статус ИИ + кнопка «▾ Подробнее» -->
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

        <!-- ВЫПАДАЮЩЕЕ МЕНЮ ПОД КАПОТОМ (открывается автоматически при Zero-Click ИИ или по клику на «▾ Подробнее») -->
        <div class="lqs-drawer ${isDrawerInitiallyOpen ? 'open' : ''}" id="lqs-drawer">
          <div class="lqs-drawer-toolbar">
            <div class="lqs-drawer-actions">
              <button type="button" class="lqs-mini-btn ai-btn" id="lqs-ai-btn" title="Найти отзывы в сети и спросить ИИ">
                🤖 ИИ-обзор
              </button>
              <button type="button" class="lqs-mini-btn ${current.banned ? 'ban-active' : ''}" id="lqs-ban-toggle" title="В чёрный список">
                ${current.banned ? '💀 В бане' : '🚫 В бан'}
              </button>
              <button type="button" class="lqs-mini-btn reset-btn ${hasAnyReviewData ? '' : 'is-hidden'}" id="lqs-reset-review" title="Очистить оценку и заметку для этого товара">
                🗑️ Сброс
              </button>
            </div>

            <div class="lqs-drawer-flags" id="lqs-drawer-flags">${initialFlagsHtml}</div>
          </div>

          <div class="lqs-tags-row">
            ${PRESET_TAGS.map((tag) => `
              <span class="lqs-tag-chip ${current.tags.includes(tag) ? 'selected' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</span>
            `).join('')}
          </div>

          <div class="lqs-note-wrap">
            <textarea class="lqs-note-input" id="lqs-note-area" rows="2" placeholder="Короткая заметка о товаре..."></textarea>
            <button type="button" class="lqs-save-btn" id="lqs-save-btn">💾 Ок</button>
          </div>

          <div class="lqs-ai-box" id="lqs-ai-box">
            <div class="lqs-ai-header">
              <span>🤖 Сводка отзывов + разбор состава (Zero-Click Автопилот)</span>
              <button type="button" class="lqs-ai-refresh-btn" id="lqs-ai-refresh" title="Принудительно переспросить ИИ-ревизора">🔄 Обновить</button>
            </div>
            <div class="lqs-ai-content" id="lqs-ai-content"></div>
            <div class="lqs-ai-sources" id="lqs-ai-sources"></div>
          </div>
        </div>
      `;

      const metricsEl = panel.querySelector('#lqs-metrics-inline');
      if (metricsEl) metricsEl.dataset.lqsHtmlCache = initialMetricsHtml;
      const flagsEl = panel.querySelector('#lqs-drawer-flags');
      if (flagsEl) flagsEl.dataset.lqsHtmlCache = initialFlagsHtml;

      updateDrawerToggleButton(panel, isDrawerInitiallyOpen, current, smart);

      const barContainer = infoBlock.querySelector('div[data-testid="bar-container"]');
      const mountPlace = (barContainer && barContainer.parentNode) ? 'after:bar-container' : 'prepend:infoBlock';
      if (barContainer && barContainer.parentNode) {
        barContainer.parentNode.insertBefore(panel, barContainer.nextSibling);
      } else {
        infoBlock.prepend(panel);
      }

      LQS_RECORDER.counters.panelMounts += 1;
      LQS_RECORDER.updateModule(
        'widget',
        'OK',
        `Смонтирован (${mountPlace}) для ${slug}, match=${match ? match.matchedBy : 'none'}`
      );
      LQS_RECORDER.record('WIDGET', `Mounted panel for ${slug} at ${mountPlace}`, {
        rating: current.rating,
        banned: current.banned,
        pricePerKg: smart.pricePerKg,
        pricePer100gProtein: smart.pricePer100gProtein
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
        syncExistingPanelUI(panel, updated || current, latestMeta);
        guardAddToCartButton(updated || current);
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
          LQS_RECORDER.record('USER_ACTION', `Star rating set to ${current.rating}★ on ${slug}`);
          persistState();
        });
      });

      panel.querySelector('#lqs-ban-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        current.banned = !current.banned;
        if (current.banned && current.rating === 0) current.rating = 1;
        LQS_RECORDER.record('USER_ACTION', `Ban toggled to ${current.banned} on ${slug}`);
        persistState();
      });

      panel.querySelector('#lqs-reset-review').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        current.rating = 0;
        current.banned = false;
        current.tags = [];
        current.note = '';
        noteArea.value = '';
        LQS_RECORDER.record('USER_ACTION', `Reset review for ${slug}`);
        persistState();
      });

      panel.querySelector('#lqs-drawer-toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleDrawerState(panel, 'button-click');
      });

      panel.querySelector('#lqs-ai-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const latestMeta = extractProductPageMetadata();
        requestAiProductReview(latestMeta, panel, false, false);
      });

      panel.querySelector('#lqs-ai-refresh').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const latestMeta = extractProductPageMetadata();
        requestAiProductReview(latestMeta, panel, true, false);
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
          LQS_RECORDER.record('USER_ACTION', `Toggled tag "${tag}" on ${slug}`);
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
        LQS_RECORDER.record('USER_ACTION', `Saved note on ${slug} (${noteArea.value.length} chars)`);
        persistState();
        const saveBtn = e.currentTarget;
        saveBtn.textContent = '✅ Ок';
        setTimeout(() => { saveBtn.textContent = '💾 Ок'; }, 1200);
      });

      // ЗАПУСКАЕМ ZERO-CLICK АВТОПИЛОТ ИИ ПРИ ОТКРЫТИИ ТОВАРА!
      scheduleZeroClickAiForProduct(slug, panel);
    } catch (err) {
      LQS_RECORDER.updateModule('widget', 'ERROR', `Ошибка рендера: ${err.message || err}`);
      LQS_RECORDER.error('renderProductPageWidget', err);
    } finally {
      isRenderingProduct = false;
      if (pendingProductRender) {
        pendingProductRender = false;
        setTimeout(renderProductPageWidget, 50);
      }
    }
  }

  // ==========================================================================
  // ЗАЩИТА КНОПКИ «В КОРЗИНУ» ОТ СЛУЧАЙНОЙ ПОКУПКИ ЗАБАНЕННОГО ТОВАРА
  // ==========================================================================
  function guardAddToCartButton(review) {
    const addBtn = document.querySelector('main[data-testid="good-page-desktop"] button[data-testid="snippet-control"]');
    if (!addBtn) {
      LQS_RECORDER.updateModule('cartGuard', 'IDLE', 'Кнопка snippet-control не отображена (товар уже в корзине или нет в наличии)');
      return;
    }

    const isBad = Boolean(review && (review.banned || (review.rating > 0 && review.rating <= 2)));
    const nextBadStr = isBad ? 'true' : 'false';
    const nextNoteStr = (review && review.note) ? review.note : '';
    const nextRatingStr = (review && review.rating) ? String(review.rating) : '1';

    LQS_RECORDER.updateModule(
      'cartGuard',
      'OK',
      isBad ? `Активна блокировка корзины (${nextRatingStr}★)` : 'Кнопка корзины проверена (товар не в бане)'
    );

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
            LQS_RECORDER.record('CART_GUARD', 'Intercepted Add-to-Cart click on banned item');
            const ok = window.confirm(
              `⚠️ Этот товар у тебя в чёрном списке (${addBtn.dataset.lqsRating}★).\nЗаметка: "${addBtn.dataset.lqsNote || 'Не брать'}"\n\nВсё равно добавить в корзину?`
            );
            if (!ok) {
              e.stopPropagation();
              e.preventDefault();
              LQS_RECORDER.record('CART_GUARD', 'User cancelled adding banned item to cart');
            } else {
              LQS_RECORDER.record('CART_GUARD', 'User confirmed adding banned item despite warning');
            }
          }
        }, true);
      }
    } else {
      addBtn.style.background = '';
      addBtn.style.color = '';
    }
  }

  // ==========================================================================
  // РАЗМЕТКА КАРТОЧЕК В КАТАЛОГЕ, ПОИСКЕ И «ВЫ ПОКУПАЛИ»
  // ==========================================================================
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
    LQS_RECORDER.counters.catalogPasses += 1;
    const db = await getReviewsDB();
    const cards = document.querySelectorAll('div[data-testid="product-card"]');

    let badgedCount = 0;
    let bannedCount = 0;

    cards.forEach((card) => {
      const ids = extractCardIdentifiers(card);
      const match = findReviewInDB(db, ids);
      const review = match ? match.item : null;
      const aiCached = ids.slug && aiCacheMemory ? aiCacheMemory[ids.slug] : null;

      const oldNote = card.querySelector('.lqs-card-note-preview');
      if (oldNote) oldNote.remove();

      const hasReview = Boolean(review && (review.rating > 0 || review.banned));
      const hasAiVerdict = Boolean(!hasReview && aiCached && aiCached.verdict);

      if (!hasReview && !hasAiVerdict) {
        if (card.dataset.lqsBadgeKey) {
          delete card.dataset.lqsBadgeKey;
          const oldBadge = card.querySelector('.lqs-card-badge');
          if (oldBadge) oldBadge.remove();
          card.classList.remove('lqs-card-dimmed');
          LQS_RECORDER.counters.catalogBadgesUpdated += 1;
        } else {
          LQS_RECORDER.counters.catalogBadgesSkipped += 1;
        }
        return;
      }

      badgedCount += 1;
      let tier = 'ok';
      let text = '';
      let titleText = '';
      let isBad = false;

      if (hasReview) {
        isBad = Boolean(review.banned || (review.rating > 0 && review.rating <= 2));
        if (isBad) bannedCount += 1;
        tier = isBad ? 'trash' : (review.rating >= 4 ? 'god' : 'ok');
        text = isBad ? `💀 ${review.rating ? review.rating + '★' : 'БАН'}` : `★ ${review.rating}`;
        titleText = (review.note && review.note.trim())
          ? review.note.trim()
          : ((review.tags && review.tags.length) ? review.tags.join(', ') : '');
      } else if (hasAiVerdict) {
        const vBadge = extractVerdictBadgeFromText(aiCached.verdict);
        text = vBadge ? vBadge.shortCatalog : '🤖';
        tier = vBadge && vBadge.cls === 'verdict-good' ? 'god' : (vBadge && vBadge.cls === 'verdict-bad' ? 'trash' : 'ok');
        titleText = aiCached.verdict.replace(/\*\*/g, '').slice(0, 220);
      }

      const badgeKey = `${tier}|${text}|${titleText}`;

      let badge = card.querySelector('.lqs-card-badge');
      if (card.dataset.lqsBadgeKey === badgeKey && badge) {
        LQS_RECORDER.counters.catalogBadgesSkipped += 1;
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
      LQS_RECORDER.counters.catalogBadgesUpdated += 1;
    });

    LQS_RECORDER.updateModule(
      'catalog',
      'OK',
      `Просканировано карточек: ${cards.length} (с бейджем: ${badgedCount}, затемнено в бане: ${bannedCount})`
    );
  }

  // ==========================================================================
  // НАБЛЮДАТЕЛЬ DOM И НАДЁЖНЫЙ ДЕТЕКТОР SPA-ПЕРЕХОДОВ
  // ==========================================================================
  let debounceTimer = null;
  function scheduleUpdate() {
    LQS_RECORDER.counters.scheduleCalls += 1;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      checkUrlTransition();
      renderProductPageWidget();
      decorateCatalogCards();
    }, 120);
  }

  function checkUrlTransition() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastObservedUrl) {
      const prevUrl = lastObservedUrl;
      lastObservedUrl = currentUrl;
      LQS_RECORDER.counters.spaTransitions += 1;
      try {
        LQS_RECORDER.record('ROUTER', `SPA transition: ${new URL(prevUrl).pathname} -> ${window.location.pathname}`);
      } catch {
        LQS_RECORDER.record('ROUTER', `SPA transition -> ${window.location.pathname}`);
      }
      runHydrationResyncWave('spa-url-change');
    }
  }

  // Надёжный легковесный поллер URL каждые 350 мс на случай тихих history.pushState в React Router
  setInterval(checkUrlTransition, 350);

  function runHydrationResyncWave(reason = 'init') {
    const slug = extractSlugFromUrl(window.location.href);
    LQS_RECORDER.updateModule(
      'router',
      'OK',
      `Маршрут: ${window.location.pathname} (${slug ? 'Товар: ' + slug : 'Каталог'}), причина: ${reason}`
    );
    LQS_RECORDER.record('ROUTER', `Hydration resync wave (${reason}) on ${window.location.pathname}`);
    [0, 180, 500, 1200, 2500].forEach((delay) => {
      setTimeout(() => {
        renderProductPageWidget();
        decorateCatalogCards();
      }, delay);
    });
  }

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
      LQS_RECORDER.counters.extMutations += 1;
      scheduleUpdate();
    } else {
      LQS_RECORDER.counters.selfMutationsIgnored += 1;
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes[STORAGE_KEY]) {
          reviewsDbCache = changes[STORAGE_KEY].newValue || {};
          LQS_RECORDER.updateModule(
            'storage',
            'OK',
            `База синхронизирована из storage.onChanged (${Object.keys(reviewsDbCache).length} товаров)`
          );
          renderProductPageWidget();
          decorateCatalogCards();
        }
        if (changes[AI_CACHE_KEY]) {
          aiCacheMemory = changes[AI_CACHE_KEY].newValue || {};
          decorateCatalogCards();
        }
        if (changes[SETTINGS_KEY]) {
          renderProductPageWidget();
        }
      }
    });
  }

  window.addEventListener('popstate', () => runHydrationResyncWave('popstate'));
  window.addEventListener('load', () => runHydrationResyncWave('window-load'));
  runHydrationResyncWave('script-boot');
})();
