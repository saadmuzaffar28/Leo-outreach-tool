# LeoPostgres service migration - READ THIS FIRST
#
# Run this in an ELEVATED (Administrator) PowerShell window.
# Run it as a whole script, not line by line, so the rollback trap can fire.
#
# SAFE BY CONSTRUCTION:
#   - Never runs initdb. The cluster already exists and is verified before start.
#   - Never drops/creates/alters any database.
#   - Never deletes anything inside .pgdata.
#   - Never uses taskkill /IM or taskkill /T.
#   - The PM2 leo-db process is stopped ONLY after the service is registered
#     and its configuration has been verified.
#   - If the service does not become healthy, the trap restores leo-db under PM2.

$ErrorActionPreference = 'Continue'

# ------------------------------------------------------------------ constants
# Data directory verified three ways: Test-Path, postmaster.pid line 2, and the
# running postmaster's command line. NOTE: the correct path contains "\.pgdata".
# The earlier "C:\deploy\Leo-outreach-tool.pgdata" spelling does NOT exist and
# would make PostgreSQL attempt initdb on an empty directory.
$PGDATA   = 'C:\deploy\Leo-outreach-tool\.pgdata'
$BINDIR   = 'C:\deploy\Leo-outreach-tool\node_modules\@embedded-postgres\windows-x64\native\bin'
$PGCTL    = Join-Path $BINDIR 'pg_ctl.exe'
$PGEXE    = Join-Path $BINDIR 'postgres.exe'
$PGPORT   = 5438
$SVC      = 'LeoPostgres'
$SVCACCT  = 'NT AUTHORITY\NetworkService'

function Say($m) { Write-Host ("`n=== {0} ===" -f $m) }
function Ok($m)  { Write-Host ("  [OK]   {0}" -f $m) }
function Bad($m) { Write-Host ("  [FAIL] {0}" -f $m) -ForegroundColor Red }

# ------------------------------------------------------------------ 1. preflight
Say "1. Preconditions"
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "NOT ELEVATED. Open PowerShell as Administrator and re-run." }
Ok "Elevated as $($id.Name)"

foreach ($p in @($PGEXE, $PGCTL, $PGDATA)) {
    if (-not (Test-Path $p)) { throw "Missing required path: $p" }
}
Ok "postgres.exe, pg_ctl.exe and data directory all exist"

if (-not (Test-Path (Join-Path $PGDATA 'PG_VERSION'))) {
    throw "No PG_VERSION in $PGDATA - this does not look like a real cluster. Refusing to continue."
}
$pgver = (Get-Content (Join-Path $PGDATA 'PG_VERSION') -Raw).Trim()
Ok "Existing cluster confirmed, PG_VERSION=$pgver (initdb will NOT be run)"

Say "2. Record pre-change state"
$prePortOwner = (Get-NetTCPConnection -LocalPort $PGPORT -State Listen -ErrorAction SilentlyContinue |
                 Select-Object -First 1).OwningProcess
$prePostmaster = if (Test-Path (Join-Path $PGDATA 'postmaster.pid')) {
    (Get-Content (Join-Path $PGDATA 'postmaster.pid') -TotalCount 1).Trim()
} else { $null }
Write-Host ("  Port {0} currently held by PID {1}" -f $PGPORT, $prePortOwner)
Write-Host ("  Current postmaster PID: {0}" -f $prePostmaster)

