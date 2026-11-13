'use strict';
/**
 * winboost.js —— 启动后让目标窗口铺满屏幕并置顶
 *
 * Windows 没有"把别的程序变成全屏"的公开接口, 这里走 Win32:
 *   1. 按 pid(+ 子进程) 找到目标顶层窗口
 *   2. SW_RESTORE + SetWindowPos 到显示器物理尺寸(盖住任务栏)
 *   3. 可选 HWND_TOPMOST 置顶, 并拉到前台
 *
 * 实现方式: 常驻一个隐藏的 PowerShell 辅助进程, 通过 stdin/stdout 收发指令。
 * 这样 C# 辅助类只编译一次、进程只启动一次, 之后每次增强只要几十毫秒。
 */

const path = require('path');
const { spawn } = require('child_process');

const CS_SRC = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WinBoost {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  static readonly IntPtr HWND_TOP = IntPtr.Zero;
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_SHOWWINDOW = 0x0040;
  const uint SWP_FRAMECHANGED = 0x0020;

  public static List<IntPtr> Candidates(uint targetPid, bool includeChildren, HashSet<uint> childPids) {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      bool match = (pid == targetPid) || (includeChildren && childPids.Contains(pid));
      if (!match) return true;
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;   // GW_OWNER: 跳过对话框/工具窗
      RECT r;
      GetWindowRect(h, out r);
      if ((r.Right - r.Left) < 240 || (r.Bottom - r.Top) < 160) return true;
      list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static string Apply(IntPtr h, bool topmost, bool cover) {
    if (IsIconic(h)) ShowWindow(h, 9);                   // SW_RESTORE
    string info;
    if (cover) {
      MONITORINFO mi = new MONITORINFO();
      mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      IntPtr mon = MonitorFromWindow(h, 2);              // MONITOR_DEFAULTTONEAREST
      if (GetMonitorInfo(mon, ref mi)) {
        ShowWindow(h, 9);                                // 最大化窗口不接受自定义尺寸, 先还原
        int w = mi.rcMonitor.Right - mi.rcMonitor.Left;
        int hgt = mi.rcMonitor.Bottom - mi.rcMonitor.Top;
        SetWindowPos(h, topmost ? HWND_TOPMOST : HWND_TOP,
          mi.rcMonitor.Left, mi.rcMonitor.Top, w, hgt,
          SWP_SHOWWINDOW | SWP_FRAMECHANGED);
        info = "cover " + w + "x" + hgt;
      } else {
        ShowWindow(h, 3);                                // SW_MAXIMIZE
        info = "maximize(fallback)";
      }
    } else {
      ShowWindow(h, 3);
      if (topmost) SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
      info = "maximize";
    }
    BringWindowToTop(h);
    SetForegroundWindow(h);
    return info + (topmost ? " +topmost" : "");
  }
}
`;

const PS_WORKER = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$dll = Join-Path $env:TEMP '__DLL__'
$src = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__CS64__'))
if (-not (Test-Path $dll)) {
  try { Add-Type -TypeDefinition $src -OutputAssembly $dll -ErrorAction Stop } catch { }
}
if (Test-Path $dll) { try { Add-Type -Path $dll -ErrorAction Stop } catch { } }
if (-not ('WinBoost' -as [type])) { Add-Type -TypeDefinition $src }

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '' ) { continue }
  if ($line -eq 'QUIT') { break }

  $parts = $line.Split(' ')
  $id = $parts[0]
  $pidT = [uint32]$parts[1]
  $timeout = [int]$parts[2]
  $mode = [int]$parts[3]
  $topmost = (($mode -band 1) -ne 0)
  $cover = (($mode -band 2) -ne 0)

  $deadline = (Get-Date).AddMilliseconds($timeout)
  $kidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
  $found = [IntPtr]::Zero

  while ((Get-Date) -lt $deadline) {
    $list = [WinBoost]::Candidates($pidT, $false, $kidSet)
    if ($list.Count -gt 0) { $found = $list[0]; break }
    Start-Sleep -Milliseconds 100
  }

  if ($found -eq [IntPtr]::Zero) {
    $queue = New-Object 'System.Collections.Queue'
    $queue.Enqueue($pidT)
    $n = 0
    while ($queue.Count -gt 0 -and $n -lt 80) {
      $p = [uint32]$queue.Dequeue()
      $n++
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($kidSet.Add([uint32]$_.ProcessId)) { $queue.Enqueue([uint32]$_.ProcessId) }
      }
    }
    while ((Get-Date) -lt $deadline) {
      $list = [WinBoost]::Candidates($pidT, $true, $kidSet)
      if ($list.Count -gt 0) { $found = $list[0]; break }
      Start-Sleep -Milliseconds 100
    }
  }

  if ($found -eq [IntPtr]::Zero) {
    [Console]::Out.WriteLine($id + ' NOTFOUND')
  } else {
    $r = [WinBoost]::Apply($found, $topmost, $cover)
    [Console]::Out.WriteLine($id + ' OK ' + $r)
  }
  [Console]::Out.Flush()
}
`;

const CS_B64 = Buffer.from(CS_SRC, 'utf8').toString('base64');
// dll 名字带上源码指纹: 改了 C# 就会重新编译, 避免命中旧缓存(旧版没有新方法)
const CS_TAG = require('crypto').createHash('sha1').update(CS_SRC).digest('hex').slice(0, 10);
const DLL_NAME = `launchplay-winboost-${CS_TAG}.dll`;
const ENCODED = Buffer.from(
  PS_WORKER.replace('__CS64__', CS_B64).replace('__DLL__', DLL_NAME),
  'utf16le'
).toString('base64');

let worker = null;
let seq = 0;
let ready = false;
let pending = new Map();
let starting = null;
let debug = !!process.env.TL_DEBUG_BOOST;

function failAll(reason) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, info: reason });
  }
  pending.clear();
}

