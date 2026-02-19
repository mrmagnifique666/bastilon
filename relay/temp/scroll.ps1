Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse5 {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public const int MOUSEEVENTF_LEFTDOWN = 0x02;
    public const int MOUSEEVENTF_LEFTUP = 0x04;
    public const int MOUSEEVENTF_WHEEL = 0x0800;
}
"@

# First close the "Vous connaissez peut-être" popup by clicking the X
# The X is at approximately x=1590, y=600 based on the crop (200+1390, 400+200)
# Actually let me close it - x button appears at about crop(1390,275) -> real(1590,675)
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(1590, 675)
Start-Sleep -Milliseconds 300
[Mouse5]::mouse_event([Mouse5]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[Mouse5]::mouse_event([Mouse5]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
Start-Sleep -Milliseconds 500

# Now move mouse to center of left monitor and scroll down
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(960, 540)
Start-Sleep -Milliseconds 300

# Scroll down multiple times
for ($i = 0; $i -lt 5; $i++) {
    [Mouse5]::mouse_event([Mouse5]::MOUSEEVENTF_WHEEL, 0, 0, -120, 0)
    Start-Sleep -Milliseconds 200
}

Write-Output 'Scrolled down'
