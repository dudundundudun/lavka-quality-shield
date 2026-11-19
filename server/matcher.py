"""
Lavka Quality Shield — Exact Product & Modifier Matcher
Matches products across retailers strictly by sugar-free/flavor modifiers and volume/weight.
"""

import re
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

REVIEW_SEARCH_SITES: List[Dict[str, str]] = [
    {"domain": "otzovik.com", "name": "Отзовик"},
    {"domain": "irecommend.ru", "name": "IRecommend"},
    {"domain": "rskrf.ru", "name": "Роскачество"},
    {"domain": "roscontrol.com", "name": "Росконтроль"},
    {"domain": "magnit.ru", "name": "Магнит"},
    {"domain": "5ka.ru", "name": "Пятёрочка"},
    {"domain": "vkusvill.ru", "name": "ВкусВилл"},
    {"domain": "perekrestok.ru", "name": "Перекрёсток"},
    {"domain": "auchan.ru", "name": "Ашан"},
    {"domain": "metro-cc.ru", "name": "МЕТРО"},
    {"domain": "globus.ru", "name": "Глобус"},
    {"domain": "mgnl.ru", "name": "Магнолия"},
    {"domain": "dixy.ru", "name": "Дикси"},
    {"domain": "chizhik.club", "name": "Чижик"},
    {"domain": "okeydostavka.ru", "name": "О’КЕЙ"},
    {"domain": "vprok.ru", "name": "Перекрёсток Впрок"},
    {"domain": "av.ru", "name": "Азбука Вкуса"},
    {"domain": "lenta.com", "name": "Лента"},
    {"domain": "ozon.ru", "name": "Ozon"},
    {"domain": "market.yandex.ru", "name": "Яндекс Маркет"},
    {"domain": "wildberries.ru", "name": "Wildberries"},
    {"domain": "kuper.ru", "name": "Купер"},
    {"domain": "sbermarket.ru", "name": "СберМаркет"},
    {"domain": "eda.yandex.ru", "name": "Яндекс Лавка / Еда"},
]


def normalize_title_for_match(raw: Optional[str]) -> str:
    if not raw:
        return ""
    s = re.sub(r"[\u00ad\u200b\u00a0«»\"'„“”]", " ", str(raw))
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


SUGAR_FREE_REGEX = re.compile(
    r"(без\s+сахара|без\s+добавленного\s+сахара|\bzero\b|\bзеро\b|\blight\b|\bлайт\b|\bdiet\b|0\s*%\s*сахара|0\s+сахара|на\s+стевии|подсластител)",
    re.IGNORECASE,
)

FLAVOR_AND_TYPE_MODIFIERS = [
    "ваниль",
    "вишн",
    "черешн",
    "лимон",
    "лайм",
    "манго",
    "маракуй",
    "апельсин",
    "персик",
    "малин",
    "клубник",
    "земляник",
    "смородин",
    "черник",
    "яблок",
    "груш",
    "ананас",
    "грейпфрут",
    "тархун",
    "дюшес",
    "байкал",
    "буратино",
    "крем-сода",
    "карамел",
    "кокос",
    "миндал",
    "фундук",
    "фисташк",
    "банан",
    "шоколад",
    "какао",
    "кофе",
    "матча",
    "имбир",
    "мята",
    "мятн",
    "солен",
    "копчен",
    "остр",
    "сырн",
    "гриб",
    "сметан",
    "зелен",
    "краб",
    "бекон",
    "паприк",
    "безлактоз",
    "топлен",
    "обезжир",
    "классич",
    "original",
    "classic",
]

GENERIC_STOP_WORDS = {
    "напиток",
    "газированный",
    "сильногазированный",
    "среднегазированный",
    "слабогазированный",
    "негазированный",
    "безалкогольный",
    "пастеризованный",
    "ультрапастеризованный",
    "стерилизованный",
    "охлажденный",
    "замороженный",
    "фасованный",
    "нарезка",
    "упаковка",
    "бутылка",
    "банка",
    "пакет",
    "коробка",
    "продукт",
    "товар",
    "купить",
    "цена",
    "отзывы",
    "отзыв",
    "доставка",
    "москва",
    "лавка",
    "яндекс",
    "бзмж",
    "стм",
    "для",
    "или",
    "под",
    "над",
    "при",
}


