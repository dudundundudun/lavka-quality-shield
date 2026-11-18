@echo off
chcp 65001 >nul
title Lavka Quality Shield v2.3.0 - Remove Windows Autostart
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%STARTUP_DIR%\LavkaQualityShield_Autostart.vbs"

if exist "%VBS_PATH%" (
  del /f /q "%VBS_PATH%"
  echo ✅ Автозапуск Lavka Quality Shield удалён из Windows Startup.
) else (
  echo ℹ️ Автозапуск не был установлен.
)

taskkill /f /im pythonw.exe >nul 2>&1
echo ✅ Фоновый процесс pythonw.exe остановлен.
pause
