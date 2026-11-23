//! Minimal local HTTP server that receives Claude Code HTTP hooks.
//!
//! - `POST /clawd-pet/event`      state events, answered immediately
//! - `POST /clawd-pet/permission` PermissionRequest; the connection is held until
//!   the user answers in the bubble, or answers in Claude Code itself instead. The
//!   terminal closes the connection then; the Desktop app leaves the hook running, so
//!   there it shows in what follows (see `Shared::observe`, `answered` and `ShellRuns`).
//!
//! Hand-rolled on std so we can watch the socket for that disconnect.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const PORT: u16 = 23490;
const MAX_BODY: usize = 16 * 1024 * 1024;
/// Hook timeout is 600s; give up a little earlier so Claude Code gets a clean reply.
const PERMISSION_MAX_WAIT: Duration = Duration::from_secs(590);
/// How many tool calls not yet claimed by a permission request are remembered.
const CALLS_KEPT: usize = 64;
/// Tools that run a shell command, each run with an output file of its own (`ShellRuns`).
const SHELL_TOOLS: &[&str] = &["Bash", "PowerShell"];
/// Tools whose runs also make such a file. A held request for one of these makes a new
/// file ambiguous for a held shell request of the same session.
const OUTPUT_TOOLS: &[&str] = &["Bash", "PowerShell", "Monitor"];
/// Sessions whose stirs are remembered at most; past it, those with no held request go.
const STIRS_KEPT: usize = 512;
/// Calls that only wait for a subagent. Its own calls have their PreToolUse, which
/// `ShellRuns` counts, so they don't need to hold back the early release.
const SUBAGENT_TOOLS: &[&str] = &["Agent", "Task"];

/// How a held request was answered in Claude Code itself, when that shows.
pub const ALLOWED: Option<&str> = Some("allow");
pub const DENIED: Option<&str> = Some("deny");

/// A tool call from its PreToolUse, until a permission request claims it or it ends.
struct Call {
    id: String,
    session: String,
    agent: Option<String>,
    tool: String,
    input: Value,
    /// `Shared::stirred` for its session, counting this call.
    stir: u64,
    /// Its permission request was let go while the call may still run or wait in
    /// Claude Code: kept only so that `alone` sees it under way, never claimed again.
    let_go: bool,
}

/// How a held request ended.
enum Answer {
    /// From the bubble: the raw JSON response for Claude Code (empty: no decision).
    Bubble(String),
    /// Answered in Claude Code itself: `ALLOWED`, `DENIED`, or `None` when that doesn't show.
    Elsewhere(Option<&'static str>),
}

/// A permission request whose connection is being held.
struct Pending {
    tx: mpsc::Sender<Answer>,
    session: String,
    /// The subagent asking, if it isn't the main thread.
    agent: Option<String>,
    tool: String,
    /// The `tool_use_id` of the call asking: PermissionRequest doesn't carry it, the
    /// PreToolUse just before does.
    call: Option<String>,
}

#[derive(Default)]
pub struct Shared {
    pub bubbles: AtomicBool,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    /// Oldest first.
    calls: Mutex<VecDeque<Call>>,
    /// session id -> when something last happened in it that can make a shell output
    /// file: a call started (PreToolUse), or a held request for a tool that makes one
    /// was let go, which it may then run. Tells `ShellRuns` whether such a thing
    /// happened since it last looked, even one that was over before the next look.
    /// Values come from `last_stir`, so they only grow, also across a session's entry
    /// being dropped and made again.
    stirs: Mutex<HashMap<String, u64>>,
    last_stir: AtomicU64,
}

/// For transcript.rs, which sees what no hook reports.
static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();

impl Shared {
    /// Answer a held permission request. `body` is the raw JSON response for Claude Code
    /// (empty string = no decision).
    pub fn resolve(&self, id: u64, body: String) -> bool {
        let denied = serde_json::from_str::<Value>(&body)
            .is_ok_and(|v| v.pointer("/hookSpecificOutput/decision/behavior").and_then(Value::as_str) == Some("deny"));
        match self.take(id, !denied) {
            Some(p) => p.tx.send(Answer::Bubble(body)).is_ok(),
            None => false,
        }
    }

