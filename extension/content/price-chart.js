/**
 * Lavka Quality Shield — Price History Chart Widget (Alitools-style SVG + Watchlist)
 * Supports both embedded mode (default) and standalone native Popover API window mode.
 * Zero external dependencies, MV3 CSP compliant (no inline event handlers).
 */
(function (root) {
  'use strict';

  const MONTHS_RU = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

  function esc(str) {
    if (root.LQS_UTILS && typeof root.LQS_UTILS.escapeHtml === 'function') {
      return root.LQS_UTILS.escapeHtml(str);
    }
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatRub(val) {
    const num = Number(val);
    if (!Number.isFinite(num) || num <= 0) return '—';
    return Number.isInteger(num) ? `${num} ₽` : `${num.toFixed(2).replace(/\.00$/, '')} ₽`;
  }

  function formatDateRu(isoStr, includeTime = false) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return String(isoStr).slice(0, 10);
    const day = d.getDate();
    const mon = MONTHS_RU[d.getMonth()] || '';
    if (!includeTime) return `${day} ${mon}`;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${day} ${mon}, ${hh}:${mm}`;
  }

  function filterPointsByDays(points, days, nowMs = Date.now()) {
    const list = Array.isArray(points) ? points : [];
    const d = Number(days) || 0;
    if (d <= 0) return list.slice();
    const cutoff = nowMs - d * 24 * 60 * 60 * 1000;
    return list.filter((p) => {
      if (!p || !p.ts) return true;
      const t = Date.parse(p.ts);
      return Number.isNaN(t) || t >= cutoff;
    });
  }

  function aggregateDailyAverages(points) {
    const buckets = new Map();
    for (const pt of Array.isArray(points) ? points : []) {
      if (!pt || !(Number(pt.price) > 0)) continue;
      const dayKey = String(pt.ts || '').slice(0, 10);
      if (!dayKey) continue;
      if (!buckets.has(dayKey)) buckets.set(dayKey, []);
      buckets.get(dayKey).push(Number(pt.price));
    }
    const keys = Array.from(buckets.keys()).sort();
    return keys.map((dayKey) => {
      const vals = buckets.get(dayKey);
      const sum = vals.reduce((a, b) => a + b, 0);
      return {
        date: dayKey,
        ts: `${dayKey}T12:00:00.000Z`,
        price: Math.round((sum / vals.length) * 100) / 100,
        minPrice: Math.round(Math.min(...vals) * 100) / 100,
        maxPrice: Math.round(Math.max(...vals) * 100) / 100,
        count: vals.length,
        accountId: vals.length > 1 ? `Средняя (${vals.length} зам.)` : 'Средняя за день'
      };
    });
  }

  function buildAxisTicks(sortedPoints, padLeft, plotW) {
    if (!sortedPoints || sortedPoints.length === 0) return [];
    if (sortedPoints.length === 1) {
      return [{ x: padLeft + plotW / 2, label: formatDateRu(sortedPoints[0].ts, false) }];
    }
    const firstTs = Date.parse(sortedPoints[0].ts);
    const lastTs = Date.parse(sortedPoints[sortedPoints.length - 1].ts);
    const spanDays = Number.isFinite(firstTs) && Number.isFinite(lastTs)
      ? Math.max(0, (lastTs - firstTs) / (24 * 60 * 60 * 1000))
      : 0;
    const tickCount = Math.min(4, sortedPoints.length);
    const ticks = [];
    for (let i = 0; i < tickCount; i++) {
      const idx = tickCount === 1
        ? 0
        : Math.round((i / (tickCount - 1)) * (sortedPoints.length - 1));
      const pt = sortedPoints[idx];
      const d = new Date(pt.ts);
      let label = formatDateRu(pt.ts, false);
      if (!Number.isNaN(d.getTime()) && spanDays >= 45) {
        label = MONTHS_RU[d.getMonth()] || label;
      }
      const x = padLeft + (sortedPoints.length === 1 ? plotW / 2 : (idx / (sortedPoints.length - 1)) * plotW);
      if (ticks.length === 0 || ticks[ticks.length - 1].label !== label || i === tickCount - 1) {
        ticks.push({ x, label });
      }
    }
    return ticks;
  }

  function buildPriceChartSvg(series, options = {}) {
    const width = options.width || 440;
    const height = options.height || 84;
    const padLeft = 8;
    const padRight = 56;
    const padTop = 10;
    const padBottom = 18;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const valid = (Array.isArray(series) ? series : [])
      .filter((p) => p && Number(p.price) > 0)
      .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));

    if (valid.length === 0) {
      return `
        <div class="lqs-chart-empty">
          Пока нет сохранённых замеров цены за выбранный период. Листайте Лавку или нажмите «Следить за товаром».
        </div>
      `;
    }

    const prices = valid.map((p) => Number(p.price));
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const lastP = prices[prices.length - 1];
    const spread = maxP - minP;
    const yMin = spread > 0 ? minP : Math.max(0, minP * 0.9);
    const yMax = spread > 0 ? maxP : maxP * 1.1;
    const ySpan = Math.max(1, yMax - yMin);

    const xForIndex = (i) => {
      if (valid.length === 1) return padLeft + plotW;
      return padLeft + (i / (valid.length - 1)) * plotW;
    };
    const yForPrice = (p) => padTop + (1 - (p - yMin) / ySpan) * plotH;

    const coords = valid.map((p, i) => ({
      x: Math.round(xForIndex(i) * 10) / 10,
      y: Math.round(yForPrice(Number(p.price)) * 10) / 10,
      raw: p
    }));

    let polylinePoints = '';
    let areaPath = '';
    if (coords.length === 1) {
      const y0 = coords[0].y;
      polylinePoints = `${padLeft},${y0} ${padLeft + plotW},${y0}`;
      areaPath = `M ${padLeft} ${y0} L ${padLeft + plotW} ${y0} L ${padLeft + plotW} ${padTop + plotH} L ${padLeft} ${padTop + plotH} Z`;
    } else {
      polylinePoints = coords.map((c) => `${c.x},${c.y}`).join(' ');
      areaPath = `M ${coords[0].x} ${coords[0].y} ` +
        coords.slice(1).map((c) => `L ${c.x} ${c.y}`).join(' ') +
        ` L ${coords[coords.length - 1].x} ${padTop + plotH} L ${coords[0].x} ${padTop + plotH} Z`;
    }

    const yMaxLine = Math.round(yForPrice(maxP) * 10) / 10;
    const yMinLine = Math.round(yForPrice(minP) * 10) / 10;
    const yLastLine = Math.round(yForPrice(lastP) * 10) / 10;
    const lastCoord = coords[coords.length - 1];
    const ticks = buildAxisTicks(valid, padLeft, plotW);

    const showMaxLabel = spread > 0 && Math.abs(yMaxLine - yLastLine) >= 12;
    const showMinLabel = spread > 0 && Math.abs(yMinLine - yLastLine) >= 12;

    const hitCircles = coords
      .map((c, i) => {
        const dt = formatDateRu(c.raw.ts, !c.raw.date);
        const acc = c.raw.accountId ? String(c.raw.accountId) : '';
        const oldP = c.raw.oldPrice ? String(c.raw.oldPrice) : '';
        return `<circle class="lqs-chart-hit" cx="${c.x}" cy="${c.y}" r="9" data-idx="${i}" data-price="${esc(formatRub(c.raw.price))}" data-date="${esc(dt)}" data-account="${esc(acc)}" data-old="${esc(oldP)}" tabindex="0" role="button" aria-label="${esc(dt)}: ${esc(formatRub(c.raw.price))}"></circle>`;
      })
      .join('');

    return `
      <svg class="lqs-price-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="График истории цены">
        <defs>
          <linearGradient id="lqsPriceAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#fce000" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#fce000" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <line x1="${padLeft}" y1="${yMaxLine}" x2="${padLeft + plotW}" y2="${yMaxLine}" stroke="#eceae6" stroke-width="1"/>
        <line x1="${padLeft}" y1="${yMinLine}" x2="${padLeft + plotW}" y2="${yMinLine}" stroke="#eceae6" stroke-width="1"/>
        <line x1="${padLeft}" y1="${yLastLine}" x2="${padLeft + plotW}" y2="${yLastLine}" stroke="#d6d3cd" stroke-width="1" stroke-dasharray="3 3"/>
        <path d="${areaPath}" fill="url(#lqsPriceAreaGrad)"/>
        <polyline fill="none" stroke="#21201f" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${polylinePoints}"/>
        <circle cx="${lastCoord.x}" cy="${lastCoord.y}" r="4" fill="#21201f" stroke="#fce000" stroke-width="2"/>
        ${showMaxLabel ? `<text x="${padLeft + plotW + 6}" y="${yMaxLine + 4}" class="lqs-svg-axis-label">${esc(formatRub(maxP))}</text>` : ''}
        <text x="${padLeft + plotW + 6}" y="${yLastLine + 4}" class="lqs-svg-axis-current">${esc(formatRub(lastP))}</text>
        ${showMinLabel ? `<text x="${padLeft + plotW + 6}" y="${yMinLine + 4}" class="lqs-svg-axis-label">${esc(formatRub(minP))}</text>` : ''}
        ${ticks.map((t) => `<text x="${Math.round(t.x)}" y="${height - 4}" text-anchor="middle" class="lqs-svg-axis-date">${esc(t.label)}</text>`).join('')}
        ${hitCircles}
      </svg>
    `;
  }

  function buildPriceHistoryCardHtml(data, state = {}) {
    const mode = state.mode === 'avg' ? 'avg' : 'exact';
    const days = Number.isFinite(Number(state.days)) ? Number(state.days) : 90;
    const isPopover = Boolean(state.isPopover);
    const isWatched = Boolean(data && data.isWatched);
    const rawPoints = (data && Array.isArray(data.points)) ? data.points : [];
    const filteredPoints = filterPointsByDays(rawPoints, days);
    const series = mode === 'avg'
      ? (Array.isArray(data?.dailyAvg) && days === Number(data?.days) ? data.dailyAvg : aggregateDailyAverages(filteredPoints))
      : filteredPoints;

    const svgHtml = buildPriceChartSvg(series, isPopover ? { width: 320, height: 104 } : { width: 440, height: 84 });
    const pointCount = filteredPoints.length;
    const stats = data && data.stats ? data.stats : {};
    const hintText = pointCount <= 1
      ? 'Пока 1 замер — график достроится при просмотрах'
      : `Замеров: ${pointCount} • Мин: ${formatRub(stats.minPrice)} • Сред: ${formatRub(stats.avgPrice)} • Макс: ${formatRub(stats.maxPrice)}`;

    return `
      <div class="lqs-ph-card ${isPopover ? 'is-popover' : 'is-inline'}">
        <div class="lqs-ph-header">
          <div class="lqs-ph-title-wrap">
            <span class="lqs-ph-title">История цены</span>
            <select class="lqs-ph-period" aria-label="Период истории цены">
              <option value="7" ${days === 7 ? 'selected' : ''}>7 дн.</option>
              <option value="30" ${days === 30 ? 'selected' : ''}>1 мес.</option>
              <option value="90" ${days === 90 ? 'selected' : ''}>3 мес.</option>
              <option value="0" ${days === 0 ? 'selected' : ''}>всё время</option>
            </select>
            <div class="lqs-ph-tabs" role="tablist" aria-label="Режим графика">
              <button type="button" role="tab" aria-selected="${mode === 'exact' ? 'true' : 'false'}" class="lqs-ph-tab ${mode === 'exact' ? 'is-active' : ''}" data-mode="exact">Точная</button>
              <button type="button" role="tab" aria-selected="${mode === 'avg' ? 'true' : 'false'}" class="lqs-ph-tab ${mode === 'avg' ? 'is-active' : ''}" data-mode="avg">Средняя</button>
            </div>
          </div>
          <div class="lqs-ph-header-actions">
            <span class="lqs-ph-tooltip" role="status" aria-live="polite"></span>
            ${isPopover
              ? '<button type="button" class="lqs-ph-close-btn" aria-label="Закрыть график" title="Закрыть (Esc)">✕</button>'
              : '<button type="button" class="lqs-ph-popout-btn" title="Открыть в отдельном окне">↗</button>'}
          </div>
        </div>

        <div class="lqs-ph-svg-wrap">${svgHtml}</div>

        <div class="lqs-ph-footer">
          <div class="lqs-ph-meta">${esc(hintText)}</div>
          <button type="button" class="lqs-ph-watch-btn ${isWatched ? 'is-watched' : ''}">
            ${isWatched ? '❤️ Слежу за товаром' : '🤍 Следить за товаром'}
          </button>
        </div>
      </div>
    `;
  }

  function mountPriceChartWidget(hostEl, initialData, callbacks = {}) {
    if (!hostEl) return;
    let currentData = initialData || { points: [], dailyAvg: [], stats: {}, isWatched: false, days: 90 };
    const state = {
      mode: callbacks.initialMode || 'exact',
      days: Number.isFinite(Number(callbacks.initialDays)) ? Number(callbacks.initialDays) : 90,
      isPopover: Boolean(callbacks.isPopover)
    };

    function render() {
      hostEl.innerHTML = buildPriceHistoryCardHtml(currentData, state);

      const periodSel = hostEl.querySelector('.lqs-ph-period');
      if (periodSel) {
        periodSel.addEventListener('change', async () => {
          state.days = Number(periodSel.value) || 0;
          if (typeof callbacks.onPeriodChange === 'function') {
            try {
              const fresh = await callbacks.onPeriodChange(state.days);
              if (fresh) currentData = fresh;
            } catch {
              // fallback to client-side filtering of existing points
            }
          }
          render();
        });
      }

      hostEl.querySelectorAll('.lqs-ph-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          const nextMode = btn.getAttribute('data-mode') === 'avg' ? 'avg' : 'exact';
          if (nextMode !== state.mode) {
            state.mode = nextMode;
            render();
          }
        });
      });

      const tooltipEl = hostEl.querySelector('.lqs-ph-tooltip');
      hostEl.querySelectorAll('.lqs-chart-hit').forEach((circle) => {
        const showTip = () => {
          if (!tooltipEl) return;
          const dt = circle.getAttribute('data-date') || '';
          const pr = circle.getAttribute('data-price') || '';
          const acc = circle.getAttribute('data-account') || '';
          tooltipEl.textContent = `${dt}: ${pr}${acc ? ` (${acc})` : ''}`;
        };
        const hideTip = () => {
          if (tooltipEl) tooltipEl.textContent = '';
        };
        circle.addEventListener('mouseenter', showTip);
        circle.addEventListener('focus', showTip);
        circle.addEventListener('mouseleave', hideTip);
        circle.addEventListener('blur', hideTip);
      });

      const watchBtn = hostEl.querySelector('.lqs-ph-watch-btn');
      if (watchBtn && typeof callbacks.onToggleWatch === 'function') {
        watchBtn.addEventListener('click', async () => {
          watchBtn.disabled = true;
          try {
            const res = await callbacks.onToggleWatch(!currentData.isWatched);
            if (res && typeof res.watched === 'boolean') {
              currentData = { ...currentData, isWatched: res.watched };
            }
          } finally {
            watchBtn.disabled = false;
            render();
          }
        });
      }

      const closeBtn = hostEl.querySelector('.lqs-ph-close-btn');
      if (closeBtn && typeof callbacks.onClose === 'function') {
        closeBtn.addEventListener('click', () => callbacks.onClose());
      }

      const popoutBtn = hostEl.querySelector('.lqs-ph-popout-btn');
      if (popoutBtn && typeof callbacks.onPopout === 'function') {
        popoutBtn.addEventListener('click', () => callbacks.onPopout(currentData, state));
      }
    }

    render();

    return {
      update(nextData) {
        if (nextData) {
          currentData = nextData;
          render();
        }
      }
    };
  }

  root.LQS_PRICE_CHART = {
    formatRub,
    formatDateRu,
    filterPointsByDays,
    aggregateDailyAverages,
    buildPriceChartSvg,
    buildPriceHistoryCardHtml,
    mountPriceChartWidget
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
