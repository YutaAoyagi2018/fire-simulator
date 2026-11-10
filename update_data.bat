@echo off
rem 最新の基準価額・指数・為替・物価を取り直して web\data.js を作り直す
cd /d "%~dp0"
if not exist .venv (
  python -m venv .venv
  .venv\Scripts\python -m pip install -q -r requirements.txt
)
set PYTHONIOENCODING=utf-8
.venv\Scripts\python build\fetch_data.py
.venv\Scripts\python build\build_data.py
pause
