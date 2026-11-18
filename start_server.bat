@echo off
title Lavka Quality Shield v2.4.0 - Local AI Review Server
cd /d "%~dp0"
set PYTHONDONTWRITEBYTECODE=1
if exist "__pycache__" rmdir /s /q "__pycache__"
echo ============================================================
echo   Lavka Quality Shield v2.4.0 - Local FastAPI Backend
echo   Listening on: http://127.0.0.1:8765
echo   Healthcheck : http://127.0.0.1:8765/api/health
echo   Works with  : Zero-Click Gemini Browser Autopilot OR :8083 Bridge
echo ============================================================
python -B -m pip install --quiet fastapi uvicorn httpx beautifulsoup4 pydantic
if exist "__pycache__" rmdir /s /q "__pycache__"
python -B server.py
pause
