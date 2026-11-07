//! Monitors, and reading and restoring the window's frame in screen coordinates.

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::mem::{size_of, zeroed};
use styk_services::shell::Rect;
use styk_services::shell::window_state::{MonitorInfo, MonitorSource, WindowFrame, monitor_for};
use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic, IsZoomed, SW_MAXIMIZE, SW_SHOWNOACTIVATE, SW_SHOWNORMAL, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos, ShowWindow};

const PRIMARY: u32 = 1; // MONITORINFOF_PRIMARY

/// The real monitors.
pub struct WindowsMonitors;

impl MonitorSource for WindowsMonitors {
    fn monitors(&self) -> Vec<MonitorInfo> {
        monitors()
    }
}

fn rect(r: RECT) -> Rect {
    Rect::new(r.left, r.top, r.right - r.left, r.bottom - r.top)
}

unsafe fn info(handle: HMONITOR) -> Option<MonitorInfo> {
    // SAFETY: `handle` came from the system's own enumeration or `MonitorFromWindow`; `data` is a plain struct.
    unsafe {
        let mut data: MONITORINFO = zeroed();
        data.cbSize = size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(handle, &mut data) == 0 {
            return None;
        }
        let (mut x, mut y) = (96u32, 96u32);
        if GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut x, &mut y) != 0 || x == 0 {
            x = 96;
        }
        Some(MonitorInfo { rect: rect(data.rcMonitor), work: rect(data.rcWork), scale_milli: x * 1000 / 96, primary: data.dwFlags & PRIMARY != 0 })
    }
}

unsafe extern "system" fn collect(handle: HMONITOR, _: HDC, _: *mut RECT, out: LPARAM) -> i32 {
    // SAFETY: `out` is the `Vec` that `monitors` passes and keeps alive for the whole enumeration.
    unsafe {
        if let Some(found) = info(handle) {
            (*(out as *mut Vec<MonitorInfo>)).push(found);
        }
    }
    1
}

/// Every attached monitor: physical pixels, the work area without the taskbar, and the scale.
pub fn monitors() -> Vec<MonitorInfo> {
    let mut found: Vec<MonitorInfo> = Vec::new();
    // SAFETY: the callback only pushes into `found`, which outlives the call.
    unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(collect), &mut found as *mut _ as LPARAM) };
    found
}

/// The monitor a window is mostly on.
pub fn monitor_of(hwnd: HWND) -> Option<MonitorInfo> {
    // SAFETY: a window handle in, a monitor handle out.
    unsafe { info(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)) }
}

pub fn hwnd_of(window: &dyn HasWindowHandle) -> Option<HWND> {
    match window.window_handle().ok()?.as_raw() {
        RawWindowHandle::Win32(handle) => Some(handle.hwnd.get() as HWND),
        _ => None,
    }
}

/// What the window looks like at one moment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    /// Its rectangle, unless it is maximized or minimized (then it is not the restore rectangle).
    pub normal: Option<Rect>,
    /// Maximized.
    pub maximized: bool,
    /// The scale of the monitor it is on.
    pub scale_milli: u32,
}

/// Looks at the window now.
pub fn sample(hwnd: HWND) -> Sample {
    // SAFETY: reads of a window's state.
    unsafe {
        let maximized = IsZoomed(hwnd) != 0;
        let normal = if maximized || IsIconic(hwnd) != 0 { None } else { window_rect(hwnd) };
        Sample { normal, maximized, scale_milli: monitor_of(hwnd).map_or(1000, |m| m.scale_milli) }
    }
}

/// Remembers the window's restore rectangle: the last rectangle it had while neither maximized nor minimized.
#[derive(Clone, Copy, Debug, Default)]
pub struct FrameTracker {
    normal: Option<Rect>,
    maximized: bool,
    scale_milli: u32,
}

impl FrameTracker {
    /// Takes in a sample; call after every move, resize and state change.
    pub fn observe(&mut self, sample: Sample) {
        self.maximized = sample.maximized;
        if let Some(rect) = sample.normal {
            self.normal = Some(rect);
            self.scale_milli = sample.scale_milli;
        }
    }

    /// The frame to save, or nothing before the window has been seen in its normal state.
    pub fn frame(&self) -> Option<WindowFrame> {
        Some(WindowFrame { rect: self.normal?, maximized: self.maximized, scale_milli: self.scale_milli })
    }

    /// Tells the tracker the frame the window was just put at.
    pub fn assume(&mut self, frame: &WindowFrame) {
        self.normal = Some(frame.rect);
        self.maximized = frame.maximized;
        self.scale_milli = frame.scale_milli;
    }
}

/// The window's current outer rectangle in screen coordinates.
pub fn window_rect(hwnd: HWND) -> Option<Rect> {
    // SAFETY: a read of a window's state.
    unsafe {
        let mut r: RECT = zeroed();
        (GetWindowRect(hwnd, &mut r) != 0).then(|| rect(r))
    }
}

