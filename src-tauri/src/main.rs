#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod autostart;
mod claude_app;
mod collection;
mod config;
mod desktop_sessions;
mod edges;
mod git;
mod hooks;
mod memory;
mod screen;
mod server;
mod sysmon;
mod transcript;

use config::Config;
use notify::RecommendedWatcher;
use server::Shared;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Wry,
};

const SIZE_RANGE: (u32, u32) = (120, 360);
/// Space above the pet reserved for speech / permission bubbles.
const BUBBLE_SPACE: f64 = 210.0;
/// More room above the pet while the AI chat is on, for a reply with a message on it.
const CHAT_SPACE: f64 = 110.0;
/// Space below the pet for the session status line.
const LABEL_SPACE: f64 = 44.0;
const MIN_WIDTH: f64 = 340.0;

struct AppState {
    config: Arc<Mutex<Config>>,
    config_path: PathBuf,
    shared: Arc<Shared>,
    events: sysmon::Events,
    watcher: Mutex<Option<RecommendedWatcher>>,
    downloads: Option<PathBuf>,
    /// Where git reports the commands it runs, once the user has turned that on.
    git_trace: PathBuf,
    /// Where `git_trace` used to be; a git config still pointing there counts as ours.
    old_git_trace: PathBuf,
    /// Interactive regions (x, y, w, h) in logical px; everything else is click-through.
    hit_rects: Mutex<Vec<[f64; 4]>>,
    /// The user is dragging the pet around.
    dragging: AtomicBool,
    dirty: AtomicBool,
    /// The pet hid itself because something full-screen took over its monitor.
    stepped_aside: AtomicBool,
}

impl AppState {
    fn save(&self) {
        self.config.lock().unwrap().save(&self.config_path);
    }

    fn rewatch(&self) {
        let cfg = self.config.lock().unwrap().clone();
        *self.watcher.lock().unwrap() = sysmon::watch(&self.events, &cfg, self.downloads.clone(), &self.git_trace);
    }
}

