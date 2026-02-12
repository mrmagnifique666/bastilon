Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\watchdog.ps1""", 0, True
