/**
 * Lavka Quality Shield — Cart Snapshot, Cross-Account Comparison & Auto-Rebuild Module
 * Вынесено из background.js (Этап 4: модульная декомпозиция).
 */
(function (root) {
  'use strict';

  function getBgDeps() {
    return root.LQS_BG_DEPS || {};
  }

  const { STORAGE_KEYS } = root.LQS_CONFIG;
  const { fetchWithTimeout, getSettings } = root.LQS_UTILS;
  const {
    getLocalPriceDb,
    findPriceEntryInDb,
    recordPricesBatch,
    parseFullProductCardFromLavkaHtml
  } = root.LQS_PRICE_RADAR;

  const SAVED_CARTS_KEY = STORAGE_KEYS.SAVED_CARTS;

async function getSavedCartsState() {
  const settings = await getSettings();
  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');

  const localState = await new Promise((resolve) => {
    chrome.storage.local.get([SAVED_CARTS_KEY], (res) => {
      resolve(res && res[SAVED_CARTS_KEY] ? res[SAVED_CARTS_KEY] : { latest: null, byAccount: {} });
    });
  });

  if (backendUrl && Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
    try {
      const r = await fetchWithTimeout(
        `${backendUrl}/api/cart/latest`,
        { method: 'GET', headers: await getBgDeps().getBackendAuthHeaders(backendUrl) },
        1200
      );
      if (r.ok) {
        const j = await r.json();
        if (j && j.latest) {
          const byAcc = { ...(localState.byAccount || {}) };
          if (Array.isArray(j.cartsByAccount)) {
            j.cartsByAccount.forEach((c) => {
              if (c && c.accountId) byAcc[c.accountId] = c;
            });
          }
          const srvTime = String(j.latest.updatedAt || '');
          const locTime = String(localState.latest?.updatedAt || '');
          const bestLatest = locTime > srvTime ? localState.latest : j.latest;
          const merged = { latest: bestLatest, byAccount: byAcc };
          chrome.storage.local.set({ [SAVED_CARTS_KEY]: merged });
          return merged;
        }
      }
    } catch {
      getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
    }
  }

  return localState;
}

async function saveCartSnapshot(accountId, items, totalPrice = 0) {
  const settings = await getSettings();
  const acc = accountId || settings.lavkaAccountLabel || 'Аккаунт #1';
  const priceDb = await getLocalPriceDb();

  // Обогащаем позиции корзины полными названиями из оригинальных карточек товаров, если они уже есть в базе
  const cleanItems = (Array.isArray(items) ? items : [])
    .filter((i) => i && i.slug)
    .map((i) => {
      const existing = findPriceEntryInDb(priceDb, i.slug, i.title, i.imageKey);
      const bestTitle = existing?.isCanonicalCardTitle ? existing.title : i.title;
      return {
        ...i,
        title: bestTitle || i.title,
        amount: existing?.amount || i.amount || '',
        imageKey: i.imageKey || existing?.imageKey || null
      };
    });

  const calcTotal = Math.round(cleanItems.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.qty) || 1), 0));
  const totalUnits = cleanItems.reduce((sum, i) => sum + (Number(i.qty) || 1), 0);
  const finalTotal = totalPrice > 0 ? Math.round(totalPrice) : calcTotal;
  const nowIso = new Date().toISOString();

  const snapshot = {
    accountId: acc,
    items: cleanItems,
    totalUnits,
    totalPrice: finalTotal,
    updatedAt: nowIso
  };

  const state = await getSavedCartsState();
  state.latest = snapshot;
  state.byAccount = state.byAccount || {};
  state.byAccount[acc] = snapshot;

  await new Promise((resolve) => {
    chrome.storage.local.set({ [SAVED_CARTS_KEY]: state }, resolve);
  });

  await recordPricesBatch(
    acc,
    cleanItems.map((i) => ({
      slug: i.slug,
      title: i.title,
      isCanonicalCardTitle: false, // из корзины не перезаписываем эталонный заголовок карточки!
      imageKey: i.imageKey || null,
      price: i.price,
      oldPrice: i.oldPrice,
      amount: i.amount
    }))
  );

  const backendUrl = (settings.backendUrl || '').replace(/\/$/, '');
  if (backendUrl && Date.now() > (getBgDeps().getBackendOfflineUntilTs?.() || 0)) {
    try {
      await fetchWithTimeout(
        `${backendUrl}/api/cart/save`,
        {
          method: 'POST',
          headers: await getBgDeps().getBackendAuthHeaders(backendUrl, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            accountId: acc,
            items: cleanItems,
            totalPrice: finalTotal
          })
        },
        1800
      );
    } catch {
      getBgDeps().setBackendOfflineUntilTs?.(Date.now() + 10000);
    }
  }

  return snapshot;
}

