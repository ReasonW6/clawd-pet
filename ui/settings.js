const { invoke } = window.__TAURI__.core;
const { emitTo, listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

const $ = (id) => document.getElementById(id);
let config;

const get = (path) => path.split(".").reduce((o, k) => o[k], config);
const set = (path, value) => {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => o[k], config)[last] = value;
};

// ---------------------------------------------------------------- saving

let saveTimer;
let savedTimer;
/** The config as the backend last had it, by this page's saves and the chat's changes:
 *  a chat change shows only in the keys it changed, not over an edit still unsaved. */
let known;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    known = structuredClone(config);
    await invoke("set_config", { config });
    $("saved").classList.add("show");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $("saved").classList.remove("show"), 1500);
  }, 150);
}

// ---------------------------------------------------------------- helpers

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function removeButton(onClick) {
  const b = el("button", "icon");
  b.title = "移除";
  b.append(el("i", "glyph-x"));
  b.onclick = onClick;
  return b;
}

// ---------------------------------------------------------------- window

$("win-min").onclick = () => getCurrentWindow().minimize();
$("win-close").onclick = () => getCurrentWindow().close();

// ---------------------------------------------------------------- tabs

for (const tab of document.querySelectorAll("nav button")) {
  tab.onclick = () => showTab(tab.dataset.tab);
}

/** Shows a tab; a page within one (`memory` in `ai`) keeps its tab lit in the sidebar. */
function showTab(id, under = id) {
  document.querySelectorAll("nav button, main section").forEach((e) => e.classList.remove("active"));
  document.querySelector(`nav button[data-tab="${under}"]`).classList.add("active");
  $(`tab-${id}`).classList.add("active");
  document.querySelector("main").scrollTop = 0;
}

// ---------------------------------------------------------------- simple fields

function bindFields() {
  for (const input of document.querySelectorAll("[data-key]")) {
    const key = input.dataset.key;
    const isCheck = input.type === "checkbox";
    const isNumber = input.type === "number" || input.type === "range";
    if (isCheck) input.checked = get(key);
    else input.value = get(key);

    input.addEventListener("input", () => {
      let value = isCheck ? input.checked : input.value.trim();
      if (isNumber) {
        value = Math.round(Number(input.value));
        if (input.value === "" || Number.isNaN(value)) return;
        value = Math.min(Number(input.max), Math.max(Number(input.min), value));
      }
      set(key, value);
      refreshOutputs();
      save();
    });
  }

  for (const radio of document.querySelectorAll("input[name=liveliness]")) {
    radio.checked = Number(radio.value) === config.liveliness;
    radio.onchange = () => {
      config.liveliness = Number(radio.value);
      save();
    };
  }
}

function refreshOutputs() {
  $("size-out").textContent = config.size;
}

function bindBirthday() {
  const [month, day] = [$("birth-month"), $("birth-day")];
  month.append(new Option("不设置", ""));
  for (let m = 1; m <= 12; m++) month.append(new Option(`${m} 月`, String(m).padStart(2, "0")));
  for (let d = 1; d <= 31; d++) day.append(new Option(`${d} 日`, String(d).padStart(2, "0")));
  showBirthday();
  month.onchange = day.onchange = () => {
    day.hidden = !month.value;
    config.birthday = month.value ? `${month.value}-${day.value}` : "";
    save();
  };
}

function showBirthday() {
  const [month, day] = [$("birth-month"), $("birth-day")];
  const [m, d] = config.birthday ? config.birthday.split("-") : ["", "01"];
  month.value = m;
  day.value = d;
  day.hidden = !m;
}

/** What the chat may change (`change_setting` in main.rs). */
const CHAT_KEYS = ["nickname", "birthday", "chatty", "liveliness", "sedentaryMinutes", "sleepEnabled", "size"];

/** The chat changed a setting (the `config` event comes only for that): the page shows
 *  it, and saves on top of it. */
