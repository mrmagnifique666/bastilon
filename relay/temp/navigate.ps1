Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse4 {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public const int MOUSEEVENTF_LEFTDOWN = 0x02;
    public const int MOUSEEVENTF_LEFTUP = 0x04;
}
"@

# First, click on the Facebook tab to make sure we're on it
# The tab "facebook.com" should be near the beginning of the tab bar
# I see the address bar shows "facebook.com" at around y=28, and it's on the left monitor
# Let me click the address bar area - approximately x=400, y=28
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(400, 28)
Start-Sleep -Milliseconds 300
[Mouse4]::mouse_event([Mouse4]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[Mouse4]::mouse_event([Mouse4]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
Start-Sleep -Milliseconds 500

# Select all text in address bar with Ctrl+A
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 200

# Type the profile URL
[System.Windows.Forms.SendKeys]::SendWait("https://www.facebook.com/me")
Start-Sleep -Milliseconds 300

# Press Enter
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Write-Output 'Navigated to profile'
