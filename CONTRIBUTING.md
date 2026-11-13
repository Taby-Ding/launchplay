# 参与贡献

感谢你愿意改进影音快启。下面是几条约定，能省掉很多来回沟通。

## 开发环境

- Node.js 22+
- Windows 10 / 11（项目依赖 Windows 的窗口 API 与注册表，其他系统只能跑界面）

```bash
npm install
npm start
```

没有构建步骤：`src/renderer/` 下的 HTML/CSS/JS 改完刷新即可生效（`Ctrl+R`）。
主进程改动需要重启 `npm start`。

## 目录约定

| 目录 | 说明 |
| --- | --- |
| `src/main.js` | 主进程入口：窗口、IPC、启动、电源、自启 |
| `src/preload.js` | 唯一允许暴露给渲染进程的桥，新增能力从这里走 |
| `src/renderer/` | 界面层，原生 JS，不引入框架与打包器 |
| `src/winboost.js` | 常驻 PowerShell 辅助进程（窗口铺满 / 置顶） |
| `src/peicon.js` | PE 资源图标解析，纯 JS，请不要引入原生依赖 |
| `tools/` | 一次性脚本：图标生成、Electron 运行时精简 |

## 提交 Issue

- 报 Bug 请附：Windows 版本、LaunchPlay 版本、复现步骤、期望结果、实际结果。
- 涉及"启动后窗口没铺满"的问题，请注明目标程序是 exe 还是 `.lnk`（两者实现不同）。

## 提交 PR

1. 从 `main` 切一个分支：`feat/xxx`、`fix/xxx`。
2. 保持改动聚焦，一个 PR 只做一件事。
3. 不要提交 `node_modules/`、`release/`、`build/electron-dist/`、`LaunchPlayData/`。
4. 新增依赖前请先开 Issue 讨论——这个项目的卖点之一就是零运行时依赖、体积小。
5. PR 描述里写清楚：改了什么、为什么改、怎么验证（最好附截图）。

## 代码风格

- 2 空格缩进，单引号，语句结尾加分号。
- 注释用中文，讲"为什么"而不是"做了什么"。
- 渲染层不要用 `innerHTML` 拼接用户输入（应用名来自文件名，可能含特殊字符）。
- 主进程新增 IPC 时，同步更新 `preload.js` 的白名单，不要开 `nodeIntegration`。

## 提交信息

采用 Conventional Commits 的简化版：

```
feat: 支持拖拽添加应用
fix: 修复 4K 屏下磁贴错位
docs: 补充自启失败的排查步骤
chore: 升级 electron 到 38.2.2
```
