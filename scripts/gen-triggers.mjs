// Generates docs/triggers.html: every animation trigger, how it fires and what plays.
// The animation lists come straight from ui/anims.js; the descriptions of when and
// how each one fires are written here and mirror the logic in ui/pet.js and
// src-tauri/src/sysmon.rs — update them together.
// Usage: node scripts/gen-triggers.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "ui/assets/clawd/manifest.json"), "utf8"));
const bySlug = Object.fromEntries(manifest.map((m) => [m.slug, m]));

const ctx = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(root, "ui/anims.js"), "utf8"), ctx);
const { ANIMS, TOOL_LABELS, GIT_ANIMS, SYS_EVENTS, APP_CATEGORIES, APP_ANIMS, LIFE, LIFE_WEIGHTS, OOPS, SCENE_INTRO, QUIRKS, ROUTINE, MOODS, NOT_FOR_FUN, SEASONS, NUDGES, holidaysOn } = ctx.window;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const used = new Set();

function figure(slug, note = "") {
  const m = bySlug[slug];
  if (!m) throw new Error(`unknown animation: ${slug}`);
  used.add(slug);
  return `<figure title="${esc(slug)} · ${(m.ms / 1000).toFixed(1)}s"><img loading="lazy" src="../ui/assets/clawd/${slug}.gif" alt=""><figcaption>${esc(m.zh)}${note}</figcaption></figure>`;
}

/** Thumbnails for a list of slugs, or for a { slug: weight } map (shown with each one's share). */
function thumbs(slugs) {
  if (Array.isArray(slugs)) return slugs.map((slug) => figure(slug)).join("");
  const total = Object.values(slugs).reduce((a, b) => a + b, 0);
  return Object.entries(slugs)
    .map(([slug, w]) => figure(slug, ` <b>${Math.round((w / total) * 100)}%</b>`))
    .join("");
}

/** One scene: its steps in order. ["slug", n] steps are marked with how often they play. */
function strip(steps) {
  return `<div class="scene">${steps.map((step) => (typeof step === "string" ? figure(step) : figure(step[0], ` <b>×${step[1]}</b>`))).join('<span class="arrow">→</span>')}</div>`;
}

const PLAY = {
  loop: ["loop", "循环", "状态持续多久就播多久"],
  force: ["force", "一次性 · 会打断", "立刻播放，Claude 正忙也会插进来"],
  polite: ["polite", "一次性 · 让路", "Claude 正忙、或开着 AI 聊天时不显示"],
  scene: ["scene", "场景 · 让路", "一步接一步演完；Claude 一开工、或你逗它，就立刻停下"],
};

/** How long a one-shot lasts: whole loops until `minMs` is reached, as playOnce() in pet.js does. */
function duration(slugs, minMs) {
  const secs = slugs.map((slug) => {
    const ms = bySlug[slug].ms;
    return (ms * Math.max(1, Math.ceil(minMs / ms))) / 1000;
  });
  const [lo, hi] = [Math.min(...secs), Math.max(...secs)].map((x) => x.toFixed(1).replace(".0", ""));
  return lo === hi ? `${lo} 秒` : `${lo}–${hi} 秒`;
}

const slugsOf = (list) => (Array.isArray(list) ? list : Object.keys(list));

/** row({ when, how, play: [kind, minMs or text?], say?, code, slugs }) */
function row({ when, how, play, say, code, slugs, scenes }) {
  const [cls, label, tip] = PLAY[play[0]];
  if (typeof play[1] === "number") play[1] = duration(slugsOf(slugs), play[1]);
  return `<div class="row">
  <div class="info">
    <h4>${when}</h4>
    <p>${how}</p>
    <p class="meta"><span class="badge ${cls}" title="${tip}">${label}</span>${play[1] ? `<span class="dur">${esc(play[1])}</span>` : ""}${say ? `<span class="say">💬 ${esc(say)}</span>` : ""}</p>
    <code>${esc(code)}</code>
  </div>
  ${scenes ? `<div class="scenes">${scenes.map(strip).join("")}</div>` : `<div class="thumbs">${thumbs(slugs)}</div>`}
</div>`;
}

const section = (id, title, intro, rows) => ({ id, title, html: `<section id="${id}"><h2>${title}</h2><p class="intro">${intro}</p>${rows.join("\n")}</section>` });
const sub = (title) => `<h3>${title}</h3>`;

// ------------------------------------------------------------ Claude Code

const TOOL_RULES = {
  edit: "工具是 Edit / MultiEdit / Write / NotebookEdit",
  read: "工具是 Read / NotebookRead",
  search: "工具是 Grep / Glob / LS / ToolSearch",
  web: "工具是 WebFetch / WebSearch，或名字里带 exa / tavily / web_search / web_fetch / firecrawl 的 MCP 工具（搜索和读网页算同一类，两种动画随机）",
  browser: "Claude 桌面版内置浏览器的工具（<code>mcp__Claude_Browser__</code>）",
  remoteBrowser: "Claude in Chrome、Playwright、Chrome DevTools、Puppeteer 的 MCP 工具，或命令是 <code>ego-browser</code>",
  computer: "操控电脑的工具（<code>mcp__computer-use__</code>）",
  agent: "工具是 Task / Agent（派出子代理）。开始时先播一遍下面的「派出子代理」",
  todo: "工具是 TodoWrite / TaskCreate / TaskUpdate / TaskList",
  mcp: "其他工具名以 <code>mcp__</code> 开头的工具",
  git: "Bash / PowerShell 命令里出现 <code>git </code>，但不是下面「Git 命令」里那些（status、log、diff 等）",
  test: "命令里出现 test / jest / vitest / pytest / mocha。结果出来之前不预设成败，跑完看下面两行",
  install: "命令是 npm / pnpm / yarn / bun / pip / uv / cargo 的 install / add / i / ci",
  build: "命令里出现 build / compile / tsc / make / cargo b",
  bash: "其他 Bash / PowerShell / Monitor 命令",
  other: "以上都不是的工具",
};

