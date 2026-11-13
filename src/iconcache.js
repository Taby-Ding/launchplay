'use strict';
/**
 * iconcache.js —— 图标解析与磁盘缓存
 * 目标: 首次解析后写入 png 缓存, 之后直接命中文件, 保证启动/打开面板都能秒开。
 *
 * 2.2 起的两处关键修正:
 *   1) 快捷方式(.lnk)会先解析出真实目标 / IconLocation, 再逐个候选尝试提取 ——
 *      以前直接把 .lnk 交给 Shell 取图标, 拿到的是"空白页 + 快捷方式箭头"的通用图标,
 *      看起来就像"自动获取图标失效";
 *   2) 缓存 key 带版本号, 老版本留下的错误图标不会继续命中。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { iconToPNG } = require('./peicon');
const { resolveShortcut } = require('./shortcut');

const COPYABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);

// 图标缓存算法版本: 改动提取逻辑时 +1, 让老缓存自动失效
const CACHE_VERSION = 2;

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

/** "C:\a\b.exe,0" -> "C:\a\b.exe" */
function stripIndex(raw) {
  return String(raw || '').trim().split(',')[0].trim().replace(/^"|"$/g, '');
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

  /**
   * 按优先级列出可用的图标来源文件。
   * 目标程序自己在最前面 —— 快捷方式解出来的 IconLocation 往往只是个小 ico/程序壳,
   * 真实程序图标通常更清晰; 但目标不存在时它会自然被跳过。
   */
  static sourcesOf(item) {
    const out = [];
    const push = (p) => {
      if (!p) return;
      const abs = String(p).trim();
      if (!abs || out.includes(abs)) return;
      if (!safeStat(abs)) return;
      out.push(abs);
    };

    const target = String(item.target || '').trim();
    const isLnk = /\.lnk$/i.test(target);

    push(target);
    if (isLnk) {
      try {
        const sc = resolveShortcut(target);
        if (sc) {
          push(sc.target);
          if (sc.iconExists) push(sc.iconLocation);
        }
      } catch { /* 解析失败就只用 .lnk 本身 */ }
    }
    push(stripIndex(item.iconPath));
    return out;
  }

  /** 旧的单来源接口, 保留给别处调用 */
  static iconFileOf(item) {
    return IconCache.sourcesOf(item)[0] || '';
  }

  keyOf(item) {
    const sources = IconCache.sourcesOf(item);
    // 用"第一个真正能出图标的文件"做 key: 快捷方式本身不参与,
    // 这样添加时(带 iconPath)和启动后自愈重算时算出来的 key 一致, 不会重复生成缓存
    const usable = sources.filter((p) => !/\.lnk$/i.test(p));
    const keyFile = usable[0] || sources[0] || '';
    const st = keyFile ? safeStat(keyFile) : null;
    const stamp = st ? `${st.size}:${Math.round(st.mtimeMs)}` : 'none';
    const raw = `v${CACHE_VERSION}|${item.kind}|${item.target}|${item.appId}|${keyFile}|${stamp}`;
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20);
  }

  fileNameOf(key) {
    return key + '.png';
  }

  /** 依次尝试各个候选, 返回第一个可用图标的 PNG Buffer */
  extract(item) {
    const sources = IconCache.sourcesOf(item);
    for (const src of sources) {
      const ext = path.extname(src).toLowerCase();
      let png = null;
      if (COPYABLE.has(ext)) {
        // UWP 包图标 / 用户自选 png, 直接复用原文件
        try { png = fs.readFileSync(src); } catch { png = null; }
      } else {
        png = iconToPNG(src); // exe / dll / ico
      }
      if (acceptIcon(png)) return png;
    }
    return null;
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
    try { png = this.extract(item); } catch { png = null; }

    // 系统图标回退: 只给非快捷方式用。
    // 对 .lnk 调用 getFileIcon 拿到的一定是"空白文件 + 快捷方式箭头"的通用图标,
    // 显示出来反而比首字母磁贴更让人困惑。
    const target = String(item.target || '').trim();
    const isLnk = /\.lnk$/i.test(target);
    if (!png && !isLnk && this.fallback) {
      try {
        const fb = await this.fallback(target || IconCache.sourcesOf(item)[0]);
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

module.exports = { IconCache, CACHE_VERSION };
