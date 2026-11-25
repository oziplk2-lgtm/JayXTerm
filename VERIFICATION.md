# 初版验证记录

## 2026-11-25：VS Code 风格主题字体、默认单击打开与终端 `Ctrl+左键` 打开文件

- 配色与字体：`src/theme.mjs`、`src/app-settings.cjs` 与 `src/terminal-settings.mjs` 默认切换为 `#181818` 背景、`#cccccc` 前景、`#264f78` 选区蓝及 VS Code `terminalColorRegistry.ts` ANSI 16 色板；默认字体保持 `Cascadia Mono` 并补充 `Consolas, "Courier New", monospace` 回退链；默认文件和目录打开方式调整为 `"single"`（单击打开）。
- 终端 `Ctrl + 左键` 打开文件：新增 `src/terminal-file-links.mjs`、`sftp:stat-target` IPC（`src/ssh-worker.cjs`、`src/main.cjs`、`src/preload.cjs`）及 `src/renderer.js` `term.registerLinkProvider`；支持绝对路径、相对路径（自动拼接 Shell 当前目录）、`~/` 及 `:line[:col]` 后缀，按住 `Ctrl`/`Cmd` 悬停显示下划线与手型光标，点击后文件直接弹出 Monaco 远程编辑器、目录在文件列表定位进入。
- 单元测试 `powershell -ExecutionPolicy Bypass -File scripts/windows.ps1 test`：54 项全部通过（含 `src/terminal-file-links.test.cjs` 3 项以及更新后的 `theme.test.cjs`、`app-settings.test.cjs`）。
- 完整 Electron Smoke 回归（开启 `JAYXTERM_CLIPBOARD_QA=1`、`JAYXTERM_EDITOR_QA=1`、`JAYXTERM_LOCAL_DRAG_QA=1`、`JAYXTERM_WORKSPACE_QA=1`、`JAYXTERM_SESSION_EXCHANGE_QA=1`、`JAYXTERM_SETTINGS_QA=1`、`JAYXTERM_FEATURES_QA=1`、`JAYXTERM_ASSIST_QA=1`）：29.3 秒全部通过；`settings-check.cjs` 真实派发 `Ctrl + 鼠标左键` 点击终端输出 `/home/jay/README.md` 成功打开 Monaco 远程编辑器。

## 2026-11-25：屏幕取色器、会话列表 `Ctrl+C` / `Ctrl+V` 复制粘贴与终端快捷键

- 新增全屏屏幕取色器（`color-picker.html`、`src/color-picker.js`、`src/color-picker-preload.cjs`、`src/color-picker-utils.mjs`）与可编辑十六进制色值输入框：突破 Chromium 原生 `<input type="color">` 吸管仅限应用窗口内的限制，支持高 DPI 缩放坐标采样、放大镜准星预览、5 秒截图超时与 `ready` 握手兜底。
- 新增会话列表两步复制粘贴（`src/session-duplicate.cjs`、`sessions:duplicate` IPC 与 `src/renderer.js`）：支持单击与方向键选中会话、按 `Ctrl+C`（macOS `Cmd+C`）记录并按 `Ctrl+V`（macOS `Cmd+V`）在原位置后生成去重副本，主进程直接克隆加密密码密文，不向渲染进程或系统剪贴板暴露明文；不影响搜索框文本复制及终端快捷键。
- 单元测试 `powershell -ExecutionPolicy Bypass -File scripts/windows.ps1 test`：51 项全部通过（新增 `src/color-picker-utils.test.cjs` 3 项、`src/session-duplicate.test.cjs` 2 项）。
- 完整 Electron Smoke 回归（移除 `ELECTRON_RUN_AS_NODE` 后启用 `JAYXTERM_CLIPBOARD_QA=1`、`JAYXTERM_LOCAL_DRAG_QA=1`、`JAYXTERM_WORKSPACE_QA=1`、`JAYXTERM_SESSION_EXCHANGE_QA=1`、`JAYXTERM_SETTINGS_QA=1`、`JAYXTERM_FEATURES_QA=1`、`JAYXTERM_ASSIST_QA=1`）：26.2 秒全部通过，`settings-check.cjs` 覆盖 Hex 输入预览联动及会话列表 `Ctrl+C` + `Ctrl+V` 复制粘贴与加密密码保留。
- 屏幕取色窗口端到端检查（mock `desktopCapturer` 屏幕位图）：验证全屏取色窗口加载、像素采样 `#1E90FF` 并回填设置页颜色选择器与 Hex 输入框成功。

