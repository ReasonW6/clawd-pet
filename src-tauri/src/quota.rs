//! How much of the user's Claude plan is used up: the 5-hour window and the weekly one.
//! Two sources, either may be missing; the page puts them together (pet.js `quotaWindow`).
//!
//! - The desktop app samples the usage every 5 to 15 minutes while it runs, into
//!   `plan-usage-history.json` in its data folder: percentages only, no reset times. That
//!   format is the app's own business, so anything unexpected just means no numbers.
//!   The file is watched, not polled.
//! - Claude Code in a terminal pipes `rate_limits` (percentage and reset time) to its
//!   status line command. With the relay installed (`install`), that command passes its
//!   input on to `/clawd-pet/status` and then runs the status line that was there
//!   before. The desktop app and the IDE extensions run Claude Code without a terminal
//!   UI, so they never run a status line.

use crate::hooks;
use crate::server::PORT;
use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const DESKTOP_FILE: &str = "plan-usage-history.json";
/// Where the terminal's last numbers are kept, so its reset times outlive a restart.
const CLI_FILE: &str = "quota.json";
/// The relay script, and the status line it took the place of, in the pet's folder.
const RELAY: &str = "statusline.sh";
const ORIGINAL: &str = "statusline-original.json";
/// The same numbers again are written only once they are this much newer than the ones
/// written (ms): a restart would otherwise take numbers just confirmed for stale ones.
const RESAVE_MS: i64 = 10 * 60 * 1000;

/// One window from the terminal: percentage used, and when it starts over (epoch s).
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
pub struct Window {
    pub pct: f64,
    pub resets: Option<i64>,
}

/// What the terminal said last, and when (epoch ms).
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Cli {
    pub t: i64,
    pub five: Option<Window>,
    pub week: Option<Window>,
}

/// The desktop app's last sample (epoch ms; percentages).
#[derive(Clone, PartialEq, Debug, Serialize)]
pub struct Desktop {
    pub t: i64,
    pub five: Option<f64>,
    pub week: Option<f64>,
}

#[derive(Clone, Default, Serialize)]
pub struct Quota {
    pub desktop: Option<Desktop>,
    pub cli: Option<Cli>,
    /// When the terminal's numbers in quota.json are from.
    #[serde(skip)]
    saved_t: i64,
}

struct State {
    app: AppHandle,
    dir: PathBuf,
    quota: Mutex<Quota>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    /// The folders watched: the desktop app's data folders, and where a new one would show.
    watched: Mutex<HashSet<PathBuf>>,
}

static STATE: OnceLock<State> = OnceLock::new();

/// Loads what is known and starts watching the desktop app's file. `dir` is the pet's
/// own folder (`~/.clawd-pet`).
pub fn init(app: AppHandle, dir: PathBuf) {
    let cli: Option<Cli> = std::fs::read(dir.join(CLI_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let saved_t = cli.as_ref().map_or(0, |c| c.t);
    let quota = Quota { desktop: read_desktop(), cli, saved_t };
    let watcher = notify::recommended_watcher(|res: notify::Result<notify::Event>| {
        let Ok(e) = res else { return };
        if e.paths.iter().any(|p| p.file_name().is_some_and(|n| n == DESKTOP_FILE)) {
            on_desktop();
        } else if appeared(&e.kind) && e.paths.iter().any(|p| is_new_folder(p)) {
            // A data folder showed up (the app installed, or run the first time since the
            // pet started): watched from now on. Not from the watcher's own thread, and
            // not by asking `watched` here: `rewatch` holds it while it waits on that thread.
            // Only made or renamed into place: a folder that is there already reports a
            // change for every file its app writes into it.
            std::thread::spawn(|| {
                rewatch();
                on_desktop();
            });
        }
    })
    .ok();
    let state = State { app, dir, quota: Mutex::new(quota), watcher: Mutex::new(watcher), watched: Mutex::default() };
    if STATE.set(state).is_ok() {
        rewatch();
    }
}

/// `%LOCALAPPDATA%\Claude-Data` (the Store build's data folders are in there) and
/// `%APPDATA%`, where the other build's `Claude` folder is.
fn parents() -> (Option<PathBuf>, Option<PathBuf>) {
    let local = std::env::var_os("LOCALAPPDATA").map(|l| PathBuf::from(l).join("Claude-Data"));
    (local, std::env::var_os("APPDATA").map(PathBuf::from))
}

/// What to watch now (not recursively): each data folder there is, and where a new one
/// would appear. Before `Claude-Data` itself is there, LocalAppData, for it to appear in.
fn watch_list() -> HashSet<PathBuf> {
    let mut list: HashSet<PathBuf> = desktop_roots().into_iter().filter(|r| r.is_dir()).collect();
    let (data, roaming) = parents();
    if let Some(data) = data {
        match data.parent() {
            Some(local) if !data.is_dir() => list.insert(local.to_path_buf()),
            _ => list.insert(data),
        };
    }
    list.extend(roaming);
    list
}

/// Something made or renamed into place.
fn appeared(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_)))
}

