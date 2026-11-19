'use strict';
/**
 * preload.js —— 安全桥: 渲染进程只能访问这里显式暴露的能力
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 状态
  getState: () => ipcRenderer.invoke('state:get'),
  saveState: (patch) => ipcRenderer.invoke('state:save', patch),

  // 图标 / 背景
  ensureIcons: (list) => ipcRenderer.invoke('icons:ensure', list),
  importIcon: (p) => ipcRenderer.invoke('icon:import', p),
  pickBackground: () => ipcRenderer.invoke('bg:pick'),
  clearBackground: () => ipcRenderer.invoke('bg:clear'),

  // 对话框
  pickExe: () => ipcRenderer.invoke('dialog:pick-exe'),
  pickImage: () => ipcRenderer.invoke('dialog:pick-image'),

  // 动作
  launch: (item) => ipcRenderer.invoke('app:launch', item),
  toggleLauncher: () => ipcRenderer.invoke('launcher:toggle'),
  power: (action) => ipcRenderer.invoke('power', action),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),

  // 窗口
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  quit: () => ipcRenderer.invoke('win:quit'),
  openPath: (p) => ipcRenderer.invoke('os:open-path', p),
  setTaskbar: (on) => ipcRenderer.invoke('taskbar:set', on),

  // 应用内更新（安装版）
  updateCapability: () => ipcRenderer.invoke('update:capability'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateOpenRelease: () => ipcRenderer.invoke('update:open-release'),
  // 更新事件只服务于"关于"面板：先清掉旧的，避免重复打开弹窗时监听器累积
  onUpdateEvent: (cb) => {
    ipcRenderer.removeAllListeners('update:event');
    ipcRenderer.on('update:event', (_e, payload) => cb(payload));
  },

  // 手机遥控
  remoteStart: () => ipcRenderer.invoke('remote:start'),
  remoteStop: () => ipcRenderer.invoke('remote:stop'),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  remoteRotate: () => ipcRenderer.invoke('remote:rotate'),
  remoteDevices: () => ipcRenderer.invoke('remote:devices'),
  remoteRevoke: (id) => ipcRenderer.invoke('remote:revoke', id),
  remoteRevokeAll: () => ipcRenderer.invoke('remote:revoke-all'),
  onRemoteStarted: (cb) => ipcRenderer.on('remote:started', (_e, info) => cb(info)),
  onRemoteNav: (cb) => ipcRenderer.on('remote:nav', (_e, action) => cb(action)),
  onRemotePower: (cb) => ipcRenderer.on('remote:power', (_e, action) => cb(action)),
  onRemoteToast: (cb) => ipcRenderer.on('remote:toast', (_e, text) => cb(text)),

  // 天气
  weatherGet: (city, force) => ipcRenderer.invoke('weather:get', city, !!force),
  weatherCities: () => ipcRenderer.invoke('weather:cities'),

  // 定时关机
  shutdownSchedule: (hours, minutes) => ipcRenderer.invoke('shutdown:schedule', hours, minutes),
  shutdownCancel: () => ipcRenderer.invoke('shutdown:cancel'),
  shutdownStatus: () => ipcRenderer.invoke('shutdown:status'),

  // 家长守护
  guardStatus: () => ipcRenderer.invoke('guard:status'),
  guardVerify: (pwd) => ipcRenderer.invoke('guard:verify', pwd),
  guardConfigure: (patch) => ipcRenderer.invoke('guard:configure', patch),
  guardQuizInfo: () => ipcRenderer.invoke('guard:quiz-info'),
  guardQuizImport: () => ipcRenderer.invoke('guard:quiz-import'),
  guardQuizExportSample: () => ipcRenderer.invoke('guard:quiz-export-sample'),
  guardQuestion: () => ipcRenderer.invoke('guard:question'),
  guardAnswer: (idx) => ipcRenderer.invoke('guard:answer', idx),
  onGuardState: (cb) => {
    ipcRenderer.removeAllListeners('guard:state');
    ipcRenderer.on('guard:state', (_e, payload) => cb(payload));
  },
});
