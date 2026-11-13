const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const { getCurrentWebview } = window.__TAURI__.webview;

const $ = (id) => document.getElementById(id);
const sprite = $("sprite");
const bubble = $("bubble");
const label = $("label");
const petHit = $("pet-hit");

const MIN = 60 * 1000;
const TOAST_MS = 4500;
const STALE_BUSY_MS = 30 * MIN;
const FORGET_IDLE_MS = 120 * MIN;
const LONG_TASK_MS = 5 * MIN;
const LONG_TASK_BREAK_MS = 4 * MIN;
const AWAKE_AFTER_WORK_MS = 2 * MIN;
const AWAKE_AFTER_POKE_MS = 1 * MIN;
/** A sleep window up to this long is a nap rather than a night's sleep. */
const NAP_MAX_MINUTES = 180;
/** Seconds it rests between scenes of its idle life, by liveliness (at 0 it only rests). */
const REST_SECONDS = [[120, 240], [30, 70], [10, 25], [3, 8]];
/** Seconds the looped steps of one scene last together. */
const SCENE_SECONDS = [20, 50];
const STEP_MIN_MS = 5000;
/** Calm time after anything else before the next scene starts. */
const CALM_AFTER_MS = 6000;
const QUIRK_CHANCE = 0.3;
/** Chance that the next scene is of the same kind as the last, up to STREAK_MAX in a row. */
const STREAK_CHANCE = 0.4;
const STREAK_MAX = 3;
/** Left alone this long, boredom turns into loneliness. */
const LONELY_AFTER_MS = 15 * MIN;
const SLEEPY_BEFORE_BED_MS = 30 * MIN;

/** Picks from a list, or from a { key: weight } map by weight. */
function pick(pool) {
  if (Array.isArray(pool)) return pool[Math.floor(Math.random() * pool.length)];
  const entries = Object.entries(pool);
  let r = Math.random() * entries.reduce((sum, e) => sum + e[1], 0);
  return (entries.find((e) => (r -= e[1]) < 0) || entries[0])[0];
}
const now = () => Date.now();
const parseHM = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
/** Is minute-of-day `t` inside [from, to), where the range may wrap past midnight? */
const inRange = (t, from, to) => (from < to ? t >= from && t < to : from > to && (t >= from || t < to));

let config = null;
const nick = () => (config.nickname ? `，${config.nickname}` : "");

// ---------------------------------------------------------------- animations

let manifest = {}; // slug -> { ms, zh }
let allSlugs = [];
let funSlugs = [];
let currentSlug = null;
let playSeq = 0;

function durationOf(slug) {
  return manifest[slug]?.ms || 2000;
}

function play(slug, restart = false) {
  if (!manifest[slug]) {
    console.warn("unknown animation", slug);
    slug = ANIMS.idle[0];
  }
  if (slug === currentSlug && !restart) return;
  currentSlug = slug;
  // A unique URL restarts the GIF from frame 0; swap only once it's loaded to avoid flicker.
  const url = `assets/clawd/${slug}.gif?${++playSeq}`;
  const seq = playSeq;
  const pre = new Image();
  pre.onload = () => seq === playSeq && (sprite.src = url);
  pre.src = url;
}

// A one-shot plays for at least `minMs` (whole loops), then hands back to the state
// machine. Unless forced, it stays hidden while Claude is busy. `life` marks a step
// of the pet's own idle life; any other one-shot cuts the scene in progress short.
let oneShot = null; // { slug, force, fresh, life }
let oneShotTimer = null;

function playOnce(slug, { force = false, minMs = 1800, then, life = false } = {}) {
  if (!life && scene) {
    scene = null;
    rest();
  }
  const ms = durationOf(slug);
  const total = ms * Math.max(1, Math.ceil(minMs / ms));
  oneShot = { slug, force, fresh: true, life };
  clearTimeout(oneShotTimer);
  oneShotTimer = setTimeout(() => {
    oneShot = null;
    then?.();
    render();
  }, total);
  render();
  return total;
}

// ---------------------------------------------------------------- state

const BUSY_RANK = { waiting: 5, compacting: 4, working: 3, thinking: 2, idle: 0 };

/** session_id -> { id, entry, cwd, state, cat, anim, subagents, fails, turnStart, nextBreak, t } */
const sessions = new Map();
/** Pending permission requests: { id, payload }. */
const perms = [];

let idleBase = pick(ANIMS.idle);

// Sleep follows the schedule in the settings, not inactivity.
let asleep = false;
let sleepAnim = null;
let awakeUntil = now() + MIN; // stay up a moment after launch
let tuckedIn = null;

