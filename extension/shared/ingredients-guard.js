/**
 * Lavka Quality Shield — Free Instant Ingredients Traffic Light ("Светофор состава")
 * Zero-cost (<1ms) client-side risk-ingredient analyzer for Yandex Lavka product pages.
 */
(function (root) {
  'use strict';

  const RED_RULES = Object.freeze([
    {
      id: 'zmzh',
      label: 'ЗМЖ (заменитель молочного жира)',
      shortLabel: 'ЗМЖ',
      pattern: /(?:заменител[ьяеи]\s+молочного\s+жира|(?:^|[^а-яёa-z0-9])змж(?=$|[^а-яёa-z0-9])|молокосодержащ[а-яё]*\s+продукт\s+с\s+заменителем)/i
    },
    {
      id: 'palm_oil',
      label: 'Пальмовое / пальмоядровое масло',
      shortLabel: 'пальмовое масло',
      pattern: /(?:пальмов(?:ое|ого|ым|ом|ых)?\s+масл|пальмоядров(?:ое|ого|ым)?\s+масл|олеин\s+пальмов|стеарин\s+пальмов|масла\s+растительные[^.,;]{0,40}пальмов)/i
    },
    {
      id: 'mmo',
      label: 'Мясо механической обвалки (ММО)',
      shortLabel: 'ММО',
      pattern: /(?:мяс[ао]\s+[а-яё\s]{0,20}механическ(?:ой|ого)\s+(?:обвалки|дообвалки)|(?:^|[^а-яёa-z0-9])ммо(?=$|[^а-яёa-z0-9]))/i
    },
    {
      id: 'trans_fat',
      label: 'Гидрогенизированные / трансжиры',
      shortLabel: 'трансжиры',
      pattern: /(?:частично\s+гидрогенизированн|гидрогенизированн[а-яё]*\s+(?:жир|масл)|трансжир|маргарин\s+столов)/i
    },
    {
      id: 'nitrite_benzoate',
      label: 'Жёсткие консерванты (нитрит E250 / бензоат E211)',
      shortLabel: 'E211/E250',
      pattern: /(?:бензоат\s+натрия|\be\s?-?211\b|нитрит\s+натрия|\be\s?-?250\b|нитритно-посолочн)/i
    }
  ]);

  const YELLOW_RULES = Object.freeze([
    {
      id: 'msg',
      label: 'Глутамат натрия / усилитель вкуса (E621)',
      shortLabel: 'глутамат E621',
      pattern: /(?:глутамат\s+натрия|\be\s?-?621\b|усилител[ьяи]\s+вкуса\s+и\s+аромата|инозинат|гуанилат|\be\s?-?627\b|\be\s?-?631\b)/i
    },
    {
      id: 'artificial_sweeteners',
      label: 'Искусственные подсластители (аспартам / ацесульфам / цикламат / сукралоза)',
      shortLabel: 'подсластители',
      pattern: /(?:аспартам|\be\s?-?951\b|ацесульфам|\be\s?-?950\b|цикламат|\be\s?-?952\b|сахарин|\be\s?-?954\b|сукралоз[аы]|\be\s?-?955\b)/i
    },
    {
      id: 'syrup_maltodextrin',
      label: 'Глюкозно-фруктозный сироп / мальтодекстрин',
      shortLabel: 'сироп/мальтодекстрин',
      pattern: /(?:глюкозно-фруктозн|фруктозно-глюкозн|патока\s+крахмальн|мальтодекстрин|кукурузн[а-яё]*\s+сироп)/i
    },
    {
      id: 'modified_starch',
      label: 'Модифицированный крахмал',
      shortLabel: 'модиф. крахмал',
      pattern: /(?:модифицированн[а-яё]*\s+крахмал|\be\s?-?14\d{2}\b)/i
    },
    {
      id: 'preservatives_dyes',
      label: 'Консерванты / синтетические красители / фосфаты',
      shortLabel: 'консерванты/E-добавки',
      pattern: /(?:сорбат\s+калия|\be\s?-?202\b|диоксид\s+серы|\be\s?-?220\b|пирофосфат|трифосфат|полифосфат|\be\s?-?45[0-2]\b|\be\s?-?102\b|\be\s?-?110\b|\be\s?-?122\b|\be\s?-?124\b|\be\s?-?129\b|\be\s?-?133\b)/i
    },
    {
      id: 'soy_protein_filler',
      label: 'Соевый белок / животный белок-наполнитель',
      shortLabel: 'соевый белок',
      pattern: /(?:соев(?:ый|ого|ым)\s+бел(?:ок|ка)|изолят\s+соевого\s+белка|растительная\s+клетчатка|животный\s+белок\s+свиной)/i
    }
  ]);

  const HEALTHY_CLAIM_PATTERN = /(?:без\s+сахара|\bzero\b|(?:^|[^а-яёa-z0-9])пп(?=$|[^а-яёa-z0-9])|фитнес|fitness|протеин|protein|диетическ|полезн|здоровое\s+питание|спорт)/i;
  const HIDDEN_SUGAR_PATTERN = /(?:(?:^|[^а-яёa-z0-9])сахар(?:а|ный|ная|ное)?(?=$|[^а-яёa-z0-9])|сахароза|декстроза|глюкозный\s+сироп|фруктоза|инвертный\s+сироп|концентрированный\s+яблочный\s+сок)/i;

  function analyzeIngredientsTrafficLight(ingredientsText, productTitle = '') {
    const raw = String(ingredientsText || '').replace(/\s+/g, ' ').trim();
    if (!raw || raw.length < 4 || /^не\s+указан/i.test(raw)) {
      return {
        level: 'none',
        emoji: '⚪',
        badgeText: '',
        summary: 'Состав на карточке не указан',
        redFlags: [],
        yellowFlags: [],
        allFlags: []
      };
    }

    const redFlags = [];
    const yellowFlags = [];

    for (const rule of RED_RULES) {
      if (rule.pattern.test(raw)) {
        redFlags.push({ id: rule.id, level: 'red', label: rule.label, shortLabel: rule.shortLabel });
      }
    }

    for (const rule of YELLOW_RULES) {
      if (rule.pattern.test(raw)) {
        yellowFlags.push({ id: rule.id, level: 'yellow', label: rule.label, shortLabel: rule.shortLabel });
      }
    }

    // Проверка скрытого сахара в товарах с маркировкой «без сахара» / «ПП» / «фитнес» / «протеин»
    const titleStr = String(productTitle || '');
    if (HEALTHY_CLAIM_PATTERN.test(titleStr)) {
      const cleanedNoSugarPhrase = raw.replace(/без\s+добавления\s+сахара|без\s+сахара/gi, '');
      if (HIDDEN_SUGAR_PATTERN.test(cleanedNoSugarPhrase)) {
        yellowFlags.push({
          id: 'hidden_sugar_in_fit',
          level: 'yellow',
          label: 'Скрытый сахар / быстрые углеводы в ПП/фитнес-товаре',
          shortLabel: 'скрытый сахар'
        });
      }
    }

    const allFlags = [...redFlags, ...yellowFlags];

    if (redFlags.length > 0) {
      const topShort = redFlags.slice(0, 2).map((f) => f.shortLabel).join(', ');
      const extra = allFlags.length > 2 ? ` +${allFlags.length - 2}` : '';
      return {
        level: 'red',
        emoji: '🔴',
        badgeText: `🔴 ${topShort}${extra}`,
        summary: `Красные флаги состава: ${allFlags.map((f) => f.label).join('; ')}`,
        redFlags,
        yellowFlags,
        allFlags
      };
    }

    if (yellowFlags.length > 0) {
      const topShort = yellowFlags.slice(0, 2).map((f) => f.shortLabel).join(', ');
      const extra = yellowFlags.length > 2 ? ` +${yellowFlags.length - 2}` : '';
      return {
        level: 'yellow',
        emoji: '🟡',
        badgeText: `🟡 ${topShort}${extra}`,
        summary: `Компромиссы в составе: ${yellowFlags.map((f) => f.label).join('; ')}`,
        redFlags,
        yellowFlags,
        allFlags
      };
    }

    return {
      level: 'green',
      emoji: '🟢',
      badgeText: '🟢 Чистый состав',
      summary: 'Светофор состава: красных и жёлтых риск-ингредиентов не найдено (бесплатная проверка).',
      redFlags: [],
      yellowFlags: [],
      allFlags: []
    };
  }

  root.LQS_INGREDIENTS_GUARD = Object.freeze({
    RED_RULES,
    YELLOW_RULES,
    analyzeIngredientsTrafficLight
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
