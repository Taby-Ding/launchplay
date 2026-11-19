'use strict';
/**
 * power.js —— 关机 / 重启（三平台）
 *
 * Windows: shutdown.exe /s|/r
 * macOS:   AppleScript 通知 System Events（首次会弹一次"允许控制"授权框）
 * Linux:   systemctl poweroff|reboot（走 polkit，桌面环境已登录时免密码）
 */

const { spawn } = require('child_process');
const { WIN, MAC, LINUX } = require('./platform');

function run(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    child.once('error', (e) => resolve({ ok: false, error: e.message }));
    child.once('spawn', () => { try { child.unref(); } catch { /* ignore */ } resolve({ ok: true }); });
  });
}

/**
 * @param {'shutdown'|'restart'} action
 */
function power(action) {
  const restart = action === 'restart';
  if (WIN) return run('shutdown.exe', [restart ? '/r' : '/s', '/t', '0']);
  if (MAC) {
    const verb = restart ? 'restart' : 'shut down';
    return run('/usr/bin/osascript', ['-e', `tell application "System Events" to ${verb}`]);
  }
  if (LINUX) return run('systemctl', [restart ? 'reboot' : 'poweroff']);
  return Promise.resolve({ ok: false, error: `当前系统不支持该操作（${process.platform}）` });
}

module.exports = { power };
