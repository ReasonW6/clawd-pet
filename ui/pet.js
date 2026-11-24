const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const { getCurrentWebview } = window.__TAURI__.webview;

const $ = (id) => document.getElementById(id);
const sprite = $("sprite");
const bubble = $("bubble");
const label = $("label");
const petHit = $("pet-hit");
const dot = $("dot");
const chatEl = $("chat");

const MIN = 60 * 1000;
const TOAST_MS = 4500;
const STALE_BUSY_MS = 30 * MIN;
/** A compaction whose PostCompact never came (e.g. one Claude Code started on its own
 *  in an idle session) is given up on after this long. */
const COMPACT_MAX_MS = 2 * MIN;
const FORGET_IDLE_MS = 120 * MIN;
const LONG_TASK_MS = 5 * MIN;
const LONG_TASK_BREAK_MS = 4 * MIN;
const AWAKE_AFTER_WORK_MS = 2 * MIN;
const AWAKE_AFTER_POKE_MS = 1 * MIN;
/** Waiting about this long on an unanswered question / plan / form, it turns impatient. */
const PATIENT_MS = 45 * 1000;
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
/** How long a finished turn's last words (and the done animation) stay up. */
const DONE_SHOW_MS = 15 * 1000;
/** Desktop app tools that start another session, and how long a turn that used one
 *  waits for that session to report in before it counts as done. */
const SPAWN_TOOLS = /^mcp__ccd_session__(start_session|hand_off_to_session)$/;
const SPAWN_GRACE_MS = 8 * 1000;
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

// ---------------------------------------------------------------- memory

// With the AI chat and memory on, the pet keeps a note about the user (memory.rs): it
// counts what happens here, has what a chat noted down merged in once it closes, dreams
// over the days at night and brings up what it prepared then.

const memOn = () => config.ai.enabled && config.memory.enabled;
const nowText = () => new Date().toLocaleString("zh-CN", { dateStyle: "full", timeStyle: "short", hour12: false });

/** The day as memory counts it, "YYYY-MM-DD": days start at 05:00, so a night's work belongs to the day before. */
function memDay() {
  const d = new Date(Date.now() - 5 * 60 * MIN);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Milestones reached, as what to say, until a quiet moment to celebrate them. */
const celebrations = [];

/** Something for memory to count (see `memory::event`). */
async function remember(kind, detail = null) {
  if (!memOn()) return;
  const reply = await invoke("memory_event", { kind, detail, day: memDay(), now: nowText() });
  celebrations.push(...(reply?.celebrate || []));
}

/** Shows something the pet prepared to say, `when` "morning", "anytime" or "any"; a click on
 *  it starts a chat that opens with it. Resolves to whether there was one. */
async function bringUp(when) {
  if (!memOn() || !config.memory.proactive || !config.chatty) return false;
  const text = await invoke("memory_topic", { when });
  if (!text) return false;
  toast(text, { ms: 12000, onClick: () => openChat(text) });
  return true;
}

// ---------------------------------------------------------------- animations

let manifest = {}; // slug -> { ms, zh }
let allSlugs = [];
let funSlugs = [];
let currentSlug = null;
/** When currentSlug started from its first frame. */
let slugSince = 0;
let playSeq = 0;
/** False while the window is hidden, by the user or to make way for something full-screen. */
let shown = true;
let ticker = null;

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
  slugSince = now();
  if (!shown) return;
  // Seen for the gallery's collection, unless the gallery asked for it or it just goes on
  // after the pet was hidden.
  const preview = oneShot?.preview && oneShot.slug === slug;
  const again = slug === resumeSlug;
  resumeSlug = null;
  // A unique URL restarts the GIF from frame 0; swap only once it's loaded to avoid flicker.
  const url = `assets/clawd/${slug}.gif?${++playSeq}`;
  const seq = playSeq;
  const pre = new Image();
  pre.onload = () => {
    if (seq !== playSeq) return;
    sprite.src = url;
    if (preview || again) return;
    countedSlug = slug;
    collect(slug);
  };
  pre.src = url;
}

/** A milestone of the gallery's collection, until a quiet moment with the user around. */
let collectCheer = 0;
/** The animation last counted for the collection, and the one to leave uncounted as the
 *  pet shows again. */
let countedSlug = null;
let resumeSlug = null;

async function collect(slug) {
  const cheer = await invoke("collection_seen", { slug }).catch(() => null);
  if (cheer) collectCheer = cheer;
}

/** WebView2 goes on drawing a hidden window, so a hidden pet shows nothing and its
 *  own life stands still. What Claude is doing is still kept track of. */
function setShown(on) {
  if (on === shown) return;
  shown = on;
  clearInterval(ticker);
  if (on) {
    ticker = setInterval(tick, 1000);
    resumeSlug = countedSlug;
    currentSlug = null;
    render();
  } else {
    playSeq++; // drops an animation that is still loading
    sprite.removeAttribute("src");
    // Out of sight is unseen: showing again starts the hotkeys' wait over.
    for (const p of perms) p.shownAt = undefined;
    syncHotkeys();
  }
}

// A one-shot plays for at least `minMs` (whole loops), then hands back to the state
// machine. Unless forced, it stays hidden while Claude is busy. `life` marks a step
// of the pet's own idle life; any other one-shot cuts the scene in progress short.
let oneShot = null; // { slug, force, fresh, life, preview }
let oneShotTimer = null;

function playOnce(slug, { force = false, minMs = 1800, then, life = false, preview = false } = {}) {
  if (!life && scene) {
    scene = null;
    rest();
  }
  const ms = durationOf(slug);
  const total = ms * Math.max(1, Math.ceil(minMs / ms));
  oneShot = { slug, force, fresh: true, life, preview };
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

/** session_id -> { id, entry, cwd, title, parent, parentTitle, state, cat, anim, waitAnim, waitSince, waitUntil, compactSince, subagents, fails, turnStart, nextBreak, t } */
const sessions = new Map();
/** Pending permission requests: { id, payload }. */
const perms = [];

let idleBase = pick(ANIMS.idle);

// Sleep follows the schedule in the settings, not inactivity.
let asleep = false;
let sleepAnim = null;
let awakeUntil = now() + MIN; // stay up a moment after launch
let tuckedIn = null;
let napping = false;

// Dreaming: while a dream goes over its memory (memory.rs says when), and a while after,
// the sleeping pet plays dream animations for its pose instead of plain sleep.
const DREAM_AFTER_MS = 90 * 1000;
const DREAM_EACH_MS = 6400; // two loops of each dream
let dreamOn = false;
let dreamUntil = 0;

function dreamSlug() {
  if (!asleep || (!dreamOn && now() >= dreamUntil)) return null;
  const pool = (napping ? ANIMS.dreamNap : ANIMS.dreamNight).filter((s) => manifest[s]);
  return pool.length ? pool[Math.floor(now() / DREAM_EACH_MS) % pool.length] : null;
}

function onDream(on) {
  dreamOn = on;
  if (!on) dreamUntil = now() + DREAM_AFTER_MS;
  render();
}

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
    s = { id, entry: "", cwd: "", title: "", parent: "", parentTitle: "", parentCwd: "", spawnedAt: 0, state: "idle", cat: null, anim: null, waitAnim: null, waitSince: 0, waitUntil: 0, compactSince: 0, subagents: 0, fails: 0, turnStart: 0, nextBreak: 0, reply: "", t: now() };
    sessions.set(id, s);
  }
  if (p._entry) s.entry = p._entry;
  if (p.cwd) s.cwd = p.cwd;
  if (p._title) s.title = p._title;
  if (p._parent) {
    s.parent = p._parent;
    s.parentTitle = p._parent_title || "";
    s.parentCwd = p._parent_cwd || "";
    // Its sidebar title, until the parent's own transcript gives one.
    const up = sessions.get(s.parent);
    if (up && !up.title) up.title = s.parentTitle;
  }
  s.t = now();
  return s;
}

/** A session started from another in the desktop app (a /btw fork, a session another
 *  one started) counts as part of that one: this is the session at the top. */
function rootOf(s) {
  for (let i = 0; s.parent && i < 8; i++) {
    s = sessions.get(s.parent) || { id: s.parent, entry: s.entry, cwd: s.parentCwd, title: s.parentTitle, state: "idle" };
  }
  return s;
}

/** Busy sessions of the same family as `s`, other than `s`. */
function busyKin(s) {
  const root = rootOf(s).id;
  return [...sessions.values()].filter((x) => x !== s && x.state !== "idle" && rootOf(x).id === root);
}

/** Where an automatic compaction leaves a session: back to the turn it interrupted,
 *  or, when it ran between turns, back to idle. */
const afterCompact = (s) => (s.turnStart ? "thinking" : "idle");

/** Starts waiting for the user: loops one of `anims` for PATIENT_MS first, if given. */
function wait(s, anims) {
  s.state = "waiting";
  s.waitAnim = anims ? pick(anims) : null;
  s.waitSince = now();
  s.waitUntil = 0;
}

/** Still looping its own waiting animation? Once PATIENT_MS is up it finishes the
 *  loop on screen before turning impatient, rather than cutting it off. */
