const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extDir = path.resolve(__dirname, '..');

function loadAiProvidersModule() {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Promise,
    RegExp,
    Error,
    Array,
    Object,
    Number,
    String,
    Boolean,
    fetch: async () => ({ ok: false, status: 500, headers: new Map(), text: async () => '', json: async () => ({}) })
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(extDir, 'bg', 'ai-providers.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'bg/ai-providers.js' });
  return sandbox.LQS_AI_PROVIDERS;
}

test('AI_PROVIDER_PRESETS exposes all 8 required providers with expected base URLs and protocols', () => {
  const mod = loadAiProvidersModule();
  const presets = JSON.parse(JSON.stringify(mod.AI_PROVIDER_PRESETS));

  const expectedIds = [
    'gemini_tab',
    'moduleapi',
    'openai',
    'gemini_api',
    'anthropic',
    'deepseek',
    'openrouter',
    'custom_openai'
  ];
  for (const id of expectedIds) {
    assert.ok(presets[id], `Missing preset ${id}`);
  }
  assert.equal(presets.moduleapi.baseUrl, 'https://moduleapi.pro/v1');
  assert.equal(presets.moduleapi.protocol, 'openai');
  assert.equal(presets.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(presets.gemini_api.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(presets.anthropic.baseUrl, 'https://api.anthropic.com/v1');
  assert.equal(presets.anthropic.protocol, 'anthropic');
  assert.equal(presets.deepseek.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(presets.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
});

test('buildChatRequest formats OpenAI-compatible (ModuleAPI/OpenRouter) vs Anthropic Claude requests correctly', () => {
  const mod = loadAiProvidersModule();

  const moduleReq = JSON.parse(
    JSON.stringify(
      mod.buildChatRequest(
        { aiProvider: 'moduleapi', aiApiKey: 'sk-test-123', aiModel: 'gpt-4o-mini' },
        'Разбери молоко'
      )
    )
  );
  assert.equal(moduleReq.url, 'https://moduleapi.pro/v1/chat/completions');
  assert.equal(moduleReq.headers.Authorization, 'Bearer sk-test-123');
  assert.equal(moduleReq.body.model, 'gpt-4o-mini');
  assert.deepEqual(moduleReq.body.messages, [{ role: 'user', content: 'Разбери молоко' }]);

  const orReq = JSON.parse(
    JSON.stringify(
      mod.buildChatRequest(
        { aiProvider: 'openrouter', aiApiKey: 'sk-or-test', aiModel: 'openai/gpt-4o-mini' },
        'Тест'
      )
    )
  );
  assert.equal(orReq.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(orReq.headers['HTTP-Referer'], 'https://lavka.yandex.ru');

  const claudeReq = JSON.parse(
    JSON.stringify(
      mod.buildChatRequest(
        { aiProvider: 'anthropic', aiApiKey: 'sk-ant-999', aiModel: 'claude-3-5-sonnet-latest' },
        'Разбери творог'
      )
    )
  );
  assert.equal(claudeReq.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(claudeReq.headers['x-api-key'], 'sk-ant-999');
  assert.equal(claudeReq.headers['anthropic-version'], '2023-06-01');
  assert.equal(claudeReq.headers.Authorization, undefined);
  assert.equal(claudeReq.body.max_tokens, 900);
  assert.deepEqual(claudeReq.body.messages, [{ role: 'user', content: 'Разбери творог' }]);
});

test('parseModuleApiCostHeader parses valid USD costs and ignores invalid values', () => {
  const mod = loadAiProvidersModule();

  const headersObj = { get: (name) => (name.toLowerCase() === 'x-moduleapi-cost' ? '0.00145' : null) };
  assert.equal(mod.parseModuleApiCostHeader(headersObj), 0.00145);
  assert.equal(mod.parseModuleApiCostHeader({ 'X-ModuleAPI-Cost': '$0.025' }), 0.025);
  assert.equal(mod.parseModuleApiCostHeader({ 'x-moduleapi-cost': '0' }), 0);
  assert.equal(mod.parseModuleApiCostHeader({ 'x-moduleapi-cost': 'not-a-number' }), null);
  assert.equal(mod.parseModuleApiCostHeader({ 'x-moduleapi-cost': '-1' }), null);
  assert.equal(mod.parseModuleApiCostHeader({}), null);

  assert.equal(mod.formatCostUsd(0.00146), '$0.0015');
  assert.equal(mod.formatCostUsd(0.025), '$0.025');
  assert.equal(mod.formatCostUsd(0.00001), '<$0.0001');
});

test('formatProviderHttpError returns clear Russian messages for 401/402/403/404/429/502-503 and redacts keys', () => {
  const mod = loadAiProvidersModule();

  const err401 = mod.formatProviderHttpError('moduleapi', 401);
  assert.match(err401, /401/);
  assert.match(err401, /ключ/i);

  const err402 = mod.formatProviderHttpError('moduleapi', 402);
  assert.match(err402, /402/);
  assert.match(err402, /баланс/i);
  assert.match(err402, /moduleapi\.pro\/check/);

  const err429 = mod.formatProviderHttpError('moduleapi', 429);
  assert.match(err429, /429/);
  assert.match(err429, /5ч\/7д/);

  const err503 = mod.formatProviderHttpError('openai', 503);
  assert.match(err503, /503/);
  assert.match(err503, /временно/i);

  const errLeak = mod.formatProviderHttpError('openai', 404, 'Bad key sk-secret123456789', 'sk-secret123456789');
  assert.doesNotMatch(errLeak, /sk-secret123456789/);
  assert.match(errLeak, /\[REDACTED\]/);
});

test('callAiProvider handles ModuleAPI cost header and Anthropic response content[0].text', async () => {
  const mod = loadAiProvidersModule();

  const moduleRes = await mod.callAiProvider(
    { aiProvider: 'moduleapi', aiApiKey: 'sk-live-key', aiModel: 'gpt-4o-mini' },
    'Оцени йогурт',
    async (url, opts) => {
      assert.equal(url, 'https://moduleapi.pro/v1/chat/completions');
      assert.equal(opts.headers.Authorization, 'Bearer sk-live-key');
      return {
        ok: true,
        status: 200,
        headers: new Map([['x-moduleapi-cost', '0.0023']]),
        json: async () => ({
          choices: [{ message: { content: '1. Отзывы хорошие.\n2. Состав чистый.\n3. Отличный выбор.' } }],
          usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 }
        })
      };
    }
  );
  const plainModule = JSON.parse(JSON.stringify(moduleRes));
  assert.equal(plainModule.ok, true);
  assert.equal(plainModule.costUsd, 0.0023);
  assert.equal(plainModule.usage.totalTokens, 165);
  assert.match(plainModule.text, /Отличный выбор/);

  const anthropicRes = await mod.callAiProvider(
    { aiProvider: 'anthropic', aiApiKey: 'sk-ant-live', aiModel: 'claude-3-5-sonnet-latest' },
    'Оцени сыр',
    async (url, opts) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(opts.headers['x-api-key'], 'sk-ant-live');
      assert.equal(opts.headers['anthropic-version'], '2023-06-01');
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          content: [{ type: 'text', text: 'Отличный сыр без ЗМЖ.' }],
          usage: { input_tokens: 90, output_tokens: 30 }
        })
      };
    }
  );
  const plainAnthropic = JSON.parse(JSON.stringify(anthropicRes));
  assert.equal(plainAnthropic.ok, true);
  assert.equal(plainAnthropic.text, 'Отличный сыр без ЗМЖ.');
  assert.equal(plainAnthropic.costUsd, null);
  assert.equal(plainAnthropic.usage.totalTokens, 120);
});

test('callAiProvider throws friendly Russian error on HTTP 402 and 429', async () => {
  const mod = loadAiProvidersModule();

  await assert.rejects(
    () =>
      mod.callAiProvider(
        { aiProvider: 'moduleapi', aiApiKey: 'sk-test', aiModel: 'gpt-4o-mini' },
        'Тест',
        async () => ({
          ok: false,
          status: 402,
          headers: new Map(),
          text: async () => JSON.stringify({ error: { message: 'Insufficient balance' } })
        })
      ),
    (err) => {
      assert.equal(err.status, 402);
      assert.match(err.message, /недостаточно средств/i);
      return true;
    }
  );

  await assert.rejects(
    () =>
      mod.callAiProvider(
        { aiProvider: 'moduleapi', aiApiKey: 'sk-test', aiModel: 'gpt-4o-mini' },
        'Тест',
        async () => ({
          ok: false,
          status: 429,
          headers: new Map(),
          text: async () => JSON.stringify({ error: { message: 'Rate limit exceeded' } })
        })
      ),
    (err) => {
      assert.equal(err.status, 429);
      assert.match(err.message, /лимит запросов/i);
      return true;
    }
  );
});

test('testProviderConnection loads GET /models list and reports Russian error on invalid key', async () => {
  const mod = loadAiProvidersModule();

  const okRes = JSON.parse(
    JSON.stringify(
      await mod.testProviderConnection(
        { aiProvider: 'moduleapi', aiApiKey: 'sk-good' },
        async (url, opts) => {
          assert.equal(url, 'https://moduleapi.pro/v1/models');
          assert.equal(opts.headers.Authorization, 'Bearer sk-good');
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: 'gpt-4o-mini' }, { id: 'claude-3-5-sonnet' }] })
          };
        }
      )
    )
  );
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.models, ['gpt-4o-mini', 'claude-3-5-sonnet']);

  const badRes = JSON.parse(
    JSON.stringify(
      await mod.testProviderConnection(
        { aiProvider: 'moduleapi', aiApiKey: 'sk-bad' },
        async () => ({
          ok: false,
          status: 401,
          text: async () => '{"error":{"message":"Invalid API key"}}'
        })
      )
    )
  );
  assert.equal(badRes.ok, false);
  assert.equal(badRes.status, 401);
  assert.match(badRes.error, /неверный/i);
});

