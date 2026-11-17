<div align="center">

# 影音快启 · LaunchPlay

**把电脑变成一台电视。**

深色客厅、大图标磁贴、遥控器选台——开机即进，选一个就播。

![Build](https://github.com/Taby-Ding/launchplay/actions/workflows/build.yml/badge.svg)

![License: MIT](https://img.shields.io/badge/License-MIT-4aa8ff.svg)

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-4aa8ff.svg)

![Portable](https://img.shields.io/badge/dist-single%20file-success.svg)

[下载](#下载) · [功能](#功能) · [截图](#截图) · [快速开始](#快速开始) · [快捷键](#操作一览) · [从源码构建](#从源码构建) · [常见问题](#常见问题)

</div>

![LaunchPlay 主界面](docs/screenshots/main.png)

---

## 下载

| 平台 | 架构 | 文件 | 大小 | 说明 |
| --- | --- | --- | --- | --- |
| **Windows 10/11** | x64 | [LaunchPlay-1.0.0-windows-x64.exe](https://github.com/Taby-Ding/launchplay/releases/download/v1.0.0/LaunchPlay-1.0.0-windows-x64.exe) | ~71 MB | 单文件免安装，双击即用，无需 .NET / 运行库 |
| **Linux** | x64 | [LaunchPlay-1.0.0-linux-x64.AppImage](https://github.com/Taby-Ding/launchplay/releases/download/v1.0.0/LaunchPlay-1.0.0-linux-x64.AppImage) | ~110 MB | 通用单文件，`chmod +x` 后直接运行 |
| **Linux** | x64 | [LaunchPlay-1.0.0-linux-x64.tar.gz](https://github.com/Taby-Ding/launchplay/releases/download/v1.0.0/LaunchPlay-1.0.0-linux-x64.tar.gz) | ~111 MB | 解压即用的绿色目录，AppImage 跑不起来时用它 |

> 全部产物都在 [Releases](https://github.com/Taby-Ding/launchplay/releases/tag/v1.0.0) 页面。
>
> Linux AppImage 由 CI 在 Ubuntu runner 上构建（原因见[构建说明](#构建说明)）；Windows 包与 Linux tar.gz 已在本地验证过可运行。

### 各平台首次运行

**Windows**：双击 exe 即可。免安装版是自解压包，部分杀软会对这类单文件包误报，可加入信任或自行构建。

**Linux**：

```bash
chmod +x LaunchPlay-1.0.0-linux-x64.AppImage
./LaunchPlay-1.0.0-linux-x64.AppImage
```

如果提示缺少 FUSE，装一下 `libfuse2`（Ubuntu/Debian：`sudo apt install libfuse2`），或者改用 tar.gz 版本：

```bash
tar -xzf LaunchPlay-1.0.0-linux-x64.tar.gz
cd LaunchPlay-1.0.0-linux-x64
./launchplay
```

如果启动时报 `The SUID sandbox helper binary was found, but is not configured correctly`，说明当前系统禁用了非特权用户命名空间（部分 Ubuntu 24.04 默认如此）。两种解法：给 sandbox 加 setuid（`sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`），或者加 `--no-sandbox` 启动。

## 这是什么

把一台接在电视上的电脑，变成一台"电视"：

开机 → 看到一屏大图标 → 用遥控器方向键选 → 按 OK 打开。关掉应用，回到这一屏。

它不扫描你的硬盘、不联网、不上传任何东西。你手动把常用的播放器、浏览器、游戏、直播站加进来，它负责把这一屏做得像电视首页：

- **像电视**：无边框全屏、深色背景、超大磁贴、清晰的焦点高亮
- **像遥控器**：方向键 / 手柄十字键 / 键盘，全都能操作
- **像首页**：打开应用后启动台留在下层，关掉应用自动回到这一屏

> 适用于 HTPC、客厅电脑、投影、一体机、旧笔记本改电视盒子等场景。

## 平台能力对照

同一份界面，两个系统能给的能力不一样，差别都在系统接口上：

| 能力 | Windows | Linux |
| --- | :---: | :---: |
| 全屏磁贴启动台 | ✅ | ✅ |
| 图标自动提取 | ✅ exe/dll 的 PE 资源，原生 256px | ✅ `.desktop` + 图标主题，png/svg |
| 新窗口铺满并置顶 | ✅ Win32 `SetWindowPos` | — 无对应接口 |
| 开机自启 | ✅ 注册表 `HKCU\...\Run` | ✅ XDG autostart |
| 关机 / 重启 | ✅ `shutdown.exe` | ✅ `systemctl` |
| 提权启动 | ✅ UAC `RunAs` | — |
| UWP 应用 | ✅ | — |
| 遥控器 / 手柄 | ✅ | ✅ |
| 全局唤回热键 | ✅ | ✅ |

> Linux 上"新窗口铺满并置顶"在设置里会显示为「仅 Windows 支持」并且不可点——不是藏起来，而是确实没有等价的可移植接口（要按窗口管理器逐个适配，做一半反而更让人困惑）。

## 功能

| 能力 | 说明 |
| --- | --- |
| 手动添加应用 | 选程序文件，支持**一次多选**，自动读取名称与图标 |
| 高清图标 | Windows 从 exe/dll 的 PE 资源取 256×256 原图，`.lnk` / `.url` 快捷方式自动解析真实目标与图标位置（含 Steam / Epic 游戏）；Linux 从 `.desktop` 与图标主题取 512→png/svg；取不到时退化为渐变字母磁贴 |
| 编辑 / 移除 | 按 `E` 或右键即可改名、改路径、换图标、移除（只从启动台移除，**不卸载**） |
| 拖动排序 | 按住磁贴拖到想要的位置，松手即保存顺序（拖动超过 8px 才生效，不影响单击启动） |
| 关机 / 重启 | 右上角图标按钮，二次确认后执行 |
| 方向键焦点 | 空间导航算法：上下左右自动寻找最近的磁贴，当前项高亮 + 缩放 + 光晕 |
| 启动后不收起 | 启动台留在新窗口下层，像电视首页；关掉应用即回到这一屏 |
| 新窗口铺满置顶 | 启动后自动把目标窗口铺满当前显示器并置顶（仅 Windows，可在设置里关闭） |
| 一键唤回 | 全局热键 `Ctrl+Alt+L`，随时把启动台拉回前台 |
| 遥控器 / 手柄 | 标准 Gamepad 映射：十字键移动、A 确认、B 返回 |
| 开机自启 | 两个平台都是用户级自启，不需要管理员 / root，一键开关，失败不破坏开关状态 |
| 全屏沉浸 | 默认无边框全屏，`F11` 切换窗口模式 |
| 默认背景 | 自带一张柔和的电视渐变壁纸，开箱就有客厅感；也可换成自己的图片 |
| 自定义背景 | 设置 → 外观选一张自己的图片当墙纸，可调暗度、开关虚化；图片存进数据目录，原图挪走也不裂 |
| 本地持久化 | 应用列表与设置存在一个 JSON 文件里，拷走整个数据目录即可迁移 |

## 截图

| 主界面 | 自定义背景 | 设置 |
| --- | --- | --- |
| ![主界面](docs/screenshots/main.png) | ![自定义背景](docs/screenshots/background.png) | ![设置](docs/screenshots/settings.png) |

添加应用面板：

![添加应用](docs/screenshots/add.png)

## 快速开始

1. 从上面的表格里挑对应平台的包下载。
2. 运行。首次启动会自动打开「添加应用」。
3. 点「浏览…」选一个程序（可多选），回车确认。
   - Windows：选 `.exe`，或桌面/开始菜单里的 `.lnk`（会自动解析出真实路径）
   - Linux：选 `/usr/share/applications` 里的 `.desktop`，或可执行文件、AppImage
4. 之后按 `C` 随时添加，`S` 打开设置。

> **Windows 建议**：把 exe 放在固定目录（例如 `D:\LaunchPlay\`），它会在同级生成 `LaunchPlayData\`。移动 exe 后建议重新开关一次"开机自启"。

## 启动应用后的行为

点开应用后，启动台**不会收起**，而是留在新窗口下面，作为电视式"首页"常驻。

- 启动时只做两件事：取消置顶、把键盘焦点让给新程序。新窗口由系统拉到前台，层级上正好压在启动台之上。
- 想彻底隐藏启动台：设置里打开「启动后收起启动台」。
- 想手动切回来：`Ctrl+Alt+L`。在应用下层时按一下拉到前台，已在前台时按一下收起。
- 如果该热键被其他软件占用，会自动退化为"不收起"，避免回不来。

## 操作一览

| 操作 | 键盘 | 遥控器 / 手柄 |
| --- | --- | --- |
| 移动焦点 | `← ↑ ↓ →` | 方向键 / 十字键 |
| 启动应用 | `Enter` / `Space` | `OK` / `A` |
| 返回 / 关闭弹层 | `Esc` | `Back` / `B` |
| 退出启动器 | `Esc` 连按两次 | — |
| 添加应用 | `C` | — |
| 编辑 / 移除 | `E` / `Del` | — |
| 设置 | `S` | — |
| 切回 / 收起启动台 | `Ctrl+Alt+L` | — |
| 全屏切换 | `F11` | — |
| 关机 / 重启 | `Ctrl+Alt+P` / `Ctrl+Alt+R` | 右上角按钮 |

鼠标：单击启动，右键编辑。

## 数据与自启

| 项目 | Windows | Linux |
| --- | --- | --- |
| 配置 | `exe 同级\LaunchPlayData\launcher.json` | AppImage 同级 `LaunchPlayData/`，或 `~/.config/LaunchPlay/` |
| 图标缓存 | `LaunchPlayData\icons\` | 同上目录 `icons/` |
| 背景图片 | `LaunchPlayData\backgrounds\`（只留当前一张） | 同上目录 `backgrounds/` |
| 回退位置 | `%APPDATA%\LaunchPlay` | `~/.config/LaunchPlay` |
| 开机自启 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\LaunchPlay` | `~/.config/autostart/launchplay.desktop` |

- Windows 上 exe 放在 `C:\Program Files` 下时，系统会阻止写同级目录，数据会自动落到 `%APPDATA%\LaunchPlay`。
- Linux 上从 AppImage 启动时，数据写在 **AppImage 文件旁边**；如果那个位置不可写（例如放在 `/opt`），自动退到 `~/.config/LaunchPlay`。

## 系统要求

| 平台 | 要求 |
| --- | --- |
| Windows | Windows 10 1809 及以上 / Windows 11，x64；无需 .NET、无需 VC++ 运行库、无需管理员权限 |
| Linux | x64 桌面发行版，需要图形环境（X11 或 Wayland）；推荐 glibc 2.28+ |

建议 1920×1080 及以上分辨率（为 16:9 大屏设计）。

## 从源码构建

```bash
git clone https://github.com/Taby-Ding/launchplay.git
cd launchplay
npm install
npm start              # 开发运行（Windows / Linux 通用）
```

按平台打包：

```bash
npm run dist:win       # Windows 便携 exe        -> release/LaunchPlay-<ver>-windows-x64.exe
npm run dist:linux     # AppImage + tar.gz       -> release/LaunchPlay-<ver>-linux-x64.*
```

其他脚本：

```bash
npm run icon              # 重新生成 build/icon.ico + icon.png(512) + src/assets/icon.png(256)
npm run prepare-electron  # 只生成精简版 Electron 运行时（Windows 打包前会自动执行）
```

### 构建说明

- **跨平台打包的现实**（两个都踩过的坑）：
  - **Linux AppImage 需要创建文件软链**。Windows 上普通用户默认没有 `SeCreateSymbolicLinkPrivilege`（除非打开「开发者模式」），app-builder 在写图标时会报 `A required privilege is not held by the client`。在 Linux 上或 CI 里没有这个问题。
  - **在 Windows 上打 Linux tar.gz 会丢执行权限**。NTFS 没有 Unix 权限位，打出来的包全是 0644，Linux 用户解压后 `./launchplay` 直接 Permission denied。所以仓库带了 `tools/pack-linux-tar.js`，按 ustar 格式重写归档，把 `launchplay` / `chrome-sandbox` / `chrome_crashpad_handler` 记成 0755：
    ```bash
    node tools/pack-linux-tar.js <解压后的目录> out.tar.gz LaunchPlay-1.0.0-linux-x64
    ```
- `npm run dist:win` 会先把 `node_modules/electron/dist` 复制成 `build/electron-dist`，并**只保留 `zh-CN` / `en-US` 两个语言包**，产物从 ~150 MB 降到 ~71 MB。
- 首次打包需要联网下载 Electron 运行时与 NSIS 工具链。国内网络可设置：
  ```bash
  export ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
  ```
- 图标只有一个源：`build/icon.png`（512×512，由 `npm run icon` 现场画出来）。Windows 另用 `build/icon.ico`，运行时窗口图标用打进 asar 的 `src/assets/icon.png`。

## 项目结构

```
src/
  main.js            主进程：窗口、IPC、协议、生命周期
  platform.js        平台能力表（两个平台的差异集中在这里）
  preload.js         contextBridge 安全桥（contextIsolation + sandbox）
  store.js           JSON 持久化（临时文件 + rename 原子写）

  # 启动 / 自启 / 电源：按平台分派
  launch.js          启动条目：Windows spawn+UAC / Linux .desktop+AppImage
  autostart.js       开机自启：Windows 注册表 / Linux XDG autostart
  power.js           关机重启：Windows shutdown.exe / Linux systemctl

  # 快捷方式与图标：按平台分派
  pick.js            选择结果标准化（.lnk / .url / .desktop 统一成一个模型）
  shortcut.js        Windows：Shell Link / Internet Shortcut 解析 + 跨电脑路径重定位
  lnk.js             Windows：添加时把快捷方式拆成 target / args / iconPath
  peicon.js          Windows：PE 资源图标解析 + PNG 编码（纯 JS，零依赖）
  desktop-entry.js   Linux：.desktop 解析 + 图标主题查找（<root>/<主题>/<尺寸>/apps/）
  iconcache.js       图标提取与磁盘缓存（png / svg 分别处理）
  winboost.js        Windows：常驻 PowerShell 辅助进程，新窗口铺满 + 置顶

  renderer/          界面（原生 HTML / CSS / JS，无框架、无构建步骤）
tools/
  make-icon.js         自绘多尺寸 ICO + 512 PNG
  prepare-electron.js  生成精简版 Electron 运行时
```

### 几个实现要点

- **图标提取**：两个平台两条路。Windows 自己写了 PE 资源解析器（`peicon.js`），遍历 `.rsrc` 的图标目录条目（而不是按数字 ID 找，很多程序的图标是命名资源），优先取 PNG 压缩条目，否则解码 DIB 再重新编码；Linux 解析 `.desktop` 的 `Icon=`，按 freedesktop 规范到图标主题目录里从 512 逐级往下找。全程零原生依赖。
- **Windows 窗口增强**：需要 `SetWindowPos`，但 Node 没有原生绑定。这里用一个**常驻的 PowerShell 辅助进程**：预热一次，把 C# 代码编译成 DLL 缓存，之后走行协议通信，避免每次冷启动 3.5 秒的开销；连续 10 分钟不用会自动退出，省内存。
- **快捷方式图标**：`.lnk` 直接向 Shell 要图标，拿到的是"空白页 + 快捷方式箭头"的通用图标（40×40，还刚好卡在尺寸阈值上不被过滤掉）。这里自己解析 Shell Link 二进制，读出真实目标与 `IconLocation`，再从目标 exe 的 PE 资源里取 256px 原图；解析不动的（只有 IDList 的系统项）交给 Electron 的 `shell.readShortcutLink()` 兜底。Steam / Epic 的游戏快捷方式则是 `.url` 格式——只有协议链接和 `IconFile=`，没有可执行目标，这一步单独解析。全程不启动外部脚本进程，1.4ms 量级。
- **换电脑后的路径重定位**：快捷方式里是绝对路径，游戏库又常装在非系统盘。解析完会按盘符、`Program Files (x86)`、Windows 用户名三类差异探测本机真实文件，只有唯一命中才改；找不到就给提示，让用户改选 exe 或手动指定图标。
- **焦点导航**：不做网格下标计算，而是在所有磁贴里按方向做空间搜索（比较中心点偏移与垂直距离），所以不等宽的磁贴、最后一行不满时也能走对。

## 已知限制

- **Windows 没有公开接口把别的程序变成真全屏**（独占全屏），本项目只能做到"铺满 + 隐藏任务栏"，视觉上等价；Linux 连这一步都没有，设置里会标注为不支持。
- `.lnk` 快捷方式和协议链接拿不到子进程 PID，因此"新窗口铺满置顶"对它们不生效。
- 启动台在前台时，`Esc` 会发给前台应用；回到首页请用 `Ctrl+Alt+L` 或 `Alt+Tab`。
- 部分程序（UWP 应用、二级启动器）启动后会拉起另一个进程，窗口增强可能不生效。
- Linux 上如果某个应用**只提供 SVG 图标**，会正常显示（浏览器直接渲染）；但如果图标藏在 Flatpak/Snap 的私有目录又不在标准主题路径里，可能拿不到，会退化成字母磁贴。
- Steam / Epic 的游戏库若装在 NAS、移动硬盘或深层自定义目录，快捷方式里的 `IconFile` 在换电脑后可能仍找不到；请在「编辑应用」里手动指定图标，或直接选择游戏 exe。
- Linux 的"关机 / 重启"依赖 systemd + polkit；非 systemd 发行版（如部分轻量发行版）会失败并提示。

## 常见问题

**图标是空的 / 显示首字母？**  
说明该程序本身没有可用的大图标（图标在 DLL 里，或只有 16px，或图标主题里只有非标准路径）。此时会退化成渐变字母磁贴，可以在「编辑应用」里手动指定一张图片。

**Steam / Epic 的游戏没图标，别的程序都正常？**  
这两个平台的游戏快捷方式大多是 `.url` 协议链接（`steam://rungameid/…`），图标写在文件内的 `IconFile=` 里，而不是某个 exe 上。1.0.0 起会解析这个字段，并按盘符 / 安装目录差异在新电脑上重新定位图标文件。如果游戏库在 NAS、移动硬盘等自定义位置，定位不到时请直接选择游戏 exe，或在「编辑应用」里手动指定图标。

**点应用没反应？**  
Windows 上需要管理员权限的程序会触发 UAC 提示；路径失效时会直接提示"路径不存在"。Linux 上会先尝试补执行权限，再退回系统默认打开方式。

**杀毒软件报毒？**  
Windows 免安装版是自解压 exe，部分杀软会对这类单文件包误报。可以加入信任，或用 `npm run dist:win` 自行构建。

**重启后列表丢了？**  
检查数据目录是否可写。Windows 上 exe 在 `C:\Program Files` 下会把数据存到 `%APPDATA%\LaunchPlay`；Linux 上 AppImage 放在只读位置时会存到 `~/.config/LaunchPlay`。

## 贡献

欢迎 Issue 和 PR。提交前请先看 [CONTRIBUTING.md](CONTRIBUTING.md)。

本项目没有构建步骤、没有前端框架、没有运行时依赖，改完 `src/renderer/` 直接 `npm start` 就能看到效果。各平台的差异请统一收进 `src/platform.js`，不要在业务代码里散落 `process.platform` 判断。

## License

[MIT](LICENSE) © LaunchPlay contributors

本项目与 Microsoft、Apple、Xbox、Steam 等公司无任何关联，仅作为个人使用的桌面工具。
