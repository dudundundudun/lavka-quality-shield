/**
 * Lavka Quality Shield v2.5.0 — Content Script
 * Что нового в v2.5.0:
 * 1. Исправлена вёрстка на карточке товара:
 *    - Устранено наложение строк в шапке ИИ-блока (.lqs-ai-header) и в кнопке сохранения заметки («💾 Ок»).
 *    - Полная изоляция line-height и flex-параметров кнопок от агрессивных стилей Яндекс Лавки.
 * 2. Прокачанный Баннер Аудита Корзины (.lqs-cart-audit-banner):
 *    - Автоматически сверяет все позиции корзины с ценами конкурентов и гостевыми ценами (без куки).
 *    - Сразу на баннере показывает, сколько позиций дешевле у конкурентов и общую сумму переплаты в рублях.
 *    - Выпадающий список по кнопке «🏪 Цены и ссылки в других магазинах ▾» с найденными ценами и прямыми ссылками
 *      на Перекрёсток, ВкусВилл, Ozon, Яндекс Маркет, Ленту и Купер по каждому товару корзины.
 *    - Быстрый переключатель аккаунтов Лавки («👤 Сменить аккаунт ▾») прямо из корзины в 1 клик.
 * 3. Исправленный захват и авто-сборка корзины (8 из 8 позиций и точный подсчёт штук):
 *    - Точное отделение строк корзины от каруселей рекомендаций, корректное чтение количества из степпера «- N +».
 * 4. Помощник авто-входа на passport.yandex.ru / id.yandex.ru для сохранённых логинов и паролей.
 */

