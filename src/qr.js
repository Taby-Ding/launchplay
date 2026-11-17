'use strict';
/**
 * qr.js —— 极简二维码生成器（byte 模式 / 纠错级别 M / 版本 1~40）
 *
 * 为什么自己写而不装 qrcode 依赖：
 *   遥控功能只需要编码一个短网址，自己实现 200 行纯 JS 即可，
 *   不往安装包里塞第三方库，也不给 CI 增加 npm 下载负担。
 *
 * 算法参考 Nayuki's QR Code generator（MIT 许可）的标准实现，
 * 这里按本项目需要裁剪：只支持 byte 模式、固定纠错级别 M。
 */

/* 纠错级别 M 的表：每个版本「每块纠错码字数」与「分块数」，索引 0 占位 */
const ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
  30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const NUM_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
  5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
  31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

/** GF(256) 乘法，本原多项式 0x11D */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Reed-Solomon 生成多项式 */
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

/** Reed-Solomon 余数（纠错码字） */
function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

/** 原始(data + ecc)模块数 */
function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    result -= (25 * n - 10) * n - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
}

function pushBits(bits, val, len) {
  for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
}

/** 数据编码 + 纠错 + 交织，返回最终码字流 */
function encodeData(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  let ver = 0;
  for (let v = 1; v <= 40; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const capBits = dataCodewords(v) * 8;
    if (4 + countBits + bytes.length * 8 <= capBits) { ver = v; break; }
  }
  if (!ver) throw new Error('二维码内容过长');

  const countBits = ver <= 9 ? 8 : 16;
  const dataCw = dataCodewords(ver);
  const bits = [];
  pushBits(bits, 0b0100, 4);          // byte 模式
  pushBits(bits, bytes.length, countBits);
  for (const b of bytes) pushBits(bits, b, 8);

  const capBits = dataCw * 8;
  pushBits(bits, 0, Math.min(4, capBits - bits.length));               // 终止符
  pushBits(bits, 0, (8 - (bits.length % 8)) % 8);                      // 补到字节边界

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  for (let pad = 0; data.length < dataCw; pad++) data.push(pad % 2 === 0 ? 0xec : 0x11);

  // 纠错 + 交织
  const numBlocks = NUM_BLOCKS[ver];
  const blockEcc = ECC_PER_BLOCK[ver];
  const rawCw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCw % numBlocks);
  const shortLen = Math.floor(rawCw / numBlocks);
  const shortData = shortLen - blockEcc;
  const divisor = rsDivisor(blockEcc);
  const blocks = [];
  let k = 0;
  for (let j = 0; j < numBlocks; j++) {
    const dataLen = j < numShort ? shortData : shortData + 1;
    const chunk = data.slice(k, k + dataLen);
    k += dataLen;
    const ecc = rsRemainder(chunk, divisor);
    const block = chunk.slice();
    if (j < numShort) block.push(0); // 短块占位，交织时跳过，使纠错码对齐
    block.push(...ecc);
    blocks.push(block);
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (j < numShort && i === shortData) continue;
      out.push(blocks[j][i]);
    }
  }
  return { version: ver, codewords: Uint8Array.from(out) };
}

function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const num = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + num * 2 + 1) / (num * 2 - 2)) * 2;
  const result = [6];
  let pos = size - 7;
  for (let i = num - 1; i >= 1; i--) { result[i] = pos; pos -= step; }
  return result;
}

function applyMask(m, fn, mask, size) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (fn[y][x]) continue;
      let inv = false;
      switch (mask) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (inv) m[y][x] = !m[y][x];
    }
  }
}

function addRunHistory(hist, run) {
  if (run < 5) return;
  if (run > 10) hist[6]++;
  else hist[run]++;
}

/** 掩码惩罚分，越低越好（ISO 标准四项规则） */
function penalty(m, size) {
  let result = 0;
  for (let i = 0; i < size; i++) {
    // 列
    let color = false; let run = 0; const h1 = [0, 0, 0, 0, 0, 0, 0];
    for (let j = 0; j < size; j++) {
      if (m[j][i] === color) {
        run++;
        if (run === 5) result += 3; else if (run > 5) result++;
      } else { addRunHistory(h1, run); color = m[j][i]; run = 1; }
    }
    addRunHistory(h1, run); result += h1[5] + h1[6];
    // 行
    color = false; run = 0; const h2 = [0, 0, 0, 0, 0, 0, 0];
    for (let j = 0; j < size; j++) {
      if (m[i][j] === color) {
        run++;
        if (run === 5) result += 3; else if (run > 5) result++;
      } else { addRunHistory(h2, run); color = m[i][j]; run = 1; }
    }
    addRunHistory(h2, run); result += h2[5] + h2[6];
  }
  // 2×2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
    }
  }
  // 类定位图形 1:1:3:1:1
  for (let i = 0; i < size; i++) {
    for (const vertical of [true, false]) {
      let bits = 0;
      for (let j = 0; j < size; j++) {
        const v = vertical ? m[j][i] : m[i][j];
        bits = ((bits << 1) & 0x7ff) | (v ? 1 : 0);
        if (j >= 10 && (bits === 0x05d || bits === 0x5d0)) result += 40;
      }
    }
  }
  // 黑白比例
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += Math.max(0, k) * 10;
  return result;
}

/** 画格式信息（纠错级别 M 的 formatBits = 0，所以 data = mask） */
function drawFormat(mask, size, set) {
  const data = mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // 固定黑点
}

/** 画版本信息（版本 ≥ 7 才有） */
function drawVersion(ver, size, setF) {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const b = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const c = Math.floor(i / 3);
    setF(a, c, b); setF(c, a, b);
  }
}

function buildMatrix(ver, codewords) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x, y, black) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    m[y][x] = !!black; fn[y][x] = true;
  };

  // 定位图形
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setF(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }
  // 对齐图形
  const pos = alignmentPositions(ver, size);
  for (const ax of pos) {
    for (const ay of pos) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setF(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // 定时图形
  for (let i = 0; i < size; i++) {
    if (!fn[6][i]) setF(i, 6, i % 2 === 0);
    if (!fn[i][6]) setF(6, i, i % 2 === 0);
  }
  drawVersion(ver, size, setF);
  drawFormat(0, size, setF); // 占位，掩码选定后重画

  // 数据位按 Z 字形填入
  let i = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < total) {
          m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  // 挑掩码
  let best = 0; let bestScore = Infinity;
  const rawSet = (x, y, b) => { m[y][x] = !!b; };
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, fn, mask, size);
    drawFormat(mask, size, rawSet);
    const score = penalty(m, size);
    if (score < bestScore) { bestScore = score; best = mask; }
    applyMask(m, fn, mask, size); // 异或自逆，撤销
  }
  applyMask(m, fn, best, size);
  drawFormat(best, size, rawSet);
  return m;
}

function matrixToSvg(m, scale = 6, margin = 4) {
  const size = m.length;
  const dim = size + margin * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim * scale}" height="${dim * scale}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`;
}

/** 对外：生成二维码，返回矩阵与 SVG */
function generateQr(text) {
  const encoded = encodeData(text);
  const matrix = buildMatrix(encoded.version, encoded.codewords);
  return {
    version: encoded.version,
    matrix,
    svg: matrixToSvg(matrix),
  };
}

module.exports = { generateQr };
