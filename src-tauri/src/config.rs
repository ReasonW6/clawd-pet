use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct SleepWindow {
    /// "HH:MM"; a window whose end is before its start wraps past midnight.
    pub start: String,
    pub end: String,
}

/// Reactions to things the user does outside Claude Code.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SysConfig {
    /// Files arriving in the watched folders (move-in, zip, download, screenshot).
    pub files: bool,
    /// `None` until the first launch fills in the default folders.
    pub folders: Option<Vec<String>>,
    pub trash: bool,
    pub clipboard: bool,
    pub power: bool,
    pub network: bool,
    pub theme: bool,
    pub holidays: bool,
    /// React to the foreground application (process name only).
    pub apps: bool,
}

impl Default for SysConfig {
    fn default() -> Self {
        Self {
            files: true,
            folders: None,
            trash: true,
            clipboard: true,
            power: true,
            network: true,
            theme: true,
            holidays: true,
            apps: false,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// Pet size in logical pixels.
    pub size: u32,
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// 0 = calm (no idle activities) … 3 = hyperactive.
    pub liveliness: u8,
    /// How the pet addresses the user in greetings.
    pub nickname: String,
    /// "MM-DD", or empty.
    pub birthday: String,
    /// Greetings, meal-time nudges and other small talk.
    pub chatty: bool,
    /// Show Allow/Deny bubbles for Claude Code permission requests.
    pub bubbles: bool,
    pub sleep_enabled: bool,
    pub sleep_windows: Vec<SleepWindow>,
    /// Minutes without keyboard/mouse input before the pet starts amusing itself.
    #[serde(alias = "awayMinutes")]
    pub alone_minutes: u32,
    /// Remind the user to stretch after this many minutes at the desk; 0 = off.
    pub sedentary_minutes: u32,
    /// Hide while a full-screen game or video has the pet's monitor.
    pub hide_in_fullscreen: bool,
    /// Programs (file names like "chrome.exe") that don't hide the pet when full-screen.
    pub fullscreen_exclude: Vec<String>,
    pub sys: SysConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            size: 200,
            x: None,
            y: None,
            liveliness: 2,
            nickname: String::new(),
            birthday: String::new(),
            chatty: true,
            bubbles: true,
            sleep_enabled: true,
            sleep_windows: vec![
                SleepWindow { start: "13:00".into(), end: "14:00".into() },
                SleepWindow { start: "22:30".into(), end: "07:00".into() },
            ],
            alone_minutes: 5,
            sedentary_minutes: 60,
            hide_in_fullscreen: true,
            fullscreen_exclude: Vec::new(),
            sys: SysConfig::default(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, s);
        }
    }
}