## 2026-11-25：终端 Ctrl+C / Ctrl+V 复制粘贴（VS Code 风格）

- 分支 `feat/ctrl-cv-clipboard`：在 `src/terminal-clipboard.mjs` 实现快捷键动作解析，在 `src/renderer.js` 通过 `term.attachCustomKeyEventHandler` 接入 xterm 实例并复用 `terminalClipboard`，同时保留右键菜单复制/粘贴及浏览器原生 `copy` / `paste` 事件拦截（防止隐藏 textarea 触发双倍粘贴）。
- 行为约定：Windows/Linux 下终端有选区时按 `Ctrl+C` 复制到系统剪贴板并清除选区（不发 `0x03`），无选区时发送 `0x03`（`SIGINT`）；`Ctrl+V` 执行终端粘贴，不发 `0x16`；`Ctrl+Shift+C` / `Ctrl+Shift+V` 支持强制复制/粘贴；macOS 使用 `Cmd+C` / `Cmd+V` 并保留 `Ctrl+C` / `Ctrl+V` 终端控制键。
- 单元测试 `./scripts/windows.ps1 test`：全部 46 项通过（含新增 `src/terminal-clipboard.test.cjs` 5 项用例，覆盖选区/无选区、Shift 组合、macOS 与 IME 组合态）。
- Electron 集成验证：清除父进程继承的 `ELECTRON_RUN_AS_NODE` 后，启用 `JAYXTERM_CLIPBOARD_QA=1`、`JAYXTERM_LOCAL_DRAG_QA=1`、`JAYXTERM_WORKSPACE_QA=1`、`JAYXTERM_SESSION_EXCHANGE_QA=1`、`JAYXTERM_SETTINGS_QA=1`、`JAYXTERM_FEATURES_QA=1`、`JAYXTERM_ASSIST_QA=1` 运行 `./scripts/windows.ps1 smoke`，约 27.5 秒全部通过；`scripts/clipboard-check.cjs` 验证选中按 `Ctrl+C` 复制并清选区、无选区按 `Ctrl+C` 发送 `0x03`、`Ctrl+Shift+C/V`、`Ctrl+V` UTF-8/GBK 及括号多行单次粘贴与右键菜单均正常。

## 2026-11-23：Windows 拖动状态释放与高延迟输入

- 真实 Windows 鼠标复现：无窗口的独立辅助进程进入 OLE 拖动后，线程未接入源窗口输入队列，无法收到松键和 Esc，主进程一直保留传输占用。抓取辅助线程栈确认停在 `DoDragDrop` 消息循环。仅在同步拖动期间通过 `AttachThreadInput` 连接前台源窗口队列，返回后立即解除。
- `electron scripts/native-drag-gesture-check.cjs` 在解锁桌面上以系统鼠标事件验证取消、放入真实 Electron 接收窗口、再次取消；每次均收到结束通知，内部令牌传递且不请求远端文件。实际应用从文件名起拖至资源管理器测试目录，落盘文件与本地 SSH/SFTP 测试服务中的字节一致；取消后重试通过。
- 经用户授权，使用已保存的 SSH 连接和既有主机指纹，单独建立 PTY 回显通道：10 次样本原始中位回显约 334 毫秒，`setNoDelay(true)` 后约 288 毫秒。本地临时诊断不记录密码或会话内容，未修改远端配置。
- 预测回显只在普通缓冲区、Shell 括号粘贴模式、非应用光标模式且当前输入已收到至少两个完全匹配的回显后启用。ASCII 预览使用独立覆盖层，不改 xterm 历史、光标或真实输出；控制键、粘贴、非 ASCII、ANSI 重画、输出不匹配、超时、缩放、断线和会话移动时撤销预测。设置可保存并同步关闭此功能。它属于启发式优化，不具备对远端任意程序输入模式的绝对判定能力。
- Windows 本机 37 项单元及 SSH 测试通过；生产构建、原生组件编译和 Shell 数据格式自检通过。完整 Electron 回归覆盖拖放、分屏、设置、字体、导入导出、辅助功能、删除和复制会话。新增 350 毫秒延迟 SSH 回显检查，预览约 3 毫秒显示，验证无重复输入、服务器重画、密码、全屏、超时及关闭设置。
- 用户保存的真实连接中，确认两字符后预览约 2 毫秒显示；仅执行 `echo JAYXTERM_LATENCY_CHECK`，核对整行命令和输出，没有修改远端文件。预测不适用于中文输入或复杂光标编辑，也不会减少命令执行和远端补全的网络等待。

