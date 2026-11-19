# 🛡️ Lavka Quality Shield v2.6 — Радар 16 Магазинов, Менеджер Аккаунтов, Аудит Корзины и Zero-Click ИИ

Гибридное расширение **Google Chrome (Manifest V3)** и локальный сервер **FastAPI + SQLite (`127.0.0.1:8765`)** для защиты покупателя на сайте **Яндекс Лавки (`https://lavka.yandex.ru/*`)** и сравнения цен по 16 торговым сетям.

## 📁 Структура проекта

```text
lavka-quality-shield/
├── extension/                  # Папка расширения Chrome (указывается в chrome://extensions)
│   ├── manifest.json
│   ├── shared/config.js        # Единый источник настроек и ключей chrome.storage
│   ├── background.js           # Service Worker (очередь ИИ, радар цен, менеджер аккаунтов)
│   ├── content.js              # UI-панель, аудит корзины, нативный парсер Магнита
│   ├── popup.html / popup.js   # Всплывающее окно, история цен, клонирование корзины
│   ├── styles.css
│   └── icons/
├── server/                     # Локальный FastAPI-бэкенд и автотесты
│   ├── server.py               # Маршруты FastAPI и SQLite-хранилище
│   ├── security.py             # Изоляция БД в %LOCALAPPDATA%, Windows DPAPI, строгий CORS
│   ├── matcher.py              # Exact Product & Modifier Matcher (сахар/вкус/объём)
│   ├── requirements.txt
│   ├── start_server.bat        # Запуск сервера в изолированном .venv
│   ├── enable_windows_autostart.bat
│   ├── disable_windows_autostart.bat
│   ├── run_tests.bat           # Запуск автотестов в 1 клик
│   └── tests/                  # Юнит-тесты матчера и безопасности API
├── .gitignore
├── LICENSE                     # MIT
└── README.md
```

## 🔥 Ключевые возможности

* **Радар 16 торговых сетей + Exact Product & Modifier Matcher**: сравнивает цены по 16 сетям (Магнит, Пятёрочка, Перекрёсток, ВкусВилл, Ашан, МЕТРО, Глобус, Лента, Магнолия, Дикси, Чижик, О’КЕЙ, Азбука Вкуса, Самокат, Ozon, Купер / Я.Маркет), жёстко разделяет версии «без сахара / Zero» и обычные, а также фильтрует несовпадающий объём/вес (`1,5 л` vs `0,33 л`).
* **Zero-Click ИИ-автопилот**: удерживает MV3 Service Worker активным (`startSwKeepAlive`), читает готовый ответ из фоновой вкладки Gemini и кэширует до 500 вердиктов локально.
* **Анти-шулер цен и клонирование корзины**: проверяет гостевую цену без cookies, фиксирует обещанные цены витрины и позволяет сравнить и пересобрать корзину на более выгодном аккаунте в 1 клик.
* **Безопасность локального хранилища (Шаг 1 — Hardening)**: SQLite-база и автогенерируемый 32-байтный токен `secret.key` хранятся в `%LOCALAPPDATA%\LavkaQualityShield\`. Все API-маршруты (кроме `/api/health` и одноразового `/api/auth/pair`) требуют заголовок `X-LQS-Token`, `X-LQS-Client` и точный закреплённый `Origin` расширения (`pinned_extension.json` / `LQS_EXTENSION_ID`). Шифрование DPAPI работает в режиме fail-closed (без отката в plaintext), а пароли и куки больше не сохраняются в `chrome.storage.local`.

## 🚀 Быстрый старт (Windows 11 + Google Chrome)

1. Распакуй проект в постоянную папку.
2. Открой `chrome://extensions`, включи **Режим разработчика (Developer mode)**, нажми **Загрузить распакованное расширение (Load unpacked)** и выбери папку **`extension/`**.
3. Запусти локальный сервер через **`server\start_server.bat`** (скрипт сам создаст изолированное Python-окружение в `%LOCALAPPDATA%\LavkaQualityShield\venv` и установит зависимости из `requirements.txt`). Для тихого автозапуска с Windows используй **`server\enable_windows_autostart.bat`**.
4. Чтобы прогнать автотесты бэкенда и матчера товаров, запусти **`server\run_tests.bat`**.

## 📄 Лицензия

Проект распространяется под лицензией [MIT](LICENSE).
