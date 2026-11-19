'use strict';
/**
 * remote.js —— 手机遥控的局域网服务（主进程）
 *
 * 设计要点：
 *   1. 用 Node 内置 http，零第三方依赖；只接受来自局域网私网网段的请求。
 *   2. 二维码里带的是落盘固定的配对凭证 pairSecret（不再每次启动换 6 位码）。
 *      手机首次扫码后用 pairSecret 换取长期设备令牌 token，存在手机 localStorage；
 *      之后每条指令只带 token，电脑端按可撤销的设备白名单校验。
 *   3. 服务默认关闭，设置里点"开启手机遥控"才启动；关掉窗口即停。
 *   4. HTTP 只传指令（几个字节），不传图片/视频，局域网里几乎不占带宽。
 *   5. 手机浏览器不能发 UDP，自动发现由手机做 HTTP 网段探测；电脑端另有
 *      discovery.js 做 UDP 广播，二者都不依赖任何原生模块（兼容 Win7）。
 *
 * 指令通过 onAction(action) 回调交给主进程执行；这里不碰 Electron API，
 * 便于单独跑单元测试。
 */

const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { generateQr } = require('./qr');
const { newPairSecret } = require('./store');

const DEFAULT_PORT = 18765;
const MAX_DEVICES = 8;

/** 允许的指令白名单，防止被当成跳板执行意外操作 */
const ALLOWED = new Set([
  'up', 'down', 'left', 'right', 'ok', 'back',
  'toggle', 'home', 'shutdown', 'restart',
  'volup', 'voldown', 'mute', 'play', 'next', 'prev',
  'closeapp',
  // 播放控制（自动跟随：注入真实键盘）
  'playpause', 'ffwd', 'rew', 'fullscreen', 'nextep',
  // 鼠标 / 键盘模拟（注入到前台程序）
  'mmove', 'mclick', 'mrclick', 'mdown', 'mup', 'mwheel', 'type', 'key',
  // 万能键：手机只传槽位下标，具体组合由电脑端配置决定
  'macro',
]);

/** 需要携带参数的指令；其余指令忽略 payload，避免夹带 */
const PARAM_ACTIONS = new Set(['mmove', 'mwheel', 'type', 'key', 'macro']);

/** key 指令允许的键名（映射到 Windows 虚拟键；也可直接传 1-254 的数字） */
const KEY_NAMES = new Set([
  'up', 'down', 'left', 'right', 'space', 'enter', 'esc', 'tab',
  'backspace', 'del', 'f', 'f11', 'volup', 'voldown', 'mute',
  'next', 'prev', 'play', 'ctrl', 'shift', 'alt',
  'a', 'b', 'c', 'd', 'e', 'f2', 'home', 'end', 'pgup', 'pgdn',
]);

/** 数值夹取（防止异常大参数） */
function clampNum(v, lo, hi, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
}

/**
 * 按指令类型提取并校验参数，返回干净的参数对象。
 * 未知字段一律丢弃；文本限制长度、数值限制范围，避免被当成跳板。
 */
function sanitizeParams(action, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  switch (action) {
    case 'mmove':
      return { dx: clampNum(p.dx, -800, 800), dy: clampNum(p.dy, -800, 800) };
    case 'mwheel':
      return { delta: clampNum(p.delta, -1200, 1200) };
    case 'type': {
      const text = typeof p.text === 'string' ? p.text.slice(0, 500) : '';
      return { text };
    }
    case 'macro': {
      const i = Number(p.index);
      if (!Number.isInteger(i) || i < 0 || i > 3) return null;
      return { index: i };
    }
    case 'key': {
      const raw = p.key;
      if (typeof raw === 'string' && KEY_NAMES.has(raw.toLowerCase())) return { key: raw.toLowerCase() };
      if (Number.isInteger(raw) && raw >= 1 && raw <= 254) return { key: raw };
      if (typeof raw === 'string' && /^\d{1,3}$/.test(raw)) {
        const n = Number(raw);
        if (n >= 1 && n <= 254) return { key: n };
      }
      return null; // 非法键名 -> 拒绝
    }
    default:
      return {};
  }
}

