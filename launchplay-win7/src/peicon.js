'use strict';
/**
 * peicon.js —— 从 Windows PE 可执行文件中提取最高分辨率图标的纯 JS 实现
 *
 * 为什么不用 Electron 的 app.getFileIcon()？
 *   它最高只返回 32x32, 在 96~128px 的磁贴上会明显发虚。
 *   这里直接解析 PE 资源段里的 RT_GROUP_ICON / RT_ICON, 可以拿到 256x256 的 PNG 图标。
 *
 * 性能要点:
 *   绝不把整个 exe 读进内存(安装包里的 exe 动辄上百 MB), 而是只读文件头 + 资源目录 +
 *   需要的那一小块图标数据。单个图标解析通常在 1ms 量级。
 *
 * 依赖: 仅 Node 内置 zlib + fs, 零第三方库, 便于控制打包体积。
 */

const fs = require('fs');
const zlib = require('zlib');

/* ============================ PNG 编码 ============================ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** rgba: Buffer(width*height*4) ——> PNG Buffer */
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ============================ DIB 解码 ============================ */

/**
 * 解码 ICONIMAGE 里的 DIB 数据为 RGBA。
 * 结构: BITMAPINFOHEADER(或扩展版) + 调色板 + XOR 像素数据 + AND 掩码
 */
function decodeDIB(buf) {
  if (buf.length < 40) return null;
  const biSize = buf.readUInt32LE(0);
  const width = buf.readInt32LE(4);
  const heightRaw = buf.readInt32LE(8);
  const bitCount = buf.readUInt16LE(14);
  const compression = buf.readUInt32LE(16);
  const clrUsed = buf.readUInt32LE(32);

  if (compression !== 0) return null;       // 不支持 BI_BITFIELDS 等压缩
  if (width <= 0 || width > 1024) return null;

  const topDown = heightRaw < 0;
  const height = Math.abs(heightRaw) / 2;   // DIB 高度含 AND 掩码, 故为实际高度 x2
  if (!Number.isFinite(height) || height <= 0 || height > 1024) return null;

  const paletteCount = clrUsed || (bitCount <= 8 ? 1 << bitCount : 0);
  const paletteOff = biSize;
  const xorOff = paletteOff + paletteCount * 4;
  const xorRow = Math.floor((width * bitCount + 31) / 32) * 4;
  const andRow = Math.floor((width + 31) / 32) * 4; // 1bpp, 4 字节对齐
  const andOff = xorOff + xorRow * height;

  if (xorOff + xorRow * height > buf.length) return null;

  const rgba = Buffer.alloc(width * height * 4);
  let alphaAllZero = true;

  for (let y = 0; y < height; y++) {
    const srcY = topDown ? y : height - 1 - y; // DIB 默认自下而上
    const rowStart = xorOff + srcY * xorRow;
    const dstStart = y * width * 4;

    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 255;

      if (bitCount === 32) {
        const p = rowStart + x * 4;
        b = buf[p]; g = buf[p + 1]; r = buf[p + 2]; a = buf[p + 3];
      } else if (bitCount === 24) {
        const p = rowStart + x * 3;
        b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
      } else if (bitCount === 8) {
        const p = paletteOff + buf[rowStart + x] * 4;
        b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
      } else if (bitCount === 4) {
        const byte = buf[rowStart + ((x / 2) | 0)];
        const idx = x % 2 === 0 ? byte >> 4 : byte & 0x0f;
        const p = paletteOff + idx * 4;
        b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
      } else if (bitCount === 1) {
        const byte = buf[rowStart + (x >> 3)];
        const idx = (byte >> (7 - (x & 7))) & 1;
        const p = paletteOff + idx * 4;
        b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
      } else {
        return null;
      }

      if (a !== 0) alphaAllZero = false;

      const d = dstStart + x * 4;
      rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b; rgba[d + 3] = a;
    }
  }

  // 老图标常见 32bpp 但 alpha 全 0 / 24bpp 无 alpha —— 用 AND 掩码补齐(掩码位=1 表示透明)
  if (alphaAllZero || bitCount <= 24) {
    if (andOff + andRow * height <= buf.length) {
      for (let y = 0; y < height; y++) {
        const srcY = topDown ? y : height - 1 - y;
        const rowStart = andOff + srcY * andRow;
        for (let x = 0; x < width; x++) {
          const transparent = (buf[rowStart + (x >> 3)] >> (7 - (x & 7))) & 1;
          const i = y * width * 4 + x * 4 + 3;
          if (transparent) rgba[i] = 0;
          else if (bitCount <= 24) rgba[i] = 255;
        }
      }
    } else if (alphaAllZero) {
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    }
  }

  return { width, height, rgba };
}

