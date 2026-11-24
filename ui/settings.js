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

/** The save in flight, if any. */
let saving = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    saving = write();
  }, 150);
}

async function write() {
  known = structuredClone(config);
  await invoke("set_config", { config });
  $("saved").classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $("saved").classList.remove("show"), 1500);
}

/** Saves what is waiting to be saved now, for a command that goes by the saved config. */
async function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    saving = write();
  }
  await saving;
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

// ---------------------------------------------------------------- drop-downs

// A <select> pops up a square list no CSS reaches, so each gets a button and a list of
// our own. The select stays underneath with the value: setting it from code shows, and
// picking from the list fires its change event.

const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
/** The list that is open: { select, button, pop }. */
let dropped = null;

function dropdown(select) {
  const button = el("button", "dropdown");
  const label = el("span");
  button.append(label, el("i", "chevron"));
  select.classList.add("native");
  select.after(button);
  const show = () => {
    const option = select.selectedOptions[0];
    label.textContent = option?.textContent ?? "";
    button.classList.toggle("placeholder", !option || option.hidden);
    button.hidden = select.hidden;
  };
  Object.defineProperty(select, "value", {
    get: () => selectValue.get.call(select),
    set: (v) => {
      selectValue.set.call(select, v);
      show();
    },
  });
  // An open list was made from the options as they were: it goes once they change.
  new MutationObserver(() => {
    if (dropped?.select === select) closeDropdown();
    show();
  }).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  button.onclick = () => (dropped?.select === select ? closeDropdown() : openDropdown(select, button));
  // The arrows open it, as they would a select.
  button.onkeydown = (e) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && dropped?.select !== select) {
      e.preventDefault();
      openDropdown(select, button);
    }
  };
  show();
}