## 2026-11-23：远程文件名和整行拖到 Windows 桌面

- macOS arm64，Node.js 26.0.0，Electron 42.8.1 / Chromium 148.0.7778.280。修复前在实际 Electron 窗口加入文件名起拖检查，原有「↗」用例通过，新用例失败：拖动只提供 `application/x-jayxterm-sftp` 和 `text/plain`，没有启动原生文件拖放。
- 修复后文件名及整行接入 Windows 辅助组件，并携带一次性 SSH 互传令牌。核对当前 Chromium 版本的拖放实现，使用其渲染器来源和忽略合成文件内容的标记，让 SSH 面板接收令牌，不先将远程文件下载到本机。枚举格式不扫描远程目录；内部复制等待原生拖动释放源连接后开始。
- `npm test` 的 33 项测试通过，新增检查覆盖等待与释放传输锁、取消、目标拒绝、提前松手、辅助进程退出、令牌归属及失效校验、仅适用于 POSIX 的文件名。Vite 生产构建通过。
- 设置 `JAYXTERM_LOCAL_DRAG_QA=1 JAYXTERM_WORKSPACE_QA=1 JAYXTERM_MULTIWINDOW_QA=1` 后运行 `electron scripts/smoke.cjs`：实际 Electron 鼠标事件验证从文件名起拖，通过真实本地 SSH/SFTP 核对二进制文件字节、中文路径、嵌套及空目录、取消和暂存清理。模拟原生接收端延迟结束拖动，跨窗口文件及分屏目录互传通过，包含空格、中文和冒号的 POSIX 文件名保持可用。单独设置 `JAYXTERM_WORKSPACE_QA=1` 验证无原生组件时的浏览器拖拽回退通过。
- 扩展冒烟抓到下载完成后旧进度消息覆盖完成状态的问题。新增确定性检查，向已完成的普通下载和原生拖放注入迟到的进度消息；修复前原生拖放检查失败，修复后两个完成状态均保持。原生拖动结束时也会清除源窗口的活动状态，不覆盖内部互传的进度。
- 在远端最新 main 上，启用与 Windows CI 相同的拖放、分屏、会话迁移、设置、终端辅助和功能检查，完整 macOS Electron 冒烟约 15.2 秒通过。其间修正字体检查对 macOS 本地化名称的误判：同时用所选字体的 PostScript 名称校验实际字形，覆盖 `PingFang SC` 与「蘋方-簡」的名称差异。
- 使用 Zig 0.14.1 在 macOS 交叉编译 Windows x64 辅助程序成功，产物为 PE32+ x86-64。扩展 `--self-test` 检查令牌、Chromium 标记及无需读取远端的格式枚举；此原生测试由 Windows CI 执行。CI 也已加入分屏及跨窗口文件互传检查。
- 上述 macOS 界面检查使用模拟 Windows 接收端，不能替代 Windows OLE / Explorer 验收。后续 Windows 构建后需运行 `node scripts/native-drag-check.cjs`，并实测从文件名、整行和「↗」拖到桌面及资源管理器，以及取消后重试和拖回 SSH 面板；核对文件内容、目录结构与状态提示。

## 2026-11-21：本机字体选择与中西文字体分开设置

