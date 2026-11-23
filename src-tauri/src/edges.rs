//! Keeps the pet on its screen. Dragged against an edge of the monitor's work area,
//! the pet's body (`#pet-hit`, which the page reports) stops at it, and so does the
//! window's top, so the room above the pet for bubbles stays on screen. This happens
//! in `WM_MOVING`, while the system moves the window, so the pet stops at the edge
//! rather than jumping back after the drop.
//!
//! The window is wider than the pet, so at a side edge part of it is off screen. The
//! page hears how much of each side is (`edges` event, logical px) and keeps its
//! bubbles in the part that shows.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, WebviewWindow};

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
pub use imp::{current, fit, install};

#[cfg(not(windows))]
pub fn current(_w: &WebviewWindow) -> Edges {
    Edges::default()
}
#[cfg(not(windows))]
pub fn fit(_w: &WebviewWindow) {}
#[cfg(not(windows))]
pub fn install(_app: &tauri::AppHandle, _w: &WebviewWindow) {}

#[cfg(windows)]
mod imp {
    use super::{Edges, BODY};
    use std::mem::{size_of, zeroed};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Manager, WebviewWindow};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowRect, SetWindowPos, SPI_SETWORKAREA, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
        WM_DISPLAYCHANGE, WM_DPICHANGED, WM_MOVING, WM_SETTINGCHANGE,
    };

    static APP: OnceLock<AppHandle> = OnceLock::new();

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

    fn work_area(p: POINT) -> Option<RECT> {
        unsafe {
            let mut info: MONITORINFO = zeroed();
            info.cbSize = size_of::<MONITORINFO>() as u32;
            (GetMonitorInfoW(MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST), &mut info) != 0).then_some(info.rcWork)
        }
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
        let mut dy = (area.bottom - body.bottom).min(0);
        // The window's top stays on screen too, for the bubbles' room, as far as that
        // leaves the body above the bottom: a window taller than the work area keeps
        // its body in it, and the page pulls the bubbles in from the top instead.
        if win.top + dy < area.top {
            dy = (area.top - win.top).min(area.bottom - body.bottom);
        }
        Some((dx, dy))
    }

    fn window_rect(h: HWND) -> Option<RECT> {
        let mut r: RECT = unsafe { zeroed() };
        (unsafe { GetWindowRect(h, &mut r) } != 0).then_some(r)
    }

    /// Moves the window, if need be, so the pet is on the monitor it is mostly on.
    pub fn fit(w: &WebviewWindow) {
        let Some(h) = hwnd(w) else { return };
        let Some(win) = window_rect(h) else { return };
        let Some(body) = body_at(h, &win) else { return };
        if let Some((dx, dy)) = nudge(h, &win, middle(&body)).filter(|&d| d != (0, 0)) {
            unsafe {
                SetWindowPos(h, std::ptr::null_mut(), win.left + dx, win.top + dy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            }
        }
    }

    pub fn current(w: &WebviewWindow) -> Edges {
        let Some(h) = hwnd(w) else { return Edges::default() };
        let Some(win) = window_rect(h) else { return Edges::default() };
        // The pet's monitor; before the page says where the pet is, its usual spot.
        let on = body_at(h, &win).map_or(POINT { x: (win.left + win.right) / 2, y: win.bottom - 80 }, |b| middle(&b));
        let Some(area) = work_area(on) else { return Edges::default() };
        let s = scale(h);
        let off = |n: i32| f64::from(n.max(0)) / s;
        Edges { left: off(area.left - win.left), top: off(area.top - win.top), right: off(win.right - area.right), bottom: off(win.bottom - area.bottom) }
    }
}
