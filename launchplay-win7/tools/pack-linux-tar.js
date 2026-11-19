'use strict';
/**
 * pack-linux-tar.js —— 给 Linux 产物打 tar.gz，并写入正确的文件权限
 *
 * 为什么不用现成的 tar：
 *   在 Windows 上打包时，NTFS 里没有 Unix 权限位，electron-builder 生成的
 *   tar.gz 会把所有文件都记成 0644 —— Linux 用户解压后 `./launchplay` 直接
 *   "Permission denied"，还可能因为 chrome-sandbox 没有执行位而启动失败。
 *   MSYS 的 tar 也只能整体加 `--mode`，没法区分可执行文件与资源文件。
 *
 * 所以这里按 ustar 格式自己写归档：目录 0755、可执行文件 0755、其余 0644。
 * 只依赖 zlib，不引入任何第三方包。
 *
 * 用法：
 *   node tools/pack-linux-tar.js <源目录> <输出.tar.gz> [包内根目录名]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');

const BLOCK = 512;

/** 这些文件在 Linux 上必须是可执行的 */
const EXECUTABLES = new Set([
  'launchplay',
  'LaunchPlay',
  'chrome-sandbox',
  'chrome_crashpad_handler',
]);

function isExecutable(relPath) {
  return EXECUTABLES.has(path.basename(relPath));
}

function octal(value, len) {
  // ustar 的长度字段是「宽度包含结尾 \0」的八进制
  const s = value.toString(8);
  return s.padStart(len - 1, '0') + '\0';
}

function writeString(buf, str, offset, len) {
  const b = Buffer.from(String(str), 'utf8');
  b.copy(buf, offset, 0, Math.min(b.length, len));
}

function header({ name, size, mode, mtime, type = '0', linkname = '' }) {
  const buf = Buffer.alloc(BLOCK, 0);
  writeString(buf, name, 0, 100);
  writeString(buf, octal(mode, 8), 100, 8);
  writeString(buf, octal(0, 8), 108, 8);        // uid
  writeString(buf, octal(0, 8), 116, 8);        // gid
  writeString(buf, octal(size, 12), 124, 12);
  writeString(buf, octal(mtime, 12), 136, 12);
  buf.write('        ', 148, 8, 'ascii');       // 校验和先填空格
  writeString(buf, type, 156, 1);
  writeString(buf, linkname, 157, 100);
  writeString(buf, 'ustar\0', 257, 6);          // magic
  writeString(buf, '00', 263, 2);               // version
  writeString(buf, 'root', 265, 32);
  writeString(buf, 'root', 297, 32);

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  writeString(buf, sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}

function pad(len) {
  const r = len % BLOCK;
  return r === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - r, 0);
}

/** 收集目录下所有条目（深度优先，父目录在前） */
function walk(root, rel = '') {
  const out = [];
  const dir = path.join(root, rel);
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ rel: r, type: 'dir' });
      out.push(...walk(root, r));
    } else if (e.isSymbolicLink()) {
      out.push({ rel: r, type: 'link', target: fs.readlinkSync(path.join(root, r)) });
    } else {
      out.push({ rel: r, type: 'file' });
    }
  }
  return out;
}

async function main() {
  const [srcDir, outFile, rootNameArg] = process.argv.slice(2);
  if (!srcDir || !outFile) {
    console.error('用法: node tools/pack-linux-tar.js <源目录> <输出.tar.gz> [包内根目录名]');
    process.exit(1);
  }
  const rootName = rootNameArg || path.basename(path.resolve(srcDir));
  const out = fs.createWriteStream(outFile);
  const gzip = zlib.createGzip({ level: 9 });
  gzip.pipe(out);

  const write = async (buf) => { if (!gzip.write(buf)) await once(gzip, 'drain'); };

  const entries = walk(srcDir);
  for (const e of entries) {
    const abs = path.join(srcDir, e.rel);
    const name = `${rootName}/${e.rel}`;
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    const mtime = Math.floor((st ? st.mtimeMs : Date.now()) / 1000);

    if (e.type === 'dir') {
      await write(header({ name: name + '/', size: 0, mode: 0o755, mtime, type: '5' }));
      continue;
    }
    if (e.type === 'link') {
      await write(header({ name, size: 0, mode: 0o777, mtime, type: '2', linkname: e.target }));
      continue;
    }

    const size = st.size;
    const mode = isExecutable(e.rel) ? 0o755 : 0o644;
    await write(header({ name, size, mode, mtime }));
    // 大文件（launchplay 本身 200MB）分块写，避免整块读进内存
    const fd = fs.openSync(abs, 'r');
    try {
      const chunk = Buffer.alloc(4 * 1024 * 1024);
      let read;
      while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        await write(Buffer.from(chunk.subarray(0, read)));
      }
    } finally {
      fs.closeSync(fd);
    }
    await write(pad(size));
  }

  // 归档结束标记：两个全零块
  await write(Buffer.alloc(BLOCK * 2, 0));
  gzip.end();
  await once(out, 'close');

  const total = entries.length;
  console.log(`[pack-linux-tar] ${outFile}  ${(fs.statSync(outFile).size / 1048576).toFixed(1)}MB  条目 ${total}`);
}

main().catch((e) => {
  console.error('[pack-linux-tar] 失败:', e.message);
  process.exit(1);
});
