'use strict';
/**
 * lnk.js —— 快捷方式解析 + 选择结果标准化
 *
 * 用户手动添加程序时, 常见做法是选一个桌面/开始菜单的 .lnk。
 * 拿到 .lnk 后先尝试解析出真实 exe 路径: 这样既能把图标提取到 256px,
 * 也能避免某些快捷方式带着奇怪的启动参数。
 * 解析失败则退回"直接启动 .lnk", 功能不受影响。
 *
 * 解析顺序: 原生二进制解析(1ms) -> PowerShell(兼容 MSI 发布点等特殊情况)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { RESOLVE_LNK_PS } = require('./ps-scripts');
const { resolveShortcut } = require('./shortcut');

let seq = 0;
function tmpFile(ext) {
  return path.join(os.tmpdir(), `launchplay-${process.pid}-${Date.now()}-${seq++}${ext}`);
}

function runPS(script, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const ps1 = tmpFile('.ps1');
    const out = tmpFile('.json');
    fs.writeFileSync(ps1, '\uFEFF' + script, 'utf8');
    let child;
    const cleanup = () => {
      try { fs.unlinkSync(ps1); } catch { /* ignore */ }
    };
    try {
      child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args, out],
        { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
        (err) => {
          cleanup();
          if (err) return reject(err);
          try {
            const txt = fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '').trim();
            try { fs.unlinkSync(out); } catch { /* ignore */ }
            resolve(txt ? JSON.parse(txt) : null);
          } catch (e) {
            reject(e);
          }
        }
      );
    } catch (e) {
      cleanup();
      return reject(e);
    }
    child.on('error', reject);
  });
}

/**
 * 把用户选中的文件标准化为可添加的条目
 * @param {string} file 绝对路径
 * @param {boolean} deepLnk 是否尝试解析 .lnk (单个选择时值得, 批量时略过)
 */
async function normalizePick(file, deepLnk = true) {
  const base = path.basename(file);
  const name = base.replace(/\.[^.]+$/, '');
  const ext = path.extname(file).toLowerCase();

  const out = { path: file, name, args: '', iconPath: file, isLnk: ext === '.lnk' };
  if (ext !== '.lnk' || !deepLnk) return out;

  // 1) 先走原生解析: 快, 且不依赖 powershell.exe 是否可用
  try {
    const r = resolveShortcut(file);
    if (r && r.target && r.targetExists) {
      out.path = r.target;
      out.args = r.args || '';
      out.iconPath = r.iconExists ? r.iconLocation : r.target;
      out.name = name;
      out.resolved = 'native';
      return out;
    }
  } catch { /* 继续尝试 PowerShell */ }

  // 2) 回退: 有些快捷方式(如 MSI 发布点)本地路径为空, 只能交给 Shell 解析
  try {
    const r = await runPS(RESOLVE_LNK_PS, [file]);
    if (r && r.target && fs.existsSync(r.target)) {
      out.path = r.target;
      out.args = r.args || '';
      out.iconPath = r.iconPath || r.target;
      out.name = (r.name || name).trim() || name;
      out.resolved = 'powershell';
    }
  } catch { /* 解析失败就用 .lnk 本身 */ }

  return out;
}

module.exports = { normalizePick, runPS };
