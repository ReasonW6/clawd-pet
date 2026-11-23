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

- 后端发给前端的事件：`hook-event`、`permission-request`、`permission-closed`（来自 `server.rs`），`user-event { kind, detail }`（来自 `sysmon.rs` 和 `git.rs`），`ai { id, kind, text }`（来自 `ai.rs`，AI 聊天的流式回复），`edges`（来自 `edges.rs`），以及 `config`、`drag-end`、`play`、`play-random`、`shown`；发给设置窗口的有 `memory`（记忆变了，重新读）和 `config`（只在聊天改了设置时）；只发给主窗口的还有 `dream`（做梦开始、结束）。
- 前端调用的命令都在 `main.rs` 的 `generate_handler!` 里注册；`window.__TAURI__` 是全局对象（`withGlobalTauri`），前端没有打包器和 import。

### Claude Code 联动

- `hooks.rs` 往 `~/.claude/settings.json` 写 `type: "http"` 的 hook（先备份为 `settings.json.clawd-pet.bak`）。它只识别、删改 URL 以 `http://127.0.0.1:23490/clawd-pet/` 开头的条目。
- `server.rs` 是手写在 std 上的 HTTP 服务：
  - `/clawd-pet/event` 立即应答。转发给前端的 `hook-event` 只带 `EVENT_FIELDS` 里列出的字段、`tool_input.command` 和后端加的 `_entry` / `_title`；prompt、文件内容、回复正文都不转发（回复只有 `transcript.rs` 读出的第一行，见下）。`pet.js` 要读新字段时，先把它加进 `EVENT_FIELDS`。
  - `/clawd-pet/permission` 一直挂着连接，直到前端调用 `resolve_permission`，或者用户在原界面先作答了，这时发 `permission-closed`。`permission-request` 带的是完整的请求内容，气泡要显示 `tool_input`。
  - 终端里在原界面作答，Claude Code 会断开连接。桌面版不会：它让钩子和应用内的弹窗同时跑，用户在应用里答完也不取消钩子，连接要挂到超时。所以要从后面发生的事看出请求已经答过了：
    - 对应到具体调用：PermissionRequest 不带 `tool_use_id`，紧挨在它前面的 `PreToolUse` 带。`Shared::observe` 记下最近的 `PreToolUse`，请求到来时按会话、子代理 `agent_id`、工具名和输入认领一个（`claim`）。之后同一个 `tool_use_id` 的 `PostToolUse` / `PostToolUseFailure` 到了，就放掉请求。
    - Bash / PowerShell 在应用里允许后马上开跑，`PostToolUse` 要等命令跑完。Claude Code 每次跑命令都在 `<temp>\claude\<hash>\<会话 id>\tasks` 里新建一个 `b*.output`（`a*.output` 是子代理的，不算），`ShellRuns` 在等待循环里每 200 ms 看一眼，出现新文件就当已允许。只在这个会话没有别的挂着的会建输出文件的请求（Bash、PowerShell、Monitor）、也没有别的进行中的调用（`calls` 里没认领的，只等子代理的 Agent / Task 不算）时才算数，免得把并行的另一条命令当成它。子代理的命令、后台命令和 Monitor 也往会话的这个目录建文件，而后台命令和 Monitor 立刻返回、文件留着，所以还要看会话的 PreToolUse 计数（`Shared::begun`）：从这个请求自己的 PreToolUse 算起、到这次看文件为止有别的调用开始了，新文件就不算。看到的文件不管算不算都记下，之后不再算。这是 Claude Code 内部的目录结构，找不到就照旧等 `PostToolUse`。
    - 在应用里拒绝并留言时，这一轮接着跑，没有任何 hook；`transcript.rs` 看到用户消息里那次调用的 `tool_result`（按 JSON 认，不只是字符串里出现 id）就调 `server::answered`。中断时调 `server::interrupted`，放掉整个会话的请求，子代理的也算（子代理的 transcript 不监听）。
    - 这一轮结束也放掉（`Stop`、`SubagentStop`、`UserPromptSubmit`，只放同一个线程的；`SessionEnd` 放掉整个会话的）。
    - `/event` 先 `observe` 再回包：Claude Code 等着这个回包，所以下一个请求不会抢在这个事件之前。
    - `permission-closed` 带 `answered`：只是等满超时放弃的为 false，这时 Claude Code 还在原界面等着，前端保持「等你确认」。还带 `outcome`：调用跑起来或跑完了（`ShellRuns`、`PostToolUse`、transcript 里那次调用真的跑过的结果）为 `"allow"`；用户拒绝了（transcript 里用户记录的 `toolDenialKind` 是 `user-rejected`，没有这个字段的旧版本看结果是否以 `DENIALS` 的固定文字开头）为 `"deny"`；终端断开、一轮结束、被叫停，或者结果是没跑成的那几种（`toolDenialKind` 是别的值，或旧版本里以 `[`、「The user doesn't want to take this action」开头，或带「Correction to the text above」：允许后又被停下）时看不出来，为 null。transcript 里读到中断时先放掉整个会话的请求，再看结果，所以不留言的拒绝和中断都是 null，播叫停的动画。前端按它播和在气泡里作答一样的动画。
