/**
 * Lavka Quality Shield — Popup AI Providers & Budget Settings Module
 * Модуль настроек ИИ-провайдеров, DPAPI-ключей, режима вкладки Gemini, выбора моделей и бюджета.
 */
(function (root) {
  'use strict';

  const MODELS_CACHE_STORAGE_KEY = 'lqs_ai_models_cache_v1';
  let loadedModelsList = [];
  let loadedModelsProvider = '';

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

  function getLoadedModelsList() {
    return [...loadedModelsList];
  }

  function saveModelsCacheForProvider(providerId, models) {
    if (!providerId || !Array.isArray(models) || models.length === 0) return;
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get([MODELS_CACHE_STORAGE_KEY], (res) => {
      const cache = (res && typeof res[MODELS_CACHE_STORAGE_KEY] === 'object' && res[MODELS_CACHE_STORAGE_KEY])
        ? { ...res[MODELS_CACHE_STORAGE_KEY] }
        : {};
      cache[providerId] = models;
      chrome.storage.local.set({ [MODELS_CACHE_STORAGE_KEY]: cache });
    });
  }

  function restoreCachedModelsForProvider(providerId) {
    if (!providerId || providerId === 'gemini_tab') {
      loadedModelsList = [];
      loadedModelsProvider = providerId;
      closeModelsDropdown();
      return;
    }
    if (!chrome || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get([MODELS_CACHE_STORAGE_KEY], (res) => {
      if (getSelectedAiProviderId() !== providerId) return;
      const cache = res && res[MODELS_CACHE_STORAGE_KEY];
      const cached = cache && Array.isArray(cache[providerId]) ? cache[providerId] : [];
      loadedModelsProvider = providerId;
      loadedModelsList = [...cached];
      syncLegacyDatalist(loadedModelsList);
      const hintEl = document.getElementById('ai-models-hint');
      if (hintEl && cached.length > 0) {
        hintEl.textContent = `✅ Доступно моделей: ${cached.length} (нажмите на поле или ▾ для выбора)`;
      }
    });
  }

  function syncLegacyDatalist(list) {
    const dl = document.getElementById('ai-models-datalist');
    if (!dl) return;
    const escapeHtml = getEscapeHtml();
    dl.innerHTML = list.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
  }

  function closeModelsDropdown() {
    const dd = document.getElementById('ai-models-dropdown');
    const toggleBtn = document.getElementById('toggle-ai-models-btn');
    if (dd) dd.hidden = true;
    if (toggleBtn && typeof toggleBtn.setAttribute === 'function') {
      toggleBtn.setAttribute('aria-expanded', 'false');
    }
  }

  function renderModelsDropdown(filterText = '') {
    const dd = document.getElementById('ai-models-dropdown');
    const modelInp = document.getElementById('inp-ai-model');
    if (!dd) return 0;

    const escapeHtml = getEscapeHtml();
    const currentVal = String(modelInp?.value || '').trim();
    const query = String(filterText || '').trim().toLowerCase();

    const filtered = query
      ? loadedModelsList.filter((m) => m.toLowerCase().includes(query))
      : loadedModelsList;

    if (loadedModelsList.length === 0) {
      dd.innerHTML = '<div class="lqs-model-empty">Список моделей пуст — нажмите «🔑 Проверить ключ и загрузить модели» или 🔄</div>';
      return 0;
    }

    if (filtered.length === 0) {
      dd.innerHTML = `<div class="lqs-model-empty">Совпадений для «${escapeHtml(filterText)}» нет (всего моделей: ${loadedModelsList.length})</div>`;
      return 0;
    }

    dd.innerHTML = filtered
      .map((m) => {
        const isSelected = m === currentVal;
        const cls = isSelected ? 'lqs-model-option selected' : 'lqs-model-option';
        const mark = isSelected ? '<span class="lqs-model-check">✓</span>' : '';
        return `<button type="button" class="${cls}" role="option" aria-selected="${isSelected ? 'true' : 'false'}" data-model-id="${escapeHtml(m)}"><span>${escapeHtml(m)}</span>${mark}</button>`;
      })
      .join('');
    return filtered.length;
  }

  function openModelsDropdown(filterText = '') {
    const dd = document.getElementById('ai-models-dropdown');
    const toggleBtn = document.getElementById('toggle-ai-models-btn');
    if (!dd) return 0;
    const count = renderModelsDropdown(filterText);
    dd.hidden = false;
    if (toggleBtn && typeof toggleBtn.setAttribute === 'function') {
      toggleBtn.setAttribute('aria-expanded', 'true');
    }
    return count;
  }

  function renderAiKeyStorageBadge(status) {
    const badge = document.getElementById('ai-key-storage-badge');
    const delBtn = document.getElementById('delete-ai-key-btn');
    const keyInp = document.getElementById('inp-ai-key');
    const offlineActions = document.getElementById('ai-server-offline-actions');
    const spoilerStatus = document.getElementById('spoiler-server-status');
    if (!badge) return;

    badge.className = 'lqs-key-status';
    if (!status || !status.ok) {
      badge.textContent = 'Ключ будет зашифрован через Windows DPAPI при запущенном сервере :8765.';
      if (delBtn) delBtn.hidden = true;
      if (offlineActions) offlineActions.hidden = false;
      return;
    }

    const serverOnline = Boolean(status.serverOnline || status.storedOnServer);
    if (offlineActions) offlineActions.hidden = serverOnline;
    if (spoilerStatus) {
      spoilerStatus.textContent = serverOnline ? '🟢 Сервер :8765 работает' : '⚪ Сервер :8765 выключен';
      spoilerStatus.style.color = serverOnline ? '#15803d' : '#92400e';
    }

    if (status.storedOnServer && status.hasKey) {
      badge.classList.add('secure');
      badge.textContent = `🔒 Ключ зашифрован на сервере (Windows DPAPI): ${status.mask || 'sk-...****'}`;
      if (delBtn) delBtn.hidden = false;
      if (keyInp) keyInp.placeholder = `🔒 В DPAPI-сейфе (${status.mask || 'сохранён'}) — введите новый для замены`;
    } else if (status.hasKey) {
      badge.classList.add('warn');
      badge.textContent = `⚠️ Сервер :8765 выключен — ключ хранится резервно в браузере (${status.mask || 'сохранён'}). Нажмите «Включить сервер» ниже для шифрования DPAPI.`;
      if (delBtn) delBtn.hidden = false;
      if (keyInp) keyInp.placeholder = `⚠️ Локально (${status.mask || 'сохранён'}) — введите новый для замены`;
    } else {
      badge.textContent = serverOnline
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

    closeModelsDropdown();
    if (!isGeminiTab) {
      refreshAiKeyVaultStatus(prov);
      restoreCachedModelsForProvider(prov);
    } else {
      loadedModelsList = [];
      loadedModelsProvider = prov;
    }
  }

  function populateModelsDatalist(models, selectFirstIfEmpty = true) {
    const modelInp = document.getElementById('inp-ai-model');
    const raw = Array.isArray(models) ? models : [];
    const list = [];
    for (const item of raw) {
      const id = String(item || '').trim();
      if (id && !list.includes(id)) list.push(id);
    }
    loadedModelsList = list;
    loadedModelsProvider = getSelectedAiProviderId();
    syncLegacyDatalist(list);
    saveModelsCacheForProvider(loadedModelsProvider, list);

    if (selectFirstIfEmpty && list.length > 0 && modelInp && !modelInp.value.trim()) {
      modelInp.value = list[0];
    }
    renderModelsDropdown('');
    return list.length;
  }

  function startLocalServerFromPopup(deps = {}) {
    const refreshAiRadar = typeof deps.refreshAiRadar === 'function' ? deps.refreshAiRadar : () => {};
    const btns = [
      document.getElementById('start-local-server-btn'),
      document.getElementById('spoiler-start-server-btn')
    ].filter(Boolean);
    const statusEl = document.getElementById('start-local-server-status');
    const copyIdBtn = document.getElementById('copy-ext-id-btn');

    btns.forEach((b) => {
      b.disabled = true;
      b.textContent = '⏳ Запускаю сервер :8765...';
    });
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = 'lqs-test-status';
      statusEl.textContent = 'Запускаю локальный сервер :8765 в фоне...';
    }
    if (copyIdBtn) copyIdBtn.hidden = true;

    chrome.runtime.sendMessage({ type: 'LQS_START_LOCAL_SERVER', force: true }, (resp) => {
      btns.forEach((b) => {
        b.disabled = false;
        b.textContent = '▶ Включить сервер :8765';
      });
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        if (statusEl) {
          statusEl.hidden = false;
          statusEl.className = 'lqs-test-status err';
          if (resp && resp.hostMissing) {
            statusEl.textContent = '⚠️ Чтобы расширение запускало сервер само, один раз запустите server\\enable_windows_autostart.bat (оно подключит мост Chrome и автозапуск Windows).';
            if (copyIdBtn) copyIdBtn.hidden = false;
          } else {
            statusEl.textContent = `⚠️ ${resp?.error || 'Не удалось запустить сервер :8765'}`;
          }
        }
        return;
      }

      if (statusEl) {
        statusEl.hidden = false;
        statusEl.className = 'lqs-test-status ok';
        const migratedNote = resp.migratedKey ? ' · API-ключ перенесён в DPAPI-сейф' : '';
        statusEl.textContent = resp.alreadyRunning
          ? `✅ Сервер :8765 уже работает${migratedNote}`
          : `✅ Сервер :8765 успешно запущен!${migratedNote}`;
      }
      refreshAiKeyVaultStatus();
      refreshAiRadar();
    });
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
          ? `✅ Загружено моделей: ${count} (нажмите на поле или ▾ для выбора)${vaultTag}`
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
        const hintEl = document.getElementById('ai-models-hint');
        if (hintEl) hintEl.textContent = '';
        syncAiProviderUi(prov, { autoFillUrl: true, autoFillModel: true });
      });
    }

    const selGeminiModeEl = document.getElementById('sel-gemini-tab-mode');
    if (selGeminiModeEl) {
      selGeminiModeEl.addEventListener('change', syncGeminiTabModeUi);
    }

    // Полноценный выбор из всех загруженных моделей без бага фильтрации нативного <datalist>
    const modelInp = document.getElementById('inp-ai-model');
    const toggleModelsBtn = document.getElementById('toggle-ai-models-btn');
    const modelsDropdown = document.getElementById('ai-models-dropdown');
    const modelCombobox = document.getElementById('ai-model-combobox');

    if (modelInp) {
      modelInp.addEventListener('focus', () => {
        if (loadedModelsList.length > 0) {
          openModelsDropdown('');
        }
      });
      modelInp.addEventListener('click', () => {
        if (loadedModelsList.length > 0) {
          openModelsDropdown('');
        }
      });
      modelInp.addEventListener('input', () => {
        if (loadedModelsList.length > 0) {
          openModelsDropdown(modelInp.value);
        }
      });
      modelInp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeModelsDropdown();
        } else if (e.key === 'ArrowDown' && loadedModelsList.length > 0) {
          openModelsDropdown('');
        }
      });
    }

    if (toggleModelsBtn) {
      toggleModelsBtn.addEventListener('click', () => {
        if (modelsDropdown && !modelsDropdown.hidden) {
          closeModelsDropdown();
        } else {
          openModelsDropdown('');
        }
      });
    }

    if (modelsDropdown) {
      modelsDropdown.addEventListener('click', (e) => {
        const target = e.target && typeof e.target.closest === 'function'
          ? e.target.closest('[data-model-id]')
          : null;
        if (!target) return;
        const chosen = target.getAttribute('data-model-id');
        if (chosen && modelInp) {
          modelInp.value = chosen;
        }
        closeModelsDropdown();
      });
    }

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('click', (e) => {
        if (!modelCombobox || !modelsDropdown || modelsDropdown.hidden) return;
        if (typeof modelCombobox.contains === 'function' && !modelCombobox.contains(e.target)) {
          closeModelsDropdown();
        }
      });
    }

    const startServerBtn = document.getElementById('start-local-server-btn');
    if (startServerBtn) {
      startServerBtn.addEventListener('click', () => startLocalServerFromPopup({ refreshAiRadar }));
    }
    const spoilerStartServerBtn = document.getElementById('spoiler-start-server-btn');
    if (spoilerStartServerBtn) {
      spoilerStartServerBtn.addEventListener('click', () => startLocalServerFromPopup({ refreshAiRadar }));
    }
    const copyExtIdBtn = document.getElementById('copy-ext-id-btn');
    if (copyExtIdBtn) {
      copyExtIdBtn.addEventListener('click', async () => {
        const extId = chrome && chrome.runtime && chrome.runtime.id ? chrome.runtime.id : '';
        if (!extId) return;
        try {
          await navigator.clipboard.writeText(extId);
          copyExtIdBtn.textContent = `✅ Скопирован: ${extId.slice(0, 10)}...`;
          setTimeout(() => { copyExtIdBtn.textContent = '📋 Скопировать ID расширения'; }, 2500);
        } catch {
          copyExtIdBtn.textContent = extId;
        }
      });
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
    getLoadedModelsList,
    renderModelsDropdown,
    openModelsDropdown,
    closeModelsDropdown,
    renderAiKeyStorageBadge,
    refreshAiKeyVaultStatus,
    formatUsdShort,
    refreshAiUsageStats,
    syncAiProviderUi,
    populateModelsDatalist,
    startLocalServerFromPopup,
    testSelectedAiProviderAndLoadModels,
    applyLoadedAiSettings,
    bindAiSettingsEvents
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_POPUP_AI_SETTINGS = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
