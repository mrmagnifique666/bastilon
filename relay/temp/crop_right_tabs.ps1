Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\desktop.png')
# Right monitor tabs
$rect = New-Object System.Drawing.Rectangle(1920, 0, 1920, 30)
$bmp = New-Object System.Drawing.Bitmap(1920, 30)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\right_tabs.png')
$g.Dispose()
$bmp.Dispose()
$src.Dispose()
Write-Output 'done'
