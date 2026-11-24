//! Global hotkeys that answer the permission bubble (allow, deny, always allow) without
//! the mouse. They are held only while the bubble shows a request, so the rest of the
//! time the combos belong to whatever program uses them.
//!
//! `RegisterHotKey` ties a hotkey to the thread that registers it, and that thread gets
//! its `WM_HOTKEY`. So one thread of our own does all the registering and runs the
//! message loop; the others change what it should hold (`State`) and wake it with a
//! thread message. A press goes to the main window as `perm-hotkey` with the action,
//! and the page answers the request the bubble shows, as a click on its button does.
//! Which combos it holds goes to the main window as `hotkeys`, so the bubble shows a
//! key only for the ones that work.

use crate::config::HotkeyConfig;
use std::sync::Mutex;

/// The actions, in the order of the ids they are registered under (index + 1).
pub const ACTIONS: [&str; 3] = ["allow", "deny", "always"];

/// `RegisterHotKey`'s modifier flags (MOD_*).
const ALT: u32 = 0x1;
const CTRL: u32 = 0x2;
const SHIFT: u32 = 0x4;
const WIN: u32 = 0x8;

/// A key with its modifiers, as `RegisterHotKey` takes them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Combo {
    mods: u32,
    vk: u32,
}

/// "Ctrl+Shift+Y" and the like: Ctrl, Alt, Shift and Win (Ctrl, Alt or Win at least, or
/// it would take a key from typing), then a letter, a digit or F1–F24.
pub fn parse(s: &str) -> Option<Combo> {
    let mut parts: Vec<&str> = s.split('+').map(str::trim).collect();
    let key = parts.pop()?.to_ascii_uppercase();
    let mut mods = 0;
    for m in parts {
        let flag = match m.to_ascii_lowercase().as_str() {
            "ctrl" => CTRL,
            "alt" => ALT,
            "shift" => SHIFT,
            "win" => WIN,
            _ => return None,
        };
        if mods & flag != 0 {
            return None;
        }
        mods |= flag;
    }
    if mods & (CTRL | ALT | WIN) == 0 {
        return None;
    }
    let vk = match key.as_bytes() {
        [c @ (b'A'..=b'Z' | b'0'..=b'9')] => *c as u32,
        [b'F', n @ ..] if n.first() != Some(&b'0') => match std::str::from_utf8(n).ok()?.parse::<u32>().ok()? {
            // VK_F1 is 0x70, and F1–F24 follow it.
            n @ 1..=24 => 0x6F + n,
            _ => return None,
        },
        _ => return None,
    };
    Some(Combo { mods, vk })
}

#[derive(Default)]
struct State {
    /// Each action's combo from the config; none while the hotkeys are switched off.
    combos: [Option<Combo>; 3],
    /// The bubble shows a request with this action's button.
    bubble: [bool; 3],
    /// The settings page is taking a new combo, so none are held: its keys reach it.
    paused: bool,
    /// What the hotkey thread holds.
    held: [Option<Combo>; 3],
    /// The hotkey thread, once its message queue is there.
    thread: u32,
}

static STATE: Mutex<State> = Mutex::new(State {
    combos: [None; 3],
    bubble: [false; 3],
    paused: false,
    held: [None; 3],
    thread: 0,
});

impl State {
    /// What should be held now.
    fn wanted(&self) -> [Option<Combo>; 3] {
        std::array::from_fn(|i| self.combos[i].filter(|_| self.bubble[i] && !self.paused))
    }
}

/// Each action's combo, none while switched off. One written differently but the same as
/// an earlier action's ("Shift+Ctrl+Y" after "Ctrl+Shift+Y") is none: it would press the
/// earlier action's button.
fn combos(cfg: &HotkeyConfig) -> [Option<Combo>; 3] {
    let texts = [&cfg.allow, &cfg.deny, &cfg.always];
    let mut out = [None; 3];
    for i in 0..3 {
        out[i] = parse(texts[i]).filter(|c| cfg.enabled && !out[..i].contains(&Some(*c)));
    }
    out
}

/// Starts the hotkey thread.
pub fn start(app: tauri::AppHandle, cfg: &HotkeyConfig) {
    STATE.lock().unwrap().combos = combos(cfg);
    imp::spawn(app);
}

/// The hotkeys in the settings changed.
pub fn configure(cfg: &HotkeyConfig) {
    update(|s| s.combos = combos(cfg));
}

/// The bubble shows a request (`on`), with an "always allow" button on it or not.
pub fn bubble(on: bool, always: bool) {
    update(|s| s.bubble = [on, on, on && always]);
}

/// The settings page is taking a new combo (or done with that).
pub fn pause(paused: bool) {
    update(|s| s.paused = paused);
}

fn update(change: impl FnOnce(&mut State)) {
    let mut s = STATE.lock().unwrap();
    let before = s.wanted();
    change(&mut s);
    if s.wanted() != before {
        imp::wake(s.thread);
    }
}

/// Whether `combo` can be had: `Err` with what to tell the user when it is no combo
/// this can take, or another program holds it. One the pet holds itself is fine.
pub fn check(combo: &str) -> Result<(), String> {
    let c = parse(combo).ok_or("要带上 Ctrl、Alt 或 Win，再加一个字母、数字或 F1–F24")?;
    // Held while trying, so the thread doesn't take it in between.
    let s = STATE.lock().unwrap();
    if s.held.contains(&Some(c)) || imp::free(c) {
        Ok(())
    } else {
        Err("被别的程序占用了，气泡出现时按它不会有反应，换一个吧".into())
    }
}

