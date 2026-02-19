Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse3 {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public const int MOUSEEVENTF_LEFTDOWN = 0x02;
    public const int MOUSEEVENTF_LEFTUP = 0x04;
}
"@

# Click on "Kingston Orchestrator" text
# Crop offset: (1050, 40), text at approx (240, 90) in crop
# Real: x=1290, y=130
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(1290, 130)
Start-Sleep -Milliseconds 500
[Mouse3]::mouse_event([Mouse3]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[Mouse3]::mouse_event([Mouse3]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
Write-Output 'Clicked at (1290, 130)'
