'use strict';
/**
 * main.js —— 主进程
 * 职责: 创建全屏无边框窗口、注册图标协议、IPC 服务(扫描/启动/电源/开机自启)、数据落盘。
 */

const {
  app, BrowserWindow, ipcMain, protocol, dialog, shell, Menu, globalShortcut,
} = require('electron');
const fs = require('fs');
const path = require('path');

const { Store } = require('./store');
const { IconCache } = require('./iconcache');
const { normalizePick } = require('./pick');
const { boostWindow, warmup: warmBoost, shutdownWorker: stopBoost, SUPPORTED: BOOST_SUPPORTED } = require('./winboost');
const { WIN, MAC, LINUX, caps, text: PTEXT } = require('./platform');
const autostart = require('./autostart');
const { power } = require('./power');
const { launchItem } = require('./launch');
const { media } = require('./media');
const { winInput, VK } = require('./wininput');
const { RemoteService } = require('./remote');
const taskbar = require('./taskbar');
const updater = require('./updater');
const weather = require('./weather');
const shutdown = require('./shutdown');
const { GuardService } = require('./guard');
const lockdown = require('./lockdown');

// 看门狗模式：同一个 exe 带 --launchplay-watchdog 启动时只跑守护逻辑，不创建窗口。
// CommonJS 模块顶层 return 合法，能把后面的 Electron 初始化整段跳过。
if (process.argv.includes('--launchplay-watchdog')) {
  require('./watchdog').run();
  return;
}

const isDev = !app.isPackaged;
const CAPTURE = process.env.TL_CAPTURE || '';
const CAPTURE_FULLSCREEN = process.env.TL_CAPTURE_FS === '1';

/* ------------------------- 进程配置 ------------------------- */
/**
 * 任务栏分组标识。Windows 靠 AUMID + exe 路径索引任务栏按钮与图标缓存,
 * 便携版每次运行都解压到新的临时目录, 不显式指定 AUMID 时图标缓存会落空,
 * 任务栏就显示成空白方块。
 */
const APP_ID = 'com.launchplay.desktop.win7';
app.setAppUserModelId(APP_ID);

/**
 * 内存相关。
 * Chromium 天然是多进程(主进程 / GPU / 渲染 / 网络 / 崩溃上报), 任务管理器里每行
 * 还会把共享的 DLL(v8、skia、GL)各算一遍, 所以相加出来的数字远大于真实占用。
 *
 * 试过把 GPU 进程并进主进程(--in-process-gpu): 进程数能从 4 降到 3,
 * 但这台机器上窗口会创建成功却始终不显示, 所以不能要。
 * 真正安全有效的只有限制 V8 老生代上限, 以及让被遮挡时降低渲染频率。
 */
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=192');

/* ------------------------- 数据目录 ------------------------- */
/**
 * 便携版优先把数据放在 exe 同级目录, 真正做到「拷走就能用」;
 * 目录不可写时回退到 userData。
 * 2.0 起品牌名从 TVLauncher 改为 LaunchPlay, 老目录数据自动迁移一次。
 */
function migrateLegacyData(portableDir) {
  const oldDir = path.join(portableDir, 'TVLauncherData');
  const newDir = path.join(portableDir, 'LaunchPlayWin7Data');
  try {
    if (!fs.existsSync(oldDir)) return;
    if (fs.existsSync(path.join(newDir, 'launcher.json'))) return;
    fs.mkdirSync(newDir, { recursive: true });
    fs.cpSync(oldDir, newDir, { recursive: true });
    console.log('[migrate] TVLauncherData -> LaunchPlayWin7Data');
  } catch (e) {
    console.warn('[migrate] skipped:', e && e.message);
  }
}

/**
 * 便携目录: 优先把数据放在程序旁边, 真正做到「拷走就能用」。
 *   Windows: 便携版 exe 会给出 PORTABLE_EXECUTABLE_DIR
 *   Linux:   AppImage 用 $APPIMAGE 所在目录; 解压版用二进制所在目录
 *   macOS:   .app 是个包, 往里写数据会破坏签名, 所以直接走 userData
 */
function portableDataDir() {
  if (WIN) {
    const d = process.env.PORTABLE_EXECUTABLE_DIR;
    return d ? path.join(d, 'LaunchPlayWin7Data') : '';
  }
  if (LINUX) {
    if (process.env.APPIMAGE) return path.join(path.dirname(process.env.APPIMAGE), 'LaunchPlayWin7Data');
    try { return path.join(path.dirname(app.getPath('exe')), 'LaunchPlayWin7Data'); } catch { return ''; }
  }
  return '';
}

function resolveDataDir() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const candidates = [];
  if (portableDir) migrateLegacyData(portableDir);
  if (process.env.TL_DATA_DIR) candidates.push(process.env.TL_DATA_DIR);
  const portable = portableDataDir();
  if (portable) candidates.push(portable);
  candidates.push(app.getPath('userData'));
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      return c;
    } catch { /* 尝试下一个 */ }
  }
  return app.getPath('userData');
}

const DATA_DIR = resolveDataDir();
const ICON_DIR = path.join(DATA_DIR, 'icons');
const BG_DIR = path.join(DATA_DIR, 'backgrounds');

let store = null;
let icons = null;
let win = null;
let splash = null;        // 启动画面(先显示, 主窗口就绪后关闭)
const SPLASH_MIN_MS = 1400; // splash 至少显示这么久: 安装版太快也要看清 logo, 便携版够盖住白框
let splashShownAt = 0;    // splash 真正"渲染完成并显示"的时刻(不是创建时刻)
let splashPainted = false; // splash 内容是否已 did-finish-load(避免白框)
let mainReady = false;     // 主窗口是否已 ready-to-show
let hotkeyOk = false;   // 唤回热键是否注册成功(没注册成功就不自动收起, 免得回不来)
let remote = null;      // 手机遥控服务(默认关闭, 设置里点开启才启动)
let guard = null;       // 家长守护服务(主进程计时 + 密码校验)
let forceQuit = false;  // 系统关机 / app.quit() 已发起，此时不再拦窗口关闭
let lastLaunchedPid = 0; // 最近一次由启动台打开的程序 pid, 供手机"关闭程序"使用
let lockdownOn = false;  // 轻量加固当前是否已应用到系统（避免每秒重复写注册表）