function onConfig(c) {
  for (const key of CHAT_KEYS) {
    if (c[key] === known[key]) continue;
    config[key] = c[key];
    const input = document.querySelector(`[data-key="${key}"]`);
    if (input?.type === "checkbox") input.checked = c[key];
    else if (input) input.value = c[key];
  }
  for (const radio of document.querySelectorAll("input[name=liveliness]")) radio.checked = Number(radio.value) === config.liveliness;
  showBirthday();
  refreshOutputs();
  known = structuredClone(c);
}

// ---------------------------------------------------------------- sleep windows

function renderSleepWindows() {
  const box = $("sleep-windows");
  box.innerHTML = "";
  config.sleepWindows.forEach((w, i) => {
    const row = el("div", "item");
    const time = (field) => {
      const input = el("input");
      input.type = "time";
      input.value = w[field];
      input.onchange = () => {
        if (!input.value) return;
        w[field] = input.value;
        save();
      };
      return input;
    };
    row.append(
      time("start"),
      el("span", "", "到"),
      time("end"),
      el("span", "grow"),
      removeButton(() => {
        config.sleepWindows.splice(i, 1);
        renderSleepWindows();
        save();
      }),
    );
    box.append(row);
  });
}

$("add-sleep").onclick = () => {
  config.sleepWindows.push({ start: "12:30", end: "13:30" });
  renderSleepWindows();
  save();
};

// ---------------------------------------------------------------- folder lists

function pathList(boxId, addId, list) {
  const render = () => {
    const box = $(boxId);
    box.innerHTML = "";
    list().forEach((path, i) => {
      const row = el("div", "item");
      const text = el("span", "path", path);
      text.title = path;
      row.append(
        text,
        removeButton(() => {
          list().splice(i, 1);
          render();
          save();
        }),
      );
      box.append(row);
    });
  };
  $(addId).onclick = async () => {
    const path = await invoke("pick_folder");
    if (!path || list().includes(path)) return;
    list().push(path);
    render();
    save();
  };
  render();
}

// ---------------------------------------------------------------- full-screen exceptions

function initFullscreenExclude() {
  const list = config.fullscreenExclude;
  // Folded down to the first line of capsules until the user opens it.
  const fold = () => {
    const [box, toggle] = [$("fs-exclude"), $("fs-fold-toggle")];
    const open = $("fs-fold").classList.contains("open");
    toggle.hidden = false; // it takes room from the capsules, so measure with it shown
    const first = box.firstElementChild?.offsetTop;
    const below = [...box.children].filter((c) => c.offsetTop > first).length;
    toggle.hidden = below === 0;
    toggle.firstElementChild.textContent = open ? "收起" : `还有 ${below} 个`;
  };
  $("fs-fold-toggle").onclick = () => {
    $("fs-fold").classList.toggle("open");
    fold();
  };
  // Also measures once the tab is shown and whenever the window is resized.
  new ResizeObserver(fold).observe($("fs-exclude"));
  const render = () => {
    $("fs-exclude").innerHTML = "";
    list.forEach((name, i) => {
      const capsule = el("span", "capsule", name);
      capsule.append(
        removeButton(() => {
          list.splice(i, 1);
          render();
          save();
        }),
      );
      $("fs-exclude").append(capsule);
    });
    fold();
  };
  const add = (name) => {
    name = (name || "").trim().toLowerCase();
    if (!name) return;
    // "Chrome" and "chrome.exe" both mean the process chrome.exe.
    if (!name.includes(".")) name += ".exe";
    if (!list.includes(name)) list.push(name);
    $("fs-exclude-name").value = "";
    render();
    save();
  };
  $("fs-exclude-add").onclick = () => add($("fs-exclude-name").value);
  $("fs-exclude-name").onkeydown = (e) => e.key === "Enter" && add($("fs-exclude-name").value);
  $("fs-exclude-pick").onclick = async () => add(await invoke("pick_program"));
  render();
}

// ---------------------------------------------------------------- git

async function initGitWatch() {
  const box = $("git-watch");
  const note = $("git-note").textContent;
  box.checked = await invoke("git_watch_get");
  box.onchange = async () => {
    box.disabled = true;
    try {
      box.checked = await invoke("git_watch_set", { on: box.checked });
      $("git-note").textContent = note;
    } catch (e) {
      box.checked = !box.checked;
      $("git-note").textContent = String(e);
    }
    box.disabled = false;
  };
}

