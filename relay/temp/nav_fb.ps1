Add-Type -AssemblyName System.Windows.Forms

# Press Ctrl+L to focus address bar
[System.Windows.Forms.SendKeys]::SendWait("^l")
Start-Sleep -Milliseconds 500

# Use clipboard to paste the URL (avoids SendKeys issues with special chars)
[System.Windows.Forms.Clipboard]::SetText("https://www.facebook.com/me")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Write-Output 'Navigating to facebook.com/me'