fn window_size(cfg: &Config) -> LogicalSize<f64> {
    let s = cfg.size as f64;
    let chat = if cfg.ai.enabled { CHAT_SPACE } else { 0.0 };
    LogicalSize::new(MIN_WIDTH.max(s + 40.0), BUBBLE_SPACE + chat + s + LABEL_SPACE)
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

// ---------- commands ----------

#[tauri::command]
fn get_config(state: State<AppState>) -> Config {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
fn set_config(config: Config, app: AppHandle, state: State<AppState>) {
    apply_config(&app, &state, config, false);
}

/// Puts a new config in place: the settings page's, or one the chat changed. The page
/// hears of it only for the chat's (`settings`): it has what it saved itself.
fn apply_config(app: &AppHandle, state: &AppState, mut config: Config, settings: bool) {
    config.size = config.size.clamp(SIZE_RANGE.0, SIZE_RANGE.1);
    let old = {
        let mut current = state.config.lock().unwrap();
        // The window position is owned by the pet window, not the settings form.
        config.x = current.x;
        config.y = current.y;
        std::mem::replace(&mut *current, config.clone())
    };
    state.shared.bubbles.store(config.bubbles, Ordering::SeqCst);
    transcript::show_replies(config.replies);
    if old.size != config.size || old.ai.enabled != config.ai.enabled {
        if let Some(w) = main_window(app) {
            resize_anchored(&w, window_size(&old), window_size(&config));
        }
    }
    if old.sys != config.sys {
        state.rewatch();
    }
    state.save();
    let _ = if settings { app.emit("config", config) } else { app.emit_to("main", "config", config) };
    if let Some(w) = main_window(app) {
        step_aside(app, state, &w);
    }
}

/// Changes one of the few settings the chat may change (`ai::SETTING_TOOL`), checked as
/// strictly as the settings page checks them, and put in place as its changes are.
/// Gives back what changed, for the model, or `None` if it was so already.
pub fn change_setting(app: &AppHandle, key: &str, value: &serde_json::Value) -> Result<Option<String>, String> {
    let state = app.state::<AppState>();
    let old = state.config.lock().unwrap().clone();
    let mut config = old.clone();
    let text = match value {
        serde_json::Value::String(s) => s.trim().to_owned(),
        serde_json::Value::Null => String::new(),
        v => v.to_string(),
    };
    let number = |lo: u32, hi: u32| text.parse::<u32>().ok().filter(|n| (lo..=hi).contains(n)).ok_or(format!("{key} 要是 {lo} 到 {hi} 之间的整数"));
    let switch = || match text.as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(format!("{key} 要写 \"true\" 或 \"false\"")),
    };
    let on_off = |on: bool| if on { "打开" } else { "关掉" };
    let said = match key {
        "nickname" => {
            if text.chars().count() > 12 {
                return Err("称呼最多 12 个字".into());
            }
            config.nickname = text.clone();
            if text.is_empty() { "不带称呼了".to_owned() } else { format!("称呼改成了「{text}」") }
        }
        "birthday" => {
            config.birthday = if text.is_empty() { String::new() } else { birthday(&text).ok_or("生日要写成 \"03-15\" 这样的月-日")? };
            match config.birthday.split_once('-') {
                Some((m, d)) => format!("生日记成了 {} 月 {} 日", m.trim_start_matches('0'), d.trim_start_matches('0')),
                None => "去掉了生日".to_owned(),
            }
        }
        "chatty" => {
            config.chatty = switch()?;
            format!("{}了爱说话", on_off(config.chatty))
        }
        "liveliness" => {
            config.liveliness = number(0, 3)? as u8;
            format!("活跃度改成了「{}」", ["安静", "悠闲", "活泼", "闹腾"][config.liveliness as usize])
        }
        "sedentaryMinutes" => {
            config.sedentary_minutes = number(0, 480)?;
            match config.sedentary_minutes {
                0 => "关掉了久坐提醒".to_owned(),
                n => format!("久坐提醒改成了 {n} 分钟"),
            }
        }
        "sleepEnabled" => {
            config.sleep_enabled = switch()?;
            format!("{}了按时睡觉", on_off(config.sleep_enabled))
        }
        "size" => {
            // In the settings slider's steps.
            config.size = (number(SIZE_RANGE.0, SIZE_RANGE.1)? + 5) / 10 * 10;
            format!("大小改成了 {} 像素", config.size)
        }
        _ => return Err("这项设置在聊天里改不了，请用户去设置里改".into()),
    };
    if serde_json::to_value(&config).ok() == serde_json::to_value(&old).ok() {
        return Ok(None);
    }
    apply_config(app, &state, config, true);
    Ok(Some(said))
}

/// "MM-DD" for a day there is in a year (Feb 29 included), from "3-15" or "03-15".
fn birthday(s: &str) -> Option<String> {
    let (m, d) = s.split_once('-')?;
    let (m, d): (u32, u32) = (m.trim().parse().ok()?, d.trim().parse().ok()?);
    let days = match m {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        1..=12 => 31,
        _ => return None,
    };
    (1..=days).contains(&d).then(|| format!("{m:02}-{d:02}"))
}

/// Brings the Claude desktop app forward, on the session with this title if given.
#[tauri::command]
fn focus_claude(title: Option<String>) {
    claude_app::focus(title);
}

/// `body`: where the pet itself is, which is kept on the screen (edges.rs).
#[tauri::command]
fn set_hit_rects(rects: Vec<[f64; 4]>, body: [f64; 4], window: WebviewWindow, state: State<AppState>) {
    *state.hit_rects.lock().unwrap() = rects;
    edges::set_body(&window, body);
}

/// How much of the pet's window is off its screen on each side.
#[tauri::command]
fn get_edges(window: WebviewWindow) -> edges::Edges {
    edges::current(&window)
}

#[tauri::command]
fn drag_started(state: State<AppState>) {
    state.dragging.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn resolve_permission(id: u64, body: String, state: State<AppState>) -> bool {
    state.shared.resolve(id, body)
}

#[tauri::command]
fn show_menu(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    let menu = build_menu(&app).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command]
fn hooks_installed() -> bool {
    hooks::is_installed()
}

#[tauri::command]
fn hooks_set(install: bool) -> Result<bool, String> {
    if install {
        hooks::install()?;
    } else {
        hooks::uninstall()?;
    }
    Ok(hooks::is_installed())
}

/// (can be turned on in this build, is on)
#[tauri::command]
fn autostart_get() -> (bool, bool) {
    (autostart::available(), autostart::enabled())
}

#[tauri::command]
fn autostart_set(enable: bool) -> Result<bool, String> {
    autostart::set(enable)?;
    Ok(autostart::enabled())
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    show_settings(&app);
}

#[tauri::command(async)]
fn pick_folder() -> Option<String> {
    rfd::FileDialog::new().pick_folder().map(|p| p.to_string_lossy().into_owned())
}

/// Lets the user point at a program; returns its file name, e.g. "chrome.exe".
#[tauri::command(async)]
fn pick_program() -> Option<String> {
    let path = rfd::FileDialog::new().add_filter("程序", &["exe"]).pick_file()?;
    Some(path.file_name()?.to_string_lossy().to_lowercase())
}

#[tauri::command(async)]
fn git_watch_get(state: State<AppState>) -> bool {
    git::is_installed(&state.git_trace)
}

#[tauri::command(async)]
fn git_watch_set(on: bool, state: State<AppState>) -> Result<bool, String> {
    if on {
        git::install(&state.git_trace, &state.old_git_trace)?;
    } else {
        git::uninstall(&state.git_trace)?;
    }
    Ok(git::is_installed(&state.git_trace))
}

// ---------- AI chat ----------

#[tauri::command]
fn ai_providers() -> &'static [ai::Provider] {
    ai::PROVIDERS
}

#[tauri::command]
fn ai_personas() -> &'static [ai::Persona] {
    ai::PERSONAS
}

