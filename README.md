# Clawd Pet

一只住在桌面上的像素小螃蟹。它实时反映 Claude Code（终端 / Desktop App / VS Code）的工作状态，能直接在气泡里批准或拒绝权限请求；没活干的时候有自己的作息，还会对你在电脑上的操作做出反应。

动画素材来自 [Clawd 400](https://github.com/khiqwq/clawd-400)（400 个 GIF，见[致谢](#致谢)），技术栈是 Tauri 2 + 原生 HTML/JS。目前只在 Windows 上开发和测试。

## 运行

```bash
npm install
npm run import-assets   # 从 ../clawd-400-src（没有就用 ../clawd-400）导入素材到 ui/assets/clawd（缩回 40×40 的原始像素尺寸），并量出每个动画的画面顶部（气泡定位用）
npm run dev             # 开发模式
npm run build           # 打包：target/release/clawd-pet.exe 和 NSIS 安装包
npm run triggers        # 重新生成 docs/triggers.html（动画触发一览）
```

启动后右键小螃蟹（或双击托盘图标）打开设置：

- **Claude 联动 → 安装联动**：接上 Claude Code。
- **性格 → 开机自启**：登录 Windows 后自动出现。只有打包后的正式版可用；开发版依赖开发服务器，不会注册自启。
- **性格 → 全屏时让开**（默认开）：前台窗口是全屏的游戏或视频（独占全屏或无边框窗口）、并且占满小螃蟹所在的那块屏幕时，它自动隐藏，退出全屏后回来。普通的最大化窗口不算。「例外的程序」里的程序全屏时它照样留着，默认已经放了主流浏览器（Chrome、Edge、Firefox、Brave、Opera、Vivaldi、Zen、Arc、ego lite、360、QQ、搜狗、夸克等）和视频软件（PotPlayer、VLC、mpv、MPC、KMPlayer、Windows 媒体播放器、Kodi、Plex、QQ 影音、迅雷影音、腾讯视频、爱奇艺、优酷、哔哩哔哩），全屏看视频时它会陪着你。

每个动画什么时候播、怎么触发、播多久，见 [`docs/triggers.html`](docs/triggers.html)（用浏览器打开，带动画预览）。

## Claude Code 联动

```
Claude Code HTTP hooks ──POST──▶ 127.0.0.1:23490 (Rust) ──event──▶ WebView 状态机 ──▶ GIF
```

- 联动会往 `~/.claude/settings.json` 写入一组 `type: "http"` 的 hook（写之前备份为 `settings.json.clawd-pet.bak`），只识别并删改 URL 以 `http://127.0.0.1:23490/clawd-pet/` 开头的条目，不碰其他 hook。
- 请求头 `X-Clawd-Entry` 带上 `$CLAUDE_CODE_ENTRYPOINT`，用来区分终端（`cli`）、Desktop（`claude-desktop`）和 VS Code 会话。
- 审批气泡和小螃蟹下方的标签显示会话标题（Desktop 侧边栏里的名字，或 `/rename` 起的名字，读自 transcript 里的 `custom-title`）；没有标题时显示「来源 · 项目名」。
- `PermissionRequest` 会挂起连接，等你在气泡里点「允许 / 总是允许 / 拒绝」；如果你在终端或 Desktop 里先作答，Claude Code 会断开连接，气泡自动消失。`AskUserQuestion` / `ExitPlanMode` 始终交给原界面。
- 桌宠没运行时，hook 连接会立刻失败，Claude Code 按原流程继续，不受影响。

| Claude Code | 小螃蟹 |
|---|---|
| 提交提问 | 思考 |
| 编辑 / 读文件 / 搜索 | 打字、笔记本、黑客帝国（偶尔暴躁砸键盘）/ 看书 / 放大镜找 bug |
| Bash：git / 测试 / 装依赖 / 编译 / 其他 | 提交图 / 测试全绿 / 依赖太重 / 进度条 / 终端 |
| 子代理 / 压缩上下文 / `/clear` | 结对编程 / 打包 ZIP / 扫地 |
| 等待权限 | 举着 PLS 牌子 + 审批气泡；允许后点赞，拒绝后垂头丧气 |
| 任务跑了 5 分钟以上 | 时不时来杯咖啡；完成时放火箭并报告耗时 |
| 完成 / 工具失败 / 连错 3 次 / API 出错 | 庆祝 / 捂脸 / 「着火了但没事」/ 蓝屏 |
| 按 Esc / Desktop 停止按钮中断 | 回到待命（中断不触发 Stop，桌宠盯着会话记录里的中断标记） |
| 完成时键鼠一阵没动静 | 「搞定啦」的气泡一直留着，你碰电脑时再提醒一次 |

多个会话同时进行时，显示最紧急的那个（等你确认 > 压缩 > 干活 > 思考）。

## 自己的生活

Claude 没活给它的时候，它演完一个「场景」歇一会儿，再演下一个。一个场景是一到几个动画接成的小段落（戴厨师帽 → 炒菜 → 搅汤 → 吃面），每个 20–50 秒。

- **作息**：一天分九个时段（早晨、上午、午饭、午后、下午茶、傍晚、晚饭、晚间、深夜），各有专属场景，还会调整其他活动的多少：傍晚多运动，晚间多音乐和变装，深夜只做安静的事。
- **随时可能做的事**：爱好、音乐、运动、角色扮演、家务、折腾小项目、当季活动，偶尔出个小意外。做完一种有四成可能接着做同一种，所以会连着练几项、连换几套衣服。
- **情绪**：干完活开心，长任务完成后得意，被摸摸后害羞，被连点后闹脾气，连续出错后郁闷，睡前犯困。情绪会持续几分钟，换掉它歇着的姿势，也多出对应的场景；鼠标悬停能看到当前心情。
- **没人理它时**：键盘鼠标一阵没动静（默认 5 分钟；你可能走开了，也可能在看视频），它会多做运动、玩变装，先是无聊，久了会想你。你一碰电脑它就高兴起来。
- **睡觉**：只在设置的时段睡（默认 13:00–14:00 打盹、22:30–07:00 睡觉）。晚上先刷牙、打哈欠再钻被窝；Claude 开工会惊醒它，忙完接着睡；到点拍闹钟起床伸懒腰，接上早晨的洗漱和早餐。
- **节日**：元旦、春节、元宵、端午、七夕、中秋、万圣节、圣诞、你的生日等当天有专属动画和问候。农历节日用的是 2026–2030 的日期表。
- **陪伴**：开机问候、饭点提醒、久坐提醒。

活动多少由设置里的「活跃度」决定：悠闲约三分之一时间在活动，活泼约六成，闹腾约八成。「Claude 在干活」的那些动画（打字、终端、思考…）不会出现在它自己的生活里，看一眼就能分清。

## 系统联动

对你在 Claude Code 之外的操作做出反应。只感知「发生了什么」，不读取文件内容、剪贴板内容和按键；Claude 干活时这些反应自动让路。每项都可以在设置里单独开关。

| 你做了什么 | 怎么知道的 | 反应 |
|---|---|---|
| 文件进了文件夹 / 压缩打包 / 下载完成 / 截图 | 监听指定文件夹里新出现的文件名 | 拖进文件夹 / 压缩打包 / 快递送达 / 拍照 |
| 删文件 / 清空回收站 | 监听回收站文件夹里条目记录的增减 | 倒垃圾 / 大扫除 |
| 复制粘贴 | 剪贴板序号变化 | 复制粘贴 |
| 电量低 / 插电 / 断网 / 联网 | 系统电源与网络状态 | 没电了 / 插线 / 找信号 / 松口气 |
| 切换深色模式 | 系统主题 | 深色模式 |
| 切到音乐、视频、聊天等软件（默认关闭） | 前台窗口的进程名 | 戴耳机、吃爆米花、打电话… |
| 任何仓库里的 Git 操作：提交、合并、推送、克隆、切分支、撤销（默认关闭） | git 自己上报命令名（见下） | 提交图 / 分支合并 / 上传到云 / 你好世界 / 时间旅行 / 撤销撤销 |

**Git 操作是怎么知道的**：不需要添加仓库。打开开关时，桌宠在全局 git 配置里加 4 行 `trace2.*` 设置（`eventTarget` 指向 `%APPDATA%\dev.clawd.pet\git-trace`），之后 git 每跑一条命令就在那个文件夹里写一个小文件，记着命令名和退出码。桌宠读完即删，只对用户自己执行且成功的命令有反应，忽略 status / fetch / log 这类后台命令。关掉开关会把这 4 行移除。桌宠没运行时，git 攒到 200 个文件就自动停止记录。

**开销**：前台窗口切换和进出全屏由系统事件通知（全屏隐藏、前台应用），文件、回收站和 Git 由文件系统通知，平时不占 CPU。需要定时看的只有两样：鼠标穿透要看光标位置（光标在小螃蟹附近时每 40 毫秒一次，离得远时每 200 毫秒一次）；键鼠空闲时间和剪贴板序号每秒读一次，网络每 5 秒、电量每 20 秒，都是只读一个数的系统调用。

## 交互

- 单击：互动反应；连点 5 下会生气；睡着时戳它会有起床气
- 鼠标在它身上来回蹭：摸摸
- 按住拖动：拎着走（位置自动记住）
- 双击：从 400 个动画里随机表演一段
- 把文件拖到它身上：接住（不会动文件）
- 悬停：显示它正在干什么
- 右键小螃蟹或托盘图标：显示隐藏、随机来一段、设置、退出
- 托盘图标：单击显示/隐藏，双击打开设置

## 修改动画

400 个动画都是 Clawd 400 用代码画出来的：每个动画是 `scenes/<主题>.py` 里的一个函数，下面一行 `add(slug, 中文名, 英文名, 函数, n=帧数, dur=每帧毫秒)` 注册它。改函数或参数、再重新渲染，就能修改现有动画或做新的。

准备一次（需要 Python 3 和 Pillow）：

```bash
git clone https://github.com/khiqwq/clawd-400.git ../clawd-400-src
```

`import-assets` 默认先用 `../clawd-400-src`，没有的话再用 `../clawd-400`（从预览网站下载的打包版，只能导入，不能修改）。

每次修改：

1. 改 `../clawd-400-src/scenes/` 里的场景。slug 不变的话，桌宠这边什么都不用改。
2. 在 `../clawd-400-src` 里检查画风、重新渲染全部动画（几秒钟）：
   ```bash
   python lint.py dev        # 检查一个主题；现有动画本来就有一些标记（道具挡住脸之类），对比改动前后的数量即可
   python generate.py        # 重写 gifs/ 和 manifest.json
   ```
3. 回到本项目 `npm run import-assets`，然后重新运行 `npm run dev`，或者 `npm run build` 重新构建正式版（素材是打包进 exe 的）。
4. 新做的动画还要在 `ui/anims.js` 里放到合适的位置，再 `npm run triggers`。

画风规则（脸上只有两只眼睛、身体只用标准橙色等）见 `../clawd-400-src/skills/clawd-pixel/references/style.md`。也可以让 Claude 来改：在 Claude Code 里装上 Clawd 400 自带的 skill，然后直接描述想要的动作。

```text
/plugin marketplace add khiqwq/clawd-400
/plugin install clawd@clawd-400
```

## 代码结构

| 文件 | 内容 |
|---|---|
| [`ui/anims.js`](ui/anims.js) | 「剧本」：所有状态、生活场景、作息、情绪、季节、节日、系统事件对应哪些动画，改这里即可换动画 |
| [`ui/pet.js`](ui/pet.js) | 状态机：会话状态、场景调度、情绪、睡眠、互动、气泡 |
| [`ui/settings.html`](ui/settings.html) | 设置窗口（性格 / 作息 / Claude 联动 / 系统联动 / 动画图鉴） |
| [`src-tauri/src/server.rs`](src-tauri/src/server.rs) | 接收 hook 的本地 HTTP 服务，挂起权限请求 |
| [`src-tauri/src/sysmon.rs`](src-tauri/src/sysmon.rs) | 系统联动：文件夹和回收站监听、前台窗口事件、系统状态轮询 |
| [`src-tauri/src/git.rs`](src-tauri/src/git.rs) | Git 操作感知：安装 / 卸载 trace2 配置，读取 git 上报的命令 |
| [`src-tauri/src/hooks.rs`](src-tauri/src/hooks.rs) | 安装 / 卸载 Claude Code hook |
| [`src-tauri/src/autostart.rs`](src-tauri/src/autostart.rs) | 开机自启（`HKCU\…\Run` 下的 `ClawdPet` 项） |
| [`scripts/gen-triggers.mjs`](scripts/gen-triggers.mjs) | 从 `ui/anims.js` 生成触发一览页面 |
| [`src-tauri/src/main.rs`](src-tauri/src/main.rs) | 窗口、托盘、鼠标穿透、配置（存于 `%APPDATA%\dev.clawd.pet\config.json`） |

## 致谢

全部动画素材来自 **[Clawd 400](https://github.com/khiqwq/clawd-400)**，作者风花叶，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 授权：

> Clawd 400 by 风花叶 — CC BY 4.0 — https://github.com/khiqwq/clawd-400

本项目对素材的改动：`npm run import-assets` 导入时把 480×480 的 GIF 缩回它们原本绘制的 40×40 网格并重新编码，画面和帧时长不变；另外按动画名重命名了文件。素材不包含在本仓库里，需要自己克隆或下载 Clawd 400 再导入（见[修改动画](#修改动画)）。

Clawd 形象和 Claude、Claude Code 名称属于 Anthropic。本项目是非官方的同人作品，与 Anthropic 无关。
