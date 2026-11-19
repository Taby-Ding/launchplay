'use strict';
/** 手机遥控长期配对 / 设备白名单 / 发现服务的本地端到端验证（不需要 Electron） */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Store } = require('../src/store');
const { RemoteService, isLanAddress } = require('../src/remote');
const { DiscoveryService } = require('../src/discovery');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-pair-test-'));
const store = new Store(dir);
const calls = [];
const remote = new RemoteService((action, params) => { calls.push({ action, params }); return { done: true }; });
remote.setStore(store);
remote.setPage('<!doctype html><title>ok</title>');
remote.setConfigProvider(() => ({ customKeys: [{ name: '测试键', index: 0, has: true }] }));

function req(method, pathname, body) {
  const data = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: remote.port, path: pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(raw || '{}'); } catch { /* 图片/PWA 资源不是 JSON */ }
        resolve({ status: res.statusCode, j, headers: res.headers, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  assert.match(store.data.version.toString(), /^9$/, 'schema 应升级到 9');
  assert.match(store.settings.remote.pairSecret, /^[0-9a-f]{48}$/, '配对凭证应落盘且为 48 位十六进制');

  const info = await remote.start();
  assert(info.running && info.url.includes('?p=' + store.settings.remote.pairSecret), '二维码应带固定凭证');
  assert(info.qrSvg.includes('<svg'), '二维码 SVG 应生成');
  console.log('OK 1/9 服务启动 + 固定凭证二维码');

  let res = await req('GET', '/ping');
  assert.strictEqual(res.j.authorized, false, '无令牌时不应授权');
  assert.strictEqual(res.j.launchSeq, 0);
  console.log('OK 2/9 /ping 授权状态');

  res = await req('POST', '/pair', { p: 'bad-secret', name: '坏手机' });
  assert.strictEqual(res.status, 403, '错误凭证应拒绝配对');
  console.log('OK 3/9 错误凭证拒绝配对');

  res = await req('POST', '/pair', { p: store.settings.remote.pairSecret, name: '客厅手机' });
  assert.strictEqual(res.status, 200);
  assert(res.j.token && res.j.id, '应返回设备令牌');
  const token = res.j.token;
  const id = res.j.id;
  console.log('OK 4/9 首次配对换取长期令牌');

  res = await req('POST', '/cmd', { t: token, action: 'toggle' });
  assert(res.j.ok && calls.length === 1 && calls[0].action === 'toggle', '合法令牌应能发指令');
  res = await req('POST', '/cmd', { t: 'wrong', action: 'toggle' });
  assert.strictEqual(res.status, 403, '非法令牌应拒绝');
  console.log('OK 5/9 指令按白名单校验');

  res = await req('GET', '/ping?t=' + token);
  assert.strictEqual(res.j.authorized, true);
  assert(res.j.customKeys && res.j.customKeys.length === 1, '万能键配置应随 ping 下发');
  console.log('OK 6/9 已配对设备保持授权');

  assert.strictEqual(remote.revokeDevice(id).ok, true);
  res = await req('POST', '/cmd', { t: token, action: 'toggle' });
  assert.strictEqual(res.status, 403, '撤销后旧令牌应立即失效');
  console.log('OK 7/9 撤销设备即时生效');

  const oldSecret = store.settings.remote.pairSecret;
  const rotated = remote.rotatePairing();
  assert.notStrictEqual(rotated.pairSecret, oldSecret, '换二维码应换凭证');
  res = await req('POST', '/pair', { p: oldSecret, name: '旧码' });
  assert.strictEqual(res.status, 403, '旧配对凭证应失效');
  res = await req('POST', '/pair', { p: rotated.pairSecret, name: '新手机' });
  assert.strictEqual(res.status, 200, '新凭证应能配对');
  console.log('OK 8/9 换凭证 + 撤销全部');

  assert.strictEqual(remote.revokeAll().ok, true);
  assert.strictEqual(store.settings.remote.devices.length, 0);
  res = await req('GET', '/manifest.webmanifest');
  assert.strictEqual(res.status, 200);
  res = await req('GET', '/icon.png');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['access-control-allow-origin'], '*', '应允许跨域探测');
  assert.strictEqual(isLanAddress('192.168.1.5'), true);
  assert.strictEqual(isLanAddress('8.8.8.8'), false);
  console.log('OK 9/9 撤销全部 + PWA 资源 + 局域网限制');

  const discovery = new DiscoveryService(() => ({ host: '192.168.1.5', port: remote.port, name: '影游快启' }));
  discovery.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(discovery.running, true, 'UDP 发现模块应能启动');
  discovery.stop();
  assert.strictEqual(discovery.running, false);
  console.log('OK 10/10 Win7 兼容的 UDP 发现模块可启停');

  remote.stop();
  store.flush();
  const reloaded = new Store(dir);
  assert.strictEqual(reloaded.settings.remote.pairSecret, store.settings.remote.pairSecret, '凭证重启后应保持');
  console.log('OK 重启后凭证保持不变');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nALL PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
