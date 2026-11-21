@echo off
setlocal EnableExtensions
title Lavka Quality Shield v2.10.0 - Local AI Review Server
cd /d "%~dp0"

REM Tip: run "start_server.bat --update-deps" (or delete
REM "%LOCALAPPDATA%\LavkaQualityShield\venv\.deps_installed")
REM to force-update dependencies from requirements.txt.

set "PYTHONDONTWRITEBYTECODE=1"
if exist "__pycache__" rmdir /s /q "__pycache__"

set "LQS_DATA_DIR=%LOCALAPPDATA%\LavkaQualityShield"
set "VENV_DIR=%LQS_DATA_DIR%\venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "DEPS_MARKER=%VENV_DIR%\.deps_installed"
set "REQ_FILE=%~dp0requirements.txt"

set "FORCE_DEPS=0"
if /i "%~1"=="--update-deps" set "FORCE_DEPS=1"
if /i "%~1"=="/update-deps" set "FORCE_DEPS=1"

if not exist "%LQS_DATA_DIR%" mkdir "%LQS_DATA_DIR%"

echo ============================================================
echo   Lavka Quality Shield v2.10.0 - Local FastAPI Backend
echo   Listening on: http://127.0.0.1:8765
echo   Healthcheck : http://127.0.0.1:8765/api/health
echo   Venv path   : %VENV_DIR%
echo   Data path   : %LQS_DATA_DIR%
echo ============================================================

set "NEED_DEPS=0"
if "%FORCE_DEPS%"=="1" set "NEED_DEPS=1"

if not exist "%VENV_PYTHON%" (
    echo [LQS] Creating isolated Python virtual environment...
    python -B -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to create venv. Make sure Python 3 is installed and in PATH.
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
        echo [LQS] Force-updating dependencies from requirements.txt...
        "%VENV_PYTHON%" -B -m pip install --upgrade --quiet --disable-pip-version-check -r "%REQ_FILE%"
    ) else (
        echo [LQS] Installing dependencies from requirements.txt...
        "%VENV_PYTHON%" -B -m pip install --quiet --disable-pip-version-check -r "%REQ_FILE%"
    )
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies from requirements.txt.
        pause
        exit /b 1
    )
    > "%DEPS_MARKER%" echo installed
) else (
    echo [LQS] Dependencies already installed ^(offline-ready^). Skipping pip install.
)

if exist "__pycache__" rmdir /s /q "__pycache__"
"%VENV_PYTHON%" -B server.py
pause
