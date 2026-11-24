//! Keeps the pet on its screen. Dragged against an edge of the monitor's work area,
//! the pet's body (`#pet-hit`, which the page reports) stops at it, and so does the
//! window's top, so the room above the pet for bubbles stays on screen. This happens
//! in `WM_MOVING`, while the system moves the window, so the pet stops at the edge
//! rather than jumping back after the drop.
//!
//! The window is wider than the pet, so at a side edge part of it is off screen. The
//! page hears how much of each side is (`edges` event, logical px) and keeps its
//! bubbles in the part that shows.
//!
//! Edge peek: the pet can also tuck itself behind the left or right side of the screen,
//! where nothing carries on past it (no other monitor, no taskbar). The page says where
//! the screen's edge is to cut the window (`peek`), which changes as the pet slides out
//! on hover and fully out for a bubble, and the window slides there. Dragged hard
//! against such a side, the pet tells the page (`peek-push` event), which tucks it in
//! there if it is dropped.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, WebviewWindow};

/// A side of the screen the pet can tuck itself behind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
}

/// How much of the window is past each edge of its monitor's work area, in logical px.
#[derive(Clone, Copy, Default, PartialEq, Serialize)]
pub struct Edges {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

/// The pet's body within the window, logical (x, y, width, height); None until the page says.
static BODY: Mutex<Option<[f64; 4]>> = Mutex::new(None);
static SENT: Mutex<Option<Edges>> = Mutex::new(None);
/// Tucked behind a side of the screen: the side, and where the screen's edge cuts the
/// window (logical px from its left), unknown after a restart until the page says.
static PEEK: Mutex<Option<(Side, Option<f64>)>> = Mutex::new(None);
/// While the pet is dragged: the side it is pushed hard against.
static PUSH: Mutex<Option<Side>> = Mutex::new(None);
/// Bumped to stop a slide in progress.
static SLIDE: AtomicU64 = AtomicU64::new(0);

/// Where the pet's body is in the window, as the page last said.
pub fn body() -> Option<[f64; 4]> {
    *BODY.lock().unwrap()
}

/// At startup: the side the pet was tucked behind when it quit. It stays put until the
/// page says where to cut it.
pub fn restore(side: Option<Side>) {
    *PEEK.lock().unwrap() = side.map(|s| (s, None));
}

pub fn peeking() -> Option<Side> {
    PEEK.lock().unwrap().map(|(s, _)| s)
}

/// Tucks the pet behind `side`, the screen's edge at `cut` (logical px from the
/// window's left), sliding it there; or, with no side, brings it back onto the screen.
/// False if it can't tuck in there (another monitor or the taskbar is on that side);
/// then it isn't peeking any more, and is put back on screen. Before the page has said
/// where the body is there is no telling, so the side is kept and `fit` judges it once
/// the body comes (`set_body`).
pub fn peek(w: &WebviewWindow, side: Option<Side>, cut: f64) -> bool {
    match side {
        Some(side) if body().is_none() => {
            *PEEK.lock().unwrap() = Some((side, Some(cut)));
            return true;
        }
        Some(side) if can_peek(w, side) => *PEEK.lock().unwrap() = Some((side, Some(cut))),
        Some(_) => {
            if PEEK.lock().unwrap().take().is_some() {
                slide(w);
            }
            return false;
        }
        None => {
            if PEEK.lock().unwrap().take().is_none() {
                return true;
            }
        }
    }
    slide(w);
    true
}

/// A drag began: out of peeking, and nothing pushed against yet.
pub fn drag_started() {
    SLIDE.fetch_add(1, Ordering::SeqCst);
    *PEEK.lock().unwrap() = None;
    *PUSH.lock().unwrap() = None;
}

/// From the page: where the pet's body is. Moves the window back onto the screen if a
/// new size took the body past an edge.
pub fn set_body(w: &WebviewWindow, body: [f64; 4]) {
    {
        let mut b = BODY.lock().unwrap();
        if *b == Some(body) {
            return;
        }
        *b = Some(body);
    }
    fit(w);
    tell(w);
}

/// Tells the page how much of the window is off screen, if that changed.
pub fn tell(w: &WebviewWindow) {
    let edges = current(w);
    {
        let mut sent = SENT.lock().unwrap();
        if *sent == Some(edges) {
            return;
        }
        *sent = Some(edges);
    }
    let _ = w.emit_to(w.label(), "edges", edges);
}

#[cfg(windows)]
pub use imp::{can_peek, current, fit, install, side_for, slide};

#[cfg(not(windows))]
pub fn current(_w: &WebviewWindow) -> Edges {
    Edges::default()
}
#[cfg(not(windows))]
pub fn fit(_w: &WebviewWindow) {}
#[cfg(not(windows))]
pub fn can_peek(_w: &WebviewWindow, _side: Side) -> bool {
    false
}
#[cfg(not(windows))]
pub fn side_for(_w: &WebviewWindow) -> Option<Side> {
    None
}
#[cfg(not(windows))]
pub fn slide(_w: &WebviewWindow) {}
#[cfg(not(windows))]
pub fn install(_app: &tauri::AppHandle, _w: &WebviewWindow) {}

#[cfg(windows)]
mod imp {
    use super::{Edges, Side, BODY, PEEK, PUSH, SLIDE};
    use std::mem::{size_of, zeroed};
    use std::sync::atomic::Ordering;
    use std::sync::OnceLock;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
    };
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowRect, SetWindowPos, SPI_SETWORKAREA, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
        WM_DISPLAYCHANGE, WM_DPICHANGED, WM_MOVING, WM_SETTINGCHANGE,
    };

    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// Dragged past a side by more than this share of its body, the pet is pushed hard
    /// against it.
    const PUSH_SHARE: f64 = 0.3;
    /// A slide takes this many steps, a frame apart.
    const SLIDE_STEPS: u32 = 12;

    fn hwnd(w: &WebviewWindow) -> Option<HWND> {
        w.hwnd().ok().map(|h| h.0 as HWND)
    }

    /// Must run on the thread that owns the window (Tauri's main thread).
    pub fn install(app: &AppHandle, w: &WebviewWindow) {
        let _ = APP.set(app.clone());
        if let Some(h) = hwnd(w) {
            unsafe {
                SetWindowSubclass(h, Some(subclass), 1, 0);
            }
        }
    }

    unsafe extern "system" fn subclass(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, _data: usize) -> LRESULT {
        let result = DefSubclassProc(h, msg, wp, lp);
        match msg {
            // Where the system is about to move the window to: on the monitor the
            // cursor is on, so that the pet can be dragged over to another one.
            WM_MOVING => {
                let r = &mut *(lp as *mut RECT);
                let mut cursor: POINT = zeroed();
                GetCursorPos(&mut cursor);
                note_push(pushed(h, r, cursor));
                if let Some((dx, dy)) = nudge(h, r, cursor) {
                    r.left += dx;
                    r.right += dx;
                    r.top += dy;
                    r.bottom += dy;
                }
                return 1;
            }
            // A monitor or the taskbar changed; or the window's DPI did, which tao
            // answers with its own SetWindowPos inside DefSubclassProc, so only now is
            // the window where it ends up.
            WM_DISPLAYCHANGE | WM_DPICHANGED | WM_SETTINGCHANGE
                if msg != WM_SETTINGCHANGE || wp == SPI_SETWORKAREA as usize =>
            {
                if let Some(w) = APP.get().and_then(|a| a.get_webview_window("main")) {
                    fit(&w);
                    super::tell(&w);
                }
            }
            _ => {}
        }
        result
    }

    fn scale(h: HWND) -> f64 {
        f64::from(unsafe { GetDpiForWindow(h) }.max(96)) / 96.0
    }

    /// The pet's body on screen for a window at `win`, physical px.
    fn body_at(h: HWND, win: &RECT) -> Option<RECT> {
        let [x, y, width, height] = (*BODY.lock().unwrap())?;
        let s = scale(h);
        let at = |base: i32, v: f64| base + (v * s).round() as i32;
        Some(RECT { left: at(win.left, x), top: at(win.top, y), right: at(win.left, x + width), bottom: at(win.top, y + height) })
    }

    /// The whole of the monitor at `p`, and its work area.
    fn monitor(p: POINT) -> Option<(RECT, RECT)> {
        unsafe {
            let mut info: MONITORINFO = zeroed();
            info.cbSize = size_of::<MONITORINFO>() as u32;
            (GetMonitorInfoW(MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST), &mut info) != 0).then_some((info.rcMonitor, info.rcWork))
        }
    }

    fn work_area(p: POINT) -> Option<RECT> {
        monitor(p).map(|(_, work)| work)
    }

    fn middle(r: &RECT) -> POINT {
        POINT { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }
    }

    /// How far to move a window at `win` to bring the pet's body, and the window's top,
    /// inside the work area of the monitor at `on`.
    fn nudge(h: HWND, win: &RECT, on: POINT) -> Option<(i32, i32)> {
        let body = body_at(h, win)?;
        let area = work_area(on)?;
        let dx = if body.left < area.left {
            area.left - body.left
        } else if body.right > area.right {
            area.right - body.right
        } else {
            0
        };
        Some((dx, rise(win, &body, &area)))
    }

    /// How far to move a window at `win` up or down to bring the pet's body, and the
    /// window's top, inside `area`.
    fn rise(win: &RECT, body: &RECT, area: &RECT) -> i32 {
        let mut dy = (area.bottom - body.bottom).min(0);
        // The window's top stays on screen too, for the bubbles' room, as far as that
        // leaves the body above the bottom: a window taller than the work area keeps
        // its body in it, and the page pulls the bubbles in from the top instead.
        if win.top + dy < area.top {
            dy = (area.top - win.top).min(area.bottom - body.bottom);
        }
        dy
    }

    /// A point of the pet's body that is on screen: tucked in, just inside the cut.
    fn inside(h: HWND, win: &RECT, body: &RECT) -> POINT {
        let mid = middle(body);
        match *PEEK.lock().unwrap() {
            Some((side, Some(cut))) => {
                let x = win.left + (cut * scale(h)).round() as i32;
                POINT { x: if side == Side::Right { x - 1 } else { x }, y: mid.y }
            }
            _ => mid,
        }
    }

    /// Whether the pet, its body at `body`, can tuck itself behind `side` of the
    /// monitor at `on`: that side of the work area is the screen's edge (no taskbar
    /// there), and no other monitor carries on past it at the body's height, where the
    /// part tucked away would show.
    fn open(body: &RECT, on: POINT, side: Side) -> bool {
        let Some((mon, work)) = monitor(on) else { return false };
        let (edge, past) = match side {
            Side::Left => (work.left == mon.left, mon.left - 1),
            Side::Right => (work.right == mon.right, mon.right),
        };
        edge && [body.top, body.bottom - 1]
            .into_iter()
            .all(|y| unsafe { MonitorFromPoint(POINT { x: past, y }, MONITOR_DEFAULTTONULL) }.is_null())
    }

    pub fn can_peek(w: &WebviewWindow, side: Side) -> bool {
        let Some(h) = hwnd(w) else { return false };
        let Some(win) = window_rect(h) else { return false };
        let Some(body) = body_at(h, &win) else { return false };
        open(&body, inside(h, &win, &body), side)
    }

    /// The side the pet would tuck itself behind: the nearer of the open ones.
    pub fn side_for(w: &WebviewWindow) -> Option<Side> {
        let h = hwnd(w)?;
        let win = window_rect(h)?;
        let body = body_at(h, &win)?;
        let on = inside(h, &win, &body);
        let area = work_area(on)?;
        let sides = if on.x - area.left <= area.right - on.x { [Side::Left, Side::Right] } else { [Side::Right, Side::Left] };
        sides.into_iter().find(|&side| open(&body, on, side))
    }

    /// The side a window the system is moving to `win` pushes the pet hard against, on
    /// the monitor at `on` (the cursor's), if the pet can tuck itself behind it.
    fn pushed(h: HWND, win: &RECT, on: POINT) -> Option<Side> {
        let body = body_at(h, win)?;
        let area = work_area(on)?;
        let hard = f64::from(body.right - body.left) * PUSH_SHARE;
        let side = if f64::from(area.left - body.left) > hard {
            Side::Left
        } else if f64::from(body.right - area.right) > hard {
            Side::Right
        } else {
            return None;
        };
        open(&body, on, side).then_some(side)
    }

    fn note_push(side: Option<Side>) {
        if std::mem::replace(&mut *PUSH.lock().unwrap(), side) != side {
            if let Some(app) = APP.get() {
                let _ = app.emit_to("main", "peek-push", side);
            }
        }
    }

    /// Where a window at `win` belongs: tucked in at the cut the page asked for, or else
    /// with the pet on the monitor it is mostly on. None while unknown.
    fn target(h: HWND, win: &RECT) -> Option<(i32, i32)> {
        let body = body_at(h, win)?;
        let peek = *PEEK.lock().unwrap();
        match peek {
            Some((side, Some(cut))) => {
                let area = work_area(inside(h, win, &body))?;
                let edge = if side == Side::Left { area.left } else { area.right };
                Some((edge - (cut * scale(h)).round() as i32, win.top + rise(win, &body, &area)))
            }
            // Tucked in before a restart: left where it is until the page says.
            Some((_, None)) => None,
            None => nudge(h, win, middle(&body)).map(|(dx, dy)| (win.left + dx, win.top + dy)),
        }
    }

    /// Slides the window to where it belongs (`target`), easing out over a fifth of a
    /// second. Another slide, a drag or a jump (`fit`) stops it.
    pub fn slide(w: &WebviewWindow) {
        let Some(h) = hwnd(w) else { return };
        let Some(from) = window_rect(h) else { return };
        let n = SLIDE.fetch_add(1, Ordering::SeqCst) + 1;
        let Some(to) = target(h, &from).filter(|&to| to != (from.left, from.top)) else { return };
        let h = h as usize; // a raw pointer can't go to another thread
        std::thread::spawn(move || {
            for i in 1..=SLIDE_STEPS {
                std::thread::sleep(Duration::from_millis(16));
                if SLIDE.load(Ordering::SeqCst) != n {
                    return;
                }
                let t = 1.0 - (1.0 - f64::from(i) / f64::from(SLIDE_STEPS)).powi(3);
                let at = |a: i32, b: i32| a + (f64::from(b - a) * t).round() as i32;
                unsafe {
                    SetWindowPos(h as HWND, std::ptr::null_mut(), at(from.left, to.0), at(from.top, to.1), 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                }
            }
        });
    }

    fn window_rect(h: HWND) -> Option<RECT> {
        let mut r: RECT = unsafe { zeroed() };
        (unsafe { GetWindowRect(h, &mut r) } != 0).then_some(r)
    }

    /// Moves the window, if need be, so the pet is on the monitor it is mostly on, or
    /// tucked in where the page cut it. Tucked behind a side that another monitor or
    /// the taskbar has since come to, it comes out, and the page hears so (`peek`).
    pub fn fit(w: &WebviewWindow) {
        let Some(h) = hwnd(w) else { return };
        let Some(win) = window_rect(h) else { return };
        if body_at(h, &win).is_none() {
            return;
        }
        if super::peeking().is_some_and(|side| !can_peek(w, side)) {
            *PEEK.lock().unwrap() = None;
            let _ = w.emit_to(w.label(), "peek", None::<Side>);
        }
        if let Some((x, y)) = target(h, &win).filter(|&to| to != (win.left, win.top)) {
            SLIDE.fetch_add(1, Ordering::SeqCst);
            unsafe {
                SetWindowPos(h, std::ptr::null_mut(), x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            }
        }
    }

    pub fn current(w: &WebviewWindow) -> Edges {
        let Some(h) = hwnd(w) else { return Edges::default() };
        let Some(win) = window_rect(h) else { return Edges::default() };
        // The pet's monitor; before the page says where the pet is, its usual spot.
        let on = body_at(h, &win).map_or(POINT { x: (win.left + win.right) / 2, y: win.bottom - 80 }, |b| inside(h, &win, &b));
        let Some(area) = work_area(on) else { return Edges::default() };
        let s = scale(h);
        let off = |n: i32| f64::from(n.max(0)) / s;
        Edges { left: off(area.left - win.left), top: off(area.top - win.top), right: off(win.right - area.right), bottom: off(win.bottom - area.bottom) }
    }
}
