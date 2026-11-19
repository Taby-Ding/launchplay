'use strict';
/**
 * updater.js —— 应用内更新（仅 NSIS 安装版支持）
 *
 * electron-updater 靠 GitHub Releases 上的 latest.yml 判断新版本，
 * 由 CI 在打 tag 时自动生成并上传。安装版可一键下载 + 静默安装；
 * 便携版（portable）无法自我替换，降级为打开下载页让用户手动更新。
 *
 * 所有事件通过 onEvent 回调推给渲染层的"关于"面板展示进度。
 */

let updater = null;      // electron-updater 单例
let eventSink = null;    // (payload) => void，渲染层事件通道
let checking = false;
let latestInfo = null;   // 最近一次 check 到的版本信息

const RELEASE_URL = 'https://github.com/Taby-Ding/launchplay/releases/latest';

function emit(type, data) {
  if (typeof eventSink === 'function') eventSink({ type, ...(data || {}) });
}

/** 是否是可自我更新的安装版：打包后 + 非 portable + Windows */
function isInstalledBuild(app) {
  if (!app || !app.isPackaged) return false;
  // electron-builder 便携版会给进程加 --portable 参数/环境变量
  if (process.argv.some((a) => /--portable\b/i.test(a))) return false;
  if (process.env.PORTABLE_EXECUTABLE_FILE) return false;
  return true;
}

function load() {
  if (updater) return updater;
  try {
    updater = require('electron-updater').autoUpdater;
    updater.autoDownload = false;       // 由用户点"下载更新"才下
    updater.autoInstallOnAppQuit = true; // 下载完退出时安装
    updater.allowPrerelease = false;
    // 绑定底层事件，统一转发给渲染层
    updater.on('checking-for-update', () => emit('checking'));
    updater.on('update-available', (info) => {
      latestInfo = { version: info.version, releaseNotes: info.releaseNotes || '' };
      emit('available', latestInfo);
    });
    updater.on('update-not-available', (info) => emit('not-available', { version: info && info.version }));
    updater.on('download-progress', (p) => emit('progress', { percent: Math.round(p.percent || 0) }));
    updater.on('update-downloaded', (info) => emit('downloaded', { version: info.version }));
    updater.on('error', (e) => emit('error', { message: (e && e.message) || '更新出错' }));
    return updater;
  } catch (e) {
    console.warn('[updater] electron-updater 不可用:', e && e.message);
    return null;
  }
}

/** 渲染层注册事件回调 */
function setSink(fn) { eventSink = fn; }

/** 是否安装版（渲染层据此决定按钮文案/是否可用） */
function capability(app, shell) {
  return { canUpdate: isInstalledBuild(app) && !!load(), releaseUrl: RELEASE_URL };
}

/** 检查新版本 */
async function check(app, shell) {
  if (!isInstalledBuild(app)) {
    emit('error', { message: '免安装版不支持自动更新，请在官网下载最新版' });
    return { ok: false, portable: true, releaseUrl: RELEASE_URL };
  }
  const u = load();
  if (!u) return { ok: false, error: '更新组件不可用' };
  if (checking) return { ok: false, error: '正在检查中' };
  checking = true;
  try {
    const r = await u.checkForUpdates();
    return { ok: true, result: r && r.updateInfo ? { version: r.updateInfo.version } : null };
  } catch (e) {
    emit('error', { message: (e && e.message) || '检查更新失败' });
    return { ok: false, error: (e && e.message) || '检查更新失败' };
  } finally {
    checking = false;
  }
}

/** 下载更新 */
async function download(app) {
  if (!isInstalledBuild(app)) return { ok: false, portable: true, releaseUrl: RELEASE_URL };
  const u = load();
  if (!u) return { ok: false, error: '更新组件不可用' };
  try {
    await u.downloadUpdate();
    return { ok: true };
  } catch (e) {
    emit('error', { message: (e && e.message) || '下载失败' });
    return { ok: false, error: (e && e.message) || '下载失败' };
  }
}

/** 安装并重启（下载完成后调用） */
function install(app) {
  if (!isInstalledBuild(app)) return { ok: false, error: '仅安装版支持' };
  const u = load();
  if (!u) return { ok: false, error: '更新组件不可用' };
  try {
    setImmediate(() => u.quitAndInstall(false, true));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '安装失败' };
  }
}

/** 打开 releases 页面（便携版用） */
function openRelease(shell) {
  if (shell) shell.openExternal(RELEASE_URL);
}

module.exports = {
  setSink, capability, check, download, install, openRelease,
  get version() { return latestInfo && latestInfo.version; },
};