// Left alone = no keyboard or mouse input for a while. The user may be gone, or just
// watching a video; either way the pet entertains itself.
let leftAlone = false;
let aloneSince = 0;
let presentSince = now();
/** Projects that finished while it was left alone, kept on show until the user is back. */
let unseenDone = [];

let dragging = false;
let dragAnim = null;

function session(p) {
  const id = p.session_id || "default";
  let s = sessions.get(id);
  if (!s) {
    s = { id, entry: "", cwd: "", state: "idle", cat: null, anim: null, subagents: 0, fails: 0, turnStart: 0, nextBreak: 0, t: now() };
    sessions.set(id, s);
  }
  if (p._entry) s.entry = p._entry;
  if (p.cwd) s.cwd = p.cwd;
  s.t = now();
  return s;
}

function leader() {
  let best = null;
  for (const s of sessions.values()) {
    const rank = BUSY_RANK[s.state] ?? 0;
    if (rank === 0) continue;
    if (!best || rank > BUSY_RANK[best.state] || (rank === BUSY_RANK[best.state] && s.t > best.t)) best = s;
  }
  return best;
}

const anyBusy = () => leader() !== null;

/** Keep the pet up for `ms`; returns true if this woke it. */
function stir(ms) {
  awakeUntil = Math.max(awakeUntil, now() + ms);
  if (!asleep) return false;
  asleep = false;
  return true;
}

// ---------------------------------------------------------------- Claude Code hooks

const WAKING_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "StopFailure"]);

function onHook(p) {
  const ev = p.hook_event_name;
  const s = session(p);
  if (WAKING_EVENTS.has(ev) && stir(AWAKE_AFTER_WORK_MS)) {
    playOnce(pick(ANIMS.wakeStartled), { force: true, minMs: 1000 });
  }

  switch (ev) {
    case "SessionStart":
      if (p.source === "clear") {
        s.state = "idle";
        playOnce(pick(ANIMS.cleared), { minMs: 2200 });
      } else if (p.source === "startup" || p.source === "resume") {
        s.state = "idle";
        if (!anyBusy()) playOnce(pick(ANIMS.hello));
      }
      break;
    case "SessionEnd":
      sessions.delete(s.id);
      if (p.reason !== "clear" && !anyBusy()) playOnce(pick(ANIMS.bye));
      break;
    case "UserPromptSubmit":
      s.state = "thinking";
      s.cat = null;
      s.anim = pick(ANIMS.thinking);
      s.subagents = 0;
      s.fails = 0;
      s.turnStart = now();
      s.nextBreak = s.turnStart + LONG_TASK_MS;
      break;
    case "PreToolUse": {
      // These wait for the user's answer in the native UI.
      if (p.tool_name === "AskUserQuestion" || p.tool_name === "ExitPlanMode") {
        s.state = "waiting";
        break;
      }
      const cat = toolCategory(p.tool_name, p.tool_input || {});
      if (cat !== s.cat || s.state !== "working") s.anim = pick(ANIMS.tools[cat]);
      s.state = "working";
      s.cat = cat;
      break;
    }
    case "PostToolUse":
      if (s.state === "waiting") s.state = "working";
      break;
    case "PostToolUseFailure":
      if (s.state === "waiting") s.state = "working";
      if (!p.is_interrupt) {
        s.fails++;
        if (s.fails === 3) {
          feel("down", 3);
          playOnce(pick(ANIMS.manyErrors), { force: true, minMs: 3000 });
        } else {
          playOnce(pick(ANIMS.toolError), { force: true, minMs: 1500 });
        }
      }
      break;
    case "SubagentStart":
      s.subagents++;
      break;
    case "SubagentStop":
      s.subagents = Math.max(0, s.subagents - 1);
      break;
    case "PreCompact":
      s.state = "compacting";
      break;
    case "PostCompact":
      s.state = p.trigger === "manual" ? "idle" : "thinking";
      break;
    case "Elicitation": // an MCP server asks the user for input
      s.state = "waiting";
      break;
    case "ElicitationResult": // may also come outside a turn, which no Stop would end
      if (s.state === "waiting") s.state = s.turnStart ? "working" : "idle";
      break;
    case "Interrupt":
      // Synthetic, from transcript.rs: an interrupt fires no Stop. A marker from
      // before the current prompt belongs to the previous turn.
      if (s.turnStart && Date.parse(p.timestamp) < s.turnStart) break;
      s.state = "idle";
      s.subagents = 0;
      s.turnStart = 0;
      break;
    case "Notification":
      if (p.notification_type === "idle_prompt") {
        // Claude is waiting for the next prompt. Fallback for an interrupt that
        // transcript.rs missed (the Desktop app doesn't seem to send it).
        s.state = "idle";
        s.subagents = 0;
        s.turnStart = 0;
      } else if (p.notification_type === "permission_prompt" || p.notification_type === "elicitation_dialog") {
        if (!perms.some((x) => x.payload.session_id === s.id)) s.state = "waiting";
      }
      break;
    case "PermissionRequest": // only reaches here when the bubble isn't used
      s.state = "waiting";
      break;
    case "Stop":
      onTurnDone(s);
      break;
    case "StopFailure":
      s.state = "idle";
      s.subagents = 0;
      s.turnStart = 0;
      feel("down", 3);
      playOnce(pick(ANIMS.apiError), { force: true, minMs: 3000 });
      toast(`呜…出错了（${p.error_type || p.error || "unknown"}）`);
      break;
  }
  render();
}

