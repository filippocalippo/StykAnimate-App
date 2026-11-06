//! Window-level operating-system helpers: showing a window without taking focus and capturing its pixels.
//!
//! Both exist for the unattended runs of the automation mode and the tests: a window that opens off-screen, never
//! takes the keyboard from the person at the computer, and can still be photographed.

use raw_window_handle::{HasWindowHandle, RawWindowHandle};

/// A captured window: tightly packed RGBA, top row first, alpha opaque.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// `width * height * 4` bytes.
    pub rgba: Vec<u8>,
}

/// Why a window could not be shown or captured.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WindowError {
    /// This target has no implementation of the operation.
    Unsupported,
    /// The window handle is not one this target can use, or the window is gone.
    NoWindow,
    /// The operating system refused: what failed, and the system's error code.
    Os(&'static str, u32),
}

impl std::fmt::Display for WindowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WindowError::Unsupported => write!(f, "not supported on this platform"),
            WindowError::NoWindow => write!(f, "the window is gone or has no native handle"),
            WindowError::Os(what, code) => write!(f, "{what} failed (error {code})"),
        }
    }
}

impl std::error::Error for WindowError {}

/// Shows a window that was created hidden, without activating it: it takes no focus, does not come to the front and has
/// no taskbar entry.
///
/// A window created visible is activated by the system as it appears, even far off-screen, and would take the keyboard
/// from the person at the computer; one created hidden and shown this way does not.
pub fn show_without_activation(window: &dyn HasWindowHandle) -> Result<(), WindowError> {
    imp::show_without_activation(window.window_handle().map_err(|_| WindowError::NoWindow)?.as_raw())
}

/// Captures what the window looks like, through the compositor, so a window that is off-screen, covered or not
/// focused is captured as it is drawn.
pub fn capture(window: &dyn HasWindowHandle) -> Result<Image, WindowError> {
    imp::capture(window.window_handle().map_err(|_| WindowError::NoWindow)?.as_raw())
}

#[cfg(windows)]
mod imp {
    use super::{Image, RawWindowHandle, WindowError};
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{GetLastError, HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleBitmap, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
    };
    use windows_sys::Win32::Storage::Xps::PrintWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetClientRect, GetWindowLongPtrW, SW_SHOWNOACTIVATE, SetWindowLongPtrW, ShowWindow, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    /// `PW_CLIENTONLY | PW_RENDERFULLCONTENT`: the client area, as the compositor draws it.
    const PRINT_FLAGS: u32 = 0x1 | 0x2;

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

    pub fn show_without_activation(handle: RawWindowHandle) -> Result<(), WindowError> {
        let hwnd = hwnd(handle)?;
        // SAFETY: `hwnd` came from a live window handle; these calls only read and set its own style bits and show it.
        // ShowWindow returns the previous visibility, not an error.
        unsafe {
            // A tool window with no activation: no taskbar button, and a click on it takes no focus either.
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let style = (style | WS_EX_TOOLWINDOW as isize | WS_EX_NOACTIVATE as isize) & !(WS_EX_APPWINDOW as isize);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        Ok(())
    }

    pub fn capture(handle: RawWindowHandle) -> Result<Image, WindowError> {
        let hwnd = hwnd(handle)?;
        // SAFETY: every GDI object created below is released on every path out of this block, `rect` and `info` are
        // plain structs that outlive the calls using them, and `pixels` has exactly the `width * height * 4` bytes
        // GetDIBits is told it may write.
        unsafe {
            let mut rect: RECT = std::mem::zeroed();
            if GetClientRect(hwnd, &mut rect) == 0 {
                return Err(os("GetClientRect"));
            }
            let (width, height) = ((rect.right - rect.left).max(0) as u32, (rect.bottom - rect.top).max(0) as u32);
            if width == 0 || height == 0 {
                return Err(WindowError::NoWindow);
            }
            let screen = GetDC(std::ptr::null_mut());
            let memory = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, width as i32, height as i32);
            let mut result = Err(os("CreateCompatibleBitmap"));
            if !memory.is_null() && !bitmap.is_null() {
                let previous = SelectObject(memory, bitmap);
                result = if PrintWindow(hwnd, memory, PRINT_FLAGS) == 0 {
                    Err(os("PrintWindow"))
                } else {
                    let mut info: BITMAPINFO = std::mem::zeroed();
                    info.bmiHeader = BITMAPINFOHEADER {
                        biSize: size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: width as i32,
                        // Negative: the rows come top first.
                        biHeight: -(height as i32),
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB,
                        ..std::mem::zeroed()
                    };
                    let mut pixels = vec![0u8; width as usize * height as usize * 4];
                    if GetDIBits(memory, bitmap, 0, height, pixels.as_mut_ptr().cast(), &mut info, DIB_RGB_COLORS) == 0 {
                        Err(os("GetDIBits"))
                    } else {
                        for pixel in pixels.chunks_exact_mut(4) {
                            pixel.swap(0, 2);
                            pixel[3] = 255;
                        }
                        Ok(Image { width, height, rgba: pixels })
                    }
                };
                SelectObject(memory, previous);
            }
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            if !memory.is_null() {
                DeleteDC(memory);
            }
            ReleaseDC(std::ptr::null_mut(), screen);
            result
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::{RawWindowHandle, WindowError};

    pub fn show_without_activation(_: RawWindowHandle) -> Result<(), WindowError> {
        Err(WindowError::Unsupported)
    }

    pub fn capture(_: RawWindowHandle) -> Result<super::Image, WindowError> {
        Err(WindowError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_say_what_failed() {
        assert_eq!(WindowError::Os("PrintWindow", 5).to_string(), "PrintWindow failed (error 5)");
        assert!(WindowError::Unsupported.to_string().contains("not supported"));
    }
}
