'use strict';
/** 生成微信收款码占位示意图（可替换为真实收款码） */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// 伪二维码点阵：给出一批固定坐标的方块，看起来像二维码但不可扫
let blocks = '';
let seed = 20261117;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
const cell = 16, gap = 3, origin = 56, cols = 15;
for (let y = 0; y < cols; y++) {
  for (let x = 0; x < cols; x++) {
    if (rnd() > 0.52) {
      const px = origin + x * (cell + gap);
      const py = origin + y * (cell + gap);
      blocks += `<rect x="${px}" y="${py}" width="${cell}" height="${cell}" rx="2" fill="#1a1a1a"/>`;
    }
  }
}
// 三个定位角（二维码的"回"字角）
function finder(fx, fy) {
  return `<rect x="${fx}" y="${fy}" width="52" height="52" rx="6" fill="none" stroke="#1a1a1a" stroke-width="12"/>
          <rect x="${fx+18}" y="${fy+18}" width="16" height="16" rx="3" fill="#1a1a1a"/>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="440" viewBox="0 0 360 440">
  <rect width="360" height="440" fill="#f7f7f7"/>
  <rect width="360" height="56" fill="#07c160"/>
  <text x="180" y="37" font-family="Microsoft YaHei, sans-serif" font-size="22" fill="#fff" text-anchor="middle" font-weight="bold">微信支付</text>
  <rect x="40" y="72" width="280" height="280" rx="10" fill="#fff"/>
  ${blocks}
  ${finder(48, 80)}${finder(264, 80)}${finder(48, 296)}
  <rect x="70" y="372" width="220" height="12" rx="6" fill="#d8d8d8"/>
  <rect x="100" y="396" width="160" height="10" rx="5" fill="#e6e6e6"/>
  <text x="180" y="430" font-family="Microsoft YaHei, sans-serif" font-size="13" fill="#b0b0b0" text-anchor="middle">占位示意图 · 请替换为真实收款码</text>
</svg>`;

sharp(Buffer.from(svg)).png().toFile(path.join(__dirname, '..', 'docs', 'wechat-qr.png')).then(() => {
  console.log('wechat-qr.png generated', fs.statSync(path.join(__dirname, '..', 'docs', 'wechat-qr.png')).size, 'bytes');
}).catch((e) => { console.error(e); process.exit(1); });