- `transcript.rs` 从一轮的第一个事件到 `Stop` 之间监听该会话的 transcript，补上 hook 不报的两样东西，都作为合成的 `hook-event` 发出。不是每一轮都从 `UserPromptSubmit` 开始（后台任务回来、桌面版唤醒会话都会自己开一轮），所以 `PreToolUse` 等事件也会开始监听；`UserPromptSubmit` 则把读取位置挪到文件末尾，免得把上一轮的中断标记算进来。只有主线程的事件（不带 `agent_id`）会开始监听和挪位置。两小时既没有事件、文件也没写入的，就停止监听（桌面版退出时，会话没有 `Stop` 就没了）。
  - `Interrupt`：中断（Esc、Desktop 停止按钮）不触发任何 hook，Desktop 也收不到 `idle_prompt`；读到 `[Request interrupted by user` 开头的用户消息就发。
  - `Reply`：Claude 每写完一个文本块，transcript 就追加一条 assistant 记录；只取第一行（去掉 Markdown 记号，截到 80 字）放进 `text`。这是唯一转发的回复内容，设置里的 `replies` 关掉时不读。收到 `Stop` 时先把文件再读一遍再停止监听，最后一句才不会漏，所以 `Reply` 总在 `Stop` 之前到前端。
- 子代理的事件带 `agent_id`（会话 id 和主线程一样）。子代理自己的 `UserPromptSubmit` 不算会话的新一轮；会话已经回到待命时，子代理的 `PreToolUse` / `PostToolUse` / `PostToolUseFailure` 也不再让它忙起来：后台子代理会比这一轮活得久，中断后也可能还有零星事件。
- 嵌套会话（`desktop_sessions.rs`）：桌面版的 /btw 分支、侧会话在 Claude Code 里是独立的会话，hook 不带来源。桌面版自己的会话记录 `<数据目录>\claude-code-sessions\<账号>\<组织>\local_<应用 id>.json` 里有：`cliSessionId` 是 hook 里的 `session_id`，`spawnedFrom.sessionId` 是来源会话的应用 id。数据目录在商店版是 `%LOCALAPPDATA%\Claude-Data\<包名>`，否则是 `%APPDATA%\Claude`。`cliSessionId` 总在文件开头，所以只读每个文件的前 256 字节来找；还没有记录的会话，全部记录最多每 5 秒重新搜一遍。来源会话被 rewind 后 `cliSessionId` 会变，所以每 30 秒重读一次它的文件开头。找到的来源作为 `_parent` / `_parent_title` / `_parent_cwd` 加进事件。前端用 `rootOf` 把一家子归到最上面那个会话名下，一家子都停了才庆祝完成。用过桌面版开会话的工具（`SPAWN_TOOLS`）的那一轮，结束后先等 8 秒，让刚开的会话报到。这是桌面版的内部格式，读不到就当没有来源。
- 点完成气泡切到桌面版会话（`claude_app.rs`）：桌面版的 `claude://code/<id>` 被功能开关关着，要的也是应用内部的 id，所以用 UI Automation 在它的侧边栏里按会话标题找 Invoke 按钮去点（行的名字是「标题」或「标题 运行中」这样带状态的）。依赖 `windows` crate（和 tauri 用的同一版本），只用于这里的 COM 调用；其余 Win32 调用仍用 `windows-sys`。`SetForegroundWindow` 只在桌宠刚被点过、自己是前台时才管用，所以 `focus_claude` 要在点击处理里同步调用，不能等。

