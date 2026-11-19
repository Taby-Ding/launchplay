'use strict';
/**
 * store.js —— 配置/应用列表持久化
 * 纯 JSON 落盘, 写入采用「临时文件 + rename」, 防止断电/异常退出把文件写坏。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  autostart: true,
  fullscreen: true,
  sound: true,
  clock24h: true,
  showClockSeconds: false,
  tileSize: 'normal', // compact | normal | large
  hideHints: false,
  hideAfterLaunch: false, // 启动应用后是否收起启动台(默认不收起, 留在应用下层)
  boostLaunch: true,      // 让新窗口铺满屏幕并置顶
  // 手机遥控：默认开启，每次启动软件自动开启服务并在角落常驻二维码
  remoteAlwaysOn: true,
  autoHideTaskbar: true,  // 默认开启：启动台运行时隐藏 Windows 任务栏, 退出后还原
  // 字号缩放系数：1.3 = 默认(即原"更大"档的字号), 见 style.css 的 --fs 与 app.js 的 FONT_SCALES
  fontScale: 1.3,
  // 左上角天气：'auto' = 按 IP 自动定位，其余为 9 位城市编码（见 weather-cities.js）
  weatherCity: 'auto',
  // 手机遥控万能键：最多 4 个，{ name: '显示名', combo: ['ctrl','alt','f5'] }
  customKeys: [],
  // 手机遥控的长期配对：
  //   pairSecret 落盘固定（二维码里只带它，不再每次启动随机换 6 位码）
  //   devices 是已配对手机白名单，每条 { id, name, token, createdAt, lastSeen }
  //   手机本地只存自己的 token；电脑端可单独撤销或整体清空。
  remote: { pairSecret: '', devices: [] },
  // 家长守护：密码哈希只存主进程，渲染层拿到的是脱敏后的副本
  parental: {
    enabled: false,
    passSalt: '',
    passHash: '',
    intervalMin: 60,   // 每隔多少分钟强制休息
    restMin: 10,       // 每次强制休息多少分钟
    quizEnabled: true, // 允许答题正确后提前结束休息
    lockdown: false,   // 轻量加固：禁任务管理器/Win 键、被结束后自动拉起、防切回桌面
    // 下面 4 个是「现实时间」计时的持久化字段，重启 / 关机都不清零。
    // 用绝对时间戳而不是内存累加，防止重启一次就把使用时长清零。
    usageMs: 0,        // 距上次休息结束累计使用毫秒
    lastAt: 0,         // 上次计时的 Date.now()
    restUntil: 0,      // 休息结束的 Date.now()（0 = 当前没在休息）
    wrongUntil: 0,     // 答错锁定结束的 Date.now()
  },
  // 背景: 'default' = 随程序附带的电视背景图, '' = 纯深色渐变,
  //       其它值为 backgrounds 目录下的自定义图片文件名
  background: { file: 'default', dim: 0.25, blur: false },
};

// 配置文件版本: 用于一次性迁移
//   1 -> 2 : 启动后不再默认收起启动台, 改为留在新窗口下层
//   2 -> 3 : 内置电视背景图成为默认背景
//   3 -> 4 : 二维码常驻与任务栏自动隐藏改为默认开启；引入字号缩放
//   4 -> 5 : 字号默认档从 1 提升到 1.3（原"更大"档成为新的"标准"）
//   5 -> 6 : 开机自启改为默认开启
//   6 -> 7 : 引入天气城市、家长守护配置
//   7 -> 8 : 天气改省市两级 9 位编码；家长守护改现实时间计时 + 轻量加固；新增万能键
//   8 -> 9 : 手机遥控改为落盘固定配对凭证 + 可撤销设备白名单
const SCHEMA_VERSION = 9;

/** 生成遥控配对凭证（32 字节随机十六进制，48 位字符） */
function newPairSecret() { return crypto.randomBytes(24).toString('hex'); }

