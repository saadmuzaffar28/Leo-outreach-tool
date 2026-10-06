// Watchdog: records every NEW console-class window with full ancestry,
// correlated against process creation. Read-only. Runs for N seconds.
// Usage: node scripts/lib/watch-popups.mjs <seconds>
import { execFileSync } from "node:child_process";
import { argv } from "node:process";

const SECONDS = Number(argv[2] ?? 90);

function ps(script, timeoutMs = 60000) {
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return "";
  }
}

const cs = [
  "using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;",
  "public class W {",
  "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc f, IntPtr l);",
  "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
  "  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);",
  "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);",
  "  [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);",
  "  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);",
  "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r);",
  "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }",
  "  public static List<string> Run() {",
  "    var res = new List<string>();",
  "    EnumWindows((h, l) => {",
  "      int pid; GetWindowThreadProcessId(h, out pid);",
  "      var sb = new StringBuilder(2048); GetWindowTextW(h, sb, 2048);",
  "      var cn = new StringBuilder(256); GetClassNameW(h, cn, 256);",
  "      var cls = cn.ToString();",
  "      if (cls == \"ConsoleWindowClass\" || cls == \"CASCADIA_HOSTING_WINDOW_CLASS\" || cls == \"PseudoConsoleWindow\") {",
  "        RECT r; GetWindowRect(h, out r);",
  "        var safe = sb.ToString().Replace(\"\\\\\", \"/\").Replace(\"\\\"\", \"'\");",
  "        res.Add(string.Format(\"{{\\\"hwnd\\\":\\\"{0}\\\",\\\"pid\\\":{1},\\\"vis\\\":{2},\\\"class\\\":\\\"{3}\\\",\\\"w\\\":{4},\\\"h\\\":{5},\\\"title\\\":\\\"{6}\\\"}}\",",
  "          h.ToInt64(), pid, IsWindowVisible(h) ? \"true\" : \"false\", cls, r.R - r.L, r.B - r.T, safe));",
  "      }",
  "      return true;",
  "    }, IntPtr.Zero);",
  "    return res;",
  "  }",
  "}",
].join("\n");

function scanWins() {
  const out = ps(
    "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n" + cs + "\n'@; [W]::Run() -join \"`n\"",
    45000,
  );
  const m = new Map();
  for (const line of out.trim().split(/\r?\n/)) {
    if (!line) continue;
    try {
      const w = JSON.parse(line);
      m.set(String(w.hwnd), w);
    } catch {
      /* ignore */
    }
  }
  return m;
}

function snapProcs() {
  const raw = ps(
    "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate " +
      "| ForEach-Object { [pscustomobject]@{ p=$_.ProcessId; pp=$_.ParentProcessId; n=$_.Name; e=$_.ExecutablePath; c=$_.CommandLine; t=([string]$_.CreationDate) } } | ConvertTo-Json -Compress -Depth 3",
    60000,
  );
  const j = JSON.parse(raw || "[]");
  const arr = Array.isArray(j) ? j : [j];
  const m = new Map();
  for (const p of arr) m.set(Number(p.p), p);
  return m;
}

const events = [];
const seen = new Set();
let prev = scanWins();
let knownProcs = new Set(snapProcs().keys());
const end = Date.now() + SECONDS * 1000;
const started = Date.now();

function chainOf(byPid, pid) {
  const out = [];
  let cur = byPid.get(Number(pid));
  let g = 0;
  while (cur && g < 10) {
    out.push(`pid=${cur.p} ppid=${cur.pp} ${cur.n}${cur.c ? " :: " + cur.c.slice(0, 150) : ""}`);
    cur = byPid.get(Number(cur.pp));
    g += 1;
  }
  return out;
}

function tick() {
  const now = scanWins();
  const byPid = snapProcs();

  // process creations since last tick
  const newProcs = [];
  for (const [pid, p] of byPid) {
    if (!knownProcs.has(pid)) {
      newProcs.push({ pid, name: p.n, ppid: p.pp, path: p.e || "", cmd: (p.c || "").slice(0, 200), started: p.t });
    }
  }
  knownProcs = new Set(byPid.keys());

  for (const p of newProcs) {
    events.push({ type: "PROC_START", at: new Date().toISOString(), ...p });
  }

  for (const [hwnd, w] of now) {
    if (!seen.has(hwnd)) {
      seen.add(hwnd);
      const owner = byPid.get(Number(w.pid));
      events.push({
        type: "WINDOW_NEW",
        at: new Date().toISOString(),
        hwnd: w.hwnd,
        class: w.class,
        visible: w.vis,
        size: `${w.w}x${w.h}`,
        title: w.title,
        windowPid: w.pid,
        process: owner ? owner.n : "<gone>",
        processPath: owner ? owner.e || "" : "",
        processCmd: owner ? (owner.c || "").slice(0, 250) : "",
        parentPid: owner ? owner.pp : null,
        ancestry: owner ? chainOf(byPid, w.pid) : [],
      });
    }
  }

  for (const hwnd of seen) {
    if (!now.has(hwnd)) {
      const rec = events.find((e) => e.type === "WINDOW_NEW" && e.hwnd === hwnd);
      events.push({
        type: "WINDOW_GONE",
        at: new Date().toISOString(),
        hwnd,
        wasClass: rec ? rec.class : "?",
        wasTitle: rec ? rec.title : "?",
      });
    }
  }
  seen.clear();
  for (const k of now.keys()) seen.add(k);
  prev = now;

  const el = Math.round((Date.now() - started) / 1000);
  console.log(`[${el}s] windows=${now.size} procs=${byPid.size} newEvents=${events.length}`);
  if (el % 15 === 0) {
    events.forEach((e) => console.log("   " + JSON.stringify(e)));
  }

  if (Date.now() > end) {
    console.log("\n================ FINAL EVENT LOG ================");
    events.forEach((e) => console.log(JSON.stringify(e, null, 2)));
    console.log(`\ntotal events: ${events.length}`);
    process.exit(0);
  }
  setTimeout(tick, 1000);
}
tick();