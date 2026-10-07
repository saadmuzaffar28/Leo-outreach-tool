# Star Billing Outreach - one-click dev environment launcher.
# Verifies the PostgreSQL Windows service (LeoPostgres) is up, then starts the
# Next.js dev app and the send worker if they are not already running, and
# opens the browser.
#
# PostgreSQL is NEVER launched from this script. It is owned by the Service
# Control Manager (service `LeoPostgres`, Session 0, port 5438). Spawning it
# from a launcher puts postgres.exe in the interactive console session - the
# exact architecture that produced the conhost popup windows. Production does
# not use this script either: it runs the three apps under PM2 (see
# ecosystem.config.cjs).

$ErrorActionPreference = "Continue"
$proj = Split-Path -Parent $PSScriptRoot
Set-Location $proj

function Test-PortListening([int]$port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Get-NodeProcsWith([string]$needle) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $needle }
}

$started = @()

# ---- 1. PostgreSQL Windows service (LeoPostgres, port 5438) ----
# The ONLY thing allowed here is to observe the service, and at most to start
# it. Never `node scripts/dev-db.mjs`: PM2 -> node.exe -> postgres.exe is the
# popup-producing architecture this migration removed.
if (Test-PortListening 5438) {
  Write-Host "[launcher] DB already listening on 5438"
} else {
  $dbSvc = Get-Service -Name "LeoPostgres" -ErrorAction SilentlyContinue
  if (-not $dbSvc) {
    Write-Host "[launcher] ERROR: Windows service 'LeoPostgres' is not installed."
    Write-Host "[launcher] Install it with scripts\migrate-to-service.ps1 from an elevated shell."
    Write-Host "[launcher] NOT starting PostgreSQL from this script."
  } else {
    Write-Host "[launcher] starting Windows service LeoPostgres..."
    try {
      Start-Service -Name "LeoPostgres" -ErrorAction Stop
      $dbReady = $false
      for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 1000
        if (Test-PortListening 5438) { $dbReady = $true; break }
      }
      if ($dbReady) { Write-Host "[launcher] DB ready (service LeoPostgres)" }
      else { Write-Host "[launcher] WARNING: LeoPostgres started but 5438 not listening after 60s" }
    } catch {
      Write-Host "[launcher] ERROR: could not start LeoPostgres: $($_.Exception.Message)"
      Write-Host "[launcher] Starting a service needs an elevated shell: Start-Service LeoPostgres"
    }
  }
}

# ---- 2. Next.js dev server (port 3001) ----
if (Test-PortListening 3001) {
  Write-Host "[launcher] Web app already running on 3001"
} else {
  Write-Host "[launcher] starting web app..."
  $proc = Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev" `
    -WorkingDirectory $proj -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $proj "dev.log") `
    -RedirectStandardError (Join-Path $proj "dev.log.err") -PassThru
  $proc.Id | Out-File -FilePath (Join-Path $proj ".dev.pid") -Encoding ascii
  $webReady = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 1000
    try {
      $resp = Invoke-WebRequest -Uri "http://localhost:3001/login" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      if ($resp.StatusCode -eq 200 -or $resp.StatusCode -eq 307) { $webReady = $true; break }
    } catch {}
  }
  if (-not $webReady) { Write-Host "[launcher] WARNING: web app not responding after 60s - check dev.log" }
  else { Write-Host "[launcher] Web app ready (pid $($proc.Id))" }
}

# ---- 3. Send worker ----
if (Get-NodeProcsWith "worker") {
  Write-Host "[launcher] Worker already running"
} else {
  Write-Host "[launcher] starting send worker..."
  $proc = Start-Process -FilePath "npm.cmd" -ArgumentList "run","worker" `
    -WorkingDirectory $proj -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $proj "worker.log") `
    -RedirectStandardError (Join-Path $proj "worker.log.err") -PassThru
  $proc.Id | Out-File -FilePath (Join-Path $proj ".worker.pid") -Encoding ascii
  $started += $proc.Id
  Write-Host "[launcher] Worker started (pid $($proc.Id))"
}

# ---- 4. Open the app ----
Start-Sleep -Milliseconds 500
Start-Process "http://localhost:3001"

Write-Host "[launcher] Star Billing Outreach is running at http://localhost:3001"
