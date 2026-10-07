# LeoPostgres service migration - READ THIS FIRST
#
# Run this in an ELEVATED (Administrator) PowerShell window.
# Run it as a whole script, not line by line.
#
# SAFE BY CONSTRUCTION:
#   - Never runs initdb. The cluster already exists and is verified before start.
#   - Never drops/creates/alters any database.
#   - Never deletes anything inside .pgdata (a stale postmaster.pid is left for
#     PostgreSQL to reconcile itself - it only reclaims pid files whose pid is dead).
#   - Never writes to C:\deploy\Leo-outreach-pgdata-backup or C:\deploy\Leo-backups.
#   - Never uses taskkill /IM or taskkill /T.
#   - Never starts PostgreSQL through PM2, and rollback never restores `leo-db`.
#   - The pre-change state is "PostgreSQL stopped, port 5438 free", so rollback
#     only removes a service this script created. Nothing is destroyed.
#
# WHY THE TRAP IS DECLARED AT THE TOP (this was a real bug, not a typo):
#   PowerShell installs `trap` statements at PARSE time, before the script body
#   runs. The previous version declared `function Rollback` on line 90 and
#   `trap { Rollback; break }` on line 104, so any terminating error raised
#   BEFORE line 90 (e.g. the "NOT ELEVATED" throw on line 39) fired a trap whose
#   body called a function that did not exist yet. PowerShell then blamed line
#   104 and printed:
#       Rollback : The term 'Rollback' is not recognized as the name of a cmdlet...
#   Reproduced and confirmed against PowerShell 5.1.26100.9444. The fix is to
#   define the function and the trap before the first statement that can throw.

$ErrorActionPreference = 'Continue'

# ------------------------------------------------------------------ constants
# The live cluster lives in the OLD project. The fresh clone has no .pgdata and
# no node_modules, so both the data directory and the PostgreSQL binaries must
# be taken from the .old tree. Verified: PG_VERSION=18, postgres/pg_ctl 18.4.
$PGDATA      = 'C:\deploy\Leo-outreach-tool.old\.pgdata'
$BINDIR      = 'C:\deploy\Leo-outreach-tool.old\node_modules\@embedded-postgres\windows-x64\native\bin'
$OLDPROJ     = 'C:\deploy\Leo-outreach-tool.old'
$NEWPROJ     = 'C:\deploy\Leo-outreach-tool'
$OLDNODEMOD  = Join-Path $OLDPROJ 'node_modules'
$ENVFILE     = Join-Path $OLDPROJ '.env'
$PGCTL       = Join-Path $BINDIR 'pg_ctl.exe'
$PGEXE       = Join-Path $BINDIR 'postgres.exe'
$PGPORT      = 5438
$SVC         = 'LeoPostgres'
$SVCACCT     = 'NT AUTHORITY\NetworkService'
# NOTE: postgresql.conf leaves `#port = 5432` commented out, so the port can
# ONLY come from the -o option passed to postgres. If that is omitted the
# server binds 5432 and every application connection fails.
$PGOPTS      = "-p $PGPORT"

function Say($m) { Write-Host ("`n=== {0} ===" -f $m) }
function Ok($m)  { Write-Host ("  [OK]   {0}" -f $m) }
function Bad($m) { Write-Host ("  [FAIL] {0}" -f $m) -ForegroundColor Red }
function Note($m){ Write-Host ("  [ .. ] {0}" -f $m) -ForegroundColor DarkGray }

# PowerShell variable names are case-insensitive: `$svc` and `$SVC` are the SAME
# variable. Assigning a service object to `$svc` therefore silently overwrites the
# service name string, and every later `-Name $SVC` receives a CimInstance whose
# ToString() is 'Win32_Service: LeoPostgres (Name = "LeoPostgres")'. That produced
# a bogus "Cannot find any service" failure and, worse, made rollback report
# "Service no longer exists" while the service was in fact still installed.
# This guard turns that silent corruption into an immediate explicit failure.
function Assert-SvcName {
    if ($SVC -isnot [string] -or [string]::IsNullOrWhiteSpace($SVC)) {
        throw ('`$SVC has been corrupted (type = {0}). PowerShell variable names ' +
               'are case-insensitive - never assign a service object to `$svc.') -f
               $(if ($null -eq $SVC) { 'null' } else { $SVC.GetType().Name })
    }
}