/** 家长守护开启且未临时放行时，是否要拦住这个动作 */
function guardBlocking() { return !!(guard && guard.blocking); }

/** 守护状态变化时打开/关闭轻量加固；只在状态真的翻转时动系统设置 */
function syncLockdown(want) {
  if (want === lockdownOn) return;
  lockdownOn = want;
  if (!WIN) return;
  if (want) {
    const r = lockdown.enable(DATA_DIR);
    if (r.errors && r.errors.length) console.warn('[lockdown] 部分加固未生效:', r.errors.join('; '));
  } else {
    try { lockdown.disable(DATA_DIR); } catch { /* ignore */ }
  }
}
function guardDenied() { return { ok: false, error: '家长守护已开启，此操作需要家长密码' }; }

/* ------------------------- 图标协议 ------------------------- */
protocol.registerSchemesAsPrivileged([
  { scheme: 'tlapp', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);

function iconUrl(fileName) {
  return fileName ? `tlapp://icon/${encodeURIComponent(fileName)}` : '';
}

function bgUrl(fileName) {
  return fileName ? `tlapp://bg/${encodeURIComponent(fileName)}` : '';
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/**
 * tlapp://icon/<文件名>  —— 程序图标
 * tlapp://bg/<文件名>    —— 自定义背景图
 * 只允许访问各自数据目录下的文件(basename 去掉任何路径成分, 防目录穿越)
 */
/** 解析 tlapp:// 请求，统一做目录穿越校验；失败返回 null */
function resolveTlapp(urlString) {
  const u = new URL(urlString);
  const host = (u.hostname || 'icon').toLowerCase();
  const rootDir = host === 'bg' ? BG_DIR : ICON_DIR;
  const name = path.basename(decodeURIComponent(u.pathname));
  const full = path.join(rootDir, name);
  if (!full.startsWith(rootDir)) return null;
  return {
    buf: fs.readFileSync(full),
    type: MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream',
  };
}

/**
 * protocol.handle 是 Electron 25 才加入的；Win7 专用版用的是 Electron 22.3.27，
 * 只有旧的 register*Protocol 系列。这里按能力自动分流，主版本与 Win7 版共用同一份代码，
 * 避免每次同步源码后 Win7 版因 API 缺失卡在启动画面。
 */
function registerIconProtocol() {
  if (typeof protocol.handle === 'function') {
    protocol.handle('tlapp', async (req) => {
      try {
        const r = resolveTlapp(req.url);
        if (!r) return new Response('forbidden', { status: 403 });
        return new Response(new Uint8Array(r.buf), {
          headers: { 'content-type': r.type, 'cache-control': 'max-age=604800' },
        });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });
    return;
  }

  // Electron 22 回退实现（Win7 专用版）
  protocol.registerBufferProtocol('tlapp', (req, callback) => {
    try {
      const r = resolveTlapp(req.url);
      if (!r) {
        callback({ statusCode: 403, mimeType: 'text/plain', data: Buffer.from('forbidden') });
        return;
      }
      callback({
        statusCode: 200,
        mimeType: r.type,
        data: r.buf,
        headers: { 'Cache-Control': 'max-age=604800' },
      });
    } catch {
      callback({ statusCode: 404, mimeType: 'text/plain', data: Buffer.from('not found') });
    }
  });
}

/* ------------------------- 背景图片 ------------------------- */
const BG_MAX_BYTES = 40 * 1024 * 1024;

/**
 * 把用户选的图片复制进数据目录, 并清掉上一张, 避免数据目录膨胀。
 * 不直接引用原路径: 图片放在桌面/U 盘时, 挪走或删除后背景会裂。
 */
function importBackground(srcPath) {
  try {
    const ext = path.extname(srcPath).toLowerCase();
    if (!MIME_BY_EXT[ext] || ext === '.ico') return { ok: false, error: '这个格式不能用作背景，请选 PNG / JPG / WEBP' };
    const st = fs.statSync(srcPath);
    if (!st.isFile()) return { ok: false, error: '不是一个文件' };
    if (st.size > BG_MAX_BYTES) return { ok: false, error: '图片超过 40 MB，请先压缩再试' };
    fs.mkdirSync(BG_DIR, { recursive: true });
    const name = `bg-${Date.now().toString(36)}${ext}`;
    fs.copyFileSync(srcPath, path.join(BG_DIR, name));
    for (const f of fs.readdirSync(BG_DIR)) {
      if (f === name) continue;
      try { fs.rmSync(path.join(BG_DIR, f), { force: true }); } catch { /* 被占用就留着 */ }
    }
    return { ok: true, file: name, url: bgUrl(name) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '读取图片失败' };
  }
}

/* ------------------------- 窗口 ------------------------- */
/**
 * 窗口图标路径。
 *
 * 两个坑都在这里踩过：
 *  1. 原来指向 build/icon.ico —— 那是 electron-builder 的 buildResources 目录,
 *     不会被打进 app.asar, 打包后路径不存在, 任务栏只剩一个空白方块。
 *  2. 改用 asar 内的 icon.ico 仍然空白: Electron 的 nativeImage 读 ICO 时会丢掉
 *     底板的 alpha, 任务栏上只剩四个白点, 浅色主题下看着就是空的。
 *     换成 PNG 就正常了, 所以窗口图标优先 PNG; ICO 继续留给 exe 资源,
 *     Windows shell 自己解析那条路没有问题。
 */
function appIconPath() {
  const candidates = [
    path.join(__dirname, 'assets', 'icon.png'),
    path.join(__dirname, '..', 'build', 'icon.png'), // 开发模式兜底
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* 路径不可读就试下一个 */ }
  }
  return undefined;
}

/* ------------------------- 启动画面 ------------------------- */
/**
 * app.ready 前不能建窗口, 所以当 ready 一触发就先显示这个轻量 splash,
 * 把"读取配置/初始化/主窗口加载"这段等待用画面盖住, 让用户知道程序正在启动。
 * 截图采集模式(TL_CAPTURE)下跳过, 避免干扰自动化截图。
 */
function createSplash() {
  if (splash || CAPTURE) return;
  splashPainted = false;
  mainReady = false;
  splashShownAt = Date.now();
  splash = new BrowserWindow({
    width: 480,
    height: 320,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    center: true,
    show: false, // 关键: 先不显示, 等内容真正渲染完再 show, 否则用户先看到白框
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#05070f',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  // 内容首次渲染完成才显示 —— 便携版解压慢, 这一步能杜绝"白框一闪"
  splash.webContents.once('did-finish-load', () => {
    splashPainted = true;
    splashShownAt = Date.now();
    if (splash && !splash.isDestroyed() && !splash.isVisible()) splash.show();
    maybeCloseSplash();
  });
  // 兜底: 极端情况下 load 事件没来, 2 秒后也强制显示, 不能让 splash 卡住主窗口
  setTimeout(() => {
    if (splash && !splash.isDestroyed() && !splash.isVisible()) {
      splashPainted = true;
      splashShownAt = Date.now();
      splash.show();
      maybeCloseSplash();
    }
  }, 2000);
  splash.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  splash.on('closed', () => { splash = null; });
}

/** 主窗口已就绪, 记下标记, 由 maybeCloseSplash 统一决定何时关 */
function mainWindowReady() {
  mainReady = true;
  maybeCloseSplash();
}

/**
 * 关闭 splash 的唯一入口。必须同时满足:
 *   1) splash 内容已真正渲染(painted) —— 否则会看到白框
 *   2) 主窗口已 ready —— 否则关早了会露出桌面
 * 两者都满足后再保证最短展示 SPLASH_MIN_MS, 从"真正显示"的时刻算起。
 * 这样便携版(慢)不会白框, 安装版(快)也会稳定展示约 1.4 秒。
 */
function maybeCloseSplash() {
  if (!splashPainted || !mainReady) return;
  if (!splash || splash.isDestroyed()) { splash = null; return; }
  if (splash._closeTimer) return; // 已排过队, 不要重复
  const elapsed = Date.now() - splashShownAt;
  const wait = Math.max(0, SPLASH_MIN_MS - elapsed);
  splash._closeTimer = setTimeout(() => {
    if (splash && !splash.isDestroyed()) splash.close();
    splash = null;
  }, wait);
}

function createWindow() {
  const fullscreen = store.settings.fullscreen !== false;

  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    frame: false,
    fullscreen,
    autoHideMenuBar: true,
    backgroundColor: '#05070c',
    title: '影游快启',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 被别的窗口完全遮住时(应用已启动)降低渲染频率, 省 CPU/GPU 与一部分内存
      backgroundThrottling: true,
      devTools: isDev || !!CAPTURE,
    },
  });

  // macOS 上完全去掉菜单会连带失去 Cmd+C / Cmd+V / Cmd+A 这些文本编辑快捷键,
  // 添加应用的输入框就没法用了, 所以只在 Windows / Linux 上清空菜单。
  if (MAC) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
  } else {
    Menu.setApplicationMenu(null);
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 渲染进程日志转发到终端, 方便排查
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    if (ev && typeof ev === 'object' && 'message' in ev) {
      console.log('[renderer]', ev.level || '', ev.message, `${ev.sourceId || ''}:${ev.lineNumber || ''}`);
    } else {
      console.log('[renderer]', args[2], `${args[4] || ''}:${args[3] || ''}`);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', JSON.stringify(d)));
  win.webContents.on('preload-error', (_e, p, err) => console.log('[preload error]', p, err && err.message));

  win.once('ready-to-show', () => {
    win.show();
    if (store.settings.fullscreen !== false) win.setFullScreen(true);
    mainWindowReady();
  });

  // 外部链接不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 家长守护：拦住应用内的关闭（Alt+F4 / 退出按钮 / 双击 Esc）。
  // 系统关机走 before-quit 会把 forceQuit 置真，此时不拦，避免挡住正常关机。
  win.on('close', (e) => {
    if (guardBlocking() && !forceQuit) {
      e.preventDefault();
      try { win.webContents.send('remote:toast', '家长守护已开启，不能退出启动器'); } catch { /* ignore */ }
    }
  });
  win.on('closed', () => { win = null; });

  // 调试用: TL_EVAL_JS 在界面就绪后注入一段脚本(可选延后), 进程保持运行
  if (process.env.TL_EVAL_JS) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const r = await win.webContents.executeJavaScript(process.env.TL_EVAL_JS);
          if (r !== undefined) console.log('[eval]', typeof r === 'string' ? r : JSON.stringify(r));
        } catch (e) {
          console.error('[eval error]', e && e.message);
        }
      }, Number(process.env.TL_EVAL_DELAY || 1200));
    });
  }

  if (CAPTURE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // 用 CDP 模拟指定视口, 便于在没有 4K 屏的机器上核对 16:9 大屏布局
          const emW = Number(process.env.TL_CAPTURE_W || 0);
          const emH = Number(process.env.TL_CAPTURE_H || 0);
          if (emW > 0 && emH > 0) {
            try {
              win.webContents.debugger.attach('1.3');
              await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
                width: emW, height: emH, deviceScaleFactor: 1, mobile: false,
              });
              await new Promise((r) => setTimeout(r, 500));
            } catch (e) { console.error('emulate failed', e); }
          }
          if (process.env.TL_CAPTURE_JS) {
            await win.webContents.executeJavaScript(process.env.TL_CAPTURE_JS);
            await new Promise((r) => setTimeout(r, Number(process.env.TL_CAPTURE_JS_WAIT || 700)));
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(CAPTURE, img.toPNG());
        } catch (e) {
          console.error('capture failed', e);
        }
        app.quit();
      }, Number(process.env.TL_CAPTURE_DELAY || 1800));
    });
  }

  return win;
}

