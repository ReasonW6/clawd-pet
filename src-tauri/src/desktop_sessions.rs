//! Which session a Claude desktop app session was started from: a /btw fork, or a
//! session another one started. To Claude Code each is a session of its own, and no
//! hook says where it came from; the desktop app keeps that in its own record of the
//! session, `claude-code-sessions\<account>\<org>\local_<app id>.json`:
//! `cliSessionId` is the id the hooks report, `spawnedFrom.sessionId` the app id of
//! the session it came from. That format is the app's own business, so anything
//! unexpected just means no parent.

use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The records are searched again, for a session without one yet, at most this often.
const RESCAN: Duration = Duration::from_secs(5);
/// A parent's id for Claude Code changes when the user rewinds it; looked at again this often.
const PARENT_RECHECK: Duration = Duration::from_secs(30);
/// `cliSessionId` comes right after `sessionId` at the start of a record.
const HEAD: u64 = 256;
/// Past this many sessions the cache starts over.
const CACHE_MAX: usize = 1024;

#[derive(Clone)]
pub struct Parent {
    /// The id the hooks report for it.
    pub id: String,
    /// Its title in the app's sidebar.
    pub title: Option<String>,
    pub cwd: Option<String>,
}

enum Known {
    Child { parent: Parent, record: PathBuf, checked: Instant },
    TopLevel,
    Missing,
}

#[derive(Default)]
struct State {
    known: HashMap<String, Known>,
    /// Hook session id -> its record, from the last full search.
    index: HashMap<String, PathBuf>,
    scanned: Option<Instant>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

/// The session `id` (as the hooks report it) was started from, if any.
pub fn parent(id: &str) -> Option<Parent> {
    if !is_uuid(id) {
        return None;
    }
    let mut st = STATE.get_or_init(Default::default).lock().unwrap();
    let scanned_lately = st.scanned.is_some_and(|t| t.elapsed() < RESCAN);
    match st.known.get_mut(id) {
        Some(Known::Child { parent, record, checked }) => {
            if checked.elapsed() > PARENT_RECHECK {
                *checked = Instant::now();
                if let Some(now) = head_id(record) {
                    parent.id = now;
                }
            }
            return Some(parent.clone());
        }
        Some(Known::TopLevel) => return None,
        Some(Known::Missing) if scanned_lately => return None,
        _ => {}
    }
    let found = look_up(&mut st, id);
    let parent = match &found {
        Known::Child { parent, .. } => Some(parent.clone()),
        _ => None,
    };
    if st.known.len() >= CACHE_MAX {
        st.known.clear();
    }
    st.known.insert(id.to_string(), found);
    parent
}

/// The session ended.
pub fn forget(id: &str) {
    if let Some(st) = STATE.get() {
        st.lock().unwrap().known.remove(id);
    }
}

fn look_up(st: &mut State, id: &str) -> Known {
    let dirs = record_dirs();
    // A fork keeps the app's id for Claude Code too.
    let direct = dirs.iter().map(|d| d.join(format!("local_{id}.json"))).find(|p| head_id(p).as_deref() == Some(id));
    let record = match direct {
        Some(p) => p,
        None => {
            if st.scanned.is_none_or(|t| t.elapsed() >= RESCAN) {
                st.index = index(&dirs);
                st.scanned = Some(Instant::now());
            }
            match st.index.get(id) {
                Some(p) => p.clone(),
                None => return Known::Missing,
            }
        }
    };
    let Some(v) = read_json(&record) else { return Known::Missing };
    let Some(from) = v["spawnedFrom"]["sessionId"].as_str() else { return Known::TopLevel };
    let from_ok = from.strip_prefix("local_").is_some_and(is_uuid);
    let parent_record = record.with_file_name(format!("{from}.json"));
    let Some(p) = from_ok.then(|| read_json(&parent_record)).flatten() else { return Known::TopLevel };
    let text = |k: &str| p[k].as_str().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
    match text("cliSessionId") {
        Some(pid) => Known::Child {
            parent: Parent { id: pid, title: text("title"), cwd: text("cwd") },
            record: parent_record,
            checked: Instant::now(),
        },
        None => Known::TopLevel,
    }
}

/// Every record's hook session id.
fn index(dirs: &[PathBuf]) -> HashMap<String, PathBuf> {
    let mut out = HashMap::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for path in entries.flatten().map(|e| e.path()) {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if name.starts_with("local_") && name.ends_with(".json") {
                if let Some(id) = head_id(&path) {
                    out.insert(id, path);
                }
            }
        }
    }
    out
}

/// `claude-code-sessions\<account>\<org>` in the app's data folder: `Claude-Data\<package>`
/// under LocalAppData for the Store build, `%APPDATA%\Claude` otherwise.
fn record_dirs() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.extend(subdirs(&PathBuf::from(local).join("Claude-Data")));
    }
    if let Some(roaming) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(roaming).join("Claude"));
    }
    roots
        .iter()
        .flat_map(|r| subdirs(&r.join("claude-code-sessions")))
        .flat_map(|account| subdirs(&account))
        .collect()
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()
}

/// The record's `cliSessionId`, read from its first bytes only.
fn head_id(path: &Path) -> Option<String> {
    const KEY: &str = r#""cliSessionId":""#;
    let mut head = Vec::new();
    std::fs::File::open(path).ok()?.take(HEAD).read_to_end(&mut head).ok()?;
    let head = String::from_utf8_lossy(&head);
    let rest = &head[head.find(KEY)? + KEY.len()..];
    let id = &rest[..rest.find('"')?];
    is_uuid(id).then(|| id.to_string())
}

fn is_uuid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}
