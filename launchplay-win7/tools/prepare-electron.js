'use strict';
/**
 * prepare-electron.js —— 生成精简版 Electron 运行时
 *
 * electron-builder 默认会把整个 Electron 发行版塞进产物，其中 locales/ 下有
 * 50 多个语言包（约 30 MB），我们只需要中文和英文。这个脚本把
 * node_modules/electron/dist 复制到 build/electron-dist，并删掉多余语言包。
 *
 * 产物由 .gitignore 排除，因此任何人 clone 后都能用 `npm run dist` 重新生成。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', 'electron', 'dist');
const DEST = path.join(ROOT, 'build', 'electron-dist');

// 保留的语言包：简体中文 + 英文
const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`[prepare-electron] 找不到 Electron 运行时：${SRC}`);
    console.error('[prepare-electron] 请先执行 npm install');
    process.exit(1);
  }

  if (fs.existsSync(DEST)) {
    console.log('[prepare-electron] build/electron-dist 已存在，跳过复制');
  } else {
    console.log('[prepare-electron] 复制 Electron 运行时 ...');
    fs.cpSync(SRC, DEST, { recursive: true });
  }

  // 裁剪语言包
  const localesDir = path.join(DEST, 'locales');
  if (fs.existsSync(localesDir)) {
    let removed = 0;
    for (const file of fs.readdirSync(localesDir)) {
      if (KEEP_LOCALES.has(file)) continue;
      try {
        fs.rmSync(path.join(localesDir, file), { force: true });
        removed++;
      } catch (e) {
        console.warn(`[prepare-electron] 删除 ${file} 失败：${e.message}`);
      }
    }
    console.log(`[prepare-electron] 已移除 ${removed} 个多余语言包，保留 ${[...KEEP_LOCALES].join(', ')}`);
  }

  console.log('[prepare-electron] 完成');
}

main();