/** One row per git animation, with the subcommands that show it. */
function gitRows() {
  const bySlugs = new Map();
  for (const [sub, slugs] of Object.entries(GIT_ANIMS)) {
    const key = slugs.join();
    if (!bySlugs.has(key)) bySlugs.set(key, { slugs, subs: [] });
    bySlugs.get(key).subs.push(sub);
  }
  return [...bySlugs.values()].map(({ slugs, subs }) =>
    row({
      when: `Git 命令：${subs.join(" / ")}`,
      how: `Claude 执行的命令里有 <code>git ${esc(subs[0])}</code>${subs.length > 1 ? " 等" : ""}${subs.includes("branch") ? "（git branch 只在新建分支时算；checkout -b、switch -c 也算新建分支）" : ""}。一条命令里有好几个 git 命令时看最后一个，比如 <code>git add -A &amp;&amp; git commit</code> 算提交。每条 git 命令都重新选动画。`,
      play: ["loop"],
      code: `GIT_ANIMS["${subs[0]}"]`,
      slugs,
    }),
  );
}

const claude = section(
  "claude",
  "一、Claude Code 联动",
  "Claude Code 每发生一件事就通过 hook 通知桌宠。每个会话各记一个状态；多个会话同时在跑时，显示最紧急的那个：等你确认 &gt; 压缩上下文 &gt; 干活 &gt; 思考。",
  [
    sub("会话开始与结束"),
    row({ when: "执行 /clear", how: "<code>SessionStart</code>，来源是 clear。新开、恢复、退出会话都不播动画。", play: ["polite", 2200], code: "ANIMS.cleared", slugs: ANIMS.cleared }),
    row({ when: "Claude 桌面版启动", how: "桌面版的窗口第一次到前台（桌宠启动时它已经开着的不算）。只是关掉窗口、它还在托盘里的，再打开也不算。30 秒内只反应一次。", play: ["polite", 2600], code: 'SYS_EVENTS["claude-open"]', slugs: SYS_EVENTS["claude-open"].anims }),
    row({ when: "Claude 桌面版退出", how: "桌面版的主进程结束（桌宠等着这个进程，不轮询）。它的会话一并清掉，不用等会话自己超时。", play: ["polite", 2600], say: SYS_EVENTS["claude-quit"].say, code: 'SYS_EVENTS["claude-quit"]', slugs: SYS_EVENTS["claude-quit"].anims }),

    sub("思考与干活"),
    row({ when: "你发出一条消息", how: "<code>UserPromptSubmit</code>。每次提问随机选一种思考姿势，直到 Claude 开始用工具。", play: ["loop"], code: "ANIMS.thinking", slugs: ANIMS.thinking }),
    ...Object.keys(TOOL_RULES).map((cat) =>
      row({ when: `用工具：${TOOL_LABELS[cat]}`, how: `<code>PreToolUse</code>，${TOOL_RULES[cat]}。连续用同一类工具不换动画${Array.isArray(ANIMS.tools[cat]) ? "" : "；每次开始时按图上的比例抽"}。`, play: ["loop"], code: `ANIMS.tools.${cat}`, slugs: ANIMS.tools[cat] }),
    ),
    ...gitRows(),
    row({ when: "派出子代理", how: "Task / Agent 的 <code>PreToolUse</code>，然后接着播上面「派出小分队」的动画。", play: ["force", 2500], code: "ANIMS.agentSent", slugs: ANIMS.agentSent }),
    row({ when: "测试通过", how: "「跑测试」那条命令的 <code>PostToolUse</code>。", play: ["force", 2500], code: "ANIMS.testPassed", slugs: ANIMS.testPassed }),
    row({ when: "测试没过", how: "「跑测试」那条命令的 <code>PostToolUseFailure</code>（命令退出码不为 0）。同一轮第 3 次失败时换成下面的「同一轮里第 3 次失败」。", play: ["force", 3000], code: "ANIMS.testFailed", slugs: ANIMS.testFailed }),
    row({ when: "有子代理在跑", how: "<code>SubagentStart</code> 到 <code>SubagentStop</code> 之间，盖过上面的工具动画。标签显示「小分队 ×N」。", play: ["loop"], code: "ANIMS.subagents", slugs: ANIMS.subagents }),
    row({ when: "压缩上下文", how: "<code>PreCompact</code> 到 <code>PostCompact</code> 之间。手动 /compact 结束后回到待命；自动压缩结束后，对话还在进行就回到思考，否则回到待命。超过 2 分钟没等到结束，也按这个规则退出。", play: ["loop"], code: "ANIMS.compacting", slugs: ANIMS.compacting }),
    row({ when: "任务跑了 5 分钟以上", how: "从你发消息算起超过 5 分钟还在忙，之后每 4 分钟来一次。", play: ["force", 3000], code: "ANIMS.longTask", slugs: ANIMS.longTask }),

    sub("需要你确认"),
    row({ when: "Claude 请求权限（开着审批气泡）", how: "<code>PermissionRequest</code>。头顶弹出「拒绝 / 总是允许 / 允许」，直到你作答，或你在原界面答了：终端里答完马上收起；桌面版不告诉钩子，允许了要等那次调用跑完，拒绝了要等会话记录里出现它的结果，这一轮结束或被叫停时也收起。等满约 10 分钟气泡自己放弃，这时仍算等你确认。优先级仅次于被拎起来。", play: ["loop"], code: "ANIMS.permission", slugs: ANIMS.permission }),
    row({ when: "你在气泡里点了允许", how: "点「允许」或「总是允许」。", play: ["force", 1200], code: "ANIMS.allowed", slugs: ANIMS.allowed }),
    row({ when: "你在气泡里点了拒绝", how: "点「拒绝」。", play: ["force", 1800], code: "ANIMS.denied", slugs: ANIMS.denied }),
    row({ when: "要你去原界面作答", how: "气泡关着时的权限请求，或 <code>Notification</code> 的 permission_prompt / elicitation_dialog，直接是这个。提问、计划、填表先用下面各自的动画等着，约 45 秒还没回应、播完手头这一轮后才换成这个。", play: ["loop"], code: "ANIMS.waiting", slugs: ANIMS.waiting }),
    row({ when: "Claude 向你提问", how: "AskUserQuestion 的 <code>PreToolUse</code>。一脸问号地等你作答，约 45 秒没回应才变得不耐烦。", play: ["loop"], code: "ANIMS.asking", slugs: ANIMS.asking }),
    row({ when: "计划写好了", how: "ExitPlanMode 的 <code>PreToolUse</code>，计划交给你审。约 45 秒没回应才变得不耐烦。", play: ["loop"], code: "ANIMS.planReady", slugs: ANIMS.planReady }),
    row({ when: "MCP 服务器要你填表", how: "<code>Elicitation</code> 到 <code>ElicitationResult</code> 之间。约 45 秒没回应才变得不耐烦。", play: ["loop"], code: "ANIMS.elicitation", slugs: ANIMS.elicitation }),
    row({ when: "你答完了", how: "AskUserQuestion 的 <code>PostToolUse</code>，或 <code>ElicitationResult</code> 里你选了提交。", play: ["force", 1500], code: "ANIMS.answered", slugs: ANIMS.answered }),
    row({ when: "计划获批", how: "ExitPlanMode 的 <code>PostToolUse</code>，接着开工。", play: ["force", 1500], code: "ANIMS.planApproved", slugs: ANIMS.planApproved }),

    sub("出错"),
    row({ when: "一次工具调用失败", how: "<code>PostToolUseFailure</code>（你主动中断的不算）。", play: ["force", 1500], code: "ANIMS.toolError", slugs: ANIMS.toolError }),
    row({ when: "同一轮里第 3 次失败", how: "同一条消息的处理过程中累计到第 3 次工具失败时，换成这个。", play: ["force", 3000], code: "ANIMS.manyErrors", slugs: ANIMS.manyErrors }),
    row({ when: "API 出错，这一轮中止", how: "<code>StopFailure</code>（限流、服务器错误等）。", play: ["force", 3000], say: "呜…出错了（错误类型）", code: "ANIMS.apiError", slugs: ANIMS.apiError }),

    sub("完成"),
    row({ when: "Claude 答完了", how: "<code>Stop</code>，耗时不到 5 分钟。开着「头顶显示对话进度」时，气泡换成 Claude 最后一句话的第一行加一个勾，动画和气泡一起留 15 秒，这期间点气泡或小螃蟹会切到桌面版里的这个会话，然后气泡缩回去；关着时弹「搞定啦」，动画播 2.6 秒。动画只在没有别的会话在忙时播。", play: ["polite", 2600], say: "项目名 搞定啦～", code: "ANIMS.done", slugs: ANIMS.done }),
    row({ when: "长任务完成", how: "<code>Stop</code>，耗时 5 分钟以上。", play: ["polite", 3500], say: "项目名 跑了 N 分钟，终于搞定啦！", code: "ANIMS.bigDone", slugs: ANIMS.bigDone }),
    row({ when: "睡眠时段里完成", how: "<code>Stop</code> 时正处在睡眠时段。", play: ["polite", 2500], say: "项目名 搞定…困了 💤", code: "ANIMS.sleepyDone", slugs: ANIMS.sleepyDone }),
    row({ when: "你中途叫停", how: "按 Esc 或 Desktop 的停止按钮。中断不触发 <code>Stop</code>，桌宠从会话记录（transcript）里读到中断标记后回到待命，挂着的审批气泡一起收起。不是你发消息开始的那一轮（后台任务回来、桌面版唤醒会话）也算；之后后台子代理的动静不会再让它忙起来。动画只在没有别的会话在忙时播。", play: ["polite", 2000], code: "ANIMS.interrupted", slugs: ANIMS.interrupted }),
    `<div class="note">干活时的头顶气泡：开着「头顶显示对话进度」时，Claude 每说完一段话（会话记录里多一条），气泡就换成那段话的第一行；几个会话同时在忙时，上面加一行会话名。点气泡右上角的「－」收起，小螃蟹下方的状态标签右边多一个圆点，数字是在忙或刚说完话的会话数（开出去的会话和它的来源算一个），点它再展开；收起状态一直保持到你点圆点。长任务完成和睡眠时段里完成也一样走完成气泡（各自的动画留 15 秒）。</div>`,
    `<div class="note">完成之后的余韵：任务跑了 1 分钟以上，它会开心 3 分钟；长任务完成会得意 5 分钟（见「它自己的生活 → 情绪」）。如果完成时键鼠已经一阵没动静，「搞定啦」的气泡会一直留着（开着对话进度时则是完成气泡照常 15 秒后收起），等你碰了电脑它再提醒一次「已经搞定啦，快去看看～」。</div>`,
    `<div class="note">从一个会话开出去的会话（桌面版的 /btw 分支、另开的侧会话）算作同一件事：桌宠从桌面版自己的会话记录里认出它们的来源。标签用最上面那个会话的名字，后面加「分支 ×N」表示有几个开出去的会话在忙；一家子都停下才算完成，在那之前先停下的只显示它最后一句话，不庆祝。刚开出会话的那一轮停下时，先等 8 秒让新会话报到再决定。</div>`,
    `<div class="note">没有动画的情况：会话超过 30 分钟没有任何事件，会当作已结束，直接回到待命。</div>`,
  ],
);

