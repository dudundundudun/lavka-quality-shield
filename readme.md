# 🛡️ Lavka Quality Shield v2.7.0 — Радар 16 Магазинов, DPAPI-Сейф, Аудит Корзины и Zero-Click ИИ

Гибридное расширение **Google Chrome (Manifest V3)** и локальный сервер **FastAPI + SQLite (`127.0.0.1:8765`)** для защиты покупателя на сайте **Яндекс Лавки (`https://lavka.yandex.ru/*`)** и сравнения цен по 16 торговым сетям.

## 📁 Структура проекта

```text
lavka-quality-shield/
├── .github/workflows/ci.yml    # Автоматический прогон Python- и JS-тестов на push / PR
├── extension/                  # Папка расширения Chrome (указывается в chrome://extensions)
│   ├── manifest.json
│   ├── shared/config.js        # Единый источник настроек, ключей storage и заголовков
│   ├── shared/price-parser.js  # Чистый парсер ₽/кг, ₽/л, ₽/шт и стоимости белка
│   ├── data/seed-magnit.json   # Внешние seed-данные Магнита (fallback)
│   ├── tests/price-parser.test.js # Юнит-тесты парсера цен (node --test)
│   ├── background.js           # Service Worker (ref-counted keep-alive, circuit breaker, радар)
│   ├── content.js              # UI-панель, аудит корзины, нативный парсер Магнита
│   ├── popup.html / popup.js   # Попап: история цен, клонирование корзины, статус 16 сетей
│   ├── styles.css
│   └── icons/
├── server/                     # Модульный локальный FastAPI-бэкенд и автотесты
│   ├── server.py               # Точка входа FastAPI, динамический CORS и подключение роутеров
│   ├── db.py                   # SQLite (WAL, busy_timeout=5000, индексы, PRAGMA user_version)
│   ├── security.py             # secret.key (32B), пиннинг Origin, fail-closed DPAPI, SSRF-фильтр
│   ├── matcher.py              # Exact Product & Modifier Matcher (сахар/вкус/объём)
│   ├── routers/                # Модульные роутеры: health.py, accounts.py, prices.py, cache.py
│   ├── requirements.txt
│   ├── start_server.bat        # Запуск сервера в изолированном .venv
│   ├── enable_windows_autostart.bat
│   ├── disable_windows_autostart.bat
│   ├── run_tests.bat           # Запуск автотестов бэкенда в 1 клик
│   └── tests/                  # Тесты безопасности, БД/конфигов, матчера и API CRUD
├── .gitignore
├── LICENSE                     # MIT
└── README.md
```

## 🔥 Что нового в v2.7.0

* **Безопасность сейфа и API**: автогенерация 32-байтного `secret.key`, обязательный `X-LQS-Token` и пиннинг `Origin` расширения при первом подключении (`/api/auth/pair`), fail-closed DPAPI без отката в plaintext, защита всех API-маршрутов и SSRF-валидация `aiBaseUrl`, полная очистка паролей и куки из `chrome.storage.local`.
* **Усиленный SQLite и конфиги**: `WAL`, `busy_timeout=5000`, 6 индексов (включая `norm_title`), версионирование схемы через `PRAGMA user_version`, единая версия `2.7.0` и динамическая подгрузка моделей ИИ из `${aiBaseUrl}/models`.
* **Стабильный Service Worker и радар**: ref-counted `startSwKeepAlive()`, внешний `extension/data/seed-magnit.json`, персистентный circuit breaker (пауза 15 мин после 3 ошибок или капчи) и компактный статус 16 сетей в настройках попапа.
* **Модульный бэкенд, чистые JS-парсеры и CI**: разделение `server.py` на `db.py` и `routers/`, чистый модуль `shared/price-parser.js` с тестами `node --test`, интеграционные тесты `test_api_crud.py` и GitHub Actions CI.

## 🚀 Быстрый старт (Windows 11 + Google Chrome)

1. Распакуй архив в постоянную папку.
2. Открой `chrome://extensions`, включи **Режим разработчика (Developer mode)**, нажми **Загрузить распакованное расширение (Load unpacked)** и выбери папку **`extension/`**.
3. Запусти локальный сервер через **`server\start_server.bat`** (или настрой тихий автозапуск через **`server\enable_windows_autostart.bat`**).
4. Запуск тестов локально:
   * Python: **`server\run_tests.bat`** или `python -m unittest discover -s server/tests -v`
   * JS: `node --test extension/tests/*.test.js`

## 📄 Лицензия

Проект распространяется под лицензией [MIT](LICENSE).
