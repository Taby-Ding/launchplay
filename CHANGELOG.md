# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 2.0.0

品牌更名为 **影音快启 / LaunchPlay**（原 TV Launcher），并开源。

### 变更

- 产品名、应用 ID、exe 名、窗口标题全部改为 LaunchPlay
- 数据目录由 `TVLauncherData\` 改为 `LaunchPlayData\`，**首次启动会自动迁移旧数据**
- 开机自启注册表值改为 `LaunchPlay`
- 精简版 Electron 运行时改为由 `tools/prepare-electron.js` 生成，可复现构建
- 补充 MIT LICENSE、贡献指南、Issue / PR 模板与 GitHub Actions 构建

### 新增

- 启动后新窗口铺满并置顶（可关闭）
- 全局热键 `Ctrl+Alt+L` 唤回 / 收起启动台
- 从 PE 资源提取 256×256 高清图标，零原生依赖
- 常驻 PowerShell 辅助进程，窗口增强热态响应 0.1–1.4s

### 修复

- PE 图标解析中 `e_lfanew` 双重相加导致的部分程序图标错乱
- 辅助进程加载旧版缓存 DLL 导致窗口增强静默失效

## 1.2.0

- 启动应用后启动台改为"留在下层"而非隐藏
- 电源按钮改为图标按钮
- 设置项拆分为「启动行为」与「显示」

## 1.1.0

- 增加遥控器 / 手柄支持
- 焦点导航改为空间搜索算法

## 1.0.0

- 首个可用版本：全屏磁贴、手动添加、方向键导航、开机自启
