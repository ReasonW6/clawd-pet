//! A screenshot of the monitor the pet is on, for the AI chat to look at. The pet's own
//! window (the chat bubbles included) is left out of it.

/// Longest edge and pixel count the shot is scaled down to: what vision models take
/// in without scaling it down again themselves.
#[cfg(windows)]
const MAX_EDGE: f64 = 1568.0;
#[cfg(windows)]
const MAX_PIXELS: f64 = 1_150_000.0;
#[cfg(windows)]
const QUALITY: u8 = 80;

/// JPEG of the monitor under the screen point (x, y); `hwnd` is the pet's window.
#[cfg(windows)]
pub fn capture(hwnd: isize, x: i32, y: i32) -> Result<Vec<u8>, String> {
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, GetDC, GetMonitorInfoW, MonitorFromPoint,
        ReleaseDC, SelectObject, SetBrushOrgEx, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};

    unsafe {
        let monitor = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = zeroed();
        info.cbSize = size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return Err("找不到屏幕".into());
        }
        let r = info.rcMonitor;
        let (w, h) = (r.right - r.left, r.bottom - r.top);
        let scale = (MAX_EDGE / w.max(h) as f64).min((MAX_PIXELS / (w as f64 * h as f64)).sqrt()).min(1.0);
        let (dw, dh) = (((w as f64 * scale) as i32).max(1), ((h as f64 * scale) as i32).max(1));

        // Leave the pet out. The compositor applies this on its next frame.
        let pet = hwnd as *mut std::ffi::c_void;
        let hidden = SetWindowDisplayAffinity(pet, WDA_EXCLUDEFROMCAPTURE) != 0;
        if hidden {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        let screen = GetDC(null_mut());
        let mem = CreateCompatibleDC(screen);
        let mut bmi: BITMAPINFO = zeroed();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: dw,
            biHeight: -dh, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB as _,
            ..zeroed()
        };
        let mut bits = null_mut();
        let dib = CreateDIBSection(screen, &bmi, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
        let mut pixels = Vec::new();
        if !dib.is_null() && !bits.is_null() {
            let old = SelectObject(mem, dib);
            SetStretchBltMode(mem, HALFTONE);
            SetBrushOrgEx(mem, 0, 0, null_mut());
            if StretchBlt(mem, 0, 0, dw, dh, screen, r.left, r.top, w, h, SRCCOPY | CAPTUREBLT) != 0 {
                GdiFlush();
                pixels = std::slice::from_raw_parts(bits as *const u8, (dw * dh * 4) as usize).to_vec();
            }
            SelectObject(mem, old);
            DeleteObject(dib);
        }
        DeleteDC(mem);
        ReleaseDC(null_mut(), screen);
        if hidden {
            SetWindowDisplayAffinity(pet, WDA_NONE);
        }
        if pixels.is_empty() {
            return Err("截图失败".into());
        }

        let mut jpeg = Vec::new();
        jpeg_encoder::Encoder::new(&mut jpeg, QUALITY)
            .encode(&pixels, dw as u16, dh as u16, jpeg_encoder::ColorType::Bgra)
            .map_err(|e| e.to_string())?;
        Ok(jpeg)
    }
}

#[cfg(not(windows))]
pub fn capture(_hwnd: isize, _x: i32, _y: i32) -> Result<Vec<u8>, String> {
    Err("这个系统上还不能截图".into())
}
