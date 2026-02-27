# Create Kingston Heartbeat shortcut on Desktop (normal window)

$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'Kingston Heartbeat.lnk'
$targetPath = 'C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\start-kingston.bat'
$workDir = 'C:\Users\Nicolas\Documents\Claude\claude-telegram-relay'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $workDir
$shortcut.WindowStyle = 1
$shortcut.Description = 'Kingston AI Heartbeat - Bastilon OS'
$shortcut.Save()

Write-Host 'Raccourci bureau mis a jour!'
