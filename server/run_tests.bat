@echo off
setlocal EnableExtensions
title Lavka Quality Shield v2.7.0 - Backend Test Suite
cd /d "%~dp0"

set "VENV_PYTHON=%LOCALAPPDATA%\LavkaQualityShield\venv\Scripts\python.exe"
if exist "%VENV_PYTHON%" (
    "%VENV_PYTHON%" -m unittest discover -s tests -v
) else (
    python -m unittest discover -s tests -v
)
pause