function patient(s) {
  if (!s.waitAnim) return false;
  if (!s.waitUntil) {
    if (now() - s.waitSince < PATIENT_MS) return true;
    const loop = durationOf(s.waitAnim);
    const left = currentSlug === s.waitAnim ? loop - ((now() - slugSince) % loop) : 0;
    s.waitUntil = now() + left;
    if (left) setTimeout(render, left);
  }
  return now() < s.waitUntil;
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

/** What a subagent does that would make an idle session look busy. */
const AGENT_ACTIVITY = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

function onHook(p) {
  const ev = p.hook_event_name;
  const s = session(p);
  // A subagent's own prompt isn't a new turn of the session. And one left running in
  // the background, or still winding down after an interrupt, doesn't make a session
  // that is done busy again.
  if (p.agent_id && (ev === "UserPromptSubmit" || (s.state === "idle" && AGENT_ACTIVITY.has(ev)))) return;
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
      }
      break;
    case "SessionEnd":
      sessions.delete(s.id);
      if (speech?.sid === s.id) hush();
      break;
    case "UserPromptSubmit":
      if (speech?.sid === s.id) hush();
      s.reply = "";
      s.state = "thinking";
      s.cat = null;
      s.anim = pick(ANIMS.thinking);
      s.subagents = 0;
      s.fails = 0;
      s.turnStart = now();
      s.nextBreak = s.turnStart + LONG_TASK_MS;
      break;
    case "PreToolUse": {
      // These wait for the user's answer (a question may get it in the bubble).
      if (p.tool_name === "AskUserQuestion" || p.tool_name === "ExitPlanMode") {
        // Always a fresh wait: any earlier "waiting" belongs to a previous request.
        wait(s, p.tool_name === "ExitPlanMode" ? ANIMS.planReady : ANIMS.asking);
        break;
      }
      const cat = toolCategory(p.tool_name, p.tool_input || {});
      // Each git command gets its own look, so a new one always picks again.
      if (cat === "git") s.anim = pick(gitAnims(p.tool_input?.command));
      else if (cat !== s.cat || s.state !== "working") s.anim = pick(ANIMS.tools[cat]);
      if (cat === "agent") playOnce(pick(ANIMS.agentSent), { force: true, minMs: 2500 });
      s.state = "working";
      s.cat = cat;
      break;
    }
    case "PostToolUse":
      if (SPAWN_TOOLS.test(p.tool_name)) s.spawnedAt = now();
      if (s.state === "waiting") {
        s.state = "working";
        if (p.tool_name === "AskUserQuestion") playOnce(pick(ANIMS.answered), { force: true, minMs: 1500 });
        else if (p.tool_name === "ExitPlanMode") playOnce(pick(ANIMS.planApproved), { force: true, minMs: 1500 });
      } else if (toolCategory(p.tool_name, p.tool_input || {}) === "test") {
        playOnce(pick(ANIMS.testPassed), { force: true, minMs: 2500 });
      }
      break;
    case "PostToolUseFailure":
      if (s.state === "waiting") s.state = "working";
      if (!p.is_interrupt) {
        s.fails++;
        if (s.fails === 3) {
          remember("rough");
          feel("down", 3);
          playOnce(pick(ANIMS.manyErrors), { force: true, minMs: 3000 });
        } else if (toolCategory(p.tool_name, p.tool_input || {}) === "test") {
          playOnce(pick(ANIMS.testFailed), { force: true, minMs: 3000 });
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
      if (s.state !== "compacting") s.compactSince = now();
      s.state = "compacting";
      break;
    case "PostCompact":
      // Late, after COMPACT_MAX_MS gave up on it: the session has moved on since.
      if (s.state !== "compacting") break;
      s.state = p.trigger === "manual" ? "idle" : afterCompact(s);
      break;
    case "Elicitation": // an MCP server asks the user for input
      if (s.state !== "waiting") wait(s, ANIMS.elicitation);
      break;
    case "ElicitationResult": // may also come outside a turn, which no Stop would end
      if (s.state === "waiting") s.state = s.turnStart ? "working" : "idle";
      if (p.action === "accept") playOnce(pick(ANIMS.answered), { force: true, minMs: 1500 });
      break;
    case "Interrupt":
      // Synthetic, from transcript.rs: an interrupt fires no Stop. A marker from
      // before the current prompt belongs to the previous turn.
      if (s.turnStart && Date.parse(p.timestamp) < s.turnStart) break;
      // Polite: only shows when no other session is busy.
      if (s.state !== "idle") playOnce(pick(ANIMS.interrupted), { minMs: 2000 });
      if (speech?.sid === s.id && !speech.done) hush();
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
        if (s.state !== "waiting" && !perms.some((x) => x.payload.session_id === s.id)) wait(s);
      }
      break;
    case "PermissionRequest": // only reaches here when the bubble isn't used
      // So does ExitPlanMode, always, right after its PreToolUse.
      if (s.state !== "waiting") wait(s);
      break;
    case "Reply":
      // Synthetic, from transcript.rs: the first line of something Claude said.
      if (!config.replies || (s.turnStart && Date.parse(p.timestamp) < s.turnStart)) break;
      s.reply = p.text;
      say(s, false);
      break;
    case "Stop":
      onTurnDone(s);
      break;
    case "StopFailure":
      if (speech?.sid === s.id) hush();
      s.state = "idle";
      s.subagents = 0;
      s.turnStart = 0;
      feel("down", 3);
      // Already counted at its third failed tool.
      if (s.fails < 3) remember("rough");
      s.fails = 0;
      playOnce(pick(ANIMS.apiError), { force: true, minMs: 3000 });
      toast(`呜…出错了（${p.error_type || p.error || "unknown"}）`);
      break;
  }
  render();
}

function onTurnDone(s) {
  const took = s.turnStart ? now() - s.turnStart : 0;
  s.state = "idle";
  s.subagents = 0;
  s.turnStart = 0;
  // Not every turn starts with UserPromptSubmit, which clears this too.
  s.fails = 0;
  // A session it just started in the desktop app takes a moment to report in: give it
  // that before telling whether the family is done.
  const grace = s.spawnedAt + SPAWN_GRACE_MS - now();
  s.spawnedAt = 0;
  if (grace > 0) {
    setTimeout(() => {
      if (s.state !== "idle" || sessions.get(s.id) !== s) return; // it went on meanwhile
      familyDone(s, took);
      render();
    }, grace);
    return;
  }
  familyDone(s, took);
}

