Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\desktop.png')
# Crop the top-center of the left monitor where the profile content would be
# The profile page content area - around x:200-900, y:0-600
$rect = New-Object System.Drawing.Rectangle(200, 0, 700, 600)
$bmp = New-Object System.Drawing.Bitmap(700, 600)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\profile_area.png')
$g.Dispose()
$bmp.Dispose()
$src.Dispose()
Write-Output 'Cropped profile area'