// ---------------------------------------------------------------- Claude Code hooks

function showHooks(installed) {
  $("hook-status").textContent = installed ? "已安装" : "未安装";
  $("hook-status").classList.toggle("on", installed);
  $("hook-toggle").textContent = installed ? "卸载" : "安装联动";
  $("hook-toggle").classList.toggle("primary", !installed);
  $("hook-toggle").onclick = async () => {
    $("hook-error").hidden = true;
    try {
      showHooks(await invoke("hooks_set", { install: !installed }));
    } catch (e) {
      $("hook-error").textContent = String(e);
      $("hook-error").hidden = false;
    }
  };
}

// ---------------------------------------------------------------- AI chat

let providers = [];
/** The provider's own model list once fetched; until then a few suggestions. */
let fetchedModels = null;

const provider = () => providers.find((p) => p.id === config.ai.provider) || providers[0];
const profile = () => (config.ai.profiles[provider().id] ??= { apiKey: "", baseUrl: "", model: "", reasoning: "" });

async function initAi() {
  providers = await invoke("ai_providers");
  const select = $("ai-provider");
  for (const group of new Set(providers.map((p) => p.group))) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group;
    for (const p of providers.filter((p) => p.group === group)) optgroup.append(new Option(p.name, p.id));
    select.append(optgroup);
  }
  select.onchange = () => {
    config.ai.provider = select.value;
    fetchedModels = null;
    baseOpen = false;
    showAi();
    save();
  };
  const field = (id, key) => {
    $(id).oninput = () => {
      profile()[key] = $(id).value.trim();
      if (key === "model") renderModels();
      save();
    };
  };
  field("ai-key", "apiKey");
  field("ai-base", "baseUrl");
  field("ai-model", "model");
  $("ai-model").addEventListener("input", showReasoning);
  for (const [box, button] of [["ai-key", "ai-key-show"], ["ai-exa-key", "ai-exa-key-show"]]) {
    $(button).onclick = () => {
      const show = $(box).type === "password";
      $(box).type = show ? "text" : "password";
      $(button).classList.toggle("on", show);
      $(button).title = show ? "隐藏" : "显示";
    };
  }
  $("ai-key-link").onclick = () => invoke("ai_key_page", { provider: provider().id });
  $("ai-exa-link").onclick = () => invoke("ai_key_page", { provider: "exa" });
  $("ai-fetch").onclick = fetchModels;
  $("ai-base-show").onclick = () => {
    baseOpen = true;
    showBase();
    $("ai-base").focus();
  };
  // The two ways of searching: turning one on turns the other off. Not Exa for a
  // provider without a search of its own, though: that would leave no search at all
  // (with both on, the chat uses Exa).
  const [search, exa] = ["ai.search", "ai.exa"].map((key) => document.querySelector(`[data-key="${key}"]`));
  for (const [me, other, key] of [[search, exa, "exa"], [exa, search, "search"]]) {
    me.addEventListener("input", () => {
      if (me.checked && other.checked && provider().search) {
        other.checked = false;
        config.ai[key] = false;
        save();
      }
      showExa();
      showReasoning();
    });
  }
  // The DeepSeek warning depends on the screen too.
  document.querySelector('[data-key="ai.screen"]').addEventListener("input", showReasoning);
  showAi();
  showExa();
  await initIdentity();
  await initPersonas();
}