# ------------------------------------------- rollback state, function and trap
# These MUST precede the first statement that can throw. See header comment.
$script:svcCreated   = $false   # becomes true only after pg_ctl register succeeds
$script:svcHealthy   = $false   # becomes true only after the service is verified up
$script:rollingBack  = $false   # recursion guard: a throw inside Rollback must not re-enter it
$script:tempVerify   = $null    # temp file to clean up

function Rollback {
    # NEVER: initdb, DROP, DELETE .pgdata, touch the backups, pm2 start leo-db.
    if ($script:rollingBack) { return }
    $script:rollingBack = $true

    Say "ROLLBACK"
    Assert-SvcName
    if (-not $script:svcCreated) {
        Note "Service was never created - nothing to undo."
        Note "Cluster in $PGDATA was not touched."
        $script:rollingBack = $false
        return
    }

    # NOTE: PowerShell variable names are case-insensitive, so `$svc` and `$SVC`
    # are the SAME variable. The service-object local must therefore never be
    # spelled `$svc` - doing so silently overwrites the service name string and
    # every later `... -Name $SVC` then receives a CimInstance instead of the
    # name. It is spelled $svcInfo throughout for that reason.
    $svcInfo = Get-Service -Name $SVC -ErrorAction SilentlyContinue
    if ($svcInfo) {
        if ($script:svcHealthy) {
            # A verified-healthy database is strictly better than the pre-change
            # state (which was: stopped). Leaving it up loses nothing and keeps
            # the application usable.
            Ok "Service is already healthy - leaving it RUNNING."
        } else {
            Note "Service created but not healthy - stopping and unregistering it."
            try { Stop-Service -Name $SVC -Force -ErrorAction SilentlyContinue } catch {}
            Start-Sleep -Seconds 2
            try { & $PGCTL unregister -N $SVC 2>&1 | Out-Null } catch {}
            $left = Get-Service -Name $SVC -ErrorAction SilentlyContinue
            if ($left) { Bad "Service $SVC still present - remove manually: sc.exe delete $SVC" }
            else { Ok "Service $SVC removed. Pre-change state restored (PostgreSQL stopped)." }
        }
    } else {
        Note "Service no longer exists."
    }

    $listen = @(Get-NetTCPConnection -LocalPort $PGPORT -State Listen -ErrorAction SilentlyContinue).Count
    if ($listen -gt 0) { Note "Port $PGPORT is listening (a server is up)." }
    else { Note "Port $PGPORT is free - matches the pre-change state." }

    if ($script:tempVerify -and (Test-Path $script:tempVerify)) {
        Remove-Item $script:tempVerify -Force -ErrorAction SilentlyContinue
    }

    Note "No database file, data directory or backup was modified by rollback."
    $script:rollingBack = $false
}
trap {
    Write-Host ("`nERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host ("       {0}" -f $_.InvocationInfo.PositionMessage) -ForegroundColor Red
    Rollback
    break
}

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

foreach ($p in @('base', 'global', 'pg_wal', 'postgresql.conf', 'pg_hba.conf')) {
    if (-not (Test-Path (Join-Path $PGDATA $p))) {
        throw "Cluster looks incomplete: $p missing from $PGDATA. Refusing to continue."
    }
}
Ok "Cluster layout complete: base, global, pg_wal, postgresql.conf, pg_hba.conf"

if (-not (Test-Path $ENVFILE)) {
    throw "Missing $ENVFILE - cannot read DATABASE_URL for verification. Refusing to continue."
}
$dbUrl = $null
$mUrl = Select-String -Path $ENVFILE -Pattern '^\s*DATABASE_URL\s*=' | Select-Object -First 1
if ($mUrl) { $dbUrl = ($mUrl.Line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"') }
if (-not $dbUrl) { throw "DATABASE_URL not found in $ENVFILE" }
if ($dbUrl -notmatch ":$PGPORT/") { throw "DATABASE_URL does not target port $PGPORT - refusing." }
Ok "DATABASE_URL targets port $PGPORT (password not printed)"

# ------------------------------------------------------- 2. pre-change baseline
Say "2. Record pre-change state (read-only)"
$prePortOwner = (Get-NetTCPConnection -LocalPort $PGPORT -State Listen -ErrorAction SilentlyContinue |
                 Select-Object -First 1).OwningProcess
$prePostmaster = if (Test-Path (Join-Path $PGDATA 'postmaster.pid')) {
    (Get-Content (Join-Path $PGDATA 'postmaster.pid') -TotalCount 1).Trim()
} else { $null }
$prePostgres = @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" -ErrorAction SilentlyContinue)
$prePm2 = @()
try { $prePm2 = @(pm2 jlist 2>$null | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).map(a=>a.name).join(','))}catch(e){}})" 2>$null) } catch {}