// ------------------------------------------------------------ daily life

const KIND_NAMES = { routine: "作息", hobby: "爱好", music: "音乐", sports: "运动", cosplay: "角色扮演", chores: "家务", project: "折腾小项目", season: "当季", oops: "小意外", surprise: "随机惊喜", mood: "情绪", holiday: "节日" };
const SEASON_NAMES = { spring: "春（3–5 月）", summer: "夏（6–8 月）", autumn: "秋（9–11 月）", winter: "冬（12–2 月）" };
const LIFE_INFO = {
  hobby: "画画、钓鱼、拍照、折纸、拼图这些随时都可能做的小爱好。",
  music: "弹琴、打鼓、打碟、K 歌。晚间更常见，深夜很少。",
  sports: "健身房、有氧、球类、运动会、武道、街头。早晨和傍晚更常见，饭点少，深夜不做。",
  cosplay: "变装小剧场：故事、舞台、职业体验。晚间更常见。",
  chores: "扫地、洗衣、洗碗、擦窗。深夜不做。",
  project: "摸鱼折腾自己的小项目。上午更常见。用的都不是「Claude 在干活」的那几个动画。",
};
const MOOD_INFO = {
  happy: "Claude 干完一轮 1 分钟以上的活之后（3 分钟）；你一阵没操作后又回来时（2 分钟）。",
  proud: "5 分钟以上的长任务完成之后，持续 5 分钟。",
  loved: "被你摸摸之后，持续 30 秒。",
  bored: "键盘鼠标超过设定的时间（默认 5 分钟）没动静，一直到你回来，或者变成「想你」。",
  lonely: "没人理它之后再过 15 分钟（默认设置下即总共 20 分钟没操作），一直到你回来。",
  grumpy: "被连点 5 下惹毛之后，持续 30 秒。这时候摸摸它，会直接变成「被宠着」。",
  down: "一轮里第 3 次工具失败，或 API 出错之后，持续 3 分钟。",
  sleepy: "离夜间的睡眠时段不到 30 分钟。这时不运动、不出小意外，变装、音乐、家务也少。",
};

