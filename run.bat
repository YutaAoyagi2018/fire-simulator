@echo off
rem FIRE Simulator を起動してブラウザで開く
cd /d "%~dp0"
start "" http://127.0.0.1:8777/
python build\serve.py 8777