#[tauri::command]
fn ai_identity() -> &'static str {
    ai::IDENTITY
}

/// Answers the chat `history` (ending with the user's message) as chat `id`, in `ai`
/// events. `now` is the local date and time, in words, and `day` the day as memory
/// counts it; `chat` numbers the chat the message is in; `looked`, that the chat has
/// looked at the screen before; `opener`, what the pet said to start the chat, when it did.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn ai_chat(id: u64, chat: u64, history: Vec<ai::Turn>, now: String, day: String, looked: bool, opener: Option<String>, app: AppHandle, state: State<AppState>) {
    let cfg = state.config.lock().unwrap().clone();
    // Where the pet is, if the model may look at the screen it is on.
    let eye = main_window(&app).filter(|_| cfg.ai.screen).and_then(|w| {
        let (p, s) = (w.outer_position().ok()?, w.outer_size().ok()?);
        #[cfg(windows)]
        let hwnd = w.hwnd().ok()?.0 as isize;
        #[cfg(not(windows))]
        let hwnd = 0;
        Some(ai::Eye { hwnd, x: p.x + s.width as i32 / 2, y: p.y + s.height as i32 - 80 })
    });
    let memory = memory::for_chat(&day);
    ai::start(app, cfg.ai, cfg.nickname, cfg.birthday, now, id, chat, history, eye, looked, memory, opener.unwrap_or_default());
}

/// Something memory counts (`memory::event`). Earlier days the pet never slept on get
/// dreamed about now.
#[tauri::command]
fn memory_event(kind: String, detail: serde_json::Value, day: String, now: String, app: AppHandle) -> memory::Reply {
    let reply = memory::event(&kind, &detail, &day);
    if reply.catch_up {
        tauri::async_runtime::spawn(memory::dream(app, day, memory::Why::CatchUp, now));
    }
    reply
}

/// A chat closed: what it noted down goes into the note, or with a model that doesn't
/// do tools, the chat itself (`memory::merge`).
#[tauri::command]
fn memory_merge(log: Option<memory::ChatLog>, now: String, app: AppHandle) {
    tauri::async_runtime::spawn(memory::merge(app, log, now));
}

/// The pet fell asleep for the first time in a sleep window (`why` "night" or "nap"), or
/// the settings page asks ("manual"): time to dream about the days so far. Comes back
/// once that dream is over (after any ahead of it in line), which the page waits for.
#[tauri::command]
async fn memory_dream(day: String, now: String, why: String, app: AppHandle) {
    memory::dream(app, day, memory::Why::parse(&why), now).await;
}

