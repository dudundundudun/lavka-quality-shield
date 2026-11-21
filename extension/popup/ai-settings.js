/**
 * Lavka Quality Shield — Popup AI Providers & Budget Settings Module
 * Модуль настроек ИИ-провайдеров, DPAPI-ключей, режима вкладки Gemini и бюджета.
 */
(function (root) {
  'use strict';

  function getDefaultSettings() {
    return (root.LQS_CONFIG && root.LQS_CONFIG.DEFAULT_SETTINGS) ? root.LQS_CONFIG.DEFAULT_SETTINGS : {};
  }

  function getEscapeHtml() {
    return (root.LQS_UTILS && typeof root.LQS_UTILS.escapeHtml === 'function')
      ? root.LQS_UTILS.escapeHtml
      : (v) => String(v ?? '');
  }

  function getSaveSettingsPatch() {
    return (root.LQS_UTILS && typeof root.LQS_UTILS.saveSettingsPatch === 'function')
      ? root.LQS_UTILS.saveSettingsPatch
      : null;
  }

  function getAiProviders() {
    return root.LQS_AI_PROVIDERS || null;
  }

  function getSelectedAiProviderId() {
    const sel = document.getElementById('sel-ai-provider');
    return (sel && sel.value) || 'gemini_tab';
  }

  function syncGeminiTabModeUi() {
    const modeSel = document.getElementById('sel-gemini-tab-mode');
    const idleRow = document.getElementById('gemini-idle-minutes-row');
    if (!modeSel || !idleRow) return;
    idleRow.hidden = modeSel.value === 'keep_open';
  }

  function renderAiKeyStorageBadge(status) {
    const badge = document.getElementById('ai-key-storage-badge');
    const delBtn = document.getElementById('delete-ai-key-btn');
    const keyInp = document.getElementById('inp-ai-key');
    if (!badge) return;

    badge.className = 'lqs-key-status';
    if (!status || !status.ok) {
      badge.textContent = 'Ключ будет зашифрован через Windows DPAPI при запущенном сервере :8765.';
      if (delBtn) delBtn.hidden = true;
      return;
    }

    if (status.storedOnServer && status.hasKey) {
      badge.classList.add('secure');
      badge.textContent = `🔒 Ключ зашифрован на сервере (Windows DPAPI): ${status.mask || 'sk-...****'}`;
      if (delBtn) delBtn.hidden = false;
      if (keyInp) keyInp.placeholder = `🔒 В DPAPI-сейфе (${status.mask || 'сохранён'}) — введите новый для замены`;
    } else if (status.hasKey) {
      badge.classList.add('warn');
      badge.textContent = `⚠️ Сервер :8765 выключен — ключ хранится резервно в браузере (${status.mask || 'сохранён'}). Запустите start_server.bat для шифрования DPAPI.`;
      if (delBtn) delBtn.hidden = false;
      if (keyInp) keyInp.placeholder = `⚠️ Локально (${status.mask || 'сохранён'}) — введите новый для замены`;
    } else {
      badge.textContent = status.serverOnline
        ? 'Ключ не задан — при сохранении будет зашифрован через Windows DPAPI на сервере :8765.'
        : 'Сервер :8765 выключен — при сохранении ключ запишется резервно в браузер.';
      if (delBtn) delBtn.hidden = true;
      if (keyInp) keyInp.placeholder = 'Вставьте API-ключ провайдера...';
    }
  }

  function refreshAiKeyVaultStatus(providerId = '') {
    const prov = providerId || getSelectedAiProviderId();
    if (prov === 'gemini_tab') return;
    if (!chrome.runtime || !chrome.runtime.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'LQS_GET_AI_KEY_STATUS', aiProvider: prov }, (resp) => {
      if (!chrome.runtime.lastError && resp && resp.ok) {
        renderAiKeyStorageBadge(resp);
      }
    });
  }

  function formatUsdShort(val) {
    const n = Number(val || 0);
    if (!Number.isFinite(n) || n <= 0) return '$0.00';
    if (n < 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(2)}`;
  }

  function refreshAiUsageStats() {
    const sumEl = document.getElementById('ai-usage-summary');
    if (!sumEl || !chrome.runtime || !chrome.runtime.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'LQS_GET_AI_USAGE_STATS' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) return;
      const todayCount = Number(resp.todayCount || 0);
      const limit = Number.isFinite(Number(resp.dailyLimit)) ? Number(resp.dailyLimit) : 25;
      const limitLabel = limit > 0 ? String(limit) : '∞';
      const todayCost = formatUsdShort(resp.todayCostUsd);
      const monthCost = formatUsdShort(resp.monthCostUsd);
      sumEl.textContent = `Сегодня запросов: ${todayCount} / ${limitLabel} · Потрачено: ${todayCost} (месяц: ${monthCost})`;
    });
  }

  function syncAiProviderUi(providerId, { autoFillUrl = false, autoFillModel = false } = {}) {
    const prov = String(providerId || 'gemini_tab').trim().toLowerCase();
    const aiProviders = getAiProviders();
    const preset = aiProviders && typeof aiProviders.getProviderPreset === 'function'
      ? aiProviders.getProviderPreset(prov)
      : null;

    const sel = document.getElementById('sel-ai-provider');
    if (sel && sel.value !== prov) sel.value = prov;

    const geminiBox = document.getElementById('ai-gemini-config-box');
    const apiBox = document.getElementById('ai-api-config-box');
    const baseUrlField = document.getElementById('ai-base-url-field');
    const modLink = document.getElementById('moduleapi-check-link');
    const modeBadge = document.getElementById('ai-provider-mode-badge');
    const urlInp = document.getElementById('inp-ai-url');
    const modelInp = document.getElementById('inp-ai-model');

    const isGeminiTab = prov === 'gemini_tab';
    if (geminiBox) geminiBox.hidden = !isGeminiTab;
    if (apiBox) apiBox.hidden = isGeminiTab;
    if (baseUrlField) baseUrlField.hidden = prov !== 'custom_openai';
    if (modLink) modLink.hidden = prov !== 'moduleapi';

    if (modeBadge) {
      const isPaid = preset ? Boolean(preset.isPaid) : !isGeminiTab && prov !== 'custom_openai';
      modeBadge.className = 'lqs-ai-badge' + (isPaid ? '' : ' free');
      modeBadge.textContent = isPaid ? 'Платный API · по кнопке' : 'Бесплатно';
    }

    if (autoFillUrl && urlInp && preset && preset.baseUrl) {
      if (prov !== 'custom_openai' || !urlInp.value.trim()) {
        urlInp.value = preset.baseUrl;
      }
    }
    if (autoFillModel && modelInp && preset) {
      if (preset.defaultModel) {
        modelInp.value = preset.defaultModel;
      } else if (prov === 'moduleapi' || prov === 'openrouter' || prov === 'custom_openai') {
        modelInp.value = '';
      }
    }

    if (!isGeminiTab) {
      refreshAiKeyVaultStatus(prov);
    }
  }

  function populateModelsDatalist(models, selectFirstIfEmpty = true) {
    const dl = document.getElementById('ai-models-datalist');
    const modelInp = document.getElementById('inp-ai-model');
    const list = Array.isArray(models) ? models : [];
    const escapeHtml = getEscapeHtml();
    if (dl) {
      dl.innerHTML = list.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
    }
    if (selectFirstIfEmpty && list.length > 0 && modelInp && !modelInp.value.trim()) {
      modelInp.value = list[0];
    }
    return list.length;
  }

  function testSelectedAiProviderAndLoadModels(silent = false) {
    const aiProvider = getSelectedAiProviderId();
    if (aiProvider === 'gemini_tab') return;
    const aiBaseUrl = document.getElementById('inp-ai-url').value.trim();
    const aiApiKey = document.getElementById('inp-ai-key').value.trim();
    const testBtn = document.getElementById('test-ai-provider-btn');
    const statusEl = document.getElementById('ai-test-status');
    const hintEl = document.getElementById('ai-models-hint');

    if (!silent) {
      if (testBtn) {
        testBtn.disabled = true;
        testBtn.textContent = '⏳ Проверяю ключ и загружаю модели...';
      }
      if (statusEl) {
        statusEl.className = 'lqs-test-status';
        statusEl.textContent = 'Подключаюсь к провайдеру...';
      }
    }

    chrome.runtime.sendMessage({ type: 'LQS_TEST_AI_PROVIDER', aiProvider, aiBaseUrl, aiApiKey }, (resp) => {
      if (testBtn) {
        testBtn.disabled = false;
        testBtn.textContent = '🔑 Проверить ключ и загрузить модели';
      }
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        const errMsg = resp?.error || 'Не удалось подключиться к провайдеру';
        if (!silent && statusEl) {
          statusEl.className = 'lqs-test-status err';
          statusEl.textContent = `⚠️ ${errMsg}`;
        }
        if (!silent && hintEl) {
          hintEl.textContent = `⚪ ${errMsg}`;
        }
        return;
      }

      const count = populateModelsDatalist(resp.models, true);
      const vaultTag = resp.usedServerKey ? ' · ключ из DPAPI-сейфа' : '';
      if (hintEl) {
        hintEl.textContent = count > 0
          ? `✅ Загружено моделей: ${count}${vaultTag}`
          : `✅ Ключ принят, список /models пуст${vaultTag}`;
      }
      if (!silent && statusEl) {
        statusEl.className = 'lqs-test-status ok';
        statusEl.textContent = count > 0
          ? `✅ Подключение успешно! Доступно моделей: ${count}${vaultTag}`
          : `✅ Ключ действителен${vaultTag}`;
      }
    });
  }

  function applyLoadedAiSettings(cfg) {
    const aiProviders = getAiProviders();
    const resolved = aiProviders && typeof aiProviders.resolveProviderConfig === 'function'
      ? aiProviders.resolveProviderConfig(cfg)
      : { providerId: cfg.aiProvider || 'gemini_tab', baseUrl: cfg.aiBaseUrl };

    const provSel = document.getElementById('sel-ai-provider');
    if (provSel) provSel.value = resolved.providerId;

    const urlInp = document.getElementById('inp-ai-url');
    if (urlInp) {
      urlInp.value = resolved.providerId === 'custom_openai'
        ? (cfg.aiBaseUrl || resolved.baseUrl)
        : resolved.baseUrl;
    }
    // Не подставляем открытый ключ в DOM-поле, показываем статус/маску отдельно
    const keyInp = document.getElementById('inp-ai-key');
    if (keyInp) keyInp.value = '';
    const modelInp = document.getElementById('inp-ai-model');
    if (modelInp) modelInp.value = cfg.aiModel || '';

    const modeSel = document.getElementById('sel-gemini-tab-mode');
    if (modeSel) modeSel.value = cfg.geminiTabMode || 'stealth_window';
    const idleInp = document.getElementById('inp-gemini-idle-minutes');
    if (idleInp) idleInp.value = String(cfg.geminiIdleCloseMinutes ?? 5);
    syncGeminiTabModeUi();

    const limitInp = document.getElementById('inp-paid-daily-limit');
    if (limitInp) limitInp.value = String(cfg.paidAiDailyLimit ?? 25);

    syncAiProviderUi(resolved.providerId, { autoFillUrl: false, autoFillModel: false });
    refreshAiUsageStats();
  }

  function bindAiSettingsEvents(deps = {}) {
    const readSelectedLiveRadarStores = typeof deps.readSelectedLiveRadarStores === 'function'
      ? deps.readSelectedLiveRadarStores
      : () => ['kuper'];
    const refreshAiRadar = typeof deps.refreshAiRadar === 'function'
      ? deps.refreshAiRadar
      : () => {};

    const selAiProviderEl = document.getElementById('sel-ai-provider');
    if (selAiProviderEl) {
      selAiProviderEl.addEventListener('change', () => {
        const prov = getSelectedAiProviderId();
        const keyInp = document.getElementById('inp-ai-key');
        if (keyInp) keyInp.value = '';
        const testStatus = document.getElementById('ai-test-status');
        if (testStatus) {
          testStatus.className = 'lqs-test-status';
          testStatus.textContent = '';
        }
        syncAiProviderUi(prov, { autoFillUrl: true, autoFillModel: true });
      });
    }

    const selGeminiModeEl = document.getElementById('sel-gemini-tab-mode');
    if (selGeminiModeEl) {
      selGeminiModeEl.addEventListener('change', syncGeminiTabModeUi);
    }

    const testAiProviderBtn = document.getElementById('test-ai-provider-btn');
    if (testAiProviderBtn) {
      testAiProviderBtn.addEventListener('click', () => testSelectedAiProviderAndLoadModels(false));
    }

    const refreshModelsBtn = document.getElementById('refresh-ai-models-btn');
    if (refreshModelsBtn) {
      refreshModelsBtn.addEventListener('click', () => testSelectedAiProviderAndLoadModels(false));
    }

    const deleteAiKeyBtn = document.getElementById('delete-ai-key-btn');
    if (deleteAiKeyBtn) {
      deleteAiKeyBtn.addEventListener('click', () => {
        const prov = getSelectedAiProviderId();
        chrome.runtime.sendMessage({ type: 'LQS_DELETE_AI_KEY', aiProvider: prov }, () => {
          const keyInp = document.getElementById('inp-ai-key');
          if (keyInp) keyInp.value = '';
          refreshAiKeyVaultStatus(prov);
          const st = document.getElementById('ai-save-status');
          if (st) {
            st.textContent = '🗑️ API-ключ удалён.';
            setTimeout(() => { st.textContent = ''; }, 2000);
          }
        });
      });
    }

    const saveAiBtn = document.getElementById('save-ai-btn');
    if (saveAiBtn) {
      saveAiBtn.addEventListener('click', () => {
        const defaultSettings = getDefaultSettings();
        const aiProviders = getAiProviders();
        const aiProvider = getSelectedAiProviderId();
        const preset = aiProviders && typeof aiProviders.getProviderPreset === 'function'
          ? aiProviders.getProviderPreset(aiProvider)
          : null;
        const resolvedBaseUrl = aiProvider === 'custom_openai'
          ? (document.getElementById('inp-ai-url').value.trim() || defaultSettings.aiBaseUrl)
          : ((preset && preset.baseUrl) || defaultSettings.aiBaseUrl);

        const rawDailyLimit = Number(document.getElementById('inp-paid-daily-limit')?.value);
        const paidAiDailyLimit = Number.isFinite(rawDailyLimit) && rawDailyLimit >= 0 ? Math.floor(rawDailyLimit) : 25;

        const rawIdleMin = Number(document.getElementById('inp-gemini-idle-minutes')?.value);
        const geminiIdleCloseMinutes = Number.isFinite(rawIdleMin) && rawIdleMin >= 1 ? Math.min(120, Math.floor(rawIdleMin)) : 5;
        const geminiTabMode = document.getElementById('sel-gemini-tab-mode')?.value || 'stealth_window';

        const patch = {
          backendUrl: document.getElementById('inp-backend').value.trim() || defaultSettings.backendUrl,
          aiProvider,
          aiBaseUrl: resolvedBaseUrl,
          aiModel: document.getElementById('inp-ai-model').value.trim(),
          preferBrowserGeminiTab: aiProvider === 'gemini_tab',
          paidAiDailyLimit,
          geminiTabMode,
          geminiIdleCloseMinutes,
          autoRunAiOnProductPage: document.getElementById('chk-auto-run-ai').checked,
          autoOpenDrawerOnAi: document.getElementById('chk-auto-open-drawer').checked,
          autoWarmupGeminiTab: document.getElementById('chk-auto-warmup').checked,
          priceChartWindowMode: Boolean(document.getElementById('chk-price-chart-popover')?.checked),
          watchlistCheckIntervalHours: Number(document.getElementById('sel-watchlist-interval')?.value ?? 6),
          liveRadarStores: readSelectedLiveRadarStores(),
          lavkaAccountLabel: document.getElementById('lavka-account-select').value
        };

        const tokEl = document.getElementById('inp-backend-token');
        if (tokEl) {
          chrome.runtime.sendMessage({ type: 'LQS_SET_BACKEND_TOKEN', token: tokEl.value.trim() });
        }

        const rawKeyInput = (document.getElementById('inp-ai-key')?.value || '').trim();
        const finishSave = (statusMsg) => {
          const st = document.getElementById('ai-save-status');
          if (st) {
            st.textContent = statusMsg;
            setTimeout(() => { st.textContent = ''; }, 3000);
          }
          refreshAiRadar();
          refreshAiUsageStats();
          refreshAiKeyVaultStatus(aiProvider);
        };

        const saveSettingsPatch = getSaveSettingsPatch();
        if (!saveSettingsPatch) return;
        saveSettingsPatch(patch, () => {
          if (aiProvider !== 'gemini_tab' && rawKeyInput) {
            chrome.runtime.sendMessage({ type: 'LQS_SAVE_AI_KEY', aiProvider, aiApiKey: rawKeyInput }, (resp) => {
              const keyInp = document.getElementById('inp-ai-key');
              if (keyInp) keyInp.value = '';
              if (resp && resp.ok && resp.storedOnServer) {
                finishSave(`✅ Сохранено! Ключ зашифрован на сервере (DPAPI: ${resp.mask})`);
              } else if (resp && resp.ok) {
                finishSave('✅ Сохранено (ключ в браузере: сервер :8765 выключен)');
              } else {
                finishSave('⚠️ Настройки сохранены, но ключ не удалось записать');
              }
            });
          } else {
            finishSave('✅ Настройки ИИ сохранены!');
          }
        });
      });
    }
  }

  const api = {
    getSelectedAiProviderId,
    syncGeminiTabModeUi,
    renderAiKeyStorageBadge,
    refreshAiKeyVaultStatus,
    formatUsdShort,
    refreshAiUsageStats,
    syncAiProviderUi,
    populateModelsDatalist,
    testSelectedAiProviderAndLoadModels,
    applyLoadedAiSettings,
    bindAiSettingsEvents
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_POPUP_AI_SETTINGS = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
