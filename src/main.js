'use strict';
/**
 * main.js —— 主进程
 * 职责: 创建全屏无边框窗口、注册图标协议、IPC 服务(扫描/启动/电源/开机自启)、数据落盘。
 */

const {
  app, BrowserWindow, ipcMain, protocol, dialog, shell, Menu, nativeImage, globalShortcut,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const { Store } = require('./store');
const { IconCache } = require('./iconcache');
const { normalizePick } = require('./lnk');
const { boostWindow, warmup: warmBoost, shutdownWorker: stopBoost } = require('./winboost');

const isDev = !app.isPackaged;
const CAPTURE = process.env.TL_CAPTURE || '';
const CAPTURE_FULLSCREEN = process.env.TL_CAPTURE_FS === '1';

/* ------------------------- 数据目录 ------------------------- */
/**
 * 便携版优先把数据放在 exe 同级目录, 真正做到「拷走就能用」;
 * 目录不可写时回退到 userData。
 * 2.0 起品牌名从 TVLauncher 改为 LaunchPlay, 老目录数据自动迁移一次。
 */
function migrateLegacyData(portableDir) {
  const oldDir = path.join(portableDir, 'TVLauncherData');
  const newDir = path.join(portableDir, 'LaunchPlayData');
  try {
    if (!fs.existsSync(oldDir)) return;
    if (fs.existsSync(path.join(newDir, 'launcher.json'))) return;
    fs.mkdirSync(newDir, { recursive: true });
    fs.cpSync(oldDir, newDir, { recursive: true });
    console.log('[migrate] TVLauncherData -> LaunchPlayData');
  } catch (e) {
    console.warn('[migrate] skipped:', e && e.message);
  }
}

function resolveDataDir() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const candidates = [];
  if (portableDir) migrateLegacyData(portableDir);
  if (process.env.TL_DATA_DIR) candidates.push(process.env.TL_DATA_DIR);
  if (portableDir) candidates.push(path.join(portableDir, 'LaunchPlayData'));
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

let store = null;
let icons = null;
let win = null;
let hotkeyOk = false;   // 唤回热键是否注册成功(没注册成功就不自动收起, 免得回不来)

/* ------------------------- 图标协议 ------------------------- */
protocol.registerSchemesAsPrivileged([
  { scheme: 'tlapp', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);

function iconUrl(fileName) {
  return fileName ? `tlapp://icon/${encodeURIComponent(fileName)}` : '';
}

function registerIconProtocol() {
  protocol.handle('tlapp', async (req) => {
    try {
      const u = new URL(req.url);
      const name = path.basename(decodeURIComponent(u.pathname));
      const full = path.join(ICON_DIR, name);
      if (!full.startsWith(ICON_DIR)) return new Response('forbidden', { status: 403 });
      const buf = fs.readFileSync(full);
      const ext = path.extname(name).toLowerCase();
      const type = ext === '.png' ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
          : ext === '.webp' ? 'image/webp'
            : ext === '.gif' ? 'image/gif' : 'application/octet-stream';
      return new Response(new Uint8Array(buf), { headers: { 'content-type': type, 'cache-control': 'max-age=604800' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

/* ------------------------- 窗口 ------------------------- */
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
    title: '影音快启 LaunchPlay',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: isDev || !!CAPTURE,
    },
  });

  Menu.setApplicationMenu(null);
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
  });

  // 外部链接不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
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
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'LaunchPlay';

function autostartTarget() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function regExe(args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      execFile('reg.exe', args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: String(e && e.message || e) });
    }
  });
}

async function getAutostart() {
  const r = await regExe(['query', RUN_KEY, '/v', RUN_VALUE]);
  if (!r.ok) return { enabled: false, command: '' };
  const m = r.stdout.match(new RegExp(`${RUN_VALUE}\\s+REG_SZ\\s+(.+)`, 'i'));
  return { enabled: !!m, command: m ? m[1].trim() : '' };
}

async function setAutostart(enabled) {
  if (enabled) {
    const cmd = `"${autostartTarget()}"`;
    const r = await regExe(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', cmd, '/f']);
    return r.ok;
  }
  // 不存在时删除会报错, 忽略即可
  await regExe(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  return true;
}

/* ------------------------- 启动应用 ------------------------- */
/** 简单参数分词, 支持双引号包裹 */
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function spawnDetached(exe, args) {
  return new Promise((resolve, reject) => {
    let done = false;
    let child;
    try {
      child = spawn(exe, args, {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(exe) || undefined,
        windowsHide: false,
      });
    } catch (e) {
      return reject(e);
    }
    child.once('error', (e) => {
      if (!done) { done = true; reject(e); }
    });
    child.once('spawn', () => {
      if (!done) { done = true; child.unref(); resolve(child); }
    });
  });
}

/** 需要管理员权限的程序: 走 ShellExecute RunAs, 会弹 UAC */
function launchElevated(exe, args) {
  const argLine = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const ps = [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
    `Start-Process -FilePath '${exe.replace(/'/g, "''")}'${argLine ? ` -ArgumentList ${argLine}` : ''} -Verb RunAs`,
  ];
  return new Promise((resolve) => {
    const c = spawn('powershell.exe', ps, { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => resolve(false));
    c.on('spawn', () => { c.unref(); resolve(true); });
  });
}

async function launchItem(item) {
  if (!item) return { ok: false, error: '条目不存在' };

  if (item.kind === 'uwp' && item.appId) {
    try {
      await spawnDetached('explorer.exe', [`shell:AppsFolder\\${item.appId}`]);
      afterLaunch(0);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: '无法启动该应用: ' + e.message };
    }
  }

  const target = (item.target || '').trim();
  if (!target) return { ok: false, error: '该条目没有可执行路径，请编辑后重试' };
  if (!fs.existsSync(target)) return { ok: false, error: `路径不存在: ${target}` };

  const ext = path.extname(target).toLowerCase();
  const args = item.args ? splitArgs(item.args) : [];

  // 快捷方式 / 脚本 / 协议链接交给系统处理
  if (['.lnk', '.url', '.bat', '.cmd', '.ps1', '.msc'].includes(ext) || target.includes('::')) {
    const err = await shell.openPath(target);
    if (!err) afterLaunch(0);
    return err ? { ok: false, error: err } : { ok: true };
  }

  try {
    const child = await spawnDetached(target, args);
    afterLaunch(child && child.pid);
    return { ok: true };
  } catch (e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
      const ok = await launchElevated(target, args);
      if (ok) afterLaunch(0);
      return ok ? { ok: true } : { ok: false, error: '该程序需要管理员权限，已取消' };
    }
    // 兜底: 用 ShellExecute
    const err = await shell.openPath(target);
    if (!err) afterLaunch(0);
    return err ? { ok: false, error: err } : { ok: true };
  }
}

/**
 * 启动应用后的收尾动作:
 *   1. 默认不收起启动台, 只让出前台 —— 新程序盖在上面, 启动台留在它下层
 *   2. 把新窗口铺满屏幕并置顶(尽力而为, 失败不影响使用)
 */
function afterLaunch(pid) {
  const s = (store && store.settings) || {};

  if (win && !win.isDestroyed()) {
    if (s.hideAfterLaunch === true) {
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

  if (s.boostLaunch !== false && pid) {
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
  win.setAlwaysOnTop(false);
  win.hide();
}

/* ------------------------- IPC ------------------------- */
function stateSnapshot() {
  return {
    items: store.items,
    settings: store.settings,
    firstRun: store.firstRun,
    dataDir: DATA_DIR,
    version: app.getVersion(),
  };
}

function setupIpc() {
  ipcMain.handle('state:get', () => stateSnapshot());

  ipcMain.handle('state:save', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return stateSnapshot();
    if (Array.isArray(patch.items)) store.items = patch.items;
    if (patch.settings && typeof patch.settings === 'object') store.patchSettings(patch.settings);
    if (typeof patch.firstRun === 'boolean') store.firstRun = patch.firstRun;
    store.save();
    return { ok: true, items: store.items, settings: store.settings };
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
   * 选择程序文件(支持多选)
   * 返回标准化后的条目数组, 由渲染层决定是填表还是批量添加
   */
  ipcMain.handle('dialog:pick-exe', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择要添加的程序（可多选）',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [
        { name: '程序与快捷方式', extensions: ['exe', 'lnk', 'bat', 'cmd', 'msc', 'com', 'url'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const deep = r.filePaths.length === 1; // 只有单个时才解析 .lnk, 批量时保证速度
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

  ipcMain.handle('app:launch', async (_e, item) => launchItem(item));

  // 供渲染层/外部唤起启动台(与全局热键同一入口)
  ipcMain.handle('launcher:toggle', () => {
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
    const arg = action === 'restart' ? '/r' : '/s';
    return new Promise((resolve) => {
      const c = spawn('shutdown.exe', [arg, '/t', '0'], { windowsHide: true, detached: true, stdio: 'ignore' });
      c.on('error', (err) => resolve({ ok: false, error: err.message }));
      c.on('spawn', () => { c.unref(); resolve({ ok: true }); });
    });
  });

  ipcMain.handle('autostart:get', () => getAutostart());
  ipcMain.handle('autostart:set', async (_e, enabled) => {
    const ok = await setAutostart(!!enabled);
    if (ok) { store.patchSettings({ autostart: !!enabled }); store.save(); }
    return { ok, state: await getAutostart() };
  });

  ipcMain.handle('win:fullscreen', (_e, on) => {
    if (!win) return false;
    win.setFullScreen(!!on);
    store.patchSettings({ fullscreen: !!on });
    store.save();
    return win.isFullScreen();
  });

  ipcMain.handle('win:minimize', () => { if (win) win.minimize(); });
  ipcMain.handle('win:quit', () => { if (win) win.close(); });

  ipcMain.handle('os:open-path', async (_e, p) => {
    if (!p) return;
    if (/^https?:/i.test(p)) shell.openExternal(p);
    else shell.openPath(p);
  });
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

  app.whenReady().then(() => {
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
    createWindow();

    // Ctrl+Alt+L 呼出/收起启动台 —— 应用被置顶时靠它回来
    for (const acc of ['Control+Alt+L', 'Control+Alt+Space']) {
      try {
        if (globalShortcut.register(acc, toggleLauncher)) { hotkeyOk = true; break; }
      } catch { /* 热键被占用时试下一个 */ }
    }

    // 预热窗口增强用的辅助进程, 让第一次启动应用不用等
    setTimeout(() => {
      if (store.settings.boostLaunch !== false) warmBoost();
    }, 1800);

    // 自愈: 让注册表里的自启项与实际设置保持一致
    getAutostart().then((cur) => {
      const want = store.settings.autostart === true;
      if (want !== cur.enabled) return setAutostart(want);
      return null;
    }).catch(() => { /* 某些安全策略会禁止访问注册表, 忽略 */ });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (store) store.flush();
    app.quit();
  });

  app.on('before-quit', () => {
    if (store) store.flush();
    try { globalShortcut.unregisterAll(); } catch {}
    stopBoost();
  });
}