function onTurnDone(s) {
  const took = s.turnStart ? now() - s.turnStart : 0;
  const name = projectName(s);
  s.state = "idle";
  s.subagents = 0;
  s.turnStart = 0;

  let [text, ms, anims, minMs] = [`${name} 搞定啦～`, TOAST_MS, ANIMS.done, 2600];
  if (sleepWindowAt(new Date())) {
    [text, anims, minMs] = [`${name} 搞定…困了 💤`, ANIMS.sleepyDone, 2500];
  } else if (took >= LONG_TASK_MS) {
    [text, ms, anims, minMs] = [`${name} 跑了 ${Math.round(took / MIN)} 分钟，终于搞定啦！`, 7000, ANIMS.bigDone, 3500];
    feel("proud", 5);
  } else if (took >= MIN) {
    feel("happy", 3);
  }
  if (leftAlone) {
    // Maybe nobody is looking: keep the news up until the user touches the computer again.
    unseenDone.push(name);
    toast(`${[...new Set(unseenDone)].join("、")} 搞定啦～`, { sticky: true });
  } else {
    toast(text, { ms });
  }
  if (!anyBusy()) playOnce(pick(anims), { minMs });
}

// ---------------------------------------------------------------- moods

// Something that happened leaves a mood for a few minutes; otherwise the mood follows
// the situation (left alone, close to bedtime). Moods colour the idle life below.
let feeling = null; // { name, until }

function feel(name, minutes) {
  feeling = { name, until: now() + minutes * MIN };
  idleBase = pick(restPool());
}

/** The current mood, a key of MOODS, or null. */
function mood() {
  if (feeling && now() < feeling.until) return feeling.name;
  if (leftAlone) return now() - aloneSince < LONELY_AFTER_MS ? "bored" : "lonely";
  const d = new Date();
  const soon = sleepWindowAt(new Date(d.getTime() + SLEEPY_BEFORE_BED_MS));
  if (soon && soon.minutes > NAP_MAX_MINUTES && !sleepWindowAt(d)) return "sleepy";
  return null;
}

const restPool = () => MOODS[mood()]?.rest || ANIMS.idle;

// ---------------------------------------------------------------- daily life

/** The sleep window covering `date`, with its length in minutes, or null. */
function sleepWindowAt(date) {
  if (!config.sleepEnabled) return null;
  const t = minutesOf(date);
  for (const w of config.sleepWindows) {
    const [from, to] = [parseHM(w.start), parseHM(w.end)];
    if (inRange(t, from, to)) return { key: `${w.start}-${w.end}`, minutes: (to - from + 1440) % 1440 };
  }
  return null;
}

function fallAsleep(win) {
  const nap = win.minutes <= NAP_MAX_MINUTES;
  const key = `${new Date().toDateString()}|${win.key}`;
  // The first time in a window, as opposed to dozing off again after being woken.
  const first = tuckedIn !== key;
  tuckedIn = key;
  if (first && config.chatty) toast(nap ? "午休时间，我眯一会儿～" : `我先睡啦${nick()}，你也早点休息哦～ 💤`);
  const yawn = () =>
    playOnce(pick(ANIMS.yawn), {
      minMs: 3000,
      then: () => {
        if (anyBusy() || !sleepWindowAt(new Date())) return;
        asleep = true;
        sleepAnim = pick(nap ? ANIMS.sleepNap : ANIMS.sleepNight);
      },
    });
  if (first && !nap) playOnce(pick(ANIMS.bedtime), { minMs: 4000, then: yawn });
  else yawn();
}

