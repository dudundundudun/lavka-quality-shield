/**
 * Lavka Quality Shield — Cart Snapshot & Competitor Audit Banner (content/cart-audit.js)
 * Captures Lavka cart snapshots, detects cart price tampering, and renders the audit banner.
 */
(function (root) {
  'use strict';

  const { VERSION, STORAGE_KEYS } = root.LQS_CONFIG;
  const CART_LOCKS_KEY = STORAGE_KEYS.CART_LOCKS;
  const {
    escapeHtml,
    safeHttpUrl,
    buildFullProductSearchQuery,
    buildDirectStoreSearchLinks
  } = root.LQS_UTILS;

  function createCartAudit(deps) {
    let lastCartAuditSignature = '';
    let lastCartCompetitorAudit = null;
    let isCartAuditLoading = false;
    let isCartCompDropdownOpen = false;
    let isCartAccDropdownOpen = false;
    let cachedAccountsVault = null;

    function lockProductPriceOnCartAdd(btnEl) {
      try {
        const card = btnEl.closest('div[data-testid="product-card"]');
        const mainPage = btnEl.closest('main[data-testid="good-page-desktop"]');
        let slug = null;
        let title = '';
        let price = null;
        let amount = '';
        let imageKey = null;

        if (mainPage) {
          slug = deps.extractSlugFromUrl(window.location.href);
          const meta = deps.extractProductPageMetadata();
          title = buildFullProductSearchQuery(meta.title, meta.brand, meta.amountText);
          price = meta.price;
          amount = meta.amountText;
          imageKey = meta.imageKey;
        } else if (card) {
          const link = card.querySelector('a[href*="/good/"]') || card.closest('a[href*="/good/"]');
          slug = link ? deps.extractSlugFromUrl(link.getAttribute('href')) : null;
          const img = card.querySelector('img');
          imageKey = img ? deps.extractImageKey(img.getAttribute('src')) : null;
          const rawT = (img && img.getAttribute('alt')) || (card.innerText || '').split('\n')[0] || slug;
          const pInfo = deps.extractPriceFromCardDOM(card);
          price = pInfo.price;
          amount = pInfo.amount;
          title = buildFullProductSearchQuery(rawT, '', amount);
        }

        if (slug && price && price > 0) {
          const cartLocksMemory = deps.getCartLocksMemory();
          cartLocksMemory[slug] = {
            slug,
            title,
            cleanTitle: deps.normalizeTitle(title),
            imageKey,
            lockedPrice: price,
            amount,
            accountId: deps.detectCurrentAccountLabel(),
            lockedAt: new Date().toISOString()
          };
          chrome.storage.local.set({ [CART_LOCKS_KEY]: cartLocksMemory });
          deps.recorder.record('CART_LOCK', `Locked price for ${slug}: ${price} ₽`);
        }
      } catch {
        // ignore
      }
    }

    function findCartRowContainerForLink(linkEl) {
      let curr = linkEl;
      let bestRow = linkEl.parentElement;

      for (let depth = 0; depth < 7 && curr && curr.parentElement; depth++) {
        const parent = curr.parentElement;
        if (parent.tagName === 'MAIN' || parent.tagName === 'BODY') break;
        if (parent.classList && parent.classList.contains('lqs-cart-audit-banner')) return null;

        const linksInside = parent.querySelectorAll('a[href*="/good/"]');
        const slugsInside = new Set();
        linksInside.forEach((a) => {
          const s = deps.extractSlugFromUrl(a.getAttribute('href'));
          if (s) slugsInside.add(s);
        });

        if (slugsInside.size > 1) {
          return curr;
        }

        bestRow = parent;
        curr = parent;
      }

      return bestRow;
    }

    /**
     * Извлекает позиции корзины и сразу подменяет сокращённое название из корзины
     * на ПОЛНОЕ название из оригинальной карточки товара (по `slug` или `imageKey`)!
     */
    function extractCartItemsFromDOM() {
      const items = [];
      const seen = new Set();

      const allGoodLinks = document.querySelectorAll('a[href*="/good/"]');

      allGoodLinks.forEach((linkEl) => {
        if (linkEl.closest('.lqs-cart-audit-banner, .lqs-product-panel')) return;
        if (linkEl.closest('div[data-testid="product-card"]')) return;

        const inCartRegion =
          window.location.pathname.includes('/cart') ||
          Boolean(linkEl.closest('[data-testid*="cart"], aside, [role="dialog"]'));
        if (!inCartRegion) return;

        const slug = deps.extractSlugFromUrl(linkEl.getAttribute('href'));
        if (!slug || seen.has(slug)) return;

        const container = findCartRowContainerForLink(linkEl);
        if (!container) return;

        const textAll = (container.innerText || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
        const priceMatches = Array.from(textAll.matchAll(/(\d[\d\s]*)\s*₽/g)).map((m) =>
          parseFloat(m[1].replace(/\s/g, ''))
        );
        if (priceMatches.length === 0) return;

        seen.add(slug);

        const imgEl = container.querySelector('img');
        const imageKey = imgEl ? deps.extractImageKey(imgEl.getAttribute('src')) : null;

        let rawCartTitle = '';
        const rowLinks = container.querySelectorAll('a[href*="/good/"]');
        rowLinks.forEach((a) => {
          const t = (a.textContent || '').replace(/[\u00ad\u200b]/g, '').trim();
          if (t && t.length > rawCartTitle.length) rawCartTitle = t;
        });
        if (!rawCartTitle && imgEl) {
          rawCartTitle = (imgEl.getAttribute('alt') || '').trim();
        }
        if (!rawCartTitle) {
          const lines = (container.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
          rawCartTitle = lines[0] || slug;
        }

        let qty = 1;
        let foundStepperQty = false;

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

        const weightMatch = textAll.match(/(\d+(?:[.,]\d+)?\s*(?:г|гр|кг|мл|л|шт)(?![а-яa-z]))/i);
        const amount = weightMatch ? weightMatch[1].trim() : '';

        // Заменяем сокращённое название из корзины («Напиток Cola Добрый») на полное название из карточки товара!
        const authoritativeTitle = deps.resolveBestKnownCanonicalTitle(slug, rawCartTitle, amount, imageKey);

        const rawFirstPrice = priceMatches[0];
        const rawOldPrice = priceMatches.length > 1 && priceMatches[1] > rawFirstPrice ? priceMatches[1] : null;

        let unitPrice = rawFirstPrice;
        let unitOldPrice = rawOldPrice;

        if (qty > 1) {
          const knownLock = deps.findCartLockInMemory(slug, authoritativeTitle, imageKey);
          const knownDb = deps.findPriceIntelInMemory(slug, authoritativeTitle, imageKey);
          const refUnitPrice = (knownLock && knownLock.lockedPrice) || (knownDb && knownDb.lastPrice) || null;

          if (refUnitPrice && Math.abs(rawFirstPrice - refUnitPrice * qty) <= Math.max(6, qty * 3)) {
            unitPrice = Math.round(rawFirstPrice / qty);
            if (rawOldPrice) unitOldPrice = Math.round(rawOldPrice / qty);
          } else if (!refUnitPrice && !/за\s*1\s*шт|₽\s*\/\s*шт/i.test(textAll) && rawFirstPrice % qty === 0) {
            unitPrice = Math.round(rawFirstPrice / qty);
            if (rawOldPrice) unitOldPrice = Math.round(rawOldPrice / qty);
          }
        }

        items.push({
          slug,
          title: authoritativeTitle.slice(0, 140),
          imageKey,
          qty,
          price: unitPrice,
          oldPrice: unitOldPrice,
          amount
        });
      });

      const totalPrice = Math.round(items.reduce((acc, i) => acc + i.price * i.qty, 0));
      const totalUnits = items.reduce((acc, i) => acc + (Number(i.qty) || 1), 0);
      return { items, totalUnits, totalPrice };
    }

    function triggerCartCompetitorAudit(snap, forceNetwork = false) {
      if (!snap || !Array.isArray(snap.items) || snap.items.length === 0) return;
      const sig = snap.items.map((i) => `${i.slug}:${i.qty}:${i.price}`).join('|') + `|${deps.detectCurrentAccountLabel()}`;
      if (!forceNetwork && sig === lastCartAuditSignature && (lastCartCompetitorAudit || isCartAuditLoading)) {
        return;
      }

      lastCartAuditSignature = sig;
      isCartAuditLoading = true;
      renderCartAuditBanner(snap);

      chrome.runtime.sendMessage(
        {
          type: 'LQS_AUDIT_CART_COMPETITORS',
          accountId: deps.detectCurrentAccountLabel(),
          items: snap.items,
          forceNetworkSearch: Boolean(forceNetwork)
        },
        (resp) => {
          isCartAuditLoading = false;
          if (!chrome.runtime.lastError && resp && resp.ok) {
            lastCartCompetitorAudit = resp;
            deps.recorder.updateModule(
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
          accountId: deps.detectCurrentAccountLabel(),
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
        const lock = deps.findCartLockInMemory(it.slug, it.title, it.imageKey);
        if (lock && lock.lockedPrice && it.price > lock.lockedPrice) {
          tampered.push({
            title: lock.title || it.title,
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

      let compPillHtml = '';
      if (isCartAuditLoading && !audit) {
        compPillHtml = `<span class="lqs-cart-pill">⏳ Загружаю полные названия из карточек товаров и сверяю с магазинами...</span>`;
      } else if (overpayComp > 0) {
        compPillHtml = `<span class="lqs-cart-pill overpay-bad">🏪 У конкурентов дешевле (${cheaperCompCount} поз.): переплата +${overpayComp} ₽!</span>`;
      } else if (audit) {
        compPillHtml = `<span class="lqs-cart-pill overpay-good">🏪 Полные названия из карточек товаров проверены (${snap.items.length} поз.)</span>`;
      }

      let altAccPillHtml = '';
      if (overpayAlt > 0) {
        altAccPillHtml = `<span class="lqs-cart-pill overpay-warn">🕵️ Без куки / на др. акке дешевле на -${overpayAlt} ₽!</span>`;
      }

      const auditItems = (audit && Array.isArray(audit.items) && audit.items.length > 0)
        ? audit.items
        : snap.items.map((i) => ({
            ...i,
            rowTotal: Math.round(i.price * i.qty),
            competitorOffers: [],
            storeSearchLinks: buildDirectStoreSearchLinks(i.title, i.amount)
          }));

      const compDropdownRowsHtml = auditItems
        .map((it) => {
          const compBadge =
            it.overpayVsCompetitorTotal > 0
              ? `<span class="lqs-cart-pill overpay-bad">Переплата +${it.overpayVsCompetitorTotal} ₽ (в сетях от ~${it.competitorMinPrice} ₽/шт)</span>`
              : it.competitorMinPrice
              ? `<span class="lqs-cart-pill overpay-good">В сетях от ~${it.competitorMinPrice} ₽/шт (в Лавке ок)</span>`
              : `<span class="lqs-cart-pill">Поиск по полному названию из карточки 👇</span>`;

          const altBadge =
            it.overpayVsAltTotal > 0
              ? `<span class="lqs-cart-pill overpay-warn">🕵️ ${escapeHtml(it.bestAltLabel || 'Без куки')}: ${it.bestAltPrice} ₽/шт (переплата +${it.overpayVsAltTotal} ₽)</span>`
              : '';

          const foundOffersHtml = Array.isArray(it.competitorOffers)
            ? it.competitorOffers
                .filter((o) => o && safeHttpUrl(o.url))
                .map((o) => {
                  const isCheaper = o.price && o.price < it.price - 2;
                  const priceTag = o.price ? `: ~${o.price} ₽` : '';
                  return `<a href="${escapeHtml(safeHttpUrl(o.url))}" target="_blank" rel="noopener noreferrer" class="lqs-store-link ${isCheaper ? 'is-cheaper' : ''}" title="${escapeHtml(o.title || o.store)}">🏪 ${escapeHtml(o.store)}${priceTag} ↗</a>`;
                })
                .join('')
            : '';

          const linksList = Array.isArray(it.storeSearchLinks) && it.storeSearchLinks.length > 0
            ? it.storeSearchLinks
            : buildDirectStoreSearchLinks(it.title, it.amount, it.brand || '');

          const searchLinksHtml = linksList
            .map(
              (s) =>
                `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" class="lqs-store-link is-search" title="Найти «${escapeHtml(s.query || it.title)}» в магазине ${escapeHtml(s.store)}">🔍 ${escapeHtml(s.store)} ↗</a>`
            )
            .join('');

          return `
            <div class="lqs-cart-comp-item">
              <div class="lqs-cart-comp-top">
                <div>
                  <a href="https://lavka.yandex.ru/good/${encodeURIComponent(it.slug)}" target="_blank" rel="noopener noreferrer" class="lqs-cart-comp-title" title="Полное название из оригинальной карточки товара">
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

      const accountsList = cachedAccountsVault && Array.isArray(cachedAccountsVault.accounts)
        ? cachedAccountsVault.accounts
        : [];
      const activeAccLabel = deps.detectCurrentAccountLabel();

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

        <div class="lqs-cart-dropdown ${isCartCompDropdownOpen ? 'open' : ''}" id="lqs-cart-comp-dropdown">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
            <span style="font-weight:700;font-size:12px;color:#334155;">
              🏪 Полные названия взяты напрямую из карточек товаров (с учётом «без сахара», вкуса и объёма):
            </span>
            <button type="button" class="lqs-mini-btn" id="lqs-cart-rescan-comp-btn">
              🔄 Обновить цены конкурентов
            </button>
          </div>
          ${compDropdownRowsHtml}
        </div>

        <div class="lqs-cart-dropdown ${isCartAccDropdownOpen ? 'open' : ''}" id="lqs-cart-acc-dropdown">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
            <span style="font-weight:700;font-size:12px;color:#334155;">
              🔐 Быстрое переключение аккаунтов Яндекс Лавки (сессия куки сохраняется автоматически):
            </span>
            <button type="button" class="lqs-mini-btn" id="lqs-cart-save-cur-cookies-btn">
              💾 Запомнить куки текущего входа (${escapeHtml(activeAccLabel)})
            </button>
          </div>
          ${accDropdownRowsHtml || '<div style="font-size:12px;color:#64748b;">Открой вкладку «🔐 Акки и Корзина» в окне расширения, чтобы настроить профили.</div>'}
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
          rescanBtn.textContent = '⏳ Проверяю карточки и сети...';
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
              const lock = deps.findCartLockInMemory(it.slug, it.title, it.imageKey);
              const lockNote = lock ? ` | Обещанная цена на витрине: ${lock.lockedPrice} ₽` : '';
              const compNote = it.competitorMinPrice ? ` | В других сетях от ~${it.competitorMinPrice} ₽ (переплата +${it.overpayVsCompetitorTotal || 0} ₽)` : '';
              return `${idx + 1}. ${it.title} [${it.slug}] — ${it.qty} шт. × ${it.price} ₽ = ${it.qty * it.price} ₽${lockNote}${compNote}`;
            }),
            ``,
            `ИТОГО ПО КАЛЬКУЛЯТОРУ: ${snap.totalPrice} ₽ (всего единиц товара: ${totalUnits} шт.)`,
            `СУММАРНАЯ ПЕРЕПЛАТА ОТНОСИТЕЛЬНО КОНКУРЕНТОВ: +${overpayComp} ₽`,
            `СУММАРНАЯ ПЕРЕПЛАТА ОТНОСИТЕЛЬНО ДРУГОГО АККАУНТА / МИН. В БД: +${overpayAlt} ₽`
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

    return {
      lockProductPriceOnCartAdd,
      findCartRowContainerForLink,
      extractCartItemsFromDOM,
      triggerCartCompetitorAudit,
      scanAndSnapshotCurrentCartDOM,
      renderCartAuditBanner
    };
  }

  const api = {
    createCartAudit
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_CART_AUDIT = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