# Pre-change popup count, read from the enumerate-popups output already on disk
# is not reliable here, so count visible Windows Terminal console windows directly.
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class WTCount {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  public static int Count() {
    int n = 0;
    EnumWindows((h,l) => {
      var cn = new StringBuilder(256); GetClassNameW(h, cn, 256);
      var sb = new StringBuilder(2048); GetWindowTextW(h, sb, 2048);
      if (cn.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS" && IsWindowVisible(h)
          && sb.ToString().IndexOf("postgres", StringComparison.OrdinalIgnoreCase) >= 0) n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
'@
$prePopups = [WTCount]::Count()
Write-Host ("  PRE-change visible PostgreSQL console windows: {0}" -f $prePopups)

# ------------------------------------------------------- 3. rollback trap setup
$pm2Stopped = $false
function Rollback {
    Say "ROLLBACK: restoring PM2 leo-db"
    try { Stop-Service -Name $SVC -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Seconds 2
    try { & $PGCTL unregister -N $SVC 2>&1 | Out-Null } catch {}
    if ($pm2Stopped) {
        pm2 start ecosystem.config.cjs --only leo-db 2>&1 | Out-Null
        $pm2Stopped = $false
        Start-Sleep -Seconds 12
    }
    $listen = (Get-NetTCPConnection -LocalPort $PGPORT -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($listen -gt 0) { Ok "Port $PGPORT is LISTENING again under PM2" }
    else { Bad "Port $PGPORT is NOT listening - run: pm2 logs leo-db" }
}
trap { Rollback; break }

# ---------------------------------------------------------- 4. ACL for the account
Say "3. Grant minimum ACL to $SVCACCT on the data directory"
# Scoped to NETWORK SERVICE only. No Everyone, no Users, no broad grants.
& icacls.exe $PGDATA /grant "$SVCACCT`:(OI)(CI)M" 2>&1 | Out-String | Write-Host
$acl = Get-Acl $PGDATA
$granted = $acl.Access | Where-Object { $_.IdentityReference -like '*NETWORK SERVICE*' }
if ($granted) {
    foreach ($g in $granted) { Ok "ACL: $($g.IdentityReference) -> $($g.FileSystemRights)" }
} else {
    Bad "NETWORK SERVICE ACE not found after icacls"
}

# ------------------------------------------------------------- 5. register service
Say "4. Register $SVC via pg_ctl register"
& $PGCTL register -N $SVC -D $PGDATA -S auto -o "-p $PGPORT" -U $SVCACCT 2>&1 | Out-String | Write-Host
Start-Sleep -Seconds 3

if (-not (Get-Service -Name $SVC -ErrorAction SilentlyContinue)) {
    Bad "Service $SVC was not created."
    throw "register failed"
}
Ok "Service $SVC exists"

# --------------------------------------------------------------- 6. verify config
Say "5. Verify service configuration (BEFORE stopping leo-db)"
& sc.exe qc $SVC 2>&1 | Out-String | Write-Host
& sc.exe qfailure $SVC 2>&1 | Out-String | Write-Host

$svc = Get-CimInstance Win32_Service -Filter "Name='$SVC'"
Write-Host ("  binPath  : {0}" -f $svc.PathName)
Write-Host ("  account  : {0}" -f $svc.StartName)
Write-Host ("  startMode: {0}" -f $svc.StartMode)
Write-Host ("  state    : {0}" -f $svc.State)

$binOk = $svc.PathName -like "*pg_ctl*"
$portOk = $svc.PathName -like "*5438*"
$dataOk = $svc.PathName -like "*Leo-outreach-tool*"
Write-Host ("  binPath points at pg_ctl : {0}" -f $binOk)
Write-Host ("  binPath carries port 5438: {0}" -f $portOk)
Write-Host ("  binPath carries data dir : {0}" -f $dataOk)
Write-Host ("  runs as NetworkService   : {0}" -f ($svc.StartName -like '*NetworkService*'))
Write-Host ("  starts automatically     : {0}" -f ($svc.StartMode -eq 'Auto'))

if (-not ($binOk -and $portOk -and $dataOk)) {
    Bad "Service configuration does not match expectations. Aborting before touching leo-db."
    throw "config verification failed"
}

# --------------------------------------------- 7. stop ONLY leo-db, then start
Say "6. Stop PM2 leo-db (only this one) and hand the port to the service"
pm2 stop leo-db 2>&1 | Out-String | Write-Host
$pm2Stopped = $true

# Wait for the port to be released so the service can bind it.
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
    $still = (Get-NetTCPConnection -LocalPort $PGPORT -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($still -eq 0) { break }
    Start-Sleep -Seconds 2
}
$still = (Get-NetTCPConnection -LocalPort $PGPORT -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
if ($still -ne 0) {
    Bad "Port $PGPORT still held after stopping leo-db. Aborting and restoring."
    throw "port not released"
}
Ok "Port $PGPORT released"

Say "7. Start service $SVC"
Start-Service -Name $SVC -ErrorAction Stop
Ok "start issued"

# ------------------------------------------------------------------ 8. readiness
Say "8. Wait for PostgreSQL to accept connections"
$ready = $false
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    $listen = (Get-NetTCPConnection -LocalPort $PGPORT -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
    if ($listen -gt 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $ready) {
    Bad "Service did not open port $PGPORT within 90s."
    Write-Host "--- service state ---"
    & sc.exe query $SVC 2>&1 | Out-String | Write-Host
    throw "service never became ready"
}
Ok "Port $PGPORT is LISTENING"

Write-Host "Waiting for the cluster to finish recovery..."
Start-Sleep -Seconds 15

# ------------------------------------------------------- 9. prove data survived
Say "9. Verify the database is the SAME cluster with data intact"
$conn = @'
const { Client } = require("pg");
(async () => {
  const c = new Client({ host: "127.0.0.1", port: 5438, user: "postgres",
                         password: "postgres", database: "star_billing_outreach" });
  await c.connect();
  const v = await c.query("select version()");
  const dbs = await c.query("select datname from pg_database where datistemplate = false order by datname");
  const tabs = await c.query(
    "select table_name from information_schema.tables where table_schema='public' order by table_name");
  const camp = await c.query("select count(*)::int as n from \"Campaign\"");
  console.log("VERSION=" + v.rows[0].version.split(",")[0]);
  console.log("DATABASES=" + dbs.rows.map(r => r.datname).join(","));
  console.log("PUBLIC_TABLES=" + tabs.rows.length);
  console.log("CAMPAIGN_ROWS=" + camp.rows[0].n);
  await c.end();
})().catch(e => { console.error("CONNFAIL:" + e.message); process.exit(1); });
'@
[System.IO.File]::WriteAllText("$env:TEMP\leo-verify.js", $conn, (New-Object System.Text.UTF8Encoding($false)))
$verify = & node "$env:TEMP\leo-verify.js" 2>&1 | Out-String
Write-Host $verify
if ($verify -notmatch 'VERSION=') {
    Bad "Database connection or query failed."
    throw "database verification failed"
}
Ok "Database reachable, schema present, data intact"

# --------------------------------------------------------------- 10. topology
Say "10. PostgreSQL process topology and session"
$svc = Get-CimInstance Win32_Service -Filter "Name='$SVC'"
Write-Host ("  service PID (svchost hosting the service): {0}" -f $svc.ProcessId)
$pmLine = if (Test-Path (Join-Path $PGDATA 'postmaster.pid')) {
    (Get-Content (Join-Path $PGDATA 'postmaster.pid') -TotalCount 1).Trim()
} else { $null }
$post = Get-CimInstance Win32_Process -Filter "ProcessId=$pmLine" -ErrorAction SilentlyContinue
if ($post) {
    Write-Host ("  postmaster PID {0}  session {1}" -f $post.ProcessId, $post.SessionId)
    Write-Host ("  postmaster parent PID {0}" -f $post.ParentProcessId)
    Write-Host ("  postmaster exe: {0}" -f $post.ExecutablePath)
} else {
    Write-Host ("  postmaster not found (pid file said {0})" -f $pmLine)
}
$kids = Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" |
        Where-Object { $_.ParentProcessId -eq [int]$pmLine }
Write-Host ("  PostgreSQL child count: {0}" -f $kids.Count)
$conhosts = Get-CimInstance Win32_Process -Filter "Name='conhost.exe'"
$withConsole = @()
foreach ($k in $kids) {
    $ch = @($conhosts | Where-Object { $_.ParentProcessId -eq $k.ProcessId })
    if ($ch.Count -gt 0) { $withConsole += $k.ProcessId }
}
Write-Host ("  children with a conhost attached: {0} {1}" -f $withConsole.Count, ($withConsole -join ','))

# ------------------------------------------------------------ 11. popup verdict
Say "11. Popup count AFTER"
$postPopups = [WTCount]::Count()
Write-Host ("  PRE-change  visible PostgreSQL console windows: {0}" -f $prePopups)
Write-Host ("  POST-change visible PostgreSQL console windows: {0}" -f $postPopups)

Say "12. Backend churn test (the previous popup trigger)"
$before = @((Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" |
             Where-Object { $_.ParentProcessId -eq [int]$pmLine -and $_.CommandLine -match 'backend' })).Count
1..5 | ForEach-Object {
    & node "$env:TEMP\leo-verify.js" 2>&1 | Out-Null
    Start-Sleep -Milliseconds 400
}
Start-Sleep -Seconds 3
$after = @((Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" |
            Where-Object { $_.ParentProcessId -eq [int]$pmLine -and $_.CommandLine -match 'backend' })).Count
$postChurnPopups = [WTCount]::Count()
Write-Host ("  live backends before churn: {0}" -f $before)
Write-Host ("  live backends after churn : {0}" -f $after)
Write-Host ("  visible PostgreSQL console windows after churn: {0}" -f $postChurnPopups)

# ------------------------------------------------------------------ 13. report
Say "13. Final state"
& sc.exe query $SVC 2>&1 | Out-String | Write-Host
pm2 list 2>&1 | Out-String | Write-Host
Write-Host ("  Old PM2-owned postmaster PID was: {0}" -f $prePostmaster)
Write-Host ("  New service-owned postmaster PID  : {0}" -f $pmLine)

Remove-Item "$env:TEMP\leo-verify.js" -Force -ErrorAction SilentlyContinue

if ($postChurnPopups -ne 0) {
    Bad "PostgreSQL console windows still present. Do NOT accept this as fixed."
} else {
    Ok "ZERO visible PostgreSQL console windows"
}
Write-Host "`nMigration finished. Do not delete the diagnostic scripts yet." -ForegroundColor Cyan