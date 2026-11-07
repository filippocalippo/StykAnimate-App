//! In-process questions about a window, for the application's `--shell-check`: each is a message sent to the window's own
//! procedure from its own thread (or a read of its state), never system input, so the check cannot reach another
//! program's window (decision N6).

use super::monitors::hwnd_of;
use raw_window_handle::HasWindowHandle;
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::UI::HiDpi::{AreDpiAwarenessContextsEqual, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow, GetWindowDpiAwarenessContext};
use windows_sys::Win32::UI::WindowsAndMessaging::{GWL_EXSTYLE, GetClientRect, GetForegroundWindow, GetWindowLongPtrW, MINMAXINFO, SendMessageW, WM_DPICHANGED, WM_GETMINMAXINFO, WM_NCHITTEST, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW};

fn handle(window: &dyn HasWindowHandle) -> Option<HWND> {
    hwnd_of(window)
}

/// What `WM_NCHITTEST` answers for a client point (physical pixels), asked of the window's own procedure.
pub fn hit_test_at(window: &dyn HasWindowHandle, x: i32, y: i32) -> Option<i32> {
    let hwnd = handle(window)?;
    let mut origin = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
    // SAFETY: converts the client origin to the screen and sends the window's own procedure a hit test.
    unsafe {
        windows_sys::Win32::Graphics::Gdi::ClientToScreen(hwnd, &mut origin);
        let (sx, sy) = (origin.x + x, origin.y + y);
        Some(SendMessageW(hwnd, WM_NCHITTEST, 0, ((sy as i16 as u16 as isize) << 16) | (sx as i16 as u16 as isize)) as i32)
    }
}

/// The client area's size in physical pixels.
pub fn client_size(window: &dyn HasWindowHandle) -> Option<(i32, i32)> {
    let hwnd = handle(window)?;
    // SAFETY: a read of the client rectangle.
    unsafe {
        let mut r: RECT = std::mem::zeroed();
        (GetClientRect(hwnd, &mut r) != 0).then_some((r.right, r.bottom))
    }
}

/// Whether the window's DPI awareness is per-monitor v2.
pub fn is_per_monitor_v2(window: &dyn HasWindowHandle) -> Option<bool> {
    let hwnd = handle(window)?;
    // SAFETY: reads the window's awareness context and compares it.
    Some(unsafe { AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(hwnd), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != 0 })
}

/// The window's DPI.
pub fn dpi(window: &dyn HasWindowHandle) -> Option<u32> {
    // SAFETY: a read of the window's DPI.
    handle(window).map(|hwnd| unsafe { GetDpiForWindow(hwnd) })
}

/// The smallest size the window allows itself (`WM_GETMINMAXINFO`), in physical pixels.
pub fn min_track_size(window: &dyn HasWindowHandle) -> Option<(i32, i32)> {
    let hwnd = handle(window)?;
    // SAFETY: the structure outlives the synchronous message.
    unsafe {
        let mut info: MINMAXINFO = std::mem::zeroed();
        SendMessageW(hwnd, WM_GETMINMAXINFO, 0, &mut info as *mut _ as isize);
        Some((info.ptMinTrackSize.x, info.ptMinTrackSize.y))
    }
}

/// Tells the window its monitor's DPI changed, as the system does when the window crosses to a monitor of another
/// scale: `suggested` is the rectangle the system would suggest. The window's own procedure resizes itself to it.
pub fn send_dpi_changed(window: &dyn HasWindowHandle, new_dpi: u32, suggested: styk_services::shell::Rect) -> Option<()> {
    let hwnd = handle(window)?;
    let suggested = RECT { left: suggested.x, top: suggested.y, right: suggested.right(), bottom: suggested.bottom() };
    // SAFETY: `suggested` outlives the synchronous message.
    unsafe { SendMessageW(hwnd, WM_DPICHANGED, ((new_dpi as usize) << 16) | new_dpi as usize, &suggested as *const _ as isize) };
    Some(())
}

/// Whether the window is a tool window without an application-window style: it has no taskbar button.
pub fn has_no_taskbar_button(window: &dyn HasWindowHandle) -> Option<bool> {
    let hwnd = handle(window)?;
    // SAFETY: a read of the window's extended style.
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    Some(style & WS_EX_TOOLWINDOW != 0 && style & WS_EX_APPWINDOW == 0)
}

/// The window that has the keyboard now, as a number (zero for none), to see whether it changed.
pub fn foreground() -> isize {
    // SAFETY: a read.
    unsafe { GetForegroundWindow() as isize }
}

/// Moves and sizes the window to a rectangle (screen coordinates) and reads back the rectangle it ended with, so a
/// check can see the minimum size at work. The window is not activated or re-ordered.
pub fn place(window: &dyn HasWindowHandle, rect: styk_services::shell::Rect) -> Option<styk_services::shell::Rect> {
    let hwnd = handle(window)?;
    // SAFETY: moves the window the check was given.
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            rect.x,
            rect.y,
            rect.w,
            rect.h,
            windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOZORDER | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE,
        );
    }
    super::monitors::window_rect(hwnd)
}