function wakeUp(date) {
  asleep = false;
  playOnce(pick(ANIMS.wakeAlarm), {
    minMs: 2200,
    then: () => playOnce(pick(ANIMS.stretch), { minMs: 2000 }),
  });
  if (config.chatty) toast(date.getHours() < 11 ? `早上好${nick()}！新的一天开始啦～` : "睡醒啦，继续开工～");
}

function holidaysToday(date) {
  return config.sys.holidays ? holidaysOn(date, config.birthday) : [];
}

function celebrate(holiday) {
  playOnce(pick(holiday.anims), { minMs: 3500 });
  toast(holiday.say, { ms: 7000 });
}

let greetedDay = null;

function greet() {
  const d = new Date();
  greetedDay = d.toDateString();
  const [holiday] = holidaysToday(d);
  if (holiday) return celebrate(holiday);
  playOnce(pick(ANIMS.hello));
  if (!config.chatty) return;
  const h = d.getHours();
  const hello = h < 5 ? "夜深啦" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  toast(`${hello}${nick()}～`);
}

// Its idle life: one scene after another (see LIFE in anims.js), resting in between.
let scene = null; // { kind, queue: [[slug, ms], ...] } while one is playing
let streak = { kind: null, n: 0 };
let recentScenes = [];
let nextSceneAt = 0;
let quirked = false;

/** Settle into a calm loop until the next scene is due. */
function rest(factor = 1) {
  const [lo, hi] = REST_SECONDS[config.liveliness];
  const pool = restPool().filter((slug) => slug !== idleBase);
  idleBase = pick(pool.length ? pool : restPool());
  nextSceneAt = now() + (lo + Math.random() * (hi - lo)) * 1000 * factor;
}

/** Draws the next scene: [kind, steps]. */
function pickScene(date) {
  const t = minutesOf(date);
  const slot = ROUTINE.find((x) => inRange(t, parseHM(x.from), parseHM(x.to)));
  const feels = MOODS[mood()];
  const tilt = (kind) => (slot.tilt[kind] ?? 1) * (feels?.tilt?.[kind] ?? 1);
  const pools = {
    ...LIFE,
    routine: slot.scenes,
    season: SEASONS[seasonOf(date)],
    oops: OOPS,
    mood: feels?.scenes,
    holiday: holidaysToday(date).flatMap((h) => h.anims.map((slug) => [slug])),
    surprise: [[pick(funSlugs)]], // anything goes
  };

  // Often carry on with what it was doing (another exercise, another costume)...
  let kind = streak.kind;
  const carryOn = LIFE[kind] && streak.n < STREAK_MAX && tilt(kind) > 0 && Math.random() < STREAK_CHANCE;
  if (!carryOn) {
    // ...otherwise draw by weight, for the time of day and whether anyone is around.
    const weights = {};
    for (const [k, w] of Object.entries(LIFE_WEIGHTS)) weights[k] = pools[k]?.length ? w[leftAlone ? 1 : 0] * tilt(k) : 0;
    kind = pick(weights);
  }
  streak = { kind, n: kind === streak.kind ? streak.n + 1 : 1 };

  const fresh = pools[kind].filter((steps) => !recentScenes.includes(steps));
  const steps = pick(fresh.length ? fresh : pools[kind]);
  recentScenes = [...recentScenes.slice(-2), steps];
  return [kind, steps];
}

function startScene(kind, steps) {
  const looped = steps.filter((step) => typeof step === "string").length;
  const [lo, hi] = SCENE_SECONDS;
  // A single animation on its own gets the short end of the range.
  const total = (lo + (Math.random() * (hi - lo)) / (looped > 1 ? 1 : 3)) * 1000;
  const each = Math.max(STEP_MIN_MS, total / looped);
  const queue = steps.map((step) => (typeof step === "string" ? [step, each] : [step[0], step[1] * durationOf(step[0])]));
  if (SCENE_INTRO[kind] && streak.n === 1) queue.unshift([SCENE_INTRO[kind], 0]);
  scene = { kind, queue };
  nextStep();
}

function nextStep() {
  const step = scene.queue.shift();
  if (step) {
    playOnce(step[0], { minMs: step[1], life: true, then: nextStep });
  } else {
    scene = null;
    rest();
  }
}

/** Drop the scene or quirk in progress. */
function cancelLife() {
  scene = null;
  clearTimeout(oneShotTimer);
  oneShot = null;
}

const firedNudges = new Set();

