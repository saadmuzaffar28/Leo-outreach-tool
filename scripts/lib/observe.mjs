// Passive observer - READ ONLY. Starts/stops/signals nothing.
// Records process start/stop and console-window churn to a JSONL log.
// Usage: node scripts/lib/observe.mjs <logfile> <minutes>
import { appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { argv, platform } from "node:process";

const LOG = argv[2] ?? "logs/observe.jsonl";
const MINUTES = Number(argv[3] ?? 30);
const PGDATA = "C:/deploy/Leo-outreach-tool/.pgdata";

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}
function emit(rec) {
  appendFileSync(LOG, JSON.stringify({ t: ts(), ...rec }) + "\n");
}

function ps(script, timeoutMs = 20000) {
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
    );
  } catch {
    return "";
  }
}

writeFileSync(LOG, "");
emit({ kind: "observer", note: "start", minutes: MINUTES });

// WMI trace of console-relevant process start/stop.
const wmiScript = [
  "$ErrorActionPreference = 'Continue'",
  "$names = \"('conhost.exe','cmd.exe','powershell.exe','pwsh.exe','WindowsTerminal.exe','OpenConsole.exe','postgres.exe','node.exe')\"",
  "$sel  = \"SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName IN $names\"",
  "$sel2 = \"SELECT * FROM Win32_ProcessStopTrace  WHERE ProcessName IN $names\"",
  "$w = New-Object System.Management.ManagementEventWatcher $sel",
  "$r = New-Object System.Management.ManagementEventWatcher $sel2",
  "$w.Options.Timeout = New-TimeSpan -Seconds 1",
  "$r.Options.Timeout = New-TimeSpan -Seconds 1",
  "$w.Start(); $r.Start()",
  "while ($true) {",
  "  foreach ($pair in @(,@($w,'start')) + @(,@($r,'stop'))) {",
  "    $evt = $null",
  "    try { $evt = $pair[0].WaitForNextEvent() } catch { }",
  "    if ($evt) {",
  "      $n = $evt.EventArguments[0]",
  "      [pscustomobject]@{ event=$pair[1]; name=$n.ProcessName; pid=$n.ProcessID; ppid=$n.ParentProcessID; session=$n.SessionID } | ConvertTo-Json -Compress",
  "    }",
  "  }",
  "}",
].join("\n");

const wmiProc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", wmiScript], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
wmiProc.stderr.on("data", () => {});
let buf = "";
wmiProc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line.startsWith("{")) {
      try {
        emit({ kind: "proc", ...JSON.parse(line) });
      } catch {
        /* ignore */
      }
    }
  }
});

// Visible top-level console windows. A "black popup" is exactly one of these.
const winCs = [
  "using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;",
  "public class WS {",
  "  [DllImport(\"user32.dll\")] static extern bool EnumWindows(EnumProc f, IntPtr l);",
  "  delegate bool EnumProc(IntPtr h, IntPtr l);",
  "  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);",
  "  [DllImport(\"user32.dll\")] static extern bool IsWindowVisible(IntPtr h);",
  "  [DllImport(\"user32.dll\")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);",
  "  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);",
  "  [DllImport(\"user32.dll\")] static extern bool GetWindowRect(IntPtr h, out RECT r);",
  "  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }",
  "  public static List<string> Run() {",
  "    var res = new List<string>();",
  "    EnumWindows((h, l) => {",
  "      int pid; GetWindowThreadProcessId(h, out pid);",
  "      var sb = new StringBuilder(1024); GetWindowTextW(h, sb, 1024);",
  "      var cn = new StringBuilder(256); GetClassNameW(h, cn, 256);",
  "      var t = sb.ToString(); var cls = cn.ToString();",
  "      if (t.Length > 0 && (cls == \"ConsoleWindowClass\" || (cls == \"CASCADIA_HOSTING_WINDOW_CLASS\" && t.IndexOf(\"postgres\", StringComparison.OrdinalIgnoreCase) >= 0))) {",
  "        RECT r; GetWindowRect(h, out r);",
  "        var safe = t.Replace(\"\\\\\", \"/\").Replace(\"\\\"\", \"'\");",
  "        res.Add(string.Format(\"{{\\\"hwnd\\\":\\\"{0}\\\",\\\"pid\\\":{1},\\\"vis\\\":{2},\\\"class\\\":\\\"{3}\\\",\\\"w\\\":{4},\\\"h\\\":{5},\\\"title\\\":\\\"{6}\\\"}}\",",
  "          h.ToInt64(), pid, IsWindowVisible(h) ? \"true\" : \"false\", cls, r.R - r.L, r.B - r.T, safe));",
  "      }",
  "      return true;",
  "    }, IntPtr.Zero);",
  "    return res;",
  "  }",
  "}",
].join("\n");

function winScan() {
  return ps(
    "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n" + winCs + "\n'@; " +
      "[WS]::Run() -join \"`n\"",
    30000,
  );
}

function pmPid() {
  const f = `${PGDATA}/postmaster.pid`;
  if (!existsSync(f)) return null;
  return readFileSync(f, "utf8").split(/\r?\n/)[0].trim();
}

const end = Date.now() + MINUTES * 60000;
let lastWindows = "";
let prevPm = pmPid();
let prevPg = null;
let prevListen = null;
emit({ kind: "baseline", postmaster: prevPm });

async function loop() {
  const norm = winScan().trim();
  if (norm !== lastWindows) {
    const parsed = norm
      ? norm.split(/\r?\n/).map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { raw: l };
          }
        })
      : [];
    emit({ kind: "windows", count: parsed.length, consoles: parsed });
    lastWindows = norm;
  }

  const pgIds = ps(
    "(Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | Select-Object -ExpandProperty ProcessId) -join ','",
    25000,
  ).trim();
  const pm = pmPid();
  const listening =
    ps("(Get-NetTCPConnection -LocalPort 5438 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count", 25000).trim() === "1";

  if (pm !== prevPm) {
    emit({ kind: "postmaster", change: "changed", from: prevPm, to: pm });
    prevPm = pm;
  }
  if (pgIds !== prevPg) {
    emit({
      kind: "postgres",
      change: "procs",
      count: pgIds ? pgIds.split(",").length : 0,
      ids: pgIds,
    });
    prevPg = pgIds;
  }
  if (listening !== prevListen) {
    emit({ kind: "postgres", change: "listen5438", listening });
    prevListen = listening;
  }

  if (Date.now() > end) {
    emit({ kind: "observer", note: "end", postmaster: prevPm, listening: prevListen });
    try {
      wmiProc.kill();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
  setTimeout(loop, 2000);
}
loop();