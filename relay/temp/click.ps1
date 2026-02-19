Add-Type -AssemblyName System.Windows.Forms
# Click on "Créer une publication" area on the left monitor - the profile page
# I need to click on the text input area near the top of the Kingston Orchestrator profile
# Looking at the screenshot, the "Créer une publication" area should be around the middle-upper area
# First let's click on the profile name/area to make sure we're on the right page
# The profile area with "Kingston Orchestrator" text is around x=320, y=70 on the left monitor
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(320, 70)
Start-Sleep -Milliseconds 200
# Click
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse {
    [DllImport("user32.dll")]
    public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public const int MOUSEEVENTF_LEFTDOWN = 0x02;
    public const int MOUSEEVENTF_LEFTUP = 0x04;
}
"@
[Mouse]::mouse_event([Mouse]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[Mouse]::mouse_event([Mouse]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
Write-Output 'Clicked'
