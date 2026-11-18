'use strict';
/**
 * lockdown.js —— 家长守护的「轻量加固」（Windows，可撤销）
 *
 * 目标：不替换系统外壳、不要求企业版/教育版、不装 native 模块，
 * 尽量挡住「切回桌面 / 关掉软件」，且全部改动都能随关闭守护或退出软件恢复。
 *
 * 三层（都由主进程按需开关）：
 *   1) 用户级策略 DisableTaskMgr / NoWinKeys —— 挡住任务管理器和 Win 键组合；
 *      **写入前把原值备份到数据目录**，恢复时按原值写回或删除该键。
 *   2) 看门狗进程 —— 主进程被结束后 1~2 秒自动重新拉起（Win7 也可用）；
 *      正常退出前写 quit.flag，看门狗见到就自行退出，不会把正常退出拉回来。
 *   3) 失焦抢回 —— 启动台打开的程序已经退出时，把启动台拉回前台，
 *      避免露出桌面；程序还在运行时不抢，保证能正常看视频。
 *
 * 能力边界（务必如实告知用户）：
 *   Ctrl+Alt+Del、长按电源键、管理员 taskkill 属于系统级手段，
 *   任何用户态应用都无法阻止；本模块的价值是「没有桌面可切 + 被结束后自动回来」。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

const POLICIES = [
  {
    name: 'DisableTaskMgr',
    psPath: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System',
    label: '禁用任务管理器',
  },
  {
    name: 'NoWinKeys',
    psPath: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer',
    label: '禁用 Win 键组合',
  },
];

function powershell(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 6000, windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').trim();
}

/** 读某个策略键：返回 { absent:true } 或 { value:number } */
function readPolicy(p) {
  const out = powershell(
    `$ErrorActionPreference='SilentlyContinue'; ` +
    `$v=(Get-ItemProperty -Path '${p.psPath}' -Name '${p.name}').'${p.name}'; ` +
    `if ($null -eq $v) { 'ABSENT' } else { [string]$v }`
  );
  if (out === null) return null;           // 执行失败（无权限 / PowerShell 被拦）
  if (out === 'ABSENT' || out === '') return { absent: true };
  const n = Number(out);
  return { value: Number.isFinite(n) ? n : 0 };
}

function writePolicy(p, value) {
  const out = powershell(
    `$ErrorActionPreference='Stop'; ` +
    `New-Item -Path '${p.psPath}' -Force | Out-Null; ` +
    `Set-ItemProperty -Path '${p.psPath}' -Name '${p.name}' -Value ${value} -Type DWord; 'OK'`
  );
  return out === 'OK';
}

function removePolicy(p) {
  const out = powershell(
    `$ErrorActionPreference='Stop'; ` +
    `Remove-ItemProperty -Path '${p.psPath}' -Name '${p.name}' -Force -ErrorAction SilentlyContinue; 'OK'`
  );
  return out === 'OK';
}

function backupFile(dataDir) { return path.join(dataDir, 'lockdown-backup.json'); }
function quitFlag(dataDir) { return path.join(dataDir, 'quit.flag'); }

/**
 * 打开加固：备份原值 -> 写策略 -> 启看门狗。
 * 返回 { ok, applied:[string], errors:[string] }，任何一步失败都不影响其它功能。
 */
function enable(dataDir) {
  if (!IS_WIN) return { ok: false, errors: ['轻量加固仅 Windows 支持'] };
  const applied = [];
  const errors = [];
  const bf = backupFile(dataDir);
  let backup = {};
  try { backup = JSON.parse(fs.readFileSync(bf, 'utf8')); } catch { /* 没有旧备份 */ }

  for (const p of POLICIES) {
    // 已有备份说明上次加固未恢复干净，别把「加固后的 1」当成原值再备份一次
    if (!backup[p.name]) {
      const cur = readPolicy(p);
      if (cur === null) { errors.push(`${p.label}：读取原值失败，已跳过`); continue; }
      backup[p.name] = cur;
    }
    if (writePolicy(p, 1)) applied.push(p.label);
    else errors.push(`${p.label}：写入失败（可能需要权限）`);
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(bf, JSON.stringify(backup, null, 2), 'utf8');
    try { fs.unlinkSync(quitFlag(dataDir)); } catch { /* 不存在就算了 */ }
  } catch (e) { errors.push('备份写入失败：' + e.message); }

  startWatchdog(dataDir);
  return { ok: applied.length > 0, applied, errors };
}

/** 关闭加固：写退出标记 -> 恢复策略原值 -> 删除备份文件 */
function disable(dataDir) {
  if (!IS_WIN) return { ok: true, restored: [] };
  markNormalQuit(dataDir);
  const restored = [];
  const errors = [];
  const bf = backupFile(dataDir);
  let backup = {};
  try { backup = JSON.parse(fs.readFileSync(bf, 'utf8')); } catch { /* 没有备份就只恢复看门狗 */ }

  for (const p of POLICIES) {
    const orig = backup[p.name];
    let ok;
    if (!orig || orig.absent) ok = removePolicy(p);
    else ok = writePolicy(p, Number(orig.value) || 0);
    if (ok) restored.push(p.label); else errors.push(`${p.label}：恢复失败`);
  }
  try { fs.unlinkSync(bf); } catch { /* ignore */ }
  return { ok: errors.length === 0, restored, errors };
}

/** 正常退出标记：看门狗见到它就自行结束，不会把主动退出拉回来 */
function markNormalQuit(dataDir) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(quitFlag(dataDir), String(Date.now()), 'utf8');
  } catch { /* ignore */ }
}

function startWatchdog(dataDir) {
  if (!IS_WIN) return null;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // 否则 Electron 会变成纯 Node 模式
    const child = spawn(process.execPath, [
      '--launchplay-watchdog',
      `--lp-pid=${process.pid}`,
      `--lp-dir=${dataDir}`,
    ], { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.unref();
    return child;
  } catch { return null; }
}

/** pid 是否仍在运行（Windows 上 process.kill(pid, 0) 只做存在性检查，不会真的发信号） */
function isAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

/**
 * 失焦抢回：只在「加固生效」「启动台打开的程序已退出」时把窗口拉回前台。
 * 程序还活着就不抢，保证家长/孩子能正常用启动台打开的软件。
 */
function attachFocusGuard(win, opts) {
  if (!win || typeof win.on !== 'function') return;
  win.on('blur', () => {
    try {
      if (!opts.isActive() || opts.isLaunchedAppAlive()) return;
      setTimeout(() => {
        if (!opts.isActive() || opts.isLaunchedAppAlive()) return;
        if (!win.isDestroyed()) {
          win.show();
          win.setAlwaysOnTop(true, 'screen-saver');
          win.focus();
        }
      }, 300);
    } catch { /* ignore */ }
  });
}

module.exports = {
  enable, disable, markNormalQuit, startWatchdog,
  isAlive, attachFocusGuard,
};
