// Diagnostic only. Enumerates every visible top-level window that is a console
// window, resolves the full process ancestry, and reports conhost attachment.
// Read-only: starts, stops and signals nothing.
import { execFileSync } from "node:child_process";

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
  "public class Pop {",
  "  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(EnumProc f, IntPtr l);",
  "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
  "  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);",
  "  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);",
  "  [DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);",
  "  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);",
  "  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r);",
  "  [DllImport(\"user32.dll\")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);",
  "  [DllImport(\"user32.dll\")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);",
  "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }",
  "  public static List<string> Run() {",
  "    var res = new List<string>();",
  "    EnumWindows((h, l) => {",
  "      int pid; GetWindowThreadProcessId(h, out pid);",
  "      var sb = new StringBuilder(2048); GetWindowTextW(h, sb, 2048);",
  "      var cn = new StringBuilder(256); GetClassNameW(h, cn, 256);",
  "      var cls = cn.ToString();",
  "      bool isConsole = cls == \"ConsoleWindowClass\" || cls == \"CASCADIA_HOSTING_WINDOW_CLASS\" || cls == \"PseudoConsoleWindow\";",
  "      if (isConsole) {",
  "        RECT r; GetWindowRect(h, out r);",
  "        var safe = sb.ToString().Replace(\"\\\\\", \"/\").Replace(\"\\\"\", \"'\");",
  "        var root = GetAncestor(h, 2);",
  "        res.Add(string.Format(\"{{\\\"hwnd\\\":\\\"{0}\\\",\\\"pid\\\":{1},\\\"visible\\\":{2},\\\"class\\\":\\\"{3}\\\",\\\"w\\\":{4},\\\"h\\\":{5},\\\"root\\\":\\\"{6}\\\",\\\"title\\\":\\\"{7}\\\"}}\",",
  "          h.ToInt64(), pid, IsWindowVisible(h) ? \"true\" : \"false\", cls, r.R - r.L, r.B - r.T, root.ToInt64(), safe));",
  "      }",
  "      return true;",
  "    }, IntPtr.Zero);",
  "    return res;",
  "  }",
  "}",
].join("\n");

// One CIM snapshot: every process, keyed by pid.
const snap = JSON.parse(
  ps(
    "$ErrorActionPreference='Stop'; " +
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate,SessionId | " +
      "ForEach-Object { [pscustomobject]@{ p=$_.ProcessId; pp=$_.ParentProcessId; n=$_.Name; " +
      "e=$_.ExecutablePath; c=$_.CommandLine; t=([string]$_.CreationDate); s=$_.SessionId } } | ConvertTo-Json -Compress -Depth 3",
    120000,
  ) || "[]",
);
const procs = Array.isArray(snap) ? snap : [snap];
const byPid = new Map(procs.map((p) => [Number(p.p), p]));

function chain(pid) {
  const out = [];
  let cur = byPid.get(Number(pid));
  let guard = 0;
  while (cur && guard < 12) {
    out.push({
      pid: cur.p,
      name: cur.n,
      ppid: cur.pp,
      path: cur.e || "",
      cmd: (cur.c || "").slice(0, 220),
      started: cur.t,
      session: cur.s,
    });
    cur = byPid.get(Number(cur.pp));
    guard += 1;
  }
  return out;
}

// Which processes own a conhost child (i.e. have a console allocated).
const conhostByParent = new Map();
for (const p of procs) {
  if (p.n === "conhost.exe") {
    const k = Number(p.pp);
    conhostByParent.set(k, (conhostByParent.get(k) || 0) + 1);
  }
}

const winOut = ps(
  "$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n" + cs + "\n'@; [Pop]::Run() -join \"`n\"",
  60000,
);
const wins = winOut
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

console.log(`TOTAL console-class top-level windows: ${wins.length}`);
console.log(`  visible: ${wins.filter((w) => w.visible).length}`);
console.log("");

const vis = wins.filter((w) => w.visible);
for (const w of vis) {
  console.log("=".repeat(100));
  console.log(`HWND ${w.hwnd}  class=${w.class}  size=${w.w}x${w.h}  rootAncestor=${w.root}`);
  console.log(`TITLE: ${w.title}`);
  const owner = byPid.get(Number(w.pid));
  console.log(`WINDOW OWNER PID ${w.pid}: ${owner ? owner.n : "<gone>"}`);
  if (owner) console.log(`  path: ${owner.e || "(none)"}`);
  if (owner) console.log(`  cmd : ${(owner.c || "").slice(0, 300)}`);
  console.log("");
  console.log("  ANCESTRY (window owner upward):");
  for (const l of chain(w.pid)) {
    const cc = (conhostByParent.get(Number(l.pid)) || 0) > 0 ? "  [HAS CONHOST]" : "";
    console.log(
      `    pid=${String(l.pid).padEnd(6)} ppid=${String(l.ppid).padEnd(6)} ${String(l.name).padEnd(22)} sess=${l.session}${cc}`,
    );
    if (l.cmd) console.log(`      cmd: ${l.cmd}`);
  }
  console.log("");
}

console.log("=".repeat(100));
console.log("CONSOLE ATTACHMENT MAP (processes that own a conhost.exe child)");
for (const [pid, n] of [...conhostByParent.entries()].sort((a, b) => a[0] - b[0])) {
  const p = byPid.get(pid);
  if (!p) {
    console.log(`  pid=${String(pid).padEnd(6)} conhost=${n}  owner=<dead>`);
    continue;
  }
  const pp = byPid.get(Number(p.pp));
  console.log(
    `  pid=${String(pid).padEnd(6)} conhost=${n}  ${String(p.n).padEnd(22)} ppid=${String(p.pp).padEnd(6)} parent=${pp ? pp.n : "<gone>"} sess=${p.s}`,
  );
}