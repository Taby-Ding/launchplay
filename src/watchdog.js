'use strict';
/**
 * watchdog.js —— 家长守护轻量加固的独立守护进程
 *
 * 由 lockdown.js 用同一个 exe 以 --launchplay-watchdog 参数拉起。
 * 每 1.5 秒检查主进程是否还在；不在且没有「正常退出标记」就重新拉起程序。
 * 正常退出前主进程会写 quit.flag，本进程见到后自行结束，不会干扰正常退出/升级。
 *
 * 注意：这是普通用户态进程，任务管理器同样可以结束它。
 * 它的作用是让「误关 / 应用内退出」后软件自动回来，不是防系统级强杀。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function run() {
  const pid = Number(arg('lp-pid'));
  const dir = arg('lp-dir');
  if (!pid || !dir) return process.exit(0);
  const flag = path.join(dir, 'quit.flag');

  const timer = setInterval(() => {
    // 正常退出 / 家长主动关闭加固：不再拉起
    if (fs.existsSync(flag)) {
      clearInterval(timer);
      try { fs.unlinkSync(flag); } catch { /* ignore */ }
      return process.exit(0);
    }
    if (alive(pid)) return;
    clearInterval(timer);
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(process.execPath, [], {
        detached: true, stdio: 'ignore', windowsHide: true, env,
      });
      child.unref();
    } catch { /* 拉不起来就安静退出 */ }
    process.exit(0);
  }, 1500);

  // 兜底：主进程 PID 被系统回收复用时不要无限驻留
  setTimeout(() => { clearInterval(timer); process.exit(0); }, 12 * 60 * 60 * 1000);
}

module.exports = { run };
