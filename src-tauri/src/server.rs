//! Minimal local HTTP server that receives Claude Code HTTP hooks.
//!
//! - `POST /clawd-pet/event`      state events, answered immediately
//! - `POST /clawd-pet/permission` PermissionRequest; the connection is held until
//!   the user answers in the bubble, or Claude Code closes it because the user
//!   answered in the terminal / Desktop app instead.
//!
//! Hand-rolled on std so we can watch the socket for that disconnect.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const PORT: u16 = 23490;
const MAX_BODY: usize = 16 * 1024 * 1024;
/// Hook timeout is 600s; give up a little earlier so Claude Code gets a clean reply.
const PERMISSION_MAX_WAIT: Duration = Duration::from_secs(590);

#[derive(Default)]
pub struct Shared {
    pub bubbles: AtomicBool,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<String>>>,
}

impl Shared {
    /// Answer a held permission request. `body` is the raw JSON response for Claude Code
    /// (empty string = no decision).
    pub fn resolve(&self, id: u64, body: String) -> bool {
        match self.pending.lock().unwrap().remove(&id) {
            Some(tx) => tx.send(body).is_ok(),
            None => false,
        }
    }
}

pub fn bind() -> io::Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", PORT))
}

pub fn serve(listener: TcpListener, app: AppHandle, shared: Arc<Shared>) {
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
    let payload = || -> Option<Value> {
        let mut v: Value = serde_json::from_slice(&req.body).ok()?;
        let title = crate::transcript::title(&v);
        let o = v.as_object_mut()?;
        o.remove("tool_response"); // can be huge and the pet doesn't need it
        o.insert("_entry".into(), Value::String(entry.clone()));
        if let Some(t) = title {
            o.insert("_title".into(), Value::String(t));
        }
        Some(v)
    };

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/clawd-pet/ping") => respond(&stream, 200, r#"{"app":"clawd-pet"}"#),
        ("POST", "/clawd-pet/event") => {
            respond(&stream, 200, "")?;
            if let Some(v) = payload() {
                crate::transcript::on_hook(&v);
                emit_hook(app, v);
            }
            Ok(())
        }
        ("POST", "/clawd-pet/permission") => match payload() {
            Some(v) => permission(stream, app, shared, v),
            None => respond(&stream, 200, ""),
        },
        _ => respond(&stream, 404, ""),
    }
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
    shared.pending.lock().unwrap().insert(id, tx);
    let _ = app.emit("permission-request", json!({ "id": id, "payload": payload }));

    let started = Instant::now();
    stream.set_nonblocking(true)?;
    let answer = loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(body) => break Some(body),
            Err(mpsc::RecvTimeoutError::Disconnected) => break None,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if !client_alive(&stream) || started.elapsed() > PERMISSION_MAX_WAIT {
            break None;
        }
    };
    shared.pending.lock().unwrap().remove(&id);
    stream.set_nonblocking(false)?;

    match answer {
        Some(body) => respond(&stream, 200, &body),
        None => {
            let _ = app.emit("permission-closed", json!({ "id": id }));
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