function showAi() {
  const [p, mine] = [provider(), profile()];
  $("ai-provider").value = p.id;
  $("ai-provider-note").textContent = p.wire === "anthropic" ? "Anthropic Messages 接口" : "OpenAI 兼容接口";
  $("ai-key").value = mine.apiKey;
  $("ai-key").placeholder = p.needsKey ? "必填" : "不需要就留空";
  $("ai-key-link").hidden = !p.keyUrl;
  $("ai-base").value = mine.baseUrl;
  $("ai-base").placeholder = p.baseUrl || "必填，如 https://example.com/v1";
  $("ai-base-note").textContent = p.baseUrl ? "留空就用官方地址" : "服务的接口地址";
  $("ai-model").value = mine.model;
  $("ai-model").placeholder = p.model || "选一个，或直接填";
  $("ai-model-note").textContent = "点「获取模型」从服务商那里拉列表，也可以直接填";
  $("ai-model-note").classList.remove("bad");
  renderModels();
  $("ai-search-note").textContent = p.search
    ? "问到新闻、天气、最新版本这类事，或者它拿不准的事，它会用服务商自带的联网搜索自己去查，回复上会标出「搜了一下」。有的服务商按次收费"
    : `${p.name} 没有自带的联网搜索，开着也搜不了，可以改用下面的 Exa。自带搜索的有：${providers.filter((x) => x.search).map((x) => x.name).join("、")}`;
  showBase();
  showReasoning();
}

/** The address row stays folded away while the provider's own address is used. */
let baseOpen = false;

function showBase() {
  const folded = !!provider().baseUrl && !profile().baseUrl && !baseOpen;
  $("ai-base-row").hidden = folded;
  $("ai-base-show").hidden = !folded;
}

function showExa() {
  $("ai-exa-key-row").hidden = !config.ai.exa;
}

/** The reasoning levels the model takes: those of the first rule its name starts with. */
function levels() {
  const model = (profile().model || provider().model).toLowerCase();
  const rule = provider().reasoning.find((r) => model.startsWith(r.prefix.toLowerCase()));
  return rule ? rule.levels : [];
}

function showReasoning() {
  const [p, mine, list] = [provider(), profile(), levels()];
  // A level the model doesn't take is never sent, so it shows as the default.
  const level = list.includes(mine.reasoning) ? mine.reasoning : "";
  const box = $("ai-reasoning");
  box.innerHTML = "";
  box.hidden = !list.length;
  for (const value of ["", ...list]) {
    const label = el("label");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "ai-reasoning";
    radio.checked = value === level;
    radio.onchange = () => {
      mine.reasoning = value;
      showReasoning();
      save();
    };
    label.append(radio, el("span", "", { "": "默认", off: "关" }[value] ?? value));
    box.append(label);
  }
  $("ai-reasoning-note").textContent =
    (list.length
      ? "想得越多答得越准，也越慢、越费 token。「默认」什么都不发，按服务商自己的默认。"
      : "这个模型没有能调的档位，按它自己的来。") + p.reasoningNote;
  // DeepSeek turns down its screenshot tool beside its own search unless it thinks.
  const clash = p.id === "deepseek" && level === "off" && config.ai.screen && config.ai.search && !config.ai.exa && p.search;
  $("ai-reasoning-warn").hidden = !clash;
  $("ai-reasoning-warn").textContent = clash
    ? "推理关着，又同时开着看屏幕和 DeepSeek 自带的搜索：DeepSeek 会拒绝这样的请求，聊天时会报错。给推理换一档，或者改用 Exa 搜索。"
    : "";
}

/** The models to pick from, narrowed down by what is typed in the box. */
function renderModels() {
  const list = fetchedModels || provider().models;
  const current = profile().model || provider().model;
  const typed = $("ai-model").value.trim().toLowerCase();
  const shown = typed && !list.some((m) => m.toLowerCase() === typed) ? list.filter((m) => m.toLowerCase().includes(typed)) : list;
  $("ai-models").innerHTML = "";
  for (const m of shown) {
    const chip = el("button", m === current ? "active" : "", m);
    chip.onclick = () => {
      profile().model = m;
      $("ai-model").value = m;
      renderModels();
      showReasoning();
      save();
    };
    $("ai-models").append(chip);
  }
}

async function fetchModels() {
  const [button, note] = [$("ai-fetch"), $("ai-model-note")];
  const p = provider();
  button.disabled = true;
  note.classList.remove("bad");
  note.textContent = "正在问服务商要列表…";
  try {
    const list = await invoke("ai_models", { ai: config.ai, provider: p.id });
    if (provider() !== p) return; // switched away meanwhile
    fetchedModels = list;
    note.textContent = list.length ? `找到 ${list.length} 个模型，点一个用它` : "服务商没给出模型列表，直接填名字吧";
  } catch (e) {
    note.textContent = String(e);
    note.classList.add("bad");
  } finally {
    button.disabled = false;
  }
  renderModels();
}