#[tauri::command]
fn memory_topic(when: String) -> Option<String> {
    memory::topic(&when)
}

#[tauri::command]
fn memory_get(day: String) -> serde_json::Value {
    memory::snapshot(&day)
}

/// From the settings page: "save" the user's own `note`, or "forget" everything.
#[tauri::command]
fn memory_edit(op: String, note: Option<String>, app: AppHandle) {
    match op.as_str() {
        "save" => memory::set_note(&app, note.as_deref().unwrap_or("")),
        "forget" => memory::forget(&app),
        _ => {}
    }
}

#[tauri::command]
fn ai_cancel() {
    ai::stop();
}

/// The models a provider offers, going by `ai` as edited in the settings.
#[tauri::command]
async fn ai_models(ai: config::AiConfig, provider: String) -> Result<Vec<String>, String> {
    ai::models(ai, provider).await
}

#[tauri::command]
fn ai_key_page(provider: String) {
    ai::open_key_page(&provider);
}

/// Opens a link from a chat reply in the default browser; only web and mail links.
/// On a thread of its own: starting a browser or mail client can take a moment, and
/// the main thread draws and drags the pet.
#[tauri::command]
fn open_link(url: String) {
    let Some(url) = safe_link(&url) else { return };
    #[cfg(windows)]
    std::thread::spawn(move || unsafe {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        // ShellExecute may hand the link to a shell extension, which wants COM.
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let (verb, url) = (wide("open"), wide(&url));
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), url.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
        if com {
            CoUninitialize();
        }
    });
}

/// A link from a reply as it may be opened: parsed and written out again, http(s)
/// with a host, or mailto with only a subject and body (a mail client takes other
/// fields too, attachments among them). Those two keep their text as it was encoded:
/// written out again as a form, a space would come back as "+", which a mail client
/// shows as it is.
fn safe_link(raw: &str) -> Option<String> {
    if raw.len() > 4096 {
        return None;
    }
    let mut url = tauri::Url::parse(raw).ok()?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some_and(|h| !h.is_empty()) => {}
        "mailto" => {
            let field = |part: &&str| {
                let key = part.split('=').next().unwrap_or_default();
                key.eq_ignore_ascii_case("subject") || key.eq_ignore_ascii_case("body")
            };
            let kept: Vec<&str> = url.query().unwrap_or_default().split('&').filter(field).collect();
            let kept = kept.join("&");
            url.set_query((!kept.is_empty()).then_some(kept.as_str()));
            url.set_fragment(None);
        }
        _ => return None,
    }
    let out = url.to_string();
    (!out.chars().any(char::is_control)).then_some(out)
}

/// Lets the chat's text box take the keyboard.
#[tauri::command]
fn chat_focus(window: WebviewWindow) {
    let _ = window.set_focus();
}

// ---------- menu & windows ----------

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let visible = main_window(app).and_then(|w| w.is_visible().ok()).unwrap_or(true);
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "toggle_visible", if visible { "隐藏桌宠" } else { "显示桌宠" }, true, None::<&str>)?,
            &MenuItem::with_id(app, "random", "随机来一段", true, None::<&str>)?,
            &MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
        ],
    )
}

fn refresh_tray(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("main"), build_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn toggle_visible(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let show = !w.is_visible().unwrap_or(false);
        // Straight to the system, as in step_aside: show() would take the keyboard focus,
        // and keys typed after it would go to the pet without the user looking.
        #[cfg(windows)]
        if let Ok(hwnd) = w.hwnd() {
            sysmon::set_shown(hwnd.0 as _, show);
        }
        #[cfg(not(windows))]
        let _ = if show { w.show() } else { w.hide() };
        tell_shown(app, show);
    }
}

/// The page stops drawing while the pet is hidden; the webview wouldn't by itself.
fn tell_shown(app: &AppHandle, shown: bool) {
    let _ = app.emit("shown", shown);
}

