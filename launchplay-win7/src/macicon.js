'use strict';
/**
 * macicon.js —— macOS 应用图标提取（.app 包 / .icns 文件）
 *
 * macOS 不像 Windows 那样把图标塞进可执行文件的资源段，而是：
 *   LaunchPlay.app/Contents/Info.plist  -->  CFBundleIconFile = AppIcon
 *   LaunchPlay.app/Contents/Resources/AppIcon.icns
 *
 * .icns 是个简单容器：8 字节头（'icns' + 总长度），后面跟着一串
 * [4 字节类型][4 字节长度][数据]。现代图标里 ic07~ic14 这几类直接就是 PNG，
 * 所以只要把最大的一张挑出来即可，不需要处理老式的 ARGB/RLE 编码。
 */

const fs = require('fs');
const path = require('path');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 从大到小的优先级；同时也按数据长度兜底排序，兼容各种非标准 icns
const PREFERRED = ['ic10', 'ic14', 'ic09', 'ic13', 'ic08', 'ic07', 'ic12', 'ic11', 'icp6', 'icp5', 'icp4'];

/**
 * 从 .icns 里取出最大的一张 PNG
 * @param {Buffer} buf
 * @returns {Buffer|null}
 */
function icnsToPNG(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf.toString('ascii', 0, 4) !== 'icns') return null;

  const total = Math.min(buf.readUInt32BE(4) || buf.length, buf.length);
  const entries = [];
  let off = 8;
  while (off + 8 <= total) {
    const type = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    if (len < 8 || off + len > buf.length) break;
    const data = buf.subarray(off + 8, off + len);
    if (data.length > 16 && data.subarray(0, 8).equals(PNG_SIG)) {
      entries.push({ type, data });
    }
    off += len;
  }
  if (!entries.length) return null;

  const rank = (t) => {
    const i = PREFERRED.indexOf(t);
    return i < 0 ? PREFERRED.length : i;
  };
  entries.sort((a, b) => (rank(a.type) - rank(b.type)) || (b.data.length - a.data.length));
  return entries[0].data;
}

/** 读 Info.plist（Electron 打包出来是 XML 格式；遇到二进制 plist 就退化为扫资源目录） */
function readInfoPlist(appPath) {
  const p = path.join(appPath, 'Contents', 'Info.plist');
  try {
    const buf = fs.readFileSync(p);
    if (buf.toString('ascii', 0, 6) === 'bplist') return null;
    const txt = buf.toString('utf8');
    const pick = (key) => {
      const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
      const m = txt.match(re);
      return m ? m[1].trim() : '';
    };
    return {
      iconFile: pick('CFBundleIconFile'),
      displayName: pick('CFBundleDisplayName') || pick('CFBundleName'),
      identifier: pick('CFBundleIdentifier'),
    };
  } catch {
    return null;
  }
}

/** 找出 Resources 下体积最大的 .icns（兜底路径） */
function biggestIcnsInResources(appPath) {
  const dir = path.join(appPath, 'Contents', 'Resources');
  let best = '';
  let bestSize = 0;
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return ''; }
  for (const f of files) {
    if (!/\.icns$/i.test(f)) continue;
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (st.size > bestSize) { bestSize = st.size; best = full; }
    } catch { /* ignore */ }
  }
  return best;
}

/**
 * 从一个 .app 包中取出应用图标（PNG Buffer）
 * @param {string} appPath 形如 /Applications/Safari.app
 */
function iconFromAppBundle(appPath) {
  const info = readInfoPlist(appPath);
  const candidates = [];

  if (info && info.iconFile) {
    const name = /\.icns$/i.test(info.iconFile) ? info.iconFile : `${info.iconFile}.icns`;
    candidates.push(path.join(appPath, 'Contents', 'Resources', name));
  }
  const fallback = biggestIcnsInResources(appPath);
  if (fallback) candidates.push(fallback);

  for (const c of candidates) {
    try {
      const png = icnsToPNG(fs.readFileSync(c));
      if (png && png.length > 32) return png;
    } catch { /* 试下一个 */ }
  }
  return null;
}

/** 显示名：优先 Info.plist 里的名字，否则用包名去掉 .app */
function appBundleName(appPath) {
  const info = readInfoPlist(appPath);
  if (info && info.displayName) return info.displayName;
  return path.basename(appPath).replace(/\.app$/i, '');
}

module.exports = { icnsToPNG, iconFromAppBundle, appBundleName, readInfoPlist };