// Share of each kind of scene in a plain hour: no tilt, no mood, no holiday.
const baseKinds = Object.keys(LIFE_WEIGHTS).filter((k) => k !== "mood" && k !== "holiday");
const share = (col) => {
  const total = baseKinds.reduce((sum, k) => sum + LIFE_WEIGHTS[k][col], 0);
  return (k) => `${Math.round((LIFE_WEIGHTS[k][col] / total) * 100)}%`;
};
const [around, alone] = [share(0), share(1)];
const weightTable = `<table class="weights">
<tr><th>场景种类</th>${baseKinds.map((k) => `<td>${KIND_NAMES[k]}</td>`).join("")}<td>情绪（有情绪时）</td><td>节日（当天）</td></tr>
<tr><th>你在用电脑时</th>${baseKinds.map((k) => `<td>${LIFE_WEIGHTS[k][0]}<small>${around(k)}</small></td>`).join("")}<td>${LIFE_WEIGHTS.mood[0]}</td><td>${LIFE_WEIGHTS.holiday[0]}</td></tr>
<tr><th>一阵没操作时</th>${baseKinds.map((k) => `<td>${LIFE_WEIGHTS[k][1]}<small>${alone(k)}</small></td>`).join("")}<td>${LIFE_WEIGHTS.mood[1]}</td><td>${LIFE_WEIGHTS.holiday[1]}</td></tr>
</table>`;
const tiltText = (tilt) =>
  Object.entries(tilt || {})
    .map(([k, x]) => (x === 0 ? `不${KIND_NAMES[k]}` : `${KIND_NAMES[k]} ×${x}`))
    .join("、");
const SCENE = () => ["scene", "每个场景 20–50 秒"];

