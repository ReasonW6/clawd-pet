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

const profile = () => (config.ai.profiles[provider().id] ??= { apiKey: "", baseUrl: "", model: "", reasoning: "" });

/** Settings from before providers of one's own: what was set for a template becomes one. */
function migrateCustom() {
  for (const [kind, name] of [["custom", "自定义"], ["custom-anthropic", "自定义（Anthropic）"]]) {
    const old = config.ai.profiles[kind];
    // Anything set (a key alone too) would be out of reach once the templates aren't listed.
    if (config.ai.provider !== kind && !Object.values(old ?? {}).some(Boolean)) continue;
    const mine = { id: `my-${kind}-${Date.now().toString(36)}`, name, kind };
    config.ai.customProviders.push(mine);
    if (old) config.ai.profiles[mine.id] = old;
    delete config.ai.profiles[kind];
    if (config.ai.provider === kind) config.ai.provider = mine.id;
    save();
  }
}

async function initAi() {
  providers = await invoke("ai_providers");
  migrateCustom();
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
  field("ai-key", "apiKey");
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
  $("ai-key").value = mine.apiKey;
  $("ai-key").placeholder = p.needsKey ? "必填" : "不需要就留空";
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
    list = await invoke("ai_models", { ai: config.ai, provider: provider().id });
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
  listen("collected", (e) => {
    seen[e.payload] ??= { first: Date.now(), count: 1 };
    render();
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
  initAutostart();
  initAi();
  initMemory();
  initGallery();
}

boot();