// Who the pet is: ai.rs has the default, config.ai.identity the user's rewrite (empty
// for the default).

let identity = "";

async function initIdentity() {
  identity = await invoke("ai_identity");
  const box = $("ai-identity");
  box.placeholder = identity; // shown when emptied, which means the default
  box.value = config.ai.identity || identity;
  box.oninput = () => {
    const text = box.value.trim();
    config.ai.identity = text === identity ? "" : text;
    showIdentityNote();
    save();
  };
  $("ai-identity-reset").onclick = () => {
    config.ai.identity = "";
    box.value = identity;
    showIdentityNote();
    save();
  };
  showIdentityNote();
}

function showIdentityNote() {
  const empty = !$("ai-identity").value.trim();
  $("ai-identity-reset").hidden = !config.ai.identity && !empty;
  $("ai-identity-note").textContent = empty ? "空着就按默认的身份" : config.ai.identity ? "改过了，点「恢复默认」回到原样" : "默认的身份，可以直接改";
}

// Personas: the presets come from ai.rs, and the user may rewrite any of them (kept
// in personaPrompts, so "恢复默认" can drop the rewrite) or add their own.

let personas = [];
let deleteTimer = 0;
/** Shown in an empty persona of the user's own: the parts a character prompt needs.
 *  Only as a placeholder, so none of it reaches the model unless they write it. */
const NEW_PERSONA =
  "性格：（三个词，带点反差更好，比如“毒舌、可靠、怕麻烦”）\n" +
  "说话方式：（句子长短、语气词、怎么称呼人、偶尔用的口头禅）\n" +
  "回应方式：（先做什么再做什么，比如先吐槽一句再认真帮忙）\n" +
  "不会：（它绝不会做的事，比如“不说教”“不拿别人的外貌开玩笑”）";

const customPersona = (id) => config.ai.customPersonas.find((p) => p.id === id);

/** The persona chatted as: one of the user's, or a preset (the first if the id is unknown). */
function currentPersona() {
  const custom = customPersona(config.ai.persona);
  return custom ? { custom } : { preset: personas.find((p) => p.id === config.ai.persona) || personas[0] };
}

async function initPersonas() {
  personas = await invoke("ai_personas");
  $("ai-persona-name").oninput = () => {
    const { custom } = currentPersona();
    if (!custom) return;
    custom.name = $("ai-persona-name").value.trim();
    renderPersonas();
    save();
  };
  $("ai-persona-prompt").oninput = () => {
    const text = $("ai-persona-prompt").value;
    const { custom, preset } = currentPersona();
    // As with the identity: emptied, or back to the preset, means no rewrite.
    if (custom) custom.prompt = text;
    else if (!text.trim() || text.trim() === preset.prompt.trim()) delete config.ai.personaPrompts[preset.id];
    else config.ai.personaPrompts[preset.id] = text;
    showPersonaNote();
    save();
  };
  $("ai-persona-reset").onclick = () => {
    delete config.ai.personaPrompts[currentPersona().preset.id];
    showPersona();
    save();
  };
  $("ai-persona-delete").onclick = deletePersona;
  showPersona();
}

function renderPersonas() {
  const box = $("ai-personas");
  const { custom, preset } = currentPersona();
  const active = (custom || preset).id;
  box.innerHTML = "";
  for (const p of [...personas, ...config.ai.customPersonas]) {
    const chip = el("button", p.id === active ? "active" : "", p.name || "未命名");
    chip.onclick = () => {
      config.ai.persona = p.id;
      showPersona();
      save();
    };
    box.append(chip);
  }
  const add = el("button", "new", "＋ 新建");
  add.title = "自己加一个人设";
  add.onclick = addPersona;
  box.append(add);
}

function showPersona() {
  const { custom, preset } = currentPersona();
  renderPersonas();
  $("ai-persona-name").hidden = !custom;
  $("ai-persona-name").value = custom?.name ?? "";
  $("ai-persona-prompt").value = custom ? custom.prompt : (config.ai.personaPrompts[preset.id] ?? preset.prompt);
  $("ai-persona-prompt").placeholder = custom ? NEW_PERSONA : preset.prompt;
  $("ai-persona-delete").hidden = !custom;
  disarmDelete();
  showPersonaNote();
}