### 记忆（`memory.rs`）

`ai.enabled && memory.enabled` 都开着才工作；关着时前端不发事件、后端也不写文件、不发请求（后端收到命令和应用结果前都会再查一遍）。

- 存储在 `~/.clawd-pet/memory/`：`note.md` 是一篇固定篇幅（约 1200 字）、分五节的笔记，每次聊天整篇放进系统提示（`for_chat` → `ai::start` 的 `memory` 参数）；`state.json` 是关系（`Bond`）、上次做梦以来按天的事件计数（`pending`）、要主动提起的话（`topics`）。状态在内存里改，置脏后由 `main.rs` 的 2 秒保存循环和退出时 `flush`；写盘一律先写 `.tmp` 再 rename。
- 一天从 05:00 算起。Cargo 里没有 chrono，逻辑日期由前端（`memDay()`）算好随每个命令传来；后端收到某天的第一条事件时数天数、判里程碑。
- 笔记的改写都走 `ai::complete`：复用聊天的 `send`（同样流式，`Speaker` 不带 `app` 就不往前端发），不带工具和搜索，推理取该模型最低档。`each_event` 用 `live` 判断要不要继续，所以新开、关掉聊天不会掐断它。
  - 聊天中：记忆开着、模型又不在 `NO_TOOLS` 里时，`Kit` 多一个 `remember` 工具（`memo`），由模型自己判断要不要记；后端 `memory::memo` 把变更追加到 `memos` 并马上写盘，发 `ai { kind: "remember" }`。拼记忆段时 `memos` 附在笔记后面。模型拒绝工具时随截图工具一起去掉。
  - `merge`：前端在聊天关闭时调 `memory_merge`，带上 `chat.log`。`memos` 不为空就合进笔记；模型用不了工具（`ai::without_tools`）时改看聊天记录，先过本地筛选（`worth`）。启动时 `memos` 不为空也补做一次。看过屏幕或上过网的聊天只交用户的话。
  - 合并和做梦都把当时的 `memos` 一起交给模型，应用结果时在同一把锁里删掉这几条。
  - `dream`（`Why`）：每个睡眠窗口（午睡、夜里）第一次睡着时（`fallAsleep`），或新的一天第一条事件到来而还有更早的日子没整理时（补做，只整理更早的日子）。没有新的天数也没有 `memos` 就不调模型（只有 `"day"` 这类什么都没数的事件不算新的一天，`event` 不为它建 `pending` 条目）；每次触发只试一次（`rewrite` 内部重试一遍）。午睡的 topics 只有 `anytime`。做梦中的天数先挪到 `dreaming`，失败或中途退出就并回 `pending`。设置页的「现在整理一次」等 `memory_dream` 返回（命令等梦做完才返回）；手动整理同时只有一个（`MANUAL`），它在跑也写在 `memory_get` 里，重开设置页也看得到。真正调模型时前后各发一次 `dream`（`true` / `false`）给主窗口，桌宠睡着的话按睡姿轮播 `ANIMS.dreamNight` / `dreamNap`，结束后再演 90 秒。
  - 同一时间只跑一个改写（`JOB`）；拿快照时记下 `version`，回来发现用户在设置里改过笔记就基于新笔记重做一次。`version` 只增不减，「全部忘掉」也不归零。「全部忘掉」还会让 `FORGETS` 加一；合并和做梦在拿到要整理的内容时记下它，改写时发现变了就放弃，不把忘掉前拿到的东西写回去。
  - 模型回复没有新笔记（`{"changed": false}`）时 `memos` 留着，等下一次合并或做梦；连着 `MAX_UNMERGED` 次都没合进去就丢掉（新记一条重新计数）。补做的梦紧接着昨晚的夜里那次梦（`last_night`）时，不换掉那次准备的、还没说的 topics，也不让模型再写；之后别的梦换掉了 topics，就清掉 `last_night`。
