'use strict';
/**
 * iconcache.js —— 图标解析与磁盘缓存
 *
 * 目标: 首次解析后写入缓存文件, 之后直接命中, 保证启动/打开面板都能秒开。
 *
 * 1.0 起跨平台, 图标来源按系统分派:
 *   Windows: exe/dll 的 PE 资源 (peicon.js) + .lnk 解析出的真实目标 (shortcut.js)
 *   macOS:   .app 包里的 .icns (macicon.js)
 *   Linux:   .desktop 的 Icon= -> 图标主题里的 png/svg (desktop-entry.js)
 *   公共:    用户手选的图片 (png/jpg/webp/gif/svg), 以及 Electron 的系统图标兜底
 *
 * 缓存文件名带内容类型后缀: 位图存 .png, 矢量存 .svg(直接复用原文件)。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WIN, MAC, LINUX } = require('./platform');
const { iconToPNG } = require('./peicon');
const { icnsToPNG, iconFromAppBundle } = require('./macicon');

const COPYABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp']);

// 图标缓存算法版本: 改动提取逻辑时 +1, 让老缓存自动失效
const CACHE_VERSION = 3;

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function isSvg(buf) {
  if (!buf || buf.length < 32) return false;
  const head = buf.subarray(0, 200).toString('utf8').trim().toLowerCase();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

/**
 * Windows 对"文件没有内嵌图标"返回的通用图标(空白页 / 空白页+箭头):
 * 40x40、几百字节, 放大到磁贴上是一块空白, 不如用字母磁贴。
 * 只用于系统图标回退的结果, 不影响用户手选的图片和 PE 提取的高清图标。
 */
function isGenericIcon(buf) {
  if (!buf || buf.length < 24 || buf.length >= 1600) return false;
  if (buf.readUInt32BE(0) !== 0x89504e47) return false;
  return buf.readUInt32BE(16) <= 48 && buf.readUInt32BE(20) <= 48;
}

