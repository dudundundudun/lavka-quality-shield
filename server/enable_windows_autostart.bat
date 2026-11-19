@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Lavka Quality Shield v2.7.0 - Windows Silent Autostart Installer
cd /d "%~dp0"

set "PYTHONDONTWRITEBYTECODE=1"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%STARTUP_DIR%\LavkaQualityShield_Autostart.vbs"
set "APP_DIR=%~dp0"
set "LQS_DATA_DIR=%LOCALAPPDATA%\LavkaQualityShield"
set "VENV_DIR=%LQS_DATA_DIR%\venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "VENV_PYTHONW=%VENV_DIR%\Scripts\pythonw.exe"

if not exist "%LQS_DATA_DIR%" mkdir "%LQS_DATA_DIR%"

echo ============================================================
echo   Lavka Quality Shield v2.7.0 - ZERO-CLICK WINDOWS AUTOSTART
echo ============================================================
echo [1/3] Подготовка изолированного Python-окружения (.venv)...
if not exist "%VENV_PYTHON%" (
    python -B -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Не удалось создать venv. Проверьте установку Python 3.
        pause
        exit /b 1
    )
)
"%VENV_PYTHON%" -B -m pip install --quiet --disable-pip-version-check -r requirements.txt
if exist "__pycache__" rmdir /s /q "__pycache__"

echo [2/3] Создание тихого фонового автозапуска в Windows Startup...
(
  echo Set WshShell = CreateObject^("WScript.Shell"^)
  echo WshShell.CurrentDirectory = "%APP_DIR:~0,-1%"
  echo WshShell.Run "cmd /c docker start gemini-argon >nul 2>&1", 0, False
  echo WshShell.Run """%VENV_PYTHONW%"" -B server.py", 0, False
) > "%VBS_PATH%"

echo [3/3] Мгновенный запуск фонового сервера прямо сейчас...
wscript.exe "%VBS_PATH%"

echo.
echo ГОТОВО! Локальный сервер (:8765) настроен на тихий автозапуск из %VENV_DIR%.
echo Чтобы отключить автозапуск — запусти disable_windows_autostart.bat.
echo ============================================================
pause
