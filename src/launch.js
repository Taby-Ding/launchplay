'use strict';
/**
 * launch.js —— 启动条目（三平台）
 *
 * 同一份数据模型在三个系统上的落地方式不一样：
 *   Windows: 直接 spawn exe；.lnk / .bat / 协议路径交给 Shell；失败时尝试 RunAs 提权
 *   macOS:   .app 用 open -n 拉起（拿到的是 LaunchServices 的 pid，不是应用的）；
 *            可执行文件直接 spawn，权限不够时补一个 chmod +x 再试
 *   Linux:   可执行文件直接 spawn；.desktop 解析出 Exec 后启动；
 *            AppImage 同样补执行位
 *
 * 所有分支都保证：成功返回 { ok:true, pid }，失败返回 { ok:false, error }，不抛异常。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WIN, MAC, LINUX } = require('./platform');

const electron = () => require('electron'); // 延迟 require，便于单独跑单元测试

/**
 * 简单参数分词, 支持双引号包裹。
 *
 * 只把「引号内的 \"」当成转义引号, 其余反斜杠一律原样保留 —— Windows 路径
 * (C:\Users\me) 里全是反斜杠, 如果按通用转义规则处理会把它吃掉; 而用户在
 * 参数里写引号时又确实需要转义, 两种需求只能这样折中。
 */
function splitArgs(str) {
  const s = String(str || '');
  const out = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && quoted && s[i + 1] === '"') { cur += '"'; i++; has = true; continue; }
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

function spawnDetached(exe, args) {
  return new Promise((resolve, reject) => {
    let done = false;
    let child;
    try {
      child = spawn(exe, args, {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(exe) || undefined,
        windowsHide: false,
      });
    } catch (e) {
      return reject(e);
    }
    child.once('error', (e) => { if (!done) { done = true; reject(e); } });
    child.once('spawn', () => {
      if (!done) { done = true; try { child.unref(); } catch { /* ignore */ } resolve(child); }
    });
  });
}

async function openWithShell(p) {
  try {
    const err = await electron().shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true, pid: 0 };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '无法用系统方式打开' };
  }
}

/** 补执行位后重试（mac / linux 上从压缩包解出来、或从 U 盘拷过来的文件经常丢 x 位） */
async function retryAfterChmod(target, args) {
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) return null;
    fs.chmodSync(target, st.mode | 0o111);
  } catch {
    return null;
  }
  try {
    const c = await spawnDetached(target, args);
    return { ok: true, pid: c.pid };
  } catch {
    return null;
  }
}

/* --------------------------- Windows --------------------------- */
/** 需要管理员权限的程序: 走 ShellExecute RunAs, 会弹 UAC */
function launchElevated(exe, args) {
  const argLine = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const ps = [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
    `Start-Process -FilePath '${exe.replace(/'/g, "''")}'${argLine ? ` -ArgumentList ${argLine}` : ''} -Verb RunAs`,
  ];
  return new Promise((resolve) => {
    const c = spawn('powershell.exe', ps, { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => resolve(false));
    c.on('spawn', () => { try { c.unref(); } catch { /* ignore */ } resolve(true); });
  });
}

async function launchWin(item, target, args) {
  if (item.kind === 'uwp' && item.appId) {
    try {
      const c = await spawnDetached('explorer.exe', [`shell:AppsFolder\\${item.appId}`]);
      return { ok: true, pid: c.pid };
    } catch (e) {
      return { ok: false, error: '无法启动该应用: ' + e.message };
    }
  }

  const ext = path.extname(target).toLowerCase();
  // 快捷方式 / 脚本 / 协议链接交给系统处理
  if (['.lnk', '.url', '.bat', '.cmd', '.ps1', '.msc'].includes(ext) || target.includes('::')) {
    return openWithShell(target);
  }

  try {
    const child = await spawnDetached(target, args);
    return { ok: true, pid: child.pid };
  } catch (e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
      const ok = await launchElevated(target, args);
      return ok ? { ok: true, pid: 0 } : { ok: false, error: '该程序需要管理员权限，已取消' };
    }
    return openWithShell(target); // 兜底: ShellExecute
  }
}

/* --------------------------- macOS --------------------------- */
async function launchMac(target, args) {
  const ext = path.extname(target).toLowerCase();
  // .app 是目录，必须交给 LaunchServices；open -n 允许同时开多个实例
  if (ext === '.app') {
    try {
      const c = await spawnDetached('/usr/bin/open', ['-n', target, ...(args.length ? ['--args', ...args] : [])]);
      return { ok: true, pid: c.pid };
    } catch (e) {
      return { ok: false, error: '无法打开该应用: ' + e.message };
    }
  }
  try {
    const child = await spawnDetached(target, args);
    return { ok: true, pid: child.pid };
  } catch (e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
      const r = await retryAfterChmod(target, args);
      if (r) return r;
    }
    return openWithShell(target);
  }
}

/* --------------------------- Linux --------------------------- */
async function launchLinux(target, args) {
  const ext = path.extname(target).toLowerCase();

  if (ext === '.desktop') {
    // 优先按 Exec 直接起：能拿到 pid，后续"窗口铺满"才有依据
    try {
      const { parseDesktopFile } = require('./desktop-entry');
      const d = parseDesktopFile(fs.readFileSync(target, 'utf8'));
      if (d && d.execPath && fs.existsSync(d.execPath)) {
        const child = await spawnDetached(d.execPath, [...d.execArgs, ...args]);
        return { ok: true, pid: child.pid };
      }
    } catch { /* 落到 gio */ }
    try {
      const c = await spawnDetached('gio', ['launch', target]);
      return { ok: true, pid: c.pid };
    } catch {
      return openWithShell(target);
    }
  }

  try {
    const child = await spawnDetached(target, args);
    return { ok: true, pid: child.pid };
  } catch (e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
      const r = await retryAfterChmod(target, args);
      if (r) return r;
    }
    return openWithShell(target);
  }
}

/* --------------------------- 对外接口 --------------------------- */
async function launchItem(item) {
  if (!item) return { ok: false, error: '条目不存在' };

  const target = String(item.target || '').trim();
  if (!target) return { ok: false, error: '该条目没有可执行路径，请编辑后重试' };

  // 网址类条目直接交给浏览器
  if (/^https?:\/\//i.test(target) || target.startsWith('www.')) {
    try {
      electron().shell.openExternal(/^https?:/i.test(target) ? target : `https://${target}`);
      return { ok: true, pid: 0 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  if (!fs.existsSync(target)) return { ok: false, error: `路径不存在: ${target}` };

  const args = item.args ? splitArgs(item.args) : [];
  if (WIN) return launchWin(item, target, args);
  if (MAC) return launchMac(target, args);
  if (LINUX) return launchLinux(target, args);
  return { ok: false, error: `当前系统不支持启动应用（${process.platform}）` };
}

module.exports = { launchItem, splitArgs };
