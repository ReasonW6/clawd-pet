//! Notices git commands run anywhere on the machine, in any repository and from any tool.
//!
//! Git can log every command it runs ("trace2"). When the user turns this on, the
//! global git config points that log at a folder of ours. Git then writes one small
//! file per git process there; each is read once the process has ended and deleted.
//! Only the command name and the exit code are looked at.

use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, SystemTime};

/// The settings we add to the global git config, besides `trace2.eventTarget`.
/// With `maxFiles`, git stops tracing by itself once that many unread files have
/// piled up, i.e. when the pet isn't running to collect them.
const SETTINGS: &[(&str, &str)] = &[("trace2.eventBrief", "true"), ("trace2.eventNesting", "1"), ("trace2.maxFiles", "200")];
const TARGET: &str = "trace2.eventTarget";
/// What git leaves behind when it has hit `maxFiles`.
const DISCARD: &str = "git-trace2-discard";
/// Anything this old was left over by a delete that failed.
const STALE: Duration = Duration::from_secs(3600);

fn git(args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.output().map_err(|_| "没找到 git：请先安装 Git，并确保命令行里能直接运行 git".to_string())
}

/// A value from the global git config; empty when unset.
fn global(key: &str) -> Result<String, String> {
    let out = git(&["config", "--global", "--get", key])?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The trace folder the way it is written into the git config.
fn target(dir: &Path) -> String {
    dir.to_string_lossy().replace('\\', "/")
}

pub fn is_installed(dir: &Path) -> bool {
    global(TARGET).is_ok_and(|current| current == target(dir))
}

/// `old` is where the trace folder used to be: a config pointing there is ours to move.
pub fn install(dir: &Path, old: &Path) -> Result<(), String> {
    let current = global(TARGET)?;
    let moving = current == target(old);
    if !moving && !current.is_empty() && current != target(dir) {
        return Err(format!("全局 git 配置里的 trace2.eventTarget 已经指向 {current}，为了不影响它，这里没有改动"));
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    clear(dir);
    let dir = target(dir);
    for (key, value) in SETTINGS.iter().copied().chain([(TARGET, dir.as_str())]) {
        let out = git(&["config", "--global", key, value])?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
    }
    // Only now: the `git config` runs above still trace to the old folder, and with
    // the folder gone git would write its trace to a file of that name instead.
    if moving {
        clear(old);
        let _ = std::fs::remove_dir(old);
    }
    Ok(())
}

pub fn uninstall(dir: &Path) -> Result<(), String> {
    if is_installed(dir) {
        for key in SETTINGS.iter().map(|s| s.0).chain([TARGET]) {
            git(&["config", "--global", "--unset", key])?;
        }
    }
    clear(dir);
    Ok(())
}

/// Empties the trace folder: whatever is in it was written while nobody was reading.
pub fn clear(dir: &Path) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let _ = std::fs::remove_file(entry.path());
    }
}

/// Called for every change to a file in the trace folder. Once the git process that
/// wrote it has ended, removes the file and returns the reaction it deserves, if any:
/// only commands the user ran themselves, and only when they succeeded.
pub fn read(path: &Path) -> Option<&'static str> {
    if path.file_name()? == DISCARD {
        let _ = std::fs::remove_file(path);
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    // Still running until the "atexit" event is there; the next write brings us back.
    if !text.contains(r#""event":"atexit""#) {
        return None;
    }
    remove(path);
    sweep(path.parent()?);

    let (mut command, mut code) = (None, None);
    for event in text.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()) {
        match event["event"].as_str() {
            // Commands started by other git commands (pull runs fetch and merge) have
            // a hierarchy like "pull/fetch".
            Some("cmd_name") if event["hierarchy"] == event["name"] => command = event["name"].as_str().map(str::to_owned),
            Some("atexit") => code = event["code"].as_i64(),
            _ => {}
        }
    }
    if code != Some(0) {
        return None;
    }
    Some(match command?.as_str() {
        "commit" | "cherry-pick" | "revert" | "tag" => "git-commit",
        "merge" | "pull" | "rebase" => "git-merge",
        "push" => "git-push",
        "clone" | "init" => "git-clone",
        "checkout" | "switch" => "git-switch",
        "reset" | "restore" | "stash" => "git-undo",
        // status, fetch, log, diff...: mostly editors and prompts asking in the background.
        _ => return None,
    })
}

/// Git may still hold the file for a moment after its last write. Trying again is
/// left to a thread of its own: the caller is the file watcher, which has other
/// folders to report on meanwhile.
fn remove(path: &Path) {
    if std::fs::remove_file(path).is_ok() {
        return;
    }
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        for _ in 0..3 {
            std::thread::sleep(Duration::from_millis(40));
            if std::fs::remove_file(&path).is_ok() {
                return;
            }
        }
    });
}

fn sweep(dir: &Path) {
    let now = SystemTime::now();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age > STALE));
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
