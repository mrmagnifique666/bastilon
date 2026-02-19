Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse7 {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public const int MOUSEEVENTF_LEFTDOWN = 0x02;
    public const int MOUSEEVENTF_LEFTUP = 0x04;
}
"@

# The Facebook tab "(20+) Facebook" is the last tab on the right monitor
# Right monitor starts at x=1920
# From the crop, the Facebook tab appears to be at approximately x=1830 in the crop
# So real: x=1920+1830=3750, y=10
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(3750, 10)
Start-Sleep -Milliseconds 300
[Mouse7]::mouse_event([Mouse7]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[Mouse7]::mouse_event([Mouse7]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
Write-Output 'Clicked Facebook tab'