    /// Takes held request `id` off the list. `going`: its call may run, or still wait
    /// in Claude Code, from now on (it wasn't denied, and nothing showed it ended).
    fn take(&self, id: u64, going: bool) -> Option<Pending> {
        let mut pending = self.pending.lock().unwrap();
        let p = pending.remove(&id)?;
        self.let_go(&p, going);
        Some(p)
    }

    /// For a request just taken off the list: once a request for a tool that makes an
    /// output file isn't held any more, a new file may be its run. Called with
    /// `pending` locked, so that no look at the files sees it gone and not yet stirred
    /// or not yet under way. `going`: its call stays under way for `alone` until it
    /// ends (PostToolUse, its thread's turn over, an interrupt), since its file may
    /// come at any time; a call that wasn't claimed, until its thread's turn is over.
    fn let_go(&self, p: &Pending, going: bool) {
        if !OUTPUT_TOOLS.contains(&p.tool.as_str()) {
            return;
        }
        self.stir(&p.session, false);
        if going {
            let id = p.call.clone().unwrap_or_else(|| format!("let-go-{}", self.last_stir.load(Ordering::SeqCst)));
            let call = Call { id, session: p.session.clone(), agent: p.agent.clone(), tool: p.tool.clone(), input: Value::Null, stir: 0, let_go: true };
            self.remember(&mut self.calls.lock().unwrap(), call);
        }
    }

    /// Adds a call; past `CALLS_KEPT`, the oldest one not let go is forgotten first.
    fn remember(&self, calls: &mut VecDeque<Call>, call: Call) {
        if calls.len() >= CALLS_KEPT {
            let i = calls.iter().position(|c| !c.let_go).unwrap_or(0);
            calls.remove(i);
        }
        calls.push_back(call);
    }

    /// Lets go of the held requests `stale` picks, as answered elsewhere with `outcome`.
    fn release(&self, outcome: Option<&'static str>, stale: impl Fn(&Pending) -> bool) {
        self.pending.lock().unwrap().retain(|_, p| {
            let drop = stale(p);
            if drop {
                // Released by what showed the call ended, or its thread's turn did.
                self.let_go(p, false);
                let _ = p.tx.send(Answer::Elsewhere(outcome));
            }
            !drop
        });
    }

    /// Notes that something happened in the session that can make an output file;
    /// returns its mark. Session ids that aren't UUID-like aren't kept. `trim`: may drop
    /// other sessions' entries when there are too many, which looks at `pending`, so
    /// never with it locked.
    fn stir(&self, session: &str, trim: bool) -> u64 {
        let mark = self.last_stir.fetch_add(1, Ordering::SeqCst) + 1;
        if !is_session_id(session) {
            return mark;
        }
        let mut stirs = self.stirs.lock().unwrap();
        if trim && stirs.len() >= STIRS_KEPT && !stirs.contains_key(session) {
            // `let_go` takes the locks the other way round.
            drop(stirs);
            let held: HashSet<String> = self.pending.lock().unwrap().values().map(|p| p.session.clone()).collect();
            stirs = self.stirs.lock().unwrap();
            stirs.retain(|k, _| held.contains(k));
        }
        stirs.insert(session.to_string(), mark);
        mark
    }

    /// The session's last stir, or 0.
    fn stirred(&self, session: &str) -> u64 {
        self.stirs.lock().unwrap().get(session).copied().unwrap_or(0)
    }

    /// Forgets the session's stirs when it has no held request, which may still be
    /// looking at them.
    fn forget_stirs(&self, session: &str) {
        let held = self.pending.lock().unwrap().values().any(|p| p.session == session);
        if !held {
            self.stirs.lock().unwrap().remove(session);
        }
    }

    /// Whether a shell command that just started in the session of held request `id`
    /// can only be its own: no other request of the session for a tool that makes an
    /// output file is held, and no other call of the session is under way (calls that
    /// never ended count too, until their thread's turn is over; a call that only waits
    /// for a subagent doesn't). That nothing else stirred since is `ShellRuns`' part.
    fn alone(&self, id: u64) -> bool {
        let session = {
            let pending = self.pending.lock().unwrap();
            let Some(me) = pending.get(&id) else { return false };
            let output = |p: &Pending| OUTPUT_TOOLS.contains(&p.tool.as_str());
            if pending.iter().any(|(&k, p)| k != id && p.session == me.session && output(p)) {
                return false;
            }
            me.session.clone()
        };
        !self.calls.lock().unwrap().iter().any(|c| c.session == session && !SUBAGENT_TOOLS.contains(&c.tool.as_str()))
    }