/* ---- 闲置回收 ----
 * 辅助进程是个常驻 powershell.exe, 空转也要占 60~90MB。
 * 电视首页通常整天挂着, 一直占着这笔内存不划算: 连续 10 分钟没有窗口增强请求
 * 就结束它, 下次真正要用时再拉起(冷启动约 3.5s, 但那种情况本身已经很少见)。
 */
const IDLE_MS = 10 * 60 * 1000;
let lastUsed = 0;
let idleTimer = null;

function touchWorker() {
  lastUsed = Date.now();
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    if (!worker) { clearInterval(idleTimer); idleTimer = null; return; }
    if (Date.now() - lastUsed < IDLE_MS) return;
    shutdownWorker();
    clearInterval(idleTimer);
    idleTimer = null;
  }, 60 * 1000);
  if (idleTimer.unref) idleTimer.unref();
}

function startWorker() {
  if (starting) return starting;
  starting = new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
      );
    } catch (e) {
      starting = null;
      return resolve(null);
    }

    let buf = '';
    worker = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        if (line === 'READY') { ready = true; touchWorker(); resolve(child); continue; }
        const sp = line.indexOf(' ');
        const id = sp < 0 ? line : line.slice(0, sp);
        const rest = sp < 0 ? '' : line.slice(sp + 1);
        const p = pending.get(id);
        if (!p) continue;
        pending.delete(id);
        clearTimeout(p.timer);
        if (rest.startsWith('OK')) p.resolve({ ok: true, info: rest.slice(2).trim() });
        else p.resolve({ ok: false, info: rest || 'not found' });
      }
    });

    child.on('close', () => {
      if (worker === child) { worker = null; ready = false; }
      starting = null;
      failAll('worker closed');
    });
    child.on('error', () => {
      if (worker === child) { worker = null; ready = false; }
      starting = null;
      resolve(null);
      failAll('worker error');
    });

    // 兜底: 8 秒内没等到 READY 就放弃(不影响主流程)
    setTimeout(() => { if (!ready) resolve(null); }, 8000);
  });
  return starting;
}

/**
 * 让某个进程的主窗口铺满屏幕并(可选)置顶。
 * @param {number} pid
 * @param {{topmost?: boolean, cover?: boolean, timeout?: number}} opts
 * @returns {Promise<{ok: boolean, info?: string}>}
 */
async function boostWindow(pid, opts = {}) {
  if (!pid) return { ok: false, info: 'no pid' };
  const topmost = opts.topmost !== false;
  const cover = opts.cover !== false;
  const timeout = Math.max(500, Math.min(15000, opts.timeout || 8000));
  const mode = (topmost ? 1 : 0) | (cover ? 2 : 0);

  const w = worker && ready ? worker : await startWorker();
  if (!w) return { ok: false, info: 'worker unavailable' };
  touchWorker();

  const id = 'r' + (++seq);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, info: 'timeout' });
    }, timeout + 4000);
    pending.set(id, { resolve, timer });
    try {
      w.stdin.write(`${id} ${pid} ${timeout} ${mode}\n`);
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, info: 'write failed' });
    }
  });
}

/** 预热: 提前把辅助进程和 C# 辅助类准备好 */
async function warmup() {
  try { await startWorker(); } catch { /* 失败就退回"不增强" */ }
}

/** 应用退出前调用, 顺手结束辅助进程 */
function shutdownWorker() {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  if (!worker) return;
  try { worker.stdin.write('QUIT\n'); } catch {}
  const w = worker;
  setTimeout(() => { try { w.kill(); } catch {} }, 400);
  worker = null;
  ready = false;
}

module.exports = { boostWindow, warmup, shutdownWorker };
