//! Follows a session's transcript while a turn is under way, until its Stop, reading
//! only the bytes appended since, for what no hook reports:
//! - interrupts (Esc, or the Desktop app's stop button): Claude Code only records a
//!   "[Request interrupted by user…]" user message;
//! - what Claude says along the way: each text block of a reply is appended as soon
//!   as it is complete. Only its first line goes to the pet, and only while the user
//!   has that turned on;
//! - a tool call that is waiting for permission getting its result: in the Desktop
//!   app the user may have answered there, denying with a note goes on with no hook;
//!   the result's text tells a denial from a call that ran.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const MARKER: &str = "[Request interrupted by user";
/// How the result of a denied call starts: on the main thread, and in a subagent.
const DENIALS: [&str; 2] = ["The user doesn't want to proceed with this tool use", "Permission for this tool use was denied"];
/// Added to a denial's text when the call had in fact been allowed and was then stopped.
const CORRECTION: &str = "Correction to the text above";
/// How much of a transcript's end, then of its start, is searched for the title.
const TITLE_TAIL: u64 = 512 * 1024;
const TITLE_HEAD: u64 = 64 * 1024;
/// A session without a title yet is looked at again this often, on any event.
const UNTITLED_RECHECK: Duration = Duration::from_secs(10);
/// How much of a reply's first line is passed on; the bubble cuts it shorter.
const REPLY_CHARS: usize = 80;
/// A transcript with no hook event and no write for this long is let go: its session
/// may have gone without a Stop, e.g. with the Desktop app quitting.
const FORGET_AFTER: Duration = Duration::from_secs(2 * 60 * 60);

/// Pass on what Claude says (`Config::replies`).
static REPLIES: AtomicBool = AtomicBool::new(true);

pub fn show_replies(on: bool) {
    REPLIES.store(on, Ordering::SeqCst);
}

/// A transcript being followed.
struct Followed {
    /// As it was watched.
    path: PathBuf,
    session: String,
    /// Bytes already read.
    offset: u64,
    /// Results read with nothing after them yet that shows how to take them (`scan`).
    unsettled: Vec<(String, Option<&'static str>)>,
    touched: Instant,
}

/// normalised transcript path -> the transcript being followed there
type Files = Arc<Mutex<HashMap<String, Followed>>>;

struct State {
    app: AppHandle,
    files: Files,
    watcher: Mutex<RecommendedWatcher>,
}

static STATE: OnceLock<State> = OnceLock::new();
/// normalised transcript path -> (session title or None, when it was read)
static TITLES: OnceLock<Mutex<HashMap<String, (Option<String>, Instant)>>> = OnceLock::new();

/// The session's title: the last "custom-title" record in its transcript. The Desktop
/// app writes one at the start and re-appends it now and then; /rename adds one too.
/// Re-read on events that come at most once per turn; while there is none yet (a
/// session started from another gets its title a little after its first prompt),
/// every UNTITLED_RECHECK on any event.
pub fn title(p: &Value) -> Option<String> {
    let path = Path::new(p["transcript_path"].as_str()?);
    let k = key(path);
    let titles = TITLES.get_or_init(Default::default);
    let event = p["hook_event_name"].as_str().unwrap_or_default();
    if event == "SessionEnd" {
        return titles.lock().unwrap().remove(&k).and_then(|(t, _)| t);
    }
    let refresh = matches!(event, "SessionStart" | "UserPromptSubmit" | "Stop" | "PermissionRequest");
    if !refresh {
        if let Some((t, at)) = titles.lock().unwrap().get(&k) {
            if t.is_some() || at.elapsed() < UNTITLED_RECHECK {
                return t.clone();
            }
        }
    }
    let t = read_title(path);
    titles.lock().unwrap().insert(k, (t.clone(), Instant::now()));
    t
}

fn read_title(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TITLE_TAIL);
    let mut read = |from: u64, n: u64| -> Option<Vec<u8>> {
        file.seek(SeekFrom::Start(from)).ok()?;
        let mut buf = Vec::new();
        (&mut file).take(n).read_to_end(&mut buf).ok()?;
        Some(buf)
    };
    let tail = read(start, len - start)?;
    last_title(&tail).or_else(|| if start > 0 { last_title(&read(0, TITLE_HEAD)?) } else { None })
}

/// Lines cut off at either end of `buf` fail to parse and are skipped.
fn last_title(buf: &[u8]) -> Option<String> {
    String::from_utf8_lossy(buf)
        .lines()
        .rev()
        .filter(|l| l.contains("\"custom-title\""))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v["type"] == "custom-title")?["customTitle"]
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

