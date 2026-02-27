# Kingston Heartbeat - Windows Task Scheduler Installation
# Run: powershell -ExecutionPolicy Bypass -File install-task.ps1

$taskName = 'KingstonHeartbeat'
$batPath = 'C:\Users\Nicolas\Documents\Claude\claude-telegram-relay\start-kingston.bat'
$workDir = 'C:\Users\Nicolas\Documents\Claude\claude-telegram-relay'

# Remove existing task if present
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Action: run the bat file via cmd.exe
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $batPath + '"') -WorkingDirectory $workDir

# Trigger: at user logon
$trigger = New-ScheduledTaskTrigger -AtLogon

# Settings: survive battery, restart on failure, don't stop on idle
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -RestartInterval (New-TimeSpan -Minutes 5) -RestartCount 999 -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 365)

# Register the task
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Kingston AI Heartbeat - Bastilon OS' -Force

Write-Host ''
Write-Host '=== Kingston Heartbeat task created ===' -ForegroundColor Green
Write-Host ('  Name:    ' + $taskName)
Write-Host '  Trigger: At logon'
Write-Host '  Restart: Every 5 min on failure'
Write-Host ('  Script:  ' + $batPath)
Write-Host ''
