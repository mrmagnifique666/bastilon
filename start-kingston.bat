@echo off
title Kingston - Bastilon OS
cd /d "C:\Users\Nicolas\Documents\Claude\claude-telegram-relay"

echo ========================================
echo   Kingston - Bastilon OS
echo ========================================
echo.

:: Check if already running
if exist "relay\bot.lock" (
    echo Kingston est deja en cours d'execution.
    echo Pour forcer un redemarrage, ferme cette fenetre et supprime relay\bot.lock
    echo.
    pause
    exit /b
)

:: Kill orphan node processes on our ports
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3200 " ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>nul
)

echo Demarrage de Kingston...
echo.
npx tsx src/index.ts
echo.
echo Kingston s'est arrete. Appuie sur une touche pour fermer.
pause
