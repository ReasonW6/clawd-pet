//! Notices what the user does outside Claude Code and tells the pet about it
//! as `user-event { kind, detail }`.
//!
//! Only "something happened" signals are used: file names in watched folders and
//! in the recycle bin, the clipboard sequence number, power / network state, time
//! since last input, which program is in the foreground. File contents, clipboard contents and
//! keystrokes are never read.

use crate::config::Config;
use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// One burst of file activity should be one reaction.
const COOLDOWN: Duration = Duration::from_secs(6);

const ARCHIVES: &[&str] = &["zip", "7z", "rar", "tar", "gz", "tgz", "xz", "zst"];
const IMAGES: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif"];
const TEMP_EXTS: &[&str] = &["tmp", "temp", "crdownload", "part", "partial", "download"];

#[derive(Clone)]
pub struct Events {
    app: AppHandle,
    last: Arc<Mutex<HashMap<&'static str, Instant>>>,
}

impl Events {
    pub fn new(app: AppHandle) -> Self {
        Self { app, last: Arc::default() }
    }

    fn emit_now(&self, kind: &'static str, detail: Value) {
        let _ = self.app.emit("user-event", json!({ "kind": kind, "detail": detail }));
    }

    /// Emit unless the same kind fired within the cooldown.
    fn emit(&self, kind: &'static str, detail: Value) {
        {
            let mut last = self.last.lock().unwrap();
            let now = Instant::now();
            if last.get(kind).is_some_and(|t| now.duration_since(*t) < COOLDOWN) {
                return;
            }
            last.insert(kind, now);
        }
        self.emit_now(kind, detail);
    }
}

// ---------- folders, recycle bin & git ----------

/// (Re)creates the file watcher for the folders in `cfg`, for the recycle bin and
/// for the folder git reports its commands to (see git.rs). Dropping the returned
/// watcher stops it.
pub fn watch(events: &Events, cfg: &Config, downloads: Option<PathBuf>, git_trace: &Path) -> Option<RecommendedWatcher> {
    let ev = events.clone();
    let trace = git_trace.to_path_buf();
    let bins = if cfg.sys.trash { recycle_bins() } else { Vec::new() };
    let watched_bins = bins.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(e) = res else { return };
        let kind = match e.paths.first().and_then(|p| Some((p, p.parent()?))) {
            Some((path, parent)) if parent == trace => crate::git::read(path),
            Some((_, parent)) if bins.iter().any(|b| b == parent) => trashed(&e, &bins),
            _ => classify(&e, downloads.as_deref()),
        };
        if let Some(kind) = kind {
            ev.emit(kind, Value::Null);
        }
    })
    .ok()?;

    if cfg.sys.files {
        for folder in cfg.sys.folders.iter().flatten() {
            let _ = watcher.watch(Path::new(folder), RecursiveMode::NonRecursive);
        }
    }
    for bin in &watched_bins {
        let _ = watcher.watch(bin, RecursiveMode::NonRecursive);
    }
    let _ = watcher.watch(git_trace, RecursiveMode::NonRecursive);
    Some(watcher)
}

/// The user's recycle bin folder on each drive: the ones under `X:\$Recycle.Bin`
/// that can be read (the others belong to other users).
fn recycle_bins() -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }
    ('C'..='Z')
        .filter_map(|drive| std::fs::read_dir(format!("{drive}:\\$Recycle.Bin")).ok())
        .flat_map(|dirs| dirs.flatten().map(|d| d.path()))
        .filter(|dir| std::fs::read_dir(dir).is_ok())
        .collect()
}

/// Every item in a recycle bin comes with an "$I…" file that describes it: a new
/// one means something was deleted, and the last one going means the bin was emptied.
fn trashed(e: &notify::Event, bins: &[PathBuf]) -> Option<&'static str> {
    let record = |name: &std::ffi::OsStr| name.to_str().is_some_and(|n| n.starts_with("$I"));
    if !record(e.paths.first()?.file_name()?) {
        return None;
    }
    match e.kind {
        EventKind::Create(_) => Some("trash"),
        EventKind::Remove(_) => {
            let holds_items = |bin: &PathBuf| {
                std::fs::read_dir(bin).is_ok_and(|mut items| items.any(|i| i.is_ok_and(|i| record(&i.file_name()))))
            };
            (!bins.iter().any(holds_items)).then_some("trash-empty")
        }
        _ => None,
    }
}