- Windows 本机 Node.js 24.16、Electron 42.8.1：24 项单元及 SSH 集成测试通过，Vite 生产构建通过。设置持久化检查覆盖旧配置迁移、中文字体保存与清除、无效值拒绝及修改其他设置时保留字体。
- 使用真实鼠标事件打开字体列表、输入搜索并选取西文字体；使用原生方向键及 Enter 选取中文字体，Esc 只关闭列表。重复点击同一选择器曾被原生弹层的自动关闭行为干扰，回归检查先复现失败，修复后通过。验证取消不落盘、恢复默认、保存后同步已有窗口，以及字体读取失败后的重试和关闭列表后迟到的读取结果。
- Chromium 实际枚举到本机 242 个字体家族；两个选择器共享缓存。模拟 20,000 个款式、去重为 10,000 个字体家族，展开并滚动到底的本机单次检查约 58ms，底部只保留 10 个 DOM 条目，没有加载未选中的字体。此耗时仅代表本机本次检查，不是其他机器的性能保证。
- 通过 Chromium 实际字形来源确认预览和 SSH 终端分别使用 Consolas 与 Microsoft YaHei；测量中文及全角标点的双列宽度，验证中英文混排在行末自动换行后光标仍位于正确列。中文字体加载完成后再更新终端，避免提前缓存回退字体的字宽。
- 使用与 CI 相同的拖放、导入导出、设置、功能及终端辅助检查开关运行完整 Electron smoke，约 16 秒通过。新回归入口为 `scripts/font-picker-check.cjs`，随 `JAYXTERM_SETTINGS_QA=1` 执行；界面截图为 `.codex-cache/qa/font-picker.png`。
- Windows x64 安装版与便携版打包成功，Windows Shell 原生拖放检查通过。在线获取 Electron 时遇到网络超时，使用 `electron-builder --win --x64 --config.electronDist=node_modules/electron/dist` 复用本机同版本 Electron 完成打包；核对 ASAR 中的字体配置、页面及界面资源与最终验证文件一致。

## 2026-11-21：终端阅读、搜索、文件图标与快捷密码

- Windows 本机 Node.js 24.16、Electron 42.8.1：24 项单元及 SSH 集成测试通过，Vite 生产构建通过。
- Electron 实际渲染检查覆盖 Success / Fail / Warning / Info 配色、中英文词边界、中文与 emoji 单元格宽度、自动换行、设置预览取消及全屏备用缓冲区。终端搜索覆盖滚动历史、中文跨行匹配、上一个 / 下一个、大小写切换、无结果、标签隔离及从文件空间打开后的输入焦点；大小写选项变化时会重建匹配缓存。
- 文件列表行高约 28px，文件夹、文本、代码、脚本、配置、图片、压缩包、PDF 与数据库图标检查通过；文件和密码本删除按钮使用 SVG 垃圾桶，保留可访问名称及确认流程。
- 快捷密码经 Windows 系统安全存储加密落盘，列表接口只返回描述和 ID。界面验收覆盖新增、显示 / 隐藏、保留密码修改描述、跨窗口更新、关闭设置后清理明文、删除及取消。键盘切换设置分区曾未清理已显示密码，新增检查先复现失败，修复后通过。
- 密码框及分包到达的 Shell 密码提示会显示候选描述。实际窗口验证候选紧邻光标右侧、跟随光标移动及窗口边缘避让；原生 ↑/↓ 按键只选择候选，Enter 或点选将密码和一个回车发送给所属 SSH 连接，选取前不发送密码。手动输入会关闭候选并保留普通回车行为，GBK 中文密码字节正确，旧标签候选和其他窗口不能向当前连接填入密码。
- 连续密码提示检查覆盖滚动历史装满后的缓冲区裁剪：使用跟随缓冲区的行标记识别新提示，避免相同行号漏弹；关闭候选后，提示末尾新增空格不会再次弹出。
- 使用与 CI 相同的拖放、导入导出、设置、功能及 `JAYXTERM_ASSIST_QA=1` 开关运行 `scripts/windows.ps1 smoke`，约 16 秒通过。另一次扩展回归启用多窗口、分屏、远程编辑器和剪贴板检查，约 23 秒通过。
- Windows x64 安装版与便携版打包成功；Windows Shell 原生拖放数据格式检查通过。核对 ASAR 中的主进程、预加载、加密密码本模块及当前界面资源与已验证文件一致。

## 2026-11-21：Windows CI 冒烟测试超时