fn show_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    // Webviews sharing a data folder must be started with the same browser arguments.
    // The pet's (software rendering, no separate GPU process) save some 20 MB of memory.
    let args = app.config().app.windows.iter().find(|w| w.label == "main").and_then(|w| w.additional_browser_args.clone());
    // Creating a window from an event handler on the main thread deadlocks on Windows.
    let app = app.clone();
    std::thread::spawn(move || {
        let mut builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()));
        if let Some(args) = &args {
            builder = builder.additional_browser_args(args);
        }
        let _ = builder
            .title("Clawd Pet 设置")
            // The page draws its own title bar.
            .decorations(false)
            .inner_size(680.0, 760.0)
            .min_inner_size(560.0, 480.0)
            .center()
            .build();
    });
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "quit" => {
            app.state::<AppState>().save();
            memory::flush();
            collection::flush(true);
            app.exit(0);
        }
        "toggle_visible" => {
            toggle_visible(app);
            refresh_tray(app);
        }
        "random" => {
            let _ = app.emit("play-random", ());
        }
        "settings" => show_settings(app),
        _ => {}
    }
}

/// Left click toggles the pet, double click opens the settings.
///
/// Windows reports a double click as up, double-click, up. So a click only takes
/// effect once the double-click interval has passed without another tray event,
/// and the "up" that ends a double click is dropped.
fn on_tray_event(app: &AppHandle, event: TrayIconEvent) {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    static LAST_DOUBLE: Mutex<Option<Instant>> = Mutex::new(None);
    let interval = sysmon::double_click_time();

    match event {
        TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
            SEQ.fetch_add(1, Ordering::SeqCst);
            *LAST_DOUBLE.lock().unwrap() = Some(Instant::now());
            show_settings(app);
        }
        TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } => {
            if LAST_DOUBLE.lock().unwrap().is_some_and(|t| t.elapsed() < interval) {
                return;
            }
            let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(interval);
                if SEQ.load(Ordering::SeqCst) == seq {
                    toggle_visible(&app);
                    refresh_tray(&app);
                }
            });
        }
        _ => {}
    }
}

/// Resize while keeping the pet's bottom-center where it was.
fn resize_anchored(w: &WebviewWindow, old: LogicalSize<f64>, new: LogicalSize<f64>) {
    let scale = w.scale_factor().unwrap_or(1.0);
    let (a, b) = (old.to_physical::<f64>(scale), new.to_physical::<f64>(scale));
    if let Ok(pos) = w.outer_position() {
        let x = pos.x as f64 + (a.width - b.width) / 2.0;
        let y = pos.y as f64 + (a.height - b.height);
        let _ = w.set_size(new);
        let _ = w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }
}

fn place_initially(w: &WebviewWindow, cfg: &Config) {
    let _ = w.set_size(window_size(cfg));
    if let (Some(x), Some(y)) = (cfg.x, cfg.y) {
        let size = window_size(cfg).to_physical::<i32>(w.scale_factor().unwrap_or(1.0));
        // The pet itself sits at the bottom center of the window.
        let (px, py) = (x + size.width / 2, y + size.height - 80);
        let on_screen = w.available_monitors().unwrap_or_default().iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            px >= p.x && py >= p.y && px < p.x + s.width as i32 && py < p.y + s.height as i32
        });
        if on_screen {
            let _ = w.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }
    if let Ok(Some(m)) = w.primary_monitor() {
        let area = m.work_area();
        let size = window_size(cfg).to_physical::<i32>(m.scale_factor());
        let x = area.position.x + area.size.width as i32 - size.width - 24;
        let y = area.position.y + area.size.height as i32 - size.height;
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
}

/// Folders watched out of the box: Desktop, Downloads, Documents and Pictures\Screenshots.
fn default_folders(app: &AppHandle) -> Vec<String> {
    let p = app.path();
    [p.desktop_dir(), p.download_dir(), p.document_dir(), p.picture_dir().map(|d| d.join("Screenshots"))]
        .into_iter()
        .flatten()
        .filter(|d| d.is_dir())
        .map(|d| d.to_string_lossy().into_owned())
        .collect()
}

