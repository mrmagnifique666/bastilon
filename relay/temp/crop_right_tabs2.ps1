Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\desktop.png')
# Right part of right monitor tabs
$rect = New-Object System.Drawing.Rectangle(3400, 0, 440, 25)
$bmp = New-Object System.Drawing.Bitmap(440, 25)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\right_tabs_end.png')
$g.Dispose()
$bmp.Dispose()
$src.Dispose()
Write-Output 'done'
