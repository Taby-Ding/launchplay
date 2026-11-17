'use strict';
/**
 * lnk.js —— 快捷方式解析 + 选择结果标准化
 *
 * 用户手动添加程序时, 常见做法是选一个桌面/开始菜单的 .lnk。
 * 拿到 .lnk 后先解析出真实 exe 路径: 这样既能把图标提取到 256px,
 * 也能避免某些快捷方式带着奇怪的启动参数。
 *
 * 解析全部交给 shortcut.js（纯 JS 读二进制 + Electron 的 Shell 解析 + 跨电脑路径重定位）,
 * 不再启动外部脚本进程 —— 那正是"在这台电脑能提取图标、换一台就失效"的根源:
 * 不少机器会静默拦截那个进程, 解析失败后 target 停在 .lnk, 图标自然拿不到。
 */

const path = require('path');
const { resolveShortcut, parseUrlShortcut } = require('./shortcut');

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

  // Steam / Epic 等平台的游戏快捷方式: 协议链接 + IconFile, 没有可执行目标
  if (ext === '.url') {
    const u = parseUrlShortcut(file);
    if (u && u.iconPath) {
      out.iconPath = u.iconPath;
      out.resolved = 'url';
    } else {
      out.warning = '这个游戏快捷方式里的图标文件在当前电脑上找不到，请手动指定图标或直接选择游戏 exe';
    }
    return out;
  }

  if (ext !== '.lnk' || !deepLnk) return out;

  const r = resolveShortcut(file);
  if (r && r.targetExists) {
    out.path = r.target;
    out.args = r.args || '';
    out.iconPath = r.iconExists ? r.iconLocation : r.target;
    out.resolved = r.resolvedBy || 'native';
    out.relocatedPath = !!r.relocated;
    return out;
  }

  // 目标在本机找不到: 至少把快捷方式里记录的图标位置带出来,
  // 图标还有机会显示; 同时给界面一个提示, 让用户改选 exe。
  if (r && r.iconExists) out.iconPath = r.iconLocation;
  out.warning = '快捷方式指向的程序在这台电脑上不存在，请直接选择程序的 exe 文件';
  return out;
}

module.exports = { normalizePick };