function tick() {
  const t = now();
  const d = new Date();

  for (const s of [...sessions.values()]) {
    if (s.state !== "idle" && t - s.t > STALE_BUSY_MS) s.state = "idle";
    if (s.state === "idle" && t - s.t > FORGET_IDLE_MS) sessions.delete(s.id);
  }

  // A coffee break now and then during long tasks.
  const lead = leader();
  if (lead && lead.turnStart && t > lead.nextBreak && (lead.state === "working" || lead.state === "thinking") && !perms.length) {
    lead.nextBreak = t + LONG_TASK_BREAK_MS;
    playOnce(pick(ANIMS.longTask), { force: true, minMs: 3000 });
  }

  const quiet = !lead && !perms.length && !oneShot && !dragging;
  if (!quiet) nextSceneAt = Math.max(nextSceneAt, t + CALM_AFTER_MS);
  const win = sleepWindowAt(d);
  if (asleep && !win) {
    wakeUp(d);
  } else if (!asleep && win && quiet && t > awakeUntil) {
    fallAsleep(win);
  } else if (!asleep && !leftAlone && config.sedentaryMinutes > 0 && t - presentSince >= config.sedentaryMinutes * MIN) {
    presentSince = t;
    playOnce(pick(ANIMS.stretch), { minMs: 3000 });
    toast(`已经坐了 ${config.sedentaryMinutes} 分钟啦，起来活动一下～`, { ms: 7000 });
  } else if (!asleep && !win && quiet) {
    idleLife(t, d);
  }
  render();
}

/** What the pet does on its own while nothing is going on. */
function idleLife(t, d) {
  const today = d.toDateString();
  if (today !== greetedDay && !toastText) {
    greetedDay = today;
    const [holiday] = holidaysToday(d);
    if (holiday) return celebrate(holiday);
  }

  const mins = minutesOf(d);
  for (const n of NUDGES) {
    const at = parseHM(n.at);
    const key = `${today}|${n.at}`;
    if (config.chatty && !toastText && !firedNudges.has(key) && mins >= at && mins < at + 10) {
      firedNudges.add(key);
      playOnce(pick(n.anims), { minMs: 3000 });
      return toast(n.say, { ms: 7000 });
    }
  }

  if (t < nextSceneAt) return;
  if (config.liveliness === 0) {
    rest();
  } else if (!quirked && !mood() && Math.random() < QUIRK_CHANCE) {
    quirked = true; // never two in a row
    rest(0.5);
    playOnce(pick(QUIRKS), { minMs: 1500, life: true });
  } else {
    quirked = false;
    startScene(...pickScene(d));
  }
}

// ---------------------------------------------------------------- what the user does

const cooldowns = {};
let lastAppCategory = null;

function onUserEvent({ kind, detail }) {
  if (kind === "alone") {
    leftAlone = true;
    aloneSince = now();
    idleBase = pick(restPool());
    render();
  } else if (kind === "back") {
    onBack(detail);
  } else if (kind === "app") {
    const category = Object.keys(APP_CATEGORIES).find((c) => APP_CATEGORIES[c].includes(detail)) || null;
    if (category && category !== lastAppCategory) reactTo(`app:${category}`, { anims: APP_ANIMS[category], cooldown: 120 });
    lastAppCategory = category;
  } else {
    reactTo(kind, SYS_EVENTS[kind]);
  }
}

function reactTo(key, def) {
  if (!def || asleep) return;
  const t = now();
  if (t < (cooldowns[key] || 0)) return;
  cooldowns[key] = t + (def.cooldown || 20) * 1000;
  playOnce(pick(def.anims), { minMs: 2600 });
  if (def.say && !anyBusy()) toast(def.say);
}

/** The user touched the keyboard or mouse again after `aloneSeconds` without. */
function onBack(aloneSeconds) {
  leftAlone = false;
  presentSince = now();
  const names = [...new Set(unseenDone)].join("、");
  unseenDone = [];
  if (names) toast(`${names} 已经搞定啦，快去看看～`, { ms: 9000 });
  if (!asleep) {
    feel("happy", 2);
    playOnce(pick(ANIMS.welcomeBack), { force: Boolean(names), minMs: 2200 });
    if (!names && config.chatty && aloneSeconds >= 30 * 60) toast(`好久没理我啦${nick()}，想你了～`);
  }
  render();
}

// ---------------------------------------------------------------- labels

function entryLabel(entry) {
  if (!entry) return "Claude Code";
  if (entry === "cli") return "终端";
  if (entry === "claude-desktop") return "Desktop";
  if (entry === "claude-vscode") return "VS Code";
  if (entry.startsWith("sdk")) return "SDK";
  return entry;
}

