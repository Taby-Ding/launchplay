'use strict';
/**
 * 从用户提供的品牌素材生成全部打包资产（构建期一次性工具，依赖 sharp，不进运行时包）：
 *   1) build/icon.ico      —— Windows exe 图标（多尺寸 PNG-based ICO）
 *   2) build/icon.png      —— 512x512，mac/linux 打包用
 *   3) src/assets/icon.png —— 256x256，运行时窗口/任务栏图标
 *   4) docs/banner.png     —— README 标题下的横幅图（压缩）
 *   5) src/assets/splash.png —— 启动画面背景图（压缩，保证快速加载）
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const ICON_SRC = 'D:/Users/DJ/Downloads/影游快启图标.png';
const BANNER_SRC = 'C:/Users/DJ/.workbuddy/clipboard-images/clipboard-2026-11-17T12-19-16-421Z-11f918ad.jpg';

/** 把若干尺寸 PNG 组装成 ICO（PNG 压缩条目，Windows Vista+ 支持） */
function buildIco(entries) {
  // entries: [{ size, png }]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);       // reserved
  header.writeUInt16LE(1, 2);       // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dirSize = 6 + entries.length * 16;
  const dir = Buffer.alloc(entries.length * 16);
  let offset = dirSize;
  entries.forEach((e, i) => {
    const p = i * 16;
    dir[p] = e.size >= 256 ? 0 : e.size;     // width
    dir[p + 1] = e.size >= 256 ? 0 : e.size; // height
    dir[p + 2] = 0;                          // palette
    dir[p + 3] = 0;                          // reserved
    dir.writeUInt16LE(1, p + 4);             // color planes
    dir.writeUInt16LE(32, p + 6);            // bpp
    dir.writeUInt32LE(e.png.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

(async () => {
  // ---------- 图标 ----------
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = [];
  for (const s of sizes) {
    const png = await sharp(ICON_SRC).resize(s, s, {
      fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 },
    }).png({ compressionLevel: 9 }).toBuffer();
    entries.push({ size: s, png });
  }
  const ico = buildIco(entries);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);

  const png512 = await sharp(ICON_SRC).resize(512, 512, {
    fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).png({ compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png512);

  const png256 = await sharp(ICON_SRC).resize(256, 256, {
    fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).png({ compressionLevel: 9 }).toBuffer();
  const assetsDir = path.join(ROOT, 'src', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'icon.png'), png256);
  // 渲染进程里 <img src="assets/icon.png"> 解析到 renderer/assets/, 也要一份
  const rendererAssets = path.join(ROOT, 'src', 'renderer', 'assets');
  fs.mkdirSync(rendererAssets, { recursive: true });
  fs.writeFileSync(path.join(rendererAssets, 'icon.png'), png256);

  // ---------- 横幅 ----------
  // README 用：宽 1000 的 JPG（质量 82，README 里等比显示，体积远小于 PNG）
  const banner = await sharp(BANNER_SRC).resize({ width: 1000 }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'banner.jpg'), banner);
  // 删掉上一版实验留下的 png，避免 README 引用混淆
  try { fs.unlinkSync(path.join(ROOT, 'docs', 'banner.png')); } catch {}

  // 启动画面用：宽 640 的 JPG，体积压到最小以保证快速加载
  const splash = await sharp(BANNER_SRC).resize({ width: 640 }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
  fs.writeFileSync(path.join(rendererAssets, 'splash.jpg'), splash);
  try { fs.unlinkSync(path.join(rendererAssets, 'splash.png')); } catch {}
  try { fs.unlinkSync(path.join(assetsDir, 'splash.jpg')); } catch {}

  console.log('build/icon.ico      ' + (ico.length / 1024).toFixed(1) + 'KB  sizes ' + sizes.join(','));
  console.log('build/icon.png      ' + (png512.length / 1024).toFixed(1) + 'KB  512x512');
  console.log('src/assets/icon.png ' + (png256.length / 1024).toFixed(1) + 'KB  256x256 (窗口图标)');
  console.log('src/renderer/assets/icon.png 256x256 (界面品牌)');
  console.log('docs/banner.jpg     ' + (banner.length / 1024).toFixed(1) + 'KB  width 1000');
  console.log('src/renderer/assets/splash.jpg ' + (splash.length / 1024).toFixed(1) + 'KB  width 640');
})().catch((e) => { console.error(e); process.exit(1); });