    /// Keeps track of tool calls, and lets go of the requests an event shows were
    /// answered in Claude Code itself: the Desktop app asks there at the same time as
    /// the hook runs, and leaves the hook running when the user answers there.
    /// Called before the event is acknowledged, so Claude Code can't move on to its
    /// next permission request before this one is accounted for.
    fn observe(&self, e: &Value) {
        let session = e["session_id"].as_str().unwrap_or_default();
        let agent = e["agent_id"].as_str();
        let call = e["tool_use_id"].as_str();
        match e["hook_event_name"].as_str().unwrap_or_default() {
            "PreToolUse" => {
                let stir = self.stir(session, true);
                let Some(id) = call else { return };
                let call = Call {
                    id: id.to_string(),
                    session: session.to_string(),
                    agent: agent.map(str::to_string),
                    tool: e["tool_name"].as_str().unwrap_or_default().to_string(),
                    input: e["tool_input"].clone(),
                    stir,
                    let_go: false,
                };
                self.remember(&mut self.calls.lock().unwrap(), call);
            }
            // The tool ran, so it was allowed.
            "PostToolUse" | "PostToolUseFailure" => {
                let Some(id) = call else { return };
                // Requests first, then calls: a request being let go as this comes puts
                // its call back (`let_go`) with `pending` locked, so either order of the
                // two leaves no call behind.
                self.release(ALLOWED, |p| p.call.as_deref() == Some(id));
                self.calls.lock().unwrap().retain(|c| c.id != id);
            }
            // The turn of that thread is over: it ended, or a new prompt ended it.
            "Stop" | "StopFailure" | "SubagentStop" | "UserPromptSubmit" => {
                self.release(None, |p| p.session == session && p.agent.as_deref() == agent);
                self.calls.lock().unwrap().retain(|c| !(c.session == session && c.agent.as_deref() == agent));
                if agent.is_none() {
                    self.forget_stirs(session);
                }
            }
            "SessionEnd" => {
                self.release(None, |p| p.session == session);
                self.calls.lock().unwrap().retain(|c| c.session != session);
                self.forget_stirs(session);
            }
            _ => {}
        }
    }