def parse_volume_or_weight_grams(text: Optional[str]) -> Optional[float]:
    """Извлекает объём/вес в граммах или миллилитрах (например '1,5 л' -> 1500, '330 мл' -> 330)."""
    if not text:
        return None
    s = re.sub(r"[\u00ad\u200b\u00a0]", " ", str(text))
    m_multi = re.search(
        r"(\d+)\s*[×xх*]\s*(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])",
        s,
        re.IGNORECASE,
    )
    if m_multi:
        cnt = int(m_multi.group(1))
        val = float(m_multi.group(2).replace(",", "."))
        u = m_multi.group(3).lower()
        mult = 1000.0 if u.startswith(("кг", "л")) else 1.0
        return cnt * val * mult

    m_single = re.search(
        r"(?:^|[^\d.,])(\d+(?:[.,]\d+)?)\s*(г|гр|грамм[а-я]*|кг|мл|л|литр[а-я]*)(?![а-яёa-z])",
        s,
        re.IGNORECASE,
    )
    if m_single:
        val = float(m_single.group(1).replace(",", "."))
        u = m_single.group(2).lower()
        mult = 1000.0 if u.startswith(("кг", "л")) else 1.0
        return val * mult
    return None


def build_full_product_search_query(
    title: str, brand: Optional[str] = None, amount: Optional[str] = None
) -> str:
    """
    Формирует ПОЛНЫЙ поисковый запрос товара без потери «без сахара», вкуса и объёма/веса!
    Если вес/объём (amount, например '1,5 л') не входит в title, добавляет его в конец.
    """
    q = re.sub(r"[\u00ad\u200b\u00a0«»\"'„“”]", " ", title or "")
    q = re.sub(r"\b(?:бзмж|стм)\b", " ", q, flags=re.IGNORECASE)
    q = re.sub(r"\s+", " ", q).strip()

    if brand:
        clean_brand = re.sub(r"[\u00ad\u200b\u00a0«»\"']", " ", brand).strip()
        if clean_brand and clean_brand.lower() not in q.lower():
            if clean_brand.lower() == "из лавки":
                q = f"{q} Из Лавки"
            else:
                q = f"{q} {clean_brand}"

    if amount:
        clean_amt = re.sub(r"[\u00ad\u200b\u00a0]", " ", amount).strip()
        if clean_amt:
            # Проверяем, есть ли уже этот вес/объём в строке запроса
            target_grams = parse_volume_or_weight_grams(clean_amt)
            query_grams = parse_volume_or_weight_grams(q)
            if not query_grams and clean_amt.lower() not in q.lower():
                q = f"{q} {clean_amt}"
            elif target_grams and query_grams and abs(target_grams - query_grams) > 5:
                q = f"{q} {clean_amt}"

    return re.sub(r"\s+", " ", q).strip()


def normalize_synonym_tokens(text: str) -> str:
    """Приводит частые англо-русские продуктовые синонимы к единому виду для точного сопоставления."""
    s = text.lower().replace("ё", "е")
    s = re.sub(r"\bcola\b", "кола", s)
    s = re.sub(r"\bcoca[\s-]*кола\b", "coca-cola кока-кола", s)
    s = re.sub(r"\boriginal\b", "оригинал original", s)
    s = re.sub(r"\bclassic\b", "классик classic", s)
    s = re.sub(r"\bzero\b", "без сахара zero зеро", s)
    return s


