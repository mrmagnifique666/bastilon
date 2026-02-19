Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\desktop.png')

# Crop center of left monitor where Kingston profile is visible
$rect = New-Object System.Drawing.Rectangle(500, 30, 900, 700)
$bmp = New-Object System.Drawing.Bitmap(900, 700)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\profile_center.png')
$g.Dispose()
$bmp.Dispose()
$src.Dispose()
Write-Output 'done'
