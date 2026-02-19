Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\desktop.png')
# Crop left monitor (0,0 to 1920,1080)
$rect = New-Object System.Drawing.Rectangle(0, 0, 1920, 1080)
$bmp = New-Object System.Drawing.Bitmap(1920, 1080)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\left_monitor.png')
$g.Dispose()
$bmp.Dispose()
$src.Dispose()

# Crop right monitor
$src2 = [System.Drawing.Image]::FromFile('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\desktop.png')
$rect2 = New-Object System.Drawing.Rectangle(1920, 0, 1920, 1080)
$bmp2 = New-Object System.Drawing.Bitmap(1920, 1080)
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$g2.DrawImage($src2, 0, 0, $rect2, [System.Drawing.GraphicsUnit]::Pixel)
$bmp2.Save('C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\relay\temp\right_monitor.png')
$g2.Dispose()
$bmp2.Dispose()
$src2.Dispose()
Write-Output 'Cropped'
