'use strict';
/**
 * shortcut.js —— 原生解析 Windows 快捷方式(.lnk)
 *
 * 为什么要自己解析:
 *   早期版本靠外部脚本 + WScript.Shell 解析, 单个快捷方式要 2~3 秒, 而且很多机器上
 *   那个进程会被安全策略直接拦掉 —— 表现是"同一份程序, 在这台电脑能提取图标,
 *   换一台电脑就全变字母磁贴"。现在完全不依赖外部进程。
 *
 * 两级解析:
 *   1) 纯 JS 读 Shell Link 二进制(MS-SHLLINK): 1ms 拿到 LocalBasePath / IconLocation
 *   2) Electron 的 shell.readShortcutLink(): 走 Windows Shell 自己解析, 能补上
 *      "只有 LinkTargetIDList、没有 LocalBasePath" 的快捷方式(系统工具、MSI 安装、
 *      部分开始菜单项)。纯 Node 环境(单元测试)自动跳过这一级。
 *
 * 另外做一次路径重定位: 快捷方式里写死的是绝对路径, 换电脑后盘符 / 32-64 位目录 /
 * Windows 用户名都可能变, 按这几类差异找到本机真实存在的同名文件并修正。
 */

const fs = require('fs');
const os = require('os');
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

function isFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

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

/** 展开 %ProgramFiles% / %windir% 之类的环境变量(Windows 变量名大小写不敏感) */
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
 * 换电脑后按几类确定性差异探测真实路径。
 * 不做全盘搜索: 慢, 而且容易把同名但完全不同的程序认错。
 * @returns {string} 第一个真实存在的文件路径, 找不到返回 ''
 */
function findExistingPath(raw) {
  const target = String(raw || '').trim().replace(/\//g, '\\');
  if (!target) return '';
  if (isFile(target)) return target;
  if (process.platform !== 'win32') return '';

  const m = target.match(/^([A-Za-z]:)\\(.*)$/);
  if (!m) return '';
  const rest = m[2];
  const home = os.homedir().replace(/[\\/]+$/, '');
  const homeRest = home.replace(/^[A-Za-z]:\\/, '');
  const userRe = /^Users\\[^\\]+/i;

  // 路径主体变体
  const rests = [rest];
  const add = (r) => { if (r && r !== rest && !rests.includes(r)) rests.push(r); };
  add(rest.replace(/Program Files \(x86\)/gi, 'Program Files'));
  add(rest.replace(/Program Files(?! \(x86\))/gi, 'Program Files (x86)'));
  add(rest.replace(userRe, homeRest));
  for (const r of rests.slice()) add(r.replace(userRe, homeRest));

  const drives = [m[1], process.env.SystemDrive || 'C:', 'C:', 'D:', 'E:', 'F:'];
  for (const d of drives) {
    for (const r of rests) {
      const cand = d + '\\' + r;
      if (isFile(cand)) return cand;
    }
  }
  return '';
}

/**
 * 纯 JS 解析 .lnk
 * @returns {{lnk:string,target:string,args:string,workingDir:string,iconLocation:string,name:string,relative:string}|null}
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

  const out = { lnk: lnkPath, target: '', args: '', workingDir: '', iconLocation: '', name: '', relative: '' };

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

/** Electron 的 Windows Shell 解析, 覆盖 IDList 型快捷方式; 纯 Node 环境返回 null */
function readWithShell(lnkPath) {
  let shell;
  try {
    const el = require('electron');
    shell = el && el.shell;
  } catch { return null; }
  if (!shell || typeof shell.readShortcutLink !== 'function') return null;
  try {
    const r = shell.readShortcutLink(lnkPath);
    if (!r) return null;
    return {
      target: expandEnv(String(r.target || '')),
      args: String(r.args || ''),
      workingDir: expandEnv(String(r.cwd || '')),
      iconLocation: expandEnv(stripIconIndex(String(r.icon || ''))),
    };
  } catch { return null; }
}

/**
 * .url (Internet Shortcut) —— Steam / Epic 的游戏快捷方式大多是这个格式:
 *   [InternetShortcut]
 *   URL=steam://rungameid/123456          (或 com.epicgames.launcher://apps/...)
 *   IconFile=D:\Games\Foo\Foo.exe
 *   IconIndex=0
 *
 * 它只有协议链接、没有可执行目标, 图标只能从 IconFile 拿。以前完全没解析这类文件,
 * 于是这几个平台的游戏图标一律退化成字母磁贴。游戏库又常装在非系统盘,
 * 换电脑后盘符一变, IconFile 也跟着失效 —— 所以这里顺带做一次路径重定位。
 */
function parseUrlShortcut(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const get = (key) => {
    const m = txt.match(new RegExp('(?:^|\\r?\\n)\\s*' + key + '\\s*=\\s*([^\\r\\n]+)', 'i'));
    return m ? m[1].trim().replace(/^"|"$/g, '') : '';
  };
  const raw = expandEnv(stripIconIndex(get('IconFile')));
  return { url: get('URL'), iconPath: findExistingPath(raw), iconFileRaw: raw };
}

/**
 * 解析并校验目标是否存在。
 * 两级解析结果合并, 再做一次跨电脑路径重定位。
 */
function resolveShortcut(lnkPath) {
  const own = parseShortcut(lnkPath);
  const sh = readWithShell(lnkPath);
  if (!own && !sh) return null;

  const targetCandidates = [own && own.target, sh && sh.target].filter(Boolean);
  const iconCandidates = [own && own.iconLocation, sh && sh.iconLocation].filter(Boolean);

  const out = {
    lnk: lnkPath,
    target: '',
    args: (own && own.args) || (sh && sh.args) || '',
    workingDir: (own && own.workingDir) || (sh && sh.workingDir) || '',
    iconLocation: '',
    resolvedBy: '',
    relocated: false,
  };

  // 目标: 逐个候选做重定位, 取第一个在本机真实存在的
  let chosen = '';
  for (const t of targetCandidates) {
    const hit = findExistingPath(t);
    if (hit) {
      chosen = hit;
      out.resolvedBy = hit === t ? 'native' : 'relocated';
      out.relocated = hit !== t;
      break;
    }
  }
  // Shell 解析出来的路径即使不存在也比纯 JS 的空值有用(至少能提示用户)
  out.target = chosen || targetCandidates[0] || '';
  if (!chosen && sh && sh.target) out.resolvedBy = 'shell';
  out.targetExists = isFile(out.target);

  // 图标位置: 同样重定位一次; 都无效时退回目标程序自身
  let iconHit = '';
  for (const i of iconCandidates) iconHit = findExistingPath(i) || iconHit;
  out.iconLocation = iconHit || (out.targetExists ? out.target : '');
  out.iconExists = isFile(out.iconLocation);

  return out;
}

module.exports = {
  parseShortcut, resolveShortcut, parseUrlShortcut, readWithShell, findExistingPath,
  stripIconIndex, expandEnv,
};