function projectName(s) {
  const parts = (s.cwd || "").split(/[\\/]/).filter(Boolean);
  // Worktree sessions run in <project>/.claude/worktrees/<name>.
  const wt = parts.findIndex((x, i) => x === ".claude" && parts[i + 1] === "worktrees");
  if (wt > 0) return parts[wt - 1];
  return parts[parts.length - 1] || "会话";
}

function stateText(s) {
  if (s.state === "waiting") return "等你确认";
  if (s.state === "compacting") return "整理记忆";
  if (s.state === "thinking") return "思考中…";
  if (s.state === "working") {
    const base = TOOL_LABELS[s.cat] || "忙活中";
    return s.subagents > 0 ? `${base} · 小分队 ×${s.subagents}` : base;
  }
  return "待命";
}

// ---------------------------------------------------------------- render

function desiredSlug() {
  if (dragging) return dragAnim;
  if (perms.length) return ANIMS.permission[0];
  const lead = leader();
  if (oneShot && (oneShot.force || !lead)) return oneShot.slug;
  if (lead) {
    if (lead.state === "waiting") return ANIMS.waiting[0];
    if (lead.state === "compacting") return ANIMS.compacting[0];
    if (lead.subagents > 0) return ANIMS.subagents[0];
    return lead.anim || ANIMS.thinking[0];
  }
  if (asleep) return sleepAnim;
  return idleBase;
}

function render() {
  // Its own life makes way as soon as Claude has something going on.
  if (oneShot?.life && (perms.length || anyBusy())) cancelLife();
  const slug = desiredSlug();
  // Bubbles sit just above where this animation's drawing starts.
  document.documentElement.style.setProperty("--content-top", manifest[slug]?.top ?? 0);
  const restart = Boolean(oneShot?.fresh && slug === oneShot.slug);
  if (restart) oneShot.fresh = false;
  play(slug, restart);
  renderLabel();
  renderBubble();
  queueHitRects();
}

function renderLabel() {
  const lead = leader();
  let text = "";
  if (lead) {
    const others = [...sessions.values()].filter((x) => x !== lead && x.state !== "idle").length;
    text = `${entryLabel(lead.entry)} · ${projectName(lead)} · ${stateText(lead)}` + (others ? `  +${others}` : "");
  } else if (petHit.matches(":hover")) {
    // What the pet is up to on its own, and how it feels.
    text = asleep ? "睡觉中 💤" : [manifest[currentSlug]?.zh, MOODS[mood()]?.label].filter(Boolean).join(" · ");
  }
  label.textContent = text;
  label.hidden = !text;
}

// ---------------------------------------------------------------- bubbles

let toastText = null;
let toastAction = null;
let toastTimer = null;
let bubbleKey = null;

function toast(text, { sticky = false, ms = TOAST_MS, onClick = null } = {}) {
  toastText = text;
  toastAction = onClick;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(clearToast, ms);
  renderBubble();
  queueHitRects();
}

function clearToast() {
  clearTimeout(toastTimer);
  toastText = null;
  renderBubble();
  queueHitRects();
}

function summarize(input = {}) {
  if (input.command) return String(input.command);
  if (input.file_path) return String(input.file_path);
  if (input.url) return String(input.url);
  if (input.query) return String(input.query);
  if (input.pattern) return String(input.pattern);
  const text = JSON.stringify(input, null, 1) || "";
  return text.length > 400 ? text.slice(0, 400) + "…" : text;
}

function suggestionText(sug) {
  if (sug.type === "addRules") {
    const r = (sug.rules || []).map((x) => (x.ruleContent ? `${x.toolName}(${x.ruleContent})` : x.toolName));
    return `以后自动允许：${r.join(", ")}`;
  }
  if (sug.type === "setMode") return `切换权限模式为 ${sug.mode}`;
  if (sug.type === "addDirectories") return `添加目录：${(sug.directories || []).join(", ")}`;
  return sug.type;
}

