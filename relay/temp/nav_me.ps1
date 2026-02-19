Add-Type -AssemblyName System.Windows.Forms

# First, click somewhere on the browser to ensure focus
Start-Sleep -Milliseconds 200

# Press F6 to focus URL bar (more reliable than Ctrl+L in some browsers)
[System.Windows.Forms.SendKeys]::SendWait("{F6}")
Start-Sleep -Milliseconds 500

# Clear and type URL via clipboard
[System.Windows.Forms.Clipboard]::SetText("https://www.facebook.com/me")
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Write-Output 'Navigated'