    /// The call a permission request is for: the earliest unclaimed one of the same
    /// thread, tool and input (identical calls in parallel ask in the order they were
    /// made); or, if a hook changed the input on the way, the only unclaimed one of that
    /// thread and tool. With the call's id, its session's stir as of the call.
    fn claim(&self, p: &Value) -> Option<(String, u64)> {
        let (session, agent, tool) = (p["session_id"].as_str()?, p["agent_id"].as_str(), p["tool_name"].as_str()?);
        let mut calls = self.calls.lock().unwrap();
        let ours = |c: &Call| !c.let_go && c.session == session && c.agent.as_deref() == agent && c.tool == tool;
        let i = calls.iter().position(|c| ours(c) && c.input == p["tool_input"]).or_else(|| {
            let mut same = calls.iter().enumerate().filter(|(_, c)| ours(c)).map(|(i, _)| i);
            match (same.next(), same.next()) {
                (Some(i), None) => Some(i),
                _ => None,
            }
        })?;
        calls.remove(i).map(|c| (c.id, c.stir))
    }
}

/// From the session's transcript: the calls still waiting for permission in `session`.
pub fn asking(session: &str) -> Vec<String> {
    let Some(shared) = SHARED.get() else { return Vec::new() };
    let pending = shared.pending.lock().unwrap();
    pending.values().filter(|p| p.session == session).filter_map(|p| p.call.clone()).collect()
}

/// From the session's transcript: the call got its result, so it was answered:
/// `DENIED`, `ALLOWED` and run, or `None` when the result doesn't show which (the call
/// was cancelled, or ended without running). Denying with a note in the Desktop app
/// lets the turn go on with no hook for it.
pub fn answered(call: &str, outcome: Option<&'static str>) {
    if let Some(shared) = SHARED.get() {
        shared.release(outcome, |p| p.call.as_deref() == Some(call));
    }
}

/// From the session's transcript: the main thread's turn was interrupted. Subagents'
/// requests go too: they stop with it, and how they were answered shows in their own
/// transcripts, which aren't watched. So do the main thread's calls: those that were
/// running stopped, and those that never ran won't end. A background subagent's may
/// outlive the turn; they end with their PostToolUse or its SubagentStop.
pub fn interrupted(session: &str) {
    if let Some(shared) = SHARED.get() {
        shared.release(None, |p| p.session == session);
        shared.calls.lock().unwrap().retain(|c| !(c.session == session && c.agent.is_none()));
    }
}

/// Each shell command Claude Code runs gets an output file of its own as it starts,
/// `b<id>.output` in `<temp>\claude\<hash>\<session id>\tasks`. In the Desktop app a
/// command allowed there starts while the hook is still held, and its PostToolUse only
/// comes once it is done, which for a long one is minutes later; the new file shows
/// at once that it started. This is Claude Code's own layout: where it isn't found,
/// PostToolUse still settles the request.
///
/// Other threads of the session (and subagents, whose files go into the session's
/// folder too) make such files as well, and a background command or Monitor keeps its
/// file after returning at once. So a new file only counts while nothing else that can
/// make one has happened in the session (`Shared::stirred`) since a moment when every
/// such thing before it was over, and so had made its file already.
struct ShellRuns {
    session: String,
    dirs: Vec<PathBuf>,
    seen: HashSet<OsString>,
    looked: Instant,
    /// The session's stir as of the last moment nothing else was under way.
    base: u64,
}

impl ShellRuns {
    /// `stir`: as of the request's own PreToolUse, so that a call started between that
    /// and the request counts as another; or now, if that call wasn't found. Only taken
    /// when nothing else is under way now (as `started` moves it); otherwise something
    /// earlier may make its file after the look below, and no file counts until a look
    /// when the session is quiet sets the base. `id`: the held request, already listed.
    fn new(session: &str, shared: &Shared, stir: Option<u64>, id: u64) -> Self {
        let base = if shared.alone(id) { stir.unwrap_or_else(|| shared.stirred(session)) } else { u64::MAX };
        let mut runs = ShellRuns { session: session.to_string(), dirs: Vec::new(), seen: HashSet::new(), looked: Instant::now(), base };
        runs.find();
        runs.seen = runs.outputs();
        runs
    }

    fn find(&mut self) {
        self.looked = Instant::now();
        // A session id is a UUID; anything else isn't looked for on disk.
        if !is_session_id(&self.session) {
            return;
        }
        let Ok(hashes) = std::fs::read_dir(std::env::temp_dir().join("claude")) else { return };
        self.dirs = hashes.flatten().map(|h| h.path().join(&self.session).join("tasks")).filter(|d| d.is_dir()).collect();
    }

    fn outputs(&self) -> HashSet<OsString> {
        let shell = |n: &OsString| n.to_str().is_some_and(|n| n.starts_with('b') && n.ends_with(".output"));
        // (A session id is checked in `find`, before any folder is listed.)
        self.dirs
            .iter()
            .filter_map(|d| std::fs::read_dir(d).ok())
            .flat_map(|files| files.flatten().map(|f| f.file_name()))
            .filter(shell)
            .collect()
    }

    /// Whether a command of the session started since the last look, with nothing else
    /// that can make an output file happening in the session meanwhile. `id`: the held
    /// request this is for.
    fn started(&mut self, shared: &Shared, id: u64) -> bool {
        if self.dirs.is_empty() {
            // The session's first command makes the folder.
            if self.looked.elapsed() < Duration::from_secs(1) {
                return false;
            }
            self.find();
        }
        let before = shared.stirred(&self.session);
        // With nothing else under way or held now, all that `before` counts is over and
        // has made its file, which the look below lists; so later files can be compared
        // with `before`. Otherwise something counted may make its file later, and the
        // base stays where it was.
        let quiet = shared.alone(id);
        let now = self.outputs();
        // Read after the look: any file listed was made by something counted by now.
        let after = shared.stirred(&self.session);
        let new = now.iter().any(|n| !self.seen.contains(n));
        let ours = new && after == self.base;
        self.seen.extend(now);
        if quiet {
            self.base = before;
        }
        ours
    }
}

/// A session id as Claude Code makes them (a UUID, 8-4-4-4-12 hex digits), not just
/// anything an event says.
fn is_session_id(s: &str) -> bool {
    s.len() == 36 && s.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

pub fn bind() -> io::Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", PORT))
}

pub fn serve(listener: TcpListener, app: AppHandle, shared: Arc<Shared>) {
    let _ = SHARED.set(shared.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let shared = shared.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, &app, &shared);
            });
        }
    });
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn bad(msg: &str) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, msg.to_string())
}