function openDropdown(select, button) {
  closeDropdown();
  const pop = el("div", "dropdown-pop");
  const list = el("div", "dropdown-list");
  /** Each group's heading and items, to hide the heading of one filtered empty. */
  const groups = [];
  const items = [];
  // The focus goes back to the button (unless what the change opens takes it).
  const pick = (value) => {
    closeDropdown(true);
    if (value === select.value) return;
    select.value = value;
    select.dispatchEvent(new Event("change"));
  };
  const add = (option, group) => {
    if (option.hidden || option.disabled) return;
    const item = el("div", "dropdown-item", option.textContent);
    item.classList.toggle("selected", option.selected);
    item.onclick = () => pick(option.value);
    // Without scrolling: an item scrolled under a still mouse would mark the next one.
    item.onmousemove = () => mark(items.indexOf(item), false);
    item.value = option.value;
    // An option marked data-keep ("自己填…") stays through any search.
    item.keep = "keep" in option.dataset;
    items.push(item);
    group?.items.push(item);
    list.append(item);
  };
  for (const child of select.children) {
    if (child.tagName !== "OPTGROUP") {
      add(child);
      continue;
    }
    const group = { head: el("div", "dropdown-group", child.label), items: [] };
    groups.push(group);
    list.append(group.head);
    for (const option of child.children) add(option, group);
  }
  // Keyboard: the arrows move a mark, Enter picks it.
  // Unshown at first, but the arrows move on from the selected one.
  let marked = items.findIndex((item) => item.classList.contains("selected"));
  const mark = (i, scroll = true) => {
    items[marked]?.classList.remove("marked");
    marked = i;
    const item = items[i];
    if (!item) return;
    item.classList.add("marked");
    if (!scroll) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  };
  const step = (by) => {
    const shown = items.filter((item) => !item.hidden);
    if (!shown.length) return;
    const at = shown.indexOf(items[marked]);
    mark(items.indexOf(shown[at < 0 ? (by > 0 ? 0 : shown.length - 1) : (at + by + shown.length) % shown.length]));
  };
  pop.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") step(e.key === "ArrowDown" ? 1 : -1);
    else if (e.key === "Enter" && items[marked] && !items[marked].hidden) pick(items[marked].value);
    else if (e.key === "Escape") closeDropdown(true);
    // From the button, so that Tab goes on to the control after it.
    else if (e.key === "Tab") return closeDropdown(true);
    else return;
    e.preventDefault();
  };
  // A select marked data-search (the models) can be searched once its list is long.
  let search;
  if ("search" in select.dataset && items.length > 12) {
    search = el("input");
    search.type = "search";
    search.placeholder = "搜索…";
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      for (const item of items) item.hidden = !!q && !item.keep && !item.textContent.toLowerCase().includes(q);
      for (const g of groups) g.head.hidden = g.items.every((item) => item.hidden);
      mark(-1);
      step(1);
    };
    pop.append(search);
  }
  pop.append(list);
  pop.tabIndex = -1;
  // Tabbing away closes it; the button's own click does that itself.
  pop.addEventListener("focusout", (e) => {
    if (!pop.contains(e.relatedTarget) && e.relatedTarget !== button) closeDropdown();
  });
  document.body.append(pop);

  // Below the button, or above it where there is more room there.
  const r = button.getBoundingClientRect();
  const extra = pop.offsetHeight - list.offsetHeight; // borders, padding, search box
  const below = innerHeight - r.bottom - 10;
  const above = r.top - 46; // under the title bar
  const up = below < 220 && above > below;
  list.style.maxHeight = `${Math.min(320, (up ? above : below) - extra)}px`;
  pop.style.minWidth = `${r.width}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
  if (up) pop.style.bottom = `${innerHeight - r.top + 4}px`;
  else pop.style.top = `${r.bottom + 4}px`;
  const selected = list.querySelector(".selected");
  if (selected) list.scrollTop = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2;
  (search || pop).focus();
  button.classList.add("open");
  dropped = { select, button, pop };
}

/** `refocus`: give the focus back to the button, as after Escape. */
function closeDropdown(refocus = false) {
  if (!dropped) return;
  // Cleared first: removing the list may lose it the focus, which closes it again.
  const { pop, button } = dropped;
  dropped = null;
  pop.remove();
  button.classList.remove("open");
  if (refocus) button.focus();
}

// Clicking elsewhere, scrolling the page or leaving the window closes the list.
document.addEventListener("mousedown", (e) => {
  if (dropped && !dropped.pop.contains(e.target) && !dropped.button.contains(e.target)) closeDropdown();
});
document.querySelector("main").addEventListener("scroll", () => closeDropdown());
addEventListener("resize", () => closeDropdown());
addEventListener("blur", () => closeDropdown());

// ---------------------------------------------------------------- window

$("win-min").onclick = () => getCurrentWindow().minimize();
$("win-close").onclick = () => getCurrentWindow().close();

// ---------------------------------------------------------------- tabs

for (const tab of document.querySelectorAll("nav button")) {
  tab.onclick = () => showTab(tab.dataset.tab);
}

for (const back of document.querySelectorAll("a.back")) {
  back.onclick = () => showTab(back.dataset.back);
}

// The links between pages have no href, so Tab and Enter reach them this way.
for (const link of document.querySelectorAll("a.back, a.row.more")) {
  link.tabIndex = 0;
  link.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    link.click();
  });
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

// ---------------------------------------------------------------- status line relay

async function initStatusline() {
  const box = $("statusline");
  const note = $("statusline-note").innerHTML;
  box.checked = await invoke("statusline_get");
  box.onchange = async () => {
    box.disabled = true;
    try {
      box.checked = await invoke("statusline_set", { install: box.checked });
      $("statusline-note").innerHTML = note;
    } catch (e) {
      box.checked = !box.checked;
      $("statusline-note").textContent = String(e);
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

// ---------------------------------------------------------------- permission hotkeys

/** [action, button it stands for, note]; in config.hotkeys by action. */
const HOTKEYS = [
  ["allow", "允许"],
  ["deny", "拒绝"],
  ["always", "总是允许", "气泡上有这个按钮时才有用"],
];
const MODIFIERS = ["Control", "Alt", "Shift", "Meta"];
/** Each action's row: { keys, small, err }. */
const hotkeyRows = {};
/** The key capture going on: { action, mods }. */
let capturing = null;

/** A combo written the one way, so that "shift+Ctrl+y" and "Ctrl+Shift+Y" compare the same. */
function sameCombo(a, b) {
  const norm = (c) => {
    const parts = c.split("+").map((x) => x.trim().toLowerCase());
    const key = parts.pop();
    return [...["ctrl", "alt", "shift", "win"].filter((m) => parts.includes(m)), key].join("+");
  };
  return Boolean(a && b) && norm(a) === norm(b);
}

/** The action before `action` with the same combo: the pet holds it for that one only. */
const twinOf = (action, combo) => HOTKEYS.slice(0, HOTKEYS.findIndex(([a]) => a === action)).find(([other]) => sameCombo(config.hotkeys[other], combo));

const heldMods = (e) => [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean);

/** A key a hotkey can end with: a letter, a digit or F1–F24, by where it is on the
 *  keyboard, so that any layout gives the same combo. */
function comboKey(e) {
  const m = /^(?:Key([A-Z])|Digit([0-9])|(F(?:[1-9]|1[0-9]|2[0-4])))$/.exec(e.code);
  return m && (m[1] || m[2] || m[3]);
}

function initHotkeys() {
  for (const [action, name, note = ""] of HOTKEYS) {
    const text = el("span", "text");
    const small = el("small", "", note);
    text.append(el("b", "", name), small);
    const keys = el("button", "keys");
    keys.onclick = () => (capturing?.action === action ? endCapture() : startCapture(action));
    const row = el("div", "row");
    row.append(text, keys);
    const err = el("div", "error");
    err.hidden = true;
    $("hotkey-list").append(row, err);
    hotkeyRows[action] = { keys, small, note, err };
    drawKeys(action);
  }
  for (const key of ["bubbles", "hotkeys.enabled"]) document.querySelector(`[data-key="${key}"]`).addEventListener("input", showHotkeys);
  // While capturing, every key is for the capture (Tab and Enter too), not for the page.
  document.addEventListener("keydown", captureKey, true);
  document.addEventListener("keyup", (e) => {
    if (!capturing) return;
    capturing.mods = heldMods(e);
    drawKeys(capturing.action);
  }, true);
  window.addEventListener("blur", endCapture);
  showHotkeys();
}

/** The combos only matter with the bubbles on, and are set only with the hotkeys on. */
function showHotkeys() {
  $("hotkeys-card").hidden = !config.bubbles;
  $("hotkey-list").hidden = !config.hotkeys.enabled;
  if (!config.hotkeys.enabled) endCapture();
  for (const [action] of HOTKEYS) checkHotkey(action);
}

/** Says so under the combo when another program holds it. */
async function checkHotkey(action) {
  const combo = config.hotkeys[action];
  const twin = config.hotkeys.enabled && twinOf(action, combo);
  const problem = twin
    ? `和「${twin[1]}」的快捷键重复了，按下去算「${twin[1]}」，换一个吧`
    : config.hotkeys.enabled && combo
      ? await invoke("hotkey_check", { combo }).then(() => "", String)
      : "";
  // A newer combo may have been set meanwhile.
  if (combo === config.hotkeys[action]) showHotkeyError(action, problem);
}

function showHotkeyError(action, text) {
  const { keys, err } = hotkeyRows[action];
  err.textContent = text;
  err.hidden = !text;
  keys.classList.toggle("taken", Boolean(text));
}

/** The combo as key caps; while capturing, the modifiers held so far. */
function drawKeys(action) {
  const { keys } = hotkeyRows[action];
  const live = capturing?.action === action;
  keys.classList.toggle("capturing", live);
  keys.innerHTML = "";
  const parts = live ? capturing.mods : config.hotkeys[action].split("+").filter(Boolean);
  parts.forEach((part, i) => {
    if (i) keys.append(el("span", "plus", "+"));
    keys.append(el("kbd", "", part));
  });
  if (live) {
    if (parts.length) keys.append(el("span", "plus", "+"));
    else keys.append(el("span", "waiting", "按下组合键"));
    keys.append(el("i", "caret"));
  } else if (!parts.length) {
    keys.append(el("span", "none", "未设置"));
  }
}

function startCapture(action) {
  endCapture();
  capturing = { action, mods: [] };
  // The pet lets go of its hotkeys meanwhile, or pressing one would reach it, not the page.
  invoke("hotkeys_pause", { paused: true });
  hotkeyRows[action].small.textContent = "Esc 取消 · Backspace 清除";
  showHotkeyError(action, "");
  drawKeys(action);
}

function endCapture() {
  if (!capturing) return;
  const { action } = capturing;
  capturing = null;
  invoke("hotkeys_pause", { paused: false });
  hotkeyRows[action].small.textContent = hotkeyRows[action].note;
  drawKeys(action);
  // What a key pressed meanwhile was turned down for gives way to how the combo stands.
  showHotkeyError(action, "");
  checkHotkey(action);
}

function captureKey(e) {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  const { action } = capturing;
  const mods = heldMods(e);
  if (MODIFIERS.includes(e.key)) {
    capturing.mods = mods;
    return drawKeys(action);
  }
  if (e.key === "Escape" && !mods.length) return endCapture();
  if ((e.key === "Backspace" || e.key === "Delete") && !mods.length) return setHotkey(action, "");
  const key = comboKey(e);
  if (!key) return showHotkeyError(action, "最后一个键要是字母、数字或 F1–F24");
  if (!mods.some((m) => m !== "Shift")) return showHotkeyError(action, "要带上 Ctrl、Alt 或 Win，免得打字时被它抢走");
  const combo = [...mods, key].join("+");
  const twin = HOTKEYS.find(([other]) => other !== action && sameCombo(config.hotkeys[other], combo));
  if (twin) return showHotkeyError(action, `和「${twin[1]}」的快捷键重复了`);
  setHotkey(action, combo);
}

function setHotkey(action, combo) {
  config.hotkeys[action] = combo;
  save();
  endCapture();
}

// ---------------------------------------------------------------- AI chat

let providers = [];
/** The provider's own model list once fetched; until then a few suggestions. */
let fetchedModels = null;
/** The two built-in templates the user's own providers work like; not offered by themselves. */
const TEMPLATES = ["custom", "custom-anthropic"];
/** Not values of their own: the provider list's "add one", the model list's "type it". */
const ADD = "\u0001add";
const MANUAL = "\u0001manual";
let deleteProviderTimer = 0;

const customProvider = (id) => config.ai.customProviders.find((c) => c.id === id);

/** The provider chatted with; one of the user's own is its template under its own id and name. */
function provider() {
  const mine = customProvider(config.ai.provider);
  if (mine) {
    const template = providers.find((p) => p.id === mine.kind) || providers.find((p) => p.id === "custom");
    return { ...template, id: mine.id, name: mine.name || "未命名", mine };
  }
  return providers.find((p) => p.id === config.ai.provider && !TEMPLATES.includes(p.id)) || providers[0];
}

const profile = () => (config.ai.profiles[provider().id] ??= { baseUrl: "", model: "", reasoning: "" });

/** Settings from before providers of one's own: what was set for a template becomes one. */
async function migrateCustom() {
  for (const [kind, name] of [["custom", "自定义"], ["custom-anthropic", "自定义（Anthropic）"]]) {
    const old = config.ai.profiles[kind];
    // Anything set (a key alone too) would be out of reach once the templates aren't listed.
    if (config.ai.provider !== kind && !Object.values(old ?? {}).some(Boolean) && !keys[kind]) continue;
    const mine = { id: `my-${kind}-${Date.now().toString(36)}`, name, kind };
    if (keys[kind]) {
      // Left as it was if the key can't move: the next time the page opens tries again.
      if (!(await invoke("ai_key_move", { from: kind, to: mine.id }).then(() => true, () => false))) continue;
      showKeys(await invoke("ai_keys"));
    }
    config.ai.customProviders.push(mine);
    if (old) config.ai.profiles[mine.id] = old;
    delete config.ai.profiles[kind];
    if (config.ai.provider === kind) config.ai.provider = mine.id;
    save();
  }
}

async function initAi() {
  providers = await invoke("ai_providers");
  showKeys(await invoke("ai_keys"));
  await migrateCustom();
  $("ai-provider").onchange = () => {
    const id = $("ai-provider").value;
    if (id === ADD) addProvider();
    else switchProvider(id);
  };
  $("provider-open").onclick = () => showTab("provider", "ai");
  $("persona-open").onclick = () => showTab("persona", "ai");
  const field = (id, key) => {
    $(id).oninput = () => {
      profile()[key] = $(id).value.trim();
      // A fetch from the old address is ignored when it comes back, and the models
      // fetched from it may not be at the new one.
      if (key === "baseUrl") {
        $("ai-fetch").disabled = false;
        $("ai-model-note").textContent = "";
        $("ai-model-note").classList.remove("bad");
        if (fetchedModels) {
          fetchedModels = null;
          renderModels();
        }
      }
      save();
    };
  };
  field("ai-base", "baseUrl");
  $("ai-name").oninput = () => {
    provider().mine.name = $("ai-name").value.trim();
    $("ai-provider").selectedOptions[0].textContent = provider().name;
    showSummary();
    save();
  };
  for (const radio of document.querySelectorAll("input[name=ai-kind]")) {
    radio.onchange = () => {
      provider().mine.kind = radio.value;
      fetchedModels = null;
      showAi();
      save();
    };
  }
  $("ai-provider-delete").onclick = deleteProvider;
  $("ai-model").onchange = () => {
    const model = $("ai-model").value;
    if (model === MANUAL) {
      renderModels(); // back to the model in use until one is typed
      $("ai-model-input").value = profile().model;
      $("ai-model-input").hidden = false;
      $("ai-model-input").focus();
      return;
    }
    profile().model = model;
    modelChanged();
  };
  $("ai-model-input").oninput = () => {
    profile().model = $("ai-model-input").value.trim();
    renderModels(); // the list above shows it as it is typed
    modelChanged();
  };
  $("ai-model-input").onblur = () => {
    $("ai-model-input").hidden = true;
    renderModels();
  };
  $("ai-model-input").onkeydown = (e) => e.key === "Enter" && $("ai-model-input").blur();
  for (const [box, button] of [["ai-key", "ai-key-show"], ["ai-exa-key", "ai-exa-key-show"]]) {
    $(button).onclick = () => {
      const show = $(box).type === "password";
      $(box).type = show ? "text" : "password";
      $(button).classList.toggle("on", show);
      $(button).title = show ? "隐藏" : "显示";
    };
  }
  vaults.push(
    (providerVault = vault($("ai-key-vault"), () => provider().id, () => (provider().needsKey ? "必填，粘贴后回车保存" : "不需要就留空"))),
    vault($("ai-exa-vault"), () => "exa", () => "可以不填"),
  );
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

function renderProviders() {
  const select = $("ai-provider");
  select.innerHTML = "";
  const group = (label, options) => {
    const optgroup = document.createElement("optgroup");
    optgroup.label = label;
    optgroup.append(...options);
    select.append(optgroup);
  };
  const builtIn = providers.filter((p) => !TEMPLATES.includes(p.id));
  for (const label of new Set(builtIn.map((p) => p.group))) {
    group(label, builtIn.filter((p) => p.group === label).map((p) => new Option(p.name, p.id)));
  }
  group("自定义", [...config.ai.customProviders.map((c) => new Option(c.name || "未命名", c.id)), new Option("＋ 添加服务商", ADD)]);
  select.value = provider().id;
}

function switchProvider(id) {
  config.ai.provider = id;
  fetchedModels = null;
  baseOpen = false;
  showAi();
  save();
}

function addProvider() {
  const mine = { id: `my-${Date.now().toString(36)}`, name: "我的服务商", kind: "custom" };
  config.ai.customProviders.push(mine);
  switchProvider(mine.id);
  $("ai-name").focus();
  $("ai-name").select();
}

/** Deleting takes a second click within a moment. */
function deleteProvider() {
  const button = $("ai-provider-delete");
  if (!button.classList.contains("armed")) {
    button.classList.add("armed");
    button.textContent = "再点一次删除";
    clearTimeout(deleteProviderTimer);
    deleteProviderTimer = setTimeout(disarmProviderDelete, 2500);
    return;
  }
  const id = provider().id;
  invoke("ai_key_set", { which: id, key: "" }).then(showKeys, (e) =>
    providerVault.notice(`删掉的服务商的密钥没能从 Windows 凭据管理器里移除：${e}。可以在系统的凭据管理器里找 clawd-pet/${id} 手动删掉。`),
  );
  config.ai.customProviders = config.ai.customProviders.filter((c) => c.id !== id);
  delete config.ai.profiles[id];
  switchProvider("deepseek"); // the default (config.rs)
}

function disarmProviderDelete() {
  clearTimeout(deleteProviderTimer);
  $("ai-provider-delete").classList.remove("armed");
  $("ai-provider-delete").textContent = "删除";
}

function showAi() {
  const [p, mine] = [provider(), profile()];
  renderProviders();
  $("ai-name-row").hidden = $("ai-kind-row").hidden = !p.mine;
  if (p.mine) {
    $("ai-name").value = p.mine.name;
    for (const radio of document.querySelectorAll("input[name=ai-kind]")) radio.checked = radio.value === (p.mine.kind === "custom-anthropic" ? "custom-anthropic" : "custom");
  }
  disarmProviderDelete();
  providerVault.reset();
  $("ai-key-link").hidden = !p.keyUrl;
  $("ai-base").value = mine.baseUrl;
  $("ai-base").placeholder = p.baseUrl || "必填，如 https://example.com/v1";
  $("ai-fetch").disabled = false; // a fetch for the provider before is ignored when it comes back
  $("ai-model-note").textContent = "";
  $("ai-model-note").classList.remove("bad");
  $("ai-model-input").hidden = true;
  renderModels();
  showBase();
  showReasoning();
  showSummary();
}

function showSummary() {
  const p = provider();
  $("provider-summary").textContent = `${p.name} · ${profile().model || p.model || "还没选模型"}`;
  $("ai-search-note").textContent = p.search ? "问到新闻、天气这类事会自己去查，有的服务商按次收费" : `${p.name} 没有自带的联网搜索，可以用 Exa`;
}

// ---- API keys: in the Windows Credential Manager, never in the config; the page only
// learns which there are (`ai_keys`), by their last few characters.

/** By provider id ("exa" for Exa's): { tail, plain }, plain while the vault couldn't take it. */
let keys = {};
/** Why the vault turned a key down. */
let keyTrouble = null;
const vaults = [];
let providerVault;

function showKeys(status) {
  keys = status.keys;
  keyTrouble = status.trouble;
  for (const v of vaults) v.show();
}

/** A key box: a saved key by its last characters, to replace or remove; or a box to type one
 *  into, which saves it on Enter and on leaving the box, and a moment after typing stops
 *  while there is no key yet. A key being replaced is saved only on Enter or leaving, so
 *  that Esc can still keep the old one. */
function vault(box, which, placeholder) {
  const input = box.querySelector("input");
  const remove = box.querySelector(".vault-remove");
  const warn = box.closest(".row").nextElementSibling;
  let editing = false;
  let sent = "";
  let failed = "";
  let timer = 0;
  let disarmTimer = 0;

  const disarm = () => {
    clearTimeout(disarmTimer);
    remove.classList.remove("armed");
    remove.textContent = "移除";
  };
  const show = () => {
    const key = keys[which()];
    box.classList.toggle("saved", !!key && !editing);
    box.classList.toggle("plain", !!key?.plain);
    box.querySelector(".vault-where").textContent = key?.plain ? "明文保存" : "凭据管理器";
    box.querySelector(".vault-tail").textContent = key?.tail || "••••";
    box.querySelector(".vault-saved").title = key?.plain
      ? "Windows 凭据管理器没能存下，还以明文放在 config.json 里"
      : `存在 Windows 凭据管理器里，名字是 clawd-pet/${which()}`;
    input.placeholder = key ? "粘贴新的密钥，回车保存，Esc 保留原来的" : placeholder();
    const plain = key?.plain ? `Windows 凭据管理器没能存下这个密钥${keyTrouble ? `：${keyTrouble}` : ""}。它还以明文放在 config.json 里，重新填一次或者重启桌宠时会再试。` : "";
    warn.textContent = failed || plain;
    warn.hidden = !warn.textContent;
    disarm();
  };
  const commit = async () => {
    clearTimeout(timer);
    const [w, value] = [which(), input.value.trim()];
    if (!value) return true;
    if (value === sent) return !failed;
    sent = value;
    try {
      const status = await invoke("ai_key_set", { which: w, key: value });
      failed = "";
      showKeys(status);
      return true;
    } catch (e) {
      sent = ""; // the same key may be tried again
      // Switched away meanwhile: said under the box now there, as it can't be under its own.
      failed = which() === w ? String(e) : `刚才填的密钥没存上：${e}。切回去再填一次吧。`;
      show();
      return false;
    }
  };
  /** Back to the saved key (if any), with nothing typed. */
  const reset = () => {
    clearTimeout(timer);
    editing = false;
    sent = failed = "";
    input.value = "";
    show();
  };

  input.oninput = () => {
    editing = true; // stays the box to type in until left, saved or not
    clearTimeout(timer);
    if (!keys[which()]) timer = setTimeout(commit, 800);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") reset();
  };
  input.onblur = async () => {
    const w = which();
    if (await commit() && which() === w) reset();
  };
  box.querySelector(".vault-replace").onclick = () => {
    editing = true;
    show();
    input.focus();
  };
  remove.onclick = async () => {
    if (!remove.classList.contains("armed")) {
      remove.classList.add("armed");
      remove.textContent = "确定";
      disarmTimer = setTimeout(disarm, 2500);
      return;
    }
    try {
      showKeys(await invoke("ai_key_set", { which: which(), key: "" }));
    } catch (e) {
      failed = String(e);
      show();
    }
  };
  /** Says `text` under the box, for something that went wrong elsewhere. */
  const notice = (text) => {
    failed = text;
    show();
  };
  show();
  return { show, reset, notice };
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
  $("ai-reasoning-row").hidden = !list.length;
  // What the provider's levels mean, for whoever wonders.
  $("ai-reasoning-row").title = p.reasoningNote;
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
  // DeepSeek turns down its screenshot tool beside its own search unless it thinks.
  const clash = p.id === "deepseek" && level === "off" && config.ai.screen && config.ai.search && !config.ai.exa && p.search;
  // Shown both beside the levels and beside the switches, whichever page is open.
  for (const warn of document.querySelectorAll(".clash-warn")) {
    warn.hidden = !clash;
    warn.textContent = clash ? "推理关着时，DeepSeek 不让看屏幕和它自带的搜索一起用，聊天会报错。换一档推理，或者改用 Exa 搜索。" : "";
  }
}

function modelChanged() {
  showReasoning();
  showSummary();
  save();
}

/** The models to pick from, with the one in use among them even if typed in. */
function renderModels() {
  const select = $("ai-model");
  const list = fetchedModels || provider().models;
  const current = profile().model || provider().model;
  select.innerHTML = "";
  const none = new Option("选一个模型", "");
  none.hidden = true;
  select.append(none);
  for (const m of current && !list.includes(current) ? [current, ...list] : list) select.append(new Option(m, m));
  const manual = new Option("自己填…", MANUAL);
  manual.dataset.keep = "";
  select.append(manual);
  select.value = current;
}

async function fetchModels() {
  const [button, note] = [$("ai-fetch"), $("ai-model-note")];
  // What the list is for: the provider, its address, and for one of the user's own, its kind.
  const which = () => `${provider().id} ${provider().mine?.kind ?? ""} ${profile().baseUrl}`;
  const asked = which();
  button.disabled = true;
  note.classList.remove("bad");
  note.textContent = "正在获取…";
  let list;
  try {
    // The backend asks with the saved settings (and the key it keeps), so save first.
    await saveNow();
    list = await invoke("ai_models", { provider: provider().id });
  } catch (e) {
    list = e;
  }
  // Switched away meanwhile: the page has moved on (and freed the button), so neither
  // the list nor an error belongs to it.
  if (which() !== asked) return;
  button.disabled = false;
  if (Array.isArray(list)) {
    fetchedModels = list;
    note.textContent = list.length ? `找到 ${list.length} 个模型` : "服务商没给出列表，选「自己填」吧";
  } else {
    note.textContent = String(list);
    note.classList.add("bad");
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
  $("ai-identity-note").textContent = empty ? "空着就按默认的身份" : "";
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
  $("persona-summary").textContent = `人设：${(custom || preset).name || "未命名"}`;
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
  $("ai-persona-note").textContent = !custom && empty ? "空着就按预设的人设" : "";
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

// ---------------------------------------------------------------- recap

// What got done with Claude (recap.rs), a day, a week (Monday to Sunday) or a month at a
// time. Days start at 05:00, so an hour row runs from 05 to 04. A day missing, or an hour
// not in its `seen` bits, is no data (the pet wasn't running), shown apart from a zero.

/** The hours of a day in the order they come: 05 … 23, 00 … 04. */
const RECAP_HOURS = [...Array(24)].map((_, i) => (i + 5) % 24);
const WEEKDAYS = "一二三四五六日";
/** Busy minutes in an hour from which a cell takes the next shade. */
const SHADES = [10, 25, 45];

let recap = { days: {} };
let recapView = "week";
/** The first day of the period shown, "YYYY-MM-DD". */
let recapStart = null;

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDay = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (day, n) => {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const weekday = (day) => (parseDay(day).getDay() + 6) % 7;
/** Minutes after 05:00: the order times of day come in within one day. */
const dayMinute = (hm) => {
  const [h, m] = hm.split(":").map(Number);
  return (h * 60 + m + 1440 - 300) % 1440;
};

/** The first day of the period `view` that `day` is in. */
function periodStart(view, day) {
  if (view === "week") return addDays(day, -weekday(day));
  if (view === "month") return `${day.slice(0, 8)}01`;
  return day;
}

function periodDays(view, start) {
  if (view === "day") return [start];
  const n = view === "week" ? 7 : new Date(parseDay(start).getFullYear(), parseDay(start).getMonth() + 1, 0).getDate();
  return [...Array(n)].map((_, i) => addDays(start, i));
}

function shiftPeriod(view, start, by) {
  if (view === "day") return addDays(start, by);
  if (view === "week") return addDays(start, 7 * by);
  const d = parseDay(start);
  return ymd(new Date(d.getFullYear(), d.getMonth() + by, 1));
}

/** [number, unit], the number possibly with a unit of its own inside: "3 小时 5 分". */
function durationText(secs) {
  const m = Math.round(secs / 60);
  if (m < 60) return [m, "分钟"];
  // Past ten hours the minutes no longer matter, and would not fit.
  if (m >= 600) return [Math.round(m / 6) / 10, "小时"];
  const h = Math.floor(m / 60);
  return m % 60 ? [`${h}<small>小时</small>${m % 60}`, "分"] : [h, "小时"];
}

// Little icons, drawn on a pixel grid like the pet.
const ICONS = {
  done: ["......X", ".....XX", "X...XX.", "XX.XX..", ".XXX...", "..X....", "......."],
  busy: ["XXXXXXX", ".X...X.", "..X.X..", "...X...", "..XXX..", ".XXXXX.", "XXXXXXX"],
  last: ["..XXX..", ".X...X.", "X..X..X", "X..XX.X", "X.....X", ".X...X.", "..XXX.."],
  late: ["..XXX..", ".XX....", "XX.....", "XX...X.", "XX.....", ".XX....", "..XXX.."],
  sessions: ["XXXXXXX", "X.....X", "X.X.X.X", "X.....X", "XXXXXXX", ".XX....", ".X....."],
  approvals: ["XXXXXXX", "X.....X", "X....XX", "XX..X.X", "X.XX..X", ".X...X.", "..XXX.."],
  errors: ["....XX.", "...XXXX", "..XX.XX", ".XX.XX.", "XX.XX..", "XXXX...", ".XX...."],
  peak: ["...XXX.", "..XXX..", ".XXX...", "XXXXXX.", "...XXX.", "..XX...", ".XX...."],
};

function icon(name) {
  const rows = ICONS[name];
  const rects = rows.flatMap((row, y) => [...row].map((c, x) => (c === "X" ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : "")));
  return `<svg class="pix" viewBox="0 0 ${rows[0].length} ${rows.length}" aria-hidden="true">${rects.join("")}</svg>`;
}

async function showRecap() {
  recap = await invoke("recap_get");
  // Without the hooks there is nothing to count.
  $("recap-nohooks").hidden = await invoke("hooks_installed");
  if (recap.open) openRecapWeek(recap.open);
  drawRecap();
}

/** From the weekly card: that week. */
function openRecapWeek(week) {
  recapView = "week";
  recapStart = week;
  document.querySelector('input[name=recap-view][value="week"]').checked = true;
  showTab("recap");
}

function drawRecap() {
  const today = memDay();
  recapStart ??= periodStart(recapView, today);
  const days = periodDays(recapView, recapStart);
  const data = days.map((d) => recap.days[d] || null);
  const end = days.at(-1);
  const earliest = Object.keys(recap.days).sort()[0] || today;
  $("recap-prev").disabled = recapStart <= earliest;
  $("recap-next").disabled = end >= today;
  $("recap-range").textContent = rangeText(days, today);
  drawStats(days, data);
  $("recap-when-title").textContent = recapView === "day" ? "每个钟头忙了多久" : "什么时候在忙";
  if (recapView === "day") drawHours(days[0], data[0], today);
  else drawHeat(days, data, today);
  drawProjects(data);
}

function rangeText(days, today) {
  const [a, b] = [parseDay(days[0]), parseDay(days.at(-1))];
  const md = (d) => `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  if (recapView === "day") {
    const name = days[0] === today ? "今天" : days[0] === addDays(today, -1) ? "昨天" : `周${WEEKDAYS[weekday(days[0])]}`;
    return `${md(a)} · ${name}`;
  }
  if (recapView === "week") {
    const name = days[0] === periodStart("week", today) ? "本周" : days[0] === periodStart("week", addDays(today, -7)) ? "上周" : "";
    const span = a.getMonth() === b.getMonth() ? `${md(a)} – ${b.getDate()} 日` : `${md(a)} – ${md(b)}`;
    return name ? `${span} · ${name}` : span;
  }
  return `${a.getFullYear()} 年 ${a.getMonth() + 1} 月`;
}

