'use strict';
/**
 * desktop-entry.js —— Linux 的 .desktop 启动项解析与图标查找
 *
 * .desktop 相当于 Linux 上的"快捷方式"，但它是纯文本，解析比 Windows 的 Shell Link
 * 简单得多：
 *
 *   [Desktop Entry]
 *   Name=VLC media player
 *   Exec=/usr/bin/vlc --started-from-file %U
 *   Icon=vlc
 *
 * 难点在 Icon=：里面写的通常只是**图标名**（vlc），真正的文件要按 freedesktop
 * 图标主题规范去 /usr/share/icons/<主题>/<尺寸>/apps/ 里找。这里按"尺寸从大到小"
 * 的顺序扫一遍，拿到最大的那张。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* --------------------------- .desktop 解析 --------------------------- */

/**
 * 按 Desktop Entry 规范切分 Exec 值：
 * 支持双引号包裹、反斜杠转义，并丢弃 %f %U %i 这类字段码。
 */
function splitExec(str) {
  const out = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\' && i + 1 < str.length) {
      cur += str[++i];
      has = true;
      continue;
    }
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  // %U / %f / %F / %u / %d / %D / %n / %N / %i / %c / %k / %v / %m 都是占位符
  return out
    .filter((t) => !/^%[a-zA-Z]$/.test(t))
    .map((t) => t.replace(/%[a-zA-Z]/g, ''))
    .filter((t) => t.length > 0);
}

/** 在 PATH 里找一个裸命令（Exec 里经常只写 vlc 而不是 /usr/bin/vlc） */
function which(cmd) {
  if (!cmd) return '';
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : '';
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, cmd);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return p;
    } catch { /* 继续找 */ }
  }
  return '';
}

/**
 * @param {string} text .desktop 文件内容
 * @returns {{name:string, exec:string, execPath:string, execArgs:string[], icon:string, terminal:boolean}|null}
 */
function parseDesktopFile(text) {
  const lines = String(text || '').split(/\r?\n/);
  let inEntry = false;
  const map = new Map();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    // 本地化键 Name[zh_CN] 单独存，主键优先
    if (!map.has(k)) map.set(k, v);
  }
  if (!map.size) return null;

  const exec = map.get('Exec') || '';
  const tokens = splitExec(exec);
  const execPath = (tokens.length && (path.isAbsolute(tokens[0]) ? tokens[0] : which(tokens[0]))) || '';
  return {
    name: map.get('Name') || '',
    exec,
    execPath,
    execArgs: tokens.slice(1),
    icon: map.get('Icon') || '',
    terminal: (map.get('Terminal') || '').toLowerCase() === 'true',
  };
}

/* --------------------------- 图标名 -> 文件 --------------------------- */

const ICON_ROOTS = [
  path.join(os.homedir(), '.local', 'share', 'icons'),
  path.join(os.homedir(), '.icons'),
  '/usr/local/share/icons',
  '/usr/share/icons',
  path.join(os.homedir(), '.local', 'share', 'flatpak', 'exports', 'share', 'icons'),
  '/var/lib/flatpak/exports/share/icons',
  '/var/lib/snapd/desktop/icons',
];

const PIXMAP_DIRS = [
  path.join(os.homedir(), '.local', 'share', 'pixmaps'),
  '/usr/local/share/pixmaps',
  '/usr/share/pixmaps',
];

// 从大到小：磁贴要的是 256 以上，找不到再逐级退让
const SIZES = ['512x512', '256x256', '384x384', '192x192', '128x128', '96x96', '64x64', '48x48', '32x32', 'scalable'];
const CATEGORIES = ['apps', 'applications'];

function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * 把 Icon=vlc 解析成真实文件路径。
 * 只返回位图（png/xpm），SVG 会在需要时由调用方另行处理 —— 这里的顺序是
 * 先找同名 PNG，实在没有再看 SVG（现代 GNOME 应用常常只发 SVG）。
 */
function resolveIconPath(icon) {
  const raw = String(icon || '').trim();
  if (!raw) return '';

  if (path.isAbsolute(raw)) {
    for (const ext of ['', '.png', '.svg', '.xpm']) {
      const p = raw + ext;
      if (fs.existsSync(p)) return p;
    }
    return '';
  }

  const base = raw.replace(/\.(png|svg|xpm)$/i, '');

  // 1) pixmaps 平铺目录
  for (const dir of PIXMAP_DIRS) {
    for (const ext of ['.png', '.svg', '.xpm']) {
      const p = path.join(dir, base + ext);
      if (fs.existsSync(p)) return p;
    }
  }

  // 2) 图标主题：hicolor 优先（规范要求应用图标都装在这里）
  const themes = [];
  for (const root of ICON_ROOTS) {
    const subs = listDirs(root);
    if (subs.includes('hicolor')) themes.push(path.join(root, 'hicolor'));
    for (const s of subs) {
      if (s === 'hicolor') continue;
      themes.push(path.join(root, s));
    }
  }

  for (const themeDir of themes) {
    for (const size of SIZES) {
      for (const cat of CATEGORIES) {
        const dir = path.join(themeDir, size, cat);
        for (const ext of ['.png', '.svg', '.xpm']) {
          const p = path.join(dir, base + ext);
          if (fs.existsSync(p)) return p;
        }
      }
    }
  }
  return '';
}

module.exports = { parseDesktopFile, resolveIconPath, splitExec, which };
