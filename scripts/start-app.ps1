# Star Billing Outreach - one-click dev environment launcher.
# Starts the embedded Postgres DB, the Next.js app, and the send worker (only if not already running), then opens the browser.

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

# ---- 1. Embedded PostgreSQL (port 5438) ----
if (Test-PortListening 5438) {
  Write-Host "[launcher] DB already running on 5438"
} else {
  Write-Host "[launcher] starting database..."
  $proc = Start-Process -FilePath "node.exe" -ArgumentList "scripts/dev-db.mjs" `
    -WorkingDirectory $proj -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $proj "db.log") `
    -RedirectStandardError (Join-Path $proj "db.log.err") -PassThru
  $proc.Id | Out-File -FilePath (Join-Path $proj ".devdb.pid") -Encoding ascii
  $dbReady = $false
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Milliseconds 1000
    if (Test-PortListening 5438) { $dbReady = $true; break }
  }
  if (-not $dbReady) { Write-Host "[launcher] WARNING: DB not responding after 45s - check db.log" }
  else { Write-Host "[launcher] DB ready (pid $($proc.Id))" }
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