Write-Host ("  Port {0} held by PID        : {1}" -f $PGPORT, $(if ($prePortOwner) { $prePortOwner } else { "(free)" }))
Write-Host ("  postmaster.pid pid          : {0}" -f $(if ($prePostmaster) { $prePostmaster } else { "(absent)" }))
Write-Host ("  postgres.exe processes      : {0}" -f $prePostgres.Count)
Write-Host ("  PM2 app names              : {0}" -f $(if (@($prePm2).Count -and @($prePm2)[0]) { @($prePm2)[0] } else { "(none)" }))

# The expected pre-change state is: PostgreSQL stopped, port free, no PM2 db app.
# We do NOT start or stop anything to reach it - if it differs, abort and show why.
if ($prePortOwner) {
    throw "Port $PGPORT is already held by PID $prePortOwner. This script only migrates a STOPPED cluster. Investigate that PID first; refusing to act."
}
if ($prePostgres.Count -gt 0) {
    $ids = ($prePostgres | ForEach-Object { $_.ProcessId }) -join ','
    throw "postgres.exe is already running (pid: $ids). Refusing to register a second server against the same data directory."
}
Ok "Pre-change state is clean: port free, no postgres.exe"

if ($prePostmaster) {
    $alive = Get-Process -Id $prePostmaster -ErrorAction SilentlyContinue
    if ($alive) {
        throw "postmaster.pid says $prePostmaster and that process IS alive. A server may be running - refusing to touch the cluster."
    }
    Note "postmaster.pid pid $prePostmaster is NOT alive -> stale (cluster is stopped)."
    Note "It is left in place; PostgreSQL reclaims dead pid files by itself."
}

# Pre-change popup count: visible Windows Terminal windows titled with 'postgres'.
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
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

# ------------------------------------------------- 3. ACL for the service account
Say "3. Grant minimum ACL to $SVCACCT on the data directory"
# Scoped to NETWORK SERVICE only. No Everyone, no Users, no broad grants.
& icacls.exe $PGDATA /grant "$SVCACCT`:(OI)(CI)M" 2>&1 | Out-String | Write-Host
$acl = Get-Acl $PGDATA
$granted = $acl.Access | Where-Object { $_.IdentityReference -like '*NetworkService*' -or $_.IdentityReference -like '*NETWORK SERVICE*' }
if ($granted) {
    foreach ($g in $granted) { Ok "ACL: $($g.IdentityReference) -> $($g.FileSystemRights)" }
} else {
    throw "NetworkService ACE not found after icacls - the service would not be able to write to the data directory."
}