async function compareSavedCartOnCurrentAccount(targetAccountId) {
  const stopKeepAlive = getBgDeps().startSwKeepAlive ? getBgDeps().startSwKeepAlive() : () => {};
  try {
    const settings = await getSettings();
    const currentAcc = targetAccountId || settings.lavkaAccountLabel || 'Текущий аккаунт';
    const cartsState = await getSavedCartsState();
    const latest = cartsState.latest;

    if (!latest || !Array.isArray(latest.items) || latest.items.length === 0) {
      return {
        ok: false,
        error: 'Слепок корзины пока пуст! Добавь товары в корзину Лавки или нажми «📸 Снять слепок корзины».'
      };
    }

    const priceDb = await getLocalPriceDb();
    const comparedItems = [];
    let sourceTotal = 0;
    let currentTotal = 0;
    const batchToRecord = [];

    for (const item of latest.items) {
      const slug = String(item.slug || '').trim().toLowerCase();
      const qty = Number(item.qty) || 1;
      const sourcePrice = Number(item.price) || 0;
      const existingEntry = findPriceEntryInDb(priceDb, slug, item.title, item.imageKey);

      let currentPrice = null;
      let cardTitle = existingEntry?.isCanonicalCardTitle ? existingEntry.title : (item.title || slug);
      let isCanonical = Boolean(existingEntry?.isCanonicalCardTitle);

      try {
        const url = `https://lavka.yandex.ru/good/${encodeURIComponent(slug)}`;
        const resp = await fetchWithTimeout(url, { method: 'GET', credentials: 'include', cache: 'no-store' }, 3800);
        if (resp.ok) {
          const html = await resp.text();
          const parsed = parseFullProductCardFromLavkaHtml(html);
          if (parsed) {
            if (parsed.price > 0) currentPrice = parsed.price;
            if (parsed.cardTitle) {
              cardTitle = buildFullProductSearchQuery(parsed.cardTitle, parsed.cardBrand || '', parsed.cardAmount || item.amount || '');
              isCanonical = true;
            }
          }
        }
      } catch {
        // fallback to priceDb
      }

      if (!currentPrice) {
        currentPrice = existingEntry?.accounts?.[currentAcc]?.price || sourcePrice;
      }

      const effCurrent = currentPrice || sourcePrice;

      sourceTotal += sourcePrice * qty;
      currentTotal += effCurrent * qty;

      if (currentPrice) {
        batchToRecord.push({
          slug,
          title: cardTitle,
          isCanonicalCardTitle: isCanonical,
          imageKey: item.imageKey || existingEntry?.imageKey || null,
          price: currentPrice,
          amount: item.amount || existingEntry?.amount || ''
        });
      }

      comparedItems.push({
        slug,
        title: cardTitle,
        qty,
        sourcePrice,
        currentPrice: effCurrent,
        diffPerUnit: effCurrent - sourcePrice,
        diffTotal: (effCurrent - sourcePrice) * qty,
        accounts: existingEntry?.accounts || {}
      });
    }

    if (batchToRecord.length > 0) {
      await recordPricesBatch(currentAcc, batchToRecord);
    }

    return {
      ok: true,
      sourceAccount: latest.accountId || 'Аккаунт #1',
      currentAccount: currentAcc,
      sourceTotal: Math.round(sourceTotal),
      currentTotal: Math.round(currentTotal),
      diffTotal: Math.round(currentTotal - sourceTotal),
      items: comparedItems,
      updatedAt: new Date().toISOString()
    };
  } finally {
    stopKeepAlive();
  }
}

