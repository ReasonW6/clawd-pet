# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Clawd Pet：Tauri 2 桌宠（Rust 后端 + 无构建步骤的原生 HTML/JS 前端），通过 Claude Code 的 HTTP hook 反映会话状态，空闲时按作息自己过日子，并对系统事件做反应。只在 Windows 上开发和测试。界面文字和 README 用中文，代码注释用英文。

## 命令

```bash
npm install
npm run import-assets   # 从 ../clawd-400-src（没有就用 ../clawd-400，或传入的路径）导入 GIF 到 ui/assets/clawd/（重编码为 40×40），生成 manifest.json
npm run dev             # 开发模式
npm run build           # 正式版：src-tauri/target/release/clawd-pet.exe + NSIS 安装包
npm run triggers        # 由 ui/anims.js 重新生成 docs/triggers.html
cd src-tauri && cargo check --release   # 只做类型检查，比 build 快得多
```

- 没有测试和 lint。验证方式是 `cargo check`，加上实际运行。
- `ui/assets/clawd/` 被 gitignore，是生成物；新克隆的仓库要先有素材来源并跑 `import-assets`，否则前端和 `npm run triggers` 都会缺 `manifest.json`。
- 素材来源有两种，manifest 格式不同，`import-assets` 都能读：
  - `../clawd-400-src`：clawd-400 仓库的克隆。动画是 `scenes/*.py` 里的场景代码，在那里改完跑 `python generate.py` 重写 `gifs/` 和 `manifest.json`（几秒钟，结果是确定的），再回来 `import-assets`。修改动画走这条路，步骤见 README「修改动画」。
  - `../clawd-400`：预览网站下载的打包版，只能导入。
  - 桌宠自己的动画（`git_*`、`cc_*`）在本仓库 `scenes/*.py`，写法同 clawd-400 的场景。来源是克隆时，`import-assets` 先调 `python scripts/render-scenes.py` 用克隆里的引擎渲染它们（输出到系统临时目录），再和 400 个一起导入；slug 重复会报错。用打包版导入时它们会缺失。改完用 `python ../clawd-400-src/render.py scenes/x.py --out <目录> --sheet` 看逐帧拼图，`lint.py` 查画风。
  - 动画时长 `ms` 从 GIF 实际播放的帧算，不用源 manifest 里的数字。
- 端口 23490 兼作单实例锁：已有一只桌宠在跑时，新启动的实例（包括 `npm run dev`）会静默退出。`npm run build` 前也要先退出桌宠，否则 exe 被占用。开发版和正式版共用同一份配置 `%USERPROFILE%\.clawd-pet\config.json`（新位置还没有配置时，启动会从旧位置 `%APPDATA%\dev.clawd.pet\config.json` 复制一份过来）。
- 开机自启只在正式版可用，注册表值 `HKCU\...\Run\ClawdPet` 指向构建出来的 exe。
- Claude 桌面版是 MSIX 打包应用，从 Claude Code 里启动的进程（`npm run dev`、直接运行 exe、运行安装包）都在它的容器里：
  - 对 `%APPDATA%`、`%LOCALAPPDATA%` 和 HKCU 的写入被重定向到 `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache` 和 Claude 的私有注册表，读到的也是合并后的视图。自启动和卸载登记也会只写进虚拟注册表。用户目录本身和 `%TEMP%` 是共享的，所以配置和 git-trace 都放在 `~/.clawd-pet` 下，不放进 AppData。
  - Claude 退出时，这些进程会被一起结束。
  - 要让桌宠独立运行，或者读写真实的配置和注册表，用 `explorer.exe <exe 或 .cmd>` 转手启动。
- 调试 WebView：启动前设置环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`，然后用 `http://127.0.0.1:9223/json` 列出页面，通过 CDP 执行 JS、截图（主窗口和设置窗口各是一个 page）。这个变量会整个替换 `tauri.conf.json` 里的 `additionalBrowserArgs`，所以值要写成那里的全部参数再加上 `--remote-debugging-port=9223`，否则调试时跑的是 GPU 渲染，和正式运行不一样。

## 架构

### 后端和前端之间