test('checkPaidAiDailyLimit enforces daily limit and recordPaidAiUsage tracks today/month USD spend and rollovers', () => {
  const mod = loadAiProvidersModule();
  const day1 = new Date('2026-11-20T10:00:00Z');
  const day2 = new Date('2026-11-21T09:00:00Z');
  const nextMonth = new Date('2026-12-01T09:00:00Z');

  let ledger = mod.recordPaidAiUsage({}, { costUsd: 0.0025, providerId: 'moduleapi', model: 'gpt-4o-mini' }, day1);
  ledger = mod.recordPaidAiUsage(
    ledger,
    { costUsd: null, usage: { promptTokens: 1000, completionTokens: 500 }, providerId: 'openai', model: 'gpt-4o-mini' },
    day1
  );
  const plainDay1 = JSON.parse(JSON.stringify(ledger));
  assert.equal(plainDay1.todayCount, 2);
  assert.equal(plainDay1.monthCount, 2);
  assert.ok(plainDay1.todayCostUsd > 0.0025);
  assert.equal(plainDay1.todayCostUsd, plainDay1.monthCostUsd);

  const allowedCheck = JSON.parse(JSON.stringify(mod.checkPaidAiDailyLimit(ledger, 25, day1)));
  assert.equal(allowedCheck.allowed, true);
  assert.equal(allowedCheck.remaining, 23);

  const blockedCheck = JSON.parse(JSON.stringify(mod.checkPaidAiDailyLimit(ledger, 2, day1)));
  assert.equal(blockedCheck.allowed, false);
  assert.equal(blockedCheck.remaining, 0);
  assert.match(blockedCheck.error, /лимит/i);
  assert.match(blockedCheck.error, /2\/2/);

  // Rollover to next day resets todayCount/todayCostUsd but keeps month totals
  const day2Ledger = JSON.parse(JSON.stringify(mod.normalizeUsageLedger(ledger, day2)));
  assert.equal(day2Ledger.todayCount, 0);
  assert.equal(day2Ledger.todayCostUsd, 0);
  assert.equal(day2Ledger.monthCount, 2);
  assert.equal(day2Ledger.monthCostUsd, plainDay1.monthCostUsd);

  // Rollover to next month resets both day and month totals
  const nextMonthLedger = JSON.parse(JSON.stringify(mod.normalizeUsageLedger(ledger, nextMonth)));
  assert.equal(nextMonthLedger.todayCount, 0);
  assert.equal(nextMonthLedger.monthCount, 0);
  assert.equal(nextMonthLedger.monthCostUsd, 0);
});
