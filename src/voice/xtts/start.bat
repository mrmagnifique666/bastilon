@echo off
echo Starting XTTS Voice Server...
cd /d "%~dp0"
call .venv\Scripts\activate.bat
python server.py %*