async function waitForTabCompleteSafe(tabId, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;

    const cleanup = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };

    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        cleanup();
        setTimeout(resolve, 650);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
  });
}

async function addSingleItemOnTab(tabId, item) {
  const desiredQty = Math.max(1, Math.min(30, Number(item.qty) || 1));
  const targetSlug = String(item.slug || '').trim().toLowerCase();
  const targetUrl = `https://lavka.yandex.ru/good/${encodeURIComponent(targetSlug)}`;

  await chrome.tabs.update(tabId, { url: targetUrl });
  await waitForTabCompleteSafe(tabId, 6500);

  try {
    const execRes = await chrome.scripting.executeScript({
      target: { tabId },
      args: [targetSlug, desiredQty],
      func: async (expectedSlug, qtyToSet) => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        window.__lqsAutoBuilding = true;

        try {
          let mainScope = null;
          for (let tick = 0; tick < 26; tick++) {
            const pathNow = decodeURIComponent(window.location.pathname || '').toLowerCase();
            const mainEl = document.querySelector('main[data-testid="good-page-desktop"]') || document.querySelector('main');
            const titleEl = document.querySelector('h1[data-testid="product-title"]') || (mainEl && mainEl.querySelector('h1'));
            if (mainEl && titleEl && (!expectedSlug || pathNow.includes(expectedSlug.slice(0, 16)))) {
              mainScope =
                mainEl.querySelector('div[data-testid="product-info"]') ||
                mainEl.querySelector('div[data-testid="product-card-header"]') ||
                mainEl;
              break;
            }
            await wait(250);
          }

          if (!mainScope) {
            return { ok: false, addedUnits: 0, reason: 'Не удалось дождаться загрузки страницы товара' };
          }

          const barScope = mainScope.querySelector('div[data-testid="bar-container"]') || mainScope;

          const readCurrentQtyInStepper = () => {
            const containers = [barScope, mainScope];
            for (const root of containers) {
              if (!root) continue;
              const candidates = root.querySelectorAll('span, div, input');
              for (const el of candidates) {
                if (el.closest('.lqs-product-panel') || el.closest('div[data-testid="product-card"]')) continue;
                const txt = (el.tagName === 'INPUT' ? el.value : el.textContent || '').trim();
                if (/^\d{1,2}$/.test(txt)) {
                  const parent = el.parentElement;
                  const grand = parent ? parent.parentElement : null;
                  const btnsInParent = parent ? parent.querySelectorAll('button').length : 0;
                  const btnsInGrand = grand ? grand.querySelectorAll('button').length : 0;
                  if (btnsInParent >= 2 || btnsInGrand >= 2) {
                    const n = parseInt(txt, 10);
                    if (n >= 1 && n <= 50) return { qty: n, stepperRoot: btnsInParent >= 2 ? parent : grand };
                  }
                }
              }
            }
            return { qty: 0, stepperRoot: null };
          };

          const findMainAddButton = () => {
            const selectors = [
              'button[data-testid="snippet-control"]',
              'button[data-testid*="add"]',
              'button[aria-label*="В корзину"]'
            ];
            for (const sel of selectors) {
              const btn = barScope.querySelector(sel) || mainScope.querySelector(sel);
              if (btn && !btn.closest('div[data-testid="product-card"]') && !btn.closest('.lqs-product-panel')) {
                return btn;
              }
            }
            const allBtns = Array.from(barScope.querySelectorAll('button')).concat(
              Array.from(mainScope.querySelectorAll('button'))
            );
            for (const b of allBtns) {
              if (b.closest('div[data-testid="product-card"]') || b.closest('.lqs-product-panel')) continue;
              const t = (b.textContent || '').trim().toLowerCase();
              if (t.includes('в корзину') || t.includes('добавить')) {
                return b;
              }
            }
            return null;
          };

          const findPlusButton = () => {
            const stepperInfo = readCurrentQtyInStepper();
            if (stepperInfo.stepperRoot) {
              const stepperBtns = Array.from(stepperInfo.stepperRoot.querySelectorAll('button')).filter(
                (b) => !b.closest('.lqs-product-panel') && !b.disabled
              );
              if (stepperBtns.length >= 2) {
                return stepperBtns[stepperBtns.length - 1];
              }
            }

            const explicitPlus =
              barScope.querySelector(
                'button[aria-label*="Увеличить"], button[aria-label*="Добавить"], button[aria-label*="Ещё"], button[data-testid*="plus"], button[data-testid*="increment"]'
              ) ||
              mainScope.querySelector(
                'button[aria-label*="Увеличить"], button[aria-label*="Добавить"], button[aria-label*="Ещё"], button[data-testid*="plus"], button[data-testid*="increment"]'
              );
            if (explicitPlus && !explicitPlus.closest('div[data-testid="product-card"]') && !explicitPlus.disabled) {
              return explicitPlus;
            }

            const barBtns = Array.from(barScope.querySelectorAll('button')).filter(
              (b) => !b.closest('.lqs-product-panel') && !b.closest('div[data-testid="product-card"]') && !b.disabled
            );
            for (const b of barBtns) {
              if ((b.textContent || '').trim() === '+') return b;
            }
            if (barBtns.length >= 2) {
              return barBtns[barBtns.length - 1];
            }
            return null;
          };

          const findMinusButton = () => {
            const stepperInfo = readCurrentQtyInStepper();
            if (stepperInfo.stepperRoot) {
              const stepperBtns = Array.from(stepperInfo.stepperRoot.querySelectorAll('button')).filter(
                (b) => !b.closest('.lqs-product-panel') && !b.disabled
              );
              if (stepperBtns.length >= 2) {
                return stepperBtns[0];
              }
            }
            return null;
          };

          let addBtn = null;
          let initialStepper = readCurrentQtyInStepper();
          for (let waitIdx = 0; waitIdx < 16; waitIdx++) {
            initialStepper = readCurrentQtyInStepper();
            if (initialStepper.qty > 0) break;
            addBtn = findMainAddButton();
            if (addBtn && !addBtn.disabled) break;
            await wait(250);
          }

          const pageText = (barScope.innerText || mainScope.innerText || '').toLowerCase();
          if (!addBtn && initialStepper.qty === 0) {
            if (/раскупили|нет в наличии|закончил/i.test(pageText)) {
              return { ok: false, addedUnits: 0, reason: 'Нет в наличии (раскупили на этом складе)' };
            }
            return { ok: false, addedUnits: 0, reason: 'Кнопка «В корзину» не найдена на странице' };
          }

          let currentQty = initialStepper.qty;
          if (currentQty === 0 && addBtn) {
            addBtn.click();
            await wait(450);
            for (let retry = 0; retry < 6; retry++) {
              currentQty = readCurrentQtyInStepper().qty;
              if (currentQty >= 1) break;
              const retryBtn = findMainAddButton();
              if (retryBtn && retry === 2) {
                retryBtn.click();
              }
              await wait(250);
            }
          }

          if (currentQty === 0) {
            return { ok: false, addedUnits: 0, reason: 'Степпер количества не появился после клика' };
          }

          let stockLimitReached = false;
          let stalledClicks = 0;
          let safetyClicks = 0;

          while (currentQty < qtyToSet && safetyClicks < qtyToSet + 4) {
            safetyClicks += 1;
            const plusBtn = findPlusButton();
            if (!plusBtn) {
              stockLimitReached = true;
              break;
            }
            plusBtn.click();
            await wait(380);
            const afterStep = readCurrentQtyInStepper().qty;
            if (afterStep > currentQty) {
              currentQty = afterStep;
              stalledClicks = 0;
            } else {
              stalledClicks += 1;
              if (stalledClicks >= 2) {
                stockLimitReached = true;
                break;
              }
            }
          }

          let safetyMinus = 0;
          while (currentQty > qtyToSet && safetyMinus < 20) {
            safetyMinus += 1;
            const minusBtn = findMinusButton();
            if (!minusBtn) break;
            minusBtn.click();
            await wait(320);
            const afterMinus = readCurrentQtyInStepper().qty;
            if (afterMinus > 0 && afterMinus < currentQty) {
              currentQty = afterMinus;
            } else {
              break;
            }
          }

          const priceEl = document.querySelector('span[data-testid="price-text"]');
          const priceVal = priceEl ? parseFloat(priceEl.textContent.replace(/[^\d.,]/g, '').replace(',', '.')) : null;
          return {
            ok: currentQty >= 1,
            addedUnits: currentQty,
            requestedUnits: qtyToSet,
            stockLimitReached,
            reason: stockLimitReached && currentQty < qtyToSet ? `Остаток на складе: ${currentQty} из ${qtyToSet} шт.` : '',
            price: priceVal
          };
        } finally {
          window.__lqsAutoBuilding = false;
        }
      }
    });

    const r = execRes && execRes[0] ? execRes[0].result : null;
    if (r && r.ok) {
      return {
        slug: item.slug,
        title: item.title,
        qty: desiredQty,
        addedUnits: r.addedUnits || 0,
        stockLimitReached: Boolean(r.stockLimitReached),
        reason: r.reason || '',
        ok: true,
        price: r.price
      };
    }
    return {
      slug: item.slug,
      title: item.title,
      qty: desiredQty,
      addedUnits: r?.addedUnits || 0,
      ok: false,
      reason: r?.reason || 'Не удалось нажать кнопку'
    };
  } catch (err) {
    return {
      slug: item.slug,
      title: item.title,
      qty: desiredQty,
      addedUnits: 0,
      ok: false,
      reason: err.message || String(err)
    };
  }
}