fn read_request(stream: &TcpStream) -> io::Result<Request> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut r = BufReader::new(stream);
    let mut line = String::new();
    r.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();

    let mut headers = HashMap::new();
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 || line.trim_end().is_empty() {
            break;
        }
        if let Some((k, v)) = line.trim_end().split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let mut body = Vec::new();
    if let Some(len) = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()) {
        if len > MAX_BODY {
            return Err(bad("body too large"));
        }
        body.resize(len, 0);
        r.read_exact(&mut body)?;
    } else if headers
        .get("transfer-encoding")
        .is_some_and(|v| v.eq_ignore_ascii_case("chunked"))
    {
        loop {
            line.clear();
            r.read_line(&mut line)?;
            let size_hex = line.trim().split(';').next().unwrap_or("0");
            let size = usize::from_str_radix(size_hex, 16).map_err(|_| bad("bad chunk"))?;
            if size == 0 {
                // Skip optional trailers.
                loop {
                    line.clear();
                    if r.read_line(&mut line)? == 0 || line.trim_end().is_empty() {
                        break;
                    }
                }
                break;
            }
            if body.len() + size > MAX_BODY {
                return Err(bad("body too large"));
            }
            let start = body.len();
            body.resize(start + size, 0);
            r.read_exact(&mut body[start..])?;
            line.clear();
            r.read_line(&mut line)?; // CRLF after chunk
        }
    }
    Ok(Request { method, path, headers, body })
}

fn respond(stream: &TcpStream, code: u16, body: &str) -> io::Result<()> {
    let reason = if code == 200 { "OK" } else { "Not Found" };
    let mut w = stream;
    write!(
        w,
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    w.flush()
}

fn handle(stream: TcpStream, app: &AppHandle, shared: &Shared) -> io::Result<()> {
    let req = read_request(&stream)?;
    let entry = req.headers.get("x-clawd-entry").cloned().unwrap_or_default();
    let body = || serde_json::from_slice::<Value>(&req.body).ok().filter(Value::is_object);

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/clawd-pet/ping") => respond(&stream, 200, r#"{"app":"clawd-pet"}"#),
        ("POST", "/clawd-pet/event") => {
            let v = body();
            if let Some(v) = &v {
                // First: at a turn's end the transcript is read one last time, and how
                // the requests it answers were answered beats the turn's end letting
                // go of them all.
                crate::transcript::on_hook(v);
                shared.observe(v);
            }
            respond(&stream, 200, "")?;
            if let Some(v) = v.map(|v| enrich(v, &entry)) {
                if v["hook_event_name"] == "SessionEnd" {
                    crate::desktop_sessions::forget(v["session_id"].as_str().unwrap_or_default());
                }
                emit_hook(app, v);
            }
            Ok(())
        }
        ("POST", "/clawd-pet/permission") => match body() {
            Some(v) => permission(stream, app, shared, enrich(v, &entry)),
            None => respond(&stream, 200, ""),
        },
        _ => respond(&stream, 404, ""),
    }
}

/// Adds what the pet wants to know besides the hook's own fields.
fn enrich(mut v: Value, entry: &str) -> Value {
    let title = crate::transcript::title(&v);
    let parent = match entry {
        "claude-desktop" => v["session_id"].as_str().and_then(crate::desktop_sessions::parent),
        _ => None,
    };
    let Some(o) = v.as_object_mut() else { return v };
    o.remove("tool_response"); // can be huge and the pet doesn't need it
    o.insert("_entry".into(), Value::String(entry.to_string()));
    if let Some(t) = title {
        o.insert("_title".into(), Value::String(t));
    }
    if let Some(p) = parent {
        o.insert("_parent".into(), Value::String(p.id));
        if let Some(t) = p.title {
            o.insert("_parent_title".into(), Value::String(t));
        }
        if let Some(cwd) = p.cwd {
            o.insert("_parent_cwd".into(), Value::String(cwd));
        }
    }
    v
}