# ------------------------------------------------------------- 4. register service
# Must be idempotent: a previous run may already have created the service, and
# registering a second time fails with ERROR_SERVICE_EXISTS (1072). Reuse the
# service when its configuration already matches; re-create it when it does not.
Say "4. Register $SVC via pg_ctl register"
Assert-SvcName

$svcInfo = Get-Service -Name $SVC -ErrorAction SilentlyContinue
if ($svcInfo) {
    $cfg = Get-CimInstance Win32_Service -Filter "Name='$SVC'"
    $cfgOk = ($cfg.PathName -like '*pg_ctl*')     -and
             ($cfg.PathName -like '*5438*')        -and
             ($cfg.PathName -like '*Leo-outreach-tool.old*') -and
             ($cfg.StartName -like '*NetworkService*')
    if ($cfgOk) {
        Ok "Service $SVC already exists with a matching configuration - reusing it."
        $script:svcCreated = $true
    } else {
        Note "Service $SVC exists but is misconfigured - re-creating it."
        $script:svcCreated = $true   # we now own it either way
        try { Stop-Service -Name $SVC -Force -ErrorAction SilentlyContinue } catch {}
        Start-Sleep -Seconds 2
        & $PGCTL unregister -N $SVC 2>&1 | Out-String | Write-Host
        Start-Sleep -Seconds 2
        if (Get-Service -Name $SVC -ErrorAction SilentlyContinue) {
            throw "Pre-existing $SVC could not be unregistered."
        }
        & $PGCTL register -N $SVC -D $PGDATA -S auto -U $SVCACCT -o $PGOPTS -w 2>&1 | Out-String | Write-Host
        Start-Sleep -Seconds 3
    }
} else {
    & $PGCTL register -N $SVC -D $PGDATA -S auto -U $SVCACCT -o $PGOPTS -w 2>&1 | Out-String | Write-Host
    $script:svcCreated = $true   # only reached if register did not throw
    Start-Sleep -Seconds 3
}

if (-not (Get-Service -Name $SVC -ErrorAction SilentlyContinue)) {
    throw "Service $SVC was not created (pg_ctl register reported success but the service is absent)."
}
Ok "Service $SVC exists"

# Configure automatic recovery: if the service dies, SCM restarts it.
& sc.exe qfailure $SVC 2>&1 | Out-String | Write-Host
& sc.exe failure $SVC reset= 0 actions= restart/5000/restart/15000/restart/60000 2>&1 | Out-String | Write-Host

# --------------------------------------------------------------- 5. verify config
Say "5. Verify service configuration (BEFORE starting)"
& sc.exe qc $SVC 2>&1 | Out-String | Write-Host

$svcInfo = Get-CimInstance Win32_Service -Filter "Name='$SVC'"
Write-Host ("  binPath   : {0}" -f $svcInfo.PathName)
Write-Host ("  account   : {0}" -f $svcInfo.StartName)
Write-Host ("  startMode : {0}" -f $svcInfo.StartMode)
Write-Host ("  state     : {0}" -f $svcInfo.State)

$binOk   = $svcInfo.PathName -like "*pg_ctl*"
$portOk  = $svcInfo.PathName -like "*5438*"
$dataOk  = $svcInfo.PathName -like "*Leo-outreach-tool.old*"
$acctOk  = $svcInfo.StartName -like "*NetworkService*"
$modeOk  = $svcInfo.StartMode -eq 'Auto'
Write-Host ("  binPath points at pg_ctl          : {0}" -f $binOk)
Write-Host ("  binPath carries port 5438         : {0}" -f $portOk)
Write-Host ("  binPath carries .old data dir     : {0}" -f $dataOk)
Write-Host ("  runs as NetworkService            : {0}" -f $acctOk)
Write-Host ("  starts automatically              : {0}" -f $modeOk)