function showPersonaNote() {
  const { custom, preset } = currentPersona();
  const empty = !$("ai-persona-prompt").value.trim();
  const edited = !custom && preset.id in config.ai.personaPrompts;
  $("ai-persona-reset").hidden = !!custom || (!edited && !empty);
  $("ai-persona-note").textContent = custom
    ? "你自己加的人设，名字和内容都能改"
    : empty
      ? "空着就按预设的人设"
      : edited
        ? "改过了，点「恢复默认」回到原样"
        : "预设的人设，可以直接改";
}

function addPersona() {
  const p = { id: `my-${Date.now().toString(36)}`, name: "新人设", prompt: "" };
  config.ai.customPersonas.push(p);
  config.ai.persona = p.id;
  showPersona();
  save();
  $("ai-persona-name").focus();
  $("ai-persona-name").select();
}

/** Deleting takes a second click within a moment. */
function deletePersona() {
  const button = $("ai-persona-delete");
  if (!button.classList.contains("armed")) {
    button.classList.add("armed");
    button.textContent = "再点一次删除";
    clearTimeout(deleteTimer);
    deleteTimer = setTimeout(disarmDelete, 2500);
    return;
  }
  config.ai.customPersonas = config.ai.customPersonas.filter((p) => p.id !== config.ai.persona);
  config.ai.persona = personas[0].id;
  showPersona();
  save();
}

function disarmDelete() {
  clearTimeout(deleteTimer);
  $("ai-persona-delete").classList.remove("armed");
  $("ai-persona-delete").textContent = "删除";
}

// ---------------------------------------------------------------- memory