const life = section(
  "life",
  "二、它自己的生活",
  `Claude 没活给它的时候，它过自己的日子：演完一个<b>场景</b>，歇一会儿，再演下一个。一个场景由一到几个动画按顺序接成（图里的箭头就是顺序），循环的那几步平分 20–50 秒，标了 ×N 的只播 N 遍；只有一个动画的场景播 20–30 秒。歇多久由「活跃度」决定：悠闲 30–70 秒（约三分之一时间在活动），活泼 10–25 秒（约六成），闹腾 3–8 秒（约八成），安静则只待着不演场景。任何别的事（Claude 开工、你逗它、系统事件）都会打断当前场景，之后至少安静 6 秒再接着过日子。`,
  [
    sub("下一个场景怎么抽"),
    `<div class="note">按下表的权重抽一个种类，再从这个种类里挑一个最近没演过的场景。两行权重分别对应<b>你在用电脑</b>和<b>键鼠一阵没动静</b>（你可能走开了，也可能在看视频）：后一种情况下它更爱运动和变装，同时会无聊、想你。小字是平常时段里的占比。${weightTable}
    <ul>
      <li><b>看时间</b>：每个作息时段会把某些种类调多或调少（写在下面每个时段里），比如傍晚运动 ×1.8、深夜不运动。</li>
      <li><b>有连续性</b>：演完爱好、音乐、运动、角色扮演、家务、小项目里的一种，有 40% 的可能接着演同一种（最多连 3 个），所以会出现「连着练几项」「连换几套衣服」。</li>
      <li><b>有开场</b>：开始运动先${esc(bySlug[SCENE_INTRO.sports].zh)}一遍，开始变装先${esc(bySlug[SCENE_INTRO.cosplay].zh)}一遍；接着演同一种时不再重复。</li>
    </ul></div>`,
    row({ when: "开场动作", how: "见上面第三条，各播一遍。", play: ["scene", ""], code: "SCENE_INTRO", slugs: Object.values(SCENE_INTRO) }),

    sub("歇着和小动作"),
    row({ when: "两个场景之间歇着", how: "每次歇下来换一个姿势。有情绪时换成那种情绪的姿势（见下面「情绪」）。", play: ["loop"], code: "ANIMS.idle", slugs: ANIMS.idle }),
    row({ when: "小动作", how: "没有特别情绪时，轮到演场景有 30% 的可能改成只来一个小动作，然后少歇一半时间。不会连着来两个。", play: ["scene", 1500], code: "QUIRKS", slugs: QUIRKS }),

    sub("作息：一天九个时段"),
    ...ROUTINE.map((slot, i) => {
      const tilt = tiltText(slot.tilt);
      return row({ when: `${slot.from}–${slot.to} ${slot.name}`, how: `这个时段的专属场景。${tilt ? `这段时间：${tilt}。` : ""}`, play: SCENE(), code: `ROUTINE[${i}] · ${slot.name}`, scenes: slot.scenes });
    }),

    sub("随时可能做的事"),
    ...Object.entries(LIFE).map(([kind, scenes]) => row({ when: KIND_NAMES[kind], how: LIFE_INFO[kind], play: SCENE(), code: `LIFE.${kind}`, scenes })),
    row({ when: "小意外", how: "很少出现的出糗时刻。", play: SCENE(), code: "OOPS", scenes: OOPS }),
    `<div class="note">随机惊喜：从全部 ${manifest.length} 个动画里随便抽一个演 20–30 秒，只排除会被误认成真实状态的 ${NOT_FOR_FUN.length} 个（${NOT_FOR_FUN.map((s) => esc(bySlug[s].zh)).join("、")}）。双击和菜单里的「随机来一段」用的也是这个范围。</div>`,

    sub("当季"),
    ...Object.entries(SEASONS).map(([key, scenes]) => row({ when: SEASON_NAMES[key], how: "按当前月份决定季节。", play: SCENE(), code: `SEASONS.${key}`, scenes })),

    sub("情绪"),
    `<div class="note">情绪不是一个动画，而是一段时间的状态：歇着的姿势换成这种情绪的，抽场景时多一份权重 ${LIFE_WEIGHTS.mood[0]} 的「情绪场景」。鼠标停在它身上，标签会写出当前心情。发生了事引起的情绪（开心、得意、被宠着、闹脾气、郁闷）优先于处境带来的（无聊、想你、犯困）。</div>`,
    ...Object.entries(MOODS).flatMap(([key, m]) => [
      row({ when: `${m.label} · 歇着的姿势`, how: `什么时候：${MOOD_INFO[key]}`, play: ["loop"], code: `MOODS.${key}.rest`, slugs: m.rest }),
      row({ when: `${m.label} · 情绪场景`, how: "这种心情下会多出来的场景。", play: SCENE(), code: `MOODS.${key}.scenes`, scenes: m.scenes }),
    ]),

    sub("睡觉：只在设置的时段"),
    row({ when: "睡前刷牙", how: "进入夜间睡眠时段（超过 3 小时的时段）且手头的场景演完后，先刷牙。每晚只刷一次，半夜被吵醒后再睡不刷。", play: ["polite", 4000], say: "我先睡啦，你也早点休息哦～ 💤", code: "ANIMS.bedtime", slugs: ANIMS.bedtime }),
    row({ when: "打哈欠", how: "刷完牙之后；午休这类短时段则直接从这里开始。", play: ["polite", 3000], say: "午休时间，我眯一会儿～", code: "ANIMS.yawn", slugs: ANIMS.yawn }),
    row({ when: "打盹", how: "时段不超过 3 小时（如午休）。", play: ["loop"], code: "ANIMS.sleepNap", slugs: ANIMS.sleepNap }),
    row({ when: "正式睡觉", how: "时段超过 3 小时（如夜里）。", play: ["loop"], code: "ANIMS.sleepNight", slugs: ANIMS.sleepNight }),
    row({ when: "睡着时 Claude 开工", how: "收到提问、工具调用、权限请求、完成等事件。醒来干活，忙完 2 分钟后接着睡。", play: ["force", 1000], code: "ANIMS.wakeStartled", slugs: ANIMS.wakeStartled }),
    row({ when: "睡着时被你戳醒", how: "单击它。清醒 1 分钟后接着睡。", play: ["force", 2000], say: "唔…再让我睡会儿嘛…", code: "ANIMS.wakeGrumpy", slugs: ANIMS.wakeGrumpy }),
    row({ when: "时段结束，起床", how: "先拍闹钟，紧接着做下一行的伸展，然后接上早晨的作息。", play: ["polite", 2200], say: "早上好！新的一天开始啦～ / 睡醒啦，继续开工～", code: "ANIMS.wakeAlarm", slugs: ANIMS.wakeAlarm }),
    row({ when: "做梦", how: "打开了「记忆」时（设置的「AI 聊天」里），每个睡眠时段第一次睡着时在梦里整理记忆：把这些天一起经历的事、聊天时记下的事写进记忆笔记，顺便准备几句接下来想说的话（午睡准备的是当天下午说的）。没有新东西就不整理，也不做梦。整理时，以及整理完后 1 分半钟里，按睡姿轮流演这些梦，每个约 6 秒，之后回到平常的睡觉动画。电脑夜里关着、或者通宵没睡的话，第二天第一次有动静时补上，那时它醒着，不演梦。", play: ["loop"], code: "ANIMS.dreamNight", slugs: ANIMS.dreamNight }),
    row({ when: "做梦（午睡）", how: "同上，午睡时（捧着书打盹的姿势）。", play: ["loop"], code: "ANIMS.dreamNap", slugs: ANIMS.dreamNap }),
    row({ when: "伸展", how: "起床拍完闹钟之后；以及久坐提醒时（连续在用电脑超过设定的分钟数，默认 60）。", play: ["polite", 2000], say: "已经坐了 N 分钟啦，起来活动一下～", code: "ANIMS.stretch", slugs: ANIMS.stretch }),

    sub("问候与提醒"),
    row({ when: "桌宠启动", how: "按钟点说早上好 / 中午好 / 下午好 / 晚上好；当天是节日则改播节日动画。", play: ["polite", 1800], say: "下午好～", code: "ANIMS.hello", slugs: ANIMS.hello }),
    row({ when: "认识满 7 / 30 / 100 / 365 天", how: "打开了「记忆」才有：从打开记忆后第一次见面算起。达成的那天、它手头的场景演完时庆祝一次；当时在忙、在睡觉或者在聊天，就等闲下来。", play: ["polite", 3500], say: "我们认识一周啦～", code: "ANIMS.milestone", slugs: ANIMS.milestone }),
    `<div class="note">打开了「记忆」和「主动提起」时，它会说做梦时准备的话：起床时有适合早上说的就用它代替早安（午睡醒来用当天的），平时你在电脑前、它手头的场景演完时也会冒一句（每天最多 2 次，间隔至少 2 小时，每 10 分钟看一次）。点这个气泡会打开聊天，这句话就是开场白。换了人设，旧人设准备的话不再说。关掉「爱说话」则都不说。</div>`,
    ...NUDGES.map((n, i) => row({ when: `${n.at} 提醒`, how: "到点后 10 分钟内、它手头的场景演完时说一次，每天一次。关掉「爱说话」则不提醒。", play: ["polite", 3000], say: n.say, code: `NUDGES[${i}]`, slugs: n.anims })),
  ],
);

