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
]);

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
  }

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

      // 健康检查：手机进来先探一下，顺便回显 token 是否还有效
      if (req.method === 'GET' && url.pathname === '/ping') {
        return json(res, 200, { ok: true, app: 'LaunchPlay', running: true });
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
          try {
            const result = await self.onAction(action);
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
