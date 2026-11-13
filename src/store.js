'use strict';
/**
 * store.js —— 配置/应用列表持久化
 * 纯 JSON 落盘, 写入采用「临时文件 + rename」, 防止断电/异常退出把文件写坏。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  autostart: false,
  fullscreen: true,
  sound: true,
  clock24h: true,
  showClockSeconds: false,
  tileSize: 'normal', // compact | normal | large
  hideHints: false,
  hideAfterLaunch: false, // 启动应用后是否收起启动台(默认不收起, 留在应用下层)
  boostLaunch: true,      // 让新窗口铺满屏幕并置顶
  // 背景: 'default' = 随程序附带的电视背景图, '' = 纯深色渐变,
  //       其它值为 backgrounds 目录下的自定义图片文件名
  background: { file: 'default', dim: 0.25, blur: false },
};

// 配置文件版本: 用于一次性迁移
//   1 -> 2 : 启动后不再默认收起启动台, 改为留在新窗口下层
//   2 -> 3 : 内置电视背景图成为默认背景
const SCHEMA_VERSION = 3;

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'launcher.json');
    this.data = { version: SCHEMA_VERSION, items: [], settings: { ...DEFAULT_SETTINGS }, firstRun: true };
    this._timer = null;
    this.load();
  }

  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const txt = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === 'object') {
        this.data.items = Array.isArray(parsed.items) ? parsed.items.filter(Boolean) : [];
        this.data.settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
        this.data.firstRun = parsed.firstRun !== false;
        if (typeof parsed.version === 'number') this.data.version = parsed.version;
        this.migrate();
      }
    } catch {
      /* 首次运行或文件损坏 —— 使用默认值 */
    }
    return this.data;
  }

  /** 老配置升级: 只在缺少字段时补默认值, 不覆盖用户已经改过的设置 */
  migrate() {
    if (this.data.version < 2) {
      // v1 里"启动后收起启动台"默认是开, 老用户未必主动选过 —— 统一改成"不收起"
      this.data.settings.hideAfterLaunch = false;
      this.data.version = 2;
      this.save();
    }
    if (this.data.version < 3) {
      // v2 及以前默认没有背景图, 3.0 起内置一张电视背景当默认值
      const bg = this.data.settings.background || {};
      if (!bg.file) this.data.settings.background = { file: 'default', dim: 0.25, blur: false };
      this.data.version = 3;
      this.save();
    }
  }

  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 120);
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] 保存失败', e);
    }
  }

  get items() { return this.data.items; }
  set items(v) { this.data.items = Array.isArray(v) ? v : []; }

  get settings() { return this.data.settings; }
  patchSettings(patch) {
    this.data.settings = { ...this.data.settings, ...(patch || {}) };
    return this.data.settings;
  }

  get firstRun() { return this.data.firstRun; }
  set firstRun(v) { this.data.firstRun = !!v; }
}

module.exports = { Store, DEFAULT_SETTINGS };