/// Hides the pet while a full-screen game or video has its monitor, and brings it
/// back afterwards. A pet the user hid themselves stays hidden.
fn step_aside(app: &AppHandle, st: &AppState, w: &WebviewWindow) {
    let (enabled, exclude) = {
        let cfg = st.config.lock().unwrap();
        (cfg.hide_in_fullscreen, cfg.fullscreen_exclude.clone())
    };
    let covered = enabled
        && w.outer_position().ok().zip(w.outer_size().ok()).is_some_and(|(p, s)| {
            // The pet itself sits at the bottom center of the window.
            sysmon::fullscreen_at(p.x + s.width as i32 / 2, p.y + s.height as i32 - 80, &exclude)
        });
    // Going by what is actually on screen, so that a pet that something else showed
    // again while its monitor is still taken hides again.
    let show = if covered && w.is_visible().unwrap_or(false) {
        false
    } else if !covered && st.stepped_aside.load(Ordering::SeqCst) {
        true
    } else {
        return;
    };
    // Both ways go straight to the system rather than through hide() / show(): those
    // record the user's own choice, and show() would take the keyboard focus from
    // whatever the user has just switched to.
    #[cfg(windows)]
    if let Ok(hwnd) = w.hwnd() {
        sysmon::set_shown(hwnd.0 as _, show);
    }
    st.stepped_aside.store(!show, Ordering::SeqCst);
    tell_shown(app, show);
    refresh_tray(app);
}

/// How often the cursor is looked at: often while it is near the pet, rarely otherwise.
const POLL_NEAR: Duration = Duration::from_millis(40);
const POLL_FAR: Duration = Duration::from_millis(200);
/// "Near" is within this many logical pixels of the pet's window.
const NEAR_MARGIN: f64 = 200.0;

