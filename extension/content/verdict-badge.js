/**
 * Lavka Quality Shield — AI Verdict Badge Parser (content/verdict-badge.js)
 * Вынесено из content.js (Этап 4: модульная декомпозиция).
 */
(function (root) {
  'use strict';

  function extractWarnReasonFromVerdict(cleanText) {
    const clean = String(cleanText || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';

    const normalizeReason = (raw) => {
      let r = String(raw || '')
        .replace(/^[«"'<(\[\s]+|[»"'>)\]\s.,;:—–-]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!r || /^есть\s+компромисс/i.test(r)) return '';
      const maxLen = 28;
      if (r.length > maxLen) {
        const cut = r.slice(0, maxLen);
        const lastSpace = cut.lastIndexOf(' ');
        r = (lastSpace >= 12 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:—–-]+$/, '') + '…';
      }
      return r;
    };

    const explicitMatch = clean.match(/(?:С оговорками|На любителя)\s*[:—–-]\s*([^\n.!?;(—–]+)/i);
    if (explicitMatch && explicitMatch[1]) {
      const parsed = normalizeReason(explicitMatch[1]);
      if (parsed) return parsed;
    }

    const lower = clean.toLowerCase();
    if (/пальмов|змж|заменител\w*\s+молочн/.test(lower)) return 'пальмовое масло / ЗМЖ';
    if (/ммо|механическ\w*\s+обвалк/.test(lower)) return 'ММО в составе';
    if (/много\s+сахар|избыт\w*\s+сахар|слишком\s+сладк|приторн/.test(lower)) return 'много сахара';
    if (/подсластител|сахарозаменител|аспартам|сукралоз/.test(lower)) return 'подсластители';
    if (/дорог|завышен\w*\s+цен|переплат|наценк|цена\s+высок/.test(lower)) return 'завышена цена';
    if (/крахмал|консервант|усилител|красител|добавк|е\d{3}/.test(lower)) return 'спорный состав';
    if (/вкус|водянист|сух|жирн|сол[её]н/.test(lower)) return 'спорный вкус';
    if (/на любителя|компромисс/.test(lower)) return 'состав или цена';
    return '';
  }

  function extractVerdictBadgeFromText(verdictText) {
    if (!verdictText) return null;
    const t = String(verdictText);
    const fullTitle = t.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (t.includes('Отличный выбор') || t.includes('✅')) {
      return { cls: 'verdict-good', text: '🤖 ✅ Стоит брать', shortCatalog: '🤖✅', title: fullTitle };
    }
    if (t.includes('Хороший вариант') || t.includes('👍')) {
      return { cls: 'verdict-ok', text: '🤖 👍 Хороший', shortCatalog: '🤖👍', title: fullTitle };
    }
    if (t.includes('Не рекомендую') || t.includes('❌')) {
      return { cls: 'verdict-bad', text: '🤖 ❌ Не брать', shortCatalog: '🤖❌', title: fullTitle };
    }
    if (t.includes('С оговорками') || t.includes('На любителя') || t.includes('⚠️')) {
      const reason = extractWarnReasonFromVerdict(fullTitle);
      const badgeText = reason ? `🤖 ⚠️ С оговорками: ${reason}` : '🤖 ⚠️ С оговорками';
      return { cls: 'verdict-warn', text: badgeText, shortCatalog: '🤖⚠️', title: fullTitle };
    }
    return { cls: 'verdict-ok', text: '🤖 ИИ-вердикт готов', shortCatalog: '🤖', title: fullTitle };
  }

  const api = {
    extractWarnReasonFromVerdict,
    extractVerdictBadgeFromText
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LQS_VERDICT_BADGE = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
