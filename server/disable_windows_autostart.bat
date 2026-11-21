@echo off
chcp 65001 >nul
title Lavka Quality Shield v2.10.0 - Remove Windows Autostart
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%STARTUP_DIR%\LavkaQualityShield_Autostart.vbs"

if exist "%VBS_PATH%" (
  del /f /q "%VBS_PATH%"
  echo Автозапуск Lavka Quality Shield удалён из Windows Startup.
) else (
  echo Автозапуск не был установлен.
)

powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*server.py*' -and $_.CommandLine -like '*LavkaQualityShield*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
echo Фоновый процесс Lavka Quality Shield (server.py) остановлен.
pause