fn classify(e: &notify::Event, downloads: Option<&Path>) -> Option<&'static str> {
    let path = e.paths.first()?;
    let name = path.file_name()?.to_str()?.to_lowercase();
    let parent = path.parent()?;

    let created = matches!(e.kind, EventKind::Create(_));
    let renamed_to = matches!(e.kind, EventKind::Modify(ModifyKind::Name(RenameMode::To)));
    let ext = name.rsplit_once('.').map_or("", |(_, ext)| ext);
    let temp = name.starts_with("~$")
        || name.starts_with('.')
        || name == "desktop.ini"
        || name == "thumbs.db"
        || TEMP_EXTS.contains(&ext);
    if temp || !(created || renamed_to) {
        return None;
    }

    // Browsers download to a temp name and rename it when finished.
    if downloads == Some(parent) {
        return Some("download");
    }
    if ARCHIVES.contains(&ext) {
        return Some("zip");
    }
    let folder = parent.file_name()?.to_str()?.to_lowercase();
    if IMAGES.contains(&ext) && (folder.contains("screenshot") || folder.contains("截图")) {
        return Some("screenshot");
    }
    created.then_some("file-in")
}

// ---------- polled system state ----------

#[cfg(not(windows))]
pub fn spawn_poller(_events: Events, _config: Arc<Mutex<Config>>) {}

#[cfg(not(windows))]
pub fn left_button_down() -> bool {
    false
}

#[cfg(not(windows))]
pub fn fullscreen_at(_x: i32, _y: i32, _exclude: &[String]) -> bool {
    false
}

#[cfg(not(windows))]
pub fn watch_foreground(_events: Events, _config: Arc<Mutex<Config>>, _on_change: impl Fn() + Send + 'static) {}

/// Whether the foreground window is a full-screen one (a game or a video, exclusive
/// or borderless) on the monitor that the screen point is on. Programs in `exclude`
/// (file names like "chrome.exe") don't count.
#[cfg(windows)]
pub fn fullscreen_at(x: i32, y: i32, exclude: &[String]) -> bool {
    win::fullscreen_at(x, y, exclude)
}

/// Shows or hides a window directly, without handing it the keyboard focus.
#[cfg(windows)]
pub fn set_shown(hwnd: *mut std::ffi::c_void, shown: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE};
    unsafe {
        ShowWindow(hwnd, if shown { SW_SHOWNOACTIVATE } else { SW_HIDE });
    }
}

/// Where the cursor is relative to a window's top-left corner, and the window's
/// size, in logical pixels: (x, y, width, height). None while the window is hidden.
/// A few plain system calls, cheap enough to poll.
#[cfg(windows)]
pub fn cursor_in(hwnd: *mut std::ffi::c_void) -> Option<(f64, f64, f64, f64)> {
    win::cursor_in(hwnd)
}

/// Runs `on_change` when another window comes to the foreground, or when a window
/// goes full-screen or leaves it, once things have settled. Also tells the pet which
/// program is in front, if it is set to react to that, and when the Claude desktop
/// app starts and quits. The system delivers these events; nothing runs in between.
#[cfg(windows)]
pub fn watch_foreground(events: Events, config: Arc<Mutex<Config>>, on_change: impl Fn() + Send + 'static) {
    std::thread::spawn(move || {
        // Already running when the pet starts: only its quitting is news.
        if let Some(pid) = win::find_claude_app() {
            follow_claude_app(&events, pid);
        }
        let mut front = String::new();
        win::foreground_loop(&mut || {
            if let Some((pid, path)) = win::foreground_process() {
                // It has just started when a window of it comes to the front that
                // isn't the process being followed.
                if pid != CLAUDE_APP.load(Ordering::SeqCst) && win::is_claude_app(&path) && follow_claude_app(&events, pid) {
                    events.emit_now("claude-open", Value::Null);
                }
                if config.lock().unwrap().sys.apps {
                    let exe = win::exe_name(&path);
                    if exe != front {
                        front = exe.clone();
                        events.emit_now("app", json!(exe));
                    }
                }
            }
            on_change();
        });
    });
}

