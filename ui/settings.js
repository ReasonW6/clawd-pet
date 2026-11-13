const { invoke } = window.__TAURI__.core;
const { emitTo } = window.__TAURI__.event;
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

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
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
  tab.onclick = () => {
    document.querySelectorAll("nav button, main section").forEach((e) => e.classList.remove("active"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.add("active");
  };
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
  const [m, d] = config.birthday ? config.birthday.split("-") : ["", "01"];
  month.value = m;
  day.value = d;
  day.hidden = !m;
  month.onchange = day.onchange = () => {
    day.hidden = !month.value;
    config.birthday = month.value ? `${month.value}-${day.value}` : "";
    save();
  };
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
  bindFields();
  refreshOutputs();
  bindBirthday();
  renderSleepWindows();
  pathList("folders", "add-folder", () => config.sys.folders);
  initFullscreenExclude();
  initGitWatch();
  showHooks(await invoke("hooks_installed"));
  initAutostart();
  initGallery();
}

boot();