/// Whether `p` is a folder the desktop app's data may go in: `Claude-Data`, one in
/// there, or `%APPDATA%\Claude`.
fn is_new_folder(p: &Path) -> bool {
    let (data, roaming) = parents();
    let data = data.as_deref();
    (Some(p) == data || p.parent() == data || roaming.is_some_and(|r| p == r.join("Claude"))) && p.is_dir()
}

/// Watches what `watch_list` says, and no longer what it doesn't.
fn rewatch() {
    let Some(st) = STATE.get() else { return };
    let mut watcher = st.watcher.lock().unwrap();
    let Some(w) = watcher.as_mut() else { return };
    let mut watched = st.watched.lock().unwrap();
    let want = watch_list();
    for gone in watched.difference(&want) {
        let _ = w.unwatch(gone);
    }
    let mut now = HashSet::new();
    for p in want {
        if watched.contains(&p) || w.watch(&p, RecursiveMode::NonRecursive).is_ok() {
            now.insert(p);
        }
    }
    *watched = now;
}

pub fn get() -> Quota {
    STATE.get().map(|s| s.quota.lock().unwrap().clone()).unwrap_or_default()
}

fn on_desktop() {
    let Some(st) = STATE.get() else { return };
    let desktop = read_desktop();
    let mut q = st.quota.lock().unwrap();
    if desktop.is_none() || q.desktop == desktop {
        return;
    }
    q.desktop = desktop;
    let _ = st.app.emit_to("main", "quota", &*q);
}

/// The status line's input, passed on by the relay. Only `rate_limits` is looked at.
pub fn reported(input: &Value) {
    let Some(st) = STATE.get() else { return };
    let Some(cli) = from_status(input, now_ms()) else { return };
    let mut q = st.quota.lock().unwrap();
    // The same numbers again (the status line runs after every message) are written only
    // now and then, for when they were last confirmed to outlive a restart.
    let same = q.cli.as_ref().is_some_and(|old| old.five == cli.five && old.week == cli.week);
    if !same || cli.t - q.saved_t >= RESAVE_MS {
        if save(&st.dir.join(CLI_FILE), &cli) {
            q.saved_t = cli.t;
        }
    }
    q.cli = Some(cli);
    let _ = st.app.emit_to("main", "quota", &*q);
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Writes `cli` to `path` whole or not at all; gives back whether it went through.
fn save(path: &Path, cli: &Cli) -> bool {
    let tmp = path.with_extension("json.tmp");
    let Ok(s) = serde_json::to_string(cli) else { return false };
    std::fs::write(&tmp, s).is_ok() && std::fs::rename(&tmp, path).is_ok()
}

/// `rate_limits` from Claude Code's status line input. None when it has none (before the
/// session's first reply, or not on a Pro / Max plan): what is known stays.
fn from_status(v: &Value, t: i64) -> Option<Cli> {
    let limits = v.get("rate_limits")?;
    let window = |key: &str| {
        let w = limits.get(key)?;
        let pct = w.get("used_percentage")?.as_f64()?.clamp(0.0, 100.0);
        let resets = w.get("resets_at").and_then(Value::as_f64).map(|s| s as i64);
        Some(Window { pct, resets })
    };
    let (five, week) = (window("five_hour"), window("seven_day"));
    (five.is_some() || week.is_some()).then_some(Cli { t, five, week })
}

/// The desktop app's data folder: `Claude-Data\<package>` under LocalAppData for the
/// Store build, `%APPDATA%\Claude` otherwise (as in desktop_sessions.rs).
fn desktop_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        if let Ok(entries) = std::fs::read_dir(PathBuf::from(local).join("Claude-Data")) {
            roots.extend(entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()));
        }
    }
    if let Some(roaming) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(roaming).join("Claude"));
    }
    roots
}

