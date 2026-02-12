@echo off
title Kingston Chrome - Remote Debug
echo ========================================
echo   Kingston Chrome (CDP Port 9222)
echo ========================================
echo.

:: Kill any existing Chrome instances first
taskkill /F /IM chrome.exe >nul 2>nul
timeout /t 3 /nobreak >nul

:: Launch Chrome with a SEPARATE data directory for CDP
:: Chrome refuses remote-debugging with the default user-data-dir
:: This creates a dedicated Kingston profile at Kingston-CDP
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
    --remote-debugging-port=9222 ^
    --user-data-dir="C:\Users\Nicolas\AppData\Local\Google\Chrome\Kingston-CDP" ^
    --no-first-run ^
    --no-default-browser-check

echo.
echo Chrome lance avec profil Kingston-CDP (data dir separee)
echo Port CDP: 9222
echo.
echo NOTE: Ce profil est separe du Chrome principal.
echo Pour Printful/Google, tu devras te connecter une fois.
echo Les cookies seront gardes pour les prochaines sessions.
echo.
echo Kingston peut maintenant se connecter avec BROWSER_MODE=connect
echo.
pause