(function () {
  'use strict';

  const VERSION = '2.5.0';
  const STORAGE_KEY = 'lqs_reviews_v1';
  const SETTINGS_KEY = 'lqs_settings_v2';
  const FLIGHT_LOG_KEY = 'lqs_flight_log_v1';
  const AI_CACHE_KEY = 'lqs_ai_cache_v1';
  const PRICE_DB_KEY = 'lqs_price_db_v1';
  const CART_LOCKS_KEY = 'lqs_cart_locks_v1';

  const DEFAULT_SETTINGS = {
    backendUrl: 'http://127.0.0.1:8765',
    aiBaseUrl: 'http://localhost:8083/v1',
    aiApiKey: '',
    aiModel: 'gemini-4-argon',
    useDirectBrowserAiFallback: true,
    autoRunAiOnProductPage: true,
    autoOpenDrawerOnAi: true,
    autoWarmupGeminiTab: true,
    lavkaAccountLabel: 'Аккаунт #1 (Основной)',
    enableGuestPriceProbe: true
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

  const drawerOpenBySlug = new Map();
  const autoAiTriggeredSlugs = new Set();
  const priceIntelRequestedSlugs = new Set();
  const lastAiResultBySlug = new Map();
  const priceSummaryBySlug = new Map();
  let autoAiDebounceTimer = null;

  let reviewsDbCache = null;
  let aiCacheMemory = null;
  let priceDbMemory = null;
  let cartLocksMemory = {};
  let cachedSettings = { ...DEFAULT_SETTINGS };
  let isRenderingProduct = false;
  let pendingProductRender = false;
  let currentReviewCache = null;
  let lastObservedUrl = window.location.href;
  let lastCatalogHarvestTs = 0;

  // Состояние аудита корзины и открытых выпадающих списков в корзине
  let lastCartAuditSignature = '';
  let lastCartCompetitorAudit = null;
  let isCartAuditLoading = false;
  let isCartCompDropdownOpen = false;
  let isCartAccDropdownOpen = false;
  let cachedAccountsVault = null;

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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

  function detectCurrentAccountLabel() {
    try {
      const avatarEl =
        document.querySelector('[data-testid="user-profile"] img[alt]') ||
        document.querySelector('header img[alt*="@"]') ||
        document.querySelector('header [aria-label*="Аккаунт"]');
      if (avatarEl) {
        const alt = (avatarEl.getAttribute('alt') || avatarEl.getAttribute('aria-label') || '').trim();
        if (alt && alt.length > 1 && alt.length < 35 && !/аватар|профиль|user/i.test(alt)) {
          return alt;
        }
      }
    } catch {
      // ignore
    }
    return cachedSettings.lavkaAccountLabel || 'Аккаунт #1 (Основной)';
  }

  // ==========================================================================
  // ПОМОЩНИК АВТО-ВХОДА НА PASSPORT.YANDEX.RU / ID.YANDEX.RU
  // ==========================================================================
  function initYandexPassportHelperIfNeeded() {
    const host = window.location.hostname.toLowerCase();
    if (!host.includes('passport.yandex.ru') && !host.includes('id.yandex.ru')) return false;

    if (document.querySelector('.lqs-passport-helper')) return true;

    chrome.runtime.sendMessage({ type: 'LQS_GET_ACCOUNTS_VAULT' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !Array.isArray(resp.accounts)) return;
      const box = document.createElement('div');
      box.className = 'lqs-passport-helper';

      const accWithCreds = resp.accounts;
      box.innerHTML = `
        <div style="font-weight:800;font-size:12.5px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
          <span>🔐 Lavka Quality Shield: Быстрый вход</span>
          <button type="button" id="lqs-pass-close" style="border:none;background:transparent;cursor:pointer;font-size:14px;">×</button>
        </div>
        <div style="font-size:11px;color:#57534e;margin-bottom:6px;">
          Выбери профиль для авто-ввода логина и пароля (или сохрани введённые данные в сейф):
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:6px;">
          ${accWithCreds
            .map(
              (a) => `
            <div style="display:flex;gap:4px;align-items:center;">
              <button type="button" class="lqs-pass-fill-btn" data-acc-id="${escapeHtml(a.accountId)}" style="flex:1;text-align:left;padding:5px 8px;border-radius:7px;border:1px solid #d6d3cd;background:#f5f4f2;cursor:pointer;font-size:11px;font-weight:600;">
                🔑 ${escapeHtml(a.label)} ${a.login ? `(${escapeHtml(a.login)})` : '(без пароля)'}
              </button>
            </div>
          `
            )
            .join('')}
        </div>
        <button type="button" id="lqs-pass-save-current" style="width:100%;padding:6px 8px;border-radius:7px;border:1px solid #ebd000;background:#fce000;font-weight:700;font-size:11px;cursor:pointer;">
          💾 Запомнить введённый логин/пароль в активный профиль
        </button>
        <div id="lqs-pass-msg" style="font-size:10.5px;color:#15803d;margin-top:4px;"></div>
      `;

      document.body.appendChild(box);

      box.querySelector('#lqs-pass-close').onclick = () => box.remove();

      box.querySelectorAll('.lqs-pass-fill-btn').forEach((btn) => {
        btn.onclick = () => {
          const accId = btn.getAttribute('data-acc-id');
          chrome.runtime.sendMessage({ type: 'LQS_AUTOFILL_YANDEX_LOGIN', accountId: accId }, (r) => {
            const msgEl = box.querySelector('#lqs-pass-msg');
            if (r && r.ok) {
              msgEl.textContent = `✅ Введены данные для «${r.label}»`;
            } else {
              msgEl.textContent = `⚠️ ${r?.error || 'Заполни логин/пароль для этого профиля в расширении'}`;
            }
          });
        };
      });

      box.querySelector('#lqs-pass-save-current').onclick = () => {
        const loginInp =
          document.querySelector('input[name="login"]') ||
          document.querySelector('input#passp-field-login') ||
          document.querySelector('input[type="text"], input[type="tel"], input[type="email"]');
        const passInp =
          document.querySelector('input[name="passwd"]') ||
          document.querySelector('input#passp-field-passwd') ||
          document.querySelector('input[type="password"]');

        const loginVal = loginInp ? loginInp.value.trim() : '';
        const passVal = passInp ? passInp.value : '';

        chrome.runtime.sendMessage(
          {
            type: 'LQS_SAVE_ACCOUNT_TO_VAULT',
            payload: {
              label: resp.activeAccountLabel || 'Аккаунт #1 (Основной)',
              login: loginVal || undefined,
              password: passVal || undefined,
              captureCookies: true
            }
          },
          () => {
            const msgEl = box.querySelector('#lqs-pass-msg');
            msgEl.textContent = `✅ Сохранено для «${resp.activeAccountLabel}»!`;
          }
        );
      };
    });

    return true;
  }

  if (initYandexPassportHelperIfNeeded()) {
    return;
  }

  // ==========================================================================
  // БОРТОВОЙ САМОПИСЕЦ (LQS FLIGHT RECORDER)
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
      pricesHarvested: 0,
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
      cartGuard: { status: 'IDLE', lastRun: null, summary: 'Аудитор корзины и защита от бана готовы' },
      storage: { status: 'INIT', lastRun: null, summary: 'Загрузка базы отзывов и цен...' },
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
        pageType: slug ? 'PRODUCT_PAGE' : (window.location.pathname.includes('/cart') ? 'CART_PAGE' : 'CATALOG_OR_HOME'),
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
        `> **Инструкция для ИИ-ассистента**: Ниже представлена полная телеметрия работы расширения Lavka Quality Shield (Manifest V3) на сайте Яндекс Лавки.`,
        ``,
        `## 1. СВОДКА ОКРУЖЕНИЯ И СТРАНИЦЫ`,
        `- **Timestamp**: ${new Date().toISOString()} (сессия с ${this.sessionStartedAt})`,
        `- **URL**: ${dom.url} | **Аккаунт**: ${detectCurrentAccountLabel()}`,
        `- **Тип страницы**: ${dom.pageType} (Slug: \`${dom.slug || 'нет'}\`, Карточек в каталоге: ${dom.catalogCardsCount})`,
        `- **База в памяти**: ${reviewsDbCache ? Object.keys(reviewsDbCache).length : 0} оценок | ${aiCacheMemory ? Object.keys(aiCacheMemory).length : 0} ИИ-обзоров | ${priceDbMemory ? Object.keys(priceDbMemory).length : 0} цен`,
        ``,
        `## 2. МАТРИЦА ФУНКЦИОНИРОВАНИЯ МОДУЛЕЙ (FUNCTION HEALTH MATRIX)`,
        `1. **[ROUTER] SPA-навигация и гидратация**: \`${m.router.status}\` (${m.router.lastRun || '—'}) — ${m.router.summary}`,
        `2. **[PARSER] Парсер метаданных и JSON-LD**: \`${m.parser.status}\` (${m.parser.lastRun || '—'}) — ${m.parser.summary}`,
        `3. **[CALCULATOR] Расчёт цены/кг, белка и КБЖУ**: \`${m.calculator.status}\` (${m.calculator.lastRun || '—'}) — ${m.calculator.summary}`,
        `4. **[WIDGET] Панель товара и Анти-Шулер Радар**: \`${m.widget.status}\` (${m.widget.lastRun || '—'}) — ${m.widget.summary}`,
        `5. **[CATALOG] Разметка карточек и сбор цен**: \`${m.catalog.status}\` (${m.catalog.lastRun || '—'}) — ${m.catalog.summary}`,
        `6. **[CART_GUARD] Аудитор корзины, конкуренты и свитчер**: \`${m.cartGuard.status}\` (${m.cartGuard.lastRun || '—'}) — ${m.cartGuard.summary}`,
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
        `- **Статус нашего виджета (.lqs-product-panel)**: ${s.panelMounted ? '✅ Смонтирован' : '⚪ Не смонтирован'} (Спойлер: ${s.drawerOpen ? 'ОТКРЫТ' : 'ЗАКРЫТ'})`,
        ``,
        `## 5. СЧЁТЧИКИ ПРОИЗВОДИТЕЛЬНОСТИ И СТАБИЛЬНОСТИ DOM`,
        `- **SPA переходов**: ${c.spaTransitions} | **Маунтов панели**: ${c.panelMounts} | **Синхронизаций UI**: ${c.panelSyncs} | **Zero-Click ИИ-запусков**: ${c.autoAiRuns} | **Цен собрано**: ${c.pricesHarvested}`,
        `- **Записей в DOM выполнено**: ${c.domWritesExecuted} | **Пропущено дублей (кэш хеша)**: ${c.domWritesSkipped}`,
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

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ type: 'LQS_WARMUP_AUTOPILOT' }, () => {
      if (chrome.runtime.lastError) {
        // ignore
      }
    });
  }

  window.addEventListener('error', (ev) => {
    if (ev && ev.error) LQS_RECORDER.error('window.onerror', ev.error);
  });

  window.addEventListener('unhandledrejection', (ev) => {
    if (ev && ev.reason) LQS_RECORDER.error('unhandledrejection', ev.reason);
  });

  // Перехват добавления товара в корзину для фиксации обещанной цены (Cart Price Lock)
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.closest) return;

    const lqsBtn = target.closest('.lqs-product-panel button, .lqs-product-panel .lqs-tag-chip, .lqs-cart-audit-banner button');
    if (lqsBtn) {
      LQS_RECORDER.counters.clicksTotal += 1;
      return;
    }

    const snippetBtn = target.closest('button[data-testid="snippet-control"], button[aria-label*="В корзину"], button[aria-label*="Увеличить"]');
    if (snippetBtn) {
      setTimeout(() => {
        lockProductPriceOnCartAdd(snippetBtn);
        setTimeout(scanAndSnapshotCurrentCartDOM, 450);
      }, 60);
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
      if (msg.type === 'LQS_EXTRACT_CURRENT_CART_FROM_PAGE') {
        const snap = extractCartItemsFromDOM();
        sendResponse({
          ok: true,
          accountId: detectCurrentAccountLabel(),
          items: snap.items,
          totalUnits: snap.totalUnits,
          totalPrice: snap.totalPrice
        });
        return true;
      }
      return false;
    });
  }

  // ==========================================================================
  // УТИЛИТЫ И РАБОТА С БАЗОЙ ОТЗЫВОВ, ИИ И ЦЕН
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
        chrome.storage.local.get([STORAGE_KEY, AI_CACHE_KEY, PRICE_DB_KEY, CART_LOCKS_KEY, SETTINGS_KEY], (res) => {
          reviewsDbCache = (res && res[STORAGE_KEY]) ? res[STORAGE_KEY] : {};
          aiCacheMemory = (res && res[AI_CACHE_KEY]) ? res[AI_CACHE_KEY] : {};
          priceDbMemory = (res && res[PRICE_DB_KEY]) ? res[PRICE_DB_KEY] : {};
          cartLocksMemory = (res && res[CART_LOCKS_KEY]) ? res[CART_LOCKS_KEY] : {};
          if (res && res[SETTINGS_KEY]) {
            cachedSettings = { ...DEFAULT_SETTINGS, ...res[SETTINGS_KEY] };
          }
          const count = Object.keys(reviewsDbCache).length;
          LQS_RECORDER.updateModule(
            'storage',
            'OK',
            `База в памяти: ${count} оценок, ${Object.keys(aiCacheMemory).length} ИИ, ${Object.keys(priceDbMemory).length} цен`
          );
          resolve(reviewsDbCache);
        });
      } else {
        reviewsDbCache = {};
        resolve(reviewsDbCache);
      }
    });
  }

  async function getSettings() {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([SETTINGS_KEY], (res) => {
          cachedSettings = { ...DEFAULT_SETTINGS, ...(res && res[SETTINGS_KEY] ? res[SETTINGS_KEY] : {}) };
          resolve(cachedSettings);
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
      return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: db }, () => resolve(null));
      });
    }

    db[canonicalKey] = {
      ...(existing || {}),
      ...data,
      slug: canonicalKey,
      updatedAt: new Date().toISOString()
    };
    reviewsDbCache = db;

    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: db }, () => resolve(db[canonicalKey]));
    });
  }

  // ==========================================================================
  // ФИКСАТОР ЦЕН КОРЗИНЫ (CART PRICE LOCK) И ТОЧНЫЙ ЗАХВАТ ВСЕХ ЕДИНИЦ КОРЗИНЫ
  // ==========================================================================
  function lockProductPriceOnCartAdd(btnEl) {
    try {
      const card = btnEl.closest('div[data-testid="product-card"]');
      const mainPage = btnEl.closest('main[data-testid="good-page-desktop"]');
      let slug = null;
      let title = '';
      let price = null;
      let amount = '';

      if (mainPage) {
        slug = extractSlugFromUrl(window.location.href);
        const meta = extractProductPageMetadata();
        title = meta.title;
        price = meta.price;
        amount = meta.amountText;
      } else if (card) {
        const link = card.querySelector('a[href*="/good/"]') || card.closest('a[href*="/good/"]');
        slug = link ? extractSlugFromUrl(link.getAttribute('href')) : null;
        const img = card.querySelector('img');
        title = (img && img.getAttribute('alt')) || (card.innerText || '').split('\n')[0] || slug;
        const pInfo = extractPriceFromCardDOM(card);
        price = pInfo.price;
        amount = pInfo.amount;
      }

      if (slug && price && price > 0) {
        cartLocksMemory[slug] = {
          slug,
          title,
          lockedPrice: price,
          amount,
          accountId: detectCurrentAccountLabel(),
          lockedAt: new Date().toISOString()
        };
        chrome.storage.local.set({ [CART_LOCKS_KEY]: cartLocksMemory });
        LQS_RECORDER.record('CART_LOCK', `Locked price for ${slug}: ${price} ₽`);
      }
    } catch {
      // ignore
    }
  }

  /**
   * Находит точный DOM-контейнер одной строки товара в корзине (не поднимаясь до общего списка!)
   */
  function findCartRowContainerForLink(linkEl) {
    let curr = linkEl;
    let bestRow = linkEl.parentElement;

    for (let depth = 0; depth < 7 && curr && curr.parentElement; depth++) {
      const parent = curr.parentElement;
      if (parent.tagName === 'MAIN' || parent.tagName === 'BODY') break;
      if (parent.classList && parent.classList.contains('lqs-cart-audit-banner')) return null;

      // Проверяем, сколько РАЗНЫХ товаров (/good/<slug>) лежит внутри parent
      const linksInside = parent.querySelectorAll('a[href*="/good/"]');
      const slugsInside = new Set();
      linksInside.forEach((a) => {
        const s = extractSlugFromUrl(a.getAttribute('href'));
        if (s) slugsInside.add(s);
      });

      if (slugsInside.size > 1) {
        // Родитель уже объединяет несколько разных товаров корзины — останавливаемся на curr!
        return curr;
      }

      bestRow = parent;
      curr = parent;
    }

    return bestRow;
  }

  /**
   * Точно извлекает все позиции и количество штук (qty) из корзины Яндекс Лавки
   */
  function extractCartItemsFromDOM() {
    const items = [];
    const seen = new Set();

    const allGoodLinks = document.querySelectorAll('a[href*="/good/"]');

    allGoodLinks.forEach((linkEl) => {
      // Исключаем ссылки внутри нашего собственного баннера и панели
      if (linkEl.closest('.lqs-cart-audit-banner, .lqs-product-panel')) return;
      // Исключаем карточки из каруселей рекомендаций ("С этим покупают", "Добавьте к заказу")
      if (linkEl.closest('div[data-testid="product-card"]')) return;

      const inCartRegion =
        window.location.pathname.includes('/cart') ||
        Boolean(linkEl.closest('[data-testid*="cart"], aside, [role="dialog"]'));
      if (!inCartRegion) return;

      const slug = extractSlugFromUrl(linkEl.getAttribute('href'));
      if (!slug || seen.has(slug)) return;

      const container = findCartRowContainerForLink(linkEl);
      if (!container) return;

      // Если внутри контейнера нет ни цены, ни кнопок степпера (- / +), это не строка корзины
      const textAll = (container.innerText || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
      const priceMatches = Array.from(textAll.matchAll(/(\d[\d\s]*)\s*₽/g)).map((m) =>
        parseFloat(m[1].replace(/\s/g, ''))
      );
      if (priceMatches.length === 0) return;

      seen.add(slug);

      // Название товара: берём из ссылки с текстом или alt картинки
      let title = '';
      const rowLinks = container.querySelectorAll('a[href*="/good/"]');
      rowLinks.forEach((a) => {
        const t = (a.textContent || '').trim();
        if (t && t.length > title.length) title = t;
      });
      if (!title) {
        const imgEl = container.querySelector('img[alt]');
        title = (imgEl && imgEl.getAttribute('alt')) || '';
      }
      if (!title) {
        // Первая строка текста контейнера до цены
        const lines = (container.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
        title = lines[0] || slug;
      }

      // Точное чтение количества (qty) из степпера "- N +"
      let qty = 1;
      let foundStepperQty = false;

      // Ищем блок с двумя кнопками (- и +), между которыми написано число
      const buttonsInRow = Array.from(container.querySelectorAll('button'));
      if (buttonsInRow.length >= 2) {
        for (let i = 0; i < buttonsInRow.length - 1; i++) {
          const commonParent = buttonsInRow[i].parentElement;
          if (commonParent && commonParent.contains(buttonsInRow[i + 1])) {
            const leaves = commonParent.querySelectorAll('span, div, input');
            for (const leaf of leaves) {
              const valStr = (leaf.tagName === 'INPUT' ? leaf.value : leaf.textContent || '').trim();
              if (/^\d{1,2}$/.test(valStr)) {
                const parsed = parseInt(valStr, 10);
                if (parsed >= 1 && parsed <= 50) {
                  qty = parsed;
                  foundStepperQty = true;
                  break;
                }
              }
            }
          }
          if (foundStepperQty) break;
        }
      }

      if (!foundStepperQty) {
        const qtyMatch = textAll.match(/(?:^|\s)(\d{1,2})\s*шт(?![а-яa-z])/i);
        if (qtyMatch) {
          qty = parseInt(qtyMatch[1], 10) || 1;
        } else {
          const allSpans = container.querySelectorAll('span, div');
          for (const sp of allSpans) {
            if (sp.children.length > 0) continue;
            const t = (sp.textContent || '').trim();
            if (/^\d{1,2}$/.test(t)) {
              const v = parseInt(t, 10);
              if (v >= 1 && v <= 30) {
                qty = v;
                break;
              }
            }
          }
        }
      }

      // Первая цена в строке Лавки — актуальная цена (вторая, если есть — зачёркнутая старая цена)
      const firstPrice = priceMatches[0];
      const oldPrice = priceMatches.length > 1 && priceMatches[1] > firstPrice ? priceMatches[1] : null;

      // Вес/фасовка (например "· 175 г")
      const weightMatch = textAll.match(/(\d+(?:[.,]\d+)?\s*(?:г|гр|кг|мл|л|шт)(?![а-яa-z]))/i);
      const amount = weightMatch ? weightMatch[1].trim() : '';

      items.push({
        slug,
        title: title.slice(0, 95),
        qty,
        price: firstPrice,
        oldPrice,
        amount
      });
    });

    const totalPrice = Math.round(items.reduce((acc, i) => acc + i.price * i.qty, 0));
    const totalUnits = items.reduce((acc, i) => acc + (Number(i.qty) || 1), 0);
    return { items, totalUnits, totalPrice };
  }

  function triggerCartCompetitorAudit(snap, forceNetwork = false) {
    if (!snap || !Array.isArray(snap.items) || snap.items.length === 0) return;
    const sig = snap.items.map((i) => `${i.slug}:${i.qty}:${i.price}`).join('|') + `|${detectCurrentAccountLabel()}`;
    if (!forceNetwork && sig === lastCartAuditSignature && (lastCartCompetitorAudit || isCartAuditLoading)) {
      return;
    }

    lastCartAuditSignature = sig;
    isCartAuditLoading = true;
    renderCartAuditBanner(snap);

    chrome.runtime.sendMessage(
      {
        type: 'LQS_AUDIT_CART_COMPETITORS',
        accountId: detectCurrentAccountLabel(),
        items: snap.items,
        forceNetworkSearch: Boolean(forceNetwork)
      },
      (resp) => {
        isCartAuditLoading = false;
        if (!chrome.runtime.lastError && resp && resp.ok) {
          lastCartCompetitorAudit = resp;
          LQS_RECORDER.updateModule(
            'cartGuard',
            'OK',
            `Аудит корзины: ${snap.items.length} поз. (${snap.totalUnits} шт.) = ${snap.totalPrice} ₽, переплата конкурентам: +${resp.totalOverpayVsCompetitors} ₽`
          );
        }
        renderCartAuditBanner(snap);
      }
    );

    chrome.runtime.sendMessage({ type: 'LQS_GET_ACCOUNTS_VAULT' }, (accResp) => {
      if (!chrome.runtime.lastError && accResp && accResp.ok) {
        cachedAccountsVault = accResp;
        renderCartAuditBanner(snap);
      }
    });
  }

  function scanAndSnapshotCurrentCartDOM() {
    const snap = extractCartItemsFromDOM();
    if (snap.items.length > 0 && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'LQS_SAVE_CART_SNAPSHOT',
        accountId: detectCurrentAccountLabel(),
        items: snap.items,
        totalPrice: snap.totalPrice
      });
      renderCartAuditBanner(snap);
      triggerCartCompetitorAudit(snap, false);
    }
  }

  function renderCartAuditBanner(snap) {
    if (!snap || snap.items.length === 0) return;
    const cartContainer =
      document.querySelector('[data-testid="cart-view"], [data-testid="cart-page"], main[data-testid*="cart"]') ||
      (window.location.pathname.includes('/cart') ? document.querySelector('main') : null);
    if (!cartContainer) return;

    const tampered = [];
    snap.items.forEach((it) => {
      const lock = cartLocksMemory[it.slug];
      if (lock && lock.lockedPrice && it.price > lock.lockedPrice) {
        tampered.push({
          title: it.title,
          lockedPrice: lock.lockedPrice,
          cartPrice: it.price,
          diff: it.price - lock.lockedPrice
        });
      }
    });

    let banner = cartContainer.querySelector('.lqs-cart-audit-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'lqs-cart-audit-banner';
      cartContainer.prepend(banner);
    }

    const totalUnits = snap.totalUnits || snap.items.reduce((s, i) => s + (Number(i.qty) || 1), 0);
    const audit = lastCartCompetitorAudit;
    const overpayComp = audit ? audit.totalOverpayVsCompetitors : 0;
    const overpayAlt = audit ? audit.totalOverpayVsAltAccount : 0;
    const cheaperCompCount = audit ? audit.cheaperAtCompetitorsCount : 0;

    // Формируем сводные бейджи переплаты прямо на главном баннере корзины
    let compPillHtml = '';
    if (isCartAuditLoading && !audit) {
      compPillHtml = `<span class="lqs-cart-pill">⏳ Сверяю цены корзины с другими магазинами и без куки...</span>`;
    } else if (overpayComp > 0) {
      compPillHtml = `<span class="lqs-cart-pill overpay-bad">🏪 У конкурентов дешевле (${cheaperCompCount} поз.): переплата +${overpayComp} ₽!</span>`;
    } else if (audit) {
      compPillHtml = `<span class="lqs-cart-pill overpay-good">🏪 Цены конкурентов проверены (${snap.items.length} поз.)</span>`;
    }

    let altAccPillHtml = '';
    if (overpayAlt > 0) {
      altAccPillHtml = `<span class="lqs-cart-pill overpay-warn">🕵️ Без куки / на др. акке дешевле на -${overpayAlt} ₽!</span>`;
    }

    // Выпадающий список 1: Цены конкурентов, переплата и прямые ссылки на другие магазины по каждому товару корзины
    const auditItems = (audit && Array.isArray(audit.items) && audit.items.length > 0)
      ? audit.items
      : snap.items.map((i) => ({
          ...i,
          rowTotal: Math.round(i.price * i.qty),
          competitorOffers: [],
          storeSearchLinks: [
            { store: 'Перекрёсток', url: `https://www.perekrestok.ru/cat/search?search=${encodeURIComponent(i.title)}` },
            { store: 'ВкусВилл', url: `https://vkusvill.ru/search/?q=${encodeURIComponent(i.title)}` },
            { store: 'Ozon', url: `https://www.ozon.ru/search/?text=${encodeURIComponent(i.title)}` },
            { store: 'Я.Маркет', url: `https://market.yandex.ru/search?text=${encodeURIComponent(i.title)}` },
            { store: 'Лента', url: `https://lenta.com/search/?searchText=${encodeURIComponent(i.title)}` }
          ]
        }));

    const compDropdownRowsHtml = auditItems
      .map((it) => {
        const compBadge =
          it.overpayVsCompetitorTotal > 0
            ? `<span class="lqs-cart-pill overpay-bad">Переплата +${it.overpayVsCompetitorTotal} ₽ (в сетях от ~${it.competitorMinPrice} ₽/шт)</span>`
            : it.competitorMinPrice
            ? `<span class="lqs-cart-pill overpay-good">В сетях от ~${it.competitorMinPrice} ₽/шт (в Лавке ок)</span>`
            : `<span class="lqs-cart-pill">Ссылки на магазины ниже 👇</span>`;

        const altBadge =
          it.overpayVsAltTotal > 0
            ? `<span class="lqs-cart-pill overpay-warn">🕵️ ${escapeHtml(it.bestAltLabel || 'Без куки')}: ${it.bestAltPrice} ₽/шт (переплата +${it.overpayVsAltTotal} ₽)</span>`
            : '';

        const foundOffersHtml = Array.isArray(it.competitorOffers)
          ? it.competitorOffers
              .filter((o) => o && o.url)
              .map((o) => {
                const isCheaper = o.price && o.price < it.price - 2;
                const priceTag = o.price ? `: ~${o.price} ₽` : '';
                return `<a href="${escapeHtml(o.url)}" target="_blank" rel="noopener noreferrer" class="lqs-store-link ${isCheaper ? 'is-cheaper' : ''}" title="${escapeHtml(o.title || o.store)}">🏪 ${escapeHtml(o.store)}${priceTag} ↗</a>`;
              })
              .join('')
          : '';

        const searchLinksHtml = Array.isArray(it.storeSearchLinks)
          ? it.storeSearchLinks
              .map(
                (s) =>
                  `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" class="lqs-store-link is-search" title="Найти «${escapeHtml(it.title)}» в магазине ${escapeHtml(s.store)}">🔍 ${escapeHtml(s.store)} ↗</a>`
              )
              .join('')
          : '';

        return `
          <div class="lqs-cart-comp-item">
            <div class="lqs-cart-comp-top">
              <div>
                <a href="https://lavka.yandex.ru/good/${encodeURIComponent(it.slug)}" target="_blank" rel="noopener noreferrer" class="lqs-cart-comp-title">
                  ${escapeHtml(it.title)}
                </a>
                <span style="color:#475569;font-size:12px;margin-left:6px;">
                  <b>${it.qty} шт. × ${it.price} ₽ = ${it.rowTotal} ₽</b>
                </span>
              </div>
              <div style="display:flex;gap:5px;flex-wrap:wrap;">
                ${compBadge}
                ${altBadge}
              </div>
            </div>
            <div class="lqs-cart-comp-links">
              ${foundOffersHtml}
              ${searchLinksHtml}
            </div>
          </div>
        `;
      })
      .join('');

    // Выпадающий список 2: Быстрое переключение аккаунтов Лавки (куки-сессии + клонирование корзины)
    const accountsList = cachedAccountsVault && Array.isArray(cachedAccountsVault.accounts)
      ? cachedAccountsVault.accounts
      : [];
    const activeAccLabel = detectCurrentAccountLabel();

    const accDropdownRowsHtml = accountsList
      .map((a) => {
        const isCurrent = a.label === activeAccLabel;
        const cookieTag = a.cookieCount > 0 ? `🍪 ${a.cookieCount} куки` : '⚪ куки не сохранены';
        const loginTag = a.login || a.yandexLogin ? `• 🔑 ${escapeHtml(a.login || a.yandexLogin)}` : '';
        return `
          <div class="lqs-cart-comp-item" style="flex-direction:row;align-items:center;justify-content:space-between;flex-wrap:wrap;">
            <div>
              <b>${isCurrent ? '🟢 ' : '👤 '}${escapeHtml(a.label)}</b>
              <span style="font-size:11.5px;color:#475569;margin-left:6px;">(${cookieTag} ${loginTag})</span>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button type="button" class="lqs-mini-btn lqs-cart-switch-acc-btn" data-acc-id="${escapeHtml(a.accountId)}" data-build="false">
                ⚡ Переключить вход
              </button>
              <button type="button" class="lqs-mini-btn btn-accent lqs-cart-switch-acc-btn" data-acc-id="${escapeHtml(a.accountId)}" data-build="true">
                🚀 Переключить и собрать эти ${totalUnits} шт.
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    banner.innerHTML = `
      <div class="lqs-cart-audit-head">
        <div>
          <strong>🛡️ Анти-Шулер Аудит Корзины (${escapeHtml(activeAccLabel)}):</strong>
          <span>По калькулятору <b>${snap.items.length} поз. (${totalUnits} шт.) = ${snap.totalPrice} ₽</b></span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" class="lqs-mini-btn btn-accent" id="lqs-cart-comp-toggle-btn">
            🏪 Магазины и переплата ${overpayComp > 0 ? `(+${overpayComp} ₽)` : ''} ${isCartCompDropdownOpen ? '▴' : '▾'}
          </button>
          <button type="button" class="lqs-mini-btn" id="lqs-cart-acc-toggle-btn">
            👤 Сменить аккаунт ${isCartAccDropdownOpen ? '▴' : '▾'}
          </button>
          <button type="button" class="lqs-mini-btn" id="lqs-cart-snapshot-btn">
            🔄 Слепок (${totalUnits} шт.)
          </button>
          <button type="button" class="lqs-mini-btn" id="lqs-cart-proof-btn">
            📸 Пруф для поддержки
          </button>
        </div>
      </div>

      <div class="lqs-cart-summary-row">
        ${compPillHtml}
        ${altAccPillHtml}
      </div>

      ${
        tampered.length > 0
          ? `<div class="lqs-cart-tamper-warn">🚨 <b>ВНИМАНИЕ! Лавка тихо подняла цены в корзине относительно витрины:</b><br>${tampered
              .map((t) => `• ${escapeHtml(t.title)}: было <b>${t.lockedPrice} ₽</b> -> стало <b>${t.cartPrice} ₽ (+${t.diff} ₽)</b>`)
              .join('<br>')}</div>`
          : ''
      }

      <!-- ВЫПАДАЮЩИЙ СПИСОК 1: ЦЕНЫ И ССЫЛКИ НА ДРУГИЕ МАГАЗИНЫ ПО КАЖДОМУ ТОВАРУ -->
      <div class="lqs-cart-dropdown ${isCartCompDropdownOpen ? 'open' : ''}" id="lqs-cart-comp-dropdown">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
          <span style="font-weight:700;font-size:12px;color:#334155;">
            🏪 Сравнение товаров корзины с ценами в других магазинах и без куки (кликни по магазину для перехода):
          </span>
          <button type="button" class="lqs-mini-btn" id="lqs-cart-rescan-comp-btn">
            🔄 Обновить цены конкурентов
          </button>
        </div>
        ${compDropdownRowsHtml}
      </div>

      <!-- ВЫПАДАЮЩИЙ СПИСОК 2: БЫСТРОЕ ПЕРЕКЛЮЧЕНИЕ АККАУНТОВ И ПЕРЕНОС КОРЗИНЫ -->
      <div class="lqs-cart-dropdown ${isCartAccDropdownOpen ? 'open' : ''}" id="lqs-cart-acc-dropdown">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
          <span style="font-weight:700;font-size:12px;color:#334155;">
            🔐 Быстрое переключение аккаунтов Яндекс Лавки (сессия куки сохраняется автоматически):
          </span>
          <button type="button" class="lqs-mini-btn" id="lqs-cart-save-cur-cookies-btn">
            💾 Запомнить куки текущего входа (${escapeHtml(activeAccLabel)})
          </button>
        </div>
        ${accDropdownRowsHtml || '<div style="font-size:12px;color:#64748b;">Открой вкладку «💰 Цены и Корзина» в окне расширения, чтобы настроить профили.</div>'}
      </div>
    `;

    const compToggleBtn = banner.querySelector('#lqs-cart-comp-toggle-btn');
    if (compToggleBtn) {
      compToggleBtn.onclick = () => {
        isCartCompDropdownOpen = !isCartCompDropdownOpen;
        if (isCartCompDropdownOpen) isCartAccDropdownOpen = false;
        renderCartAuditBanner(snap);
      };
    }

    const accToggleBtn = banner.querySelector('#lqs-cart-acc-toggle-btn');
    if (accToggleBtn) {
      accToggleBtn.onclick = () => {
        isCartAccDropdownOpen = !isCartAccDropdownOpen;
        if (isCartAccDropdownOpen) isCartCompDropdownOpen = false;
        chrome.runtime.sendMessage({ type: 'LQS_GET_ACCOUNTS_VAULT' }, (accResp) => {
          if (!chrome.runtime.lastError && accResp && accResp.ok) {
            cachedAccountsVault = accResp;
          }
          renderCartAuditBanner(snap);
        });
      };
    }

    const rescanBtn = banner.querySelector('#lqs-cart-rescan-comp-btn');
    if (rescanBtn) {
      rescanBtn.onclick = () => {
        rescanBtn.textContent = '⏳ Ищу цены в сетях...';
        triggerCartCompetitorAudit(snap, true);
      };
    }

    const saveCookiesBtn = banner.querySelector('#lqs-cart-save-cur-cookies-btn');
    if (saveCookiesBtn) {
      saveCookiesBtn.onclick = () => {
        saveCookiesBtn.textContent = '⏳ Сохраняю куки...';
        chrome.runtime.sendMessage(
          {
            type: 'LQS_SAVE_ACCOUNT_TO_VAULT',
            payload: { label: activeAccLabel, captureCookies: true }
          },
          (r) => {
            if (r && r.vaultStatus) cachedAccountsVault = r.vaultStatus;
            saveCookiesBtn.textContent = '✅ Куки сохранены в сейф!';
            setTimeout(() => renderCartAuditBanner(snap), 1200);
          }
        );
      };
    }

    banner.querySelectorAll('.lqs-cart-switch-acc-btn').forEach((btn) => {
      btn.onclick = () => {
        const targetAccId = btn.getAttribute('data-acc-id');
        const shouldBuild = btn.getAttribute('data-build') === 'true';
        btn.textContent = shouldBuild ? '⏳ Переключаю и собираю...' : '⏳ Переключаю аккаунт...';

        chrome.runtime.sendMessage(
          {
            type: 'LQS_SAVE_CART_SNAPSHOT',
            accountId: activeAccLabel,
            items: snap.items,
            totalPrice: snap.totalPrice
          },
          () => {
            chrome.runtime.sendMessage({
              type: 'LQS_SWITCH_LAVKA_ACCOUNT',
              payload: {
                accountId: targetAccId,
                autoBackupCurrent: true,
                buildCartAfterSwitch: shouldBuild
              }
            });
          }
        );
      };
    });

    const snapBtn = banner.querySelector('#lqs-cart-snapshot-btn');
    if (snapBtn) {
      snapBtn.onclick = () => {
        chrome.runtime.sendMessage(
          {
            type: 'LQS_SAVE_CART_SNAPSHOT',
            accountId: activeAccLabel,
            items: snap.items,
            totalPrice: snap.totalPrice
          },
          () => {
            snapBtn.textContent = `✅ Слепок (${snap.items.length} поз. / ${totalUnits} шт.) сохранён!`;
            setTimeout(() => {
              snapBtn.textContent = `🔄 Слепок (${totalUnits} шт.)`;
            }, 2000);
          }
        );
      };
    }

    const proofBtn = banner.querySelector('#lqs-cart-proof-btn');
    if (proofBtn) {
      proofBtn.onclick = () => {
        const lines = [
          `# ДОКАЗАТЕЛЬСТВО РАСЧЁТА КОРЗИНЫ ЯНДЕКС ЛАВКИ (LAVKA QUALITY SHIELD v${VERSION})`,
          `Дата и время: ${new Date().toLocaleString('ru-RU')}`,
          `Аккаунт: ${activeAccLabel}`,
          `URL: ${window.location.href}`,
          ``,
          `## Список позиций (${snap.items.length} наименований, всего ${totalUnits} шт.) и пересчёт по калькулятору:`,
          ...auditItems.map((it, idx) => {
            const lock = cartLocksMemory[it.slug];
            const lockNote = lock ? ` | Обещанная цена на витрине: ${lock.lockedPrice} ₽` : '';
            const compNote = it.competitorMinPrice ? ` | В других сетях от ~${it.competitorMinPrice} ₽ (переплата +${it.overpayVsCompetitorTotal || 0} ₽)` : '';
            const guestNote = it.guestPrice ? ` | Цена без куки (Гость): ${it.guestPrice} ₽` : '';
            return `${idx + 1}. ${it.title} [${it.slug}] — ${it.qty} шт. × ${it.price} ₽ = ${it.qty * it.price} ₽${lockNote}${guestNote}${compNote}`;
          }),
          ``,
          `ИТОГО ПО КАЛЬКУЛЯТОРУ: ${snap.totalPrice} ₽ (всего единиц товара: ${totalUnits} шт.)`,
          `СУММАРНАЯ ПЕРЕПЛАТА ОТНОСИТЕЛЬНО КОНКУРЕНТОВ: +${overpayComp} ₽`,
          `СУММАРНАЯ ПЕРЕПЛАТА ОТНОСИТЕЛЬНО ГОСТЯ / ДРУГОГО АККАУНТА: +${overpayAlt} ₽`
        ];
        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `lavka-cart-proof-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.txt`;
        a.click();
      };
    }
  }

  // ==========================================================================
  // ПАРСЕР СТРАНИЦЫ ТОВАРА И КАЛЬКУЛЯТОР КБЖУ / ЦЕНЫ ЗА КГ
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
        // ignore
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
      unitLabel = fromTitle.unitLabel;
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

  function buildPriceShieldAlertPill(slug, currentPrice) {
    if (!slug || !currentPrice) return '';
    const pIntel = priceSummaryBySlug.get(slug) || (priceDbMemory && priceDbMemory[slug]);
    if (!pIntel) return '';

    const curAcc = detectCurrentAccountLabel();

    let cheapestAltPrice = null;
    let cheapestAltLabel = '';

    if (pIntel.guestPrice && pIntel.guestPrice < currentPrice - 2) {
      cheapestAltPrice = pIntel.guestPrice;
      cheapestAltLabel = 'без куки';
    }

    if (pIntel.accounts && typeof pIntel.accounts === 'object') {
      for (const [accName, accObj] of Object.entries(pIntel.accounts)) {
        if (accName !== curAcc && accObj && accObj.price && accObj.price < currentPrice - 2) {
          if (!cheapestAltPrice || accObj.price < cheapestAltPrice) {
            cheapestAltPrice = accObj.price;
            cheapestAltLabel = accName;
          }
        }
      }
    }

    if (cheapestAltPrice && cheapestAltPrice < currentPrice - 2) {
      const diff = Math.round(currentPrice - cheapestAltPrice);
      return `<span class="lqs-metric-pill verdict-bad" title="Штраф за лояльность! На профиле «${escapeHtml(cheapestAltLabel)}» этот же товар стоит ${cheapestAltPrice} ₽">🕵️ Тебе +${diff} ₽ (${escapeHtml(cheapestAltLabel)}: ${cheapestAltPrice} ₽)</span>`;
    }

    if (pIntel.competitorMinPrice && pIntel.competitorMinPrice < currentPrice - 5) {
      const diffPct = Math.round(((currentPrice - pIntel.competitorMinPrice) / pIntel.competitorMinPrice) * 100);
      if (diffPct >= 8) {
        return `<span class="lqs-metric-pill verdict-warn" title="Цены в других сетях: ${escapeHtml(pIntel.competitorSummary || '')}">🏪 В сетях от ~${pIntel.competitorMinPrice} ₽ (тут +${diffPct}%)</span>`;
      }
    }

    if (pIntel.minPrice && currentPrice > pIntel.minPrice + 4) {
      const diff = Math.round(currentPrice - pIntel.minPrice);
      return `<span class="lqs-metric-pill verdict-warn" title="В твоей базе цен этот товар стоил ${pIntel.minPrice} ₽ (средняя: ${pIntel.avgPrice || pIntel.minPrice} ₽)">📈 +${diff} ₽ к мин. (${pIntel.minPrice} ₽)</span>`;
    }

    if (pIntel.maxPrice && currentPrice < pIntel.maxPrice - 4) {
      const saved = Math.round(pIntel.maxPrice - currentPrice);
      return `<span class="lqs-metric-pill verdict-good" title="Выгодная цена! Раньше стоил до ${pIntel.maxPrice} ₽">📉 Выгодно (-${saved} ₽)</span>`;
    }

    return '';
  }

  function buildPriceRadarDrawerBarHtml(slug, currentPrice) {
    const pIntel = (slug && priceSummaryBySlug.get(slug)) || (slug && priceDbMemory && priceDbMemory[slug]);
    if (!pIntel) {
      return `<span>💰 <b>Радар цен:</b> собираю данные по гостевой цене (без куки), истории и другим магазинам...</span>`;
    }
    const parts = [];
    if (currentPrice) parts.push(`Сейчас (${escapeHtml(detectCurrentAccountLabel())}): <b>${Math.round(currentPrice)} ₽</b>`);
    if (pIntel.guestPrice) {
      const diff = currentPrice ? Math.round(currentPrice - pIntel.guestPrice) : 0;
      const tag = diff > 2 ? `<b style="color:#b91c1c;">${pIntel.guestPrice} ₽ (тебе +${diff} ₽!)</b>` : `<b>${pIntel.guestPrice} ₽</b>`;
      parts.push(`Без куки (Гость): ${tag}`);
    }
    if (pIntel.minPrice && pIntel.maxPrice) {
      parts.push(`История БД: мин <b>${pIntel.minPrice} ₽</b> / макс <b>${pIntel.maxPrice} ₽</b>`);
    }
    if (pIntel.accounts && Object.keys(pIntel.accounts).length > 1) {
      const accStr = Object.entries(pIntel.accounts)
        .map(([k, v]) => `${escapeHtml(k)}: <b>${v.price} ₽</b>`)
        .join(', ');
      parts.push(`По аккаунтам: ${accStr}`);
    }
    if (pIntel.competitorSummary) {
      parts.push(`Конкуренты: <b>${escapeHtml(pIntel.competitorSummary)}</b>`);
    }
    return `<span>💰 ${parts.join(' • ')}</span>`;
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

    const priceShieldPill = buildPriceShieldAlertPill(slug, meta ? meta.price : null);

    let aiVerdictPill = '';
    const cachedAi = (slug && lastAiResultBySlug.get(slug)) || (slug && aiCacheMemory && aiCacheMemory[slug]);
    if (cachedAi && cachedAi.loading) {
      aiVerdictPill = `<span class="lqs-metric-pill ai-pill-loading" title="Zero-Click Автопилот анализирует товар...">🤖 ⏳ ИИ...</span>`;
    } else if (cachedAi && cachedAi.verdict) {
      const vBadge = extractVerdictBadgeFromText(cachedAi.verdict);
      if (vBadge) {
        aiVerdictPill = `<span class="lqs-metric-pill ${vBadge.cls}" title="Вердикт ИИ-ревизора">${escapeHtml(vBadge.text)}</span>`;
      }
    }

    return `${primaryPill} ${proteinPill} ${priceShieldPill} ${aiVerdictPill}`.trim();
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

    if (resultObj.priceSummary && slug) {
      priceSummaryBySlug.set(slug, resultObj.priceSummary);
    }

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

    const radarBar = panel.querySelector('#lqs-price-radar-bar');
    if (radarBar) {
      setHtmlIfChanged(radarBar, buildPriceRadarDrawerBarHtml(slug, meta ? meta.price : null), 'price-radar-bar');
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

    const radarBar = panel.querySelector('#lqs-price-radar-bar');
    if (radarBar) {
      setHtmlIfChanged(radarBar, buildPriceRadarDrawerBarHtml(slug, meta ? meta.price : null), 'price-radar-bar');
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

  function triggerPriceIntelForProduct(slug, meta, panel) {
    if (!slug || !meta || !meta.price) return;
    if (priceIntelRequestedSlugs.has(slug)) return;
    priceIntelRequestedSlugs.add(slug);

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(
        {
          type: 'LQS_GET_PRICE_INTEL',
          slug,
          title: meta.title,
          price: meta.price,
          oldPrice: meta.oldPrice,
          amount: meta.amountText,
          accountId: detectCurrentAccountLabel()
        },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.summary) return;
          priceSummaryBySlug.set(slug, resp.summary);
          if (priceDbMemory) priceDbMemory[slug] = resp.summary;
          const activePanel = document.querySelector(`.lqs-product-panel[data-slug="${CSS.escape(slug)}"]`) || panel;
          if (activePanel) {
            const latestMeta = extractProductPageMetadata();
            syncExistingPanelUI(activePanel, currentReviewCache, latestMeta);
          }
        }
      );
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
      ? '⏳ <b>Zero-Click Автопилот:</b> сверяю цену без куки, цены в других сетях, отзывы по 14 площадкам и состав...'
      : '⏳ Ищу отзывы, цены конкурентов и спрашиваю ИИ-ревизора...';
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
                oldPrice: meta.oldPrice,
                accountId: detectCurrentAccountLabel(),
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
          renderAiVerdictIntoPanel(panel, slug, meta, bgResult, !isZeroClickAuto || settings.autoOpenDrawerOnAi !== false);
          return;
        } else if (bgResult && bgResult.error) {
          lastAiResultBySlug.delete(slug);
          if (metricsBox) {
            setHtmlIfChanged(metricsBox, buildMetricsInlineHtml(smart, meta, slug), 'metrics-inline-err');
          }
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

    aiContent.innerHTML =
      `⚠️ <b>Для запуска Автопилота ИИ нужно один раз войти в аккаунт Google на <a href="https://gemini.google.com/" target="_blank" rel="noopener noreferrer">gemini.google.com</a>!</b>`;
  }

  function scheduleZeroClickAiForProduct(slug, panel) {
    if (!slug || !panel) return;

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
      return;
    }

    const infoBlock = mainPage.querySelector('div[data-testid="product-info"]') ||
                      mainPage.querySelector('div[data-testid="product-card-header"]');
    if (!infoBlock) {
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
        triggerPriceIntelForProduct(slug, meta, existing);
        scheduleZeroClickAiForProduct(slug, existing);
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
      const initialRadarHtml = buildPriceRadarDrawerBarHtml(slug, meta.price);

      panel.innerHTML = `
        <!-- ЕДИНСТВЕННАЯ ОСНОВНАЯ СТРОКА: Звёзды + Цена/кг + Цена/100г белка + Анти-Шулер Бейдж + ИИ + кнопка «▾ Подробнее» -->
        <div class="lqs-main-bar">
          <div class="lqs-core-left">
            <div class="lqs-stars-inline" id="lqs-stars-box">
              ${[1, 2, 3, 4, 5].map((n) => `
                <button type="button" class="lqs-star-btn ${current.rating >= n ? 'active' : ''}" data-star="${n}" title="Оценить на ${n}">★</button>
              `).join('')}
            </div>

            <div class="lqs-metrics-inline" id="lqs-metrics-inline">${initialMetricsHtml}</div>
          </div>

          <button type="button" class="lqs-drawer-toggle-btn" id="lqs-drawer-toggle" title="Открыть заметку, радар цен, состав и ИИ-обзор">
            <span class="lqs-dot-indicator is-hidden" id="lqs-drawer-dot"></span>
            <span class="lqs-toggle-label" id="lqs-drawer-label">${isDrawerInitiallyOpen ? '▴ Скрыть' : '▾ Подробнее'}</span>
          </button>
        </div>

        <!-- ВЫПАДАЮЩЕЕ МЕНЮ ПОД КАПОТОМ -->
        <div class="lqs-drawer ${isDrawerInitiallyOpen ? 'open' : ''}" id="lqs-drawer">
          <div class="lqs-price-radar-bar" id="lqs-price-radar-bar">${initialRadarHtml}</div>

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
              <span class="lqs-ai-header-title">🤖 ИИ-разбор состава, отзывов и цен</span>
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
      if (barContainer && barContainer.parentNode) {
        barContainer.parentNode.insertBefore(panel, barContainer.nextSibling);
      } else {
        infoBlock.prepend(panel);
      }

      LQS_RECORDER.counters.panelMounts += 1;
      LQS_RECORDER.updateModule('widget', 'OK', `Смонтирован для ${slug}`);

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

      panel.querySelector('#lqs-reset-review').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        current.rating = 0;
        current.banned = false;
        current.tags = [];
        current.note = '';
        noteArea.value = '';
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

      triggerPriceIntelForProduct(slug, meta, panel);
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
          // Не блокируем автоматическую сборку корзины
          if (window.__lqsAutoBuilding) return;
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

  // ==========================================================================
  // РАЗМЕТКА КАРТОЧЕК В КАТАЛОГЕ + АВТО-СБОР ЦЕН СО ВСЕХ КАРТОЧЕК В БАЗУ
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

    return { slug, productId, imageKey, cleanTitle, rawTitle: imgAlt || '' };
  }

  function extractPriceFromCardDOM(card) {
    const priceEl = card.querySelector('[data-testid="price-text"]');
    let price = null;
    if (priceEl) {
      price = parseFloat(priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.')) || null;
    } else {
      const m = (card.innerText || '').match(/(\d[\d\s]*)\s*₽/);
      if (m) price = parseFloat(m[1].replace(/\s/g, '')) || null;
    }
    const oldEl = card.querySelector('[data-testid="price-old-text"]');
    const oldPrice = oldEl ? (parseFloat(oldEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.')) || null) : null;
    const amtEl = card.querySelector('[data-testid="product-amount"]');
    const amount = amtEl ? amtEl.textContent.trim() : '';
    return { price, oldPrice, amount };
  }

  async function decorateCatalogCards() {
    LQS_RECORDER.counters.catalogPasses += 1;
    const db = await getReviewsDB();
    const cards = document.querySelectorAll('div[data-testid="product-card"]');

    let badgedCount = 0;
    let bannedCount = 0;
    const harvestedPrices = [];

    cards.forEach((card) => {
      const ids = extractCardIdentifiers(card);
      const pInfo = extractPriceFromCardDOM(card);

      if (ids.slug && pInfo.price && pInfo.price > 0) {
        if (card.dataset.lqsHarvestedPrice !== String(pInfo.price)) {
          card.dataset.lqsHarvestedPrice = String(pInfo.price);
          harvestedPrices.push({
            slug: ids.slug,
            title: ids.rawTitle || ids.slug,
            price: pInfo.price,
            oldPrice: pInfo.oldPrice,
            amount: pInfo.amount
          });
        }
      }

      const match = findReviewInDB(db, ids);
      const review = match ? match.item : null;
      const aiCached = ids.slug && aiCacheMemory ? aiCacheMemory[ids.slug] : null;
      const priceEntry = ids.slug && priceDbMemory ? priceDbMemory[ids.slug] : null;

      let priceDiffTag = '';
      if (priceEntry && pInfo.price) {
        if (priceEntry.minPrice && pInfo.price > priceEntry.minPrice + 4) {
          priceDiffTag = ` 📈+${Math.round(pInfo.price - priceEntry.minPrice)}₽`;
        } else if (priceEntry.maxPrice && pInfo.price < priceEntry.maxPrice - 4) {
          priceDiffTag = ` 📉-${Math.round(priceEntry.maxPrice - pInfo.price)}₽`;
        }
      }

      const hasReview = Boolean(review && (review.rating > 0 || review.banned));
      const hasAiVerdict = Boolean(!hasReview && aiCached && aiCached.verdict);
      const hasPriceSignal = Boolean(!hasReview && !hasAiVerdict && priceDiffTag);

      if (!hasReview && !hasAiVerdict && !hasPriceSignal) {
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
        text = (isBad ? `💀 ${review.rating ? review.rating + '★' : 'БАН'}` : `★ ${review.rating}`) + priceDiffTag;
        titleText = (review.note && review.note.trim())
          ? review.note.trim()
          : ((review.tags && review.tags.length) ? review.tags.join(', ') : '');
      } else if (hasAiVerdict) {
        const vBadge = extractVerdictBadgeFromText(aiCached.verdict);
        text = (vBadge ? vBadge.shortCatalog : '🤖') + priceDiffTag;
        tier = vBadge && vBadge.cls === 'verdict-good' ? 'god' : (vBadge && vBadge.cls === 'verdict-bad' ? 'trash' : 'ok');
        titleText = aiCached.verdict.replace(/\*\*/g, '').slice(0, 220);
      } else if (hasPriceSignal) {
        text = priceDiffTag.trim();
        tier = priceDiffTag.includes('📉') ? 'god' : 'ok';
        titleText = `По базе цен: мин ${priceEntry.minPrice} ₽ / макс ${priceEntry.maxPrice} ₽`;
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

    const now = Date.now();
    if (harvestedPrices.length > 0 && now - lastCatalogHarvestTs > 1800) {
      lastCatalogHarvestTs = now;
      LQS_RECORDER.counters.pricesHarvested += harvestedPrices.length;
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'LQS_RECORD_PRICES',
          accountId: detectCurrentAccountLabel(),
          items: harvestedPrices
        });
      }
    }

    LQS_RECORDER.updateModule(
      'catalog',
      'OK',
      `Карточек: ${cards.length} (с бейджем: ${badgedCount}, в бане: ${bannedCount}, цен собрано: ${LQS_RECORDER.counters.pricesHarvested})`
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
      scanAndSnapshotCurrentCartDOM();
    }, 120);
  }

  function checkUrlTransition() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastObservedUrl) {
      lastObservedUrl = currentUrl;
      LQS_RECORDER.counters.spaTransitions += 1;
      runHydrationResyncWave('spa-url-change');
    }
  }

  setInterval(checkUrlTransition, 350);

  function runHydrationResyncWave(reason = 'init') {
    const slug = extractSlugFromUrl(window.location.href);
    LQS_RECORDER.updateModule(
      'router',
      'OK',
      `Маршрут: ${window.location.pathname} (${slug ? 'Товар: ' + slug : 'Каталог'}), причина: ${reason}`
    );
    [0, 180, 500, 1200, 2500].forEach((delay) => {
      setTimeout(() => {
        renderProductPageWidget();
        decorateCatalogCards();
        scanAndSnapshotCurrentCartDOM();
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
         node.classList.contains('lqs-cart-audit-banner') ||
         node.classList.contains('lqs-passport-helper'))
      ) {
        return true;
      }
      if (node.closest && node.closest('.lqs-product-panel, .lqs-card-badge, .lqs-cart-audit-banner, .lqs-passport-helper')) {
        return true;
      }
    } else if (node.parentElement && node.parentElement.closest('.lqs-product-panel, .lqs-card-badge, .lqs-cart-audit-banner, .lqs-passport-helper')) {
      return true;
    }
    return false;
  }

  function hasExternalMutation(mutations) {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (isOwnLqsNode(m.target)) continue;
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
      if (hasNonLqsChild) return true;
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
          renderProductPageWidget();
          decorateCatalogCards();
        }
        if (changes[AI_CACHE_KEY]) {
          aiCacheMemory = changes[AI_CACHE_KEY].newValue || {};
          decorateCatalogCards();
        }
        if (changes[PRICE_DB_KEY]) {
          priceDbMemory = changes[PRICE_DB_KEY].newValue || {};
          renderProductPageWidget();
          decorateCatalogCards();
        }
        if (changes[SETTINGS_KEY]) {
          cachedSettings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
          renderProductPageWidget();
          scanAndSnapshotCurrentCartDOM();
        }
      }
    });
  }

  window.addEventListener('popstate', () => runHydrationResyncWave('popstate'));
  window.addEventListener('load', () => runHydrationResyncWave('window-load'));
  runHydrationResyncWave('script-boot');
})();
