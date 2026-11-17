'use strict';
/**
 * remote.js —— 手机遥控的局域网服务（主进程）
 *
 * 设计要点：
 *   1. 用 Node 内置 http，零第三方依赖；只监听局域网网卡，不监听公网。
 *   2. 每次开启生成 6 位配对码，写进二维码网址；手机每条指令都要带上，
 *      校验不过直接拒绝——避免同一 WiFi 下其他人误连。
 *   3. 服务默认关闭，设置里点"开启手机遥控"才启动；关掉窗口即停。
 *   4. HTTP 只传指令（几个字节），不传图片/视频，局域网里几乎不占带宽。
 *
 * 指令通过 onAction(action) 回调交给主进程执行；这里不碰 Electron API，
 * 便于单独跑单元测试。
 */

const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { generateQr } = require('./qr');

const DEFAULT_PORT = 18765;

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
]);

/** 需要携带参数的指令；其余指令忽略 payload，避免夹带 */
const PARAM_ACTIONS = new Set(['mmove', 'mwheel', 'type', 'key']);

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

function newToken() {
  // crypto.randomInt 避免取模偏置；补足 6 位
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // 遥控页由本地服务提供，允许同源 fetch；不需要宽松 CORS
  });
  res.end(body);
}

/**
 * @param {(action: string) => (Promise<any>|any)} onAction 收到合法指令时的回调
 */
class RemoteService {
  constructor(onAction) {
    this.onAction = onAction;
    this.server = null;
    this.token = '';
    this.port = DEFAULT_PORT;
    this.addr = '';
    this._addresses = [];
    // 启动计数器：每当启动台打开一个程序就 +1，手机页检测到变化后自动跳到播放遥控卡片
    this.launchSeq = 0;
    // 启动台是否在前台的状态提供者（由主进程注入，remote.js 本身不依赖 Electron）
    this.frontProvider = null;
  }

  /** 通知手机页"有新程序被打开"（由主进程 afterLaunch 调用） */
  notifyLaunch() { this.launchSeq++; }

  /** 注入"启动台是否在前台"的查询函数，供 /ping 回显给手机页 */
  setFrontProvider(fn) { this.frontProvider = typeof fn === 'function' ? fn : null; }

  get running() { return !!this.server; }

  /** 页面 HTML 由外部注入（放在 renderer/remote.html），避免 here 里堆一大段字符串 */
  setPage(html) { this.pageHtml = String(html || ''); }

  async start() {
    if (this.server) return this.info();
    this.token = newToken();
    this._addresses = lanAddresses();
    this.addr = (this._addresses[0] && this._addresses[0].address) || '127.0.0.1';

    const self = this;
    const server = http.createServer((req, res) => {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return json(res, 400, { ok: false, error: 'bad request' }); }

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

      // 健康检查：手机进来先探一下，回显 token 是否有效、是否有新程序被打开、启动台是否在前台
      if (req.method === 'GET' && url.pathname === '/ping') {
        let front = false;
        try { front = self.frontProvider ? !!self.frontProvider() : false; } catch { /* ignore */ }
        return json(res, 200, { ok: true, app: 'LaunchPlay', running: true, launchSeq: self.launchSeq, front });
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
          const action = String(payload.action || '');
          if (token !== self.token) return json(res, 403, { ok: false, error: '配对码不正确' });
          if (!ALLOWED.has(action)) return json(res, 400, { ok: false, error: '未知指令' });
          const params = PARAM_ACTIONS.has(action) ? sanitizeParams(action, payload) : {};
          if (params === null) return json(res, 400, { ok: false, error: '指令参数不合法' });
          try {
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

    // 绑定局域网地址（0.0.0.0 表示所有本机网卡，仍是私有网段，非公网映射）
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
    this.token = '';
    return { running: false };
  }

  /** 换一个配对码（不重启服务），用于"重新生成二维码" */
  rotateToken() {
    if (!this.server) return null;
    this.token = newToken();
    return this.info();
  }

  info() {
    if (!this.server) return { running: false };
    const base = `http://${this.addr}:${this.port}`;
    const url = `${base}/?t=${this.token}`;
    const qr = generateQr(url);
    return {
      running: true,
      url,
      base,
      token: this.token,
      address: this.addr,
      addresses: this._addresses.map((a) => a.address),
      port: this.port,
      qrSvg: qr.svg,
    };
  }
}

module.exports = { RemoteService, lanAddresses, newToken, ALLOWED, DEFAULT_PORT };