/// Puts the window at the frame's rectangle with screen-coordinate calls only: the move is done twice, so a
/// `WM_DPICHANGED` that the first one causes (the window changed monitors of another scale) cannot leave the window at a
/// rectangle the system rescaled; then the window is shown (activated only if asked) or maximized. Returns the rectangle the window ended with.
pub fn apply_frame(hwnd: HWND, frame: &WindowFrame, activate: bool) -> Option<Rect> {
    // SAFETY: `hwnd` is a live window of this process; the calls only move and show it.
    unsafe {
        for _ in 0..2 {
            SetWindowPos(hwnd, std::ptr::null_mut(), frame.rect.x, frame.rect.y, frame.rect.w, frame.rect.h, SWP_NOZORDER | SWP_NOACTIVATE);
        }
        ShowWindow(hwnd, if frame.maximized { SW_MAXIMIZE } else if activate { SW_SHOWNORMAL } else { SW_SHOWNOACTIVATE });
    }
    window_rect(hwnd)
}

/// Shows the window at the place it has, activating it.
pub fn show_normal(hwnd: HWND) {
    // SAFETY: shows a window of this process.
    unsafe { ShowWindow(hwnd, SW_SHOWNORMAL) };
}

/// The monitor of a frame among the given ones (see `window_state::monitor_for`).
pub fn frame_monitor<'a>(frame: &WindowFrame, monitors: &'a [MonitorInfo]) -> Option<&'a MonitorInfo> {
    monitor_for(&frame.rect, monitors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, SW_HIDE, WS_MAXIMIZEBOX, WS_POPUP, WS_THICKFRAME};

    fn window() -> HWND {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        // SAFETY: a system class, far off-screen, not shown.
        let hwnd = unsafe { CreateWindowExW(0, class.as_ptr(), std::ptr::null(), WS_POPUP | WS_THICKFRAME | WS_MAXIMIZEBOX, -20000, -20000, 300, 200, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null()) };
        assert!(!hwnd.is_null());
        hwnd
    }

    #[test]
    fn the_real_monitors_have_a_primary_a_work_area_inside_the_monitor_and_a_scale() {
        let found = monitors();
        assert!(!found.is_empty(), "this machine has a display");
        assert_eq!(found.iter().filter(|m| m.primary).count(), 1);
        for m in &found {
            assert!(!m.rect.is_empty() && !m.work.is_empty());
            assert_eq!(m.work.intersect(&m.rect), m.work, "the work area lies inside the monitor: {m:?}");
            assert!((500..=5000).contains(&m.scale_milli), "{m:?}");
        }
    }

    #[test]
    fn an_applied_frame_is_exactly_where_the_window_is_and_repeated_restores_do_not_drift() {
        let hwnd = window();
        // A frame at screen coordinates with an offset origin, far off-screen: the same arithmetic as anywhere.
        let frame = WindowFrame { rect: Rect::new(-19000, -19500, 1234, 777), maximized: false, scale_milli: 1000 };
        for round in 0..5 {
            let got = apply_frame(hwnd, &frame, false).expect("the window exists");
            assert_eq!(got, frame.rect, "round {round}");
            // SAFETY: hide the window again, as it started.
            unsafe { ShowWindow(hwnd, SW_HIDE) };
        }
        // SAFETY: the window was made here.
        unsafe { DestroyWindow(hwnd) };
    }

    #[test]
    fn a_maximized_window_still_remembers_where_it_restores_to() {
        let mut tracker = FrameTracker::default();
        let restore = Rect::new(111, 222, 1234, 777);
        tracker.observe(Sample { normal: Some(restore), maximized: false, scale_milli: 1500 });
        tracker.observe(Sample { normal: None, maximized: true, scale_milli: 1500 });
        assert_eq!(tracker.frame(), Some(WindowFrame { rect: restore, maximized: true, scale_milli: 1500 }));
        tracker.observe(Sample { normal: Some(Rect::new(5, 5, 1100, 700)), maximized: false, scale_milli: 1500 });
        assert!(!tracker.frame().unwrap().maximized);
    }

    #[test]
    fn the_tracker_keeps_the_restore_rectangle_and_ignores_a_hidden_state_it_cannot_read() {
        let hwnd = window();
        let mut tracker = FrameTracker::default();
        assert!(tracker.frame().is_none(), "nothing seen yet");
        // SAFETY: move a window of this test.
        unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), -19800, -19800, 640, 480, SWP_NOZORDER | SWP_NOACTIVATE) };
        tracker.observe(sample(hwnd));
        let frame = tracker.frame().unwrap();
        assert_eq!(frame.rect, Rect::new(-19800, -19800, 640, 480));
        assert!(!frame.maximized);
        // SAFETY: the window was made here.
        unsafe { DestroyWindow(hwnd) };
    }
}