/// The newest sample of any install.
fn read_desktop() -> Option<Desktop> {
    desktop_roots()
        .iter()
        .filter_map(|r| std::fs::read_to_string(r.join(DESKTOP_FILE)).ok())
        .filter_map(|s| last_sample(&s))
        .max_by_key(|d| d.t)
}

/// `{"version":2,"samples":[{"t":<ms>,"org":..,"u":{"fh":<5-hour %>,"sd":<weekly %>,..}}]}`
fn last_sample(text: &str) -> Option<Desktop> {
    let v: Value = serde_json::from_str(text).ok()?;
    v.get("samples")?.as_array()?.iter().rev().find_map(|s| {
        let t = s.get("t")?.as_f64()? as i64;
        let pct = |k: &str| s.get("u")?.get(k)?.as_f64().map(|p| p.clamp(0.0, 100.0));
        let (five, week) = (pct("fh"), pct("sd"));
        (five.is_some() || week.is_some()).then_some(Desktop { t, five, week })
    })
}

// ---------------------------------------------------------------- the status line relay

fn relay_path() -> Option<PathBuf> {
    STATE.get().map(|s| s.dir.join(RELAY))
}

fn is_ours(status_line: &Value) -> bool {
    status_line
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|c| c.contains(&format!(".clawd-pet/{RELAY}")))
}

pub fn is_installed() -> bool {
    hooks::read_settings().is_ok_and(|v| is_ours(&v["statusLine"]))
}

/// Claude Code runs the status line in Git Bash when there is one, in PowerShell
/// otherwise. The relay is a bash script, so it needs Git Bash.
fn git_bash() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").map(PathBuf::from) {
        return p.is_file().then_some(p);
    }
    let from_path = std::env::var_os("PATH").into_iter().flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).find_map(|dir| {
        // `<git>\cmd\git.exe` or `<git>\bin\git.exe`; bash is `<git>\bin\bash.exe`.
        dir.join("git.exe").is_file().then(|| dir.parent().map(|g| g.join("bin").join("bash.exe")))?
    });
    let program_files = ["ProgramFiles", "ProgramW6432", "LOCALAPPDATA"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|d| {
            let d = PathBuf::from(d);
            if d.ends_with("Local") { d.join("Programs").join("Git") } else { d.join("Git") }
        })
        .map(|g| g.join("bin").join("bash.exe"));
    from_path.into_iter().chain(program_files).find(|p| p.is_file())
}

/// Single-quoted for bash.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The relay: passes its input to the pet in the background, then runs the status line
/// that was there before with the same input, so the terminal looks as it did. In the
/// background because on Windows a connection to a port nobody listens on takes about
/// 2 s to be refused; the status line doesn't wait for it. Builtins otherwise: bash's
/// own `/dev/tcp` rather than curl, and a here-string rather than a pipe, as every
/// process started costs time in Git Bash.
fn relay_script(original: &str) -> String {
    format!(
        r#"#!/usr/bin/env bash
# Written by Clawd Pet for its Claude quota display. It passes Claude Code's status line
# input on to the pet, then shows the status line that was set up before. Turning the
# setting off puts that one back and removes this file.
IFS= read -r -d '' input
(
  LC_ALL=C
  exec 3<>/dev/tcp/127.0.0.1/{PORT} || exit
  printf 'POST /clawd-pet/status HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s' "${{#input}}" "$input" >&3
) >/dev/null 2>&1 &
cmd={}
[ -n "$cmd" ] && eval "$cmd" <<<"$input"
"#,
        sh_quote(original)
    )
}

/// The status line command to put in the settings: `bash '<relay>'`, in the path form
/// bash takes.
fn relay_command(relay: &Path) -> String {
    format!("bash {}", sh_quote(&relay.to_string_lossy().replace('\\', "/")))
}