/// Process id of the Claude desktop app being followed, 0 when none.
#[cfg(windows)]
static CLAUDE_APP: AtomicU32 = AtomicU32::new(0);

/// Follows the Claude desktop app's process: when it ends, the app has quit (closing
/// its window may only send it to the tray). Waiting on the process costs nothing.
#[cfg(windows)]
fn follow_claude_app(events: &Events, pid: u32) -> bool {
    let Some(process) = win::wait_handle(pid) else { return false };
    CLAUDE_APP.store(pid, Ordering::SeqCst);
    let events = events.clone();
    std::thread::spawn(move || {
        win::wait_exit(process);
        if CLAUDE_APP.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            events.emit_now("claude-quit", Value::Null);
        }
    });
    true
}

/// The system's double-click interval.
pub fn double_click_time() -> Duration {
    #[cfg(windows)]
    let ms = unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime() };
    #[cfg(not(windows))]
    let ms = 500;
    Duration::from_millis(ms.into())
}

#[cfg(windows)]
pub fn left_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    unsafe { GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000 != 0 }
}

#[cfg(windows)]
pub fn spawn_poller(events: Events, config: Arc<Mutex<Config>>) {
    std::thread::spawn(move || {
        let mut alone = false;
        let mut longest_idle = 0u64;
        let mut clipboard = win::clipboard_seq();
        let mut online: Option<bool> = None;
        let mut power: Option<(bool, bool)> = None; // (plugged in, battery low)
        let mut tick = 0u64;

        loop {
            std::thread::sleep(Duration::from_secs(1));
            tick += 1;
            let (alone_minutes, on_clipboard, on_network, on_power) = {
                let cfg = config.lock().unwrap();
                (cfg.alone_minutes, cfg.sys.clipboard, cfg.sys.network, cfg.sys.power)
            };

            // No input for a while: the pet is left to itself. The user may be gone
            // or just watching something, so this is not treated as absence.
            let idle = win::idle_secs();
            if !alone && idle >= u64::from(alone_minutes.max(1)) * 60 {
                alone = true;
                events.emit_now("alone", Value::Null);
            }
            if alone {
                if idle < 5 {
                    alone = false;
                    events.emit_now("back", json!(longest_idle));
                    longest_idle = 0;
                } else {
                    longest_idle = longest_idle.max(idle);
                }
            }

            let seq = win::clipboard_seq();
            if seq != clipboard {
                clipboard = seq;
                if on_clipboard {
                    events.emit("clipboard", Value::Null);
                }
            }

            if on_network && tick % 5 == 0 {
                let now = win::is_online();
                if online.is_some_and(|prev| prev != now) {
                    events.emit(if now { "online" } else { "offline" }, Value::Null);
                }
                online = Some(now);
            }

            if on_power && tick % 20 == 0 {
                if let Some((plugged, percent)) = win::battery() {
                    let low = !plugged && percent <= 20;
                    if let Some((was_plugged, was_low)) = power {
                        if low && !was_low {
                            events.emit("battery-low", json!(percent));
                        }
                        if plugged && !was_plugged {
                            events.emit("power-plug", Value::Null);
                        }
                    }
                    power = Some((plugged, low));
                }
            }
        }
    });
}

