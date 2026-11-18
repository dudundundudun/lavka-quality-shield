@echo off
title Lavka Quality Shield v2.2.0 - Local AI Review Server
cd /d "%~dp0"
echo ============================================================
echo   Lavka Quality Shield v2.2.0 - Local FastAPI Backend
echo   Listening on: http://127.0.0.1:8765
echo   Healthcheck : http://127.0.0.1:8765/api/health
echo   Works with  : Gemini Browser Tab Autopilot OR :8083 Bridge
echo ============================================================
python -m pip install --quiet fastapi uvicorn httpx beautifulsoup4 pydantic
python server.py
pause