pub fn init(app: AppHandle) {
    let files: Files = Default::default();
    let f = files.clone();
    let a = app.clone();
    let Ok(watcher) = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(e) = res else { return };
        if !matches!(e.kind, EventKind::Modify(_)) {
            return;
        }
        for path in &e.paths {
            let mut files = f.lock().unwrap();
            let Some(t) = files.get_mut(&key(path)) else { continue };
            t.touched = Instant::now();
            let found = scan(path, &t.session, &mut t.offset, &mut t.unsettled, false);
            report(&a, &t.session, found);
        }
    }) else {
        return;
    };
    let _ = STATE.set(State { app, files, watcher: Mutex::new(watcher) });
}

fn report(app: &AppHandle, session: &str, found: Found) {
    // Results the interrupt wrote are already None (`scan`); answered ones before it
    // keep what they were, so they go first. (Results read with the interrupt still to
    // come wait in `unsettled`, so none was let go as it read.)
    for (call, outcome) in &found.answered {
        crate::server::answered(call, *outcome);
    }
    if found.interrupt.is_some() {
        crate::server::interrupted(session);
    }
    if let Some((text, ts)) = found.reply {
        let _ = app.emit(
            "hook-event",
            json!({ "hook_event_name": "Reply", "session_id": session, "text": text, "timestamp": ts }),
        );
    }
    if let Some(ts) = found.interrupt {
        let _ = app.emit(
            "hook-event",
            json!({ "hook_event_name": "Interrupt", "session_id": session, "timestamp": ts }),
        );
    }
}

/// Called with every hook event.
pub fn on_hook(p: &Value) {
    let Some(st) = STATE.get() else { return };
    forget_stale(st);
    let Some(path) = p["transcript_path"].as_str().map(PathBuf::from) else { return };
    let k = key(&path);
    // A subagent's events carry the session's transcript too, but its prompt doesn't
    // start a turn of the session, and one left in the background runs on after it.
    let main = !p["agent_id"].is_string();
    match p["hook_event_name"].as_str().unwrap_or_default() {
        // Not every turn starts with a prompt: a background task finishing, or the Desktop
        // app waking a session, starts one too. A prompt reads on from there, so that a
        // marker left over from before it isn't taken for this turn's.
        ev @ ("UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PreCompact") => {
            let session = p["session_id"].as_str().unwrap_or("default").to_string();
            let restart = main && ev == "UserPromptSubmit";
            let end = || std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let fresh = {
                let mut files = st.files.lock().unwrap();
                match files.get_mut(&k) {
                    Some(t) => {
                        t.touched = Instant::now();
                        if restart {
                            t.offset = end();
                            t.unsettled.clear();
                            t.session = session;
                        }
                        false
                    }
                    None if main => {
                        let t = Followed { path: path.clone(), session, offset: end(), unsettled: Vec::new(), touched: Instant::now() };
                        files.insert(k.clone(), t);
                        true
                    }
                    None => false,
                }
            };
            // Never call into the watcher while holding `files`: its callback takes that lock.
            // A failed watch (e.g. the file doesn't exist yet) must not leave the entry
            // behind, or later events would never retry.
            if fresh && st.watcher.lock().unwrap().watch(&path, RecursiveMode::NonRecursive).is_err() {
                st.files.lock().unwrap().remove(&k);
            }
        }
        "Stop" | "StopFailure" | "SessionEnd" => {
            let removed = st.files.lock().unwrap().remove(&k);
            if let Some(mut t) = removed {
                // The reply's last words are written just before Stop, and the watcher
                // may not have reported them yet. This runs before Stop reaches the pet.
                report(&st.app, &t.session, scan(&path, &t.session, &mut t.offset, &mut t.unsettled, true));
                let _ = st.watcher.lock().unwrap().unwatch(&t.path);
            }
        }
        _ => {}
    }
}

/// Lets go of transcripts whose session went quiet without a Stop.
fn forget_stale(st: &State) {
    let stale: Vec<PathBuf> = {
        let mut files = st.files.lock().unwrap();
        let keys: Vec<String> = files.iter().filter(|(_, t)| t.touched.elapsed() > FORGET_AFTER).map(|(k, _)| k.clone()).collect();
        keys.iter().filter_map(|k| files.remove(k)).map(|t| t.path).collect()
    };
    if stale.is_empty() {
        return;
    }
    let mut watcher = st.watcher.lock().unwrap();
    for path in stale {
        let _ = watcher.unwatch(&path);
    }
}

/// The watcher may report a path with different case or separators than the hook.
fn key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

