//! In-process automation addressed only to the app's own window; never desktop input injection.
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use crate::window::WindowError;

/// Posts a left-button click in physical client coordinates, exclusively in an unattended window.
pub fn click(window: &dyn HasWindowHandle, point: [f64; 2]) -> Result<(), WindowError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP};
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;
    use windows_sys::Win32::Foundation::GetLastError;
    if crate::unattended::requested_by_environment().ok().flatten() != Some(crate::unattended::Strategy::HiddenWindow) { return Err(WindowError::Unsupported); }
    let RawWindowHandle::Win32(handle) = window.window_handle().map_err(|_| WindowError::NoWindow)?.as_raw() else { return Err(WindowError::NoWindow); };
    if !point.iter().all(|value| value.is_finite() && *value >= 0. && *value <= i16::MAX as f64) { return Err(WindowError::NoWindow); }
    let packed = ((point[1].round() as u32) << 16 | point[0].round() as u32) as isize;
    let hwnd = handle.hwnd.get() as _;
    // SAFETY: called by window::run on this window's thread. No data or pointer is retained.
    if unsafe { SetWindowSubclass(hwnd, Some(unattended_pointer), SUBCLASS_ID, 0) } == 0 { return Err(WindowError::Os("SetWindowSubclass", unsafe { GetLastError() })); }
    for (message, buttons) in [(WM_MOUSEMOVE, 0), (WM_LBUTTONDOWN, 1), (WM_LBUTTONUP, 0)] {
        // SAFETY: the toolkit supplies this live app window, never an external PID or desktop target.
        if unsafe { PostMessageW(hwnd, message, buttons, packed) } == 0 { return Err(WindowError::Os("PostMessageW", unsafe { GetLastError() })); }
    }
    Ok(())
}

const SUBCLASS_ID: usize = crate::input::windows::subclass_id::AUTOMATION;

/// The real desktop pointer stays elsewhere. Windows immediately posts MouseLeave after a scripted
/// move into the off-screen window; iced would then see an unavailable cursor for the entire batch.
/// This unattended-only hook keeps the script's cursor until its next move. It owns no allocations.
unsafe extern "system" fn unattended_pointer(hwnd: windows_sys::Win32::Foundation::HWND, msg: u32, wparam: usize, lparam: isize, _: usize, _: usize) -> isize {
    use windows_sys::Win32::UI::Controls::WM_MOUSELEAVE;
    use windows_sys::Win32::UI::WindowsAndMessaging::WM_NCDESTROY;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass};
    if msg == WM_MOUSELEAVE { return 0; }
    if msg == WM_NCDESTROY { unsafe { RemoveWindowSubclass(hwnd, Some(unattended_pointer), SUBCLASS_ID); } }
    // SAFETY: forwards the unmodified window message through the subclass chain.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Type a numeric value into the focused field. Focusing a number field selects its contents.
pub fn number(window: &dyn HasWindowHandle, text: &str) -> Result<(), WindowError> {
    for ch in text.chars() {
        let vk = match ch { '0'..='9' => ch as u16, '-' => 0xBD, '.' => 0xBE, _ => return Err(WindowError::NoWindow) };
        crate::input::post_key(window, vk, true)?;
        crate::input::post_key(window, vk, false)?;
    }
    crate::input::post_key(window, 0x0D, true)?;
    crate::input::post_key(window, 0x0D, false)
}
