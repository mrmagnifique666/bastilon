Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse8 {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public const int MOUSEEVENTF_LEFTDOWN = 0x02;
    public const int MOUSEEVENTF_LEFTUP = 0x04;
    public const int MOUSEEVENTF_WHEEL = 0x0800;
}
"@

# First, click on the main Facebook area to make sure it has focus
# The profile content is around x=800, y=400
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(800, 400)
Start-Sleep -Milliseconds 300
[Mouse8]::mouse_event([Mouse8]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[Mouse8]::mouse_event([Mouse8]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
Start-Sleep -Milliseconds 500

# Close the "Vous connaissez peut-être" suggestion by clicking X if visible
# The X is at approximately x=945, y=138
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(945, 138)
Start-Sleep -Milliseconds 200
[Mouse8]::mouse_event([Mouse8]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[Mouse8]::mouse_event([Mouse8]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
Start-Sleep -Milliseconds 500

# Scroll down to find the post composer
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(700, 400)
Start-Sleep -Milliseconds 200
for ($i = 0; $i -lt 8; $i++) {
    [Mouse8]::mouse_event([Mouse8]::MOUSEEVENTF_WHEEL, 0, 0, -120, 0)
    Start-Sleep -Milliseconds 200
}

Write-Output 'Scrolled down'