Rust 只负责「感知」和窗口，所有「演什么」都在前端决定。

- 后端发给前端的事件：`hook-event`、`permission-request`、`permission-closed`（来自 `server.rs`），`user-event { kind, detail }`（来自 `sysmon.rs` 和 `git.rs`），`ai { id, kind, text }`（来自 `ai.rs`，AI 聊天的流式回复），以及 `config`、`drag-end`、`play`、`play-random`、`shown`。
- 前端调用的命令都在 `main.rs` 的 `generate_handler!` 里注册；`window.__TAURI__` 是全局对象（`withGlobalTauri`），前端没有打包器和 import。

### Claude Code 联动

- `hooks.rs` 往 `~/.claude/settings.json` 写 `type: "http"` 的 hook（先备份为 `settings.json.clawd-pet.bak`）。它只识别、删改 URL 以 `http://127.0.0.1:23490/clawd-pet/` 开头的条目。
- `server.rs` 是手写在 std 上的 HTTP 服务：
  - `/clawd-pet/event` 立即应答。转发给前端的 `hook-event` 只带 `EVENT_FIELDS` 里列出的字段、`tool_input.command` 和后端加的 `_entry` / `_title`；prompt、文件内容、回复正文都不转发（回复只有 `transcript.rs` 读出的第一行，见下）。`pet.js` 要读新字段时，先把它加进 `EVENT_FIELDS`。
  - `/clawd-pet/permission` 一直挂着连接，直到前端调用 `resolve_permission`，或者用户在原界面先作答了，这时发 `permission-closed`。`permission-request` 带的是完整的请求内容，气泡要显示 `tool_input`。
  - 终端里在原界面作答，Claude Code 会断开连接。桌面版不会：它让钩子和应用内的弹窗同时跑，用户在应用里答完也不取消钩子，连接要挂到超时。所以要从后面发生的事看出请求已经答过了：
    - 对应到具体调用：PermissionRequest 不带 `tool_use_id`，紧挨在它前面的 `PreToolUse` 带。`Shared::observe` 记下最近的 `PreToolUse`，请求到来时按会话、子代理 `agent_id`、工具名和输入认领一个（`claim`）。之后同一个 `tool_use_id` 的 `PostToolUse` / `PostToolUseFailure` 到了，就放掉请求。
    - 在应用里拒绝并留言时，这一轮接着跑，没有任何 hook；`transcript.rs` 看到那次调用的 `tool_result`（`"tool_use_id":"…"`）就调 `server::answered`。中断时调 `server::interrupted`。
    - 这一轮结束也放掉（`Stop`、`SubagentStop`、`UserPromptSubmit`，只放同一个线程的；`SessionEnd` 放掉整个会话的）。
    - `/event` 先 `observe` 再回包：Claude Code 等着这个回包，所以下一个请求不会抢在这个事件之前。
    - `permission-closed` 带 `answered`：只是等满超时放弃的为 false，这时 Claude Code 还在原界面等着，前端保持「等你确认」。
- `transcript.rs` 从一轮的第一个事件到 `Stop` 之间监听该会话的 transcript，补上 hook 不报的两样东西，都作为合成的 `hook-event` 发出。不是每一轮都从 `UserPromptSubmit` 开始（后台任务回来、桌面版唤醒会话都会自己开一轮），所以 `PreToolUse` 等事件也会开始监听；`UserPromptSubmit` 则把读取位置挪到文件末尾，免得把上一轮的中断标记算进来。只有主线程的事件（不带 `agent_id`）会开始监听和挪位置。两小时既没有事件、文件也没写入的，就停止监听（桌面版退出时，会话没有 `Stop` 就没了）。
  - `Interrupt`：中断（Esc、Desktop 停止按钮）不触发任何 hook，Desktop 也收不到 `idle_prompt`；读到 `[Request interrupted by user` 开头的用户消息就发。
  - `Reply`：Claude 每写完一个文本块，transcript 就追加一条 assistant 记录；只取第一行（去掉 Markdown 记号，截到 80 字）放进 `text`。这是唯一转发的回复内容，设置里的 `replies` 关掉时不读。收到 `Stop` 时先把文件再读一遍再停止监听，最后一句才不会漏，所以 `Reply` 总在 `Stop` 之前到前端。
