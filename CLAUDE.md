# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Clawd Pet：Tauri 2 桌宠（Rust 后端 + 无构建步骤的原生 HTML/JS 前端），通过 Claude Code 的 HTTP hook 反映会话状态，空闲时按作息自己过日子，并对系统事件做反应。只在 Windows 上开发和测试。界面文字和 README 用中文，代码注释用英文。

## 命令

```bash
npm install
npm run import-assets   # 从 ../clawd-400（或传入的路径）导入 GIF 到 ui/assets/clawd/（重编码为 40×40），生成 manifest.json
npm run dev             # 开发模式
npm run build           # 正式版：src-tauri/target/release/clawd-pet.exe + NSIS 安装包
npm run triggers        # 由 ui/anims.js 重新生成 docs/triggers.html
cd src-tauri && cargo check --release   # 只做类型检查，比 build 快得多
```

- 没有测试和 lint。验证方式是 `cargo check`，加上实际运行。
- `ui/assets/clawd/` 被 gitignore，是生成物；新克隆的仓库要先有 `../clawd-400` 并跑 `import-assets`，否则前端和 `npm run triggers` 都会缺 `manifest.json`。
- 端口 23490 兼作单实例锁：已有一只桌宠在跑时，新启动的实例（包括 `npm run dev`）会静默退出。`npm run build` 前也要先退出桌宠，否则 exe 被占用。开发版和正式版共用同一份配置 `%APPDATA%\dev.clawd.pet\config.json`。
- 开机自启只在正式版可用，注册表值 `HKCU\...\Run\ClawdPet` 指向构建出来的 exe。
- 调试 WebView：启动前设置环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，然后用 `http://127.0.0.1:9223/json` 列出页面，通过 CDP 执行 JS、截图（主窗口和设置窗口各是一个 page）。这个变量会整个替换 `tauri.conf.json` 里的 `additionalBrowserArgs`，所以值要写成那里的全部参数再加上 `--remote-debugging-port=9223`，否则调试时跑的是 GPU 渲染，和正式运行不一样。

## 架构

### 后端和前端之间

Rust 只负责「感知」和窗口，所有「演什么」都在前端决定。

- 后端发给前端的事件：`hook-event`、`permission-request`、`permission-closed`（来自 `server.rs`），`user-event { kind, detail }`（来自 `sysmon.rs` 和 `git.rs`），以及 `config`、`drag-end`、`play`、`play-random`、`shown`。
- 前端调用的命令都在 `main.rs` 的 `generate_handler!` 里注册；`window.__TAURI__` 是全局对象（`withGlobalTauri`），前端没有打包器和 import。

### Claude Code 联动

- `hooks.rs` 往 `~/.claude/settings.json` 写 `type: "http"` 的 hook（先备份为 `settings.json.clawd-pet.bak`）。它只识别、删改 URL 以 `http://127.0.0.1:23490/clawd-pet/` 开头的条目。
- `server.rs` 是手写在 std 上的 HTTP 服务：
  - `/clawd-pet/event` 立即应答。转发给前端的 `hook-event` 只带 `EVENT_FIELDS` 里列出的字段、`tool_input.command` 和后端加的 `_entry` / `_title`；prompt、文件内容、回复正文都不转发。`pet.js` 要读新字段时，先把它加进 `EVENT_FIELDS`。
  - `/clawd-pet/permission` 一直挂着连接，直到前端调用 `resolve_permission`，或者 Claude Code 断开连接（用户在原界面先作答了），断开时发 `permission-closed`。`permission-request` 带的是完整的请求内容，气泡要显示 `tool_input`。
- 中断（Esc、Desktop 停止按钮）不触发任何 hook，Desktop 也收不到 `idle_prompt`。`transcript.rs` 从 `UserPromptSubmit` 到 `Stop` 之间监听该会话的 transcript，读到 `[Request interrupted by user` 开头的用户消息，就发出一个合成的 `hook-event`，`hook_event_name` 为 `Interrupt`。

### 前端（`ui/`）

- `anims.js` 是「剧本」：全部用 `window.XXX = ...` 定义成全局（`ANIMS`、`LIFE`、`ROUTINE`、`MOODS`、`SYS_EVENTS` 等），按 slug 引用 clawd-400 的动画。`scripts/gen-triggers.mjs` 用 `node:vm` 执行这个文件来读取这些全局，所以它必须保持为普通脚本，不能改成 ES module。
- `pet.js` 是状态机：
  - 多会话状态，忙碌程度 waiting > compacting > working > thinking。
  - 空闲生活：场景由一串动画步骤组成，场景之间按活跃度休息，九个作息时段调整各类活动的权重。
  - 情绪（`feel(name, minutes)`）、睡眠、互动、气泡。
