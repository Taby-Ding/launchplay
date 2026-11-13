'use strict';
/**
 * preload.js —— 安全桥: 渲染进程只能访问这里显式暴露的能力
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 状态
  getState: () => ipcRenderer.invoke('state:get'),
  saveState: (patch) => ipcRenderer.invoke('state:save', patch),

  // 图标
  ensureIcons: (list) => ipcRenderer.invoke('icons:ensure', list),
  importIcon: (p) => ipcRenderer.invoke('icon:import', p),

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
});