const sum = (list) => list.reduce((a, b) => a + b, 0);

function drawStats(days, data) {
  const box = $("recap-stats");
  box.innerHTML = "";
  const seen = data.filter(Boolean);
  const tasks = sum(seen.map((d) => sum(d.done)));
  const busy = sum(seen.map((d) => sum(d.busy)));
  // The latest finish, and on which day when there is more than one.
  let last = null;
  data.forEach((d, i) => {
    if (d?.last && (!last || dayMinute(d.last) > dayMinute(last.at))) last = { at: d.last, day: days[i] };
  });
  // Finished between 23:00 and 05:00.
  const late = sum(seen.map((d) => d.done[23] + d.done[0] + d.done[1] + d.done[2] + d.done[3] + d.done[4]));
  const hours = RECAP_HOURS.map((h) => sum(seen.map((d) => d.busy[h])));
  const peak = Math.max(...hours);
  const peakHour = RECAP_HOURS[hours.indexOf(peak)];
  const none = !seen.length;
  const tiles = [
    ["done", "搞定的任务", tasks, "个"],
    ["busy", "一起忙了", ...durationText(busy)],
    ["last", "最晚收工", last ? last.at.replace(/^0/, "") : "", last && recapView !== "day" ? `周${WEEKDAYS[weekday(last.day)]}` : ""],
    ["late", "深夜收工", late, "次"],
    ["sessions", "会话", sum(seen.map((d) => d.sessions)), "个"],
    ["approvals", "批过的权限", sum(seen.map((d) => d.approvals)), "次"],
    ["errors", "出错", sum(seen.map((d) => d.errors)), "次"],
    ["peak", "最忙的钟点", peak ? `${peakHour}–${(peakHour + 1) % 24}` : "", peak ? "点" : ""],
  ];
  for (const [name, title, value, unit] of tiles) {
    const tile = el("div", "stat");
    tile.innerHTML = `<span class="name">${icon(name)}${title}</span><span class="value"></span>`;
    const v = tile.querySelector(".value");
    // No data is a dash; nothing done is a zero.
    if (none || value === "") {
      v.textContent = "—";
      v.classList.add("empty");
    } else {
      v.innerHTML = `${value}<small>${unit}</small>`;
    }
    box.append(tile);
  }
}

