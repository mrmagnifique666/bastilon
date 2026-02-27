# Create Kingston Heartbeat shortcut in Windows Startup folder
# This makes Kingston auto-start when you log in

$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'Kingston Heartbeat.lnk'
$targetPath = 'C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\start-kingston.bat'
$workDir = 'C:\Users\Nicolas\Documents\Claude\claude-telegram-relay'

# Create shortcut via WScript.Shell COM object
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $workDir
$shortcut.WindowStyle = 7  # Minimized
$shortcut.Description = 'Kingston AI Heartbeat - Bastilon OS'
$shortcut.Save()

Write-Host ''
Write-Host '=== Raccourci cree dans le dossier Demarrage ===' -ForegroundColor Green
Write-Host ('  Emplacement: ' + $shortcutPath)
Write-Host ('  Cible:       ' + $targetPath)
Write-Host '  Fenetre:     Minimisee'
Write-Host ''
Write-Host '  Kingston demarrera automatiquement a chaque connexion Windows.'
Write-Host '  Pour desactiver: supprime le raccourci dans shell:startup'
Write-Host ''
