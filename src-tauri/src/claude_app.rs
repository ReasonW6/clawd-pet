//! Brings the Claude desktop app to the front, on one of its Code sessions.
//!
//! The app has no link for that: `claude://code/<id>` is gated off and wants an id
//! only the app knows, not the session id hooks report. So the session is clicked in
//! the app's sidebar through UI Automation, found by its title (each row is a button
//! named after it, maybe followed by a status such as "运行中"). When that fails the
//! app is still brought to the front.

/// Must be called while the pet is the foreground window (right after a click on
/// it), or Windows won't let it hand the foreground over.
#[cfg(windows)]
pub fn focus(title: Option<String>) {
    let Some(hwnd) = crate::sysmon::claude_app().and_then(imp::main_window) else {
        // Not running, or only in the tray: the link starts it or shows its window.
        imp::open("claude://code");
        return;
    };
    imp::raise(hwnd);
    if let Some(title) = title.filter(|t| !t.is_empty()) {
        std::thread::spawn(move || imp::click_session(hwnd, &title));
    }
}

#[cfg(not(windows))]
pub fn focus(_title: Option<String>) {}

#[cfg(windows)]
mod imp {
    use std::time::Duration;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationInvokePattern, TreeScope_Descendants, UIA_ButtonControlTypeId,
        UIA_ControlTypePropertyId, UIA_InvokePatternId,
    };
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE, SW_SHOWNORMAL,
    };
    use windows::core::{BOOL, HSTRING, PCWSTR};

    /// The app's visible, titled top-level window. Handles go between threads as numbers.
    pub fn main_window(pid: u32) -> Option<usize> {
        struct Search {
            pid: u32,
            found: Option<usize>,
        }
        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let s = &mut *(lparam.0 as *mut Search);
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid());
            if pid == s.pid && IsWindowVisible(hwnd).as_bool() && !owned && GetWindowTextLengthW(hwnd) > 0 {
                s.found = Some(hwnd.0 as usize);
                return false.into();
            }
            true.into()
        }
        let mut s = Search { pid, found: None };
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut s as *mut Search as isize));
        }
        s.found
    }

    pub fn raise(hwnd: usize) {
        let hwnd = HWND(hwnd as _);
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let _ = SetForegroundWindow(hwnd);
        }
    }

    pub fn open(url: &str) {
        unsafe {
            ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(url), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
        }
    }

    /// Clicks the sidebar row of the session titled `title`. The app builds its
    /// accessibility tree only once something asks for it, so the first look may
    /// come back short: a few tries.
    pub fn click_session(hwnd: usize, title: &str) {
        unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                return;
            }
            for _ in 0..5 {
                if try_click(HWND(hwnd as _), title).unwrap_or(false) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(400));
            }
            CoUninitialize();
        }
    }

    unsafe fn try_click(hwnd: HWND, title: &str) -> windows::core::Result<bool> {
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let root = uia.ElementFromHandle(hwnd)?;
        let buttons = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_ButtonControlTypeId.0))?;
        let all = root.FindAll(TreeScope_Descendants, &buttons)?;
        let row = format!("{title} ");
        // Another session's title may start with this one ("Fix bug in parser" for
        // "Fix bug"): an exact name wins, otherwise the shortest, which leaves the
        // least room for anything but a status.
        let mut best: Option<(usize, IUIAutomationInvokePattern)> = None;
        for i in 0..all.Length()? {
            let e = all.GetElement(i)?;
            let name = e.CurrentName()?.to_string();
            // "<title> 的更多选项" is the row's menu button; it has no Invoke pattern anyway.
            if name != title && !(name.starts_with(&row) && !name.ends_with("的更多选项")) {
                continue;
            }
            if best.as_ref().is_some_and(|(len, _)| *len <= name.len()) {
                continue;
            }
            if let Ok(invoke) = e.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                if name == title {
                    invoke.Invoke()?;
                    return Ok(true);
                }
                best = Some((name.len(), invoke));
            }
        }
        match best {
            Some((_, invoke)) => invoke.Invoke().map(|_| true),
            None => Ok(false),
        }
    }
}
