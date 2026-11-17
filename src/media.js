'use strict';
/**
 * media.js —— 系统音量 / 播放控制（跨平台，尽力而为）
 *
 * 为什么是"尽力而为"：
 *   操作系统没有给普通应用一个统一的"改系统音量"接口。
 *   - Windows 用一段内联 PowerShell 调 user32 发媒体键（VK_VOLUME_* / VK_MEDIA_*）；
 *     不落盘脚本，避免过去 .ps1 被安全策略拦截的问题。
 *   - Linux 依次尝试 playerctl / pactl / xdotool，谁在用谁。
 *   - macOS 用 osascript。
 * 每条路径失败都明确返回 {ok:false,error}，由界面提示用户，不静默失败。
 */

const { spawn } = require('child_process');
const { WIN, MAC, LINUX } = require('./platform');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore', ...opts });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    let settled = false;
    child.once('error', (e) => { if (!settled) { settled = true; resolve({ ok: false, error: e.message }); } });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      resolve(code === 0 ? { ok: true } : { ok: false, error: `命令退出码 ${code}` });
    });
  });
}

/** Windows 虚拟键码 */
const VK = {
  volup: 0xaf,     // VK_VOLUME_UP
  voldown: 0xae,   // VK_VOLUME_DOWN
  mute: 0xad,      // VK_VOLUME_MUTE
  play: 0xb3,      // VK_MEDIA_PLAY_PAUSE
  next: 0xb0,      // VK_MEDIA_NEXT_TRACK
  prev: 0xb1,      // VK_MEDIA_PREV_TRACK
};

function winMedia(action) {
  const vk = VK[action];
  if (vk === undefined) return Promise.resolve({ ok: false, error: '不支持的操作' });
  // keybd_event 按下+抬起；内联传参，不写临时脚本
  const ps = `-NoProfile -NonInteractive -WindowStyle Hidden -Command ` +
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class LPKey{[DllImport("user32.dll")]public static extern void keybd_event(byte k,byte s,uint f,IntPtr e);}';` +
    `[LPKey]::keybd_event(${vk},0,0,[IntPtr]::Zero);[LPKey]::keybd_event(${vk},0,2,[IntPtr]::Zero)`;
  return run('powershell.exe', ps.split(' ').filter(Boolean));
}

async function linuxMedia(action) {
  // 播放器控制优先 playerctl（播放/暂停/切歌）
  if (['play', 'next', 'prev'].includes(action)) {
    const arg = { play: 'play-pause', next: 'next', prev: 'previous' }[action];
    let r = await run('playerctl', [arg]);
    if (r.ok) return r;
    // 没有 playerctl 就退回 X11 媒体键
    const key = { play: 'XF86AudioPlay', next: 'XF86AudioNext', prev: 'XF86AudioPrev' }[action];
    return run('xdotool', ['key', key]);
  }
  // 音量：pactl（PulseAudio/PipeWire）优先，退回 amixer
  if (action === 'volup' || action === 'voldown') {
    const sign = action === 'volup' ? '+5%' : '-5%';
    let r = await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', sign]);
    if (r.ok) return r;
    return run('amixer', ['-D', 'pulse', 'sset', 'Master', action === 'volup' ? '5%+' : '5%-']);
  }
  if (action === 'mute') {
    let r = await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
    if (r.ok) return r;
    return run('amixer', ['-D', 'pulse', 'sset', 'Master', 'toggle']);
  }
  return { ok: false, error: '不支持的操作' };
}

function macMedia(action) {
  const script = {
    volup: 'set volume output volume (output volume of (get volume settings) + 5)',
    voldown: 'set volume output volume (output volume of (get volume settings) - 5)',
    mute: 'set volume with output muted',
    play: 'tell application "System Events" to key code 49', // 空格 = 播放/暂停
    next: 'tell application "System Events" to key code 124', // 右方向键
    prev: 'tell application "System Events" to key code 123', // 左方向键
  }[action];
  if (!script) return Promise.resolve({ ok: false, error: '不支持的操作' });
  return run('/usr/bin/osascript', ['-e', script]);
}

/** 控制音量/播放，action ∈ {volup,voldown,mute,play,next,prev} */
function media(action) {
  if (WIN) return winMedia(action);
  if (LINUX) return linuxMedia(action);
  if (MAC) return macMedia(action);
  return Promise.resolve({ ok: false, error: `当前系统不支持媒体控制（${process.platform}）` });
}

module.exports = { media };
