//! Keyboard-layout and input-method automation, for checks that need the real operating system's input path.
//!
//! An input-method context and a keyboard layout belong to the thread that owns the window, so every function here must be
//! called on the window's UI thread (in iced: from the closure of `window::run`). Together they let a check drive the
//! same path a person's typing takes, without the keyboard and without a window in front: switch the thread to a
//! layout (Arabic, Hebrew), post the key, set and complete an IME composition, and read where the candidate window was
//! asked to appear. They exist for the developer build's input check and the tests; the application never calls them.

use crate::window::WindowError;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

/// Where the candidate window was asked to appear, in client coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// The style flags the application set (`CFS_EXCLUDE`, `CFS_CANDIDATEPOS`, ...).
    pub style: u32,
    /// The point the application gave: for `CFS_EXCLUDE` the caret's interest point.
    pub x: i32,
    pub y: i32,
    /// The exclude rectangle (left, top, right, bottom), when the style has one.
    pub exclude: (i32, i32, i32, i32),
}

/// Makes the calling thread use the keyboard layout `klid` ("00000401" is Arabic, "0000040D" Hebrew). The layout files ship
/// with Windows; no language pack is installed. Returns the layout handle.
pub fn activate_layout(klid: &str) -> Result<u64, WindowError> {
    imp::activate_layout(klid)
}

/// The text the layout `klid` gives the key `vk` with no modifiers (a key can give several scalars: the Arabic layout's
/// `B` key gives lam-alef).
pub fn key_text(klid: &str, vk: u16) -> Result<String, WindowError> {
    imp::key_text(klid, vk)
}

/// Posts a key press (`down`) or release of `vk` to the window, as the keyboard driver would.
pub fn post_key(window: &dyn HasWindowHandle, vk: u16, down: bool) -> Result<(), WindowError> {
    imp::post_key(window.window_handle().map_err(|_| WindowError::NoWindow)?.as_raw(), vk, down)
}

/// Sets the composition string of the window's input context (what an IME does while the user types).
pub fn compose(window: &dyn HasWindowHandle, text: &str) -> Result<(), WindowError> {
    imp::compose(window.window_handle().map_err(|_| WindowError::NoWindow)?.as_raw(), text)
}

/// Completes the composition (the user chooses a candidate or presses Enter).
pub fn complete(window: &dyn HasWindowHandle) -> Result<(), WindowError> {
    imp::complete(window.window_handle().map_err(|_| WindowError::NoWindow)?.as_raw())
}

/// Where the application asked for the candidate window.
pub fn candidate(window: &dyn HasWindowHandle) -> Result<Option<Candidate>, WindowError> {
    imp::candidate(window.window_handle().map_err(|_| WindowError::NoWindow)?.as_raw())
}

#[cfg(windows)]
mod imp {
    use super::{Candidate, RawWindowHandle, WindowError};
    use windows_sys::Win32::Foundation::{GetLastError, HWND};
    use windows_sys::Win32::UI::Input::Ime::{
        CANDIDATEFORM, CPS_COMPLETE, ImmGetCandidateWindow, ImmGetContext, ImmNotifyIME, ImmReleaseContext, ImmSetCompositionStringW, NI_COMPOSITIONSTR, SCS_SETSTR,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{ActivateKeyboardLayout, LoadKeyboardLayoutW, MapVirtualKeyExW, ToUnicodeEx};
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_KEYDOWN, WM_KEYUP};

    const MAPVK_VK_TO_VSC: u32 = 0;
    const KLF_NOTELLSHELL: u32 = 0x80;

    fn hwnd(handle: RawWindowHandle) -> Result<HWND, WindowError> {
        match handle {
            RawWindowHandle::Win32(handle) => Ok(handle.hwnd.get() as HWND),
            _ => Err(WindowError::NoWindow),
        }
    }