/** 判断图标是否清晰到值得使用: 太小的图放大后会很糊, 不如用字母磁贴 */
function acceptIcon(buf) {
  if (!buf || buf.length < 32) return false;
  if (isSvg(buf)) return true; // 矢量图交给浏览器渲染, 无所谓尺寸
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
    this.memo = new Map(); // key -> 文件名
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

    if (WIN) {
      const isLnk = /\.lnk$/i.test(target);
      // 选 .lnk 时, 解析阶段已经把 IconLocation 放进 iconPath 了。
      // 换电脑后目标 exe 常常找不到, 但图标位置往往还有效, 所以把它排在最前面。
      const picked = stripIndex(item.iconPath);
      if (picked && !/\.lnk$/i.test(picked)) push(picked);
      push(target);
      if (isLnk) {
        try {
          const { resolveShortcut } = require('./shortcut');
          const sc = resolveShortcut(target);
          if (sc) {
            push(sc.target);
            push(sc.iconLocation); // 不再要求 iconExists, push 内部会 stat
          }
        } catch { /* 解析失败就只用 .lnk 本身 */ }
      }
      // Steam / Epic 的 .url: 图标藏在文件里的 IconFile= 字段
      // (启动自愈时 item 可能只有 target, 没有解析过的 iconPath, 这里补一次)
      if (/\.url$/i.test(target)) {
        try {
          const { parseUrlShortcut } = require('./shortcut');
          const u = parseUrlShortcut(target);
          if (u && u.iconPath) push(u.iconPath);
        } catch { /* 忽略 */ }
      }
      return out;
    }

    if (MAC) {
      push(target);
      push(item.iconPath);
      return out;
    }

    // Linux: 目标可能是可执行文件(没有内嵌图标), 所以 iconPath 反而更重要
    if (LINUX) {
      push(item.iconPath);
      push(target);
      if (/\.desktop$/i.test(target)) {
        try {
          const { parseDesktopFile, resolveIconPath } = require('./desktop-entry');
          const d = parseDesktopFile(fs.readFileSync(target, 'utf8'));
          const icon = d ? resolveIconPath(d.icon) : '';
          push(icon);
        } catch { /* 解析不了就只留原文件 */ }
      }
      return out;
    }

    push(target);
    push(item.iconPath);
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

  /** 依次尝试各个候选, 返回 { buf, ext } 或 null */
  extract(item) {
    const sources = IconCache.sourcesOf(item);
    for (const src of sources) {
      const ext = path.extname(src).toLowerCase();
      let buf = null;
      let outExt = '.png';

      if (COPYABLE.has(ext)) {
        // 用户自选图片 / Linux 主题里的矢量图, 直接复用原文件
        try { buf = fs.readFileSync(src); } catch { buf = null; }
        outExt = ext === '.svg' ? '.svg' : '.png';
      } else if (ext === '.app') {
        buf = iconFromAppBundle(src);
      } else if (ext === '.icns') {
        try { buf = icnsToPNG(fs.readFileSync(src)); } catch { buf = null; }
      } else if (ext === '.desktop') {
        try {
          const { parseDesktopFile, resolveIconPath } = require('./desktop-entry');
          const d = parseDesktopFile(fs.readFileSync(src, 'utf8'));
          const icon = d ? resolveIconPath(d.icon) : '';
          if (icon && icon !== src) {
            const iext = path.extname(icon).toLowerCase();
            buf = fs.readFileSync(icon);
            outExt = iext === '.svg' ? '.svg' : '.png';
          }
        } catch { buf = null; }
      } else if (WIN) {
        buf = iconToPNG(src); // exe / dll / ico
      }

      if (acceptIcon(buf)) return { buf, ext: outExt };
    }
    return null;
  }

  /**
   * 确保图标已缓存, 返回文件名 (不含目录) 或 '' 表示没有可用图标
   */
  async ensure(item) {
    const key = this.keyOf(item);
    if (this.memo.has(key)) return this.memo.get(key);

    // 命中已有缓存(可能是上一次以另一种格式存下的)
    for (const ext of ['.png', '.svg']) {
      const fname = key + ext;
      if (safeStat(path.join(this.dir, fname))) {
        this.memo.set(key, fname);
        return fname;
      }
    }

    let got = null;
    try { got = this.extract(item); } catch { got = null; }

    // 系统图标回退: 先对真实文件(目标 exe / IconLocation)要图标, 最后才轮到 .lnk 本身。
    // 老版本对 .lnk 一刀切禁用回退, 于是快捷方式一旦解析不出来就一个图标都没有 ——
    // 这正是"换台电脑后图标全变字母"最直接的一层。
    // getFileIcon 对没有内嵌图标的文件会返回通用空白图标, 快捷方式条目把它过滤掉。
    if (!got && this.fallback) {
      const target = String(item.target || '').trim();
      const isLnk = /\.lnk$/i.test(target);
      const sources = IconCache.sourcesOf(item);
      const fbCandidates = sources.filter((p) => !/\.lnk$/i.test(p));
      if (isLnk) fbCandidates.push(target);
      for (const p of fbCandidates) {
        let fb = null;
        try { fb = await this.fallback(p); } catch { fb = null; }
        const generic = isLnk && isGenericIcon(fb);
        if (acceptIcon(fb) && !generic) { got = { buf: fb, ext: '.png' }; break; }
      }
    }

    if (!got) {
      this.memo.set(key, '');
      return '';
    }

    const fname = key + got.ext;
    const full = path.join(this.dir, fname);
    try {
      const tmp = full + '.tmp';
      fs.writeFileSync(tmp, got.buf);
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
    const ext = path.extname(srcPath).toLowerCase();
    const outExt = ext === '.svg' ? '.svg' : '.png';
    const key = crypto.createHash('sha1')
      .update(`${srcPath}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 20);
    const fname = key + outExt;
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
