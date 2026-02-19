Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\desktop.png')

# Crop the right side of left monitor - where the main feed/profile content is
$rect = New-Object System.Drawing.Rectangle(1100, 30, 820, 1050)
$bmp = New-Object System.Drawing.Bitmap(820, 1050)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\profile_right.png')
$g.Dispose()
$bmp.Dispose()
$src.Dispose()
Write-Output 'done'