if (-not ($binOk -and $portOk -and $dataOk)) {
    throw "Service configuration does not match expectations. Aborting before starting anything."
}
if (-not $acctOk) { Bad "Service does not run as NetworkService - review before starting." }
if (-not $modeOk) { Bad "Service start mode is not Automatic." }
Ok "Service configuration verified"

# --------------------------------------------------------------- 6. start service
Say "6. Start service $SVC"
Assert-SvcName
Start-Service -Name $SVC -ErrorAction Stop
Ok "start issued"

# ------------------------------------------------------------------ 7. readiness
Say "7. Wait for PostgreSQL to accept connections on $PGPORT"
$ready = $false
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    $listen = @(Get-NetTCPConnection -LocalPort $PGPORT -State Listen -ErrorAction SilentlyContinue).Count
    if ($listen -gt 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $ready) {
    Bad "Service did not open port $PGPORT within 90s."
    Write-Host "--- sc query ---"
    & sc.exe query $SVC 2>&1 | Out-String | Write-Host
    Write-Host "--- sc qc ---"
    & sc.exe qc $SVC 2>&1 | Out-String | Write-Host
    throw "service never became ready"
}
Ok "Port $PGPORT is LISTENING"
Write-Host "Waiting for the cluster to finish crash recovery..."
Start-Sleep -Seconds 15

# ------------------------------------------------------- 8. prove data survived
Say "8. Verify the ORIGINAL database and its data"
$script:tempVerify = Join-Path $env:TEMP 'leo-verify.js'
$conn = @'
const { Client } = require("pg");
const url = process.env.LEO_VERIFY_URL;
(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const v = await c.query("select version()");
  const dbs = await c.query("select datname from pg_database where datistemplate = false order by datname");
  const tabs = await c.query(
    "select table_name from information_schema.tables where table_schema='public' order by table_name");
  const camp = await c.query('select count(*)::int as n from "Campaign"');
  const lead = await c.query('select count(*)::int as n from "Lead"');
  const smtp = await c.query('select count(*)::int as n from "SmtpAccount"');
  console.log("VERSION=" + v.rows[0].version.split(",")[0]);
  console.log("DATABASES=" + dbs.rows.map(r => r.datname).join(","));
  console.log("PUBLIC_TABLES=" + tabs.rows.length);
  console.log("CAMPAIGN_ROWS=" + camp.rows[0].n);
  console.log("LEAD_ROWS=" + lead.rows[0].n);
  console.log("SMTP_ROWS=" + smtp.rows[0].n);
  await c.end();
})().catch(e => { console.error("CONNFAIL:" + e.message); process.exit(1); });
'@
[System.IO.File]::WriteAllText($script:tempVerify, $conn, (New-Object System.Text.UTF8Encoding($false)))
# The fresh clone has no node_modules, so resolve `pg` from the old tree.
$env:NODE_PATH = $OLDNODEMOD
$env:LEO_VERIFY_URL = $dbUrl
$verify = & node $script:tempVerify 2>&1 | Out-String
Write-Host $verify
if ($verify -notmatch 'VERSION=' -or $verify -match 'CONNFAIL:') {
    throw "database verification failed"
}
Ok "Database reachable, schema present, data intact"

# --------------------------------------------------------------- 9. topology
Say "9. PostgreSQL process topology and session"
$svcInfo = Get-CimInstance Win32_Service -Filter "Name='$SVC'"
Write-Host ("  SCM service PID (host process)  : {0}" -f $svcInfo.ProcessId)
$pmLine = if (Test-Path (Join-Path $PGDATA 'postmaster.pid')) {
    (Get-Content (Join-Path $PGDATA 'postmaster.pid') -TotalCount 1).Trim()
} else { $null }
$post = Get-CimInstance Win32_Process -Filter "ProcessId=$pmLine" -ErrorAction SilentlyContinue
if (-not $post) { throw "postmaster pid $pmLine not found - cannot verify session." }

