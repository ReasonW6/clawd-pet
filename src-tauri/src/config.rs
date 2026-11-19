use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// Browsers and video players, excluded from hiding out of the box: full-screen in
/// one of these is usually a video, and the pet may keep the user company through it.
const BROWSERS: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "vivaldi.exe",
    "zen.exe",
    "arc.exe",
    "chromium.exe",
    "floorp.exe",
    "librewolf.exe",
    "waterfox.exe",
    "thorium.exe",
    "360se.exe",
    "360chrome.exe",
    "360chromex.exe",
    "qqbrowser.exe",
    "sogouexplorer.exe",
    "2345explorer.exe",
    "quark.exe",
    "ego.exe",
];

const VIDEO_PLAYERS: &[&str] = &[
    "potplayermini64.exe",
    "potplayermini.exe",
    "vlc.exe",
    "mpv.exe",
    "mpc-hc64.exe",
    "mpc-hc.exe",
    "mpc-be64.exe",
    "mpc-be.exe",
    "kmplayer.exe",
    "wmplayer.exe",
    "microsoft.media.player.exe",
    "kodi.exe",
    "plex.exe",
    "qqplayer.exe",
    "xmp.exe",
    "qqlive.exe",
    "qyclient.exe",
    "qyplayer.exe",
    "youkudesktop.exe",
    "哔哩哔哩.exe",
];

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

/// One AI provider's settings, kept per provider so that switching back keeps them.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiProfile {
    pub api_key: String,
    /// Empty = the provider's own address.
    pub base_url: String,
    /// Empty = the provider's default model.
    pub model: String,
    /// How hard the model thinks: "off" or one of the levels `ai::PROVIDERS` lists for
    /// the model; empty leaves it to the model, and nothing about it is sent.
    pub reasoning: String,
}

/// A persona the user added for the chat.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomPersona {
    pub id: String,
    pub name: String,
    pub prompt: String,
}

/// Chatting with an AI model in bubbles above the pet.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiConfig {
    /// A double click opens the chat instead of a random act.
    pub enabled: bool,
    /// An id from `ai::PROVIDERS`.
    pub provider: String,
    pub profiles: BTreeMap<String, AiProfile>,
    /// Give the model a tool that takes a screenshot of the pet's monitor.
    pub screen: bool,
    /// Turn on the provider's own web search, where it has one. Off by default, for
    /// configs from before it too: most providers bill each search.
    pub search: bool,
    /// Search through Exa instead, with a tool the pet runs itself. The settings page
    /// turns `search` off as this goes on and the other way round (unless the provider has
    /// no search of its own); with both on, the chat uses Exa.
    pub exa: bool,
    /// Empty for Exa's free way, without a key.
    pub exa_key: String,
    /// Who the pet believes it is, as the user rewrote it; empty for `ai::IDENTITY`.
    pub identity: String,
    /// Who the pet chats as: an id from `ai::PERSONAS`, or of one in `custom_personas`.
    pub persona: String,
    /// Preset personas' prompts as the user rewrote them, by id.
    pub persona_prompts: BTreeMap<String, String>,
    pub custom_personas: Vec<CustomPersona>,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "deepseek".into(),
            profiles: BTreeMap::new(),
            screen: false,
            search: false,
            exa: false,
            exa_key: String::new(),
            identity: String::new(),
            persona: "default".into(),
            persona_prompts: BTreeMap::new(),
            custom_personas: Vec::new(),
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
    /// Show the first line of what Claude says above the pet while it works.
    pub replies: bool,
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
    pub ai: AiConfig,
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
            replies: true,
            sleep_enabled: true,
            sleep_windows: vec![
                SleepWindow { start: "13:00".into(), end: "14:00".into() },
                SleepWindow { start: "22:30".into(), end: "07:00".into() },
            ],
            alone_minutes: 5,
            sedentary_minutes: 60,
            hide_in_fullscreen: true,
            fullscreen_exclude: BROWSERS.iter().chain(VIDEO_PLAYERS).map(|p| p.to_string()).collect(),
            sys: SysConfig::default(),
            ai: AiConfig::default(),
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