/** The day as memory counts it (as in pet.js): days start at 05:00. */
function memDay() {
  const d = new Date(Date.now() - 5 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let memory = null;
let forgetTimer;
/** The button's dream is under way (its call comes back when it is over). */
let dreaming = false;

async function showMemory() {
  memory = await invoke("memory_get", { day: memDay() });
  if (!memory) return;
  const on = config.ai.enabled && config.memory.enabled;
  $("memory-summary").textContent = !on
    ? "还没打开"
    : memory.met
      ? `认识第 ${memory.known} 天 · ${memory.lastDream ? `上次整理 ${memory.lastDream}` : "还没整理过"}`
      : "还什么都没记";
  $("memory-off").hidden = on;
  $("memory-known").textContent = memory.met ? `认识第 ${memory.known} 天` : "还不认识呢";
  $("memory-counts").textContent = memory.met ? `一起过了 ${memory.days} 天 · 聊过 ${memory.chats} 次 · 一起完成了 ${memory.tasks} 个任务` : "打开记忆后，从下一次见面开始算";
  $("memory-milestones-row").hidden = !memory.milestones.length;
  $("memory-milestones").textContent = memory.milestones.map((m) => `${m.name}（${m.day}）`).join("、");
  const box = $("memory-note");
  // Off, nothing would keep what is written in it.
  box.readOnly = !on;
  // Not while the user is writing in it.
  if (document.activeElement !== box) box.value = memory.note;
  noteInfo();
  $("memory-error").hidden = !memory.lastError;
  $("memory-error").textContent = memory.lastError ? `上次整理没成功：${memory.lastError}` : "";
  // Also one asked for before the page was reopened.
  const busy = dreaming || memory.dreaming;
  $("memory-dream").textContent = busy ? "整理中…" : "现在整理一次";
  $("memory-dream").disabled = busy || !on;
}

function noteInfo() {
  const n = [...$("memory-note").value.trim()].length;
  const over = n > memory.noteMax ? "，有点长，下次整理时会压缩" : "";
  const memos = memory.memos ? `；还有 ${memory.memos} 条刚记下的，关掉聊天后整理进来` : "";
  $("memory-note-info").textContent = `${n} / ${memory.noteMax} 字${over}${memos}`;
}

function initMemory() {
  $("memory-open").onclick = () => showTab("memory", "ai");
  $("memory-back").onclick = () => showTab("ai");
  const box = $("memory-note");
  box.oninput = noteInfo;
  box.onchange = () => invoke("memory_edit", { op: "save", note: box.value });
  $("memory-dream").onclick = () => {
    $("memory-dream").textContent = "整理中…";
    $("memory-dream").disabled = true;
    dreaming = true;
    invoke("memory_dream", { day: memDay(), now: new Date().toLocaleString("zh-CN", { dateStyle: "full", timeStyle: "short", hour12: false }), why: "manual" }).finally(dreamDone);
  };
  $("memory-forget").onclick = () => {
    const b = $("memory-forget");
    if (!b.classList.contains("armed")) {
      b.classList.add("armed");
      b.textContent = "再点一次，全部删掉";
      clearTimeout(forgetTimer);
      forgetTimer = setTimeout(disarmForget, 2500);
      return;
    }
    disarmForget();
    box.value = "";
    invoke("memory_edit", { op: "forget" });
  };
  // Switching memory on or off changes what the page says.
  for (const key of ["memory.enabled", "ai.enabled"]) document.querySelector(`[data-key="${key}"]`).addEventListener("input", showMemory);
  listen("memory", () => showMemory());
  showMemory();
}

function dreamDone() {
  dreaming = false;
  $("memory-dream").textContent = "现在整理一次";
  $("memory-dream").disabled = !(config.ai.enabled && config.memory.enabled);
}

function disarmForget() {
  clearTimeout(forgetTimer);
  $("memory-forget").classList.remove("armed");
  $("memory-forget").textContent = "全部忘掉";
}

// ---------------------------------------------------------------- autostart

async function initAutostart() {
  const box = $("autostart");
  const [available, enabled] = await invoke("autostart_get");
  box.checked = enabled;
  box.disabled = !available;
  if (!available) $("autostart-note").textContent = "开发模式下不可用，打包后的正式版才能开机自启";
  box.onchange = async () => {
    try {
      box.checked = await invoke("autostart_set", { enable: box.checked });
    } catch (e) {
      box.checked = !box.checked;
      $("autostart-note").textContent = String(e);
    }
  };
}

// ---------------------------------------------------------------- gallery

async function initGallery() {
  const list = await fetch("assets/clawd/manifest.json").then((r) => r.json());
  let theme = "";
  $("gallery-count").textContent = `共 ${list.length} 个`;

  const render = () => {
    const q = $("search").value.trim().toLowerCase();
    $("grid").innerHTML = "";
    for (const m of list) {
      if (theme && m.theme !== theme) continue;
      if (q && !`${m.zh} ${m.en} ${m.slug}`.toLowerCase().includes(q)) continue;
      const b = el("button", "", m.zh);
      b.title = `${m.en} · ${m.slug}`;
      b.onclick = () => {
        $("preview").src = `assets/clawd/${m.slug}.gif`;
        $("preview-name").textContent = `${m.zh} · ${m.slug}`;
        emitTo("main", "play", m.slug);
      };
      $("grid").append(b);
    }
  };

  const themes = [["", "全部"], ...new Map(list.map((m) => [m.theme, m.themeZh]))];
  for (const [id, name] of themes) {
    const chip = el("button", id === theme ? "active" : "", name);
    chip.onclick = () => {
      theme = id;
      $("themes").querySelectorAll("button").forEach((c) => c.classList.toggle("active", c === chip));
      render();
    };
    $("themes").append(chip);
  }
  $("search").oninput = render;
  render();
}

// ---------------------------------------------------------------- boot

async function boot() {
  config = await invoke("get_config");
  config.sys.folders ??= [];
  known = structuredClone(config);
  bindFields();
  refreshOutputs();
  bindBirthday();
  listen("config", (e) => onConfig(e.payload));
  renderSleepWindows();
  pathList("folders", "add-folder", () => config.sys.folders);
  initFullscreenExclude();
  initGitWatch();
  showHooks(await invoke("hooks_installed"));
  initAutostart();
  initAi();
  initMemory();
  initGallery();
}

boot();
