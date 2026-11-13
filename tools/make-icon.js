// 生成应用图标 build/icon.ico —— 蓝青渐变圆角方块 + 2x2 磁贴, 4 倍超采样抗锯齿
const fs = require('fs');
const path = require('path');
const { encodePNG } = require('../src/peicon');

const SS = 4;            // 超采样倍数
const OUT = 256;         // 目标尺寸
const N = OUT * SS;

const canvas = new Float32Array(N * N * 4); // RGBA 0..1

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** 圆角矩形 SDF (中心式) */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function blend(i, r, g, b, a) {
  if (a <= 0) return;
  const dr = canvas[i], dg = canvas[i + 1], db = canvas[i + 2], da = canvas[i + 3];
  const na = a + da * (1 - a);
  if (na <= 0) { canvas[i] = canvas[i + 1] = canvas[i + 2] = canvas[i + 3] = 0; return; }
  canvas[i] = (r * a + dr * da * (1 - a)) / na;
  canvas[i + 1] = (g * a + dg * da * (1 - a)) / na;
  canvas[i + 2] = (b * a + db * da * (1 - a)) / na;
  canvas[i + 3] = na;
}

/** 以 SDF 覆盖率绘制一个圆角矩形 */
function drawRoundRect(cx, cy, hw, hh, r, colorAt) {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = sdRoundRect(x + 0.5, y + 0.5, cx, cy, hw, hh, r);
      const cov = clamp01(0.5 - d * SS / 2);
      if (cov <= 0) continue;
      const [r0, g0, b0, a0] = colorAt(x, y);
      blend((y * N + x) * 4, r0, g0, b0, a0 * cov);
    }
  }
}

const C = N / 2;
// 1) 底板: 圆角方块 + 对角渐变
drawRoundRect(C, C, C - 8 * SS, C - 8 * SS, 190 * SS / 4, (x, y) => {
  const t = (x / N) * 0.55 + (y / N) * 0.45;
  const r = (0.16 + (0.10 - 0.16) * t);
  const g = (0.45 + (0.72 - 0.45) * t);
  const b = (0.95 + (0.90 - 0.95) * t);
  return [r, g, b, 1];
});

// 2) 2x2 磁贴 (右下角一块做成半透明, 更像"启动台")
const pad = 56 * SS / 4;
const gap = 18 * SS / 4;
const cell = (N - pad * 2 - gap) / 2;
const tr = cell * 0.26;
const cells = [
  [pad + cell / 2, pad + cell / 2, 1],
  [pad + cell * 1.5 + gap, pad + cell / 2, 1],
  [pad + cell / 2, pad + cell * 1.5 + gap, 1],
  [pad + cell * 1.5 + gap, pad + cell * 1.5 + gap, 0.45],
];
for (const [cx, cy, alpha] of cells) {
  drawRoundRect(cx, cy, cell / 2, cell / 2, tr, () => [1, 1, 1, alpha]);
}

/* ---- 降采样 ---- */
function downsample(size) {
  const f = N / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < f; sy++) {
        for (let sx = 0; sx < f; sx++) {
          const i = ((y * f + sy) * N + (x * f + sx)) * 4;
          const al = canvas[i + 3];
          r += canvas[i] * al; g += canvas[i + 1] * al; b += canvas[i + 2] * al; a += al;
        }
      }
      const n = f * f;
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round((r / a) * 255);
        out[o + 1] = Math.round((g / a) * 255);
        out[o + 2] = Math.round((b / a) * 255);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/* ---- 写 ICO (经典 DIB 条目, 兼容性最好) ---- */
function dibFor(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);   // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);        // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // DIB 自下而上
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];      // B
      xor[d + 1] = rgba[s + 1];  // G
      xor[d + 2] = rgba[s];      // R
      xor[d + 3] = rgba[s + 3];  // A
    }
  }
  const andRow = Math.floor((size + 31) / 32) * 4;
  const and = Buffer.alloc(andRow * size, 0);
  return Buffer.concat([header, xor, and]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => dibFor(downsample(s), s));

const dir = Buffer.alloc(6 + images.length * 16);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(images.length, 4);
let offset = 6 + images.length * 16;
images.forEach((img, i) => {
  const e = 6 + i * 16;
  const s = sizes[i];
  dir[e] = s >= 256 ? 0 : s;
  dir[e + 1] = s >= 256 ? 0 : s;
  dir[e + 2] = 0;
  dir[e + 3] = 0;
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(img.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += img.length;
});

const ico = Buffer.concat([dir, ...images]);
const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
// 同时留一张 png 便于预览
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePNG(256, 256, downsample(256)));
console.log('icon.ico', (ico.length / 1024).toFixed(1) + 'KB', 'sizes:', sizes.join(','));
