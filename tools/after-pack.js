'use strict';
/**
 * after-pack.js —— electron-builder 的 afterPack 钩子
 *
 * macOS 上 Electron 20+ 的产物至少要有一次 ad-hoc 签名，否则 Apple Silicon
 * 机器会直接拒绝启动（提示"已损坏"）。没有开发者证书时 electron-builder 会跳过
 * 签名，这里补一次 `codesign -s -`。
 *
 * 为什么用 afterPack 而不是 afterSign：
 *   afterSign 只在"确实发生了签名"之后才回调，而我们恰恰是没证书、没签名的场景，
 *   用它会被直接跳过（构建日志里会写 "skipping afterSign hook as no signing occurred"）。
 *   afterPack 在 .app 组装完成、打 zip 之前执行，时机正合适。
 *
 * 其他平台直接返回；配了真证书（CSC_LINK / CSC_NAME）时也不介入，
 * 让 electron-builder 走正常签名流程。
 */

const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function afterPack(context) {
  if (process.platform !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // 有正式证书，交给 electron-builder

  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    // 签名后确认一下，失败时日志里能立刻看出来
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log(`[after-pack] ad-hoc 签名完成: ${appPath}`);
  } catch (e) {
    console.warn('[after-pack] ad-hoc 签名失败，产物仍可生成，但 Apple Silicon 上可能需要手动签名:', e.message);
  }
};