function shade(secs) {
  const m = secs / 60;
  if (!m) return "l0";
  return `l${1 + SHADES.filter((x) => m >= x).length}`;
}

function cellTitle(day, h, d) {
  const span = `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;
  const when = `${parseDay(day).getMonth() + 1}/${parseDay(day).getDate()} 周${WEEKDAYS[weekday(day)]} ${span}`;
  if (!d || !(d.seen & (1 << h))) return `${when}\n没开着`;
  const m = Math.round(d.busy[h] / 60);
  return `${when}\n${m ? `忙了 ${m} 分钟` : "没在忙"}${d.done[h] ? ` · 搞定 ${d.done[h]} 个` : ""}`;
}

/** Whether hour `h` of `day` is still to come. */
function ahead(day, h, today) {
  if (day > today) return true;
  if (day < today) return false;
  const now = new Date();
  return RECAP_HOURS.indexOf(h) > RECAP_HOURS.indexOf(now.getHours());
}

/** A week or a month: a row for each day, a cell for each hour. */
function drawHeat(days, data, today) {
  const box = $("recap-heat");
  box.innerHTML = "";
  box.className = `heat ${recapView}`;
  box.append(el("span"));
  for (const h of RECAP_HOURS) box.append(el("span", "hour", h % 3 ? "" : String(h)));
  days.forEach((day, i) => {
    const d = data[i];
    const name = el("span", "day");
    const w = weekday(day);
    name.innerHTML = recapView === "week" ? `周${WEEKDAYS[w]}<small>${parseDay(day).getDate()}</small>` : `${parseDay(day).getDate()}<small>周${WEEKDAYS[w]}</small>`;
    name.classList.toggle("today", day === today);
    name.classList.toggle("weekend", w >= 5);
    box.append(name);
    for (const h of RECAP_HOURS) {
      const cell = el("i", "cell");
      if (ahead(day, h, today)) cell.classList.add("ahead");
      else if (!d || !(d.seen & (1 << h))) cell.classList.add("none");
      else cell.classList.add(shade(d.busy[h]));
      if (d?.done[h]) cell.classList.add("did");
      if (!cell.classList.contains("ahead")) cell.title = cellTitle(day, h, d);
      box.append(cell);
    }
  });
}

/** One day: a bar for each hour, how many minutes of it were busy, with the tasks done in it. */
function drawHours(day, d, today) {
  const box = $("recap-heat");
  box.innerHTML = "";
  box.className = "hours";
  for (const h of RECAP_HOURS) {
    const col = el("div", "col");
    const bar = el("i", "bar");
    if (ahead(day, h, today)) col.classList.add("ahead");
    else if (!d || !(d.seen & (1 << h))) col.classList.add("none");
    else {
      // In 5-minute steps, so the bars keep to a pixel grid.
      bar.style.setProperty("--h", Math.ceil(d.busy[h] / 300));
      bar.classList.add(shade(d.busy[h]));
      col.title = cellTitle(day, h, d);
    }
    col.append(el("span", "n", d?.done[h] ? String(d.done[h]) : ""), bar, el("span", "hour", h % 3 ? "" : String(h)));
    box.append(col);
  }
}

function drawProjects(data) {
  const box = $("recap-projects");
  box.innerHTML = "";
  const totals = new Map();
  for (const d of data) for (const [name, [n, m]] of Object.entries(d?.projects || {})) {
    const t = totals.get(name) || [0, 0];
    totals.set(name, [t[0] + n, t[1] + m]);
  }
  const top = [...totals].sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]).slice(0, 6);
  if (!top.length) {
    const empty = el("div", "recap-empty");
    const seen = data.some(Boolean);
    empty.innerHTML = `<img src="assets/clawd/${seen ? "read_doze" : "life_bed_sleep"}.gif" alt="" /><span></span>`;
    empty.querySelector("span").textContent = seen ? "这段时间还没一起完成任务，歇着也挺好～" : "这段时间我没开着，没有记录";
    box.append(empty);
    return;
  }
  const most = top[0][1][0];
  for (const [name, [n, m]] of top) {
    const row = el("div", "row project");
    const label = el("span", "text");
    label.append(el("b", "", name));
    const bar = el("span", "track");
    const fill = el("i");
    fill.style.width = `${Math.max(4, (n / most) * 100)}%`;
    bar.append(fill);
    const [v, unit] = durationText(m * 60);
    const count = el("span", "count");
    count.innerHTML = `${n} 个<small> · ${v}${unit}</small>`;
    row.append(label, bar, count);
    row.title = name;
    box.append(row);
  }
}

function initRecap() {
  for (const radio of document.querySelectorAll("input[name=recap-view]")) {
    radio.onchange = () => {
      // To the period around today if the one shown has it, else around its first day.
      const today = memDay();
      const days = periodDays(recapView, recapStart || today);
      recapView = radio.value;
      recapStart = periodStart(recapView, days.includes(today) ? today : days[0]);
      drawRecap();
    };
  }
  $("recap-prev").onclick = () => {
    recapStart = shiftPeriod(recapView, recapStart, -1);
    drawRecap();
  };
  $("recap-next").onclick = () => {
    recapStart = shiftPeriod(recapView, recapStart, 1);
    drawRecap();
  };
  document.querySelector('nav button[data-tab="recap"]').addEventListener("click", showRecap);
  listen("recap-open", (e) => {
    openRecapWeek(e.payload);
    showRecap();
  });
  // New numbers come in as Claude works: once a minute while the page shows them.
  setInterval(() => $("tab-recap").classList.contains("active") && showRecap(), 60 * 1000);
  showRecap();
}

// ---------------------------------------------------------------- autostart

async function initAutostart() {
  const box = $("autostart");
  const [available, enabled] = await invoke("autostart_get");
  box.checked = enabled;
  box.disabled = !available;
  if (!available) $("autostart-note").textContent = "只有打包后的正式版能开机自启";
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

// A collection of what the pet has played on the desktop (collection.rs): those show in
// color and move under the mouse; the rest stay silhouettes named "???" until it plays them.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Animations per milestone, as collection.rs cheers them. */
const COLLECT_STEP = 50;
/** slug -> a promise of a frame from the middle of the animation, or null. */
const keyFrames = new Map();

function keyFrame(slug) {
  if (!keyFrames.has(slug)) {
    const load = async () => {
      const data = await fetch(`assets/clawd/${slug}.gif`).then((r) => r.arrayBuffer());
      if (!window.ImageDecoder) return createImageBitmap(new Blob([data], { type: "image/gif" }));
      const decoder = new ImageDecoder({ data, type: "image/gif" });
      try {
        await decoder.tracks.ready;
        await decoder.completed;
        const { image } = await decoder.decode({ frameIndex: Math.floor(decoder.tracks.selectedTrack.frameCount / 2) });
        try {
          return await createImageBitmap(image);
        } finally {
          image.close();
        }
      } finally {
        decoder.close();
      }
    };
    keyFrames.set(slug, load().catch(() => null));
  }
  return keyFrames.get(slug);
}

/** Draws `slug`'s key frame on a canvas, or just its outline in the shadow color. */
async function drawFrame(canvas, slug, shadow) {
  const frame = await keyFrame(slug);
  if (!frame) return;
  const g = canvas.getContext("2d");
  g.globalCompositeOperation = "copy";
  g.drawImage(frame, 0, 0, canvas.width, canvas.height);
  if (!shadow) return;
  g.globalCompositeOperation = "source-in";
  g.fillStyle = getComputedStyle(canvas).getPropertyValue("--shadow").trim() || "#d6ccbd";
  g.fillRect(0, 0, canvas.width, canvas.height);
}

const longDate = (ms) => new Date(ms).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });

async function initGallery() {
  const list = await fetch("assets/clawd/manifest.json").then((r) => r.json());
  const record = await invoke("collection_get");
  const seen = record?.seen || {};
  // New: collected since the gallery was last opened (on a first visit, in the last day).
  const newSince = record?.visited || Date.now() - DAY_MS;
  const isNew = (m) => seen[m.slug]?.first > newSince;
  let theme = "";
  let filter = "all";
  let picked = null;

  if (record?.since) $("gallery-count").textContent = `${longDate(record.since)}开始收集`;
  $("total").textContent = list.length;
  $("progress-fill").parentElement.style.setProperty("--tick", `${(COLLECT_STEP / list.length) * 100}%`);

  // Tiles get their picture once scrolled near.
  const lazy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        lazy.unobserve(e.target);
        drawFrame(e.target.querySelector("canvas"), e.target.dataset.slug, e.target.classList.contains("unseen"));
      }
    },
    { root: document.querySelector("main"), rootMargin: "300px 0px" },
  );

  /** Shows `m` up top; a click on its tile (`tile`) also has the pet play it, if collected. */
  const choose = (m, tile) => {
    const have = seen[m.slug];
    $("preview").hidden = !have;
    $("preview-shadow").hidden = Boolean(have);
    if (!tile) {
      // Before any click: the latest one collected.
      $("preview").src = `assets/clawd/${m.slug}.gif`;
      $("preview-name").textContent = `最近收集：${m.zh}`;
      $("preview-meta").textContent = `${longDate(have.first)}第一次见 · 点卡片让它在桌面上演一遍`;
      return;
    }
    picked = m.slug;
    $("grid").querySelectorAll(".picked").forEach((t) => t.classList.remove("picked"));
    tile.classList.add("picked");
    if (have) {
      $("preview").src = `assets/clawd/${m.slug}.gif`;
      $("preview-name").textContent = m.zh;
      $("preview-meta").textContent = `${longDate(have.first)}第一次见 · 在桌面上演过 ${have.count} 次`;
      emitTo("main", "play", m.slug);
    } else {
      drawFrame($("preview-shadow"), m.slug, true);
      $("preview-name").textContent = "???";
      $("preview-meta").textContent = `${m.themeZh} · 还没见它演过，多陪它待一会儿吧`;
    }
  };

  const tile = (m) => {
    const have = seen[m.slug];
    const t = el("button", `tile ${have ? "seen" : "unseen"}${m.slug === picked ? " picked" : ""}`);
    t.dataset.slug = m.slug;
    const canvas = el("canvas");
    canvas.width = canvas.height = 40;
    t.append(canvas, el("span", "", have ? m.zh : "???"));
    if (isNew(m)) t.append(el("i", "badge", "NEW"));
    t.title = have ? `${m.zh}\n${longDate(have.first)}第一次见` : "还没见它演过";
    if (have) {
      // Moves while the mouse is on it.
      t.onmouseenter = () => {
        const gif = el("img");
        gif.src = `assets/clawd/${m.slug}.gif`;
        t.append(gif);
      };
      t.onmouseleave = () => t.querySelector("img")?.remove();
    }
    t.onclick = () => choose(m, t);
    lazy.observe(t);
    return t;
  };

  const render = () => {
    const owned = list.filter((m) => seen[m.slug]);
    const fresh = owned.filter(isNew).length;
    $("have").textContent = owned.length;
    $("gallery-pct").textContent = owned.length === list.length ? "全部收集齐啦 🎉" : `${Math.floor((owned.length / list.length) * 100)}%`;
    $("progress-fill").style.width = `${(owned.length / list.length) * 100}%`;
    $("new-filter").hidden = !fresh;
    $("new-count").textContent = fresh;
    if (!fresh && filter === "new") {
      filter = "all";
      document.querySelector('[name="collect"][value="all"]').checked = true;
    }

    // Theme chips, each with how much of it is collected.
    $("themes").innerHTML = "";
    for (const [id, name] of [["", "全部"], ...new Map(list.map((m) => [m.theme, m.themeZh]))]) {
      const of = list.filter((m) => !id || m.theme === id);
      const got = of.filter((m) => seen[m.slug]).length;
      const chip = el("button", `${id === theme ? "active" : ""}${id && got === of.length ? " done" : ""}`, name);
      if (id) chip.append(el("small", "", `${got}/${of.length}`));
      chip.onclick = () => {
        theme = id;
        render();
      };
      $("themes").append(chip);
    }

    // Names of the ones not seen yet stay a secret, from the search too.
    const q = $("search").value.trim().toLowerCase();
    lazy.disconnect();
    $("grid").innerHTML = "";
    for (const m of list) {
      const have = seen[m.slug];
      if (theme && m.theme !== theme) continue;
      if ((filter === "have" && !have) || (filter === "missing" && have) || (filter === "new" && !isNew(m))) continue;
      if (q && !(have && `${m.zh} ${m.en} ${m.slug}`.toLowerCase().includes(q))) continue;
      $("grid").append(tile(m));
    }
    const empty = !$("grid").childElementCount;
    $("grid-empty").hidden = !empty;
    if (empty) {
      $("grid-empty").textContent = q ? "没找到。没见过的动画，名字还是秘密哦" : filter === "missing" ? "这些都收集齐啦 🎉" : "还没有收集到，多陪它待一会儿吧～";
    }
  };

  for (const radio of document.querySelectorAll('[name="collect"]')) {
    radio.onchange = () => {
      filter = radio.value;
      render();
    };
  }
  $("search").oninput = render;
  // What shows as new stays new until the gallery is opened the next time.
  document.querySelector('nav button[data-tab="gallery"]').addEventListener("click", () => invoke("collection_visit"), { once: true });
  // Every play on the pet, with its count; a new one is collected.
  listen("collected", (e) => {
    const { slug, first, count } = e.payload;
    const fresh = !seen[slug];
    seen[slug] = { first, count };
    // The grid is built anew only for a new one: the pet plays something every few
    // seconds, and rebuilding the cards would drop the one hovered or being clicked.
    if (fresh) return render();
    if (picked === slug) {
      $("preview-meta").textContent = `${longDate(first)}第一次见 · 在桌面上演过 ${count} 次`;
    }
  });
  render();
  const latest = list.filter((m) => seen[m.slug]).sort((a, b) => seen[b.slug].first - seen[a.slug].first)[0];
  if (latest) choose(latest);
}

// ---------------------------------------------------------------- boot

async function boot() {
  document.querySelectorAll("select").forEach(dropdown);
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
  initStatusline();
  initHotkeys();
  initAutostart();
  initAi();
  initMemory();
  initGallery();
  initRecap();
}

boot();
