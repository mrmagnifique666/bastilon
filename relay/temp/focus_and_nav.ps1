Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse9 {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public const int MOUSEEVENTF_LEFTDOWN = 0x02;
    public const int MOUSEEVENTF_LEFTUP = 0x04;
}
"@

# Click on the Facebook area (center of profile content) to ensure browser focus
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(700, 300)
Start-Sleep -Milliseconds 300
[Mouse9]::mouse_event([Mouse9]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[Mouse9]::mouse_event([Mouse9]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
Start-Sleep -Milliseconds 500

# Use keyboard shortcut to go to address bar
[System.Windows.Forms.SendKeys]::SendWait("{F6}")
Start-Sleep -Milliseconds 500

# Select all text
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 200

# Use clipboard to paste URL
[System.Windows.Forms.Clipboard]::SetText("https://www.facebook.com/me")
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 300

# Press Enter
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Write-Output 'Navigated to facebook.com/me'
