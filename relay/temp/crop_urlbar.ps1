Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\desktop.png')
$rect = New-Object System.Drawing.Rectangle(0, 0, 1200, 30)
$bmp = New-Object System.Drawing.Bitmap(1200, 30)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\urlbar.png')
$g.Dispose()
$bmp.Dispose()
$src.Dispose()
Write-Output 'done'
