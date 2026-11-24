//! Installs / removes the pet's HTTP hooks in the user's Claude Code settings.
//! Our entries are recognised by their URL prefix, so other hooks are never touched.

use crate::server::PORT;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

/// Events forwarded to `/event`. PermissionRequest goes to `/permission` separately.
const STATE_EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "Notification",
    "Elicitation",
    "ElicitationResult",
];

fn base_url() -> String {
    format!("http://127.0.0.1:{PORT}/clawd-pet/")
}

pub fn settings_path() -> PathBuf {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return PathBuf::from(dir).join("settings.json");
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".claude").join("settings.json")
}

fn hook(route: &str, timeout: u32) -> Value {
    json!({
        "type": "http",
        "url": format!("{}{route}", base_url()),
        "timeout": timeout,
        // Lets the pet tell terminal / Desktop app / IDE sessions apart.
        "headers": { "X-Clawd-Entry": "$CLAUDE_CODE_ENTRYPOINT" },
        "allowedEnvVars": ["CLAUDE_CODE_ENTRYPOINT"]
    })
}

fn is_ours(h: &Value) -> bool {
    h.get("url")
        .and_then(Value::as_str)
        .is_some_and(|u| u.starts_with(&base_url()))
}

pub fn read_settings() -> Result<Value, String> {
    let path = settings_path();
    match std::fs::read_to_string(&path) {
        Ok(s) if s.trim().is_empty() => Ok(json!({})),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("settings.json 解析失败：{e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("读取 settings.json 失败：{e}")),
    }
}

pub fn write_settings(v: &Value) -> Result<(), String> {
    let path = settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        let backup = path.with_extension("json.clawd-pet.bak");
        std::fs::copy(&path, backup).map_err(|e| format!("备份失败：{e}"))?;
    }
    let tmp = path.with_extension("json.clawd-pet.tmp");
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("写入 settings.json 失败：{e}"))
}

/// Remove our handlers; drops matcher groups / events that become empty because of it.
fn strip(hooks: &mut Map<String, Value>) {
    hooks.retain(|_, groups| {
        let Some(arr) = groups.as_array_mut() else { return true };
        arr.retain_mut(|group| {
            let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let before = list.len();
            list.retain(|h| !is_ours(h));
            !(list.is_empty() && before > 0)
        });
        !arr.is_empty()
    });
}

pub fn is_installed() -> bool {
    let Ok(v) = read_settings() else { return false };
    v.get("hooks")
        .and_then(Value::as_object)
        .is_some_and(|h| {
            h.values()
                .filter_map(Value::as_array)
                .flatten()
                .filter_map(|g| g.get("hooks").and_then(Value::as_array))
                .flatten()
                .any(is_ours)
        })
}

pub fn install() -> Result<(), String> {
    let mut v = read_settings()?;
    let root = v.as_object_mut().ok_or("settings.json 不是 JSON 对象")?;
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("settings.json 里的 hooks 不是对象")?;
    strip(hooks);
    let mut add = |event: &str, h: Value| {
        let groups = hooks.entry(event).or_insert_with(|| json!([]));
        if let Some(arr) = groups.as_array_mut() {
            arr.push(json!({ "hooks": [h] }));
        }
    };
    for event in STATE_EVENTS {
        add(event, hook("event", 5));
    }
    add("PermissionRequest", hook("permission", 600));
    write_settings(&v)
}

pub fn uninstall() -> Result<(), String> {
    let mut v = read_settings()?;
    let Some(root) = v.as_object_mut() else { return Ok(()) };
    if let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        strip(hooks);
        if hooks.is_empty() {
            root.remove("hooks");
        }
    }
    write_settings(&v)
}