- 每个动画在 manifest 里有 `top` 字段（画面最高像素占高度的比例），渲染时写进 CSS 变量 `--content-top`，用来把气泡放在画面正上方。
- 素材是 40×40 的像素画（clawd-400 里是放大 12 倍的 480×480，导入时缩回去；不是整数倍放大的图会原样保留）。显示它们的 `<img>` 都要写固定宽高和 `image-rendering: pixelated`。
- 隐藏时暂停：WebView2 对隐藏的窗口照样渲染，所以收到 `shown: false` 后 `setShown` 会停掉 `tick`、撤下 `sprite` 的 `src`；会话状态照常跟踪，显示时恢复。

### 改了行为就要同步 `docs/triggers.html`

`docs/triggers.html` 提交在仓库里。`gen-triggers.mjs` 里有手写的说明表（`MOOD_INFO`、`SYS_INFO`、各个 `row({ how: ... })` 文案），里面写着时长、阈值这类数字。改了 `pet.js` 的时长或触发条件、或者改了 `anims.js` 之后，要更新这些文案，再跑 `npm run triggers`。

### 窗口和鼠标穿透（`main.rs`）

- 主窗口透明、置顶、整体默认鼠标穿透。前端用 `set_hit_rects` 上报可点区域（小螃蟹、气泡）。后台线程读光标位置来切换 `set_ignore_cursor_events`：光标在附近时每 40 ms 一次，远时每 200 ms 一次。
- 全屏让开（`step_aside`）：
  - 判定：前台窗口铺满小螃蟹所在的显示器、没有标题栏、不是 explorer，也不在例外名单里。
  - 显示和隐藏一律走 `sysmon::set_shown`（原生 `ShowWindow`），不要用 `w.hide()` / `w.show()`。那两个会改掉用户自己选择的显示状态，`show()` 还会抢走焦点；而且混用会让 tao 记录的可见状态跟实际不一致。
- 凡是显示或隐藏主窗口的地方（`step_aside`、`toggle_visible`），之后都要调 `tell_shown` 通知前端，否则隐藏期间页面还在全速渲染。
- 设置窗口用 `decorations(false)`，页面自己画标题栏。它要在新线程里创建：在主线程的事件回调里直接创建会死锁。
- WebView2 启动参数写在 `tauri.conf.json` 主窗口的 `additionalBrowserArgs` 里：
  - `--disable-gpu --in-process-gpu` 改用软件渲染、去掉 GPU 进程，内存少约 20 MB，代价是多占 1～2% 单核 CPU。
  - 设了这个字段就会替换 wry 的默认参数，所以 `--disable-features=msWebOOUI,...` 要一起保留。
  - 共用同一个数据目录的 WebView 启动参数必须一致，所以 `show_settings` 从主窗口的配置里读同一组参数；不要给设置窗口另写一份。

### 系统联动（`sysmon.rs`、`git.rs`）

原则是事件驱动，尽量不轮询；之前每 3 秒调一次 `SHQueryRecycleBinW` 就是 CPU 占用的大头。

| 什么 | 怎么来的 |
|---|---|
| 前台窗口切换、进出全屏 | `SetWinEventHook`，再把一个隐形窗口注册成 appbar，接收 `ABN_FULLSCREENAPP`；150 ms 去抖 |
| 文件夹、回收站 | `notify` 文件监听；回收站看各盘 `$Recycle.Bin\<SID>` 里 `$I*` 文件的增减 |
| Git | 设置里的开关在**全局 git 配置**里写入 `trace2.eventTarget` 等 4 项，git 把每条命令写成一个文件放进 `%APPDATA%\dev.clawd.pet\git-trace`；`git::read` 读完即删，只认用户直接执行且成功的命令 |
| 键鼠空闲、剪贴板序号、网络、电量 | 1 秒一次的轮询线程，只做读一个数的廉价调用 |

`~/.claude/settings.json` 的 hook 和全局 git 配置，都只在用户在设置里点开关时才改，不要在代码里或测试时自动写入。

### 配置（`config.rs`）

- 结构体带 `#[serde(default, rename_all = "camelCase")]`：新增字段会自动取默认值，改名时用 `#[serde(alias = ...)]` 兼容旧配置。
- 改默认值不会影响已经存在的配置文件。
- `set_config` 是设置页的唯一写入口；它会按需重设窗口大小、重建文件监听（`rewatch`），并重新判断全屏让开。