- 笔记用中立的第三人称写，不带人设口吻；只有 `topics` 按做梦时的人设写，并记下人设 id，换了人设就丢掉。
- 称呼和生日以设置为准：`remember` 的说明和整理的提示词都不让记这两样，笔记里已有的在下次整理时删掉；聊天的系统提示直接从配置带上它们。聊天里改称呼走 `change_setting`。
- 事件只记计数、时长和项目文件夹名，不记会话标题（桌面版的标题是从用户的话里生成的）。

### 聊天改设置（`change_setting`）

模型支持工具调用时（和记忆开关无关），`Kit` 带 `change_setting { key, value }`，由 `main.rs` 的 `change_setting` 执行：只认白名单里的几项（`nickname`、`birthday`、`chatty`、`liveliness`、`sedentaryMinutes`、`sleepEnabled`、`size`），按设置页的范围严格校验，再和 `set_config` 一样经 `apply_config` 生效（窗口大小、保存、发 `config`）。设置页自己保存的 `config` 只发给主窗口；聊天改的发给所有窗口，设置页对照它记下的后端配置（`known`），只同步聊天改了的项（`onConfig`），免得之后保存时把改动盖掉，也不盖掉还没保存的输入。工具结果告诉模型改了什么，前端在回复上只显示「⚙️ 改了设置」；一轮最多 3 次；模型用不了工具时，提示词让它请用户去设置里改。

### 前端（`ui/`）

- `anims.js` 是「剧本」：全部用 `window.XXX = ...` 定义成全局（`ANIMS`、`LIFE`、`ROUTINE`、`MOODS`、`SYS_EVENTS` 等），按 slug 引用 clawd-400 的动画。`scripts/gen-triggers.mjs` 用 `node:vm` 执行这个文件来读取这些全局，所以它必须保持为普通脚本，不能改成 ES module。
- `markdown.js` 定义 `window.renderMarkdown`，把聊天回复画成 HTML（回复每打出几个字就整段重画一次）。它先转义全部文字，只输出自己拼的标签：回复可能转述网页内容，不能把模型的 HTML 放进页面（页面能调后端命令）。链接只放行 http(s) 和 mailto，点击走 `open_link` 用默认浏览器打开；图片只画成链接，不加载（加载远程图片能把内容带出去）。`**粗体**` 用宽松匹配，挨着中文标点也能闭合。公式交给 `ui/vendor/katex/katex.min.js`（从 npm 的 katex 包原样复制，带 LICENSE），第一次遇到公式才插 `<script>` 加载，输出 MathML，不需要 KaTeX 的样式和字体；加载完回调重画那条回复。
- 聊天气泡的尺寸由弹簧控制，目标是 `.body` 的尺寸加上卡片两侧的边框（`CARD_BORDER`）。少算边框的话卡片比内容小，能被滚动（输入法、光标会把它滚上去），停下后橙色底就够不到卡片底部。
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
- 屏幕边缘（`edges.rs`）：
  - `set_hit_rects` 同时带上 `body`（`#pet-hit` 的位置）。窗口被子类化，在 `WM_MOVING` 里改系统要移到的位置：小螃蟹的身体不出光标所在显示器的工作区，窗口顶端也不出（上面是气泡的地方），除非窗口比工作区还高，这时身体优先。所以拖到边上就停住，而不是松手后再弹回来。
  - 不经过拖动的移动由 `fit` 挪回来：身体位置变了（`set_body`，改大小、开关聊天后页面会报新的身体位置，所以 `resize_anchored` 自己不调 `fit`：那时 `BODY` 还是旧布局的）、DPI 变了（子类里在 `DefSubclassProc` 之后处理 `WM_DPICHANGED`，tao 那时才把窗口挪到位；不要放进 `ScaleFactorChanged` 或 `Resized`）、显示器或任务栏变了。
  - 窗口比小螃蟹宽，靠左右边时有一部分在屏幕外，拖到任务栏上时底部也在外面。`edges` 事件告诉前端每边各有多少（逻辑像素，只在变了时发；页面启动时用 `get_edges` 取一次），前端写进 CSS 变量 `--off-*`：气泡区、聊天栏缩进能看见的部分，状态标签变窄、抬高。`placeBubble` 把气泡尽量放在小螃蟹正上方，尾巴位置（`--tail-x`）跟着算；聊天栏由 `fitChat` 定位，`placeX` 按小螃蟹在栏里的位置（`petX`，不一定是栏的正中）放尾巴。
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