#[derive(Default)]
struct Found {
    /// The first line of the latest thing Claude said, and when.
    reply: Option<(String, String)>,
    /// When the turn was interrupted.
    interrupt: Option<String>,
    /// Calls waiting for permission that got their result, and how they were answered.
    answered: Vec<(String, Option<&'static str>)>,
}

/// Looks through the complete lines appended since `offset`.
///
/// A result only counts once what follows it shows how to take it: Claude writing
/// again keeps it as it reads; an interrupt first means the interrupt wrote it (a
/// denial without a note, or a stop while a call waited or ran), so it says nothing of
/// how the call was answered. Until then it waits in `unsettled`, across reads, since
/// the two may be written apart. `last`: the turn is over, so what waits counts as it reads.
fn scan(path: &Path, session: &str, offset: &mut u64, unsettled: &mut Vec<(String, Option<&'static str>)>, last: bool) -> Found {
    let mut found = Found::default();
    let text = read_from(path, offset).unwrap_or_default();
    let replies = REPLIES.load(Ordering::SeqCst);
    // A result names its call this way; the call itself has it as "id".
    let asking: Vec<(String, String)> = crate::server::asking(session)
        .into_iter()
        .map(|call| (format!(r#""tool_use_id":"{call}""#), call))
        .collect();
    for l in text.lines() {
        // The id may also turn up quoted in other text (a command, a file); only a
        // user message carrying the result counts. The substring is just the cheap check.
        let mut parsed: Option<Value> = None;
        for (needle, call) in &asking {
            if !l.contains(needle.as_str()) || found.answered.iter().chain(unsettled.iter()).any(|(c, _)| c == call) {
                continue;
            }
            let v = parsed.get_or_insert_with(|| serde_json::from_str(l).unwrap_or(Value::Null));
            if let Some(outcome) = answers(v, call) {
                unsettled.push((call.clone(), outcome));
            }
        }
        // Unescaped, so the record's own type and not text quoting one.
        if l.contains(r#""type":"assistant""#) {
            found.answered.append(unsettled);
        }
        let interrupt = l.contains(MARKER);
        let reply = replies && l.contains(r#""assistant""#) && l.contains(r#""text""#);
        if !interrupt && !reply {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        let ts = || v["timestamp"].as_str().unwrap_or_default().to_string();
        if interrupt && is_interrupt(&v) {
            found.interrupt = Some(ts());
            found.answered.extend(unsettled.drain(..).map(|(call, _)| (call, None)));
        } else if let Some(line) = reply.then(|| said(&v)).flatten() {
            found.reply = Some((line, ts()));
        }
    }
    if last {
        found.answered.append(unsettled);
    }
    found
}

/// In a user message with the result of tool call `call`: how the call was answered,
/// `ALLOWED` (it ran), `DENIED`, or `None` when it didn't run and wasn't denied either
/// (cancelled, expired, interrupted, skipped, or stopped after it was allowed).
fn answers(v: &Value, call: &str) -> Option<Option<&'static str>> {
    use crate::server::{ALLOWED, DENIED};
    if v["type"] != "user" && v["message"]["role"] != "user" {
        return None;
    }
    let content = v["message"]["content"].as_array()?;
    let result = content.iter().find(|b| b["type"] == "tool_result" && b["tool_use_id"] == call)?;
    let text = match &result["content"] {
        Value::String(s) => s.as_str(),
        Value::Array(items) => items.iter().find_map(|i| i["text"].as_str()).unwrap_or_default(),
        _ => "",
    };
    let text = text.trim_start();
    let denial = || DENIALS.iter().any(|d| text.starts_with(d)) && !text.contains(CORRECTION);
    // Recent versions put why a call didn't run on the record.
    if let Some(kind) = v["toolDenialKind"].as_str() {
        return Some(if kind == "user-rejected" && denial() { DENIED } else { None });
    }
    // Without it: the call ran, or an older version only says so in the text. An
    // error that isn't a denial may be a call that never ran (cancelled, expired, a
    // sibling call's error...); one that did run has its PostToolUseFailure anyway.
    if result["is_error"] != true {
        return Some(ALLOWED);
    }
    Some(if denial() { DENIED } else { None })
}

fn read_from(path: &Path, offset: &mut u64) -> Option<String> {
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
    Some(String::from_utf8_lossy(&buf[..complete]).into_owned())
}

/// The first line of text in a main-thread assistant message, without Markdown marks.
fn said(v: &Value) -> Option<String> {
    if v["type"] != "assistant" || v["isSidechain"] == true {
        return None;
    }
    let content = v["message"]["content"].as_array()?;
    let text = content.iter().rev().find(|i| i["type"] == "text")?["text"].as_str()?;
    let line = text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("```"))?;
    let line = line.trim_start_matches(['#', '>', '-', '*', ' ']).replace("**", "").replace('`', "");
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut out: String = line.chars().take(REPLY_CHARS).collect();
    if line.chars().count() > REPLY_CHARS {
        out.push('…');
    }
    Some(out)
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
