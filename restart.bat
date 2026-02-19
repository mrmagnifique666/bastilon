@echo off
echo Killing all node processes...
taskkill /IM node.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul
echo Starting Kingston bot...
cd /d C:\Users\Nicolas\Documents\Claude\claude-telegram-relay
start "Kingston Bot" cmd /k "npx tsx src/launcher.ts"
echo Kingston restarted!
