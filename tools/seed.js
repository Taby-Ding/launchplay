// 开发辅助: 用真实 exe 生成一份测试数据(图标走真实提取流程), 用于界面验证
const fs = require('fs');
const path = require('path');
const { IconCache } = require('../src/iconcache');

const DATA = path.join(__dirname, '..', 'out', 'testdata');
const ICONS = path.join(DATA, 'icons');

const CANDIDATES = [
  ['C:\\Windows\\System32\\notepad.exe', '记事本'],
  ['C:\\Windows\\System32\\mspaint.exe', '画图'],
  ['C:\\Windows\\System32\\calc.exe', '计算器'],
  ['C:\\Windows\\System32\\cmd.exe', '命令提示符'],
  ['C:\\Windows\\explorer.exe', '文件资源管理器'],
  ['C:\\Windows\\System32\\Taskmgr.exe', '任务管理器'],
  ['C:\\Windows\\System32\\SnippingTool.exe', '截图工具'],
  ['C:\\Windows\\System32\\mstsc.exe', '远程桌面'],
  ['C:\\Windows\\System32\\control.exe', '控制面板'],
  ['C:\\Windows\\System32\\osk.exe', '屏幕键盘'],
  ['D:\\Program Files\\IQIYI Video\\LStyle\\QyClient.exe', '爱奇艺'],
  ['D:\\DJ\\AppData\\Roaming\\baidu\\BaiduNetdisk\\BaiduNetdisk.exe', '百度网盘'],
  ['D:\\Program Files (x86)\\DingDing\\DingtalkLauncher.exe', '钉钉'],
  ['C:\\Windows\\System32\\dxdiag.exe', 'DirectX 诊断'],
];

(async () => {
  fs.mkdirSync(ICONS, { recursive: true });
  const cache = new IconCache(ICONS, null);
  const items = [];
  let i = 0;
  for (const [target, name] of CANDIDATES) {
    if (!fs.existsSync(target)) { console.log('跳过(不存在):', target); continue; }
    const t0 = Date.now();
    const file = await cache.ensure({ kind: 'exe', target, iconPath: target, appId: '', name });
    console.log(`${file ? '✓' : '✗'} ${name.padEnd(8)} ${Date.now() - t0}ms  ${file || '无图标'}`);
    items.push({
      id: 'test' + (i++).toString(36).padStart(3, '0'),
      name, target, args: '', kind: 'exe', appId: '', iconFile: file, addedAt: Date.now(),
    });
  }
  const data = {
    version: 1,
    items,
    settings: { autostart: false, fullscreen: true, sound: false, clock24h: true, tileSize: 'normal', hideHints: false },
    firstRun: false,
  };
  fs.writeFileSync(path.join(DATA, 'launcher.json'), JSON.stringify(data, null, 2), 'utf8');
  console.log(`\n已写入 ${items.length} 条到 ${path.join(DATA, 'launcher.json')}`);
  const withIcon = items.filter((x) => x.iconFile).length;
  console.log(`图标提取成功: ${withIcon}/${items.length}`);
})();
