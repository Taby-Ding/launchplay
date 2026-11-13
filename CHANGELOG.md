# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 1.0.0 是首个公开发布版本。此前内部迭代用过 2.0.0 ~ 2.2.1 的版本号（当时只有 Windows 包），
> 那些版本从未对外发布，内容已全部并入 1.0.0，版本号从 1.0.0 重新起算。

## 1.0.0

首个公开发布版本：**Windows / Linux 双平台支持**。

### 新增

- **Linux 支持**（AppImage 与 tar.gz）
  - `.desktop` 启动项直接添加，解析 `Exec=` 得到真实命令与参数
  - 图标按 freedesktop 规范到图标主题目录里找（`<root>/<主题>/<尺寸>/apps/`），png 与 svg 都支持
  - 开机自启写入 `~/.config/autostart/launchplay.desktop`
  - 关机 / 重启走 `systemctl`
  - AppImage 场景下数据写在 AppImage 同级目录；不可写时退到 `~/.config/LaunchPlay`
- **平台能力表** `src/platform.js`：平台差异集中在一处，界面据此调整文案与可选项，业务代码里不再散落 `process.platform`

### 变更

- **版本号收敛为 1.0.0**，旧的构建产物与历史版本目录已清除
- **产物命名统一**：`LaunchPlay-<版本>-<平台>-<架构>.<扩展名>`，一眼能看出是哪个平台
- **图标只有一个源**：`build/icon.png`（512×512，由 `npm run icon` 现场绘制），Windows 另出 `build/icon.ico`，运行时窗口图标用打进 asar 的 `src/assets/icon.png`
- **CI 改为平台矩阵**：Windows / Ubuntu 各自在原生 runner 上构建，tag 推送时统一挂到同一个 Release

### 保留（1.0 之前完成、本版本一并发布）

- 全屏磁贴启动台、空间导航焦点算法（方向键自动找最近磁贴）
- 遥控器 / 手柄支持（标准 Gamepad 映射：十字键、A 确认、B 返回）
- 拖动排序（超过 8px 才进入拖动，不影响单击启动）
- 自定义背景图片：暗度四档、虚化开关、恢复默认壁纸；图片复制进数据目录，原图挪走不裂
- 内置电视渐变壁纸，开箱即有客厅感
- 高清图标：Windows 从 PE 资源取 256×256 原图；Linux 取主题里最大尺寸
- Windows 快捷方式图标修复：自写 Shell Link 解析，1.4ms 拿到真实目标（原 PowerShell 方案 2.4s 且会静默失败）
- Windows 窗口增强：常驻 PowerShell 辅助进程，新窗口铺满 + 置顶，闲置 10 分钟自动退出
- 全局热键 `Ctrl+Alt+L` 唤回 / 收起启动台
- 开机自启两个平台均为一键开关，失败不破坏开关状态

### 已知限制

- Linux 没有"把别的程序变成全屏"的等价接口，设置里该项标注为仅 Windows 支持
- Linux 上只在非标准路径提供图标的少数应用会退化为字母磁贴
