'use strict';
/**
 * discovery.js —— 手机遥控的轻量局域网发现（主进程）
 *
 * 设计要点：
 *   1. 只用 Node 内置 dgram，零第三方依赖；Electron 22 / Win7 可直接运行。
 *   2. UDP 仅用于「电脑向局域网广播自己」以及「回答主动查询」。
 *      手机浏览器不能收发 UDP，所以手机真正的发现走 HTTP 网段探测（见 remote.html）；
 *      这里的广播主要让同一 WiFi 里的其它客户端/未来原生 App 能找到电脑。
 *   3. 广播失败（防火墙拦截、Win7 网卡禁用广播）不会影响 HTTP 遥控服务，
 *      所有异常都吞掉并只打日志，服务照常可用。
 */

const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 18766;
const MAGIC = 'launchplay-discover-v1';

/** 列出本机所有网卡的定向广播地址（含全局广播），Win7 上比只发 255.255.255.255 更可靠 */
function broadcastTargets() {
  const out = ['255.255.255.255'];
  const ifaces = os.networkInterfaces() || {};
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      if (!a.netmask || /^169\.254\./.test(a.address)) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4 || ip.some(isNaN) || mask.some(isNaN)) continue;
      const bc = ip.map((v, i) => (v | (~mask[i] & 255)) >>> 0).join('.');
      if (out.indexOf(bc) === -1) out.push(bc);
    }
  }
  return out;
}

class DiscoveryService {
  /**
   * @param {() => object} infoProvider 返回 { port, host, name } 的回调
   */
  constructor(infoProvider) {
    this.infoProvider = typeof infoProvider === 'function' ? infoProvider : () => ({});
    this.socket = null;
    this.timer = null;
    this.targets = broadcastTargets();
  }

  get running() { return !!this.socket; }

  start() {
    if (this.socket) return;
    let socket;
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (e) {
      console.warn('[discovery] 无法创建 UDP socket，跳过广播:', e && e.message);
      return;
    }
    this.socket = socket;
    socket.on('error', (e) => {
      // Win7 防火墙/网卡可能拒绝广播；不能让它冒泡把主进程搞崩
      console.warn('[discovery] UDP 错误:', e && e.message);
    });
    socket.on('message', (msg, rinfo) => {
      try {
        const text = msg.toString('utf8');
        let query = null;
        try { query = JSON.parse(text); } catch { /* 兼容纯文本 magic */ }
        const isQuery = (query && query.q === MAGIC) || text === MAGIC;
        if (!isQuery) return;
        const info = this.infoProvider() || {};
        const reply = Buffer.from(JSON.stringify({
          a: MAGIC, app: 'LaunchPlay',
          name: info.name || '影游快启',
          host: info.host || '', port: info.port || 18765,
        }), 'utf8');
        try { socket.send(reply, 0, reply.length, rinfo.port, rinfo.address); } catch { /* ignore */ }
      } catch { /* ignore */ }
    });
    try {
      socket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
        try { socket.setBroadcast(true); } catch { /* ignore */ }
        this.beacon();
        this.timer = setInterval(() => this.beacon(), 5000);
        if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
      });
    } catch (e) {
      console.warn('[discovery] UDP 绑定失败，跳过广播:', e && e.message);
      this.stop();
    }
  }

  beacon() {
    if (!this.socket) return;
    const info = this.infoProvider() || {};
    const packet = Buffer.from(JSON.stringify({
      a: MAGIC, app: 'LaunchPlay', t: 'beacon',
      name: info.name || '影游快启',
      host: info.host || '', port: info.port || 18765,
    }), 'utf8');
    for (const target of this.targets) {
      try { this.socket.send(packet, 0, packet.length, DISCOVERY_PORT, target); }
      catch { /* 单块网卡失败不影响其它网卡 */ }
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }
}

module.exports = { DiscoveryService, DISCOVERY_PORT, MAGIC, broadcastTargets };
