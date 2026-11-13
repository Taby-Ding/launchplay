'use strict';
/**
 * iconcache.js —— 图标解析与磁盘缓存
 * 目标: 首次解析后写入 png 缓存, 之后直接命中文件, 保证启动/打开面板都能秒开。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { iconToPNG } = require('./peicon');

const COPYABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

/** 判断图标是否清晰到值得使用: 太小的图放大后会很糊, 不如用字母磁贴 */
function acceptIcon(buf) {
  if (!buf || buf.length < 32) return false;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.length < 24) return true; // 非 PNG 交给浏览器处理
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return w >= 40 && h >= 40;
}

class IconCache {
  /**
   * @param {string} dir 缓存目录
   * @param {(p:string)=>Promise<Buffer|null>} fallback 系统图标回退 (Electron app.getFileIcon)
   */
  constructor(dir, fallback) {
    this.dir = dir;
    this.fallback = fallback;
    this.memo = new Map(); // key -> url
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  /** 从 DisplayIcon 字符串里取出实际文件路径: "C:\a\b.exe,0" -> "C:\a\b.exe" */
  static iconFileOf(item) {
    const raw = (item.iconPath || '').trim();
    if (raw) {
      const p = raw.split(',')[0].trim().replace(/^"|"$/g, '');
      if (p && safeStat(p)) return p;
    }
    return item.target && safeStat(item.target) ? item.target : '';
  }

  keyOf(item) {
    const src = IconCache.iconFileOf(item);
    const st = src ? safeStat(src) : null;
    const stamp = st ? `${st.size}:${Math.round(st.mtimeMs)}` : 'none';
    const raw = `${item.kind}|${item.target}|${item.appId}|${src}|${stamp}`;
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20);
  }

  fileNameOf(key) {
    return key + '.png';
  }

  /**
   * 确保图标已缓存, 返回文件名 (不含目录) 或 '' 表示没有可用图标
   */
  async ensure(item) {
    const key = this.keyOf(item);
    if (this.memo.has(key)) return this.memo.get(key);

    const fname = this.fileNameOf(key);
    const full = path.join(this.dir, fname);
    if (safeStat(full)) {
      this.memo.set(key, fname);
      return fname;
    }

    let png = null;
    const src = IconCache.iconFileOf(item);
    const ext = src ? path.extname(src).toLowerCase() : '';

    if (src && COPYABLE.has(ext) && ext !== '.bmp') {
      // UWP 包图标 / 用户自选 png, 直接复用原文件
      try { png = fs.readFileSync(src); } catch { png = null; }
    } else if (src) {
      png = iconToPNG(src); // exe / dll / ico
    }
    if (!acceptIcon(png)) png = null;

    if (!png && item.target) {
      const alt = iconToPNG(item.target);
      if (acceptIcon(alt)) png = alt;
    }

    if (!png && this.fallback) {
      try {
        const fb = await this.fallback(item.target || src);
        if (acceptIcon(fb)) png = fb;
      } catch { png = null; }
    }

    if (!png) {
      this.memo.set(key, '');
      return '';
    }

    try {
      const tmp = full + '.tmp';
      fs.writeFileSync(tmp, png);
      fs.renameSync(tmp, full);
    } catch {
      this.memo.set(key, '');
      return '';
    }
    this.memo.set(key, fname);
    return fname;
  }

  /** 用户手动指定图片做为图标 */
  importImage(srcPath) {
    const st = safeStat(srcPath);
    if (!st) return '';
    const key = crypto.createHash('sha1')
      .update(`${srcPath}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 20);
    const fname = key + '.png';
    const full = path.join(this.dir, fname);
    if (!safeStat(full)) {
      try {
        fs.copyFileSync(srcPath, full);
      } catch {
        return '';
      }
    }
    return fname;
  }
}

module.exports = { IconCache };