- 子代理的事件带 `agent_id`（会话 id 和主线程一样）。子代理自己的 `UserPromptSubmit` 不算会话的新一轮；会话已经回到待命时，子代理的 `PreToolUse` / `PostToolUse` / `PostToolUseFailure` 也不再让它忙起来：后台子代理会比这一轮活得久，中断后也可能还有零星事件。
- 嵌套会话（`desktop_sessions.rs`）：桌面版的 /btw 分支、侧会话在 Claude Code 里是独立的会话，hook 不带来源。桌面版自己的会话记录 `<数据目录>\claude-code-sessions\<账号>\<组织>\local_<应用 id>.json` 里有：`cliSessionId` 是 hook 里的 `session_id`，`spawnedFrom.sessionId` 是来源会话的应用 id。数据目录在商店版是 `%LOCALAPPDATA%\Claude-Data\<包名>`，否则是 `%APPDATA%\Claude`。`cliSessionId` 总在文件开头，所以只读每个文件的前 256 字节来找；还没有记录的会话，全部记录最多每 5 秒重新搜一遍。来源会话被 rewind 后 `cliSessionId` 会变，所以每 30 秒重读一次它的文件开头。找到的来源作为 `_parent` / `_parent_title` / `_parent_cwd` 加进事件。前端用 `rootOf` 把一家子归到最上面那个会话名下，一家子都停了才庆祝完成。用过桌面版开会话的工具（`SPAWN_TOOLS`）的那一轮，结束后先等 8 秒，让刚开的会话报到。这是桌面版的内部格式，读不到就当没有来源。
- 点完成气泡切到桌面版会话（`claude_app.rs`）：桌面版的 `claude://code/<id>` 被功能开关关着，要的也是应用内部的 id，所以用 UI Automation 在它的侧边栏里按会话标题找 Invoke 按钮去点（行的名字是「标题」或「标题 运行中」这样带状态的）。依赖 `windows` crate（和 tauri 用的同一版本），只用于这里的 COM 调用；其余 Win32 调用仍用 `windows-sys`。`SetForegroundWindow` 只在桌宠刚被点过、自己是前台时才管用，所以 `focus_claude` 要在点击处理里同步调用，不能等。

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
| Git | 设置里的开关在**全局 git 配置**里写入 `trace2.eventTarget` 等 4 项，git 把每条命令写成一个文件放进 `%USERPROFILE%\.clawd-pet\git-trace`（不放在 AppData 里，见上面 MSIX 容器那条；配置还指向旧位置 `%APPDATA%\dev.clawd.pet\git-trace` 时，打开开关会把它改过来）；`git::read` 读完即删，只认用户直接执行且成功的命令 |
| 键鼠空闲、剪贴板序号、网络、电量 | 1 秒一次的轮询线程，只做读一个数的廉价调用 |
| Claude 桌面版启动、退出 | 启动时用进程快照找已经开着的主进程（不算启动）；之后前台窗口属于一个没在跟踪的桌面版主进程（路径在 `WindowsApps\Claude_` 或 `AnthropicClaude` 下，不是 Claude Code 的 `claude.exe`）就是 `claude-open`。跟踪靠一个线程 `WaitForSingleObject` 等进程结束，结束发 `claude-quit`，前端顺带清掉 `claude-desktop` 的会话。会话的 `SessionStart` / `SessionEnd` 本身不播动画（桌面版会自己随时启停会话进程） |

`~/.claude/settings.json` 的 hook 和全局 git 配置，都只在用户在设置里点开关时才改，不要在代码里或测试时自动写入。

### 配置（`config.rs`）

- 结构体带 `#[serde(default, rename_all = "camelCase")]`：新增字段会自动取默认值，改名时用 `#[serde(alias = ...)]` 兼容旧配置。
- 改默认值不会影响已经存在的配置文件。
- `set_config` 是设置页的唯一写入口；它会按需重设窗口大小、重建文件监听（`rewatch`），并重新判断全屏让开。
