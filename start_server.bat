@echo off
set NO_PROXY=127.0.0.1,localhost
echo Starting Lavka Quality Shield v2.1.0 FastAPI Server on http://127.0.0.1:8765 ...
python server.py
pause