function familyDone(s, took) {
  const name = projectName(rootOf(s));
  // Sessions started from one another are done when all of them are; till then only
  // its last words show.
  if (busyKin(s).length) {
    if (config.replies && s.reply) say(s, true);
    return;
  }
  remember("task", { project: name, minutes: Math.round(took / MIN) });

  let [text, ms, anims, minMs] = [`${name} 搞定啦～`, TOAST_MS, ANIMS.done, 2600];
  if (sleepWindowAt(new Date())) {
    [text, anims, minMs] = [`${name} 搞定…困了 💤`, ANIMS.sleepyDone, 2500];
  } else if (took >= LONG_TASK_MS) {
    [text, ms, anims, minMs] = [`${name} 跑了 ${Math.round(took / MIN)} 分钟，终于搞定啦！`, 7000, ANIMS.bigDone, 3500];
    feel("proud", 5);
  } else if (took >= MIN) {
    feel("happy", 3);
  }
  if (config.replies && s.reply) {
    // Its last words, ticked, with the done animation for a while; onBack still
    // tells a user who was away.
    if (leftAlone) unseenDone.push(name);
    say(s, true);
    if (!anyBusy()) speech.anim = pick(anims);
    if (speech.anim) playOnce(speech.anim, { minMs: DONE_SHOW_MS });
    return;
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

// ---------------------------------------------------------------- what Claude says

// The first line of each thing Claude says shows above the pet as it comes. When the
// turn ends its last words stay up for DONE_SHOW_MS with a tick; a click on them or on
// the pet meanwhile goes to that session in the desktop app. Then they shrink into the pet.
let speech = null; // { sid, text, done, anim, timer, leaving }
const HUSH_MS = 320; // the .leaving animation in style.css
// The user can fold the words away: then a dot by the status line counts the sessions with
// something going on, until a click on it brings the words back.
let folded = false;
let folding = false;

function say(s, done) {
  clearTimeout(speech?.timer);
  speech = { sid: s.id, text: s.reply, done, anim: null, timer: null, leaving: false };
  if (done) speech.timer = setTimeout(hush, DONE_SHOW_MS);
  renderBubble();
  queueHitRects();
}

/** Shrinks the words into the pet, or just drops them if something else is showing. */
function hush() {
  if (!speech || speech.leaving) return;
  clearTimeout(speech.timer);
  if (!bubbleKey?.startsWith("speech-")) {
    speech = null;
    return;
  }
  speech.leaving = true;
  bubble.classList.add("leaving");
  const gone = speech;
  setTimeout(() => {
    if (speech === gone) speech = null;
    renderBubble();
    queueHitRects();
  }, HUSH_MS);
}

function fold() {
  if (folding || folded) return;
  folding = true;
  bubble.classList.add("leaving");
  setTimeout(() => {
    folding = false;
    folded = true;
    renderBubble();
    queueHitRects();
  }, HUSH_MS);
}

function unfold() {
  folded = false;
  renderBubble();
  queueHitRects();
}

/** Sessions with something to say: those at work, and the one whose words are up. A
 *  session and those started from it count once. */
function talkers() {
  const busy = [...sessions.values()].filter((s) => s.state !== "idle" || s.id === speech?.sid);
  return new Set(busy.map((s) => rootOf(s).id)).size;
}

function renderDot() {
  const n = folded ? talkers() : 0;
  dot.hidden = !n;
  dot.textContent = n > 99 ? "99+" : String(n);
}

/** A click on finished words or on the pet under them: back to that session. */
function followSpeech() {
  if (!speech?.done || speech.leaving) return false;
  const s = sessions.get(speech.sid);
  if (s && fromDesktop(s)) invoke("focus_claude", { title: s.title || null });
  if (speech.anim && oneShot?.slug === speech.anim) {
    clearTimeout(oneShotTimer);
    oneShot = null;
    render();
  }
  hush();
  return true;
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
    if (inRange(t, from, to)) return { key: `${w.start}-${w.end}`, start: w.start, minutes: (to - from + 1440) % 1440 };
  }
  return null;
}

function fallAsleep(win) {
  const nap = win.minutes <= NAP_MAX_MINUTES;
  // Past midnight, a window that started the evening before is still that night's.
  const d = new Date();
  const started = minutesOf(d) < parseHM(win.start) ? new Date(d.getTime() - 24 * 60 * MIN) : d;
  const key = `${started.toDateString()}|${win.key}`;
  // The first time in a window, as opposed to dozing off again after being woken.
  const first = tuckedIn !== key;
  tuckedIn = key;
  if (first && config.chatty) toast(nap ? "午休时间，我眯一会儿～" : `我先睡啦${nick()}，你也早点休息哦～ 💤`);
  // Its first sleep in a window is when it goes over its memory; the dream animations
  // play only if that asks the model (the "dream" event).
  if (first && memOn()) invoke("memory_dream", { day: memDay(), now: nowText(), why: nap ? "nap" : "night" });
  const yawn = () =>
    playOnce(pick(ANIMS.yawn), {
      minMs: 3000,
      then: () => {
        if (anyBusy() || !sleepWindowAt(new Date())) return;
        asleep = true;
        napping = nap;
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
  if (!config.chatty) return;
  const hello = date.getHours() < 11 ? `早上好${nick()}！新的一天开始啦～` : "睡醒啦，继续开工～";
  // Something it prepared in its dream, if it did.
  bringUp(date.getHours() < 11 ? "morning" : "anytime").then((said) => said || toast(hello));
}

function holidaysToday(date) {
  return config.sys.holidays ? holidaysOn(date, config.birthday) : [];
}

function celebrate(holiday) {
  playOnce(pick(holiday.anims), { minMs: 3500 });
  toast(holiday.say, { ms: 7000 });
  remember("holiday", holiday.name);
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
  memoryTick(t, d);

  for (const s of [...sessions.values()]) {
    if (s.state === "compacting" && t - s.compactSince > COMPACT_MAX_MS) s.state = afterCompact(s);
    if (s.state !== "idle" && t - s.t > STALE_BUSY_MS) s.state = "idle";
    if (s.state === "idle" && t - s.t > FORGET_IDLE_MS) sessions.delete(s.id);
  }

  // A coffee break now and then during long tasks.
  const lead = leader();
  if (lead && lead.turnStart && t > lead.nextBreak && (lead.state === "working" || lead.state === "thinking") && !perms.length) {
    lead.nextBreak = t + LONG_TASK_BREAK_MS;
    playOnce(pick(ANIMS.longTask), { force: true, minMs: 3000 });
  }

  // Left open with nothing going on, the chat would keep bubbles and reminders away
  // for good.
  if (chat) {
    // An open box counts only while something is typed in it or the pet has focus:
    // opened and then clicked away from, it would hold the chat open forever.
    const composing = chat.stack.some((m) => m.kind === "compose" && (m.input?.value.trim() || document.hasFocus()));
    if (chat.phase !== "idle" || composing) chat.quietSince = t;
    else if (t - chat.quietSince >= CHAT_IDLE_MS) closeChat();
  }

  const quiet = !lead && !perms.length && !oneShot && !dragging && !chat;
  if (!quiet) nextSceneAt = Math.max(nextSceneAt, t + CALM_AFTER_MS);
  const win = sleepWindowAt(d);
  if (asleep && !win) {
    wakeUp(d);
  } else if (!asleep && win && quiet && t > awakeUntil) {
    fallAsleep(win);
  } else if (!asleep && !leftAlone && !chat && config.sedentaryMinutes > 0 && t - presentSince >= config.sedentaryMinutes * MIN) {
    presentSince = t;
    playOnce(pick(ANIMS.stretch), { minMs: 3000 });
    toast(`已经坐了 ${config.sedentaryMinutes} 分钟啦，起来活动一下～`, { ms: 7000 });
  } else if (!asleep && !win && quiet) {
    idleLife(t, d);
  }
  render();
}

let memDayNow = null;
let lateAt = 0;

/** Tells memory about a new day (the pet is around to see it), and about the user still
 *  at the computer in the small hours. */
function memoryTick(t, d) {
  if (!memOn()) return;
  const day = memDay();
  if (day !== memDayNow) {
    memDayNow = day;
    remember("day");
  }
  if (d.getHours() < 5 && !leftAlone && t - lateAt >= 10 * MIN) {
    lateAt = t;
    remember("late", `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
  }
}

// Things it prepared to say, brought up at most this often.
const TOPICS_PER_DAY = 2;
const TOPIC_GAP_MS = 2 * 60 * MIN;
let topicsSaid = { day: null, n: 0, at: 0 };
let nextTopicTry = now() + 10 * MIN;

/** What the pet does on its own while nothing is going on. */
function idleLife(t, d) {
  const today = d.toDateString();
  if (today !== greetedDay && !toastText) {
    greetedDay = today;
    const [holiday] = holidaysToday(d);
    if (holiday) return celebrate(holiday);
  }

  // A milestone reached while it was busy, asleep or chatting.
  if (celebrations.length && !toastText) {
    playOnce(pick(ANIMS.milestone), { minMs: 3500 });
    return toast(celebrations.shift(), { ms: 8000 });
  }

  // A milestone of the gallery's collection, cheered with the user there to see it.
  if (collectCheer && !leftAlone && !toastText) {
    const all = collectCheer >= allSlugs.length;
    playOnce(pick(all ? ANIMS.collectedAll : ANIMS.collected), { minMs: 3500 });
    toast(all ? "动画图鉴全部收集齐啦！每个样子你都见过了🎉" : `动画图鉴收集突破 ${collectCheer} 个啦～`, { ms: 8000 });
    invoke("collection_cheered", { milestone: collectCheer }).catch(() => {});
    collectCheer = 0;
    return;
  }

  if (!leftAlone && !toastText && t >= nextTopicTry && memOn() && config.memory.proactive) {
    nextTopicTry = t + 10 * MIN;
    const day = memDay();
    if (topicsSaid.day !== day) topicsSaid = { day, n: 0, at: 0 };
    if (topicsSaid.n < TOPICS_PER_DAY && t - topicsSaid.at >= TOPIC_GAP_MS) {
      // Before 11 what it meant to say in the morning may still go.
      bringUp(d.getHours() < 11 ? "any" : "anytime").then((said) => {
        if (!said) return;
        topicsSaid.n++;
        topicsSaid.at = now();
      });
    }
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
    onBack();
  } else if (kind === "claude-quit") {
    // Its sessions went with it, whether or not their SessionEnd made it out.
    for (const [id, s] of sessions) if (fromDesktop(s)) sessions.delete(id);
    if (speech && !sessions.has(speech.sid)) hush();
    reactTo(kind, SYS_EVENTS[kind]);
    render();
  } else if (kind === "app") {
    const category = Object.keys(APP_CATEGORIES).find((c) => APP_CATEGORIES[c].includes(detail)) || null;
    if (category && category !== lastAppCategory) reactTo(`app:${category}`, { anims: APP_ANIMS[category], cooldown: 120 });
    lastAppCategory = category;
  } else {
    if (kind.startsWith("git-")) remember("git", kind.slice(4));
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

/** The user touched the keyboard or mouse again after a while without. The pet has
 *  been getting on with its own life meanwhile, so it doesn't drop it to say hello. */
function onBack() {
  leftAlone = false;
  presentSince = now();
  const names = [...new Set(unseenDone)].join("、");
  unseenDone = [];
  if (names) toast(`${names} 已经搞定啦，快去看看～`, { ms: 9000 });
  render();
}

// ---------------------------------------------------------------- labels

/** Sessions in the Claude desktop app, which all end when it quits. */
const fromDesktop = (s) => s.entry === "claude-desktop";

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

/** The session's title (as in the Desktop app's sidebar, or set by /rename), else where it runs. */
function sessionName(s) {
  return s.title || `${entryLabel(s.entry)} · ${projectName(s)}`;
}

function stateText(s) {
  if (s.state === "waiting") return perms.some((x) => x.ask && x.payload.session_id === s.id) ? "等你回答" : "等你确认";
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
  if (perms.length) return perms[0].ask?.anim || ANIMS.permission[0];
  const lead = leader();
  if (oneShot?.force) return oneShot.slug;
  // Chatting, it stays at its desk with the user; the label still tells how Claude is doing.
  if (chat) return chatSlug();
  if (oneShot && !lead) return oneShot.slug;
  if (lead) {
    if (lead.state === "waiting") {
      return patient(lead) ? lead.waitAnim : ANIMS.waiting[0];
    }
    if (lead.state === "compacting") return ANIMS.compacting[0];
    if (lead.subagents > 0) return ANIMS.subagents[0];
    return lead.anim || ANIMS.thinking[0];
  }
  if (asleep) return dreamSlug() || sleepAnim;
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
    // Under the name of the session at the top of its family, with how many of those
    // started from it are busy.
    const root = rootOf(lead);
    const forks = busyKin(root).length;
    text = `${sessionName(root)} · ${stateText(lead)}${forks ? ` · 分支 ×${forks}` : ""}`;
  } else if (petHit.matches(":hover")) {
    // What the pet is up to on its own, and how it feels.
    text = asleep ? (dreamSlug() ? "做梦中 💭" : "睡觉中 💤") : [manifest[currentSlug]?.zh, MOODS[mood()]?.label].filter(Boolean).join(" · ");
  }
  label.textContent = text;
  label.hidden = !text;
}

// ---------------------------------------------------------------- bubbles

let toastText = null;
let toastAction = null;
let toastTimer = null;
let bubbleKey = null;
/** What the hotkeys were last asked to be held for: "" none, "plain", or "always" too;
 *  null at first, so a reloaded page tells the backend even when it wants none. */
let hotkeysFor = null;
const HOTKEY_ACTIONS = ["allow", "deny", "always"];
/** A request answers its hotkeys only once it has been on show this long: a second press
 *  meant for the one before, or one already on its way as it was answered elsewhere,
 *  doesn't answer one the user hasn't looked at. */
const HOTKEY_SETTLE_MS = 700;

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
  // Anything else (MCP tools mostly): one "key: value" line per argument.
  const text = Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  return text.length > 400 ? text.slice(0, 400) + "…" : text;
}

/** "mcp__server__tool" reads as "tool"; the full name stays in the tooltip. */
function toolName(name = "") {
  const m = /^mcp__.+?__(.+)$/.exec(name);
  return m ? m[1] : name;
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
  drawBubble();
  syncHotkeys();
  placeBubble();
}

/** The hotkeys are held only while the bubble shows a request (hotkeys.rs). */
function syncHotkeys() {
  // A question card has no allow / deny to give, so it holds no hotkeys.
  const req = shown && !perms[0]?.ask ? perms[0] : null;
  const want = !req ? "" : req.payload.permission_suggestions?.length ? "always" : "plain";
  if (want === hotkeysFor) return;
  hotkeysFor = want;
  invoke("permission_hotkeys", { on: Boolean(want), always: want === "always" });
}

/** A hotkey pressed: the request the bubble shows is answered as by its button, once it
 *  has been on show a moment (`HOTKEY_SETTLE_MS`). */
function onPermHotkey(action) {
  const req = perms[0];
  const sug = req?.payload.permission_suggestions?.[0];
  if (!req || !shown || bubble.hidden || req.ask || req.hotkeyed || (action === "always" && !sug)) return;
  // Not yet on show (undefined) counts as too soon too.
  if (!(performance.now() - req.shownAt >= HOTKEY_SETTLE_MS)) return;
  req.hotkeyed = true;
  // The button shows pressed for a moment first, so it's clear which answer went.
  bubble.querySelector(`.perm button[data-act="${action}"]`)?.classList.add("pressed");
  setTimeout(() => perms.includes(req) && decide(req, action, sug), 140);
}

/** Marks a button with its action, for a hotkey press to show it pressed. The hotkeys
 *  themselves aren't shown on the buttons. */
function keyCap(b, action) {
  b.dataset.act = action;
}

function drawBubble() {
  renderDot();
  // The chat gives way to a permission request, and otherwise has the space to itself.
  chatEl.classList.toggle("away", perms.length > 0);
  if ((chat || msgs.size) && !perms.length) {
    bubbleKey = null;
    bubble.hidden = true;
    bubble.innerHTML = "";
    return;
  }
  bubble.classList.toggle("leaving", Boolean((speech?.leaving || folding) && !perms.length && !toastText));
  if (perms.length) {
    const req = perms[0];
    if (shown && req.shownAt === undefined) req.shownAt = performance.now();
    if (req.ask) return drawAsk(req);
    const key = `perm-${req.id}-${perms.length}`;
    if (bubbleKey === key) return;
    bubbleKey = key;
    const p = req.payload;
    const s = sessions.get(p.session_id) || { entry: p._entry, cwd: p.cwd, title: p._title };
    const sug = (p.permission_suggestions || [])[0];
    bubble.innerHTML = "";
    const card = el("div", "perm");
    const who = el("div", "who", sessionName(s));
    who.title = sessionName(s);
    const what = el("div", "what", `想用 ${toolName(p.tool_name)}，可以吗？`);
    what.title = p.tool_name;
    card.append(who, what);
    const args = summarize(p.tool_input);
    if (args) card.append(el("pre", "", args));
    const actions = el("div", "actions");
    const deny = button("拒绝", "deny", () => decide(req, "deny"));
    keyCap(deny, "deny");
    actions.append(deny);
    if (sug) {
      const b = button("总是允许", "", () => decide(req, "always", sug));
      b.title = suggestionText(sug);
      keyCap(b, "always");
      actions.append(b);
    }
    const allow = button("允许", "allow", () => decide(req, "allow"));
    keyCap(allow, "allow");
    actions.append(allow);
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
  if (speech && !folded) {
    // Whose words, when more than one session is going.
    const s = sessions.get(speech.sid);
    const busy = [...sessions.values()].filter((x) => x.state !== "idle" && x !== s).length;
    const who = s && busy ? sessionName(s) : "";
    const key = `speech-${speech.sid}-${speech.done}-${who}-${speech.text}`;
    if (bubbleKey === key) return;
    bubbleKey = key;
    bubble.innerHTML = "";
    const card = el("div", speech.done ? "speech done" : "speech");
    if (who) card.append(el("div", "who", who));
    const line = el("div", "line");
    const text = el("span", "text", speech.text);
    text.title = speech.text;
    line.append(text);
    if (speech.done) line.append(el("span", "tick", "✓"));
    card.append(line);
    const close = el("button", "fold");
    close.title = "收起";
    close.onclick = (e) => {
      e.stopPropagation();
      fold();
    };
    card.append(close);
    card.onclick = followSpeech;
    bubble.append(card);
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
  // A question handed back is still waiting for its answer, there.
  if (s && s.state === "waiting" && !(kind === "pass" && req.ask)) s.state = "working";
  await invoke("resolve_permission", { id: req.id, body });
  if (kind === "deny") playOnce(pick(ANIMS.denied), { force: true, minMs: 1800 });
  else if (kind !== "pass") playOnce(pick(ANIMS.allowed), { force: true, minMs: 1200 });
  render();
}

// ---------------------------------------------------------------- questions

// AskUserQuestion, answered in the bubble: one page per question. A choice question has
// its options plus a box to write one's own answer; with `kind` "text" or "number" there
// is only the box. The public AskUserQuestion docs have only question / header / options /
// multiSelect: `kind`, `title`, `unit`, `placeholder`, `min` / `max` / `step` and
// `defaultValue` are read in case a newer Claude Code sends such forms, and haven't been
// checked against one.

const ASK_KINDS = [undefined, "choice", "text", "number"];

/** What has been answered so far, for a request the bubble can show; null otherwise. */
function askState(p) {
  const qs = p.tool_input?.questions;
  const fits = (q) => q && typeof q.question === "string" && ASK_KINDS.includes(q.kind) && (Array.isArray(q.options) || isTyped(q));
  if (!Array.isArray(qs) || !qs.length || !qs.every(fits)) return null;
  return {
    page: 0,
    anim: pick(ANIMS.asking),
    picks: qs.map(() => new Set()), // indexes of the options picked
    // Only a default the question gives is filled in: the smallest number allowed would
    // count as answered without the user having looked.
    text: qs.map((q) => (q.kind === "number" ? String(q.defaultValue ?? "") : "")),
    // Whether one's own answer counts, for a choice question.
    own: qs.map(() => false),
  };
}

const isTyped = (q) => q.kind === "text" || q.kind === "number";

/** The answer to question `i` as Claude Code takes it (a label, the text written, or
 *  for multi-select the labels joined with commas, which every version reads), or null
 *  while there is none. */
function askAnswer(q, a, i) {
  const text = a.text[i].trim();
  if (q.kind === "number") {
    const n = Number(text);
    return text && Number.isFinite(n) && !(n < q.min) && !(n > q.max) ? text : null;
  }
  if (q.kind === "text") return text || null;
  const picked = q.options.filter((_, j) => a.picks[i].has(j)).map((o) => String(o.label));
  if (a.own[i] && text) picked.push(text);
  if (!picked.length) return null;
  return q.multiSelect ? picked.join(", ") : picked[0];
}

function drawAsk(req) {
  const a = req.ask;
  const p = req.payload;
  const qs = p.tool_input.questions;
  const key = `ask-${req.id}-${a.page}`;
  // Another request joining the queue only changes the count, in place: drawing the card
  // again would lose the caret and break off what an input method is composing.
  const queued = perms.length > 1 ? `还有 ${perms.length - 1} 个在排队` : "";
  if (bubbleKey === key) {
    const line = bubble.querySelector(".ask .queued");
    if (line && line.textContent !== queued) {
      line.textContent = queued;
      queueHitRects();
    }
    return;
  }
  // Drawn again while typing (another request joined the queue): the box keeps the focus.
  const typing = document.activeElement?.closest?.("#bubble input");
  bubbleKey = key;
  const s = sessions.get(p.session_id) || { entry: p._entry, cwd: p.cwd, title: p._title };
  const i = a.page;
  const q = qs[i];
  const last = i === qs.length - 1;

  bubble.innerHTML = "";
  const card = el("div", "perm ask");
  const top = el("div", "top");
  top.append(el("span", "chip", q.header || "提问"));
  const who = el("span", "who", sessionName(s));
  who.title = sessionName(s);
  top.append(who);
  const steps = el("span", "steps");
  if (qs.length > 1) {
    qs.forEach((_, j) => {
      const dotEl = el("button", j === i ? "now" : "");
      dotEl.title = `第 ${j + 1} 题`;
      dotEl.onclick = () => askGo(req, j);
      steps.append(dotEl);
    });
  }
  top.append(steps);
  card.append(top);
  if (p.tool_input.title) card.append(el("div", "hint", p.tool_input.title));
  card.append(el("div", "what", q.question));
  if (q.description) card.append(el("div", "hint", q.description));

  const list = el("div", "opts");
  const rows = [];
  if (!isTyped(q)) {
    q.options.forEach((o, j) => {
      const b = el("button", "opt");
      b.append(el("span", q.multiSelect ? "mark multi" : "mark"));
      const txt = el("span", "txt");
      txt.append(el("span", "label", String(o.label)));
      if (o.description) {
        const d = el("span", "desc", String(o.description));
        d.title = String(o.description);
        txt.append(d);
      }
      b.append(txt);
      b.onclick = () => {
        if (q.multiSelect) {
          if (!a.picks[i].delete(j)) a.picks[i].add(j);
        } else {
          a.picks[i] = new Set([j]);
          a.own[i] = false;
        }
        sync();
        // One pick answers it: on to the next question, after a moment to see it ticked.
        if (!q.multiSelect && !last) setTimeout(() => perms[0] === req && a.page === i && askGo(req, i + 1), 260);
      };
      rows.push([b, () => a.picks[i].has(j)]);
      list.append(b);
    });
  }
  const own = el("label", isTyped(q) ? "opt own typed" : "opt own");
  const ownMark = el("span", q.multiSelect ? "mark multi" : "mark");
  if (!isTyped(q)) {
    own.append(ownMark);
    ownMark.onclick = (e) => {
      // Ticks or unticks one's own answer; the box itself is clicked to write in it.
      e.preventDefault();
      a.own[i] = !a.own[i];
      if (a.own[i] && !q.multiSelect) a.picks[i].clear();
      sync();
      if (a.own[i]) input.focus();
    };
    rows.push([own, () => a.own[i]]);
  }
  const input = el("input");
  input.type = q.kind === "number" ? "number" : "text";
  input.spellcheck = false;
  input.value = a.text[i];
  input.placeholder = q.kind === "text" ? q.placeholder || "写下你的回答…" : q.kind === "number" ? q.placeholder || "填一个数" : "其他：自己写…";
  if (q.kind === "number") {
    for (const k of ["min", "max", "step"]) if (q[k] !== undefined) input[k] = q[k];
  }
  // The pet's window has to take the keyboard to be typed into.
  own.addEventListener("pointerdown", () => invoke("chat_focus"));
  input.addEventListener("input", () => {
    a.text[i] = input.value;
    if (!isTyped(q)) {
      a.own[i] = input.value.trim() !== "";
      if (a.own[i] && !q.multiSelect) a.picks[i].clear();
    }
    sync();
  });
  input.addEventListener("keydown", (e) => {
    // Not for the chat's keys (Esc there closes the chat).
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing && !next.disabled) next.click();
    else if (e.key === "Escape") input.blur();
  });
  own.append(input);
  if (q.kind === "number") {
    const range = [q.min, q.max].every((v) => v !== undefined) ? `${q.min}–${q.max}` : "";
    own.append(el("span", "unit", [q.unit, range && `（${range}）`].filter(Boolean).join(" ")));
  }
  list.append(own);
  card.append(list);

  // Handing it back to the native UI on the left, so the buttons stay where they are.
  const actions = el("div", "actions");
  const side = el("span", "side");
  const pass = el("a", "", "去原界面回答");
  pass.onclick = () => decide(req, "pass");
  side.append(pass);
  side.append(el("span", "queued", queued));
  actions.append(side);
  if (i > 0) actions.append(button("上一题", "back", () => askGo(req, i - 1)));
  const next = button(last ? "提交" : "下一题", "allow", () => (last ? askSubmit(req) : askGo(req, i + 1)));
  actions.append(next);
  card.append(actions);

  /** Shows what is picked, which questions have an answer, and whether to go on. */
  function sync() {
    for (const [row, on] of rows) row.classList.toggle("on", on());
    [...steps.children].forEach((d, j) => d.classList.toggle("done", askAnswer(qs[j], a, j) !== null));
    next.disabled = askAnswer(q, a, i) === null;
    // The option picked shows all of its description, which may make the bubble taller.
    queueHitRects();
  }
  sync();
  bubble.append(card);
  bubble.hidden = false;
  if (typing || (isTyped(q) && document.hasFocus())) input.focus({ preventScroll: true });
}

function askGo(req, page) {
  req.ask.page = page;
  renderBubble();
  queueHitRects();
}

/** Sends the answers: the call's input as it was asked, with `answers` keyed by each
 *  question's text. A question still without one is shown instead. */
async function askSubmit(req) {
  const a = req.ask;
  const qs = req.payload.tool_input.questions;
  const answers = {};
  for (let i = 0; i < qs.length; i++) {
    const answer = askAnswer(qs[i], a, i);
    if (answer === null) return askGo(req, i);
    answers[qs[i].question] = answer;
  }
  const decision = { behavior: "allow", updatedInput: { ...req.payload.tool_input, answers } };
  const body = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  removePerm(req.id);
  const s = sessions.get(req.payload.session_id);
  if (s && s.state === "waiting") s.state = "working";
  await invoke("resolve_permission", { id: req.id, body });
  playOnce(pick(ANIMS.answered), { force: true, minMs: 1500 });
  render();
}

// ---------------------------------------------------------------- hit testing

let hitQueued = false;
let hitSent = "";
function queueHitRects() {
  if (hitQueued) return;
  hitQueued = true;
  requestAnimationFrame(() => {
    hitQueued = false;
    const chatParts = chatEl.classList.contains("away")
      ? []
      : [...chatEl.querySelectorAll(".msg:not(.gone):not(.standby) > .card, .msg:not(.gone):not(.nox):not(.standby) > .x")];
    const rects = [petHit, bubble, label, dot]
      .filter((e) => !e.hidden)
      .concat(chatParts)
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0)
      .map((r) => [r.x, r.y, r.width, r.height].map(Math.round));
    // Asked for on every render; told to the backend only when something moved. The
    // pet itself is told apart too: the backend keeps it on the screen.
    const r = petHit.getBoundingClientRect();
    const body = [r.x, r.y, r.width, r.height].map(Math.round);
    const key = `${rects.join()}|${body}`;
    if (key === hitSent) return;
    hitSent = key;
    invoke("set_hit_rects", { rects, body });
  });
}

// ---------------------------------------------------------------- screen edges

// The window is wider than the pet, and with the pet against a side of the screen part
// of it is off screen (edges.rs keeps the pet itself on). The bubbles stay in the part
// that shows: over the pet where there is room, pushed in from the edge where not.
let edges = { left: 0, top: 0, right: 0, bottom: 0 };

function onEdges(e) {
  edges = e;
  const root = document.documentElement.style;
  for (const side of ["left", "top", "right", "bottom"]) root.setProperty(`--off-${side}`, `${e[side]}px`);
  placeBubble();
  fitChat();
  queueHitRects();
}

/** Keeps the bubble over the pet as far as the room on screen allows, its tail where it
 *  would be on a bubble right over the pet, clear of the rounded corners. */
function placeBubble() {
  if (bubble.hidden) return;
  const area = bubble.parentElement;
  // Layout sizes, which the pop and shrink animations don't scale. Unshifted, the
  // bubble sits in the middle of its area.
  const w = bubble.offsetWidth;
  const over = innerWidth / 2 - area.offsetLeft - w / 2;
  const left = clamp(over, 0, area.clientWidth - w);
  bubble.style.setProperty("--shift", `${left - (area.clientWidth - w) / 2}px`);
  // From the padding box's left, as the tail is placed.
  bubble.style.setProperty("--tail-x", `${clamp(over + w - 42 - left, 24, w - 28)}px`);
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

dot.addEventListener("click", unfold);

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
      remember("petted");
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
  if (e.target.closest("#chat .msg")) return; // copy and paste in the chat
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
  if (chat) return chatPoke();
  if (followSpeech()) return;
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
    remember("grumpy");
    ignoreClicksUntil = t + playOnce(pick(ANIMS.clickSpam), { force: true, minMs: 1500 });
    return;
  }
  burst++;
  // With the AI chat on, a double click opens it straight away.
  if (burst === 2 && config.ai.enabled) {
    burst = 0;
    clicks = [];
    return openChat();
  }
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

// ---------------------------------------------------------------- AI chat

// With the AI chat on, a double click opens a box above the pet for talking to a model
// (src-tauri/src/ai.rs); while the chat is open a single click opens it again. The
// bubbles stack up from the pet, two at most: the user's message on the right, the
// reply on the left. A sent message floats off once its reply is in, and the last
// reply once the next message goes out. The conversation lives here only until the
// chat is closed.
//
// Every bubble moves on springs rather than CSS transitions, so that a bubble pushed
// again mid-flight carries on smoothly from wherever it is.
const CHAT_GAP = 10;
/** The card's border (style.css) goes around the body, so a card is this much bigger
 *  than its body on each side. A card any smaller could be scrolled, by the caret say,
 *  and stay that way with its colour no longer reaching its bottom. */
const CARD_BORDER = 2;
/** Room above the top bubble for its close button. */
const CHAT_TOP_ROOM = 12;
/** Messages sent along as context, counting both sides. */
const CHAT_HISTORY = 24;
/** How soon after a box pops up from blind typing an Enter is ignored rather than sending. */
const WOKE_ENTER_MS = 500;
/** The chat closes itself after this long with no box open and no reply coming. */
const CHAT_IDLE_MS = 4 * MIN;
/** How far either side of the pet the tails are: the reply's on its left, the user's on its right. */
const TAIL_REACH = 48;
/** How far in from its outer end a bubble's tail sits, while the window leaves room for that. */
const TAIL_INSET = 30;
/** How far a bubble may reach across the pet's middle; one wider grows out on its own side. */
const CHAT_REACH = 70;
let chat = null; // { seq, req, history: [{ role, text }], stack: [msg] top to bottom, phase, reply, quietSince }
let chatReq = 0;
/** Numbers the chats, for the pages the backend lets each one open. From the time, so
 * that a reloaded page doesn't count from 1 again into a chat the backend still keeps. */
let chatSeq = Date.now();
/** Bubbles on screen, those on their way out included: { kind, el, card, body, sp, gone, ... }. */
const msgs = new Set();

/** A damped spring (unit mass) heading for `to`. */
class Spring {
  constructor(v, [stiffness, damping, eps]) {
    this.v = this.to = v;
    this.vel = 0;
    this.k = stiffness;
    this.c = damping;
    this.eps = eps;
  }
  step(dt) {
    this.vel += (-this.k * (this.v - this.to) - this.c * this.vel) * dt;
    this.v += this.vel * dt;
  }
  get still() {
    return Math.abs(this.v - this.to) < this.eps && Math.abs(this.vel) < this.eps * 10;
  }
}
// [stiffness, damping, rest threshold]; damping ratio = damping / (2 * sqrt(stiffness)).
const MOVE = [380, 26, 0.2]; // 0.67: overshoots a little
const SIZE = [520, 34, 0.2]; // 0.75
const POP = [560, 21, 0.002]; // 0.44: bouncy
const FADE = [300, 34, 0.002]; // 0.98: no overshoot

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Tails lean in towards the pet: the reply's, near its left end, bends right; the
// user's, near its right end, bends left (the same drawing, mirrored by CSS). Each
// draws its own shadow and covers the bubble's border where they join.
const tailSvg = (side, shadowX) =>
  `<svg class="tail ${side}" viewBox="0 0 20 18" aria-hidden="true"><path class="sh" transform="translate(${shadowX} 3)" d="M5 2C6 7 5 12 1.5 16.5C9 15 15.5 9.5 19 2Z"/><path class="f" d="M5 0V2C6 7 5 12 1.5 16.5C9 15 15.5 9.5 19 2V0Z"/><path class="s" d="M5 2C6 7 5 12 1.5 16.5C9 15 15.5 9.5 19 2"/></svg>`;
const TAIL_LEFT = tailSvg("left", 2);
const TAIL_RIGHT = tailSvg("right", -2);
const SEND_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M3.5 8 8 3.5 12.5 8"/></svg>';

/** `opener`: what the pet said to start the chat, when it brought something up. */
function openChat(opener = "") {
  if (chat) return chatPoke();
  stir(AWAKE_AFTER_POKE_MS);
  cancelLife();
  clearTimeout(noticeTimer);
  // looked: it has looked at the screen, so links aren't opened for the rest of the chat.
  // log: the whole chat, which history (sent as context) is only the end of, for memory
  // to go over when the model had no tool to note things down with; searched: it went
  // online at some point.
  chat = { seq: ++chatSeq, req: 0, history: [], stack: [], phase: "idle", reply: null, quietSince: now(), looked: false, opener, log: [], searched: false };
  if (opener) addMsg("ai").body.append(el("div", "text", opener));
  openCompose();
}

/** A click on the pet while the chat is open. */
function chatPoke() {
  const compose = chat.stack.find((m) => m.kind === "compose");
  if (compose) return focusCompose(compose);
  if (chat.phase === "waiting" || chat.phase === "typing") {
    // Busy answering: the reply just gives a little wobble.
    chat.reply.sp && (chat.reply.sp.s.vel += 1.6);
    return animate();
  }
  if (chat.standby) {
    const m = chat.standby;
    wakeCompose(m);
    return focusCompose(m);
  }
  openCompose();
}

/** Turns of a chat kept in its log. */
const CHAT_LOG_MAX = 60;

/** The chat is closing: what it noted down goes into memory's note. With a model that
 *  doesn't do tools memory goes over the chat itself, and decides that by itself. */
function mergeChat() {
  if (!memOn()) return;
  invoke("memory_merge", {
    // Replies may tell what was on the screen or on a page: only the user's words go then.
    log: { turns: mergedTurns(), private: chat.looked || chat.searched, opener: chat.opener },
    now: nowText(),
  });
}

/** The chat's log for memory. A reply still coming leaves its question out; one that has
 *  all come in and is only being typed out goes in with it. */
function mergedTurns() {
  const r = chat.reply;
  if (!r || r.finished) return chat.log;
  if (r.ended && !r.error && !r.refused && r.full.trim()) return [...chat.log, { role: "assistant", text: r.full.trim() }];
  return chat.log.slice(0, -1);
}

function logChat(role, text) {
  chat.log.push({ role, text });
  if (chat.log.length > CHAT_LOG_MAX) chat.log.splice(0, chat.log.length - CHAT_LOG_MAX);
}

function closeChat() {
  if (!chat) return;
  mergeChat();
  invoke("ai_cancel");
  for (const m of chat.stack) leave(m, "down");
  if (chat.standby) leave(chat.standby, "down");
  typing.clear();
  chat = null;
  render();
}

/** A bubble, laid out from the next frame on; a standby one stays unseen until woken. */
function addMsg(kind, standby = false) {
  const node = el("div", `msg ${kind}`);
  const card = el("div", "card");
  const body = el("div", "body");
  card.append(body);
  node.append(card);
  node.insertAdjacentHTML("beforeend", kind === "ai" ? TAIL_RIGHT : TAIL_LEFT);
  const m = { kind, el: node, card, body, sp: null, gone: false };
  if (kind !== "me") {
    const x = el("button", "x");
    x.title = "关闭聊天";
    x.onclick = (e) => {
      e.stopPropagation();
      closeChat();
    };
    node.append(x);
  }
  chatEl.append(node);
  msgs.add(m);
  if (standby) {
    node.classList.add("standby");
    // Tab then Enter in the unseen box shouldn't land on its × and close the chat.
    node.querySelector(".x").tabIndex = -1;
    m.standby = true;
    chat.standby = m;
  } else {
    chat.stack.push(m);
  }
  return m;
}

/**
 * The box for the next message. A standby one waits unseen, focused, for the first key
 * typed after a reply, so that typing straight away carries on the chat; it is already
 * the box being typed into, so an input method composes in it from the first key.
 */
function openCompose(standby = false) {
  const m = addMsg("compose", standby);
  const input = document.createElement("textarea");
  input.rows = 1;
  input.maxLength = 1000;
  input.spellcheck = false;
  input.placeholder = `说点什么${nick()}…（Enter 发送）`;
  const send = el("button", "send");
  send.title = "发送（Enter）";
  send.disabled = true;
  send.innerHTML = SEND_ICON;
  m.body.append(input, send);
  m.input = input;
  input.addEventListener("input", () => {
    wakeCompose(m);
    send.disabled = !input.value.trim();
    fitInput(m);
    layoutChat();
  });
  // An input method starting to compose brings the box into view straight away.
  input.addEventListener("compositionstart", () => wakeCompose(m));
  input.addEventListener("keydown", (e) => {
    const composing = e.isComposing || e.keyCode === 229;
    // An empty unseen box: a space or a new line would only bring up a blank box, and
    // Ctrl+A selects the reply, as it would without the box.
    if (m.standby && !input.value && !composing) {
      if (e.key === " " || (e.key === "Enter" && e.shiftKey)) return e.preventDefault();
      if (e.key.toLowerCase() === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        return selectReply();
      }
    }
    // Enter while an input method is composing picks a candidate instead.
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      // Just popped up from keys typed blind: an Enter this soon wasn't meant to send.
      if (now() - (m.wokeAt || 0) < WOKE_ENTER_MS) return;
      sendChat(m);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // not on to the page, where Esc closes the whole chat
      if (m.standby) closeChat();
      else dropCompose(m);
    } else if (e.key === "Tab" && m.standby) {
      e.preventDefault(); // nothing to move on to in a box nobody can see
    }
  });
  send.onclick = () => sendChat(m);
  fitInput(m);
  if (standby) {
    placeStandby(m);
    input.focus({ preventScroll: true });
    return m;
  }
  layoutChat();
  focusCompose(m);
  render();
  return m;
}

/** Puts a standby box where it will pop up, so an input method's candidates show beside it. */
function placeStandby(m) {
  const w = m.body.offsetWidth + 2 * CARD_BORDER;
  const [x] = placeX(m, w);
  m.el.style.width = `${w}px`;
  m.el.style.height = `${m.body.offsetHeight + 2 * CARD_BORDER}px`;
  m.el.style.transform = `translate(${x}px, 0)`;
}

/** Selects the text of the reply on show (for Ctrl+A in the unseen box). */
function selectReply() {
  const r = chat.stack.find((m) => m.kind === "ai");
  if (!r) return;
  chat.standby?.input.blur(); // so that Ctrl+C copies the reply, not the empty box
  const range = document.createRange();
  range.selectNodeContents(r.body);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}

/** The pet lost the focus: the unseen box goes, and keys stop being carried into the
 *  chat, so that keys typed once Windows hands the focus back (after the settings
 *  window closes, or the pet is shown from the tray, say) don't end up sent to the
 *  model. A click on the pet or on a reply brings the chat back. */
function dropStandby() {
  if (!chat) return;
  chat.attended = false;
  if (!chat.standby) return;
  leave(chat.standby, "down");
  chat.standby = null;
}

/** The standby box comes into view, popping up like any new bubble. */
function wakeCompose(m) {
  if (!m.standby || !chat) return;
  m.standby = false;
  m.wokeAt = now();
  chat.standby = null;
  m.el.classList.remove("standby");
  m.el.querySelector(".x")?.removeAttribute("tabindex");
  m.el.style.opacity = 0;
  chat.stack.push(m);
  layoutChat();
  render();
}

/** The text box grows with what is typed, up to four lines. */
function fitInput(m) {
  m.input.style.height = "auto";
  m.input.style.height = `${Math.min(m.input.scrollHeight, 78)}px`;
}

async function focusCompose(m) {
  await invoke("chat_focus");
  m.input?.focus();
}

/** Esc in the box: just the box goes, or the whole chat if nothing else is up. */
function dropCompose(m) {
  if (chat.stack.length <= 1) return closeChat();
  leave(m, "down");
  chat.stack = chat.stack.filter((x) => x !== m);
  layoutChat();
  render();
}

function sendChat(m) {
  // Moved aside for a permission request: the box may still have focus, but Enter
  // shouldn't send what nobody can see.
  if (chatEl.classList.contains("away")) return;
  const text = m.input.value.trim();
  if (!text || chat.phase === "waiting" || chat.phase === "typing") return;
  // Sent with the pet in front: typing on after the reply carries on the chat, as long
  // as the focus stays.
  chat.attended = true;
  // The last reply floats off...
  for (const x of chat.stack) if (x !== m) leave(x, "up");
  chat.stack = [m];
  // ...the box turns into the message, moving over to the right...
  m.kind = "me";
  m.el.className = "msg me";
  m.el.querySelector(".x")?.remove();
  m.input = null;
  m.body.replaceChildren(el("div", "text", text));
  // ...and the reply comes up from below, pushing it up.
  const r = addMsg("ai");
  Object.assign(r, { full: "", shown: "", buffer: "", chip: null, text: null, looked: false, blind: false, searched: null, read: false, searching: false, reading: false, remembered: false, ended: false, error: null });
  r.body.append(dots());
  chat.reply = r;
  // Once a chat, even if its first question goes unanswered and out of the log.
  if (!chat.counted) remember("chat");
  chat.counted = true;
  logChat("user", text);
  chat.history.push({ role: "user", text });
  chat.history = chat.history.slice(-CHAT_HISTORY);
  while (chat.history[0]?.role !== "user") chat.history.shift();
  chat.phase = "waiting";
  chat.req = ++chatReq;
  invoke("ai_chat", { id: chat.req, chat: chat.seq, history: chat.history, now: nowText(), day: memDay(), looked: chat.looked, opener: chat.opener || null });
  layoutChat();
  render();
}

function dots() {
  const d = el("div", "dots");
  d.append(el("i"), el("i"), el("i"));
  return d;
}

/** A small note above the reply: that it looked at the screen (or couldn't), or went online. */
function setChip(r, text) {
  if (!r.chip) {
    r.chip = el("div", "chip");
    r.body.prepend(r.chip);
  }
  r.chip.textContent = text;
  layoutChat();
}

/** What the reply went and did on the way: under way until its text comes in, or it ends. */
function chipFor(r) {
  const done = Boolean(r.text) || r.ended;
  const sight = r.blind ? "🙈 这个模型看不了图" : r.looked && (done ? "👀 看了一眼屏幕" : "👀 瞄一眼屏幕…");
  // Exa's searches and reads are marked as they start, and only count once one came
  // back; none did by the end, and the mark says so.
  const web =
    r.searched === "link" ? (done ? "🔗 看了链接" : "🔗 打开链接…")
    : r.searched ? (done ? "🔎 搜了一下" : "🔎 搜一下…")
    : r.searching && (r.ended ? "🔎 没搜成" : "🔎 搜一下…");
  const read = r.read ? (done ? "📖 读了网页" : "📖 读网页…") : r.reading && (r.ended ? "📖 没读成" : "📖 读网页…");
  const memo = r.remembered && "📝 记下了";
  const set = r.set && "⚙️ 改了设置";
  return [sight, web, read, memo, set].filter(Boolean).join(" · ");
}

function onAi({ id, kind, text }) {
  if (!chat || id !== chat.req) return; // from a chat closed since, or an earlier message
  const r = chat.reply;
  if (kind === "text") {
    if (!r.text) {
      r.text = el("div", "text md");
      r.body.querySelector(".dots")?.remove();
      r.body.append(r.text);
      chat.phase = "typing";
      render();
    }
    if (r.chip) setChip(r, chipFor(r));
    r.full += text;
    r.buffer += text;
    typing.add(r);
    typeOn();
  } else if (kind === "look") {
    r.looked = true;
    chat.looked = true;
    setChip(r, chipFor(r));
    playOnce(ANIMS.chatSnap[0], { force: true, minMs: 0 });
  } else if (kind === "blind") {
    r.blind = true;
    setChip(r, chipFor(r));
  } else if (kind === "search") {
    r.searched = text === "link" ? "link" : "search";
    chat.searched = true;
    setChip(r, chipFor(r));
  } else if (kind === "read") {
    r.read = true;
    chat.searched = true;
    setChip(r, chipFor(r));
  } else if (kind === "searching" || kind === "reading") {
    // What it asked went out, whether or not anything came back.
    r[kind] = true;
    chat.searched = true;
    setChip(r, chipFor(r));
  } else if (kind === "remember") {
    r.remembered = true;
    setChip(r, chipFor(r));
  } else if (kind === "setting") {
    r.set = true;
    setChip(r, chipFor(r));
  } else if (kind === "done" || kind === "error") {
    r.ended = true;
    r.error = kind === "error" ? text : null;
    r.refused = kind === "done" && text === "refused";
    if (r.chip) setChip(r, chipFor(r));
    finishReply(r);
  }
}

// The reply is typed out at a steady pace, however the text arrives: faster when it
// has fallen behind.
const typing = new Set();
let typeFrame = 0;

function typeOn() {
  if (!typeFrame) typeFrame = requestAnimationFrame(typeStep);
}

function typeStep() {
  typeFrame = 0;
  for (const r of typing) {
    if (!r.buffer) {
      typing.delete(r);
      finishReply(r);
      continue;
    }
    let n = Math.max(1, Math.ceil(r.buffer.length / 12));
    if (/[\uD800-\uDBFF]/.test(r.buffer[n - 1] || "")) n++; // never half an emoji
    r.shown += r.buffer.slice(0, n);
    r.buffer = r.buffer.slice(n);
    showReply(r);
  }
  layoutChat();
  if (typing.size) typeOn();
}

/** What of the reply is typed out so far, with its Markdown drawn. Formulas show as
 *  source until KaTeX has loaded, then the reply is drawn again. */
function showReply(r) {
  // One per reply, so that KaTeX coming in draws it once, however many frames waited.
  r.redraw ||= () => {
    if (!r.text?.isConnected) return;
    showReply(r);
    layoutChat();
  };
  try {
    drawBlocks(r.text, renderMarkdown(r.shown, r.redraw));
  } catch {
    r.text.textContent = r.shown; // whatever trips the renderer, the reply still shows
  }
}

/** Puts html into box, keeping the blocks at the start that are the same as before, so
 *  that while a reply types out, a table's or formula's scroll and a link being pressed
 *  are not lost to every frame. Only the blocks from the first one that changed on are
 *  replaced, which is usually the last. */
function drawBlocks(box, html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  const fresh = [...t.content.childNodes];
  const old = [...box.childNodes];
  let same = 0;
  while (same < fresh.length && same < old.length && old[same].isEqualNode(fresh[same])) same++;
  for (const n of old.slice(same)) n.remove();
  box.append(...fresh.slice(same));
}

/** Once the reply has come in and been typed out: the message it answers floats off. */
function finishReply(r) {
  if (!r.ended || r.buffer || r.finished || chat?.reply !== r) return;
  r.finished = true;
  if (r.error || !r.full.trim()) {
    chat.history.pop(); // the question goes unanswered
    chat.log.pop(); // nor is it gone over for memory
    const err = el("div", "err", r.error || "唔…一时不知道说啥了");
    if (r.error) {
      const fix = el("a", "", "去设置看看");
      fix.onclick = () => invoke("open_settings");
      err.append(fix);
      playOnce(pick(ANIMS.toolError), { force: true, minMs: 1500 });
    }
    r.body.replaceChildren(err);
  } else if (r.refused) {
    chat.history.pop(); // declined: neither the question nor what it said goes on as context
    chat.log.pop();
  } else {
    chat.history.push({ role: "assistant", text: r.full.trim() });
    logChat("assistant", r.full.trim());
  }
  chat.phase = "idle";
  // Typing straight away carries on the chat, unless the focus went elsewhere at any
  // point since the message was sent, or text in the reply is being selected.
  if (chat.attended && document.hasFocus() && getSelection().isCollapsed && !chat.standby) openCompose(true);
  const asked = chat.stack.find((m) => m.kind === "me");
  setTimeout(() => {
    if (!chat || !chat.stack.includes(asked)) return;
    leave(asked, "up");
    chat.stack = chat.stack.filter((m) => m !== asked);
    layoutChat();
  }, 450);
  render();
}

/** Off it goes: floating up, or back down into the pet. */
function leave(m, way) {
  m.gone = true;
  m.el.classList.add("gone");
  if (!m.sp) {
    m.el.remove();
    msgs.delete(m);
    return;
  }
  if (way === "up") {
    m.sp.y.to += 24;
    m.sp.s.to = 0.92;
  } else {
    m.sp.y.to = -20;
    m.sp.s.to = 0.4;
  }
  m.sp.o.to = 0;
  animate();
}

/** The column the bubbles stack up in: up to 300 px wide, over the pet, inside the part
 *  of the window on screen. */
function fitChat() {
  const lo = 8 + edges.left;
  const hi = innerWidth - 8 - edges.right;
  const width = Math.min(300, hi - lo);
  const left = clamp(innerWidth / 2 - width / 2, lo, hi - width);
  chatEl.style.left = `${left}px`;
  chatEl.style.width = `${width}px`;
  chatEl.style.setProperty("--chat-w", `${width}px`);
  petX = innerWidth / 2 - left;
  layoutChat();
}

/** Where each bubble should be, from the bottom up, given what is in it now. */
function layoutChat() {
  if (!chat) return;
  const width = chatEl.clientWidth;
  const height = chatEl.clientHeight;
  chatWidth = width;
  for (const m of chat.stack) {
    m.nw = Math.ceil(m.body.offsetWidth) + 2 * CARD_BORDER;
    m.nh = Math.ceil(m.body.offsetHeight) + 2 * CARD_BORDER;
  }
  const total = chat.stack.reduce((sum, m) => sum + m.nh + CHAT_GAP, -CHAT_GAP);
  // One close button, on the top bubble that has one; one tail, on the bubble next to the pet.
  const closer = chat.stack.find((m) => m.kind !== "me");
  for (const m of chat.stack) {
    m.el.classList.toggle("nox", m !== closer);
    m.el.classList.toggle("tailless", m !== chat.stack.at(-1));
  }
  let y = 0;
  for (const m of [...chat.stack].reverse()) {
    // A long reply scrolls rather than pushing the rest out of the window.
    const h = m.kind === "ai" ? clamp(height - CHAT_TOP_ROOM - (total - m.nh), 56, m.nh) : m.nh;
    const scroll = h < m.nh;
    m.card.classList.toggle("scroll", scroll);
    // Scrolled while the card was catching up with what is in it. Up and down the
    // browser brings it back itself as the card grows: with its border counted it has
    // nothing left to scroll at rest, and setting it here would jump to the top.
    m.card.scrollLeft = 0;
    const w = m.nw + (scroll ? 8 : 0);
    const to = { y, w, h, s: 1, o: 1 };
    // A new bubble pops up from just below where it belongs.
    if (!m.sp) m.sp = { y: new Spring(y - 18, MOVE), w: new Spring(w, SIZE), h: new Spring(h, SIZE), s: new Spring(0.5, POP), o: new Spring(0, FADE) };
    for (const k in to) m.sp[k].to = to[k];
    if (scroll && m === chat.reply && chat.phase === "typing") m.card.scrollTop = m.card.scrollHeight;
    y += h + CHAT_GAP;
  }
  animate();
}

/**
 * A bubble's left edge, and its tail's place across from that. A short bubble grows from
 * its tail beside the pet across towards the other side, the reply rightwards and the
 * user's side leftwards; once it reaches CHAT_REACH past the middle it grows out on its
 * own side instead, so long replies stay on the left and long messages on the right.
 * The middle is the pet's (`petX`), which near a side of the screen isn't the column's.
 * The tail stays put, sliding along the bubble (clear of the rounded corners) only
 * when the bubble can't move any further.
 */
function placeX(m, w) {
  const mid = petX;
  const room = Math.max(0, chatWidth - w);
  if (m.kind === "ai") {
    const tail = mid - TAIL_REACH;
    const x = clamp(Math.min(tail - TAIL_INSET, mid + CHAT_REACH - w), 0, room);
    return [x, clamp(tail - x, 21, Math.max(21, w - 17))];
  }
  const tail = mid + TAIL_REACH;
  const x = clamp(Math.max(tail + TAIL_INSET - w, mid - CHAT_REACH), 0, room);
  return [x, clamp(tail - x, 17, Math.max(17, w - 21))];
}

let animating = false;
let lastFrame = 0;
let chatWidth = 0;
/** The pet's middle across the chat's column. */
let petX = 150;
let lastHits = 0;

function animate() {
  if (animating) return;
  animating = true;
  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

function frame(t) {
  const dt = Math.min(0.05, (t - lastFrame) / 1000);
  lastFrame = t;
  let moving = false;
  for (const m of msgs) {
    if (!m.sp) continue; // not laid out yet
    const sp = Object.values(m.sp);
    // Small fixed steps keep the stiff springs stable whatever the frame rate.
    for (let left = dt; left > 1e-6; left -= 1 / 240) for (const s of sp) s.step(Math.min(left, 1 / 240));
    for (const s of sp) {
      if (s.still) {
        s.v = s.to;
        s.vel = 0;
      } else moving = true;
    }
    if (m.gone && m.sp.o.v < 0.03) {
      m.el.remove();
      msgs.delete(m);
      if (!msgs.size) renderBubble(); // whatever the chat kept out of the way comes back
      continue;
    }
    const { y, w, h, s, o } = m.sp;
    const [width, height] = [Math.max(0, w.v), Math.max(0, h.v)];
    const [x, tail] = placeX(m, width);
    m.el.style.width = `${width}px`;
    m.el.style.height = `${height}px`;
    m.el.style.setProperty("--tail-x", `${tail}px`);
    // Grows out of, and shrinks back into, the tip of its tail.
    m.el.style.transformOrigin = `${tail}px ${height + 14}px`;
    m.el.style.transform = `translate(${x}px, ${-y.v}px) scale(${s.v})`;
    m.el.style.opacity = clamp(o.v, 0, 1);
  }
  if (t - lastHits > 120 || !moving) {
    lastHits = t;
    queueHitRects();
  }
  animating = moving;
  if (moving) requestAnimationFrame(frame);
}

/** What the pet does while chatting, all at one desk. */
function chatSlug() {
  if (chat.stack.some((m) => m.kind === "compose")) return ANIMS.chatListen[0];
  if (chat.phase === "waiting") return ANIMS.chatPonder[0];
  if (chat.phase === "typing") return ANIMS.chatTyping[0];
  return ANIMS.chatIdle[0];
}

document.addEventListener("keydown", (e) => {
  if (!chat || chat.stack.some((m) => m.kind === "compose")) return;
  if (e.key === "Escape") return closeChat();
  // A key typed with the reply up but the box not focused: into the box it goes, input
  // methods' keys included. Only while the pet has kept the focus since the message was
  // sent; not a key meant for a focused button or link, nor while the chat is moved aside.
  const ime = e.key === "Process" || e.keyCode === 229;
  const typed = (ime || (e.key.length === 1 && e.key !== " ")) && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (!typed || !chat.attended || e.target.closest?.("button, a")) return;
  if (chat.phase === "idle" && !chatEl.classList.contains("away")) focusStandby();
});
/** Focuses the unseen box for the next message, opening one if need be. */
function focusStandby() {
  (chat.standby || openCompose(true)).input.focus({ preventScroll: true });
}
// A click on a reply takes the focus from the unseen box: it goes straight back, so that
// an input method composes in the box from the first key. Not while text is selected.
chatEl.addEventListener("pointerup", (e) => {
  if (!chat || chat.phase !== "idle" || chatEl.classList.contains("away") || !document.hasFocus()) return;
  if (chat.stack.some((m) => m.kind === "compose") || e.target.closest("button, a") || !getSelection().isCollapsed) return;
  chat.attended = true; // clicked on, so being looked at
  focusStandby();
});
// Links in a reply open in the browser, not in the pet's page.
chatEl.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a) return;
  e.preventDefault();
  invoke("open_link", { url: a.getAttribute("href") });
});
window.addEventListener("blur", dropStandby);
window.addEventListener("resize", fitChat);
// The bubbles ride along when the drawing under them changes height, and a long reply
// is fitted to the room it has then.
chatEl.addEventListener("transitionend", (e) => {
  if (e.target === chatEl) layoutChat();
  queueHitRects();
});

// ---------------------------------------------------------------- boot

function applyConfig(c) {
  const livelinessChanged = !config || config.liveliness !== c.liveliness;
  config = c;
  if (chat && !c.ai.enabled) closeChat();
  document.documentElement.style.setProperty("--size", `${c.size}px`);
  if (livelinessChanged) rest();
  queueHitRects();
}

async function boot() {
  const list = await fetch("assets/clawd/manifest.json").then((r) => r.json());
  for (const m of list) manifest[m.slug] = m;
  allSlugs = list.map((m) => m.slug);
  funSlugs = allSlugs.filter((s) => !NOT_FOR_FUN.includes(s));
  // A milestone reached last time and not yet celebrated.
  collectCheer = (await invoke("collection_known", { slugs: allSlugs }).catch(() => null)) || 0;
  applyConfig(await invoke("get_config"));

  await listen("hook-event", (e) => onHook(e.payload));
  await listen("permission-request", (e) => {
    const req = { id: e.payload.id, payload: e.payload.payload };
    if (req.payload.tool_name === "AskUserQuestion") {
      req.ask = askState(req.payload);
      // Asked in a way the bubble can't show: answered in the native UI, as before.
      if (!req.ask) return invoke("resolve_permission", { id: req.id, body: "" });
    }
    stir(AWAKE_AFTER_WORK_MS);
    perms.push(req);
    const s = session(e.payload.payload);
    if (s.state !== "waiting") wait(s);
    render();
  });
  await listen("permission-closed", (e) => {
    const req = perms.find((x) => x.id === e.payload.id);
    removePerm(e.payload.id);
    // Answered in Claude Code itself: back to work, unless it is asking something else.
    // When the bubble only gave up waiting, Claude Code is still asking there.
    const s = req && sessions.get(req.payload.session_id);
    // A question answered in the terminal (outcome unknown) is left waiting: its PostToolUse
    // comes right after and plays "you answered" only while the session still waits.
    const unknownAsk = req?.ask && e.payload.outcome == null;
    if (e.payload.answered && !unknownAsk && s?.state === "waiting" && !perms.some((x) => x.payload.session_id === s.id)) s.state = "working";
    // Reacts as to an answer in the bubble, when it shows which answer it was. A question
    // answered elsewhere: its PostToolUse may have played that already.
    if (req?.ask && e.payload.outcome === "allow") {
      if (!ANIMS.answered.includes(oneShot?.slug)) playOnce(pick(ANIMS.answered), { force: true, minMs: 1500 });
    } else if (req && e.payload.outcome === "allow") playOnce(pick(ANIMS.allowed), { force: true, minMs: 1200 });
    else if (req && e.payload.outcome === "deny") playOnce(pick(ANIMS.denied), { force: true, minMs: 1800 });
    render();
  });
  await listen("perm-hotkey", (e) => onPermHotkey(e.payload));
  await listen("user-event", (e) => onUserEvent(e.payload));
  await listen("ai", (e) => onAi(e.payload));
  await listen("dream", (e) => onDream(e.payload));
  await listen("drag-end", onDragEnd);
  await listen("edges", (e) => onEdges(e.payload));
  onEdges(await invoke("get_edges"));
  await listen("config", (e) => applyConfig(e.payload));
  await listen("play-random", () => playRandom());
  await listen("shown", (e) => setShown(e.payload));
  await listen("play", (e) => {
    stir(AWAKE_AFTER_POKE_MS);
    playOnce(e.payload, { force: true, minMs: 3000, preview: true });
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
  ticker = setInterval(tick, 1000);
  // It may have stepped aside before the listener above was there.
  setShown(await getCurrentWindow().isVisible());
  if (!(await invoke("hooks_installed"))) {
    setTimeout(() => {
      toast("还没连上 Claude Code，点这里去设置里安装联动～", { ms: 15000, onClick: () => invoke("open_settings") });
    }, 6000);
  }
}

boot();