function renderBubble() {
  if (perms.length) {
    const req = perms[0];
    if (bubbleKey === `perm-${req.id}-${perms.length}`) return;
    bubbleKey = `perm-${req.id}-${perms.length}`;
    const p = req.payload;
    const s = sessions.get(p.session_id) || { entry: p._entry, cwd: p.cwd };
    const sug = (p.permission_suggestions || [])[0];
    bubble.innerHTML = "";
    const card = el("div", "perm");
    card.append(
      el("div", "who", `${entryLabel(s.entry)} · ${projectName(s)}`),
      el("div", "what", `想用 ${p.tool_name}，可以吗？`),
      el("pre", "", summarize(p.tool_input)),
    );
    const actions = el("div", "actions");
    actions.append(button("拒绝", "deny", () => decide(req, "deny")));
    if (sug) {
      const b = button("总是允许", "", () => decide(req, "always", sug));
      b.title = suggestionText(sug);
      actions.append(b);
    }
    actions.append(button("允许", "allow", () => decide(req, "allow")));
    card.append(actions);
    const foot = el("div", "foot");
    foot.append(el("span", "", perms.length > 1 ? `还有 ${perms.length - 1} 个在排队` : ""));
    const pass = el("a", "", "去原界面处理");
    pass.onclick = () => decide(req, "pass");
    foot.append(pass);
    card.append(foot);
    bubble.append(card);
    bubble.hidden = false;
    return;
  }
  if (toastText) {
    if (bubbleKey === `toast-${toastText}`) return;
    bubbleKey = `toast-${toastText}`;
    bubble.innerHTML = "";
    const t = el("div", "toast", toastText);
    t.onclick = () => {
      toastAction?.();
      clearToast();
    };
    bubble.append(t);
    bubble.hidden = false;
    return;
  }
  bubbleKey = null;
  bubble.hidden = true;
  bubble.innerHTML = "";
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text, cls, onClick) {
  const b = el("button", cls, text);
  b.onclick = onClick;
  return b;
}

function removePerm(id) {
  const i = perms.findIndex((x) => x.id === id);
  if (i >= 0) perms.splice(i, 1);
}

async function decide(req, kind, suggestion) {
  let body = "";
  if (kind !== "pass") {
    const decision =
      kind === "deny"
        ? { behavior: "deny", message: "The user denied this from the Clawd desktop pet." }
        : { behavior: "allow", ...(kind === "always" && suggestion ? { updatedPermissions: [suggestion] } : {}) };
    body = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  }
  removePerm(req.id);
  const s = sessions.get(req.payload.session_id);
  if (s && s.state === "waiting") s.state = "working";
  await invoke("resolve_permission", { id: req.id, body });
  if (kind === "deny") playOnce(pick(ANIMS.denied), { force: true, minMs: 1800 });
  else if (kind !== "pass") playOnce(pick(ANIMS.allowed), { force: true, minMs: 1200 });
  render();
}

// ---------------------------------------------------------------- hit testing

let hitQueued = false;
function queueHitRects() {
  if (hitQueued) return;
  hitQueued = true;
  requestAnimationFrame(() => {
    hitQueued = false;
    const rects = [petHit, bubble, label]
      .filter((e) => !e.hidden)
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0)
      .map((r) => [r.x, r.y, r.width, r.height]);
    invoke("set_hit_rects", { rects });
  });
}

// ---------------------------------------------------------------- interaction

let down = null;
/** A click counts toward a double click if the next one comes within this. */
const CLICK_SETTLE_MS = 300;
const CLICK_SPAM_MS = 2500;
let clicks = []; // recent click times, for spam detection
let burst = 0; // clicks in the sequence still being judged
let clickTimer = null;
let ignoreClicksUntil = 0;
const rub = { lastX: null, dir: 0, turns: 0, t: 0, restUntil: 0 };
let noticeTimer = null;
let noticeRestUntil = 0;

petHit.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
});

petHit.addEventListener("mousemove", (e) => {
  if (e.buttons & 1) {
    if (down && !dragging && Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) startDrag();
    return;
  }
  // Rubbing the mouse back and forth over the pet = petting it.
  if (rub.lastX === null) rub.lastX = e.screenX;
  const dx = e.screenX - rub.lastX;
  if (Math.abs(dx) < 3) return;
  rub.lastX = e.screenX;
  const t = now();
  if (Math.sign(dx) !== rub.dir) {
    if (t - rub.t > 1200) rub.turns = 0;
    rub.dir = Math.sign(dx);
    rub.turns++;
    rub.t = t;
  }
  if (rub.turns >= 4 && t > rub.restUntil) {
    rub.turns = 0;
    rub.restUntil = t + 4000;
    clearTimeout(noticeTimer);
    if (!asleep) {
      feel("loved", 0.5);
      playOnce(pick(ANIMS.petted), { force: true, minMs: 1800 });
    }
  }
});

petHit.addEventListener("mouseup", (e) => {
  if (e.button !== 0 || !down) return;
  down = null;
  onPetClick();
});

petHit.addEventListener("mouseenter", () => {
  rub.lastX = null;
  renderLabel();
  queueHitRects();
  // Notice a cursor that lingers.
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (!petHit.matches(":hover") || asleep || anyBusy() || (oneShot && !oneShot.life) || now() < noticeRestUntil) return;
    noticeRestUntil = now() + 30000;
    playOnce(pick(ANIMS.noticed), { minMs: 1500 });
  }, 2500);
});