async function autoBuildCartInBrowser(customItems = null) {
  const stopKeepAlive = getBgDeps().startSwKeepAlive ? getBgDeps().startSwKeepAlive() : () => {};
  try {
    const cartsState = await getSavedCartsState();
    const items = Array.isArray(customItems) && customItems.length > 0
      ? customItems
      : (cartsState.latest && Array.isArray(cartsState.latest.items) ? cartsState.latest.items : []);

    if (items.length === 0) {
      return {
        ok: false,
        error: 'Нет сохранённых товаров в слепке корзины! Сначала собери корзину на первом аккаунте.'
      };
    }

    const lavkaTabs = await chrome.tabs.query({ url: ['https://lavka.yandex.ru/*'] });
    let targetTab = lavkaTabs && lavkaTabs.length > 0 ? lavkaTabs[0] : null;
    if (!targetTab) {
      targetTab = await chrome.tabs.create({ url: 'https://lavka.yandex.ru/', active: true });
      await waitForTabCompleteSafe(targetTab.id, 5000);
    } else {
      await chrome.tabs.update(targetTab.id, { active: true });
    }

    const resultsLog = [];
    const failedItemsForRetry = [];

    for (const item of items) {
      if (!item || !item.slug) continue;
      const res = await addSingleItemOnTab(targetTab.id, item);
      if ((!res.ok || res.addedUnits < res.qty) && !res.stockLimitReached) {
        failedItemsForRetry.push({ item, firstResult: res });
      } else {
        resultsLog.push(res);
      }
    }

    for (const { item, firstResult } of failedItemsForRetry) {
      if (firstResult.reason && firstResult.reason.includes('раскупили')) {
        resultsLog.push(firstResult);
        continue;
      }
      const retryRes = await addSingleItemOnTab(targetTab.id, item);
      resultsLog.push(retryRes);
    }

    await chrome.tabs.update(targetTab.id, { url: 'https://lavka.yandex.ru/cart' });

    const addedCount = resultsLog.filter((r) => r.ok).length;
    const totalRequestedUnits = items.reduce((s, i) => s + (Math.max(1, Number(i.qty) || 1)), 0);
    const totalAddedUnits = resultsLog.reduce((s, r) => s + (Number(r.addedUnits) || 0), 0);

    return {
      ok: true,
      addedCount,
      totalRequested: items.length,
      totalAddedUnits,
      totalRequestedUnits,
      results: resultsLog
    };
  } finally {
    stopKeepAlive();
  }
}

  const api = {
    getSavedCartsState,
    saveCartSnapshot,
    compareSavedCartOnCurrentAccount,
    waitForTabCompleteSafe,
    addSingleItemOnTab,
    autoBuildCartInBrowser
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_CART_SYNC = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
