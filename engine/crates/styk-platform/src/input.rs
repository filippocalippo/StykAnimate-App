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

/// Whether the primary mouse button is down right now, as the system sees it (a read, never an injection). A scrub
/// uses it to notice that mouse capture was lost to another window without any event saying so. Where the platform has no
/// way to ask, it says `true`: nothing is cancelled that cannot be known to be over.
pub fn primary_button_down() -> bool {
    imp::primary_button_down()
}

/// The phases of an input-method composition the window is told about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImePhase {
    /// `WM_IME_STARTCOMPOSITION`.
    Start,
    /// `WM_IME_COMPOSITION` with the composition string and the cursor.
    Update,
    /// `WM_IME_ENDCOMPOSITION`.
    End,
}

/// Delivers an input-method composition message to the window, as an installed input method would after it changed the
/// composition string (see [`compose`]). Without an input method installed nothing sends these by itself, so a check on
/// such a machine sends them; it proves the window's handling, not an input method.
pub fn send_ime(window: &dyn HasWindowHandle, phase: ImePhase) -> Result<(), WindowError> {
    imp::send_ime(window.window_handle().map_err(|_| WindowError::NoWindow)?.as_raw(), phase)
}

/// Posts a key press (`down`) or release of `vk` to the window, as the keyboard driver would. A press also posts the
/// characters the thread's current layout gives the key (`WM_CHAR`, one per UTF-16 unit), as the system's message
/// translation does for a real key.
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
        CANDIDATEFORM, CPS_COMPLETE, GCS_COMPSTR, GCS_CURSORPOS, ImmGetCandidateWindow, ImmGetContext, ImmNotifyIME, ImmReleaseContext, ImmSetCompositionStringW, NI_COMPOSITIONSTR, SCS_SETSTR,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        ActivateKeyboardLayout, GetAsyncKeyState, LoadKeyboardLayoutW, MapVirtualKeyExW, ToUnicodeEx, VK_LBUTTON, VK_RBUTTON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, PostMessageW, SM_SWAPBUTTON, SendMessageW, WM_CHAR, WM_IME_COMPOSITION, WM_IME_ENDCOMPOSITION, WM_IME_STARTCOMPOSITION, WM_KEYDOWN, WM_KEYUP};

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

    pub fn primary_button_down() -> bool {
        // SAFETY: both calls read system state and take plain values.
        unsafe {
            let key = if GetSystemMetrics(SM_SWAPBUTTON) != 0 { VK_RBUTTON } else { VK_LBUTTON };
            GetAsyncKeyState(i32::from(key)) < 0
        }
    }

    pub fn send_ime(handle: RawWindowHandle, phase: super::ImePhase) -> Result<(), WindowError> {
        let hwnd = hwnd(handle)?;
        let (message, flags) = match phase {
            super::ImePhase::Start => (WM_IME_STARTCOMPOSITION, 0),
            super::ImePhase::Update => (WM_IME_COMPOSITION, (GCS_COMPSTR | GCS_CURSORPOS) as isize),
            super::ImePhase::End => (WM_IME_ENDCOMPOSITION, 0),
        };
        // SAFETY: SendMessageW runs the window's own procedure on this thread with plain values.
        unsafe {
            SendMessageW(hwnd, message, 0, flags);
        }
        Ok(())
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
            if down {
                let state = [0u8; 256];
                let mut buffer = [0u16; 8];
                let count = ToUnicodeEx(u32::from(vk), scan, state.as_ptr(), buffer.as_mut_ptr(), buffer.len() as i32, 0, layout);
                for &unit in &buffer[..count.max(0) as usize] {
                    if PostMessageW(hwnd, WM_CHAR, usize::from(unit), flags as isize) == 0 {
                        return Err(os("PostMessageW"));
                    }
                }
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

    pub fn send_ime(_: RawWindowHandle, _: super::ImePhase) -> Result<(), WindowError> {
        Err(WindowError::Unsupported)
    }

    pub fn primary_button_down() -> bool {
        true
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
