@echo off
chcp 65001 >nul
title Lavka Quality Shield v2.3.0 - Windows Silent Autostart Installer
cd /d "%~dp0"

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%STARTUP_DIR%\LavkaQualityShield_Autostart.vbs"
set "APP_DIR=%~dp0"

echo ============================================================
echo   Lavka Quality Shield v2.3.0 - ZERO-CLICK WINDOWS AUTOSTART
echo ============================================================
echo [1/3] Проверка библиотек Python (fastapi, uvicorn, httpx, bs4)...
python -B -m pip install --quiet fastapi uvicorn httpx beautifulsoup4 pydantic
if exist "__pycache__" rmdir /s /q "__pycache__"

echo [2/3] Создание тихого фонового автозапуска в Windows Startup...
(
  echo Set WshShell = CreateObject^("WScript.Shell"^)
  echo WshShell.CurrentDirectory = "%APP_DIR:~0,-1%"
  echo WshShell.Run "cmd /c docker start gemini-argon >nul 2>&1", 0, False
  echo WshShell.Run "pythonw -B server.py", 0, False
) > "%VBS_PATH%"

echo [3/3] Мгновенный запуск фонового сервера прямо сейчас...
wscript.exe "%VBS_PATH%"

echo.
echo ✅ ГОТОВО! Теперь локальный сервер (:8765) и Docker-мост (:8083)
echo запускаются САМИ в скрытом режиме при каждом включении Windows!
echo Никаких чёрных окон консоли и никаких ручных кликов.
echo Чтобы отключить автозапуск — запусти disable_windows_autostart.bat.
echo ============================================================
pause