/** v7 的城市 id -> v8 的 9 位编码，保证老用户升级后天气设置不丢 */
const LEGACY_CITY_CODES = {
  beijing: '101010100', shanghai: '101020100', guangzhou: '101280101', shenzhen: '101280601',
  hangzhou: '101210101', nanjing: '101190101', suzhou: '101190401', chengdu: '101270101',
  chongqing: '101040100', wuhan: '101200101', xian: '101110101', tianjin: '101030100',
  changsha: '101250101', zhengzhou: '101180101', jinan: '101120101', qingdao: '101120201',
  shenyang: '101070101', dalian: '101070201', harbin: '101050101', changchun: '101060101',
  shijiazhuang: '101090101', taiyuan: '101100101', kunming: '101290101', guiyang: '101260101',
  nanning: '101300101', haikou: '101310101', fuzhou: '101230101', xiamen: '101230201',
  nanchang: '101240101', hefei: '101220101', lanzhou: '101160101', urumqi: '101130101',
};

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
        // 家长守护是嵌套对象：做一次深合并，避免旧配置只带部分字段时丢掉其它默认值
        this.data.settings.parental = {
          ...DEFAULT_SETTINGS.parental,
          ...((parsed.settings && parsed.settings.parental) || {}),
        };
        this.data.settings.remote = {
          ...DEFAULT_SETTINGS.remote,
          ...((parsed.settings && parsed.settings.remote) || {}),
        };
        this.data.firstRun = parsed.firstRun !== false;
        if (typeof parsed.version === 'number') this.data.version = parsed.version;
        this.migrate();
      }
    } catch {
      /* 首次运行或文件损坏 —— 使用默认值 */
    }
    // 首次运行不会走 migrate()，这里兜底生成遥控配对凭证
    const r = this.data.settings.remote;
    if (!r || typeof r !== 'object') this.data.settings.remote = { pairSecret: '', devices: [] };
    if (!/^[0-9a-f]{48}$/.test(this.data.settings.remote.pairSecret)) {
      this.data.settings.remote.pairSecret = newPairSecret();
      this.save();
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
    if (this.data.version < 4) {
      // v3 及以前二维码/任务栏是可选开关(旧默认 false), 4.0 起默认开启。
      // 旧配置里的 false 是"旧默认"而非用户主动选择 —— 统一升级为开启。
      const s = this.data.settings;
      s.remoteAlwaysOn = true;
      s.autoHideTaskbar = true;
      if (typeof s.fontScale !== 'number') s.fontScale = 1;
      this.data.version = 4;
      this.save();
    }
    if (this.data.version < 5) {
      // 字号默认档从 1 提到 1.3(原"更大")。只有仍停留在旧默认值 1 的才提升,
      // 用户主动调过的其它值(1.15/1.3/1.5...)保持尊重, 不覆盖其选择。
      const s = this.data.settings;
      if (s.fontScale === 1) s.fontScale = 1.3;
      this.data.version = 5;
      this.save();
    }
    if (this.data.version < 6) {
      // 开机自启改为默认开启。与二维码/任务栏一致: 旧 false 是旧默认而非用户主动关闭,
      // 统一升级为开启。以后用户仍可在设置里手动关掉。
      this.data.settings.autostart = true;
      this.data.version = 6;
      this.save();
    }
    if (this.data.version < 7) {
      const s = this.data.settings;
      if (typeof s.weatherCity !== 'string' || !s.weatherCity) s.weatherCity = 'auto';
      s.parental = { ...DEFAULT_SETTINGS.parental, ...(s.parental || {}) };
      this.data.version = 7;
      this.save();
    }
    if (this.data.version < 8) {
      const s = this.data.settings;
      // 老版本用 beijing / shenzhen 这类 id，v8 起统一换成 9 位编码
      if (typeof s.weatherCity === 'string' && s.weatherCity !== 'auto' && !/^\d{9}$/.test(s.weatherCity)) {
        s.weatherCity = LEGACY_CITY_CODES[s.weatherCity] || 'auto';
      }
      s.parental = { ...DEFAULT_SETTINGS.parental, ...(s.parental || {}) };
      if (!Array.isArray(s.customKeys)) s.customKeys = [];
      this.data.version = 8;
      this.save();
    }
    if (this.data.version < 9) {
      const s = this.data.settings;
      const r = s.remote && typeof s.remote === 'object' ? s.remote : {};
      if (typeof r.pairSecret !== 'string' || !/^[0-9a-f]{48}$/.test(r.pairSecret)) {
        r.pairSecret = newPairSecret();
      }
      r.devices = Array.isArray(r.devices) ? r.devices.filter((d) => d && typeof d.token === 'string' && d.token) : [];
      s.remote = { ...DEFAULT_SETTINGS.remote, ...r };
      this.data.version = 9;
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

module.exports = { Store, DEFAULT_SETTINGS, newPairSecret };
