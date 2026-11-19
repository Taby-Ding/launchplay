'use strict';
/**
 * taskbar.js —— Windows 任务栏"自动隐藏"开关
 *
 * 为什么用 SHAppBarMessage 而不是改注册表 StuckRects3：
 *   注册表方式要重启 explorer 才生效，用户会看到任务栏闪一下甚至桌面卡住；
 *   SHAppBarMessage(ABM_SETSTATE) 是系统公开接口，即时生效、不需要管理员权限。
 *
 * 原状态记在 DATA_DIR/taskbar-state.json：
 *   - 开启时先读出当前状态并存档，再叠加 ABS_AUTOHIDE；
 *   - 正常退出时读档还原并删档；
 *   - 若程序被强杀，残留的档会在下次开启/退出时继续生效，不会把用户的任务栏永久藏起来。
 *
 * 与 wininput.js 一样：脚本内联在内存里，不落盘 .ps1，避免安全策略拦截。
 * 只有 Windows 有任务栏这个概念，其他平台所有方法都安全返回。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { WIN } = require('./platform');

const ABS_AUTOHIDE = 0x1; // ABS_AUTOHIDE

const PS_TYPES = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LPTaskbarState {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA {
    public int cbSize;
    public IntPtr hWnd;
    public uint uCallbackMessage;
    public int uEdge;
    public RECT rc;
    public IntPtr lParam;
  }
  [DllImport("shell32.dll")] public static extern IntPtr SHAppBarMessage(uint msg, ref APPBARDATA data);
  public const uint ABM_GETSTATE = 0x4;
  public const uint ABM_SETSTATE = 0xa;
  public static int Get() {
    APPBARDATA d = new APPBARDATA();
    d.cbSize = Marshal.SizeOf(typeof(APPBARDATA));
    return SHAppBarMessage(ABM_GETSTATE, ref d).ToInt32();
  }
  public static void Set(int flags) {
    APPBARDATA d = new APPBARDATA();
    d.cbSize = Marshal.SizeOf(typeof(APPBARDATA));
    d.lParam = new IntPtr(flags);
    SHAppBarMessage(ABM_SETSTATE, ref d);
  }
}
'@
`;

const CMD_GET = "[Console]::WriteLine('STATE ' + [LPTaskbarState]::Get())";
const cmdSet = (flags) => `[LPTaskbarState]::Set(${flags}); [Console]::WriteLine('OK')`;

/** 跑一段 PowerShell；sync=true 时同步返回（退出阶段用，确保还原完成再退） */
function run(script, sync) {
  const args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script];
  if (sync) {
    try {
      const r = spawnSync('powershell.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 6000 });
      if (r.error) return { ok: false, error: r.error.message };
      if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim() || ('exit ' + r.status) };
      return { ok: true, out: (r.stdout || '').trim() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    let out = '', err = '', done = false;
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.once('error', (e) => { if (!done) { done = true; resolve({ ok: false, error: e.message }); } });
    child.once('close', (code) => {
      if (done) return;
      done = true;
      if (code === 0) resolve({ ok: true, out: out.trim() });
      else resolve({ ok: false, error: err.trim() || ('exit ' + code) });
    });
  });
}

function statePath(dataDir) { return path.join(dataDir, 'taskbar-state.json'); }

function readSaved(dataDir) {
  try {
    const o = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8'));
    return Number.isInteger(o.original) ? o.original : null;
  } catch { return null; }
}
function writeSaved(dataDir, original) {
  try { fs.writeFileSync(statePath(dataDir), JSON.stringify({ original, savedAt: Date.now() }), 'utf8'); } catch { /* ignore */ }
}
function clearSaved(dataDir) {
  try { fs.rmSync(statePath(dataDir), { force: true }); } catch { /* ignore */ }
}

/** 读取当前任务栏状态位 */
async function getState() {
  if (!WIN) return { ok: false, error: '仅 Windows 支持任务栏状态读取' };
  const r = await run(PS_TYPES + '\n' + CMD_GET, false);
  if (!r.ok) return r;
  const m = r.out.match(/STATE\s+(-?\d+)/);
  return m ? { ok: true, value: parseInt(m[1], 10) } : { ok: false, error: '无法解析任务栏状态：' + r.out };
}

function setState(flags, sync) {
  if (!WIN) return sync ? { ok: false, error: '仅 Windows 支持' } : Promise.resolve({ ok: false, error: '仅 Windows 支持' });
  const r = run(PS_TYPES + '\n' + cmdSet(flags), !!sync);
  return sync ? r : r.then((x) => (x.ok ? { ok: true } : x));
}

/**
 * 开启自动隐藏。返回 {ok, skipped?}
 * 若用户本来就已开启自动隐藏，则跳过托管（退出时不还原，尊重用户自己的设置）。
 */
async function enable(dataDir) {
  if (!WIN) return { ok: false, error: '仅 Windows 支持自动隐藏任务栏' };
  const saved = readSaved(dataDir);
  let original;
  if (saved !== null) {
    original = saved; // 上次残留的档（可能是被强杀留下的），继续用它
  } else {
    const s = await getState();
    if (!s.ok) return s;
    original = s.value;
    if (original & ABS_AUTOHIDE) {
      return { ok: true, skipped: true, reason: '任务栏已处于自动隐藏状态，未接管' };
    }
  }
  const r = await setState(original | ABS_AUTOHIDE, false);
  if (!r.ok) return r;
  writeSaved(dataDir, original);
  return { ok: true };
}

/**
 * 还原任务栏原状态。sync=true 同步执行（用于 before-quit，确保还原完成再退出）。
 * 没有任何托管记录时安全返回 {ok:true, skipped:true}。
 */
function restore(dataDir, sync) {
  if (!WIN) return sync ? { ok: true, skipped: true } : Promise.resolve({ ok: true, skipped: true });
  const original = readSaved(dataDir);
  if (original === null) {
    return sync ? { ok: true, skipped: true } : Promise.resolve({ ok: true, skipped: true });
  }
  const finish = (r) => { if (r.ok) clearSaved(dataDir); return r; };
  const p = setState(original, !!sync);
  return sync ? finish(p) : Promise.resolve(p).then(finish);
}

/** 当前是否由我们托管着（决定退出时是否需要还原） */
function isActive(dataDir) { return WIN && readSaved(dataDir) !== null; }

module.exports = { enable, restore, getState, setState, isActive, ABS_AUTOHIDE };
