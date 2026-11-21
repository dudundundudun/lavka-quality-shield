/**
 * Lavka Quality Shield — Unified AI Providers Module
 * Supports Gemini Web (Hydrogen), ModuleAPI, OpenAI, Anthropic Claude,
 * Google Gemini Official API, DeepSeek, OpenRouter, and custom OpenAI-compatible URLs.
 */
(function (root) {
  'use strict';

  const AI_DIRECT_TIMEOUT_MS = 28000;
  const AI_MODELS_TIMEOUT_MS = 10000;
  const ANTHROPIC_DEFAULT_VERSION = '2023-06-01';
  const ANTHROPIC_DEFAULT_MAX_TOKENS = 900;

  const AI_PROVIDER_PRESETS = Object.freeze({
    gemini_tab: Object.freeze({
      id: 'gemini_tab',
      label: 'Gemini Web (Hydrogen — бесплатно)',
      protocol: 'gemini_tab',
      baseUrl: 'https://gemini.google.com/app',
      requiresKey: false,
      isPaid: false,
      defaultModel: '',
      supportsModelsEndpoint: false
    }),
    moduleapi: Object.freeze({
      id: 'moduleapi',
      label: 'ModuleAPI (moduleapi.pro)',
      protocol: 'openai',
      baseUrl: 'https://moduleapi.pro/v1',
      requiresKey: true,
      isPaid: true,
      defaultModel: '',
      checkUrl: 'https://www.moduleapi.pro/check',
      supportsModelsEndpoint: true
    }),
    openai: Object.freeze({
      id: 'openai',
      label: 'OpenAI (официальный)',
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      requiresKey: true,
      isPaid: true,
      defaultModel: 'gpt-4o-mini',
      supportsModelsEndpoint: true
    }),
    gemini_api: Object.freeze({
      id: 'gemini_api',
      label: 'Google Gemini Official API',
      protocol: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      requiresKey: true,
      isPaid: true,
      defaultModel: 'gemini-2.5-flash',
      supportsModelsEndpoint: true
    }),
    anthropic: Object.freeze({
      id: 'anthropic',
      label: 'Anthropic Claude (официальный)',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      requiresKey: true,
      isPaid: true,
      defaultModel: 'claude-3-5-sonnet-latest',
      anthropicVersion: ANTHROPIC_DEFAULT_VERSION,
      maxTokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
      supportsModelsEndpoint: true,
      fallbackModels: Object.freeze([
        'claude-sonnet-4-20250514',
        'claude-3-7-sonnet-latest',
        'claude-3-5-sonnet-latest',
        'claude-3-5-haiku-latest'
      ])
    }),
    deepseek: Object.freeze({
      id: 'deepseek',
      label: 'DeepSeek (официальный)',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      requiresKey: true,
      isPaid: true,
      defaultModel: 'deepseek-chat',
      supportsModelsEndpoint: true
    }),
    openrouter: Object.freeze({
      id: 'openrouter',
      label: 'OpenRouter',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      requiresKey: true,
      isPaid: true,
      defaultModel: '',
      supportsModelsEndpoint: true
    }),
    custom_openai: Object.freeze({
      id: 'custom_openai',
      label: 'Свой OpenAI-совместимый URL',
      protocol: 'openai',
      baseUrl: '',
      requiresKey: false,
      isPaid: false,
      defaultModel: '',
      supportsModelsEndpoint: true
    })
  });

  function listProviderPresets() {
    return Object.values(AI_PROVIDER_PRESETS);
  }

  function getProviderPreset(providerId) {
    const key = String(providerId || '').trim().toLowerCase();
    return AI_PROVIDER_PRESETS[key] || null;
  }

  function cleanBaseUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function inferProviderFromBaseUrl(baseUrl) {
    const lower = cleanBaseUrl(baseUrl).toLowerCase();
    if (!lower) return 'gemini_tab';
    if (lower.includes('moduleapi.pro')) return 'moduleapi';
    if (lower.includes('api.openai.com')) return 'openai';
    if (lower.includes('generativelanguage.googleapis.com')) return 'gemini_api';
    if (lower.includes('api.anthropic.com')) return 'anthropic';
    if (lower.includes('api.deepseek.com')) return 'deepseek';
    if (lower.includes('openrouter.ai')) return 'openrouter';
    return 'custom_openai';
  }

  function resolveProviderConfig(settingsOrOptions = {}) {
    const rawProvider = String(settingsOrOptions.aiProvider || '').trim().toLowerCase();
    const rawBaseUrl = cleanBaseUrl(settingsOrOptions.aiBaseUrl);
    const apiKey = String(settingsOrOptions.aiApiKey || '').trim();
    const model = String(settingsOrOptions.aiModel || '').trim();

    let providerId = rawProvider;
    if (!providerId || !AI_PROVIDER_PRESETS[providerId]) {
      if (settingsOrOptions.preferBrowserGeminiTab === false && rawBaseUrl) {
        providerId = inferProviderFromBaseUrl(rawBaseUrl);
      } else if (rawBaseUrl && !rawBaseUrl.includes('localhost:8083') && !rawBaseUrl.includes('127.0.0.1:8083')) {
        providerId = inferProviderFromBaseUrl(rawBaseUrl);
      } else {
        providerId = 'gemini_tab';
      }
    }

    const preset = AI_PROVIDER_PRESETS[providerId] || AI_PROVIDER_PRESETS.gemini_tab;
    let baseUrl = preset.baseUrl;
    if (providerId === 'custom_openai') {
      baseUrl = rawBaseUrl || preset.baseUrl;
    } else if (providerId === 'anthropic' && rawBaseUrl && rawBaseUrl.toLowerCase().includes('anthropic.com')) {
      baseUrl = rawBaseUrl.replace(/\/messages$/i, '');
    }

    return {
      providerId: preset.id,
      label: preset.label,
      protocol: preset.protocol,
      baseUrl: cleanBaseUrl(baseUrl),
      apiKey,
      model: model || preset.defaultModel || '',
      requiresKey: Boolean(preset.requiresKey),
      isPaid: Boolean(preset.isPaid),
      checkUrl: preset.checkUrl || '',
      anthropicVersion: preset.anthropicVersion || ANTHROPIC_DEFAULT_VERSION,
      maxTokens: preset.maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
    };
  }

  function parseModuleApiCostHeader(headers) {
    if (!headers) return null;
    let raw = null;
    if (typeof headers.get === 'function') {
      raw = headers.get('x-moduleapi-cost');
    } else if (typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (String(k).toLowerCase() === 'x-moduleapi-cost') {
          raw = v;
          break;
        }
      }
    }
    if (raw === null || raw === undefined || raw === '') return null;
    const normalized = String(raw).trim().replace(/^\$/, '').replace(',', '.');
    const num = Number(normalized);
    if (!Number.isFinite(num) || num < 0) return null;
    return num;
  }

  function maskApiKey(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) return '';
    if (key.length <= 4) return '***';
    if (key.length <= 8) return `${key.slice(0, 2)}...${key.slice(-2)}`;
    return `${key.slice(0, 3)}...${key.slice(-4)}`;
  }

  function isMaskedApiKey(val) {
    const s = String(val || '').trim();
    if (!s) return true;
    return /(\.\.\.|•{2,}|\*{3,})/.test(s);
  }

  function formatCostUsd(costUsd) {
    if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return '';
    if (costUsd === 0) return '$0.00';
    if (costUsd < 0.0001) return '<$0.0001';
    if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
    return `$${costUsd.toFixed(3)}`;
  }

  function sanitizeErrorDetail(detail, apiKey = '') {
    let text = String(detail || '').replace(/\s+/g, ' ').trim();
    if (apiKey) {
      text = text.split(apiKey).join('[REDACTED]');
    }
    text = text.replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]');
    if (text.length > 180) {
      text = `${text.slice(0, 177)}...`;
    }
    return text;
  }

  function formatProviderHttpError(providerId, status, rawDetail = '', apiKey = '') {
    const preset = getProviderPreset(providerId);
    const providerName = preset ? preset.label : (providerId || 'ИИ-провайдер');
    const detail = sanitizeErrorDetail(rawDetail, apiKey);
    const suffix = detail ? ` (${detail})` : '';

    if (status === 401) {
      return `${providerName}: неверный или отозванный API-ключ (HTTP 401). Проверьте ключ в настройках.`;
    }
    if (status === 402) {
      if (providerId === 'moduleapi') {
        return 'ModuleAPI: недостаточно средств на балансе (HTTP 402). Пополните счёт или проверьте ключ на moduleapi.pro/check.';
      }
      return `${providerName}: недостаточно средств на балансе или требуется оплата (HTTP 402).`;
    }
    if (status === 403) {
      return `${providerName}: доступ запрещён (HTTP 403). Проверьте права ключа, регион или доступность модели.`;
    }
    if (status === 404) {
      return `${providerName}: модель или адрес API не найдены (HTTP 404). Проверьте название модели и URL.${suffix}`;
    }
    if (status === 429) {
      if (providerId === 'moduleapi') {
        return 'ModuleAPI: превышен лимит запросов или окно 5ч/7д (HTTP 429). Подождите немного и повторите попытку.';
      }
      return `${providerName}: превышен лимит запросов (HTTP 429). Подождите минуту и повторите попытку.`;
    }
    if (status === 502 || status === 503 || status === 504) {
      return `${providerName}: сервер провайдера временно перегружен или недоступен (HTTP ${status}). Попробуйте повторить через пару секунд.`;
    }
    return `${providerName}: ошибка API (HTTP ${status})${suffix}`;
  }

  function buildChatRequest(config, prompt) {
    const resolved = config && config.protocol ? config : resolveProviderConfig(config);
    const baseUrl = cleanBaseUrl(resolved.baseUrl);
    const model = String(resolved.model || '').trim();

    if (resolved.protocol === 'anthropic') {
      const endpoint = /\/messages$/i.test(baseUrl) ? baseUrl : `${baseUrl}/messages`;
      const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': resolved.anthropicVersion || ANTHROPIC_DEFAULT_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true'
      };
      if (resolved.apiKey) {
        headers['x-api-key'] = resolved.apiKey;
      }
      const body = {
        model,
        max_tokens: resolved.maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS,
        temperature: 0.2,
        messages: [{ role: 'user', content: String(prompt || '') }]
      };
      return { url: endpoint, method: 'POST', headers, body };
    }

    const endpoint = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json'
    };
    if (resolved.apiKey) {
      headers.Authorization = `Bearer ${resolved.apiKey}`;
    }
    if (resolved.providerId === 'openrouter') {
      headers['HTTP-Referer'] = 'https://lavka.yandex.ru';
      headers['X-Title'] = 'Lavka Quality Shield';
    }
    const body = {
      model,
      messages: [{ role: 'user', content: String(prompt || '') }],
      temperature: 0.2
    };
    return { url: endpoint, method: 'POST', headers, body };
  }

  function extractChatReply(protocol, jsonData) {
    if (!jsonData || typeof jsonData !== 'object') return '';
    if (protocol === 'anthropic') {
      const blocks = Array.isArray(jsonData.content) ? jsonData.content : [];
      const texts = blocks
        .map((b) => {
          if (typeof b === 'string') return b;
          if (b && typeof b.text === 'string') return b.text;
          return '';
        })
        .filter(Boolean);
      return texts.join('\n').trim();
    }

    const choiceContent = jsonData.choices?.[0]?.message?.content;
    if (typeof choiceContent === 'string') {
      return choiceContent.trim();
    }
    if (Array.isArray(choiceContent)) {
      return choiceContent
        .map((part) => (typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : '')))
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    return '';
  }

  function extractUsage(protocol, jsonData) {
    const u = jsonData && typeof jsonData === 'object' ? jsonData.usage : null;
    if (!u || typeof u !== 'object') return null;
    if (protocol === 'anthropic') {
      const promptTokens = Number(u.input_tokens || 0);
      const completionTokens = Number(u.output_tokens || 0);
      return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      };
    }
    const promptTokens = Number(u.prompt_tokens || 0);
    const completionTokens = Number(u.completion_tokens || 0);
    const totalTokens = Number(u.total_tokens || (promptTokens + completionTokens));
    return { promptTokens, completionTokens, totalTokens };
  }

  async function runFetchWithTimeout(url, options, timeoutMs, fetchImpl) {
    if (typeof fetchImpl === 'function') {
      return await fetchImpl(url, options);
    }
    if (root.LQS_UTILS && typeof root.LQS_UTILS.fetchWithTimeout === 'function') {
      return await root.LQS_UTILS.fetchWithTimeout(url, options, timeoutMs);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function extractResponseErrorDetail(resp) {
    try {
      const text = await resp.text();
      if (!text) return '';
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error?.message) return String(parsed.error.message);
        if (typeof parsed?.error === 'string') return parsed.error;
        if (parsed?.message) return String(parsed.message);
        if (parsed?.detail) return String(parsed.detail);
      } catch {
        // plain text body
      }
      return text;
    } catch {
      return '';
    }
  }

  async function fetchProviderModelsList(options = {}, fetchImpl = null) {
    const config = resolveProviderConfig(options);
    if (config.protocol === 'gemini_tab') {
      return ['Gemini Web (Hydrogen)'];
    }
    if (!config.baseUrl) {
      throw new Error('Не указан адрес API (Base URL).');
    }
    if (config.requiresKey && !config.apiKey) {
      throw new Error(`${config.label}: укажите API-ключ для проверки подключения и загрузки моделей.`);
    }

    const headers = {};
    if (config.protocol === 'anthropic') {
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = config.anthropicVersion || ANTHROPIC_DEFAULT_VERSION;
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else {
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      if (config.providerId === 'openrouter') {
        headers['HTTP-Referer'] = 'https://lavka.yandex.ru';
        headers['X-Title'] = 'Lavka Quality Shield';
      }
    }

    const modelsUrl = `${config.baseUrl.replace(/\/(chat\/completions|messages)$/i, '')}/models`;
    const timeoutMs = Number(options.timeoutMs) || AI_MODELS_TIMEOUT_MS;

    const resp = await runFetchWithTimeout(modelsUrl, { method: 'GET', headers }, timeoutMs, fetchImpl);
    if (!resp.ok) {
      if (config.protocol === 'anthropic' && resp.status === 404) {
        return [...(AI_PROVIDER_PRESETS.anthropic.fallbackModels || [])];
      }
      const detail = await extractResponseErrorDetail(resp);
      const err = new Error(formatProviderHttpError(config.providerId, resp.status, detail, config.apiKey));
      err.status = resp.status;
      throw err;
    }

    const data = await resp.json();
    const rawList = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    const ids = [];
    for (const item of rawList) {
      const id = typeof item === 'string' ? item.trim() : String(item?.id || '').trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  async function testProviderConnection(options = {}, fetchImpl = null) {
    const config = resolveProviderConfig(options);
    if (config.protocol === 'gemini_tab') {
      return {
        ok: true,
        providerId: config.providerId,
        label: config.label,
        baseUrl: config.baseUrl,
        models: ['Gemini Web (Hydrogen)'],
        error: null,
        status: 200
      };
    }
    try {
      const models = await fetchProviderModelsList(options, fetchImpl);
      return {
        ok: true,
        providerId: config.providerId,
        label: config.label,
        baseUrl: config.baseUrl,
        models,
        error: null,
        status: 200
      };
    } catch (err) {
      return {
        ok: false,
        providerId: config.providerId,
        label: config.label,
        baseUrl: config.baseUrl,
        models: [],
        error: err && err.message ? err.message : String(err),
        status: err && typeof err.status === 'number' ? err.status : 0
      };
    }
  }

  async function callAiProvider(options = {}, prompt = '', fetchImpl = null) {
    const config = resolveProviderConfig(options);
    if (config.protocol === 'gemini_tab') {
      throw new Error('Провайдер gemini_tab выполняется через вкладку браузера.');
    }
    if (!config.baseUrl) {
      throw new Error('Не указан адрес API (Base URL).');
    }
    if (config.requiresKey && !config.apiKey) {
      throw new Error(`${config.label}: не указан API-ключ в настройках.`);
    }

    let resolvedModel = String(config.model || '').trim();
    if (!resolvedModel) {
      const models = await fetchProviderModelsList(options, fetchImpl).catch(() => []);
      resolvedModel = models[0] || '';
    }
    if (!resolvedModel) {
      throw new Error(`${config.label}: не выбрана модель и список /models пуст.`);
    }

    const reqSpec = buildChatRequest({ ...config, model: resolvedModel }, prompt);
    const timeoutMs = Number(options.timeoutMs) || AI_DIRECT_TIMEOUT_MS;
    const resp = await runFetchWithTimeout(
      reqSpec.url,
      {
        method: reqSpec.method,
        headers: reqSpec.headers,
        body: JSON.stringify(reqSpec.body)
      },
      timeoutMs,
      fetchImpl
    );

    if (!resp.ok) {
      const detail = await extractResponseErrorDetail(resp);
      const err = new Error(formatProviderHttpError(config.providerId, resp.status, detail, config.apiKey));
      err.status = resp.status;
      throw err;
    }

    const costUsd = parseModuleApiCostHeader(resp.headers);
    const json = await resp.json();
    const text = extractChatReply(config.protocol, json);
    if (!text) {
      throw new Error(`${config.label}: получен пустой ответ от модели ${resolvedModel}.`);
    }
    const usage = extractUsage(config.protocol, json);

    return {
      ok: true,
      text,
      model: resolvedModel,
      providerId: config.providerId,
      providerLabel: config.label,
      baseUrl: config.baseUrl,
      costUsd,
      usage
    };
  }


  const PAID_PROVIDER_IDS = Object.freeze([
    'moduleapi',
    'openai',
    'anthropic',
    'gemini_api',
    'deepseek',
    'openrouter'
  ]);

  function isPaidProvider(providerId) {
    return PAID_PROVIDER_IDS.includes(String(providerId || '').trim().toLowerCase());
  }

  function getTodayKey(now = new Date()) {
    const d = now instanceof Date ? now : new Date(now);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function getMonthKey(now = new Date()) {
    const d = now instanceof Date ? now : new Date(now);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  function roundUsd(val) {
    const n = Number(val || 0);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(n * 1e6) / 1e6;
  }

  function normalizeUsageLedger(rawLedger = {}, now = new Date()) {
    const todayKey = getTodayKey(now);
    const monthKey = getMonthKey(now);
    const src = rawLedger && typeof rawLedger === 'object' ? rawLedger : {};

    const sameDay = src.dayKey === todayKey;
    const sameMonth = src.monthKey === monthKey;

    return {
      dayKey: todayKey,
      monthKey,
      todayCount: sameDay ? Math.max(0, Math.floor(Number(src.todayCount || 0))) : 0,
      todayCostUsd: sameDay ? roundUsd(src.todayCostUsd || 0) : 0,
      monthCount: sameMonth ? Math.max(0, Math.floor(Number(src.monthCount || 0))) : 0,
      monthCostUsd: sameMonth ? roundUsd(src.monthCostUsd || 0) : 0,
      lastUpdatedAt: src.lastUpdatedAt || null
    };
  }

  function checkPaidAiDailyLimit(rawLedger = {}, dailyLimit = 25, now = new Date()) {
    const ledger = normalizeUsageLedger(rawLedger, now);
    const parsedLimit = Number(dailyLimit);
    const limit = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? Math.floor(parsedLimit) : 25;

    if (limit > 0 && ledger.todayCount >= limit) {
      return {
        allowed: false,
        todayCount: ledger.todayCount,
        dailyLimit: limit,
        remaining: 0,
        todayCostUsd: ledger.todayCostUsd,
        monthCostUsd: ledger.monthCostUsd,
        error: `Защита кошелька: достигнут дневной лимит платного ИИ (${ledger.todayCount}/${limit} запросов за сегодня, потрачено ${formatCostUsd(ledger.todayCostUsd) || '$0.00'}). Измените лимит в настройках или переключитесь на бесплатный Gemini Web (Hydrogen).`
      };
    }

    return {
      allowed: true,
      todayCount: ledger.todayCount,
      dailyLimit: limit,
      remaining: limit > 0 ? Math.max(0, limit - ledger.todayCount) : null,
      todayCostUsd: ledger.todayCostUsd,
      monthCostUsd: ledger.monthCostUsd,
      error: null
    };
  }

  function estimateCostUsdFromUsage(providerId, model = '', usage = null) {
    if (!usage || typeof usage !== 'object') return 0;
    const inTok = Math.max(0, Number(usage.promptTokens || 0));
    const outTok = Math.max(0, Number(usage.completionTokens || 0));
    if (inTok === 0 && outTok === 0) return 0;

    const m = String(model || '').toLowerCase();
    // Консервативные ориентировочные тарифы ($ за 1M токенов), если API не вернул точный x-moduleapi-cost
    let inRate = 0.25;
    let outRate = 1.0;
    if (m.includes('opus') || m.includes('o1') || m.includes('gpt-5')) {
      inRate = 5.0;
      outRate = 15.0;
    } else if (m.includes('sonnet') || m.includes('gpt-4o') && !m.includes('mini') || m.includes('claude')) {
      inRate = 3.0;
      outRate = 15.0;
    } else if (m.includes('mini') || m.includes('flash') || m.includes('haiku') || m.includes('deepseek')) {
      inRate = 0.15;
      outRate = 0.6;
    }
    return roundUsd((inTok * inRate + outTok * outRate) / 1e6);
  }

  function recordPaidAiUsage(rawLedger = {}, info = {}, now = new Date()) {
    const ledger = normalizeUsageLedger(rawLedger, now);
    const hasExactCost = typeof info.costUsd === 'number' && Number.isFinite(info.costUsd) && info.costUsd >= 0;
    const costDelta = hasExactCost
      ? roundUsd(info.costUsd)
      : estimateCostUsdFromUsage(info.providerId || '', info.model || '', info.usage || null);

    return {
      dayKey: ledger.dayKey,
      monthKey: ledger.monthKey,
      todayCount: ledger.todayCount + 1,
      todayCostUsd: roundUsd(ledger.todayCostUsd + costDelta),
      monthCount: ledger.monthCount + 1,
      monthCostUsd: roundUsd(ledger.monthCostUsd + costDelta),
      lastUpdatedAt: (now instanceof Date ? now : new Date(now)).toISOString()
    };
  }

  root.LQS_AI_PROVIDERS = Object.freeze({
    AI_DIRECT_TIMEOUT_MS,
    AI_MODELS_TIMEOUT_MS,
    AI_PROVIDER_PRESETS,
    PAID_PROVIDER_IDS,
    isPaidProvider,
    getTodayKey,
    getMonthKey,
    normalizeUsageLedger,
    checkPaidAiDailyLimit,
    estimateCostUsdFromUsage,
    recordPaidAiUsage,
    listProviderPresets,
    getProviderPreset,
    inferProviderFromBaseUrl,
    resolveProviderConfig,
    parseModuleApiCostHeader,
    maskApiKey,
    isMaskedApiKey,
    formatCostUsd,
    formatProviderHttpError,
    buildChatRequest,
    extractChatReply,
    extractUsage,
    fetchProviderModelsList,
    testProviderConnection,
    callAiProvider
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
