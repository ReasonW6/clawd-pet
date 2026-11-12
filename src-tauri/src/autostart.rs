//! "Start with Windows": a value under HKCU\…\Run that points at this executable.

/// A dev build only works next to its dev server, so it is never registered.
pub fn available() -> bool {
    cfg!(windows) && !cfg!(debug_assertions)
}

fn command() -> Option<String> {
    std::env::current_exe().ok().map(|exe| format!("\"{}\"", exe.display()))
}

pub fn enabled() -> bool {
    imp::registered().is_some()
}

pub fn set(enable: bool) -> Result<(), String> {
    if !available() {
        return Err("开发模式下不能设置开机自启".into());
    }
    let ok = if enable {
        command().is_some_and(|cmd| imp::register(&cmd))
    } else {
        imp::unregister() || !enabled()
    };
    ok.then_some(()).ok_or_else(|| "写入注册表失败".into())
}

/// Re-point the entry at this executable if the app was moved or reinstalled.
pub fn refresh() {
    if !available() {
        return;
    }
    if let (Some(registered), Some(cmd)) = (imp::registered(), command()) {
        if registered != cmd {
            imp::register(&cmd);
        }
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };

    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "ClawdPet";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    pub fn registered() -> Option<String> {
        let (key, name) = (wide(KEY), wide(NAME));
        let mut buf = [0u16; 1024];
        let mut bytes = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        // `bytes` includes the terminating NUL.
        (rc == 0).then(|| String::from_utf16_lossy(&buf[..(bytes as usize / 2).saturating_sub(1)]))
    }

    pub fn register(command: &str) -> bool {
        let (key, name, data) = (wide(KEY), wide(NAME), wide(command));
        let bytes = (data.len() * 2) as u32;
        unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr(), REG_SZ, data.as_ptr().cast(), bytes) == 0 }
    }

    pub fn unregister() -> bool {
        let (key, name) = (wide(KEY), wide(NAME));
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) == 0 }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn registered() -> Option<String> {
        None
    }
    pub fn register(_command: &str) -> bool {
        false
    }
    pub fn unregister() -> bool {
        false
    }
}