/// Watches the cursor and toggles click-through so only the pet and its bubbles
/// catch the mouse. Also notices the end of a drag and flushes the config to disk.
fn spawn_background_loop(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(w) = main_window(&app) else { return };
        // Where the cursor is relative to the window, and the window's size, in
        // logical pixels; None while the window is hidden.
        #[cfg(windows)]
        let pointer = {
            let hwnd = w.hwnd().map_or(std::ptr::null_mut(), |h| h.0 as *mut std::ffi::c_void);
            move || sysmon::cursor_in(hwnd)
        };
        #[cfg(not(windows))]
        let pointer = || {
            if !w.is_visible().unwrap_or(false) {
                return None;
            }
            let (cur, pos, size) = (w.cursor_position().ok()?, w.outer_position().ok()?, w.outer_size().ok()?);
            let scale = w.scale_factor().ok()?;
            let px = |n: f64| n / scale;
            Some((px(cur.x - pos.x as f64), px(cur.y - pos.y as f64), px(size.width as f64), px(size.height as f64)))
        };

        let st = app.state::<AppState>();
        let mut through: Option<bool> = None;
        let mut nap = POLL_NEAR;
        let mut saved = Instant::now();
        loop {
            std::thread::sleep(nap);
            if saved.elapsed() >= Duration::from_secs(2) {
                saved = Instant::now();
                if st.dirty.swap(false, Ordering::SeqCst) {
                    st.save();
                }
                memory::flush();
                collection::flush(false);
            }
            let dragging = st.dragging.load(Ordering::SeqCst);
            if dragging && !sysmon::left_button_down() {
                st.dragging.store(false, Ordering::SeqCst);
                let _ = app.emit("drag-end", ());
                // It may have been dropped on a monitor that something full-screen has.
                step_aside(&app, &st, &w);
            }
            let Some((x, y, width, height)) = pointer() else {
                nap = POLL_FAR;
                continue;
            };
            let inside = st.hit_rects.lock().unwrap().iter().any(|r| x >= r[0] && y >= r[1] && x <= r[0] + r[2] && y <= r[1] + r[3]);
            if through != Some(!inside) {
                let _ = w.set_ignore_cursor_events(!inside);
                through = Some(!inside);
            }
            let near = x > -NEAR_MARGIN && y > -NEAR_MARGIN && x < width + NEAR_MARGIN && y < height + NEAR_MARGIN;
            nap = if near || dragging { POLL_NEAR } else { POLL_FAR };
        }
    });
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            set_hit_rects,
            get_edges,
            focus_claude,
            drag_started,
            resolve_permission,
            show_menu,
            hooks_installed,
            hooks_set,
            autostart_get,
            autostart_set,
            open_settings,
            pick_folder,
            pick_program,
            git_watch_get,
            git_watch_set,
            ai_providers,
            ai_personas,
            ai_identity,
            ai_chat,
            ai_cancel,
            ai_models,
            ai_key_page,
            open_link,
            chat_focus,
            memory_event,
            memory_merge,
            memory_dream,
            memory_topic,
            memory_get,
            memory_edit,
            collection::collection_known,
            collection::collection_seen,
            collection::collection_cheered,
            collection::collection_get,
            collection::collection_visit
        ])
        .setup(|app| {
            // The port doubles as a single-instance lock.
            let Ok(listener) = server::bind() else {
                eprintln!("clawd-pet: port {} busy, another instance is probably running", server::PORT);
                std::process::exit(0);
            };
            let handle = app.handle().clone();
            // Our files live under the user profile, not AppData: Claude Desktop runs Claude
            // Code in an MSIX container that redirects AppData writes, so a pet started from
            // there (`npm run dev`) would get a config of its own, and git run from there
            // would report to a folder the pet never sees. The user profile itself is shared.
            let data_dir = app.path().home_dir()?.join(".clawd-pet");
            let old_dir = app.path().app_config_dir()?;
            let config_path = data_dir.join("config.json");
            if !config_path.exists() && old_dir.join("config.json").exists() {
                let _ = std::fs::create_dir_all(&data_dir);
                let _ = std::fs::copy(old_dir.join("config.json"), &config_path);
            }
            let mut cfg = Config::load(&config_path);
            if cfg.sys.folders.is_none() {
                cfg.sys.folders = Some(default_folders(&handle));
                cfg.save(&config_path);
            }
            let config = Arc::new(Mutex::new(cfg.clone()));
            memory::load(data_dir.join("memory"), config.clone());
            collection::load(data_dir.join("collection.json"));
            let shared = Arc::new(Shared::default());
            shared.bubbles.store(cfg.bubbles, Ordering::SeqCst);
            transcript::show_replies(cfg.replies);
            let events = sysmon::Events::new(handle.clone());
            let git_trace = data_dir.join("git-trace");
            let old_git_trace = old_dir.join("git-trace");
            let _ = std::fs::create_dir_all(&git_trace);
            git::clear(&git_trace);
            app.manage(AppState {
                config: config.clone(),
                config_path,
                shared: shared.clone(),
                events: events.clone(),
                watcher: Mutex::new(None),
                downloads: app.path().download_dir().ok(),
                git_trace,
                old_git_trace,
                hit_rects: Mutex::new(Vec::new()),
                dragging: AtomicBool::new(false),
                dirty: AtomicBool::new(false),
                stepped_aside: AtomicBool::new(false),
            });
            app.state::<AppState>().rewatch();
            autostart::refresh();
            sysmon::spawn_poller(events.clone(), config.clone());
            transcript::init(handle.clone());
            server::serve(listener, handle.clone(), shared);
            // Noted down in a chat that a quit cut short: into the note now.
            if memory::has_memos() {
                tauri::async_runtime::spawn(memory::merge(handle.clone(), None, String::new()));
            }

            let w = main_window(&handle).expect("main window");
            place_initially(&w, &cfg);
            edges::install(&handle, &w);
            w.show()?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("icon"))
                .tooltip("Clawd Pet")
                .menu(&build_menu(&handle)?)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, e| on_tray_event(tray.app_handle(), e))
                .build(app)?;

            spawn_background_loop(handle.clone());
            sysmon::watch_foreground(events, config, move || {
                if let Some(w) = main_window(&handle) {
                    step_aside(&handle, &handle.state::<AppState>(), &w);
                }
            });
            Ok(())
        })
        .on_menu_event(|app, e| on_menu(app, e.id().as_ref()))
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::Moved(p) = event {
                let st = window.state::<AppState>();
                let mut cfg = st.config.lock().unwrap();
                cfg.x = Some(p.x);
                cfg.y = Some(p.y);
                st.dirty.store(true, Ordering::SeqCst);
            }
            if let Some(w) = main_window(window.app_handle()) {
                // A DPI change is fitted in edges.rs, after tao has moved the window.
                if let tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) = event {
                    edges::tell(&w);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running clawd-pet");
}
