'use strict';
/**
 * shortcut.js —— 原生解析 Windows 快捷方式(.lnk)
 *
 * 为什么要自己解析:
 *   1) 之前靠 PowerShell + WScript.Shell 解析, 单个快捷方式要 2~3 秒(冷启动更久),
 *      而"浏览…"是同步等待的, 体验很差;
 *   2) 某些安全策略下 powershell.exe 起不来, 解析就静默失败 —— 结果是 target 停在 .lnk,
 *      图标只能退回 Shell 给的"空白页+快捷方式箭头"(40x40 通用图标),
 *      用户看到的就是"自动获取图标失效"。
 *
 * 这里直接读 Shell Link 二进制格式(MS-SHLLINK), 1ms 拿到 TargetPath / Arguments /
 * IconLocation。解析不出来时调用方再退回 PowerShell。
 *
 * 只处理本地快捷方式; 指向 MSI 发布点(Darwin 描述符)这类特殊快捷方式拿不到
 * LocalBasePath, 会如实返回空路径, 由调用方回退。
 */

const fs = require('fs');
const path = require('path');

const HEADER_SIZE = 0x4c;

const FLAG = {
  ID_LIST: 0x00000001,
  LINK_INFO: 0x00000002,
  NAME: 0x00000004,
  RELATIVE_PATH: 0x00000008,
  WORKING_DIR: 0x00000010,
  ARGUMENTS: 0x00000020,
  ICON_LOCATION: 0x00000040,
  IS_UNICODE: 0x00000080,
};

/** 读以 \0 结尾的字符串 */
function cstr(buf, off, unicode) {
  if (off < 0 || off >= buf.length) return '';
  if (unicode) {
    let end = off;
    while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
    return buf.subarray(off, end).toString('utf16le');
  }
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.subarray(off, end).toString('latin1');
}

/** StringData: 先 2 字节字符数, 再字符数据 */
function readStringData(buf, p, unicode) {
  if (p + 2 > buf.length) return { value: '', next: buf.length };
  const chars = buf.readUInt16LE(p);
  const bytes = chars * (unicode ? 2 : 1);
  const start = p + 2;
  if (start + bytes > buf.length) return { value: '', next: buf.length };
  const raw = buf.subarray(start, start + bytes);
  return { value: unicode ? raw.toString('utf16le') : raw.toString('latin1'), next: start + bytes };
}

/** 展开 %ProgramFiles% 之类的环境变量 */
function expandEnv(s) {
  return String(s || '').replace(/%([^%]+)%/g, (all, name) => {
    const v = process.env[name] !== undefined
      ? process.env[name]
      : Object.entries(process.env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    return v === undefined ? all : v;
  });
}

/** "C:\a\b.ico,0" -> "C:\a\b.ico"; ",0" -> "" (表示用程序自身图标) */
function stripIconIndex(s) {
  const m = String(s || '').match(/^(.*?)(?:,\s*-?\d+)\s*$/);
  return (m ? m[1] : String(s || '')).trim();
}

/**
 * 解析 .lnk
 * @returns {{lnk:string,target:string,args:string,workingDir:string,iconLocation:string}|null}
 */
function parseShortcut(lnkPath) {
  let buf;
  try {
    const st = fs.statSync(lnkPath);
    if (!st.isFile() || st.size < HEADER_SIZE || st.size > 4 * 1024 * 1024) return null;
    buf = fs.readFileSync(lnkPath);
  } catch {
    return null;
  }
  if (buf.readUInt32LE(0) !== HEADER_SIZE) return null;

  const flags = buf.readUInt32LE(0x14);
  const unicode = (flags & FLAG.IS_UNICODE) !== 0;

  let p = HEADER_SIZE;

  // LinkTargetIDList: 2 字节长度 + 数据
  if (flags & FLAG.ID_LIST) {
    if (p + 2 > buf.length) return null;
    const size = buf.readUInt16LE(p);
    p += 2 + size;
  }

  const out = { lnk: lnkPath, target: '', args: '', workingDir: '', iconLocation: '' };

  // LinkInfo: 本地路径的主要来源
  if (flags & FLAG.LINK_INFO) {
    if (p + 28 > buf.length) return null;
    const liSize = buf.readUInt32LE(p);
    const liHeader = buf.readUInt32LE(p + 4);
    if (liSize < 28 || p + liSize > buf.length) return null;

    const localBaseOff = buf.readUInt32LE(p + 16);
    const suffixOff = buf.readUInt32LE(p + 24);

    let localBase = '';
    let suffix = '';
    if (liHeader >= 0x24) {
      // Vista 之后带 Unicode 偏移
      const uLocal = buf.readUInt32LE(p + 0x1c);
      const uSuffix = buf.readUInt32LE(p + 0x20);
      if (uLocal && uLocal < liSize) localBase = cstr(buf, p + uLocal, true);
      if (uSuffix && uSuffix < liSize) suffix = cstr(buf, p + uSuffix, true);
    }
    if (!localBase && localBaseOff && localBaseOff < liSize) localBase = cstr(buf, p + localBaseOff, false);
    if (!suffix && suffixOff && suffixOff < liSize) suffix = cstr(buf, p + suffixOff, false);

    if (localBase) out.target = localBase + suffix;
    p += liSize;
  }

  // StringData: 顺序固定 —— NAME / RELATIVE_PATH / WORKING_DIR / ARGUMENTS / ICON_LOCATION
  const order = [
    [FLAG.NAME, 'name'],
    [FLAG.RELATIVE_PATH, 'relative'],
    [FLAG.WORKING_DIR, 'workingDir'],
    [FLAG.ARGUMENTS, 'args'],
    [FLAG.ICON_LOCATION, 'iconLocation'],
  ];
  for (const [bit, key] of order) {
    if (!(flags & bit)) continue;
    const r = readStringData(buf, p, unicode);
    p = r.next;
    if (!out[key] && r.value) out[key] = r.value;
  }

  // 只有相对路径时, 按 .lnk 所在目录拼回来
  if (!out.target && out.relative) {
    out.target = path.resolve(path.dirname(lnkPath), out.relative);
  }

  out.target = expandEnv(out.target);
  out.workingDir = expandEnv(out.workingDir);
  out.iconLocation = expandEnv(stripIconIndex(out.iconLocation));
  return out;
}

/** 解析并校验目标是否存在 */
function resolveShortcut(lnkPath) {
  const r = parseShortcut(lnkPath);
  if (!r) return null;
  const exists = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
  r.targetExists = exists(r.target);
  r.iconExists = exists(r.iconLocation);
  return r;
}

module.exports = { parseShortcut, resolveShortcut, stripIconIndex };
