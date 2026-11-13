//! Spots interrupts (Esc, or the Desktop app's stop button). They fire no hook:
//! Claude Code only records a "[Request interrupted by user…]" user message in the
//! session transcript. A session's transcript is watched from its UserPromptSubmit
//! until its turn ends, and only the bytes appended since are read.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

const MARKER: &str = "[Request interrupted by user";

/// normalised transcript path -> (session id, bytes already read)
type Files = Arc<Mutex<HashMap<String, (String, u64)>>>;

struct State {
    files: Files,
    watcher: Mutex<RecommendedWatcher>,
}

static STATE: OnceLock<State> = OnceLock::new();

pub fn init(app: AppHandle) {
    let files: Files = Default::default();
    let f = files.clone();
    let Ok(watcher) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(e) = res else { return };
        if !matches!(e.kind, EventKind::Modify(_)) {
            return;
        }
        for path in &e.paths {
            let mut files = f.lock().unwrap();
            let Some((session, offset)) = files.get_mut(&key(path)) else { continue };
            if let Some(ts) = scan(path, offset) {
                let _ = app.emit(
                    "hook-event",
                    json!({ "hook_event_name": "Interrupt", "session_id": session, "timestamp": ts }),
                );
            }
        }
    }) else {
        return;
    };
    let _ = STATE.set(State { files, watcher: Mutex::new(watcher) });
}

/// Called with every hook event.
pub fn on_hook(p: &Value) {
    let Some(st) = STATE.get() else { return };
    let Some(path) = p["transcript_path"].as_str().map(PathBuf::from) else { return };
    match p["hook_event_name"].as_str().unwrap_or_default() {
        "UserPromptSubmit" => {
            let end = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let session = p["session_id"].as_str().unwrap_or("default").to_string();
            let fresh = st.files.lock().unwrap().insert(key(&path), (session, end)).is_none();
            // Never call into the watcher while holding `files`: its callback takes that lock.
            // A failed watch (e.g. the file doesn't exist yet) must not leave the entry
            // behind, or later prompts would never retry.
            if fresh && st.watcher.lock().unwrap().watch(&path, RecursiveMode::NonRecursive).is_err() {
                st.files.lock().unwrap().remove(&key(&path));
            }
        }
        "Stop" | "StopFailure" | "SessionEnd" => {
            if st.files.lock().unwrap().remove(&key(&path)).is_some() {
                let _ = st.watcher.lock().unwrap().unwatch(&path);
            }
        }
        _ => {}
    }
}

/// The watcher may report a path with different case or separators than the hook.
fn key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// Reads the complete lines appended since `offset`; returns the timestamp of an
/// interrupt among them.
fn scan(path: &Path, offset: &mut u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len < *offset {
        *offset = len;
    }
    file.seek(SeekFrom::Start(*offset)).ok()?;
    let mut buf = Vec::new();
    file.take(len - *offset).read_to_end(&mut buf).ok()?;
    let complete = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    *offset += complete as u64;
    String::from_utf8_lossy(&buf[..complete])
        .lines()
        .filter(|l| l.contains(MARKER))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(is_interrupt)
        .last()
        .and_then(|v| v["timestamp"].as_str().map(str::to_string))
}

/// A main-thread user message whose text starts with the marker. The plain substring
/// also shows up elsewhere, e.g. in a tool call that greps for it.
fn is_interrupt(v: &Value) -> bool {
    if v["type"] != "user" || v["isSidechain"] == true {
        return false;
    }
    match &v["message"]["content"] {
        Value::String(s) => s.starts_with(MARKER),
        Value::Array(items) => items
            .iter()
            .any(|i| i["type"] == "text" && i["text"].as_str().is_some_and(|t| t.starts_with(MARKER))),
        _ => false,
    }
}