/** 列出可用于局域网的 IPv4（排除回环、APIPA 169.254） */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces() || {};
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue;
      out.push({ address: a.address, name });
    }
  }
  // 常见的家用网段排前面，方便默认选中
  const score = (ip) => {
    if (/^192\.168\./.test(ip)) return 0;
    if (/^10\./.test(ip)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  out.sort((a, b) => score(a.address) - score(b.address));
  return out;
}

/** 仅接受 RFC1918 私网地址（含本机回环），公网来源一律拒绝 */
function isLanAddress(remote) {
  let ip = String(remote || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(ip)) return true;
  return false;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(body);
}

const MANIFEST = JSON.stringify({
  name: '影游快启 · 手机遥控',
  short_name: '遥控',
  description: '影游快启的局域网手机遥控器',
  start_url: '/',
  display: 'fullscreen',
  orientation: 'portrait',
  background_color: '#0b1020',
  theme_color: '#0b1020',
  icons: [{ src: '/icon.png', sizes: '192x192', type: 'image/png' }],
});

// 192×192 内嵌图标，避免为 PWA 再带一张图片文件（base64 解码后约 1.2KB）
const ICON_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAChklEQVR42u3csQ2DMABFQfc0jMCCTMLQZgUaCvtdpLcA+qcogDOO85pSteEiCAAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQApAOB+pjYPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAgAAAQAAAIAAAEAADf+vsDAABpADsiAACANAIAAEgjAACANAIAAEgjAACANAIAAEgjAACANAQAAEgjAACANAIAAEgjAACANAIAAEgjAACANAIAAEgjAACANAIAAEhDAACANAIAAEgjAACANAIAAEgjAACANAIAAEgjAACANAIAAEgjAACANAQAAPANAAAAfgMAAIC7QAAA4DkAAAB4EgwAAN4FAgAAb4MCAIDzAAAA4EQYAAA4EwwAAP4VAgAA1h8/AACkxw8AAOnxAwBAevwAAJAePwAApMcPAADp8QMAQHb4AACQHz8AAKTHDwAA6fEDAEB6/AAAkB4/AACkxw8AAOnxA7AZAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgABYB4AEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgABwEQSABIAEgASABIAEgASABIAEgASABIC0Qy9jBuWQbb+bEgAAAABJRU5ErkJggg==';

/**
 * @param {(action: string, params: object) => (Promise<any>|any)} onAction 收到合法指令时的回调
 */
class RemoteService {
  constructor(onAction) {
    this.onAction = onAction;
    this.server = null;
    this.store = null;
    this.pairSecret = '';
    this.port = DEFAULT_PORT;
    this.addr = '';
    this._addresses = [];
    // 启动计数器：每当启动台打开一个程序就 +1，手机页检测到变化后自动跳到播放遥控卡片
    this.launchSeq = 0;
    // 启动台是否在前台的状态提供者（由主进程注入，remote.js 本身不依赖 Electron）
    this.frontProvider = null;
    // 手机页动态配置（万能键等）提供者，随 /ping 下发
    this.configProvider = null;
  }

  /** 注入 Store（可选）；不注入时凭证只在内存中，重启后失效 */
  setStore(store) { this.store = store || null; }

  /** 通知手机页"有新程序被打开"（由主进程 afterLaunch 调用） */
  notifyLaunch() { this.launchSeq++; }

  /** 注入"启动台是否在前台"的查询函数，供 /ping 回显给手机页 */
  setFrontProvider(fn) { this.frontProvider = typeof fn === 'function' ? fn : null; }

  /** 注入手机页配置查询函数（只下发显示名，不下发具体按键组合） */
  setConfigProvider(fn) { this.configProvider = typeof fn === 'function' ? fn : null; }

  get running() { return !!this.server; }

  /** 页面 HTML 由外部注入（放在 renderer/remote.html），避免 here 里堆一大段字符串 */
  setPage(html) { this.pageHtml = String(html || ''); }

  /* ---------------- 持久化凭证 / 设备白名单 ---------------- */

  _settings() {
    if (!this.store) return null;
    const s = this.store.settings;
    if (!s.remote || typeof s.remote !== 'object') s.remote = { pairSecret: '', devices: [] };
    if (!Array.isArray(s.remote.devices)) s.remote.devices = [];
    return s.remote;
  }

  _loadCredentials() {
    const r = this._settings();
    if (!r) {
      if (!this.pairSecret) this.pairSecret = newPairSecret();
      return;
    }
    if (typeof r.pairSecret !== 'string' || !/^[0-9a-f]{48}$/.test(r.pairSecret)) {
      r.pairSecret = newPairSecret();
      this.store.save();
    }
    this.pairSecret = r.pairSecret;
  }

  _devices() { const r = this._settings(); return r ? r.devices : []; }

  _findDevice(token) {
    if (typeof token !== 'string' || !token) return null;
    return this._devices().find((d) => d && d.token === token) || null;
  }

  /** 手机首次扫码后用 pairSecret 换取长期设备令牌 */
  pair(pairSecret, name) {
    const r = this._settings();
    if (!r || !pairSecret || pairSecret !== this.pairSecret) {
      return { ok: false, error: '配对凭证不正确，请重新扫描电脑上的二维码' };
    }
    const devices = r.devices;
    const now = Date.now();
    const token = crypto.randomBytes(24).toString('hex');
    const id = crypto.randomBytes(8).toString('hex');
    const device = {
      id,
      name: String(name || '手机').slice(0, 24),
      token,
      createdAt: now,
      lastSeen: now,
    };
    devices.push(device);
    // 超出上限时踢掉最久没用的设备，避免白名单无限增长
    while (devices.length > MAX_DEVICES) {
      devices.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
      devices.shift();
    }
    this.store.save();
    return { ok: true, token, id, port: this.port, host: this.addr };
  }

  /** 只读设备列表（不含令牌） */
  listDevices() {
    return this._devices().map((d) => ({
      id: d.id, name: d.name || '手机',
      createdAt: d.createdAt || 0, lastSeen: d.lastSeen || 0,
    }));
  }

  revokeDevice(id) {
    const r = this._settings();
    if (!r) return { ok: false, error: '配置未就绪' };
    const before = r.devices.length;
    r.devices = r.devices.filter((d) => d.id !== id);
    if (r.devices.length === before) return { ok: false, error: '设备不存在' };
    this.store.save();
    return { ok: true, count: r.devices.length };
  }

  revokeAll() {
    const r = this._settings();
    if (!r) return { ok: false, error: '配置未就绪' };
    r.devices = [];
    this.store.save();
    return { ok: true, count: 0 };
  }

  /** 换二维码：只换配对凭证，已配对手机仍可用；想让所有手机失效请用 revokeAll */
  rotatePairing() {
    const r = this._settings();
    this.pairSecret = newPairSecret();
    if (r) { r.pairSecret = this.pairSecret; this.store.save(); }
    return this.info();
  }

  async start() {
    if (this.server) return this.info();
    this._loadCredentials();
    this._addresses = lanAddresses();
    this.addr = (this._addresses[0] && this._addresses[0].address) || '127.0.0.1';

    const self = this;
    const server = http.createServer((req, res) => {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return json(res, 400, { ok: false, error: 'bad request' }); }

      // 只接受局域网私网来源；公网/伪造成公网的地址直接拒绝
      if (!isLanAddress(req.socket.remoteAddress)) {
        return json(res, 403, { ok: false, error: '仅允许局域网访问' });
      }

      // 手机自动发现会跨域探测；简单请求 + 预检都放行，真正的指令仍需设备令牌
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        return res.end();
      }

      // PWA：桌面图标 / 全屏运行
      if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
        res.writeHead(200, {
          'Content-Type': 'application/manifest+json; charset=utf-8',
          'Content-Length': Buffer.byteLength(MANIFEST),
          'Cache-Control': 'no-store', ...CORS_HEADERS,
        });
        return res.end(MANIFEST);
      }
      if (req.method === 'GET' && url.pathname === '/icon.png') {
        const buf = Buffer.from(ICON_PNG_BASE64, 'base64');
        res.writeHead(200, {
          'Content-Type': 'image/png', 'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=86400', ...CORS_HEADERS,
        });
        return res.end(buf);
      }

      // 遥控页面
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = self.pageHtml || '<!doctype html><meta charset="utf-8"><title>LaunchPlay</title><p>遥控页面资源缺失</p>';
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(html),
        });
        return res.end(html);
      }

      // 健康检查：手机进来先探一下，回显授权状态、是否有新程序被打开、启动台是否在前台
      if (req.method === 'GET' && url.pathname === '/ping') {
        let front = false;
        let config = {};
        try { front = self.frontProvider ? !!self.frontProvider() : false; } catch { /* ignore */ }
        try { config = self.configProvider ? self.configProvider() : {}; } catch { /* ignore */ }
        const token = String(url.searchParams.get('t') || '');
        return json(res, 200, {
          ok: true, app: 'LaunchPlay', running: true,
          authorized: !!self._findDevice(token),
          launchSeq: self.launchSeq, front,
          ...(config && typeof config === 'object' ? config : {}),
        });
      }

      // 首次配对：用二维码里的 pairSecret 换长期设备令牌
      if (req.method === 'POST' && url.pathname === '/pair') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; if (raw.length > 4096) req.destroy(); });
        req.on('end', () => {
          let payload = {};
          try { payload = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
          const secret = String(payload.p || url.searchParams.get('p') || '');
          const name = String(payload.name || '');
          const result = self.pair(secret, name);
          return json(res, result.ok ? 200 : 403, result);
        });
        return;
      }

      // 指令入口
      if (req.method === 'POST' && url.pathname === '/cmd') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 8192) req.destroy(); // 防止异常大包
        });
        req.on('end', async () => {
          let payload = {};
          try { payload = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
          const token = String(payload.t || url.searchParams.get('t') || '');
          const device = self._findDevice(token);
          if (!device) return json(res, 403, { ok: false, error: '设备已被撤销，请重新扫码配对' });
          const action = String(payload.action || '');
          if (!ALLOWED.has(action)) return json(res, 400, { ok: false, error: '未知指令' });
          const params = PARAM_ACTIONS.has(action) ? sanitizeParams(action, payload) : {};
          if (params === null) return json(res, 400, { ok: false, error: '指令参数不合法' });
          try {
            device.lastSeen = Date.now();
            self.store.save();
            const result = await self.onAction(action, params);
            return json(res, 200, { ok: true, action, ...(result && typeof result === 'object' ? result : {}) });
          } catch (e) {
            return json(res, 500, { ok: false, error: (e && e.message) || '执行失败' });
          }
        });
        return;
      }

      return json(res, 404, { ok: false, error: 'not found' });
    });

    // 绑定所有网卡，但上面按来源 IP 过滤，只允许局域网私网地址
    await new Promise((resolve, reject) => {
      const onError = (e) => { server.removeListener('listening', onOk); reject(e); };
      const onOk = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onOk);
      server.listen(this.port, '0.0.0.0');
    });
    this.server = server;
    this.port = server.address().port;
    return this.info();
  }

  stop() {
    if (!this.server) return { running: false };
    try { this.server.close(); } catch { /* ignore */ }
    this.server = null;
    return { running: false };
  }

  /** 兼容旧调用：换二维码（不撤销已配对设备） */
  rotateToken() { return this.rotatePairing(); }

  info() {
    if (!this.server) return { running: false };
    const base = `http://${this.addr}:${this.port}`;
    const url = `${base}/?p=${this.pairSecret}`;
    const qr = generateQr(url);
    return {
      running: true,
      url,
      base,
      pairSecret: this.pairSecret,
      token: this.pairSecret, // 旧字段保留，供旧版 UI 读取
      deviceCount: this.listDevices().length,
      address: this.addr,
      addresses: this._addresses.map((a) => a.address),
      port: this.port,
      qrSvg: qr.svg,
    };
  }
}

module.exports = {
  RemoteService, lanAddresses, newPairSecret, isLanAddress,
  ALLOWED, DEFAULT_PORT, DISCOVERY_PORT: 18766,
};