/* ------------------------- 开机自启 ------------------------- */
/**
 * 三平台实现都在 autostart.js 里:
 *   Windows -> HKCU\...\Run 注册表项
 *   macOS   -> ~/Library/LaunchAgents/com.launchplay.desktop.win7.plist
 *   Linux   -> ~/.config/autostart/launchplay.desktop
 * 都不需要管理员权限。
 */
const getAutostart = () => autostart.getAutostart();
const setAutostart = (enabled) => autostart.setAutostart(enabled);

/** 把当前运行位置告诉自启模块(mac 需要 .app 包路径, 其余需要可执行文件路径) */
function setupAutostartContext() {
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
  let appPath = '';
  if (MAC) {
    // .../LaunchPlay.app/Contents/MacOS/LaunchPlay -> .../LaunchPlay.app
    const guess = path.resolve(exePath, '..', '..', '..');
    if (/\.app$/i.test(guess)) appPath = guess;
  }
  autostart.init({
    exePath: LINUX && process.env.APPIMAGE ? process.env.APPIMAGE : exePath,
    appPath,
    displayName: '影游快启',
  });
}

/* ------------------------- 启动应用 ------------------------- */
/**
 * 启动逻辑抽到 launch.js(三平台分派)。这里只负责启动之后的收尾动作。
 */

