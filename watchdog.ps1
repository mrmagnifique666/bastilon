# Kingston Watchdog — runs via Windows Task Scheduler every 5 minutes
# Checks if the bot wrapper is running, restarts if dead.

$ProjectDir = "C:\Users\Nicolas\Documents\Claude\claude-telegram-relay"
$LockFile = Join-Path $ProjectDir "relay\bot.lock"
$LogFile = Join-Path $ProjectDir "relay\watchdog.log"
$WrapperLog = Join-Path $ProjectDir "relay\wrapper-output.log"

function Write-Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
    "$ts [watchdog] $msg" | Tee-Object -FilePath $LogFile -Append
}

# Check if any node process is running wrapper.ts or index.ts for this project
$botProcesses = Get-WmiObject Win32_Process -Filter "Name='node.exe'" 2>$null |
    Where-Object { $_.CommandLine -match "claude-telegram-relay" }

if ($botProcesses) {
    # Bot is running — check if it's actually responsive (lock file exists and is recent)
    if (Test-Path $LockFile) {
        $lockAge = (Get-Date) - (Get-Item $LockFile).LastWriteTime
        if ($lockAge.TotalMinutes -gt 30) {
            Write-Log "Lock file is stale ($([int]$lockAge.TotalMinutes)min old) — bot may be hung"
            # Don't restart yet, just log. Next check will catch if truly dead.
        }
    }
    # Bot is alive, nothing to do
    exit 0
}

# Bot is NOT running — restart it
Write-Log "Bot not running! Starting wrapper..."

# Clean stale lock
if (Test-Path $LockFile) {
    Remove-Item $LockFile -Force
    Write-Log "Removed stale lock file"
}

# Kill any orphan node processes on our ports
foreach ($port in @(3100, 3200, 3300)) {
    $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($conn) {
        $pid = $conn.OwningProcess
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        Write-Log "Killed orphan process on port $port (PID $pid)"
    }
}

# Start the wrapper (detached, output to log)
Start-Process -FilePath "npx" `
    -ArgumentList "tsx", "src/wrapper.ts" `
    -WorkingDirectory $ProjectDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $WrapperLog `
    -RedirectStandardError (Join-Path $ProjectDir "relay\wrapper-err.log")

Write-Log "Wrapper started successfully"
