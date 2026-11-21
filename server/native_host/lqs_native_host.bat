@echo off
set "PYTHONDONTWRITEBYTECODE=1"
set "VENV_PY=%LOCALAPPDATA%\LavkaQualityShield\venv\Scripts\python.exe"
if exist "%VENV_PY%" (
    "%VENV_PY%" -B "%~dp0lqs_native_host.py" %*
) else (
    python -B "%~dp0lqs_native_host.py" %*
)
