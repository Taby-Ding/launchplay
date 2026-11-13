const { spawn } = require('child_process');
const { boostWindow, shutdownWorker } = require('../src/winboost');

const PROBE = `$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class Probe2 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONINFO mi);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONINFO { public int cb; public RECT mon; public RECT work; public uint flags; }
  public static string Dump(uint pid) {
    StringBuilder sb = new StringBuilder();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint wp; GetWindowThreadProcessId(h, out wp);
      if (wp != pid) return true;
      if (!IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      if ((r.R - r.L) < 200) return true;
      int ex = GetWindowLong(h, -20);
      MONINFO mi = new MONINFO(); mi.cb = Marshal.SizeOf(typeof(MONINFO));
      GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
      sb.Append("rect=" + (r.R - r.L) + "x" + (r.B - r.T) + "@" + r.L + "," + r.T
        + " monitor=" + (mi.mon.R - mi.mon.L) + "x" + (mi.mon.B - mi.mon.T)
        + " topmost=" + (((ex & 0x8) != 0) ? "yes" : "no") + "; ");
      return true;
    }, IntPtr.Zero);
    return sb.Length == 0 ? "no-window" : sb.ToString();
  }
}
'@
Write-Output ([Probe2]::Dump([uint32]__PID__))`;

function probe(pid) {
  return new Promise((resolve) => {
    const enc = Buffer.from(PROBE.replace('__PID__', String(pid)), 'utf16le').toString('base64');
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out.trim()));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const exe = process.argv[2] || 'C:\\Windows\\System32\\notepad.exe';
  const app = spawn(exe, [], { detached: true, stdio: 'ignore' });
  app.unref();
  console.log('launched pid=' + app.pid + ' ' + exe);

  await sleep(1200);
  console.log('before: ' + await probe(app.pid));

  const t = Date.now();
  const r = await boostWindow(app.pid, { topmost: true, cover: true, timeout: 6000 });
  console.log('boost  ->', JSON.stringify(r), Date.now() - t + 'ms');
  await sleep(600);
  console.log('after : ' + await probe(app.pid));

  await sleep(400);
  try { spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }); } catch {}
  shutdownWorker();
  setTimeout(() => process.exit(0), 600);
})();