def is_search_result_matching_product(
    res_title: str,
    res_snippet: str,
    product_title: str,
    product_amount: Optional[str] = None,
) -> Tuple[bool, bool]:
    """
    Проверяет, относится ли найденный результат поиска ИМЕННО К ЭТОМУ ПРОДУКТУ.
    Возвращает кортеж: (is_same_product, is_same_volume).
    """
    full_target = f"{product_title or ''} {product_amount or ''}".strip()
    target_lower = full_target.lower().replace("ё", "е")
    res_title_lower = (res_title or "").lower().replace("ё", "е")
    res_combined_lower = f"{res_title_lower} {(res_snippet or '').lower().replace('ё', 'е')}"

    # 1. ЖЁСТКАЯ ПРОВЕРКА МОДИФИКАТОРА «БЕЗ САХАРА / ZERO»
    target_is_sugar_free = bool(SUGAR_FREE_REGEX.search(target_lower))
    res_is_sugar_free = bool(SUGAR_FREE_REGEX.search(res_combined_lower))
    res_title_is_sugar_free = bool(SUGAR_FREE_REGEX.search(res_title_lower))

    if target_is_sugar_free and not res_is_sugar_free:
        # Ищем товар БЕЗ САХАРА, а в результате — обычный товар с сахаром -> ОТБРАСЫВАЕМ!
        return False, False

    if not target_is_sugar_free and res_title_is_sugar_free:
        # Ищем обычный товар С САХАРОМ, а в заголовке результата — версия БЕЗ САХАРА -> ОТБРАСЫВАЕМ!
        return False, False

    # 2. ПРОВЕРКА ВКУСОВЫХ И ВИДОВЫХ МОДИФИКАТОРОВ (ваниль, вишня, лайм, безлактозное и т.д.)
    for mod in FLAVOR_AND_TYPE_MODIFIERS:
        if mod in ("original", "classic", "классич"):
            continue
        target_has_mod = mod in target_lower
        res_title_has_mod = mod in res_title_lower
        res_any_has_mod = mod in res_combined_lower
        if target_has_mod and not res_any_has_mod:
            return False, False
        if not target_has_mod and res_title_has_mod:
            return False, False

    # 3. ПРОВЕРКА КЛЮЧЕВЫХ СЛОВ НАЗВАНИЯ И БРЕНДА
    norm_target = normalize_synonym_tokens(target_lower)
    norm_res = normalize_synonym_tokens(res_combined_lower)

    raw_words = re.findall(r"[а-яa-z0-9]{3,}", norm_target)
    core_tokens = []
    for w in raw_words:
        if w in GENERIC_STOP_WORDS:
            continue
        if w in ("без", "сахара", "сахар", "zero", "зеро", "литр", "литра", "литров", "грамм", "грамма"):
            continue
        if re.match(r"^\d+(?:г|гр|кг|мл|л|шт|percent)?$", w):
            continue
        if w not in core_tokens:
            core_tokens.append(w)

    if core_tokens:
        matched_tokens = 0
        for tok in core_tokens:
            stem = tok[:5] if len(tok) >= 6 else (tok[:4] if len(tok) >= 5 else tok)
            if stem in norm_res:
                matched_tokens += 1
        required = 1 if len(core_tokens) == 1 else max(2, int(len(core_tokens) * 0.6))
        if matched_tokens < min(required, len(core_tokens)):
            return False, False

    # 4. ПРОВЕРКА СОВПАДЕНИЯ ОБЪЁМА / ВЕСА (чтобы не сравнивать цену 1.5 л с баночкой 0.33 л)
    target_grams = parse_volume_or_weight_grams(product_amount) or parse_volume_or_weight_grams(product_title)
    res_grams = parse_volume_or_weight_grams(res_title) or parse_volume_or_weight_grams(res_snippet)

    is_same_volume = True
    if target_grams and res_grams:
        ratio = res_grams / target_grams if target_grams > 0 else 1.0
        if ratio < 0.78 or ratio > 1.25:
            is_same_volume = False

    return True, is_same_volume


def detect_source_label(url: str) -> Tuple[str, bool]:
    try:
        host = urllib.parse.urlparse(url).netloc.lower()
    except Exception:
        host = ""
    for site in REVIEW_SEARCH_SITES:
        dom = site["domain"]
        if host == dom or host.endswith("." + dom):
            return site["name"], True
    return host.replace("www.", "") or "Веб", False


def extract_competitor_prices_from_sources(
    sources: List[Dict[str, Any]],
    lavka_price: Optional[float] = None,
    product_title: str = "",
    product_amount: Optional[str] = None,
) -> Tuple[Optional[float], str, List[Dict[str, Any]]]:
    """
    Извлекает цены в рублях и ссылки ТОЛЬКО из тех сниппетов конкурентов,
    которые прошли проверку полного совпадения продукта (включая «без сахара» и объём/вес).
    """
    if not sources:
        return None, "", []
    found: List[Dict[str, Any]] = []
    for s in sources:
        raw_title = s.get("title") or ""
        snippet = s.get("snippet") or ""
        if product_title:
            same_prod, same_vol = is_search_result_matching_product(
                raw_title, snippet, product_title, product_amount
            )
            if not same_prod or not same_vol:
                continue

        text = f"{raw_title} {snippet}"
        source_name = s.get("source") or "Магазин"
        url = s.get("url") or ""
        for m in re.finditer(
            r"(?:от\s+|цена\s+|за\s+)?(\d{2,4}(?:[.,]\d{1,2})?)\s*(?:₽|руб\.?|р\.)(?![а-яa-z])",
            text,
            re.IGNORECASE,
        ):
            try:
                val = float(m.group(1).replace(",", "."))
                if 20 <= val <= 9500:
                    if lavka_price and (val < lavka_price * 0.35 or val > lavka_price * 3.0):
                        continue
                    found.append(
                        {
                            "store": source_name,
                            "price": int(round(val)),
                            "url": url,
                            "title": (raw_title or source_name)[:90],
                        }
                    )
            except Exception:
                pass
    if not found:
        return None, "", []
    found.sort(key=lambda x: x["price"])
    min_p = float(found[0]["price"])
    seen_stores = set()
    parts = []
    unique_offers: List[Dict[str, Any]] = []
    for item in found:
        st = item["store"]
        if st not in seen_stores:
            seen_stores.add(st)
            parts.append(f"{st}: ~{item['price']} ₽")
            unique_offers.append(item)
        if len(unique_offers) >= 5:
            break
    return min_p, ", ".join(parts[:3]), unique_offers
