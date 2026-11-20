# 🛡️ Lavka Quality Shield v2.9.3 — График Истории Цен, Светофор Состава, Радар 16 Магазинов и Zero-Click ИИ

Гибридное расширение **Google Chrome (Manifest V3)** и локальный сервер **FastAPI + SQLite (`127.0.0.1:8765`)** для защиты покупателя на сайте **Яндекс Лавки (`https://lavka.yandex.ru/*`)**: история и график цен товаров, бесплатный мгновенный «Светофор состава», фоновое отслеживание скидок, сравнение цен по 16 торговым сетям, сейф аккаунтов и Zero-Click ИИ с поддержкой ModuleAPI, официальных API, защитой кошелька и Gemini Web (Hydrogen).

## 📁 Структура проекта

```text
lavka-quality-shield/
├── .github/workflows/ci.yml       # Автоматический прогон Python- и JS-тестов на push / PR
├── extension/                     # Папка расширения Chrome (указывается в chrome://extensions)
│   ├── manifest.json
│   ├── shared/config.js           # Единый источник настроек, ключей storage, aiProvider, лимитов и таймаутов
│   ├── shared/price-parser.js     # Чистый парсер ₽/кг, ₽/л, ₽/шт и стоимости белка
│   ├── shared/utils.js            # Общие утилиты (escapeHtml, safeHttpUrl, fetchWithTimeout, настройки, поиск)
│   ├── shared/product-matcher.js  # Чистый модуль нормализации и матчинга товаров (сахар/вкус/объём)
│   ├── shared/ingredients-guard.js# Бесплатный мгновенный «Светофор состава» (ЗМЖ, пальмовое масло, ММО, E-добавки, скрытый сахар)
│   ├── data/seed-magnit.json      # Внешние seed-данные Магнита (fallback)
│   ├── tests/                     # Юнит- и поведенческие тесты (ai-providers, ingredients-guard, price-parser, price-chart, utils, matcher, price-radar, security-guards)
│   ├── background.js              # Service Worker (keep-alive, LQS_BG_DEPS, chrome.alarms watchlist, onMessage)
│   ├── bg/accounts-vault.js       # Сейф аккаунтов, куки-сессии, 1-клик свитчер и автозаполнение
│   ├── bg/ai-providers.js         # Единый модуль ИИ-провайдеров + трекер дневного лимита и расходов в USD
│   ├── bg/gemini-tab.js           # Вкладка Gemini, куки Google, автопрогрев и очередь промптов
│   ├── bg/price-radar.js          # Радар 16 сетей, полная история цен, Watchlist и фоновый чекер
│   ├── content/store-harvester.js # Универсальный пассивный сборщик цен для 7 торговых сетей
│   ├── content/passport-helper.js # Плашка быстрого входа и автозаполнения на passport.yandex.ru / id.yandex.ru
│   ├── content/cart-audit.js      # Слепок корзины, фиксатор цен и баннер аудита корзины Лавки
│   ├── content/price-chart.js     # Интерактивный SVG-график истории цены в стиле Alitools + кнопка «Следить»
│   ├── content.js                 # Оркестрация карточки товара Лавки, панель ИИ-ревизора, спойлер и SPA
│   ├── popup.html / popup.js      # Попап: история цен, отслеживаемые товары, клонирование корзины, настройки
│   ├── styles.css
│   └── icons/
├── server/                        # Модульный локальный FastAPI-бэкенд и автотесты
│   ├── server.py                  # Точка входа FastAPI, динамический CORS и подключение роутеров
│   ├── db.py                      # SQLite (WAL, busy_timeout=5000, индексы, PRAGMA user_version=3, price_watchlist)
│   ├── security.py                # secret.key (32B), пиннинг Origin, fail-closed DPAPI, SSRF-фильтр
│   ├── matcher.py                 # Exact Product & Modifier Matcher (сахар/вкус/объём)
│   ├── routers/                   # Модульные роутеры: health.py, accounts.py, prices.py, cache.py
│   ├── requirements.txt
│   ├── start_server.bat           # Запуск сервера в изолированном .venv
│   ├── enable_windows_autostart.bat
│   ├── disable_windows_autostart.bat
│   ├── run_tests.bat              # Запуск автотестов бэкенда в 1 клик
│   └── tests/                     # Тесты безопасности, БД/конфигов, матчера, ИИ-провайдеров и API CRUD
├── .gitignore
├── LICENSE                        # MIT
└── README.md
```