/* ============================ PE 结构读取 ============================ */

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

class PeFile {
  constructor(filePath) {
    this.fd = fs.openSync(filePath, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.sections = [];
    this.resBase = 0;   // 资源目录在文件中的偏移
    this.resSize = 0;
    this.tree = null;   // 资源目录缓冲区([resBase, resBase+tree.length))
    this.header = null;
  }

  readAt(off, len) {
    if (off < 0) return Buffer.alloc(0);
    const n = Math.max(0, Math.min(len, this.size - off));
    if (n <= 0) return Buffer.alloc(0);
    const b = Buffer.allocUnsafe(n);
    const got = fs.readSync(this.fd, b, 0, n, off);
    return got === n ? b : b.subarray(0, got);
  }

  close() {
    try { fs.closeSync(this.fd); } catch { /* ignore */ }
  }

  rvaToOff(rva) {
    for (const s of this.sections) {
      const size = Math.max(s.virtSize, s.rawSize);
      if (rva >= s.virtAddr && rva < s.virtAddr + size) return rva - s.virtAddr + s.rawPtr;
    }
    return -1;
  }

  parseHeaders() {
    const dos = this.readAt(0, 0x40);
    if (dos.length < 0x40 || dos[0] !== 0x4d || dos[1] !== 0x5a) return false; // "MZ"
    const peOff = dos.readUInt32LE(0x3c);
    if (peOff <= 0 || peOff + 24 > this.size) return false;

    const head = this.readAt(peOff, 0x200);
    if (head.length < 24 || head.readUInt32LE(0) !== 0x00004550) return false; // "PE\0\0"

    const numSections = head.readUInt16LE(6);
    const optSize = head.readUInt16LE(20);
    const opt = 24;                                  // IMAGE_OPTIONAL_HEADER 在 head 内的偏移
    const total = opt + optSize + 40 * numSections;
    if (numSections <= 0 || numSections > 96 || total > this.size) return false;

    // 一次读全: 可选头 + 节表
    const pe = total > head.length ? this.readAt(peOff, total) : head;
    if (pe.length < opt + 4) return false;

    const magic = pe.readUInt16LE(opt);
    const pe32plus = magic === 0x20b;
    if (!pe32plus && magic !== 0x10b) return false;
    const dataDirOff = opt + (pe32plus ? 112 : 96);

    const resRva = pe.readUInt32LE(dataDirOff + 2 * 8);
    const resSize = pe.readUInt32LE(dataDirOff + 2 * 8 + 4);
    if (!resRva || !resSize) return false;

    const secOff = opt + optSize;
    for (let i = 0; i < numSections; i++) {
      const s = secOff + i * 40;
      if (s + 40 > pe.length) break;
      this.sections.push({
        virtSize: pe.readUInt32LE(s + 8),
        virtAddr: pe.readUInt32LE(s + 12),
        rawSize: pe.readUInt32LE(s + 16),
        rawPtr: pe.readUInt32LE(s + 20),
      });
    }

    const resOff = this.rvaToOff(resRva);
    if (resOff < 0) return false;
    this.resBase = resOff;
    this.resSize = resSize;
    // 目录树通常很小, 先取 64KB; 不够时按需扩容
    this.tree = this.readAt(resOff, Math.min(resSize, 64 * 1024));
    return this.tree.length > 0;
  }

  /** 扩容资源目录缓冲区, 保证 off+len 落在 tree 内 */
  ensureTree(off, len) {
    if (off < 0) return false;
    if (off + len <= this.tree.length) return true;
    const want = Math.min(this.resSize, Math.max(off + len + 64, this.tree.length * 2));
    const nb = this.readAt(this.resBase, want);
    if (nb.length < off + len) return false;
    this.tree = nb;
    return true;
  }

  /** 列出一个资源目录的子项 */
  listDir(dirOff) {
    if (!this.ensureTree(dirOff, 16)) return [];
    const t = this.tree;
    const named = t.readUInt16LE(dirOff + 12);
    const ids = t.readUInt16LE(dirOff + 14);
    const total = named + ids;
    if (total <= 0 || total > 4096) return [];
    if (!this.ensureTree(dirOff + 16, total * 8)) return [];
    const t2 = this.tree;
    const out = [];
    for (let i = 0; i < total; i++) {
      const e = dirOff + 16 + i * 8;
      const nameField = t2.readUInt32LE(e);
      const dataField = t2.readUInt32LE(e + 4);
      out.push({
        named: (nameField & 0x80000000) !== 0,
        id: nameField & 0xffff,
        isDir: (dataField & 0x80000000) !== 0,
        child: dataField & 0x7fffffff,
      });
    }
    return out;
  }

  /** 读取 IMAGE_RESOURCE_DATA_ENTRY 指向的数据 */
  readDataEntry(entryOff) {
    if (!this.ensureTree(entryOff, 16)) return null;
    const rva = this.tree.readUInt32LE(entryOff);
    const size = this.tree.readUInt32LE(entryOff + 4);
    if (!size || size > 8 * 1024 * 1024) return null;
    const off = this.rvaToOff(rva);
    if (off < 0) return null;
    const buf = this.readAt(off, size);
    return buf.length ? buf : null;
  }

  /** 取某个资源类型目录下的全部条目 */
  typeEntries(typeId) {
    const types = this.listDir(0);
    const t = types.find((e) => !e.named && e.id === typeId && e.isDir);
    if (!t) return [];
    return this.listDir(t.child);
  }

  /** 由"名称/ID 层的子目录"继续下钻到语言层, 读出数据 */
  readByNameChild(childOff) {
    const langs = this.listDir(childOff);
    const leaf = langs.find((e) => !e.isDir) || langs[0];
    if (!leaf) return null;
    return this.readDataEntry(leaf.child);
  }

  /** 按数字 ID 取图标数据(RT_ICON 的 ID 一定是数字) */
  readIconData(id) {
    const hit = this.typeEntries(RT_ICON).find((e) => !e.named && e.id === id && e.isDir);
    if (!hit) return null;
    return this.readByNameChild(hit.child);
  }
}

/** 从 PE 文件中挑选并解码最优图标, 返回 PNG Buffer */
function extractFromPE(filePath) {
  const pe = new PeFile(filePath);
  try {
    if (!pe.parseHeaders()) return null;

    // 图标组既可能是数字 ID(1..N), 也可能是命名资源(如 MAINICON), 这里按条目遍历
    const groupEntries = pe.typeEntries(RT_GROUP_ICON);
    if (!groupEntries.length) return null;

    const entries = [];
    for (const ge of groupEntries.slice(0, 16)) {
      if (!ge.isDir) continue;
      const g = pe.readByNameChild(ge.child);
      if (!g || g.length < 6) continue;
      const count = g.readUInt16LE(4);
      if (!count || count > 64) continue;
      for (let i = 0; i < count; i++) {
        const e = 6 + i * 14;
        if (e + 14 > g.length) break;
        entries.push({
          w: g[e] === 0 ? 256 : g[e],
          h: g[e + 1] === 0 ? 256 : g[e + 1],
          bitCount: g.readUInt16LE(e + 6),
          id: g.readUInt16LE(e + 12),
        });
      }
    }
    if (!entries.length) return null;

    entries.sort((a, b) => b.w * b.h - a.w * a.h || b.bitCount - a.bitCount);

    for (const ent of entries) {
      const data = pe.readIconData(ent.id);
      if (!data || data.length < 8) continue;
      if (data.readUInt32BE(0) === 0x89504e47) return data; // PNG 压缩图标, 直接用
      const dib = decodeDIB(data);
      if (dib) return encodePNG(dib.width, dib.height, dib.rgba);
    }
    return null;
  } catch {
    return null;
  } finally {
    pe.close();
  }
}

/** 从 .ico 文件里取最大图像 */
function extractFromICO(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch { return null; }
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const count = buf.readUInt16LE(4);
  const items = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (e + 16 > buf.length) break;
    items.push({
      w: buf[e] === 0 ? 256 : buf[e],
      h: buf[e + 1] === 0 ? 256 : buf[e + 1],
      size: buf.readUInt32LE(e + 8),
      off: buf.readUInt32LE(e + 12),
    });
  }
  items.sort((a, b) => b.w * b.h - a.w * a.h);
  for (const it of items) {
    if (it.off + it.size > buf.length) continue;
    const data = buf.slice(it.off, it.off + it.size);
    if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) return data;
    const dib = decodeDIB(data);
    if (dib) return encodePNG(dib.width, dib.height, dib.rgba);
  }
  return null;
}

/**
 * 对外主入口: 任意可执行文件 / 图标文件 -> PNG Buffer
 * 失败返回 null (调用方自行回退)
 */
function iconToPNG(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size < 64) return null;

  const ext = filePath.toLowerCase().split('.').pop();
  if (ext === 'ico') return extractFromICO(filePath) || extractFromPE(filePath);
  return extractFromPE(filePath);
}

module.exports = { iconToPNG, encodePNG, decodeDIB, PeFile };
