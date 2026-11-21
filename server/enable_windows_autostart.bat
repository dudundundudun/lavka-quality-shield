@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Lavka Quality Shield v2.10.0 - Windows Silent Autostart & Chrome Bridge Installer
cd /d "%~dp0"

REM Подсказка: запусти "enable_windows_autostart.bat --update-deps" (или удали
REM "%LOCALAPPDATA%\LavkaQualityShield\venv\.deps_installed")
REM для принудительного обновления зависимостей из requirements.txt.

set "PYTHONDONTWRITEBYTECODE=1"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%STARTUP_DIR%\LavkaQualityShield_Autostart.vbs"
set "APP_DIR=%~dp0"
set "LQS_DATA_DIR=%LOCALAPPDATA%\LavkaQualityShield"
set "VENV_DIR=%LQS_DATA_DIR%\venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "VENV_PYTHONW=%VENV_DIR%\Scripts\pythonw.exe"
set "DEPS_MARKER=%VENV_DIR%\.deps_installed"
set "REQ_FILE=%~dp0requirements.txt"

set "FORCE_DEPS=0"
if /i "%~1"=="--update-deps" set "FORCE_DEPS=1"
if /i "%~1"=="/update-deps" set "FORCE_DEPS=1"

if not exist "%LQS_DATA_DIR%" mkdir "%LQS_DATA_DIR%"

echo ============================================================
echo   Lavka Quality Shield v2.10.0 - AUTOSTART + CHROME BRIDGE
echo ============================================================
echo [1/4] Подготовка изолированного Python-окружения ^(.venv^)...

set "NEED_DEPS=0"
if "%FORCE_DEPS%"=="1" set "NEED_DEPS=1"

if not exist "%VENV_PYTHON%" (
    python -B -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Не удалось создать venv. Проверьте установку Python 3.
        pause
        exit /b 1
    )
    set "NEED_DEPS=1"
)

if not exist "%DEPS_MARKER%" set "NEED_DEPS=1"

if "%NEED_DEPS%"=="0" (
    "%VENV_PYTHON%" -B -c "import fastapi, uvicorn, httpx" >nul 2>&1
    if errorlevel 1 set "NEED_DEPS=1"
)

if "%NEED_DEPS%"=="1" (
    if "%FORCE_DEPS%"=="1" (
        echo [LQS] Принудительное обновление зависимостей из requirements.txt...
        "%VENV_PYTHON%" -B -m pip install --upgrade --quiet --disable-pip-version-check -r "%REQ_FILE%"
    ) else (
        echo [LQS] Установка зависимостей из requirements.txt...
        "%VENV_PYTHON%" -B -m pip install --quiet --disable-pip-version-check -r "%REQ_FILE%"
    )
    if errorlevel 1 (
        echo [ERROR] Не удалось установить зависимости из requirements.txt.
        pause
        exit /b 1
    )
    > "%DEPS_MARKER%" echo installed
) else (
    echo [LQS] Зависимости уже установлены ^(готов к офлайн-запуску^). Пропускаем pip install.
)

if exist "__pycache__" rmdir /s /q "__pycache__"

echo [2/4] Создание тихого фонового автозапуска в Windows Startup...
(
  echo Set WshShell = CreateObject^("WScript.Shell"^)
  echo WshShell.CurrentDirectory = "%APP_DIR:~0,-1%"
  echo WshShell.Run """%VENV_PYTHONW%"" -B server.py", 0, False
) > "%VBS_PATH%"

echo [3/4] Регистрация моста Chrome Native Messaging ^(автозапуск и кнопка из расширения^)...
"%VENV_PYTHON%" -B "%~dp0native_host\register_native_host.py"

echo [4/4] Мгновенный запуск фонового сервера прямо сейчас...
wscript.exe "%VBS_PATH%"

echo.
echo ГОТОВО!
echo  - Сервер (:8765) настроен на тихий автозапуск вместе с Windows.
echo  - Расширение теперь может само включать сервер (:8765) автоматически и по кнопке.
echo Чтобы отключить автозапуск — запусти disable_windows_autostart.bat.
echo ============================================================
pause
