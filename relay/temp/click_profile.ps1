Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse2 {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public const int MOUSEEVENTF_LEFTDOWN = 0x02;
    public const int MOUSEEVENTF_LEFTUP = 0x04;
}
"@

# Click on "Kingston Orchestrator" text in the sidebar
# Based on the crop at offset (1100, 30), Kingston Orchestrator is at approx x=90, y=50 in crop
# So real coordinates: x=1100+90=1190, y=30+50=80
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(1190, 80)
Start-Sleep -Milliseconds 300
[Mouse2]::mouse_event([Mouse2]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[Mouse2]::mouse_event([Mouse2]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
Write-Output 'Clicked Kingston Orchestrator'