#[cfg(windows)]
mod imp {
    use super::{Combo, ACTIONS, STATE};
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_APP, WM_HOTKEY};

    /// Wakes the thread to hold what `STATE` wants.
    const WM_RECONCILE: u32 = WM_APP + 1;
    /// Taken for a moment by `free`; above the actions' ids.
    const CHECK_ID: i32 = 0xBF00;

    pub fn spawn(app: AppHandle) {
        std::thread::spawn(move || unsafe {
            let mut msg: MSG = std::mem::zeroed();
            // Makes the thread's message queue, so that messages posted to it arrive.
            PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
            STATE.lock().unwrap().thread = GetCurrentThreadId();
            reconcile(&app);
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                match msg.message {
                    WM_RECONCILE => reconcile(&app),
                    WM_HOTKEY => {
                        let i = (msg.wParam as usize).wrapping_sub(1);
                        if STATE.lock().unwrap().held.get(i).is_some_and(Option::is_some) {
                            let _ = app.emit_to("main", "perm-hotkey", ACTIONS[i]);
                        }
                    }
                    _ => {}
                }
            }
        });
    }

    pub fn wake(thread: u32) {
        if thread != 0 {
            unsafe { PostThreadMessageW(thread, WM_RECONCILE, 0, 0) };
        }
    }

    /// Registers and unregisters until the thread holds what is wanted, as far as other
    /// programs let it; one that couldn't be had is tried again on the next change.
    fn reconcile(app: &AppHandle) {
        let live = {
            let mut s = STATE.lock().unwrap();
            let wanted = s.wanted();
            let changed: Vec<usize> = (0..ACTIONS.len()).filter(|&i| s.held[i] != wanted[i]).collect();
            // All let go first: a combo may move from one action to another.
            for &i in &changed {
                if s.held[i].take().is_some() {
                    unsafe { UnregisterHotKey(std::ptr::null_mut(), i as i32 + 1) };
                }
            }
            for &i in &changed {
                if let Some(c) = wanted[i] {
                    if unsafe { RegisterHotKey(std::ptr::null_mut(), i as i32 + 1, c.mods | MOD_NOREPEAT, c.vk) } != 0 {
                        s.held[i] = Some(c);
                    }
                }
            }
            s.held.map(|h| h.is_some())
        };
        let _ = app.emit_to("main", "hotkeys", live);
    }

    /// No other program holds `c`: it can be registered (and is let go at once).
    pub fn free(c: Combo) -> bool {
        unsafe {
            let ok = RegisterHotKey(std::ptr::null_mut(), CHECK_ID, c.mods | MOD_NOREPEAT, c.vk) != 0;
            if ok {
                UnregisterHotKey(std::ptr::null_mut(), CHECK_ID);
            }
            ok
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Combo;

    pub fn spawn(_app: tauri::AppHandle) {}
    pub fn wake(_thread: u32) {}
    pub fn free(_c: Combo) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_combos() {
        assert_eq!(parse("Ctrl+Shift+Y"), Some(Combo { mods: CTRL | SHIFT, vk: b'Y' as u32 }));
        assert_eq!(parse("alt + 7"), Some(Combo { mods: ALT, vk: b'7' as u32 }));
        assert_eq!(parse("Win+Ctrl+F1"), Some(Combo { mods: WIN | CTRL, vk: 0x70 }));
        assert_eq!(parse("Ctrl+F24"), Some(Combo { mods: CTRL, vk: 0x87 }));
        assert_eq!(parse("Ctrl+a"), parse("Ctrl+A"));
    }

    #[test]
    fn refuses_what_it_cannot_hold() {
        for s in ["", "Y", "Shift+Y", "Ctrl+Ctrl+Y", "Ctrl+Meta+Y", "Ctrl+", "Ctrl+F0", "Ctrl+F25", "Ctrl+F01", "Ctrl+Space", "Ctrl+YY"] {
            assert_eq!(parse(s), None, "{s}");
        }
    }

    #[test]
    fn holds_only_while_the_bubble_wants() {
        let y = parse("Ctrl+Shift+Y");
        let mut s = State { combos: [y, parse("Ctrl+Shift+N"), parse("Ctrl+Shift+A")], ..State::default() };
        assert_eq!(s.wanted(), [None; 3]);
        s.bubble = [true, true, false];
        assert_eq!(s.wanted(), [y, parse("Ctrl+Shift+N"), None]);
        s.paused = true;
        assert_eq!(s.wanted(), [None; 3]);
    }

    #[test]
    fn switched_off_holds_nothing() {
        let cfg = HotkeyConfig { enabled: false, ..HotkeyConfig::default() };
        assert_eq!(combos(&cfg), [None; 3]);
        // "Always allow" has no combo until the user sets one.
        let [allow, deny, always] = combos(&HotkeyConfig::default());
        assert!(allow.is_some() && deny.is_some() && always.is_none());
    }

    #[test]
    fn a_combo_twice_counts_once() {
        let cfg = HotkeyConfig { enabled: true, allow: "Ctrl+Shift+Y".into(), deny: "shift + ctrl + y".into(), always: "Ctrl+Alt+A".into() };
        assert_eq!(combos(&cfg), [parse("Ctrl+Shift+Y"), None, parse("Ctrl+Alt+A")]);
    }
}
