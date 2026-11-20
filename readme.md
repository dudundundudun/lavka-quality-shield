# 🛡️ Lavka Quality Shield v2.9.2 — График Истории Цен, Отслеживание, Радар 16 Магазинов и Zero-Click ИИ

Гибридное расширение **Google Chrome (Manifest V3)** и локальный сервер **FastAPI + SQLite (`127.0.0.1:8765`)** для защиты покупателя на сайте **Яндекс Лавки (`https://lavka.yandex.ru/*`)**: история и график цен товаров, фоновое отслеживание скидок, сравнение цен по 16 торговым сетям, сейф аккаунтов и Zero-Click ИИ с поддержкой ModuleAPI, официальных API и Gemini Web (Hydrogen).

## 📁 Структура проекта

```text
lavka-quality-shield/
├── .github/workflows/ci.yml       # Автоматический прогон Python- и JS-тестов на push / PR
├── extension/                     # Папка расширения Chrome (указывается в chrome://extensions)
│   ├── manifest.json
│   ├── shared/config.js           # Единый источник настроек, ключей storage, aiProvider и таймаутов
│   ├── shared/price-parser.js     # Чистый парсер ₽/кг, ₽/л, ₽/шт и стоимости белка
│   ├── shared/utils.js            # Общие утилиты (escapeHtml, safeHttpUrl, fetchWithTimeout, настройки, поиск)
│   ├── shared/product-matcher.js  # Чистый модуль нормализации и матчинга товаров (сахар/вкус/объём)
│   ├── data/seed-magnit.json      # Внешние seed-данные Магнита (fallback)
│   ├── tests/                     # Юнит- и поведенческие тесты (ai-providers, price-parser, price-chart, utils, matcher, price-radar, security-guards)
│   ├── background.js              # Service Worker (keep-alive, LQS_BG_DEPS, chrome.alarms watchlist, onMessage)
│   ├── bg/accounts-vault.js       # Сейф аккаунтов, куки-сессии, 1-клик свитчер и автозаполнение
│   ├── bg/ai-providers.js         # Единый модуль ИИ-провайдеров (ModuleAPI, OpenAI, Claude, Gemini API, DeepSeek, OpenRouter, Gemini Web)
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

## 🚀 Что нового в v2.9.2 (Шаг 2 — Единый движок ИИ-провайдеров)
* **Новый модуль `extension/bg/ai-providers.js`**: единый маршрутизатор с готовыми пресетами для **ModuleAPI** (`https://moduleapi.pro/v1`), **OpenAI**, **Google Gemini Official API**, **Anthropic Claude** (отдельный адаптер `x-api-key` + `anthropic-version: 2023-06-01`), **DeepSeek**, **OpenRouter**, своего OpenAI-совместимого URL и бесплатной вкладки **Gemini Web (Hydrogen)**.
* **Чтение точной стоимости и понятные ошибки**: автоматическое чтение заголовка `x-moduleapi-cost` (в USD) с передачей `costUsd` в ответ и отображением рядом с режимом разбора; понятные русские тексты ошибок для кодов 401/402/403/404/429/502–503 без утечки ключей.
* **Проверка ключа и загрузка моделей**: добавлена функция проверки подключения (`LQS_TEST_AI_PROVIDER`) и загрузка доступных моделей через `GET /models`.
* **Увеличенные таймауты и права доступа**: добавлены `host_permissions` в `manifest.json` для всех поддерживаемых ИИ-доменов; таймаут прямого запроса увеличен с 6 с до **28 с**, а таймаут `/api/analyze-product` — с 9.5 с до **35 с**; на локальном сервере (`server/routers/cache.py`) добавлен адаптер Anthropic и возврат `costUsd`.
* **Тесты и синхронизация версий**: добавлены JS- и Python-тесты для `ai-providers.js` и серверного адаптера Anthropic/ModuleAPI, синхронизирована версия `v2.9.2` по всему проекту.

## 🛠️ Что нового в v2.9.1 (Audit Hotfix — Шаг 1)
* **Исправлен баг радара цен (`bg/price-radar.js`)**: восстановлен правильный порядок аргументов при вызове `getProductPriceIntelligence` после живого сканирования магазинов («Найти цены в сетях») — старая цена и имя аккаунта больше не смещаются.
* **Все 30 автотестов снова зелёные**: обновлены проверки безопасности под `store-harvester.js` и `isTrustedExternalStoreSender`, устранена ошибка инициализации таймера в `waitForTabComplete` и исправлено сравнение объектов в `store-harvester.test.js`.
* **Чистка проекта**: удалён неиспользуемый файл `content/magnit-parser.js` и убрана устаревшая фраза «сверяю цену без куки» в интерфейсе загрузки.

## 🔥 Что нового в v2.9.0

* **Живой поиск цен в других сетях в 1 клик (`🔄 Найти цены в сетях`)**: кнопка в блоке сравнения тихо открывает в фоновой вкладке поиск на Купере (сразу по Пятёрочке, Магниту, Перекрёстку, Ашану, Ленте, МЕТРО, Дикси и ВкусВиллу по твоему адресу) или до 3 выбранных в настройках сетей, забирает реальные цены без капч, закрывает вкладку и сразу обновляет Топ-3 и кнопки магазинов.
* **Универсальный пассивный сборщик для 7 сетей (`content/store-harvester.js`)**: автоматическое запоминание цен теперь работает не только на Магните, но и на Купере, Перекрёстке (и Впрок), Пятёрочке, ВкусВилле, Ашане и Ленте — при любом визите или клике по кнопке сети цены сразу попадают в локальную базу.
* **Фирменная палитра Лавки и компактный график**: узкое окно графика (340 px) в цветах Яндекс Лавки (`#FCE000` / `#21201F`).

## 🚀 Быстрый старт (Windows 11 + Google Chrome)

1. Распакуй архив в постоянную папку (замени файлы поверх старой папки, если обновляешься).
2. Открой `chrome://extensions`, включи **Режим разработчика (Developer mode)**, нажми **Загрузить распакованное расширение (Load unpacked)** и выбери папку **`extension/`** (при обновлении просто нажми значок обновления 🔄 на карточке расширения).
3. Перезапусти локальный сервер через **`server\start_server.bat`** (или настрой тихий автозапуск через **`server\enable_windows_autostart.bat`**).
4. Запуск тестов локально:
   * Python: **`server\run_tests.bat`** или `python -m unittest discover -s server/tests -v`
   * JS: `node --test extension/tests/*.test.js`

## 📄 Лицензия

Проект распространяется под лицензией [MIT](LICENSE).
