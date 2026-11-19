/**
 * Lavka Quality Shield — Shared Utility Functions
 * Single source of truth for background.js, content.js, popup.js, and Node.js tests.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_UTILS = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function (root) {
  'use strict';

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeHttpUrl(url) {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : '';
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return resp;
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  }

  async function getSettings() {
    const cfg = root.LQS_CONFIG || {};
    const settingsKey = (cfg.STORAGE_KEYS && cfg.STORAGE_KEYS.SETTINGS) || 'lqs_settings_v2';
    const defaults = cfg.DEFAULT_SETTINGS || {};
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([settingsKey], (res) => {
          resolve({ ...defaults, ...(res && res[settingsKey] ? res[settingsKey] : {}) });
        });
      } else {
        resolve({ ...defaults });
      }
    });
  }

  async function saveSettingsPatch(patch, callback) {
    const cfg = root.LQS_CONFIG || {};
    const settingsKey = (cfg.STORAGE_KEYS && cfg.STORAGE_KEYS.SETTINGS) || 'lqs_settings_v2';
    const current = await getSettings();
    const next = { ...current, ...(patch || {}) };
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [settingsKey]: next }, () => {
          if (typeof callback === 'function') callback(next);
          resolve(next);
        });
      } else {
        if (typeof callback === 'function') callback(next);
        resolve(next);
      }
    });
  }

  function _parseVolumeOrWeightGrams(rawStr) {
    if (!rawStr) return null;
    const s = String(rawStr).replace(/[\u00ad\u200b\u00a0]/g, ' ');
    const multi = s.match(
      /(\d+)\s*[×xх*]\s*(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i
    );
    if (multi) {
      const cnt = parseInt(multi[1], 10) || 1;
      const val = parseFloat(multi[2].replace(',', '.'));
      const u = multi[3].toLowerCase();
      const mult = u.startsWith('кг') || u.startsWith('л') ? 1000 : 1;
      if (val > 0) return cnt * val * mult;
    }
    const single = s.match(
      /(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])/i
    );
    if (single) {
      const val = parseFloat(single[1].replace(',', '.'));
      const u = single[2].toLowerCase();
      const mult = u.startsWith('кг') || u.startsWith('л') ? 1000 : 1;
      if (val > 0) return val * mult;
    }
    return null;
  }

  function buildFullProductSearchQuery(title, brand = '', amount = '') {
    let q = String(title || '').replace(/[\u00ad\u200b\u00a0«»"'„“”]/g, ' ');
    q = q.replace(/(^|\s)(?:бзмж|стм)(?=\s|$)/gi, ' ');
    q = q.replace(/\s+/g, ' ').trim();

    if (brand) {
      const cleanBrand = String(brand).replace(/[\u00ad\u200b\u00a0«»"']/g, ' ').trim();
      if (cleanBrand && !q.toLowerCase().includes(cleanBrand.toLowerCase())) {
        q = cleanBrand.toLowerCase() === 'из лавки' ? `${q} Из Лавки` : `${q} ${cleanBrand}`;
      }
    }

    if (amount) {
      const cleanAmt = String(amount).replace(/[\u00ad\u200b\u00a0]/g, ' ').trim();
      if (cleanAmt) {
        const targetGrams = _parseVolumeOrWeightGrams(cleanAmt);
        const queryGrams = _parseVolumeOrWeightGrams(q);
        if (!queryGrams && !q.toLowerCase().includes(cleanAmt.toLowerCase())) {
          q = `${q} ${cleanAmt}`;
        } else if (targetGrams && queryGrams && Math.abs(targetGrams - queryGrams) > 5) {
          q = `${q} ${cleanAmt}`;
        }
      }
    }

    return q.replace(/\s+/g, ' ').trim();
  }

  function buildDirectStoreSearchLinks(rawTitle, amount = '', brand = '') {
    const fullQuery = buildFullProductSearchQuery(rawTitle, brand, amount);
    const enc = encodeURIComponent(fullQuery || rawTitle || '');
    return [
      // У дома и экспресс
      { store: 'Магнит', category: 'У дома', url: `https://magnit.ru/search?term=${enc}`, query: fullQuery },
      { store: 'Пятёрочка', category: 'У дома', url: `https://5ka.ru/catalog/?q=${enc}`, query: fullQuery },
      { store: 'Перекрёсток', category: 'Супермаркет', url: `https://www.perekrestok.ru/cat/search?search=${enc}`, query: fullQuery },
      { store: 'ВкусВилл', category: 'У дома', url: `https://vkusvill.ru/search/?q=${enc}`, query: fullQuery },
      { store: 'Магнолия', category: 'У дома', url: `https://shop.mgnl.ru/catalog/?q=${enc}`, query: fullQuery },
      { store: 'Дикси', category: 'У дома', url: `https://dixy.ru/catalog/?q=${enc}`, query: fullQuery },
      { store: 'Чижик', category: 'Дискаунтер', url: `https://chizhik.club/search?query=${enc}`, query: fullQuery },
      // Гипермаркеты
      { store: 'Ашан', category: 'Гипермаркет', url: `https://www.auchan.ru/search/?q=${enc}`, query: fullQuery },
      { store: 'МЕТРО', category: 'Гипермаркет', url: `https://online.metro-cc.ru/search?q=${enc}`, query: fullQuery },
      { store: 'Глобус', category: 'Гипермаркет', url: `https://online.globus.ru/search/?q=${enc}`, query: fullQuery },
      { store: 'Лента', category: 'Гипермаркет', url: `https://lenta.com/search/?searchText=${enc}`, query: fullQuery },
      { store: 'О’КЕЙ', category: 'Гипермаркет', url: `https://www.okeydostavka.ru/webapp/wcs/stores/servlet/SearchDisplay?searchTerm=${enc}`, query: fullQuery },
      { store: 'Азбука Вкуса', category: 'Супермаркет', url: `https://av.ru/search/?text=${enc}`, query: fullQuery },
      // Маркетплейсы и агрегаторы
      { store: 'Ozon Fresh', category: 'Маркетплейс', url: `https://www.ozon.ru/search/?text=${enc}`, query: fullQuery },
      { store: 'Купер', category: 'Агрегатор', url: `https://kuper.ru/multisearch?q=${enc}`, query: fullQuery },
      { store: 'Я.Маркет', category: 'Маркетплейс', url: `https://market.yandex.ru/search?text=${enc}`, query: fullQuery }
    ];
  }

  return Object.freeze({
    escapeHtml,
    safeHttpUrl,
    fetchWithTimeout,
    getSettings,
    saveSettingsPatch,
    buildFullProductSearchQuery,
    buildDirectStoreSearchLinks
  });
});
