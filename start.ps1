# Bastilon OS — Auto-Restart Wrapper
# Usage: powershell -ExecutionPolicy Bypass -File start.ps1
#
# Automatically restarts the bot on crash with port cleanup.
# Press Ctrl+C to stop completely.

$ErrorActionPreference = "Continue"
$RestartDelay = 5       # seconds between restarts
$MaxRestarts = 50       # max restarts before giving up (reset on 10min+ uptime)
$MinUptimeReset = 600   # seconds of uptime to reset crash counter

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$crashCount = 0

function Cleanup-Ports {
    # Kill processes on voice (3100) and dashboard (3200) ports
    foreach ($port in @(3100, 3200)) {
        $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
        foreach ($conn in $connections) {
            if ($conn.OwningProcess -gt 0) {
                $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
                if ($proc -and $proc.ProcessName -eq "node") {
                    Write-Host "[restart] Killing stale node process on port $port (PID $($conn.OwningProcess))" -ForegroundColor Yellow
                    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
}

function Cleanup-Lock {
    $lockFile = Join-Path $scriptDir "relay\bot.lock"
    if (Test-Path $lockFile) {
        try {
            $lock = Get-Content $lockFile | ConvertFrom-Json
            $proc = Get-Process -Id $lock.pid -ErrorAction SilentlyContinue
            if (-not $proc) {
                Write-Host "[restart] Removing stale lock file (PID $($lock.pid) not running)" -ForegroundColor Yellow
                Remove-Item $lockFile -Force
            }
        } catch {
            Write-Host "[restart] Removing unreadable lock file" -ForegroundColor Yellow
            Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Bastilon OS — Auto-Restart Wrapper" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

while ($true) {
    $crashCount++
    if ($crashCount -gt $MaxRestarts) {
        Write-Host "[restart] Max restarts ($MaxRestarts) reached. Stopping." -ForegroundColor Red
        break
    }

    # Pre-start cleanup
    Cleanup-Lock
    Cleanup-Ports
    Start-Sleep -Seconds 1

    $startTime = Get-Date
    Write-Host "[restart] Starting Bastilon OS (attempt #$crashCount)..." -ForegroundColor Green

    # Run the bot
    try {
        $process = Start-Process -FilePath "npx" -ArgumentList "tsx", "src/index.ts" -NoNewWindow -PassThru -Wait
        $exitCode = $process.ExitCode
    } catch {
        $exitCode = 1
        Write-Host "[restart] Process start failed: $_" -ForegroundColor Red
    }

    $uptime = (Get-Date) - $startTime
    $uptimeStr = "{0:mm\:ss}" -f $uptime

    # Reset crash counter if bot ran long enough (stable)
    if ($uptime.TotalSeconds -ge $MinUptimeReset) {
        $crashCount = 0
        Write-Host "[restart] Bot was stable for $($uptime.ToString('hh\:mm\:ss')) — crash counter reset" -ForegroundColor Cyan
    }

    Write-Host ""
    Write-Host "[restart] Bot exited with code $exitCode after $uptimeStr" -ForegroundColor Yellow

    # Clean exit (Ctrl+C / SIGINT) — don't restart
    if ($exitCode -eq 0) {
        Write-Host "[restart] Clean exit — not restarting." -ForegroundColor Green
        break
    }

    Write-Host "[restart] Restarting in $RestartDelay seconds..." -ForegroundColor Yellow
    Start-Sleep -Seconds $RestartDelay
}

Write-Host "[restart] Bastilon OS stopped." -ForegroundColor Red