// ------------------------------------------------------------ holidays

const holidays = new Map();
for (let d = new Date(2026, 0, 1); d.getFullYear() === 2026; d.setDate(d.getDate() + 1)) {
  for (const h of holidaysOn(d, "")) {
    if (!holidays.has(h.name)) holidays.set(h.name, { ...h, days: [] });
    holidays.get(h.name).days.push(`${d.getMonth() + 1} 月 ${d.getDate()} 日`);
  }
}
const birthday = holidaysOn(new Date(2026, 4, 20), "05-20").find((h) => h.name === "生日");
const LUNAR = new Set(["除夕", "春节", "元宵节", "端午节", "七夕", "中秋节"]);

const festive = section(
  "holidays",
  "三、节日",
  "当天第一次空闲时（或启动时）庆祝一次并说祝福语，之后一整天抽场景时多一份很重的「节日」权重，每个节日动画单独成一个场景。农历节日按内置的 2026–2030 年日期表，下面列的是 2026 年的日期。可在设置的「系统联动 → 节日」里关闭。",
  [
    row({ when: "你的生日", how: "设置里填的日期。", play: ["polite", 3500], say: birthday.say, code: "holidaysOn() · 生日", slugs: birthday.anims }),
    ...[...holidays.values()].map((h) => {
      const days = h.days.length > 1 ? `${h.days[0]} 起 ${h.days.length} 天` : h.days[0];
      return row({ when: `${h.name} · ${days}`, how: LUNAR.has(h.name) ? "农历节日。" : "公历固定日期。", play: ["polite", 3500], say: h.say, code: `holidaysOn() · ${h.name}`, slugs: h.anims });
    }),
  ],
);

// ------------------------------------------------------------ interaction

const touch = section(
  "touch",
  "四、你和它的互动",
  "直接对小螃蟹做的动作。这些都会打断 Claude 的状态动画，播完再回去。",
  [
    row({ when: "单击", how: "点一下，等 0.3 秒确认不是双击后播放。三连击、四连击也算这个。AI 聊天开着时，单击是打开输入框。", play: ["force", 1200], code: "ANIMS.click", slugs: ANIMS.click }),
    row({ when: "2.5 秒内点满 5 下", how: "第 5 下立刻生气，播完之前不理会更多点击。之后闹 30 秒脾气。开了 AI 聊天时不会发生：点第 2 下就打开聊天了。", play: ["force", 1500], code: "ANIMS.clickSpam", slugs: ANIMS.clickSpam }),
    row({ when: "摸摸", how: "不按键，鼠标在它身上左右来回蹭（1.2 秒内连续变向 4 次）。4 秒内不重复触发，睡着时无效。之后 30 秒钟它是「被宠着」的心情。", play: ["force", 1800], code: "ANIMS.petted", slugs: ANIMS.petted }),
    row({ when: "鼠标停在它身上", how: "悬停 2.5 秒且 Claude 没在忙（它自己的场景会被打断）。30 秒内不重复。", play: ["polite", 1500], code: "ANIMS.noticed", slugs: ANIMS.noticed }),
    row({ when: "被拎起来", how: "按住左键拖动超过 4 像素，直到松手。优先级最高。", play: ["loop"], code: "ANIMS.dragged", slugs: ANIMS.dragged }),
    row({ when: "被放下", how: "拖动后松开鼠标。", play: ["force", 1500], code: "ANIMS.dropped", slugs: ANIMS.dropped }),
    row({ when: "文件拖到它上方", how: "从资源管理器拖着文件进入桌宠窗口。", play: ["force", 1500], code: "ANIMS.fileHover", slugs: ANIMS.fileHover }),
    row({ when: "文件丢给它", how: "在它身上松手。文件本身不会被动。", play: ["force", 2500], say: "接住啦～（只是抱一下，文件原封不动）", code: "ANIMS.fileDrop", slugs: ANIMS.fileDrop }),
    sub("AI 聊天（设置里打开后）"),
    row({ when: "聊天：输入框开着", how: "双击它弹出输入框，聊天开着时单击它也会；回复完以后焦点没被别处拿走的话，直接打字也会。框开着时它坐在书桌前转过身来听你说。聊天开着的整段时间里它不睡觉，也不演自己的场景；Claude 干活的动画也让给聊天（会话状态照样写在标签里），只有权限请求和必播的反应（比如瞄屏幕、出错）会盖过它。", play: ["loop"], code: "ANIMS.chatListen", slugs: ANIMS.chatListen }),
    row({ when: "聊天：等回复", how: "消息发出去以后、回复的第一个字到来之前。", play: ["loop"], code: "ANIMS.chatPonder", slugs: ANIMS.chatPonder }),
    row({ when: "聊天：回复中", how: "回复一个字一个字打出来的时候。", play: ["loop"], code: "ANIMS.chatTyping", slugs: ANIMS.chatTyping }),
    row({ when: "聊天：回复留在头顶", how: "回完了、输入框没开着，直到关掉聊天。没在回复、输入框也没开着（或者开着但空着、你点去了别处）满 4 分钟，聊天会自己关掉。", play: ["loop"], code: "ANIMS.chatIdle", slugs: ANIMS.chatIdle }),
    row({ when: "聊天：看一眼屏幕", how: "模型觉得要看你的屏幕、调用截图工具时（设置里允许看屏幕才有）。回复上会标出「看了一眼屏幕」。", play: ["force", 0], code: "ANIMS.chatSnap", slugs: ANIMS.chatSnap }),
    `<div class="note">不走固定动画的操作：<b>双击</b>（没开 AI 聊天时）和右键菜单的<b>「随机来一段」</b>从随机惊喜的范围里抽一个播 2.5 秒以上；设置里的<b>动画图鉴</b>点哪个播哪个；<b>右键</b>弹菜单；<b>托盘图标</b>单击显示/隐藏、双击打开设置。</div>`,
  ],
);

// ------------------------------------------------------------ system