/// What pet.js reads from a hook event, besides the `_` fields added here and the
/// command in `tool_input`.
const EVENT_FIELDS: &[&str] = &[
    "hook_event_name",
    "session_id",
    "cwd",
    "tool_name",
    "source",
    "reason",
    "trigger",
    "notification_type",
    "error_type",
    "error",
    "is_interrupt",
    "action",
    "agent_id",
];

/// Passes a state event on to the pet, without the prompts, file contents and replies
/// that come with it: those can be large, and the page would have to parse them.
fn emit_hook(app: &AppHandle, mut payload: Value) {
    if let Some(o) = payload.as_object_mut() {
        let command = o.get_mut("tool_input").and_then(|input| input.get_mut("command")).map(Value::take);
        o.retain(|key, _| key.starts_with('_') || EVENT_FIELDS.contains(&key.as_str()));
        if let Some(command) = command {
            o.insert("tool_input".into(), json!({ "command": command }));
        }
    }
    let _ = app.emit("hook-event", payload);
}

fn permission(stream: TcpStream, app: &AppHandle, shared: &Shared, payload: Value) -> io::Result<()> {
    let tool = payload["tool_name"].as_str().unwrap_or_default();
    // These need structured answers only the native UI can collect.
    let native_only = matches!(tool, "AskUserQuestion" | "ExitPlanMode");
    if native_only || !shared.bubbles.load(Ordering::SeqCst) {
        respond(&stream, 200, "")?;
        emit_hook(app, payload);
        return Ok(());
    }

    let id = shared.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = mpsc::channel();
    let claimed = shared.claim(&payload);
    let held = Pending {
        tx,
        session: payload["session_id"].as_str().unwrap_or_default().to_string(),
        agent: payload["agent_id"].as_str().map(str::to_string),
        tool: tool.to_string(),
        call: claimed.as_ref().map(|(call, _)| call.clone()),
    };
    let session = held.session.clone();
    shared.pending.lock().unwrap().insert(id, held);
    let mut runs = SHELL_TOOLS.contains(&tool).then(|| ShellRuns::new(&session, shared, claimed.map(|(_, n)| n), id));
    let _ = app.emit("permission-request", json!({ "id": id, "payload": payload }));

    let started = Instant::now();
    stream.set_nonblocking(true)?;
    // `answered`: by the user, here or in Claude Code; otherwise we gave up waiting.
    let (answer, answered) = loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(answer) => break (answer, true),
            Err(mpsc::RecvTimeoutError::Disconnected) => break (Answer::Elsewhere(None), true),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if !client_alive(&stream) {
            break (Answer::Elsewhere(None), true);
        }
        // Looked at every time, so that a run that wasn't ours isn't taken for it later.
        if runs.as_mut().is_some_and(|r| r.started(shared, id)) && shared.alone(id) {
            break (Answer::Elsewhere(ALLOWED), true);
        }
        if started.elapsed() > PERMISSION_MAX_WAIT {
            break (Answer::Elsewhere(None), false);
        }
    };
    // Still listed only when nothing here answered it: it was allowed and started, the
    // user answered in the terminal, or we gave up while Claude Code still asks.
    shared.take(id, true);
    stream.set_nonblocking(false)?;

    match answer {
        Answer::Bubble(body) => respond(&stream, 200, &body),
        Answer::Elsewhere(outcome) => {
            let _ = app.emit("permission-closed", json!({ "id": id, "answered": answered, "outcome": outcome }));
            let _ = respond(&stream, 200, "");
            Ok(())
        }
    }
}

/// Claude Code closes the connection once the user answers natively.
fn client_alive(stream: &TcpStream) -> bool {
    let mut b = [0u8; 1];
    match stream.peek(&mut b) {
        Ok(0) => false,
        Ok(_) => true,
        Err(e) => e.kind() == ErrorKind::WouldBlock,
    }
}