## 🛡️ Что нового в v2.9.3 (Шаг 3 — Защита кошелька + «Светофор состава»)
* **Защита кошелька для платных ИИ API**: при выборе любого платного провайдера (`ModuleAPI`, `OpenAI`, `Claude`, `Gemini API`, `DeepSeek`, `OpenRouter`) автозапуск ИИ на каждой открытой карточке товара автоматически отключается — вместо этого появляется понятная кнопка **«🤖 Разобрать через [Провайдер]»**. Бесплатный режим вкладки Gemini Web (Hydrogen) работает как раньше.
* **Дневной лимит и счётчик трат в USD**: добавлен настраиваемый дневной лимит (`paidAiDailyLimit`, по умолчанию **25 запросов/день**) и счётчик запросов и расходов за сегодня/месяц (`lqs_ai_usage_v1`, на базе `x-moduleapi-cost` или `usage`). При достижении лимита запрос останавливается с понятным предупреждением.
* **Бесплатный мгновенный «Светофор состава» (`shared/ingredients-guard.js`)**: за миллисекунды и за 0 ₽ проверяет состав товара на карточке Лавки и выводит компактный цветной бейдж: **🟢 Чистый состав**, **🟡 Компромиссы** (глутамат E621, подсластители, модифицированный крахмал, сиропы, консерванты, скрытый сахар в ПП-товарах) или **🔴 Красные флаги** (ЗМЖ, пальмовое масло, ММО, трансжиры, E211/E250).
* **Автотесты**: добавлены unit-тесты для `ingredients-guard.js` и счётчика дневного лимита/расходов.

## 🚀 Что нового в v2.9.2 (Шаг 2 — Единый движок ИИ-провайдеров)
* **Новый модуль `extension/bg/ai-providers.js`**: единый маршрутизатор с готовыми пресетами для **ModuleAPI** (`https://moduleapi.pro/v1`), **OpenAI**, **Google Gemini Official API**, **Anthropic Claude** (отдельный адаптер `x-api-key` + `anthropic-version: 2023-06-01`), **DeepSeek**, **OpenRouter**, своего OpenAI-совместимого URL и бесплатной вкладки **Gemini Web (Hydrogen)**.
* **Чтение точной стоимости и понятные ошибки**: автоматическое чтение заголовка `x-moduleapi-cost` (в USD) с передачей `costUsd` в ответ; понятные русские тексты ошибок для кодов 401/402/403/404/429/502–503 без утечки ключей.
* **Увеличенные таймауты и права доступа**: добавлены `host_permissions` для всех ИИ-доменов; таймауты увеличены до **28 с** (прямой) и **35 с** (`/api/analyze-product`), добавлен адаптер Anthropic на локальном сервере.

## 🛠️ Что нового в v2.9.1 (Audit Hotfix — Шаг 1)
* **Исправлен баг радара цен (`bg/price-radar.js`)**: восстановлен правильный порядок аргументов при вызове `getProductPriceIntelligence` после живого сканирования магазинов («Найти цены в сетях»).
* **Все автотесты снова зелёные** и удалён неиспользуемый файл `content/magnit-parser.js`.

## 🚀 Быстрый старт (Windows 11 + Google Chrome)

1. Распакуй архив в постоянную папку (замени файлы поверх старой папки, если обновляешься).
2. Открой `chrome://extensions`, включи **Режим разработчика (Developer mode)**, нажми **Загрузить распакованное расширение (Load unpacked)** и выбери папку **`extension/`** (при обновлении просто нажми значок обновления 🔄 на карточке расширения).
3. Перезапусти локальный сервер через **`server\start_server.bat`** (или настрой тихий автозапуск через **`server\enable_windows_autostart.bat`**).
4. Запуск тестов локально:
   * Python: **`server\run_tests.bat`** или `python -m unittest discover -s server/tests -v`
   * JS: `node --test extension/tests/*.test.js`

## 📄 Лицензия

Проект распространяется под лицензией [MIT](LICENSE).
