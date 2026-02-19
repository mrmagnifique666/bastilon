Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\desktop.png')
# Lower section of left monitor - profile content area
$rect = New-Object System.Drawing.Rectangle(200, 400, 1400, 680)
$bmp = New-Object System.Drawing.Bitmap(1400, 680)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\profile_bottom.png')
$g.Dispose()
$bmp.Dispose()
$src.Dispose()
Write-Output 'done'