/**
 * 启动应用后的收尾动作:
 *   1. 默认不收起启动台, 只让出前台 —— 新程序盖在上面, 启动台留在它下层
 *   2. 把新窗口铺满屏幕并置顶(尽力而为, 失败不影响使用)
 */
function afterLaunch(pid) {
  const s = (store && store.settings) || {};

  // 记下最近启动的程序, 手机遥控的"关闭程序"就关它
  // (pid 为 0 表示系统方式打开、拿不到句柄, 这时关闭会给出提示)
  lastLaunchedPid = pid || 0;

  // 通知手机遥控页: 有新程序被打开, 自动把"播放遥控"卡片滚动到最上方
  if (remote && remote.running) {
    try { remote.notifyLaunch(); } catch { /* ignore */ }
  }

  if (win && !win.isDestroyed()) {
    // 家长守护下不收起启动台，避免露出电脑桌面
    if (s.hideAfterLaunch === true && !guardBlocking()) {
      if (hotkeyOk) {
        try {
          win.setAlwaysOnTop(false);
          win.hide();
          if (process.env.TL_DEBUG_BOOST) console.error('[hide] visible=' + win.isVisible());
        } catch { /* ignore */ }
      }
    } else {
      // 不收起: 取消置顶 + 交还焦点。新程序由系统拉到前台, 启动台自然留在它下面,
      // 关掉新程序后会回到这里(无需再 show 一次, 便于电视式"退回首页")
      try {
        win.setAlwaysOnTop(false);
        win.blur();
        if (process.env.TL_DEBUG_BOOST) console.error('[keep] behind, visible=' + win.isVisible());
      } catch { /* ignore */ }
    }
  }

  if (BOOST_SUPPORTED && s.boostLaunch !== false && pid) {
    boostWindow(pid, { topmost: true, cover: true, timeout: 8000 })
      .then((r) => { if (process.env.TL_DEBUG_BOOST) console.error('[boost]', pid, JSON.stringify(r)); })
      .catch(() => { /* 尽力而为 */ });
  }
}

/** 呼出/收起启动台(全局热键, 应用置顶时也能回来) */
function bringLauncherFront() {
  if (!win || win.isDestroyed()) return;
  // 先取消再设置置顶: 这样会排到其他置顶窗口之上
  try { win.setAlwaysOnTop(false); } catch { /* ignore */ }
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* ignore */ }
  if (win.isMinimized()) win.restore();
  win.show();
  try { win.moveTop(); } catch { /* ignore */ }
  win.focus();
}

function toggleLauncher() {
  if (!win || win.isDestroyed()) return;
  // 在应用下层时(可见但没焦点) -> 拉到前台; 已在前台 -> 收起
  if (!win.isVisible()) { bringLauncherFront(); return; }
  if (!win.isFocused()) { bringLauncherFront(); return; }
  // 家长守护：不允许把启动台收起来露出电脑桌面（唤回始终允许）
  if (guardBlocking()) {
    try { win.webContents.send('remote:toast', '家长守护已开启，不能切回电脑桌面'); } catch { /* ignore */ }
    return;
  }
  win.setAlwaysOnTop(false);
  win.hide();
}

/* ------------------------- IPC ------------------------- */
function stateSnapshot() {
  // 家长守护的密码哈希绝不下发到渲染层；只给一份脱敏后的状态供界面显示
  const p = store.settings.parental || {};
  const safeParental = {
    enabled: !!(p.enabled && p.passHash),
    hasPassword: !!p.passHash,
    intervalMin: p.intervalMin || 60,
    restMin: p.restMin || 10,
    quizEnabled: p.quizEnabled !== false,
    lockdown: !!p.lockdown,
  };
  return {
    items: store.items,
    settings: { ...store.settings, parental: safeParental },
    firstRun: store.firstRun,
    dataDir: DATA_DIR,
    version: app.getVersion(),
    // 界面据此调整文案与可选项（mac/linux 上没有窗口增强、没有 UAC）
    platform: process.platform,
    caps,
    text: PTEXT,
  };
}

