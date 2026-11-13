'use strict';
/**
 * platform.js —— 平台能力探测
 *
 * 1.0 起同时支持 Windows / macOS / Linux。三个平台能做的事不一样，
 * 这里把差异集中成一张"能力表"，其余模块只查表，不再到处写 if (win32)。
 *
 *   能力                Windows   macOS   Linux
 *   窗口铺满置顶          ✅       ❌      ❌
 *   开机自启              ✅       ✅      ✅
 *   关机/重启             ✅       ✅      ✅   (mac 走 AppleScript 授权)
 *   提权启动(UAC)         ✅       ❌      ❌
 *   UWP 应用              ✅       ❌      ❌
 *   .lnk 快捷方式         ✅       ❌      ❌
 *   .app 包 / .icns       ❌       ✅      ❌
 *   .desktop 启动项       ❌       ❌      ✅
 */

const OS = process.platform;

const WIN = OS === 'win32';
const MAC = OS === 'darwin';
const LINUX = OS === 'linux';

const caps = {
  windowBoost: WIN, // SetWindowPos 是 Win32 独有的
  elevate: WIN,     // ShellExecute RunAs / UAC
  uwp: WIN,
  shellLink: WIN,   // .lnk
  appBundle: MAC,   // .app / .icns
  desktopEntry: LINUX,
  peIcon: WIN,      // 从 exe 的 PE 资源里取图标
};

const OS_NAME = WIN ? 'Windows' : MAC ? 'macOS' : 'Linux';

/** 给界面用的文案，避免渲染层再判断平台 */
const text = {
  osName: OS_NAME,
  loginHint: WIN ? '登录 Windows 后自动打开启动台'
    : MAC ? '登录 macOS 后自动打开启动台'
      : '登录系统后自动打开启动台',
  pickerHint: WIN ? '点击右侧「浏览…」选择 exe、bat 或快捷方式'
    : MAC ? '点击右侧「浏览…」选择 .app 应用或可执行文件'
      : '点击右侧「浏览…」选择程序、.desktop 启动项或 AppImage',
  pathPlaceholder: WIN ? 'C:\\Program Files\\App\\app.exe'
    : MAC ? '/Applications/Safari.app'
      : '/usr/bin/vlc 或 /usr/share/applications/vlc.desktop',
  formatHelp: WIN
    ? '支持 exe / lnk / bat / cmd / url 等格式。桌面或开始菜单里的快捷方式同样可以直接选择，程序会自动解析出真实路径。需要管理员权限的程序，启动时会弹出 UAC 授权框。'
    : MAC
      ? '支持 .app 应用包与任意可执行文件。选中 .app 会自动读出包内的应用名与图标。'
      : '支持可执行文件、AppImage 与 .desktop 启动项。选中 .desktop 会自动解析出真实命令与图标。',
  quitHint: WIN ? '关闭程序，返回 Windows 桌面'
    : MAC ? '关闭程序，返回 macOS 桌面'
      : '关闭程序，返回桌面',
};

module.exports = { OS, WIN, MAC, LINUX, caps, text, OS_NAME };