#[cfg(windows)]
mod win {
    use std::cell::Cell;
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::Networking::WinInet::InternetGetConnectedState;
    use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };
    use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::Shell::{SHAppBarMessage, ABM_NEW, ABN_FULLSCREENAPP, APPBARDATA};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetCursorPos, GetForegroundWindow, GetMessageW,
        GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, KillTimer, RegisterClassW,
        SetTimer, EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, GWL_STYLE, MSG,
        WINEVENT_OUTOFCONTEXT, WM_APP, WM_TIMER, WNDCLASSW, WS_CAPTION, WS_EX_TOOLWINDOW, WS_POPUP,
    };

    pub fn fullscreen_at(x: i32, y: i32, exclude: &[String]) -> bool {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return false;
            }
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if monitor != MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) {
                return false;
            }
            let mut info: MONITORINFO = zeroed();
            info.cbSize = size_of::<MONITORINFO>() as u32;
            let mut r: RECT = zeroed();
            if GetMonitorInfoW(monitor, &mut info) == 0 || GetWindowRect(hwnd, &mut r) == 0 {
                return false;
            }
            let m = info.rcMonitor;
            let covers = r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
            // An ordinary maximized window covers the monitor too when the taskbar
            // hides itself, but it keeps its title bar; full-screen windows have none.
            let captioned = GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CAPTION == WS_CAPTION;
            if !covers || captioned {
                return false;
            }
            // The desktop and the task switcher fill the screen as well; those are explorer's.
            let exe = foreground_exe();
            exe != "explorer.exe" && !exclude.iter().any(|x| x.trim().eq_ignore_ascii_case(&exe))
        }
    }

    pub fn cursor_in(hwnd: *mut c_void) -> Option<(f64, f64, f64, f64)> {
        unsafe {
            let (mut cursor, mut r): (POINT, RECT) = zeroed();
            if IsWindowVisible(hwnd) == 0 || GetCursorPos(&mut cursor) == 0 || GetWindowRect(hwnd, &mut r) == 0 {
                return None;
            }
            let scale = f64::from(GetDpiForWindow(hwnd).max(96)) / 96.0;
            let px = |n: i32| f64::from(n) / scale;
            Some((px(cursor.x - r.left), px(cursor.y - r.top), px(r.right - r.left), px(r.bottom - r.top)))
        }
    }

    /// How long things have to hold still before `on_change` runs.
    const SETTLE_MS: u32 = 150;
    /// The message the shell uses to tell our (invisible) window about full-screen programs.
    const SHELL_NOTICE: u32 = WM_APP + 1;

    thread_local! {
        static SETTLE_TIMER: Cell<usize> = const { Cell::new(0) };
    }

    /// (Re)starts the timer; the loop in `foreground_loop` acts when it runs out.
    unsafe fn settle() {
        SETTLE_TIMER.set(SetTimer(null_mut(), SETTLE_TIMER.get(), SETTLE_MS, None));
    }

    unsafe extern "system" fn on_win_event(_: HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
        settle();
    }

    unsafe extern "system" fn on_message(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == SHELL_NOTICE && wparam as u32 == ABN_FULLSCREENAPP {
            settle();
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    pub fn foreground_loop(on_change: &mut dyn FnMut()) {
        unsafe {
            for (first, last) in [
                (EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND),
                // Restoring a minimized window doesn't always count as a foreground change.
                (EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            ] {
                SetWinEventHook(first, last, null_mut(), Some(on_win_event), 0, 0, WINEVENT_OUTOFCONTEXT);
            }

            // A window can also go full-screen without the foreground changing (a game
            // after launching, a video on F11). The shell tells application bars about
            // that, so that they get out of the way like the taskbar does; an invisible
            // window registered as one (taking up no screen space) gets told as well.
            let class: Vec<u16> = "ClawdPetShellNotice\0".encode_utf16().collect();
            let mut wc: WNDCLASSW = zeroed();
            wc.lpfnWndProc = Some(on_message);
            wc.lpszClassName = class.as_ptr();
            RegisterClassW(&wc);
            let (none, style) = (null_mut(), WS_POPUP);
            let hwnd = CreateWindowExW(WS_EX_TOOLWINDOW, class.as_ptr(), class.as_ptr(), style, 0, 0, 0, 0, none, none, none, none);
            let mut bar: APPBARDATA = zeroed();
            bar.cbSize = size_of::<APPBARDATA>() as u32;
            bar.hWnd = hwnd;
            bar.uCallbackMessage = SHELL_NOTICE;
            SHAppBarMessage(ABM_NEW, &mut bar);

            settle();
            // The hooks call back from inside GetMessageW, on this thread.
            let mut msg: MSG = zeroed();
            while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                if msg.message == WM_TIMER && msg.hwnd.is_null() {
                    KillTimer(null_mut(), msg.wParam);
                    SETTLE_TIMER.set(0);
                    on_change();
                } else {
                    DispatchMessageW(&msg);
                }
            }
        }
    }

    /// Seconds since the last keyboard / mouse input, system-wide.
    pub fn idle_secs() -> u64 {
        let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        unsafe {
            if GetLastInputInfo(&mut info) == 0 {
                return 0;
            }
            u64::from(GetTickCount().wrapping_sub(info.dwTime)) / 1000
        }
    }

    /// Changes whenever the clipboard does; says nothing about what is on it.
    pub fn clipboard_seq() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    pub fn is_online() -> bool {
        let mut flags = 0;
        unsafe { InternetGetConnectedState(&mut flags, 0) != 0 }
    }

    /// (plugged in, percent), or None on machines without a battery.
    pub fn battery() -> Option<(bool, u8)> {
        unsafe {
            let mut s: SYSTEM_POWER_STATUS = zeroed();
            if GetSystemPowerStatus(&mut s) == 0 || s.BatteryFlag & 128 != 0 || s.BatteryLifePercent > 100 {
                return None;
            }
            Some((s.ACLineStatus == 1, s.BatteryLifePercent))
        }
    }

    /// Lower-case file name of the foreground window's process, e.g. "spotify.exe".
    fn foreground_exe() -> String {
        foreground_process().map(|(_, path)| exe_name(&path)).unwrap_or_default()
    }

    pub fn exe_name(path: &str) -> String {
        path.rsplit('\\').next().unwrap_or_default().to_lowercase()
    }

    /// Id and executable path of the foreground window's process.
    pub fn foreground_process() -> Option<(u32, String)> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            Some((pid, process_path(pid)?))
        }
    }

    fn process_path(pid: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut buf = [0u16; 520];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(process);
            (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    /// The Claude desktop app, from the Store (WindowsApps\Claude_...\app\Claude.exe)
    /// or the standalone installer (AnthropicClaude\app-...\claude.exe). Claude Code's
    /// own claude.exe lives elsewhere.
    pub fn is_claude_app(path: &str) -> bool {
        let path = path.to_lowercase();
        path.ends_with("\\claude.exe") && (path.contains("\\windowsapps\\claude_") || path.contains("\\anthropicclaude\\"))
    }

    /// The Claude desktop app's main process, if it is running: the one whose parent
    /// isn't a claude.exe (its helpers and Claude Code sessions are its children).
    pub fn find_claude_app() -> Option<u32> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap.is_null() || snap as isize == -1 {
                return None;
            }
            let mut procs = Vec::new();
            let mut e: PROCESSENTRY32W = zeroed();
            e.dwSize = size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut e);
            while ok != 0 {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                let name = String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase();
                procs.push((e.th32ProcessID, e.th32ParentProcessID, name));
                ok = Process32NextW(snap, &mut e);
            }
            CloseHandle(snap);
            let is_claude = |pid: u32| procs.iter().any(|(p, _, name)| *p == pid && name == "claude.exe");
            procs
                .iter()
                .filter(|(pid, parent, name)| name == "claude.exe" && !is_claude(*parent) && *pid != 0)
                .map(|(pid, ..)| *pid)
                .find(|&pid| process_path(pid).is_some_and(|path| is_claude_app(&path)))
        }
    }

    /// A handle to wait on the process with, as a plain number so it can go to another thread.
    pub fn wait_handle(pid: u32) -> Option<usize> {
        let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        (!process.is_null()).then_some(process as usize)
    }

    /// Blocks until the process ends, then closes the handle.
    pub fn wait_exit(process: usize) {
        unsafe {
            WaitForSingleObject(process as *mut c_void, INFINITE);
            CloseHandle(process as *mut c_void);
        }
    }
}