function setupIpc() {
  // 更新进度事件转发给渲染层"关于"面板
  updater.setSink((payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('update:event', payload);
  });

  ipcMain.handle('state:get', () => stateSnapshot());

  ipcMain.handle('state:save', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return stateSnapshot();
    if (Array.isArray(patch.items)) {
      // 家长守护开启且未临时放行时，拒绝增删应用（孩子不能自己往启动台加东西）
      if (!guardBlocking() || patch.items.length === store.items.length) store.items = patch.items;
    }
    if (patch.settings && typeof patch.settings === 'object') {
      const s = { ...patch.settings };
      // 家长守护只走 guard:configure：渲染层拿到的是脱敏副本，回写会抹掉密码哈希
      delete s.parental;
      store.patchSettings(s);
    }
    if (typeof patch.firstRun === 'boolean') store.firstRun = patch.firstRun;
    store.save();
    return { ok: true, items: store.items, settings: stateSnapshot().settings };
  });

  ipcMain.handle('icons:ensure', async (_e, list) => {
    const arr = Array.isArray(list) ? list : [];
    const map = {};
    for (const it of arr) {
      if (!it || !it.id) continue;
      let file = '';
      try { file = await icons.ensure(it); } catch { file = ''; }
      if (file) map[it.id] = iconUrl(file);
    }
    return map;
  });

  ipcMain.handle('icon:import', (_e, p) => {
    try {
      const f = icons.importImage(p);
      return f ? iconUrl(f) : '';
    } catch { return ''; }
  });

  /**
   * 背景图片: 复制一份到数据目录再引用。
   * 不能直接用原路径 —— 用户可能把图片放在桌面/U 盘, 移动或删除后就裂图了。
   */
  ipcMain.handle('bg:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择背景图片',
      buttonLabel: '用作背景',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return importBackground(r.filePaths[0]);
  });

  ipcMain.handle('bg:clear', () => {
    try {
      for (const f of fs.readdirSync(BG_DIR)) {
        try { fs.rmSync(path.join(BG_DIR, f), { force: true }); } catch { /* 忽略 */ }
      }
    } catch { /* 目录不存在 */ }
    return { ok: true };
  });

  /**
   * 选择程序文件(支持多选)
   * 返回标准化后的条目数组, 由渲染层决定是填表还是批量添加
   */
  ipcMain.handle('dialog:pick-exe', async () => {
    if (guardBlocking()) return guardDenied();
    // 三个平台能选的"快捷方式"差别很大: .lnk / .app / .desktop
    const filters = WIN
      ? [
        { name: '程序与快捷方式', extensions: ['exe', 'lnk', 'bat', 'cmd', 'msc', 'com', 'url'] },
        { name: '所有文件', extensions: ['*'] },
      ]
      : MAC
        ? [
          { name: '应用程序', extensions: ['app'] },
          { name: '所有文件', extensions: ['*'] },
        ]
        : [
          { name: '启动项与程序', extensions: ['desktop', 'AppImage', 'appimage', 'sh', 'bin'] },
          { name: '所有文件', extensions: ['*'] },
        ];

    const r = await dialog.showOpenDialog(win, {
      title: '选择要添加的程序（可多选）',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters,
    });
    if (r.canceled || !r.filePaths.length) return null;
    // 解析现在走纯 JS + Electron Shell(1ms 量级), 不再启动外部进程, 多选也逐个解析
    const deep = true;
    const out = [];
    for (const f of r.filePaths) {
      try {
        out.push(await normalizePick(f, deep));
      } catch {
        out.push({ path: f, name: path.basename(f).replace(/\.[^.]+$/, ''), args: '', iconPath: f });
      }
    }
    return out;
  });

  ipcMain.handle('dialog:pick-image', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择图标图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  // 启动由 launch.js 按平台分派, 收尾动作(让出焦点 / 窗口增强)留在这里
  ipcMain.handle('app:launch', async (_e, item) => {
    const r = await launchItem(item);
    if (r && r.ok) afterLaunch(r.pid || 0);
    return r;
  });

  // 供渲染层/外部唤起启动台(与全局热键同一入口)
  ipcMain.handle('launcher:toggle', () => {
    if (guardBlocking()) return guardDenied();
    toggleLauncher();
    return {
      visible: !!(win && !win.isDestroyed() && win.isVisible()),
      focused: !!(win && !win.isDestroyed() && win.isFocused()),
      topmost: !!(win && !win.isDestroyed() && win.isAlwaysOnTop()),
      fullscreen: !!(win && !win.isDestroyed() && win.isFullScreen()),
      hotkey: hotkeyOk,
    };
  });

  ipcMain.handle('power', async (_e, action) => {
    if (guardBlocking()) return guardDenied();
    return power(action);
  });

  ipcMain.handle('autostart:get', () => getAutostart());
  ipcMain.handle('autostart:set', async (_e, enabled) => {
    const ok = await setAutostart(!!enabled);
    if (ok) { store.patchSettings({ autostart: !!enabled }); store.save(); }
    return { ok, state: await getAutostart() };
  });

  ipcMain.handle('win:fullscreen', (_e, on) => {
    if (!win) return false;
    // 家长守护下不允许退出全屏（否则就能看见桌面）
    if (guardBlocking() && !on) return win.isFullScreen();
    win.setFullScreen(!!on);
    store.patchSettings({ fullscreen: !!on });
    store.save();
    return win.isFullScreen();
  });

  ipcMain.handle('win:minimize', () => {
    if (guardBlocking()) return guardDenied();
    if (win) win.minimize();
    return { ok: true };
  });
  ipcMain.handle('win:quit', () => {
    if (guardBlocking()) return guardDenied();
    if (win) win.close();
    return { ok: true };
  });

  ipcMain.handle('os:open-path', async (_e, p) => {
    if (!p) return;
    if (/^https?:/i.test(p)) shell.openExternal(p);
    else shell.openPath(p);
  });

  // 任务栏自动隐藏: 开=托管并隐藏, 关=还原用户原状态
  ipcMain.handle('taskbar:set', async (_e, on) => {
    try {
      return on ? await taskbar.enable(DATA_DIR) : await taskbar.restore(DATA_DIR, false);
    } catch (e) {
      return { ok: false, error: (e && e.message) || '设置失败' };
    }
  });

  /* ---- 应用内更新（安装版） ---- */
  ipcMain.handle('update:capability', () => updater.capability(app, shell));
  ipcMain.handle('update:check', () => updater.check(app, shell));
  ipcMain.handle('update:download', () => updater.download(app));
  ipcMain.handle('update:install', () => updater.install(app));
  ipcMain.handle('update:open-release', () => updater.openRelease(shell));

  /* ---- 手机遥控 ---- */
  ipcMain.handle('remote:start', async () => {
    try {
      const info = await startRemoteService();
      console.log('[remote] started at', info.url);
      return { ok: true, ...info };
    } catch (e) {
      console.error('[remote] start failed', e && e.message);
      return { ok: false, error: (e && e.message) || '启动失败' };
    }
  });

  ipcMain.handle('remote:stop', () => {
    if (remote) remote.stop();
    return { ok: true, running: false };
  });

  ipcMain.handle('remote:status', () => {
    return remote && remote.running ? remote.info() : { running: false };
  });

  ipcMain.handle('remote:rotate', () => {
    if (!remote || !remote.running) return { ok: false, error: '遥控服务未开启' };
    return { ok: true, ...remote.rotateToken() };
  });

  /* ---- 左上角天气 ---- */
  ipcMain.handle('weather:get', async (_e, city, force) => weather.getWeather(city, !!force));
  // 省 / 市两级列表 + 编码到城市名的索引，供设置里的两级下拉使用
  ipcMain.handle('weather:cities', () => ({
    provinces: weather.PROVINCES,
    names: weather.CITY_NAMES,
  }));

  /* ---- 定时关机 ---- */
  ipcMain.handle('shutdown:schedule', (_e, h, m) => shutdown.schedule(h, m));
  ipcMain.handle('shutdown:cancel', () => shutdown.cancel());
  ipcMain.handle('shutdown:status', () => shutdown.status());

  /* ---- 家长守护 ---- */
  ipcMain.handle('guard:status', () => ({
    cfg: guard ? guard.publicCfg() : null,
    unlocked: !!(guard && guard.unlocked),
    active: !!(guard && guard.state === 'resting'),
    restLeft: guard ? guard.restLeft : 0,
    wrongLeft: guard ? Math.max(0, Math.ceil((guard.wrongUntil - Date.now()) / 1000)) : 0,
  }));
  ipcMain.handle('guard:verify', (_e, pwd) =>
    (guard ? guard.verify(pwd) : { ok: false, error: '守护服务未就绪' }));
  ipcMain.handle('guard:configure', (_e, patch) =>
    (guard ? guard.configure(patch) : { ok: false, error: '守护服务未就绪' }));
  ipcMain.handle('guard:quiz-info', () =>
    (guard ? guard.quizInfo() : { source: '内置题库', count: 0, custom: false, path: '' }));
  ipcMain.handle('guard:quiz-import', async () => {
    if (guardBlocking()) return guardDenied();
    const r = await dialog.showOpenDialog(win, {
      title: '选择题库文件（JSON）',
      buttonLabel: '导入',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: '题库 JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    return guard.importQuiz(r.filePaths[0]);
  });
  ipcMain.handle('guard:quiz-export-sample', () => {
    if (!guard) return { ok: false, error: '守护服务未就绪' };
    const r = guard.exportSample();
    if (r.ok) shell.showItemInFolder(r.path);
    return r;
  });
  ipcMain.handle('guard:question', () =>
    (guard ? guard.nextQuestion() : { ok: false, error: '守护服务未就绪' }));
  ipcMain.handle('guard:answer', (_e, idx) =>
    (guard ? guard.answer(idx) : { ok: false, error: '守护服务未就绪' }));
}

/* ------------------------- 手机遥控 ------------------------- */
/** 统一入口：确保服务实例存在并启动（IPC 与开机自启共用） */
async function startRemoteService() {
  if (!remote) {
    remote = new RemoteService(handleRemoteAction);
    remote.setPage(remotePageHtml());
    // 让 /ping 能回显启动台是否在前台，手机页据此自动跳回导航卡片
    remote.setFrontProvider(launcherActive);
    // 把万能键配置随 /ping 下发给手机页；在电脑端改了设置，手机不用刷新就能看到
    remote.setConfigProvider(() => ({
      // 只下发有组合的槽位，但带上原始下标，保证手机按下时电脑能取到正确配置
      customKeys: (Array.isArray(store.settings.customKeys) ? store.settings.customKeys : [])
        .slice(0, 4)
        .map((k, i) => ({
          name: String((k && k.name) || `万能键 ${i + 1}`).slice(0, 12),
          index: i,
          has: !!(k && Array.isArray(k.combo) && k.combo.length),
        }))
        .filter((k) => k.has),
    }));
  }
  return remote.start();
}

/**
 * 把手机指令映射成实际动作。
 * 分两类：
 *   - 导航类(方向/确定/返回/唤出)需要渲染层的焦点系统参与, 发给渲染层执行;
 *   - 系统类(音量/播放/关机/重启/关闭程序)主进程直接做。
 * 关机/重启执行前先让渲染层弹确认框, 手机端也已经做了一次确认(双保险)。
 */
/**
 * 启动台当前是否处于"用户正在操作"的状态。
 * 可见且聚焦 -> 导航键应该走界面焦点系统；
 * 隐藏 / 失焦(在看影音软件) -> 导航键应该注入到前台程序。
 */
function launcherActive() {
  return !!(win && !win.isDestroyed() && win.isVisible() && win.isFocused());
}

/** 把按键注入到前台程序；非 Windows 或注入进程异常时明确返回 */
async function injectKey(vk, label) {
  if (!WIN) return { ok: false, error: '键盘注入仅 Windows 支持' };
  const r = await winInput.key(typeof vk === 'number' ? vk : (VK[vk] || 0));
  if (!r.ok && win && !win.isDestroyed()) {
    win.webContents.send('remote:toast', `按键注入失败：${r.error || '未知原因'}`);
  }
  return r.ok ? { ok: true, injected: label || vk } : r;
}

/** 把组合键注入到前台程序，如 ['alt','enter'] / ['ctrl','right'] / ['alt','f4'] */
async function injectCombo(names, label) {
  if (!WIN) return { ok: false, error: '键盘注入仅 Windows 支持' };
  const vks = (names || []).map((n) => (typeof n === 'number' ? n : (VK[n] || 0)));
  if (vks.some((v) => !v)) return { ok: false, error: '未知组合键' };
  const r = await winInput.combo(vks);
  if (!r.ok && win && !win.isDestroyed()) {
    win.webContents.send('remote:toast', `组合键注入失败：${r.error || '未知原因'}`);
  }
  return r.ok ? { ok: true, injected: label || names.join('+') } : r;
}

function handleRemoteAction(action, params = {}) {
  // ---- 导航类：任何时候都只做导航 ------------------------------------
  // 需求明确：手机遥控的导航按键永远不要自动变成音量加减 / 快进快退。
  // 播放遥控卡片里的音量、快进快退、全屏等按钮是独立入口，不受影响。
  // launcherActive() 仍保留给 /ping 的 front 字段，驱动「自动跳到播放遥控卡片」。
  if (['up', 'down', 'left', 'right', 'ok', 'back'].includes(action)) {
    if (win && !win.isDestroyed()) win.webContents.send('remote:nav', action);
    return { ok: true, mode: 'focus' };
  }

  // ---- 万能键：手机页按下自定义组合键，配置只在电脑端保存 --------------
  if (action === 'macro') {
    const list = Array.isArray(store.settings.customKeys) ? store.settings.customKeys : [];
    const item = list[params.index];
    if (!item || !Array.isArray(item.combo) || !item.combo.length) {
      return { ok: false, error: '这个万能键还没有设置组合' };
    }
    return injectCombo(item.combo, item.name || '万能键');
  }

  // ---- 播放控制：始终注入真实键盘（不受启动台焦点影响） ----------------
  if (action === 'playpause') return injectKey('space', '播放/暂停');
  if (action === 'ffwd') return injectKey('right', '快进');
  if (action === 'rew') return injectKey('left', '快退');
  // 全屏：影音软件普遍用 Alt+Enter，比 F 更通用
  if (action === 'fullscreen') return injectCombo(['alt', 'enter'], '全屏(Alt+Enter)');
  // 下一集：主流播放器通用 Ctrl+→（用独立动作名，避免与系统媒体键 next 冲突）
  if (action === 'nextep') return injectCombo(['ctrl', 'right'], '下一集(Ctrl+→)');

  // ---- 唤出 / 收起启动台 ---------------------------------------------
  if (action === 'toggle' || action === 'home') {
    toggleLauncher();
    return { ok: true };
  }

  // ---- 系统媒体键（音量对系统生效，播放器不认时用） -------------------
  if (['volup', 'voldown', 'mute', 'play', 'next', 'prev'].includes(action)) {
    return media(action);
  }

  // ---- 鼠标 / 键盘模拟 ------------------------------------------------
  if (!WIN) return { ok: false, error: '键鼠模拟仅 Windows 支持' };
  switch (action) {
    case 'mmove':  return winInput.move(params.dx, params.dy);
    case 'mclick': return winInput.click();
    case 'mrclick': return winInput.rclick();
    case 'mdown':  return winInput.mdown();
    case 'mup':    return winInput.mup();
    case 'mwheel': return winInput.wheel(params.delta);
    case 'type':   return (params.text ? winInput.type(params.text) : Promise.resolve({ ok: false, error: '文本为空' }));
    case 'key': {
      const vk = params.key;
      const code = typeof vk === 'number' ? vk : (VK[vk] || 0);
      if (!code) return { ok: false, error: '未知按键' };
      return winInput.key(code);
    }
  }

  // ---- 电源: 走渲染层的确认弹窗, 用户在大屏上再确认一次 ----------------
  if (action === 'shutdown' || action === 'restart') {
    if (win && !win.isDestroyed()) win.webContents.send('remote:power', action);
    return { ok: true, pending: true };
  }
  // ---- 关闭当前程序：模拟 Alt+F4 关闭前台窗口 -------------------------
  // 比按 pid 强杀更自然：让程序自己走正常关闭流程，也适用于非启动台打开的程序。
  if (action === 'closeapp') {
    return injectCombo(['alt', 'f4'], '关闭窗口(Alt+F4)').then((r) => {
      if (r.ok) lastLaunchedPid = 0;
      if (win && !win.isDestroyed()) {
        win.webContents.send('remote:toast', r.ok ? '已向前台窗口发送关闭指令' : ('关闭失败：' + (r.error || '未知原因')));
      }
      return r;
    });
  }
  return { ok: false, error: '未知指令' };
}

/** 结束一个进程: Windows 用 taskkill /T 连子进程一起关, 其余用 SIGTERM */
function terminatePid(pid) {
  const { spawn } = require('child_process');
  if (WIN) {
    return new Promise((resolve) => {
      const c = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      let done = false;
      c.once('error', (e) => { if (!done) { done = true; resolve({ ok: false, error: e.message }); } });
      c.once('close', (code) => { if (!done) { done = true; resolve(code === 0 ? { ok: true } : { ok: false, error: `进程已退出或无权关闭（code ${code}）` }); } });
    });
  }
  try {
    process.kill(pid, 'SIGTERM');
    return Promise.resolve({ ok: true });
  } catch (e) {
    return Promise.resolve({ ok: false, error: e.message });
  }
}

/** 读取遥控页面 HTML(打包后也在 asar 内, 走文件路径读取) */
function remotePageHtml() {
  const p = path.join(__dirname, 'renderer', 'remote.html');
  try { return fs.readFileSync(p, 'utf8'); } catch (e) {
    console.error('[remote] 读取遥控页面失败', e && e.message);
    return '';
  }
}

/* ------------------------- 生命周期 ------------------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // 第一件事: 先亮出启动画面, 盖住后面读配置/建窗口的等待
    createSplash();

    store = new Store(DATA_DIR);
    icons = new IconCache(ICON_DIR, async (p) => {
      if (!p) return null;
      try {
        const img = await app.getFileIcon(p, { size: 'large' });
        return img && !img.isEmpty() ? img.toPNG() : null;
      } catch { return null; }
    });

    registerIconProtocol();
    setupIpc();
    setupAutostartContext();
    createWindow();

    // 家长守护：计时、密码校验、拦截都在主进程，渲染层只负责展示
    guard = new GuardService({
      getCfg: () => store.settings.parental || {},
      setCfg: (c) => { store.patchSettings({ parental: c }); store.save(); },
      send: (ch, payload) => {
        // 守护每秒推一次状态，顺便在这里驱动轻量加固的开关（只在翻转时写系统设置）
        if (ch === 'guard:state' && payload) {
          syncLockdown(!!(payload.enabled && payload.cfg && payload.cfg.lockdown && !payload.unlocked));
        }
        // 窗口被强杀的瞬间渲染帧可能已销毁，此时 send 会在 Electron 内部报错
        if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
          try { win.webContents.send(ch, payload); } catch { /* ignore */ }
        }
      },
      dataDir: DATA_DIR,
    });
    guard.push();
    // 加固生效、且启动台打开的程序已退出时，把窗口拉回前台，避免露出桌面
    lockdown.attachFocusGuard(win, {
      isActive: () => !!(guard && guard.lockdown),
      isLaunchedAppAlive: () => lockdown.isAlive(lastLaunchedPid),
    });

    // 任务栏自动隐藏: 设置开启则启动时隐藏, 退出时还原(见 before-quit)
    if (WIN && store.settings.autoHideTaskbar === true) {
      setTimeout(() => {
        taskbar.enable(DATA_DIR).then((r) => {
          if (r && !r.ok) console.warn('[taskbar] 自动隐藏失败', r.error);
        }).catch(() => {});
      }, 1500);
    }

    // 手机遥控常驻: 之前开启过就自动重启服务, 二维码角标随界面恢复显示, 不用每次去设置里点
    if (store.settings.remoteAlwaysOn === true) {
      setTimeout(() => {
        startRemoteService().then((info) => {
          console.log('[remote] auto-started at', info.url);
          // 通知渲染层显示常驻二维码角标（自动启动晚于渲染层初始化）
          if (win && !win.isDestroyed()) win.webContents.send('remote:started', info);
        }).catch((e) => {
          console.warn('[remote] auto-start failed', e && e.message);
        });
      }, 1200);
    }

    // Ctrl+Alt+L 呼出/收起启动台 —— 应用被置顶时靠它回来
    for (const acc of ['Control+Alt+L', 'Control+Alt+Space']) {
      try {
        if (globalShortcut.register(acc, toggleLauncher)) { hotkeyOk = true; break; }
      } catch { /* 热键被占用时试下一个 */ }
    }

    // 预热窗口增强用的辅助进程, 让第一次启动应用不用等。
    // 延后到首屏稳定之后再拉起, 避免启动瞬间和渲染争内存。
    // 只有 Windows 有这条路径, 其他平台直接跳过(不必白起一个进程)。
    if (BOOST_SUPPORTED) {
      setTimeout(() => {
        if (store.settings.boostLaunch !== false) warmBoost();
      }, 5000);
    }

    // 自愈: 让系统里的自启项与实际设置保持一致
    getAutostart().then((cur) => {
      const want = store.settings.autostart === true;
      if (want !== cur.enabled) return setAutostart(want);
      return null;
    }).catch(() => { /* 某些安全策略会禁止写自启项, 忽略 */ });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (store) store.flush();
    app.quit();
  });

  app.on('before-quit', () => {
    forceQuit = true; // 系统关机 / 主动 app.quit() 不再被窗口关闭拦截
    if (guard) guard.stop();
    // 轻量加固：写正常退出标记、恢复注册表策略，避免退出后任务管理器/Win 键一直被禁用
    try { lockdown.disable(DATA_DIR); } catch { /* ignore */ }
    if (store) store.flush(); // guard.stop() 写入的最后一批时间戳同步落盘
    // 还原任务栏: 同步执行, 确保退出前用户的任务栏已经回来
    try { if (taskbar.isActive(DATA_DIR)) taskbar.restore(DATA_DIR, true); } catch { /* ignore */ }
    try { globalShortcut.unregisterAll(); } catch {}
    try { if (remote) remote.stop(); } catch { /* ignore */ }
    try { winInput.stop(); } catch { /* ignore */ }
    stopBoost();
  });
}