const SYS_INFO = {
  "file-in": ["文件进了文件夹", "监听的文件夹里出现新文件或新文件夹：拖入、移入、新建、另存都算。", "文件动静"],
  zip: ["压缩打包", "监听的文件夹里出现 .zip / .7z / .rar / .tar / .gz 等压缩包（下载文件夹里的算下载）。", "文件动静"],
  download: ["下载完成", "下载文件夹里出现新文件，或浏览器的临时文件被改名为正式文件。", "文件动静"],
  screenshot: ["截图", "名字含 Screenshots 或「截图」的文件夹里出现新图片。", "文件动静"],
  trash: ["删除文件", "回收站文件夹里多了一条记录（文件系统通知，不轮询）。", "回收站"],
  "trash-empty": ["清空回收站", "回收站里最后一条记录被移除。", "回收站"],
  clipboard: ["复制或剪切", "剪贴板的序号变了（每秒查一次，不读内容）。", "复制粘贴"],
  "battery-low": ["电量低", "用电池供电且电量降到 20% 以下（每 20 秒查一次）。", "电量"],
  "power-plug": ["插上电源", "从电池供电变成接通电源。", "电量"],
  offline: ["断网", "系统报告的联网状态变为断开（每 5 秒查一次）。", "网络"],
  online: ["网络恢复", "联网状态从断开变回连接。", "网络"],
  dark: ["切到深色模式", "系统主题变为深色。", "深色 / 浅色模式"],
  light: ["切到浅色模式", "系统主题变为浅色。", "深色 / 浅色模式"],
  "git-init": ["Git：新建仓库", "任何仓库里成功执行 init。git 自己把命令名告诉桌宠，不用添加仓库。", "Git 操作（默认关闭）"],
  "git-clone": ["Git：克隆", "成功执行 clone。", "Git 操作（默认关闭）"],
  "git-add": ["Git：暂存", "成功执行 add（编辑器里点暂存也算）。", "Git 操作（默认关闭）"],
  "git-commit": ["Git：提交", "成功执行 commit / tag。", "Git 操作（默认关闭）"],
  "git-push": ["Git：推送", "成功执行 push。", "Git 操作（默认关闭）"],
  "git-pull": ["Git：拉取", "成功执行 pull。", "Git 操作（默认关闭）"],
  "git-switch": ["Git：切分支", "成功执行 checkout / switch。", "Git 操作（默认关闭）"],
  "git-merge": ["Git：合并", "成功执行 merge。", "Git 操作（默认关闭）"],
  "git-rebase": ["Git：变基", "成功执行 rebase。", "Git 操作（默认关闭）"],
  "git-stash": ["Git：藏起改动", "成功执行 stash。", "Git 操作（默认关闭）"],
  "git-reset": ["Git：撤销", "成功执行 reset / restore / revert。", "Git 操作（默认关闭）"],
  "git-cherry-pick": ["Git：摘提交", "成功执行 cherry-pick。", "Git 操作（默认关闭）"],
};
const APP_NAMES = { music: "音乐", video: "视频", game: "游戏", code: "编辑器 / IDE", terminal: "终端", chat: "聊天", design: "设计", office: "办公与笔记", mail: "邮件" };

const system = section(
  "system",
  "五、系统联动",
  "对你在 Claude Code 之外的操作做反应。全部是「一次性 · 让路」：Claude 正忙时不显示，它睡着时不理会。同一种事件默认 20 秒内只反应一次。每项都能在设置的「系统联动」里单独关掉。status、fetch、log 这类编辑器在后台反复执行的 git 命令，以及别的 git 命令派生出来的子命令，都不触发。",
  [
    // The Claude app's own comings and goings are in the Claude Code section.
    ...Object.entries(SYS_EVENTS).filter(([kind]) => !kind.startsWith("claude-")).map(([kind, def]) => {
      const [when, how, toggle] = SYS_INFO[kind];
      const cd = def.cooldown ? `；${def.cooldown >= 60 ? `${def.cooldown / 60} 分钟` : `${def.cooldown} 秒`}内只反应一次` : "";
      return row({ when, how: `${how}开关：${toggle}${cd}。`, play: ["polite", 2600], say: def.say, code: `SYS_EVENTS["${kind}"]`, slugs: def.anims });
    }),
    sub("前台应用（默认关闭）"),
    ...Object.entries(APP_ANIMS).map(([cat, slugs]) =>
      row({ when: `切到${APP_NAMES[cat]}软件`, how: `系统通知前台窗口换了，且它的进程名是：${APP_CATEGORIES[cat].map((e) => `<code>${esc(e)}</code>`).join(" ")}。同一类 2 分钟内只反应一次。`, play: ["polite", 2600], code: `APP_ANIMS.${cat}`, slugs }),
    ),
  ],
);

// ------------------------------------------------------------ unused

const sections = [claude, life, festive, touch, system];
const unusedByTheme = new Map();
for (const m of manifest) {
  if (used.has(m.slug)) continue;
  if (!unusedByTheme.has(m.themeZh)) unusedByTheme.set(m.themeZh, []);
  unusedByTheme.get(m.themeZh).push(m.slug);
}
const usedCount = used.size; // before the unused thumbnails are rendered
const unusedCount = manifest.length - usedCount;
const unused = {
  id: "unused",
  title: "六、还没安排戏份的动画",
  html: `<section id="unused"><h2>六、还没安排戏份的动画</h2><p class="intro">这 ${unusedCount} 个动画没有固定的触发时机，只会在「随机惊喜」和双击时出现（嚎啕大哭、心碎这类太伤心的是特意留着的）。想给哪个安排角色，告诉我它的名字和想要的触发时机就行。</p>${[...unusedByTheme]
    .map(([theme, slugs]) => `<h3>${esc(theme)} · ${slugs.length} 个</h3><div class="thumbs loose">${thumbs(slugs)}</div>`)
    .join("")}</section>`,
};
sections.push(unused);

// ------------------------------------------------------------ page