- [PR #1 的失败构建](https://github.com/JayBigKing/JayXTerm/actions/runs/44745513659) 已完成 Vite 构建、19 项测试、拖放和设置检查，随后在终端设置检查中达到 120 秒总超时。日志中的错误密码认证失败来自预期的拒绝测试。
- Windows 本机对旧 smoke 入口执行最小化对照检查：页面变为 `hidden`，字号预览已变为 `22px`，终端列数仍为原来的 `128`，15 秒后探针报告失败。后台节流使终端重排所需的动画帧停止，并拖慢页面内轮询。
- smoke 入口为所有测试窗口关闭后台节流，增加阶段名称、耗时及失败阶段日志。Windows 终端设置检查主动最小化工作台，覆盖字体预览、取消、保存、重排和跨窗口同步，并在清理时恢复窗口。
- 修复后在 Windows、Node.js 24.16、Electron 42.8.1 上通过 19 项单元及 SSH 集成测试；启用 CI 同样的 `JAYXTERM_LOCAL_DRAG_QA=1`、`JAYXTERM_SESSION_EXCHANGE_QA=1`、`JAYXTERM_SETTINGS_QA=1`、`JAYXTERM_FEATURES_QA=1` 后执行 `scripts/windows.ps1 smoke`，Vite 构建及完整界面检查通过，冒烟阶段约 11 秒。
- `scripts/windows.ps1 package` 成功生成 Windows x64 安装版和便携版；`node scripts/native-drag-check.cjs` 的 Windows Shell 原生拖放数据格式检查通过。

## 2026-11-20：整体配色、远端删除、同目录复制与终端设置

- Windows 本机 Node.js 24.16、Electron 42.8.1：19 项单元和 SSH 集成测试通过，Vite 生产构建通过。
- Electron 窗口检查通过：浅色与深色主题应用到标题栏、工具栏、终端、文件面板及 Monaco 编辑器；预览取消恢复原色，保存后同步已有窗口，新窗口读取已保存主题。
- 本地 SSH/SFTP 测试服务验证删除文件、递归删除目录、取消、权限拒绝、禁止删除根目录和跨窗口连接校验；单元测试验证删除链接本身而不遍历目标，以及父路径变化时拒绝删除。
- 原生标签菜单复制验证独立认证、原连接不受影响、保留 GBK 编码，以及包含中文、空格、引号和 Shell 特殊字符的路径；删除已保存会话后仍能从活动连接复制，未向界面返回密码。
- 设置分区支持键盘导航，切换分区保留草稿；Shell 字体与字号的预览、取消、保存、恢复默认、终端尺寸重算及跨窗口同步通过实际 Electron 检查。默认编码只影响新会话，GB2312 中文输入和 SSH 回显通过，非法字号被拒绝，旧配置正确回退到默认值。
- Windows x64 安装版和便携版打包成功，已检查发行包包含新增主题、终端设置模块及最新界面文件；产物位于 `.codex-cache/releases/`。
- VMware Ubuntu 真实 SSH 只读验收通过：原终端位于 `/usr/share`、SFTP 浏览 `/etc` 时，复制产生的新 SSH 终端实际进入 `/usr/share`；关闭复制标签后原连接仍可查询目录，文件空间同步正常。使用现有主机指纹校验；未执行远端写入或删除，禁用测试会话历史写入，`.bash_history` 前后 SHA-256 一致。
- 运行新增界面检查：设置 `JAYXTERM_SETTINGS_QA=1`、`JAYXTERM_FEATURES_QA=1`，再执行 `scripts/windows.ps1 smoke`。VM 连接参数及凭据仅用于本地临时测试，不进入仓库。

2026-11-13，开发主机 macOS，Electron 42.8.1，关闭硬件加速。

已完成：

- Vite 生产构建。
- 5 项测试通过：会话校验和持久化、真实本地 SSH 密码认证 / 错误密码拒绝 / 主机指纹拒绝、UTF-8 回显、600 KB 连续输出流量控制、SFTP 单文件与嵌套目录往返、空目录、Windows 文件名和符号链接保护。
- 实际 Electron 窗口检查：通过表单保存会话和系统加密密码，磁盘中没有明文测试密码；连接真实本地 SSH 测试服务，左侧显示远程文件，右侧显示交互终端。
- 通过原生磁盘 File 对象触发拖放上传，远程收到的文件字节一致。
- 通过界面上传嵌套目录，再下载回本地，中文文件内容和空目录均保留。
- 在 macOS 交叉生成 Windows x64 便携版 EXE；检查包内 SSH 依赖、最新文件面板、传输模块、许可证均存在，应用主程序为 Windows x86-64 PE。

尚未完成：Windows 实机启动、Windows DPAPI 实测、Windows 原生资源管理器拖放与中文输入法、内网服务器兼容性、无 GPU Windows 下与 VS Code 的输入延迟对比。已提供 Windows CI 工作流，但未在本次会话触发。

截图（开发环境）：`.codex-cache/qa/overview.png`、`session.png`、`connected.png`。

## 0.1.1 终端尺寸回归

- 新增真实 SSH 时序测试先在旧代码上失败：期望 137 列 / 41 行，远端实际收到 100 列 / 30 行。
- 修复后覆盖握手前、Shell 创建期间、已连接后的三种尺寸更新，全部通过。
- 在关闭硬件加速的 Electron 中连接真实 Bash / Readline PTY，用带颜色的长路径提示符测试三种窗口宽度；输入超过两屏宽度的命令、执行后重复上 / 下键，检查命令完整换行，历史操作前后屏幕内容完全一致。此项在 macOS 运行，Windows 和用户实际服务器上的复测仍待完成。
- POSIX Bash 窗口回归可通过设置 `JAYXTERM_READLINE_QA=1` 运行 `scripts/smoke.cjs`；测试脚本依赖 Python 3 和 /bin/bash，不进入发行包。

## 0.2.0 功能回归

- 7 项自动测试通过：新增 GBK 每个拆包位置解码、ANSI / Vim 控制序列完整性、GBK 输入编码、UTF-8 / GBK 切换，真实 SSH 探测不创建 PTY，以及真实连接的 GBK 双向回显。
- 实际窗口验证：未保存会话测试成功，错误密码测试失败且不增加会话或终端标签；保存密码点击显示后正确可见，隐藏恢复掩码，关闭编辑框清空。
- 用真实 Bash / Vim 验证：同一 GBK 文件 cat 正常而 Vim termencoding=utf-8 时乱码；将 Vim termencoding 改为 cp936 后显示正确，输入中文并保存，检查文件仍为 GBK 且内容一致；切换客户端为 UTF-8 后，Vim termencoding=utf-8 也能正确读取该 GBK 文件。未直接测试 electerm 本身。
- 新增截图 `.codex-cache/qa/vim-mismatch.png`、`vim-gbk.png`，对照乱码配置和正确配置。
- 此次 GUI / Vim 检查在 macOS Electron 42.8.1、软件渲染下进行；新版本仍待 Windows 和实际内网老系统验收。

## 0.3.0 多窗口

- 真实 Electron 多窗口检查：会话修改同步；输出不发送到无归属窗口；移动到已有窗口、移出新窗口、合并回原窗口，认证次数保持不变，历史、编码和 SFTP 路径保留；不同窗口尺寸下 PTY 与终端一致。
- 在 GBK Vim 正在编辑时移出和合并，再编辑保存，文件内容及 GBK 编码仍正确。
- 故障注入：目标恢复失败时回退到原窗口，SSH 连接仍可输入；关闭空闲窗口或另一个有连接的窗口，不影响当前连接。
- 后台协议回归：暂停交接输出期间，ACK 不得提前恢复流，解除暂停后输出完整。
- 本机回环传输测量：120 次回显（两组均将被测终端窗口置前，待界面空闲后测量），单窗口与增加 3 个空闲窗口对比；数据见 `.codex-cache/qa/multiwindow-metrics.json`。它只测传输到界面事件的时延，不包含绘制，不代表 Windows 内网或持续高负载性能。
- 多窗口检查命令：设置 `JAYXTERM_MULTIWINDOW_QA=1` 后运行 `scripts/smoke.cjs`；可与 `JAYXTERM_READLINE_QA=1`、`JAYXTERM_VIM_QA=1` 一起运行。窗口管理截图：`.codex-cache/qa/window-manager.png`。
- 本版在 macOS 软件渲染下检查，Windows 实机多窗口及多显示器仍待用户验收。

## 0.3.1 剪贴板

- 使用真实系统剪贴板和 Chromium 键鼠输入：终端全选后 Ctrl+Shift+C、Ctrl+C 均复制到系统；没有选择时 Ctrl+C 仍向 SSH 发送 0x03，不被复制逻辑吞掉。
- Ctrl+V、Ctrl+Shift+V 的 UTF-8 中文粘贴只发送一次；Shift+Insert 的 GBK 中文粘贴检查原始 SSH 输入字节与 CP936 编码相同。
- 多行文本在 bracketed paste 模式下保留起止标记，CRLF / LF 正确归一化。实际构造右键原生菜单并验证复制、粘贴回调。
- 剪贴板测试使用临时测试文字，结束时恢复原有文本、HTML、RTF 和图片等常用格式，不保存原剪贴板内容到磁盘。
- 检查命令：设置 `JAYXTERM_CLIPBOARD_QA=1` 运行 `scripts/smoke.cjs`。本次在 macOS Electron 软件渲染环境中模拟 Windows 快捷键验证，Windows 实机仍需验收。

## 0.3.2 仅右键剪贴板

- 移除终端复制粘贴的自定义快捷键及原生菜单 accelerator；阻止终端浏览器 copy / paste 事件，保留右键菜单。
- 实际 Electron 检查：右键全选、复制、UTF-8 / GBK 粘贴和带括号标记的多行粘贴；菜单没有快捷键提示。选中终端文字后 Ctrl+C 仍发送 0x03 且不更改剪贴板；Ctrl+V 发送 0x16，不粘贴系统内容。测试后恢复原剪贴板常用格式。

## 0.5.0 远程文件编辑

- 启用 `JAYXTERM_EDITOR_QA=1` 运行 Electron 验收，验证双击在独立窗口打开多个文件、主窗口终端保持可用、拒绝二进制、快捷键保存、保留 GBK 和 CRLF、选择编码重新读取及转存 UTF-8、远端修改冲突时保留本地草稿，以及取消关闭未保存文件。原有四分屏和多窗口验收也已通过。
- 保存通过同目录临时文件替换原文件，要求 SFTP 服务允许替换。会保留标准权限位和所有者，SFTP v3 不提供保留 ACL、扩展属性或硬链接关系所需的信息。
- 在 macOS Electron 软件渲染下联调，跨平台打包 Windows x64 便携版。Windows 实机和实际内网 SFTP 服务待验收。

## 0.5.2 文件编辑器修复

- Electron 验收覆盖 Tab / Shift+Tab、聚焦选区配色、SFTP 通道关闭后的再次保存，以及服务器在替换目标文件时改写修改时间的连续保存。真实内容冲突仍会阻止覆盖并保留草稿。
- 7 项单元和 SSH 集成测试通过，四分屏、双栏文件和多窗口回归通过。Windows 实机和用户内网服务器仍待验证。

## 0.5.3 分屏文件空间

- Electron 本机验收逐一对比切换前后的一至四个分屏坐标及尺寸，验证每格跟随其终端标签，空分屏保持空状态，返回终端后 SFTP 路径仍可从侧栏访问。
- 跨分屏将目录拖到另一台服务器指定的子目录，并校验嵌套文件内容和空目录。原有跨窗口二进制传输、多窗口和远程编辑器回归通过。

## 0.5.4 分屏目录同步

- 本机 Electron 与两个 SSH 会话验证首次确认发往活动分屏，切换分屏保留各自路径，后续同步无需再发送终端命令。
- 交互式 Bash 和 Zsh 验证原有提示符钩子仍执行，切换带中文和百分号的目录后会报告新路径，目录未变时不重复报告。

## 0.6.0 Monaco 远程编辑器

- 本机 Electron 软件渲染验收用鼠标拖选 C++ 中间一行的重复参数，校验选区实际位于该行。Tab、Shift+Tab、快捷键保存、GBK 与 CRLF 往返、编码转换和远端修改冲突提示均通过。
- JSON 文件在本地编辑窗口中显示语法错误，主终端窗口启动时没有加载 Monaco 资源。四分屏、多窗口、跨分屏与跨窗口传输回归通过。Windows 实机性能待验证。

## 0.7.0 应用设置

- 单元测试覆盖缓存迁移在重启后执行、只复制 Chromium 缓存、密码本默认关闭、跨重启去重与关闭清空。
- Electron 验收覆盖设置入口、选择缓存目录与迁移确认、系统安全存储生成密文、遮盖后选择再显示完整密码、关闭密码本保留会话密码、单击进入目录以及单击打开文件编辑器。终端、分屏互传和 Monaco 回归通过。

## 0.8.0 分屏工作台

- 本机 Electron 验证顶部设置入口、窗口菜单、背景取色即时预览、取消还原和恢复默认。自定义背景已写入配置并通过重新打开配置的测试，终端表面保持深色。
- 分屏、文件空间、跨窗口传输、远程编辑器和密码设置通过回归。Windows x64 便携包已交叉打包，原生标题栏按钮与拖动手感仍待 Windows 实机验证。

## 0.9.0 拖出远程文件

- 9 项自动测试通过。在 macOS Electron 中连接真实本地 SSH/SFTP 测试服务，使用模拟 Windows 辅助进程发出同样的管道请求，覆盖单文件字节一致、取消后不取文件内容、中文路径、嵌套目录、空目录、零字节文件和暂存清理。
- 本机 Electron 回归通过，包括原有拖放上传、分屏和跨窗口互传、远程编辑器及设置。已交叉编译 Windows x64 原生 OLE 辅助程序并随便携版打包。原生 OLE 与资源管理器的拖放交互以及拖放期间 Windows 终端的性能待实机验证。

## 0.9.1 远程编辑器强制保存

- macOS Electron 连接真实本地 SSH/SFTP 测试服务。普通保存拒绝覆盖新版本，强制保存确认后覆盖新版本，取消时保留远端文件，强制保存成功后可再次普通保存。
- 远端目标被删除或目录拒绝写入时显示失败原因，窗口中的草稿保留。9 项自动测试通过，Windows x64 便携版通过交叉打包。

## 0.9.2 终端显示修复

- 在 macOS Electron 中复现修复前终端网格超出实际显示区，末行底部超出 2.5 CSS 像素。修复后通过 100%、125%、150% 缩放和分屏迁移测试。
- 9 项自动测试通过。真实 Bash 长命令换行、历史键、多窗口和分屏互传均通过回归。Windows x64 便携版已交叉打包，Windows 字体与显示缩放下的效果待实机验证。

## 0.9.3 雾蓝灰工作台

- 10 项自动测试通过，覆盖旧默认色切换、保留自定义背景及恢复默认。macOS Electron 验证了实际界面、终端底色一致、100% / 125% / 150% 缩放和分屏、多窗口、SFTP 回归。
- 顶部工具组使用静态渐变和高光，软件渲染模式下通过界面测试。Windows x64 便携版已交叉打包，Windows 原生标题栏的视觉效果待实机验证。

## 0.10.0 会话导入导出

- 13 项自动测试通过，覆盖 Xshell 压缩包、中文分组、登录凭据隔离、OpenSSH 多别名和默认值、冲突更新与导出别名去重。
- macOS Electron 验证工作台菜单、预览、取消后重开、保留已有密码和 GBK 编码、导出及分屏、多窗口和设置回归。使用 `ssh -G -F` 校验了导出配置。Windows x64 便携版通过交叉打包，Windows 原生文件对话框待实机验证。

## 0.10.1 会话默认名称

- 14 项自动测试通过，覆盖空名称、手填名称、默认端口及 IPv6 名称格式。macOS Electron 验证表单留空可保存并连接，密码管理和会话导入导出通过回归。

## 0.10.2 Windows 拖放

- macOS Electron 使用鼠标输入测试「↗」起拖，确认远端互传的浏览器拖动不会抢占该手势。使用真实本机 SFTP 与模拟 Shell 辅助进程验证单文件、目录、取消、目标拒绝及暂存清理。分屏和跨窗口互传通过回归。
- Windows x64 Shell 辅助组件已交叉编译。增加了 Windows CI 原生数据对象测试，用于检查目录描述、文件索引、两种数据介质及松手前的行为。Windows 文件资源管理器的实际拖放仍待实机验证。

## 0.10.3 文件空间自动同步目录

- Electron 多分屏回归覆盖一格使用 Shell 目录报告，另一格使用独立 SSH 通道，分别显示不同的中文目录。验证进入文件空间时没有向两个交互终端写入任何内容。14 项自动测试、多窗口和 SFTP 互传通过。
- 在 Debian 容器中用真实 PTY 进程验证 Linux 目录探测和多个候选时的回退。此测试模拟 OpenSSH 的父子进程结构，容器已自动清理。Windows x64 便携版通过交叉打包。
