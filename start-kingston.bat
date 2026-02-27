@echo off
:: Kingston Wrapper Launcher with auto-restart watchdog

cd /d "C:\Users\Nicolas\Documents\Claude\claude-telegram-relay"
title Kingston Wrapper

:: Check if already running
powershell -NoProfile -Command "if (Get-Process -Name node -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if %errorlevel%==1 (
    echo.
    echo   Kingston est deja en cours d'execution!
    echo   Pour redemarrer, ferme d'abord la fenetre "Kingston Wrapper"
    echo   ou kill les processus node dans le Gestionnaire des taches.
    echo.
    pause
    exit /b
)

:loop

:: Clean stale locks
if exist "relay\bot.lock" del /f "relay\bot.lock" >nul 2>nul

echo.
echo ========================================
echo   Kingston Wrapper - Bastilon OS
echo   %date% %time%
echo ========================================
echo.
echo   Demarrage du superviseur...
echo   Les logs s'affichent ici en temps reel.
echo   Pour arreter: ferme cette fenetre.
echo.

:: Start wrapper — output to BOTH console and log file
"C:\Program Files\nodejs\npx.cmd" tsx src/wrapper.ts 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath data\heartbeat-stdout.log -Append"

:: If wrapper exits, wait 30s then restart
echo.
echo [%date% %time%] Wrapper s'est arrete - redemarrage dans 30s...
echo Appuie Ctrl+C pour annuler le redemarrage.
timeout /t 30
goto loop