const rowsTotal = sections.reduce((n, s) => n + (s.html.match(/class="row"/g) || []).length, 0);
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clawd Pet 动画触发一览</title>
<style>
  :root { --ink:#2b2b2b; --muted:#7d766c; --clawd:#e17f50; --soft:#fbe6da; --paper:#fbf6ee; --card:#fff; --line:#e6ddd0; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; scroll-padding-top: 64px; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 14px/1.6 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; }
  header { max-width: 1180px; margin: 0 auto; padding: 28px 24px 8px; }
  h1 { margin: 0 0 6px; font-size: 26px; }
  header p { margin: 0; color: var(--muted); }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0 4px; }
  .stat { padding: 8px 14px; background: var(--card); border: 2px solid var(--ink); border-radius: 10px; box-shadow: 3px 3px 0 rgba(0,0,0,.12); }
  .stat b { font-size: 20px; margin-right: 4px; }
  nav { position: sticky; top: 0; z-index: 5; background: var(--paper); border-bottom: 2px solid var(--line); }
  nav div { max-width: 1180px; margin: 0 auto; padding: 10px 24px; display: flex; flex-wrap: wrap; gap: 6px; }
  nav a { padding: 4px 12px; border: 2px solid var(--ink); border-radius: 999px; background: var(--card); color: var(--ink); text-decoration: none; font-size: 13px; }
  nav a:hover { background: var(--soft); }
  main { max-width: 1180px; margin: 0 auto; padding: 0 24px 60px; }
  h2 { margin: 36px 0 6px; font-size: 21px; }
  h3 { margin: 26px 0 10px; font-size: 15px; color: var(--clawd); }
  .intro { margin: 0 0 14px; color: var(--muted); max-width: 900px; }
  .legend { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 18px 0 0; padding: 12px 16px; background: var(--card); border: 2px dashed var(--line); border-radius: 10px; font-size: 13px; }
  .legend ol { margin: 4px 0 0; padding-left: 20px; }
  .row { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; gap: 18px; margin-bottom: 10px; padding: 14px 16px; background: var(--card); border: 2px solid var(--ink); border-radius: 10px; box-shadow: 3px 3px 0 rgba(0,0,0,.1); }
  .info h4 { margin: 0 0 4px; font-size: 15px; }
  .info p { margin: 0 0 6px; color: #4d4841; font-size: 13px; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .badge { padding: 1px 9px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
  .badge.loop { background: #e3eefb; color: #1f5fa8; }
  .badge.force { background: #fde2dc; color: #b3391d; }
  .badge.polite { background: #e4f3e2; color: #2c7a35; }
  .badge.scene { background: #efe4f7; color: #6a3a94; }
  .dur { color: var(--muted); font-size: 12px; }
  .say { color: #4d4841; font-size: 12px; }
  code { font: 12px "Cascadia Mono", Consolas, monospace; padding: 1px 5px; background: var(--paper); border-radius: 4px; }
  .info > code { color: var(--muted); }
  .thumbs { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 6px; }
  figure { width: 84px; margin: 0; text-align: center; }
  figure img { width: 84px; height: 84px; image-rendering: pixelated; background: #f4efe6; border-radius: 8px; display: block; }
  figcaption { margin-top: 2px; font-size: 11px; line-height: 1.3; color: #4d4841; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  figcaption b { color: var(--clawd); }
  .scenes { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 8px; }
  .scene { display: flex; align-items: flex-start; gap: 2px; padding: 6px; background: var(--paper); border: 1px solid var(--line); border-radius: 10px; }
  .scene figure, .scene figure img { width: 68px; }
  .scene figure img { height: 68px; }
  .arrow { align-self: center; margin-bottom: 16px; color: var(--muted); }
  .weights { margin: 10px 0 4px; border-collapse: collapse; background: var(--card); font-size: 12px; }
  .weights th, .weights td { padding: 4px 8px; border: 1px solid var(--line); text-align: center; white-space: nowrap; }
  .weights th { text-align: left; }
  .weights small { display: block; color: var(--muted); }
  .note ul { margin: 6px 0 0; padding-left: 20px; }
  .thumbs.loose { padding: 14px 16px; background: var(--card); border: 2px solid var(--ink); border-radius: 10px; }
  .note { margin: 12px 0; padding: 10px 14px; border-left: 4px solid var(--clawd); background: var(--soft); border-radius: 0 8px 8px 0; font-size: 13px; }
  @media (max-width: 760px) { .row { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Clawd Pet 动画触发一览</h1>
  <p>每个动画什么时候播、怎么触发、播多久。动画列表直接取自 <code>ui/anims.js</code>，改完后运行 <code>npm run triggers</code> 重新生成本页。</p>
  <div class="stats">
    <div class="stat"><b>${rowsTotal}</b>个触发时机</div>
    <div class="stat"><b>${usedCount}</b>个动画有固定戏份</div>
    <div class="stat"><b>${unusedCount}</b>个只随机出现</div>
    <div class="stat"><b>${manifest.length}</b>个动画总数</div>
  </div>
  <div class="legend">
    <div>
      <b>播放方式</b><br>
      <span class="badge loop">循环</span> 状态持续多久就播多久
      <span class="badge force">一次性 · 会打断</span> 立刻播，Claude 正忙也插进来
      <span class="badge polite">一次性 · 让路</span> Claude 正忙时不显示
      <span class="badge scene">场景 · 让路</span> 几个动画接着演，一有别的事就停
    </div>
    <div>
      <b>同时满足多个条件时，谁说了算</b>（从高到低）
      <ol><li>被拎起来</li><li>有待审批的权限请求</li><li>「会打断」的一次性动画</li><li>Claude 正在忙的状态动画</li><li>「让路」的一次性动画、它自己的场景</li><li>睡觉</li><li>歇着</li></ol>
    </div>
    <div>一行里有多个动画时，每次随机选一个。灰色小字是它在 <code>ui/anims.js</code> 里的名字，告诉我要改哪一行时用得上。鼠标停在缩略图上能看到动画的英文代号和单圈时长。</div>
  </div>
</header>
<nav><div>${sections.map((s) => `<a href="#${s.id}">${s.title}</a>`).join("")}</div></nav>
<main>
${sections.map((s) => s.html).join("\n")}
</main>
</body>
</html>
`;

const out = path.join(root, "docs", "triggers.html");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${path.relative(root, out)}: ${rowsTotal} triggers, ${usedCount} animations in use, ${unusedCount} unused`);
