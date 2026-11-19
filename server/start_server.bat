@echo off
setlocal EnableExtensions
title Lavka Quality Shield v2.7.0 - Local AI Review Server
cd /d "%~dp0"

set "PYTHONDONTWRITEBYTECODE=1"
if exist "__pycache__" rmdir /s /q "__pycache__"

set "LQS_DATA_DIR=%LOCALAPPDATA%\LavkaQualityShield"
set "VENV_DIR=%LQS_DATA_DIR%\venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"

if not exist "%LQS_DATA_DIR%" mkdir "%LQS_DATA_DIR%"

echo ============================================================
echo   Lavka Quality Shield v2.7.0 - Local FastAPI Backend
echo   Listening on: http://127.0.0.1:8765
echo   Healthcheck : http://127.0.0.1:8765/api/health
echo   Venv path   : %VENV_DIR%
echo   Data path   : %LQS_DATA_DIR%
echo ============================================================

if not exist "%VENV_PYTHON%" (
    echo [LQS] Creating isolated Python virtual environment...
    python -B -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to create venv. Make sure Python 3 is installed and in PATH.
        pause
        exit /b 1
    )
)

echo [LQS] Checking dependencies from requirements.txt...
"%VENV_PYTHON%" -B -m pip install --quiet --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies from requirements.txt.
    pause
    exit /b 1
)

if exist "__pycache__" rmdir /s /q "__pycache__"
"%VENV_PYTHON%" -B server.py
pause
