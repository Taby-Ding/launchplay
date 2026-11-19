'use strict';
/**
 * pick.js —— 用户选中文件后的标准化（三平台）
 *
 * 同一个动作在三个系统上用户点到的"快捷方式"长得完全不同：
 *   Windows  -> .lnk（Shell Link 二进制，见 lnk.js / shortcut.js）
 *   macOS    -> .app（其实是目录，名字和图标都在包里的 Info.plist / .icns）
 *   Linux    -> .desktop（纯文本，Exec / Icon 两个键）
 *
 * 这里统一成 { path, name, args, iconPath }，后面所有逻辑就不用再管平台了。
 */

const fs = require('fs');
const path = require('path');
const { WIN, MAC, LINUX } = require('./platform');

/** 带空格的参数加上引号，保证存进 JSON 后还能被 splitArgs 还原 */
function quoteArg(a) {
  const s = String(a);
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function normalizeMac(file, ext) {
  const out = {
    path: file, name: path.basename(file).replace(/\.[^.]+$/, ''), args: '', iconPath: file, isLnk: false,
  };
  if (ext === '.app') {
    try {
      const { appBundleName } = require('./macicon');
      out.name = appBundleName(file) || out.name;
    } catch { /* 用文件名兜底 */ }
  }
  return out;
}

function normalizeLinux(file, ext) {
  const out = {
    path: file, name: path.basename(file).replace(/\.[^.]+$/, ''), args: '', iconPath: file, isLnk: false,
  };
  if (ext === '.desktop') {
    try {
      const { parseDesktopFile, resolveIconPath } = require('./desktop-entry');
      const d = parseDesktopFile(fs.readFileSync(file, 'utf8'));
      if (d) {
        if (d.execPath && fs.existsSync(d.execPath)) {
          out.path = d.execPath;
          out.args = d.execArgs.map(quoteArg).join(' ');
        }
        if (d.name) out.name = d.name;
        const icon = resolveIconPath(d.icon);
        out.iconPath = icon || file; // 解析不到就先记 .desktop 自己，运行时还能再试
      }
    } catch { /* 解析失败就按原文件处理（gio launch 也能打开） */ }
  }
  return out;
}

/**
 * @param {string} file 绝对路径
 * @param {boolean} deep 是否深入解析（批量选择时关掉，省时间）
 */
async function normalizePick(file, deep = true) {
  const ext = path.extname(file).toLowerCase();

  if (WIN) {
    const { normalizePick: normalizeWin } = require('./lnk');
    return normalizeWin(file, deep);
  }
  if (MAC) return normalizeMac(file, ext);
  if (LINUX) return normalizeLinux(file, ext);

  return { path: file, name: path.basename(file).replace(/\.[^.]+$/, ''), args: '', iconPath: file, isLnk: false };
}

module.exports = { normalizePick, quoteArg };
