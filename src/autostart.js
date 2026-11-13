'use strict';
/**
 * autostart.js —— 开机自启（三平台）
 *
 *   Windows: HKCU\Software\Microsoft\Windows\CurrentVersion\Run\LaunchPlay
 *   macOS:   ~/Library/LaunchAgents/com.launchplay.desktop.plist（RunAtLoad）
 *   Linux:   ~/.config/autostart/launchplay.desktop（XDG 自启规范）
 *
 * 三个平台都不用管理员权限：Windows 写 HKCU，mac/linux 写用户家目录下的配置文件。
 * 所有失败都返回 { ok:false } 而不是抛异常 —— 开关状态不能因为一次写盘失败就卡住。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { WIN, MAC, LINUX } = require('./platform');

/** 由 main.js 在 ready 之后注入：运行目标路径等信息 */
const ctx = {
  exePath: '',   // 当前可执行文件（便携 exe / AppImage / 二进制）
  appPath: '',   // macOS 的 .app 包路径
  appId: 'com.launchplay.desktop',
  displayName: '影音快启 LaunchPlay',
};

function init(o) {
  Object.assign(ctx, o || {});
}

/* --------------------------- Windows --------------------------- */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'LaunchPlay';

function regExe(args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      execFile('reg.exe', args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: String((e && e.message) || e) });
    }
  });
}

async function getWin() {
  const r = await regExe(['query', RUN_KEY, '/v', RUN_VALUE]);
  if (!r.ok) return { enabled: false, command: '' };
  const m = r.stdout.match(new RegExp(`${RUN_VALUE}\\s+REG_SZ\\s+(.+)`, 'i'));
  return { enabled: !!m, command: m ? m[1].trim() : '' };
}

async function setWin(enabled) {
  if (enabled) {
    const cmd = `"${ctx.exePath}"`;
    const r = await regExe(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', cmd, '/f']);
    return r.ok;
  }
  // 不存在时删除会报错，忽略即可
  await regExe(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  return true;
}

/* --------------------------- macOS --------------------------- */
function macPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${ctx.appId}.plist`);
}

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getMac() {
  const p = macPlistPath();
  if (!fs.existsSync(p)) return { enabled: false, command: '' };
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const app = (txt.match(/<string>([^<]*\.app)<\/string>/) || [])[1] || '';
    return { enabled: true, command: app ? `open -a "${app}"` : 'launchctl (plist)' };
  } catch {
    return { enabled: false, command: '' };
  }
}

async function setMac(enabled) {
  const p = macPlistPath();
  try {
    if (!enabled) {
      try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
      // 顺手卸载已注册的任务，避免本次登录内仍然生效
      execFile('/bin/launchctl', ['unload', p], { timeout: 5000 }, () => {});
      return true;
    }
    if (!ctx.appPath) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ctx.appId}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>${xmlEsc(ctx.appPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
    fs.writeFileSync(p, xml, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/* --------------------------- Linux --------------------------- */
function linuxDesktopPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'autostart', 'launchplay.desktop');
}

/** Desktop Entry 规范里 Exec 的引号规则：含空格/特殊字符时必须整体加引号 */
function desktopQuote(s) {
  if (!/[\s"'\\$`]/.test(s)) return s;
  return `"${String(s).replace(/(["`$\\])/g, '\\$1')}"`;
}

async function getLinux() {
  const p = linuxDesktopPath();
  if (!fs.existsSync(p)) return { enabled: false, command: '' };
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const exec = (txt.match(/^Exec=(.*)$/m) || [])[1] || '';
    return { enabled: true, command: exec.trim() };
  } catch {
    return { enabled: false, command: '' };
  }
}

async function setLinux(enabled) {
  const p = linuxDesktopPath();
  try {
    if (!enabled) {
      try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
      return true;
    }
    if (!ctx.exePath) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const body = `[Desktop Entry]
Type=Application
Name=${ctx.displayName}
Comment=把电脑变成电视式大屏启动器
Exec=${desktopQuote(ctx.exePath)}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
    fs.writeFileSync(p, body, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/* --------------------------- 对外接口 --------------------------- */
async function getAutostart() {
  if (WIN) return getWin();
  if (MAC) return getMac();
  if (LINUX) return getLinux();
  return { enabled: false, command: '' };
}

async function setAutostart(enabled) {
  if (WIN) return setWin(!!enabled);
  if (MAC) return setMac(!!enabled);
  if (LINUX) return setLinux(!!enabled);
  return false;
}

module.exports = { init, getAutostart, setAutostart };