pub fn install() -> Result<(), String> {
    let relay = relay_path().ok_or("还没准备好")?;
    if git_bash().is_none() {
        return Err("没找到 Git Bash：终端版 Claude Code 没有 Git Bash 时用 PowerShell 跑状态栏，中继脚本跑不了".into());
    }
    let _lock = hooks::lock_settings();
    let mut v = hooks::read_settings()?;
    let root = v.as_object_mut().ok_or("settings.json 不是 JSON 对象")?;
    let saved = relay.with_file_name(ORIGINAL);
    // Already ours: what was there before ours is what we saved then.
    let original = match root.get("statusLine") {
        Some(s) if is_ours(s) => std::fs::read(&saved).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null),
        Some(s) => s.clone(),
        None => Value::Null,
    };
    let command = original.get("command").and_then(Value::as_str).unwrap_or_default();
    if let Some(dir) = relay.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&relay, relay_script(command)).map_err(|e| format!("写入中继脚本失败：{e}"))?;
    std::fs::write(&saved, serde_json::to_string_pretty(&original).unwrap_or_default())
        .map_err(|e| format!("保存原来的状态栏失败：{e}"))?;
    // Its padding, refresh interval and so on stay.
    let mut ours = match original {
        Value::Object(o) => Value::Object(o),
        _ => json!({}),
    };
    ours["type"] = json!("command");
    ours["command"] = json!(relay_command(&relay));
    root.insert("statusLine".into(), ours);
    hooks::write_settings(&v)
}

pub fn uninstall() -> Result<(), String> {
    let relay = relay_path().ok_or("还没准备好")?;
    let saved = relay.with_file_name(ORIGINAL);
    let _lock = hooks::lock_settings();
    let mut v = hooks::read_settings()?;
    if let Some(root) = v.as_object_mut() {
        // Someone else's status line since: theirs stays.
        if root.get("statusLine").is_some_and(is_ours) {
            let original = std::fs::read(&saved).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
            match original {
                Some(o) if !o.is_null() => root.insert("statusLine".into(), o),
                _ => root.remove("statusLine"),
            };
            hooks::write_settings(&v)?;
        }
    }
    let _ = std::fs::remove_file(&relay);
    let _ = std::fs::remove_file(&saved);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rate_limits() {
        let v = json!({ "model": {}, "rate_limits": {
            "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
            "seven_day": { "used_percentage": 141.2, "resets_at": 1738857600 }
        }});
        let cli = from_status(&v, 7).unwrap();
        assert_eq!(cli.t, 7);
        assert_eq!(cli.five, Some(Window { pct: 23.5, resets: Some(1738425600) }));
        assert_eq!(cli.week, Some(Window { pct: 100.0, resets: Some(1738857600) }));
    }

    #[test]
    fn a_window_may_be_missing() {
        let v = json!({ "rate_limits": { "seven_day": { "used_percentage": 41 } } });
        let cli = from_status(&v, 0).unwrap();
        assert_eq!(cli.five, None);
        assert_eq!(cli.week, Some(Window { pct: 41.0, resets: None }));
        assert_eq!(from_status(&json!({ "rate_limits": {} }), 0), None);
        assert_eq!(from_status(&json!({ "model": {} }), 0), None);
    }

    #[test]
    fn reads_the_desktop_apps_last_sample() {
        let text = r#"{"version":2,"samples":[
            {"t":1000,"org":"a","u":{"fh":5,"sd":96}},
            {"t":2000,"org":"a","u":{"fh":18,"sd":41,"xu":3}},
            {"t":3000,"org":"a","u":{"xu":4}}]}"#;
        assert_eq!(last_sample(text), Some(Desktop { t: 2000, five: Some(18.0), week: Some(41.0) }));
        assert_eq!(last_sample(r#"{"version":2,"samples":[]}"#), None);
        assert_eq!(last_sample("not json"), None);
    }

    #[test]
    fn quotes_for_bash() {
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(relay_command(Path::new(r"C:\Users\A B\.clawd-pet\statusline.sh")), "bash 'C:/Users/A B/.clawd-pet/statusline.sh'");
        assert!(is_ours(&json!({ "command": relay_command(Path::new(r"C:\u\.clawd-pet\statusline.sh")) })));
        assert!(!is_ours(&json!({ "command": "bash ~/.claude/statusline.sh" })));
    }
}
