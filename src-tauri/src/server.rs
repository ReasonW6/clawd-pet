//! Minimal local HTTP server that receives Claude Code HTTP hooks.
//!
//! - `POST /clawd-pet/event`      state events, answered immediately
//! - `POST /clawd-pet/permission` PermissionRequest; the connection is held until
//!   the user answers in the bubble, or answers in Claude Code itself instead. The
//!   terminal closes the connection then; the Desktop app leaves the hook running, so
//!   there it shows in what follows (see `Shared::observe` and `answered`).
//!
//! Hand-rolled on std so we can watch the socket for that disconnect.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{self, BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
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

/// A tool call from its PreToolUse, until a permission request claims it or it ends.
struct Call {
    id: String,
    session: String,
    agent: Option<String>,
    tool: String,
    input: Value,
}

/// A permission request whose connection is being held.
struct Pending {
    /// `Some(body)`: the answer from the bubble. `None`: it was answered elsewhere.
    tx: mpsc::Sender<Option<String>>,
    session: String,
    /// The subagent asking, if it isn't the main thread.
    agent: Option<String>,
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
}

/// For transcript.rs, which sees what no hook reports.
static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();

impl Shared {
    /// Answer a held permission request. `body` is the raw JSON response for Claude Code
    /// (empty string = no decision).
    pub fn resolve(&self, id: u64, body: String) -> bool {
        match self.pending.lock().unwrap().remove(&id) {
            Some(p) => p.tx.send(Some(body)).is_ok(),
            None => false,
        }
    }

    /// Lets go of the held requests `stale` picks, as answered elsewhere.
    fn release(&self, stale: impl Fn(&Pending) -> bool) {
        self.pending.lock().unwrap().retain(|_, p| {
            let drop = stale(p);
            if drop {
                let _ = p.tx.send(None);
            }
            !drop
        });
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
                let Some(id) = call else { return };
                let mut calls = self.calls.lock().unwrap();
                if calls.len() >= CALLS_KEPT {
                    calls.pop_front();
                }
                calls.push_back(Call {
                    id: id.to_string(),
                    session: session.to_string(),
                    agent: agent.map(str::to_string),
                    tool: e["tool_name"].as_str().unwrap_or_default().to_string(),
                    input: e["tool_input"].clone(),
                });
            }
            // The tool ran, so it was allowed.
            "PostToolUse" | "PostToolUseFailure" => {
                let Some(id) = call else { return };
                self.calls.lock().unwrap().retain(|c| c.id != id);
                self.release(|p| p.call.as_deref() == Some(id));
            }
            // The turn of that thread is over: it ended, or a new prompt ended it.
            "Stop" | "StopFailure" | "SubagentStop" | "UserPromptSubmit" => {
                self.calls.lock().unwrap().retain(|c| !(c.session == session && c.agent.as_deref() == agent));
                self.release(|p| p.session == session && p.agent.as_deref() == agent);
            }
            "SessionEnd" => {
                self.calls.lock().unwrap().retain(|c| c.session != session);
                self.release(|p| p.session == session);
            }
            _ => {}
        }
    }

    /// The call a permission request is for: the earliest unclaimed one of the same
    /// thread, tool and input (identical calls in parallel ask in the order they were
    /// made); or, if a hook changed the input on the way, the only unclaimed one of that
    /// thread and tool.
    fn claim(&self, p: &Value) -> Option<String> {
        let (session, agent, tool) = (p["session_id"].as_str()?, p["agent_id"].as_str(), p["tool_name"].as_str()?);
        let mut calls = self.calls.lock().unwrap();
        let ours = |c: &Call| c.session == session && c.agent.as_deref() == agent && c.tool == tool;
        let i = calls.iter().position(|c| ours(c) && c.input == p["tool_input"]).or_else(|| {
            let mut same = calls.iter().enumerate().filter(|(_, c)| ours(c)).map(|(i, _)| i);
            match (same.next(), same.next()) {
                (Some(i), None) => Some(i),
                _ => None,
            }
        })?;
        calls.remove(i).map(|c| c.id)
    }
}

/// From the session's transcript: the calls still waiting for permission in `session`.
pub fn asking(session: &str) -> Vec<String> {
    let Some(shared) = SHARED.get() else { return Vec::new() };
    let pending = shared.pending.lock().unwrap();
    pending.values().filter(|p| p.session == session).filter_map(|p| p.call.clone()).collect()
}

/// From the session's transcript: the call got its result, so it was answered. Denying
/// with a note in the Desktop app lets the turn go on with no hook for it.
pub fn answered(call: &str) {
    if let Some(shared) = SHARED.get() {
        shared.release(|p| p.call.as_deref() == Some(call));
    }
}

/// From the session's transcript: the main thread's turn was interrupted. Subagents'
/// requests go too: they stop with it, and how they were answered shows in their own
/// transcripts, which aren't watched.
pub fn interrupted(session: &str) {
    if let Some(shared) = SHARED.get() {
        shared.release(|p| p.session == session);
    }
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
                shared.observe(v);
            }
            respond(&stream, 200, "")?;
            if let Some(v) = v.map(|v| enrich(v, &entry)) {
                crate::transcript::on_hook(&v);
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
    let held = Pending {
        tx,
        session: payload["session_id"].as_str().unwrap_or_default().to_string(),
        agent: payload["agent_id"].as_str().map(str::to_string),
        call: shared.claim(&payload),
    };
    shared.pending.lock().unwrap().insert(id, held);
    let _ = app.emit("permission-request", json!({ "id": id, "payload": payload }));

    let started = Instant::now();
    stream.set_nonblocking(true)?;
    // `answered`: by the user, here or in Claude Code; otherwise we gave up waiting.
    let (answer, answered) = loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(answer) => break (answer, true),
            Err(mpsc::RecvTimeoutError::Disconnected) => break (None, true),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if !client_alive(&stream) {
            break (None, true);
        }
        if started.elapsed() > PERMISSION_MAX_WAIT {
            break (None, false);
        }
    };
    shared.pending.lock().unwrap().remove(&id);
    stream.set_nonblocking(false)?;

    match answer {
        Some(body) => respond(&stream, 200, &body),
        None => {
            let _ = app.emit("permission-closed", json!({ "id": id, "answered": answered }));
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