    fn os(what: &'static str) -> WindowError {
        // SAFETY: GetLastError reads the calling thread's last-error value.
        WindowError::Os(what, unsafe { GetLastError() })
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn activate_layout(klid: &str) -> Result<u64, WindowError> {
        let id = wide(klid);
        // SAFETY: `id` is a NUL-terminated UTF-16 string that outlives the call.
        let layout = unsafe { LoadKeyboardLayoutW(id.as_ptr(), KLF_NOTELLSHELL) };
        if layout.is_null() {
            return Err(os("LoadKeyboardLayoutW"));
        }
        // SAFETY: `layout` is a layout handle just returned by the system.
        let previous = unsafe { ActivateKeyboardLayout(layout, 0) };
        if previous.is_null() {
            return Err(os("ActivateKeyboardLayout"));
        }
        Ok(layout as usize as u64)
    }

    pub fn key_text(klid: &str, vk: u16) -> Result<String, WindowError> {
        let id = wide(klid);
        // SAFETY: as in `activate_layout`; the buffers below are sized for the lengths passed.
        unsafe {
            let layout = LoadKeyboardLayoutW(id.as_ptr(), 0);
            if layout.is_null() {
                return Err(os("LoadKeyboardLayoutW"));
            }
            let scan = MapVirtualKeyExW(u32::from(vk), MAPVK_VK_TO_VSC, layout);
            let state = [0u8; 256];
            let mut buffer = [0u16; 8];
            let count = ToUnicodeEx(u32::from(vk), scan, state.as_ptr(), buffer.as_mut_ptr(), buffer.len() as i32, 0, layout);
            Ok(String::from_utf16_lossy(&buffer[..count.max(0) as usize]))
        }
    }

    pub fn post_key(handle: RawWindowHandle, vk: u16, down: bool) -> Result<(), WindowError> {
        let hwnd = hwnd(handle)?;
        // SAFETY: MapVirtualKeyW and PostMessageW take plain values; the window handle is live.
        unsafe {
            let layout = windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout(0);
            let scan = MapVirtualKeyExW(u32::from(vk), MAPVK_VK_TO_VSC, layout);
            let repeat_and_scan = 1usize | ((scan as usize) << 16);
            let (message, flags) = if down { (WM_KEYDOWN, repeat_and_scan) } else { (WM_KEYUP, repeat_and_scan | (1 << 30) | (1 << 31)) };
            if PostMessageW(hwnd, message, usize::from(vk), flags as isize) == 0 {
                return Err(os("PostMessageW"));
            }
        }
        Ok(())
    }

    pub fn compose(handle: RawWindowHandle, text: &str) -> Result<(), WindowError> {
        let hwnd = hwnd(handle)?;
        let units = wide(text);
        // SAFETY: the input context is released on every path; the string pointer and length describe `units`.
        unsafe {
            let context = ImmGetContext(hwnd);
            if context.is_null() {
                return Err(WindowError::Os("ImmGetContext", 0));
            }
            let bytes = (units.len() * 2) as u32;
            let ok = ImmSetCompositionStringW(context, SCS_SETSTR, units.as_ptr().cast(), bytes, std::ptr::null(), 0);
            let result = if ok == 0 { Err(os("ImmSetCompositionStringW")) } else { Ok(()) };
            ImmReleaseContext(hwnd, context);
            result
        }
    }

    pub fn complete(handle: RawWindowHandle) -> Result<(), WindowError> {
        let hwnd = hwnd(handle)?;
        // SAFETY: as in `compose`.
        unsafe {
            let context = ImmGetContext(hwnd);
            if context.is_null() {
                return Err(WindowError::Os("ImmGetContext", 0));
            }
            let ok = ImmNotifyIME(context, NI_COMPOSITIONSTR, CPS_COMPLETE, 0);
            let result = if ok == 0 { Err(os("ImmNotifyIME")) } else { Ok(()) };
            ImmReleaseContext(hwnd, context);
            result
        }
    }

    pub fn candidate(handle: RawWindowHandle) -> Result<Option<Candidate>, WindowError> {
        let hwnd = hwnd(handle)?;
        // SAFETY: as in `compose`; `form` is a plain struct the call fills.
        unsafe {
            let context = ImmGetContext(hwnd);
            if context.is_null() {
                return Err(WindowError::Os("ImmGetContext", 0));
            }
            let mut form: CANDIDATEFORM = std::mem::zeroed();
            let ok = ImmGetCandidateWindow(context, 0, &mut form);
            ImmReleaseContext(hwnd, context);
            if ok == 0 {
                return Ok(None);
            }
            Ok(Some(Candidate {
                style: form.dwStyle,
                x: form.ptCurrentPos.x,
                y: form.ptCurrentPos.y,
                exclude: (form.rcArea.left, form.rcArea.top, form.rcArea.right, form.rcArea.bottom),
            }))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{Candidate, RawWindowHandle, WindowError};

    pub fn activate_layout(_: &str) -> Result<u64, WindowError> {
        Err(WindowError::Unsupported)
    }

    pub fn key_text(_: &str, _: u16) -> Result<String, WindowError> {
        Err(WindowError::Unsupported)
    }

    pub fn post_key(_: RawWindowHandle, _: u16, _: bool) -> Result<(), WindowError> {
        Err(WindowError::Unsupported)
    }

    pub fn compose(_: RawWindowHandle, _: &str) -> Result<(), WindowError> {
        Err(WindowError::Unsupported)
    }

    pub fn complete(_: RawWindowHandle) -> Result<(), WindowError> {
        Err(WindowError::Unsupported)
    }

    pub fn candidate(_: RawWindowHandle) -> Result<Option<Candidate>, WindowError> {
        Err(WindowError::Unsupported)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn the_arabic_layouts_b_key_gives_lam_alef_as_two_scalars() {
        assert_eq!(key_text("00000401", 0x42).unwrap(), "\u{644}\u{627}");
    }

    #[test]
    fn a_plain_letter_gives_one_scalar_in_the_us_layout() {
        assert_eq!(key_text("00000409", 0x42).unwrap(), "b");
    }
}