petHit.addEventListener("mouseleave", () => {
  clearTimeout(noticeTimer);
  renderLabel();
  queueHitRects();
});

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  invoke("show_menu");
});

function startDrag() {
  down = null;
  dragging = true;
  dragAnim = pick(ANIMS.dragged);
  clearTimeout(noticeTimer);
  invoke("drag_started");
  getCurrentWindow().startDragging();
  render();
}

function onDragEnd() {
  dragging = false;
  stir(AWAKE_AFTER_POKE_MS);
  playOnce(pick(ANIMS.dropped), { force: true, minMs: 1500 });
}

// Clicks are judged once they stop coming, so a double click never flashes the
// single-click reaction first. Five clicks within CLICK_SPAM_MS annoy the pet at
// once, and it ignores further clicks until that tantrum has played out.
function onPetClick() {
  const t = now();
  if (t < ignoreClicksUntil) return;
  clearTimeout(noticeTimer);
  if (stir(AWAKE_AFTER_POKE_MS)) {
    ignoreClicksUntil = t + playOnce(pick(ANIMS.wakeGrumpy), { force: true, minMs: 2000 });
    toast("唔…再让我睡会儿嘛…");
    return;
  }
  clicks = clicks.filter((x) => t - x < CLICK_SPAM_MS);
  clicks.push(t);
  clearTimeout(clickTimer);
  if (clicks.length >= 5) {
    clicks = [];
    burst = 0;
    feel("grumpy", 0.5);
    ignoreClicksUntil = t + playOnce(pick(ANIMS.clickSpam), { force: true, minMs: 1500 });
    return;
  }
  burst++;
  clickTimer = setTimeout(() => {
    const n = burst;
    burst = 0;
    if (n === 2) playRandom();
    else playOnce(pick(ANIMS.click), { force: true, minMs: 1200 });
  }, CLICK_SETTLE_MS);
}

function playRandom() {
  stir(AWAKE_AFTER_POKE_MS);
  playOnce(pick(funSlugs), { force: true, minMs: 2500 });
}

// ---------------------------------------------------------------- boot

function applyConfig(c) {
  const livelinessChanged = !config || config.liveliness !== c.liveliness;
  config = c;
  document.documentElement.style.setProperty("--size", `${c.size}px`);
  if (livelinessChanged) rest();
  queueHitRects();
}

async function boot() {
  const list = await fetch("assets/clawd/manifest.json").then((r) => r.json());
  for (const m of list) manifest[m.slug] = m;
  allSlugs = list.map((m) => m.slug);
  funSlugs = allSlugs.filter((s) => !NOT_FOR_FUN.includes(s));
  applyConfig(await invoke("get_config"));

  await listen("hook-event", (e) => onHook(e.payload));
  await listen("permission-request", (e) => {
    stir(AWAKE_AFTER_WORK_MS);
    perms.push({ id: e.payload.id, payload: e.payload.payload });
    session(e.payload.payload).state = "waiting";
    render();
  });
  await listen("permission-closed", (e) => {
    removePerm(e.payload.id);
    render();
  });
  await listen("user-event", (e) => onUserEvent(e.payload));
  await listen("drag-end", onDragEnd);
  await listen("config", (e) => applyConfig(e.payload));
  await listen("play-random", () => playRandom());
  await listen("play", (e) => {
    stir(AWAKE_AFTER_POKE_MS);
    playOnce(e.payload, { force: true, minMs: 3000 });
  });

  // Files dragged onto the pet. Nothing is done with them.
  await getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "enter") {
      playOnce(pick(ANIMS.fileHover), { force: true, minMs: 1500 });
    } else if (e.payload.type === "drop") {
      playOnce(pick(ANIMS.fileDrop), { force: true, minMs: 2500 });
      toast("接住啦～（只是抱一下，文件原封不动）");
    }
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (config.sys.theme) onUserEvent({ kind: e.matches ? "dark" : "light" });
  });
  window.addEventListener("resize", queueHitRects);
  // The bubble slides when the animation under it changes height.
  $("bubble-area").addEventListener("transitionend", queueHitRects);

  greet();
  setInterval(tick, 1000);
  if (!(await invoke("hooks_installed"))) {
    setTimeout(() => {
      toast("还没连上 Claude Code，点这里去设置里安装联动～", { ms: 15000, onClick: () => invoke("open_settings") });
    }, 6000);
  }
}

boot();