Write-Host ("  postmaster PID                  : {0}" -f $post.ProcessId)
Write-Host ("  postmaster SessionId            : {0}" -f $post.SessionId)
Write-Host ("  postmaster ParentProcessId      : {0}" -f $post.ParentProcessId)
Write-Host ("  postmaster ExecutablePath       : {0}" -f $post.ExecutablePath)

$kids = @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" |
          Where-Object { $_.ParentProcessId -eq [int]$pmLine })
Write-Host ("  PostgreSQL child count          : {0}" -f $kids.Count)
foreach ($k in $kids) { Write-Host ("     child pid={0} session={1}" -f $k.ProcessId, $k.SessionId) }

$allPg = @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'")
$sessions = @($allPg | ForEach-Object { $_.SessionId } | Sort-Object -Unique)
Write-Host ("  distinct sessions of postgres   : {0}" -f ($sessions -join ','))

# conhost relationships
$conhosts = @(Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" -ErrorAction SilentlyContinue)
Write-Host ("  conhost.exe processes           : {0}" -f $conhosts.Count)
$withConsole = @()
foreach ($k in $allPg) {
    $ch = @($conhosts | Where-Object { $_.ParentProcessId -eq $k.ProcessId })
    if ($ch.Count -gt 0) { $withConsole += $k.ProcessId }
}
Write-Host ("  postgres.exe with conhost child : {0} {1}" -f $withConsole.Count, ($withConsole -join ','))

# Session assertions - the whole point of the migration.
if ($post.SessionId -ne 0) {
    throw "postmaster SessionId is $($post.SessionId), expected 0. PostgreSQL is NOT running as a Session 0 service."
}
Ok "postmaster is in Session 0"
$badSessions = @($sessions | Where-Object { $_ -ne 0 })
if ($badSessions.Count -gt 0) {
    throw "postgres.exe running outside Session 0: sessions $($badSessions -join ','). Refusing to call this a success."
}
Ok "ALL postgres.exe processes are in Session 0"
if ($post.ExecutablePath -notlike "$OLDPROJ\*") {
    Bad "postmaster is not running from $OLDPROJ binaries: $($post.ExecutablePath)"
} else {
    Ok "postmaster runs from the expected binary path"
}
# The parent must be the service host process reported by the SCM, i.e. the chain
# must be: services.exe (SCM) -> service host process -> postgres.exe.
# NOTE: for a pg_ctl-registered PostgreSQL service the service host process is
# pg_ctl.exe, NOT svchost.exe - pg_ctl is installed as a WIN32_OWN_PROCESS
# service that itself spawns the postmaster. What matters is that the parent IS
# the SCM's service process (and is never node.exe / PM2 or an interactive shell).
$scmHostPid = (Get-CimInstance Win32_Service -Filter "Name='$SVC'" -ErrorAction SilentlyContinue).ProcessId
if (-not $scmHostPid) {
    throw "Cannot read the SCM service process for $SVC - cannot prove the postmaster is service-owned."
}
if ($post.ParentProcessId -eq 0) {
    Ok "postmaster parent is pid 0 (SCM-attached) - not PM2, not an interactive shell"
} elseif ($post.ParentProcessId -eq $scmHostPid) {
    $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($post.ParentProcessId)" -ErrorAction SilentlyContinue
    $gp  = Get-CimInstance Win32_Process -Filter "ProcessId=$($par.ParentProcessId)" -ErrorAction SilentlyContinue
    Write-Host ("  service host process            : {0} (pid {1}, session {2})" -f $par.Name, $par.ProcessId, $par.SessionId)
    Write-Host ("  service host parent             : {0} (pid {1})" -f $gp.Name, $gp.ProcessId)
    if ($par.Name -like 'node*') {
        throw "postmaster parent is node.exe - PostgreSQL is being spawned by PM2. Refusing to call this a success."
    }
    if ($gp.Name -ne 'services.exe') {
        Bad "service host parent is '$($gp.Name)' - expected services.exe (SCM)."
    } else {
        Ok "parent chain is SCM -> $($par.Name) -> postgres.exe (service-owned, not PM2)"
    }
} else {
    throw "postmaster parent pid $($post.ParentProcessId) is NOT the SCM service host ($scmHostPid). Refusing to call this a success."
}

# ------------------------------------------------------------ 10. popup verdict
Say "10. Popup count AFTER"
$postPopups = [WTCount]::Count()
Write-Host ("  PRE-change  visible PostgreSQL console windows: {0}" -f $prePopups)
Write-Host ("  POST-change visible PostgreSQL console windows: {0}" -f $postPopups)

# ------------------------------------------- 11. backend churn test (the trigger)
Say "11. Backend churn test (5 short-lived connections - previous popup trigger)"
$before = @((Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" |
             Where-Object { $_.ParentProcessId -eq [int]$pmLine })).Count
1..5 | ForEach-Object {
    & node $script:tempVerify 2>&1 | Out-Null
    Write-Host ("  connection {0} done (exit {1})" -f $_, $LASTEXITCODE)
    Start-Sleep -Milliseconds 400
}
Start-Sleep -Seconds 3
$after = @((Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" |
            Where-Object { $_.ParentProcessId -eq [int]$pmLine })).Count
$churnPopups = [WTCount]::Count()
$churnSessions = @((Get-CimInstance Win32_Process -Filter "Name='postgres.exe'") |
                   ForEach-Object { $_.SessionId } | Sort-Object -Unique)
Write-Host ("  postgres.exe processes before churn : {0}" -f $before)
Write-Host ("  postgres.exe processes after churn  : {0}" -f $after)
Write-Host ("  sessions after churn                : {0}" -f ($churnSessions -join ','))
Write-Host ("  visible PostgreSQL windows after churn: {0}" -f $churnPopups)

if ($churnSessions -and (@($churnSessions | Where-Object { $_ -ne 0 }).Count -gt 0)) {
    throw "postgres.exe appeared outside Session 0 during churn. FAIL."
}
Ok "postgres.exe stayed in Session 0 through the churn test"

# ------------------------------------------------------------------ 12. report
Say "12. Final state"
& sc.exe query $SVC 2>&1 | Out-String | Write-Host
pm2 list 2>&1 | Out-String | Write-Host
Write-Host ("  Old PM2-owned postmaster PID : {0}" -f $prePostmaster)
Write-Host ("  New service postmaster PID   : {0}" -f $pmLine)
Write-Host ("  Old project path             : {0}" -f $OLDPROJ)
Write-Host ("  New project path             : {0}" -f $NEWPROJ)

$script:svcHealthy = $true
if ($script:tempVerify -and (Test-Path $script:tempVerify)) {
    Remove-Item $script:tempVerify -Force -ErrorAction SilentlyContinue
    $script:tempVerify = $null
}

if ($churnPopups -ne 0) {
    Bad "PostgreSQL console windows still present. Do NOT accept this as fixed."
} else {
    Ok "ZERO visible PostgreSQL console windows"
}

Write-Host "`nPost-migration state (completed 2026-10-06):" -ForegroundColor Cyan
Write-Host "  [done] leo-db removed from ecosystem.config.cjs - PM2 must not manage PostgreSQL"
Write-Host "  [done] scripts/dev-db.mjs + scripts/lib/pg-supervisor.mjs deleted (no code path launches PostgreSQL)"
Write-Host "  [info] `embedded-postgres` KEPT as a devDependency on purpose: tests/helpers/test-db.ts"
Write-Host "         imports it to boot a throwaway cluster on a random port for the integration"
Write-Host "         tests. That harness never touches the application database on :5438, and"
Write-Host "         repointing it at the LeoPostgres service would run `prisma db push` against"
Write-Host "         production data. Keeping it is test-only, not a runtime path."
Write-Host "  [ ] do NOT re-enable LeoOutreach.cmd.disabled"
Write-Host "`nMigration script finished." -ForegroundColor Cyan
