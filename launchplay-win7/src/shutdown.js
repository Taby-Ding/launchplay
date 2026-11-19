'use strict';
/**
 * shutdown.js —— 定时关机
 *
 * Windows 用系统级 `shutdown.exe /s /t <秒>`：即使本程序被关掉，到点依然会关机，
 * 取消用 `shutdown.exe /a`。macOS / Linux 没有免 root 的等价命令，改为应用内定时器
 * 兜底（到点调用 power()），此时需要保持程序运行。
 *
 * 只记录一个"到点时间"，倒计时由调用方按本地时钟计算，不依赖定时器精度。
 */

const { spawn } = require('child_process');
const { WIN } = require('./platform');
const { power } = require('./power');

let deadline = 0;          // Date.now() 时间戳，0 = 未设置
let fallbackTimer = null;  // 非 Windows 的应用内兜底定时器
let scheduledBy = '';      // 'system' | 'app'

function run(cmd, args) {
  try {
    const child = spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.once('spawn', () => { try { child.unref(); } catch { /* ignore */ } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function status() {
  const active = deadline > 0 && Date.now() < deadline;
  if (!active && deadline > 0) { deadline = 0; scheduledBy = ''; }
  return {
    active,
    remaining: active ? Math.ceil((deadline - Date.now()) / 1000) : 0,
    by: active ? scheduledBy : '',
  };
}

/** @param {number} hours 0-23 @param {number} minutes 0-59 */
function schedule(hours, minutes) {
  const h = Math.max(0, Math.min(23, Math.round(Number(hours) || 0)));
  const m = Math.max(0, Math.min(59, Math.round(Number(minutes) || 0)));
  const sec = h * 3600 + m * 60;
  if (sec <= 0) return { ok: false, error: '请选择大于 0 的时长' };

  cancel();

  if (WIN) {
    const r = run('shutdown.exe', ['/s', '/t', String(sec)]);
    if (!r.ok) return r;
    scheduledBy = 'system';
  } else {
    fallbackTimer = setTimeout(() => {
      deadline = 0;
      scheduledBy = '';
      fallbackTimer = null;
      power('shutdown');
    }, sec * 1000);
    scheduledBy = 'app';
  }

  deadline = Date.now() + sec * 1000;
  return { ok: true, ...status() };
}

function cancel() {
  if (WIN && (deadline > 0 || fallbackTimer)) run('shutdown.exe', ['/a']);
  if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
  deadline = 0;
  scheduledBy = '';
  return { ok: true };
}

module.exports = { schedule, cancel, status };
