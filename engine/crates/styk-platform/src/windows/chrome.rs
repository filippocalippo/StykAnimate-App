//! The frameless window's non-client behaviour: resize borders, the caption, the maximize button the Windows 11
//! snap-layouts flyout attaches to, and the press states around it.
//!
//! One subclass of the window (`SetWindowSubclass`, its own id) answers `WM_NCHITTEST` from the regions the band
//! publishes and runs the maximize button with the state machine of `styk_services::shell::chrome`. It chains: every
//! message it does not handle goes to `DefSubclassProc`, so the pen input's subclass and winit's procedure still see
//! theirs. The procedure never waits: the regions are one `Arc` swapped under a lock held for the swap, the button
//! state is an atomic the interface reads, a toggle request is a counter, and the one wake-up is a callback that only
//! ever does a non-blocking send.

use super::monitors::hwnd_of;
use raw_window_handle::HasWindowHandle;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use styk_services::shell::Rect;
use styk_services::shell::chrome::{ButtonAction, ButtonInput, Cancel, ChromeRegions, FrameState, MaxButton, MaxButtonState, hit_test, ht};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetCapture, ReleaseCapture, SetCapture, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClientRect, IsZoomed, SM_CXPADDEDBORDER, SM_CXSIZEFRAME, WA_INACTIVE, WM_ACTIVATE, WM_CANCELMODE, WM_CAPTURECHANGED, WM_KILLFOCUS, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDBLCLK,
    WM_NCLBUTTONDOWN, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE,
};

/// The subclass id of this module, registered with the others in one place.
const SUBCLASS_ID: usize = crate::input::windows::subclass_id::CHROME;

type Wake = Box<dyn Fn() + Send + Sync>;

struct Shared {
    regions: Mutex<Arc<ChromeRegions>>,
    button: Mutex<MaxButton>,
    button_state: AtomicU8,
    fullscreen: AtomicBool,
    /// Toggle requests not yet taken by the interface: a count, so none is lost and none is delivered twice.
    toggles: AtomicU32,
    wake: Mutex<Option<Wake>>,
}

impl Shared {
    fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn notify(&self) {
        if let Some(wake) = Self::lock(&self.wake).as_ref() {
            wake();
        }
    }

    /// Runs one input through the button, publishes its state, wakes the interface on a change, and returns the action.
    fn step(&self, input: ButtonInput) -> ButtonAction {
        let (action, state) = {
            let mut button = Self::lock(&self.button);
            let action = button.step(input);
            (action, button.state())
        };
        let before = self.button_state.swap(state.as_u8(), Ordering::AcqRel);
        if action == ButtonAction::Toggle {
            self.toggles.fetch_add(1, Ordering::AcqRel);
        }
        if before != state.as_u8() || action == ButtonAction::Toggle {
            self.notify();
        }
        action
    }
}

/// The handle the application keeps for a window's chrome.
#[derive(Clone)]
pub struct Chrome {
    shared: Arc<Shared>,
    hwnd: usize,
}

impl std::fmt::Debug for Chrome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Chrome").field("button", &self.max_button()).finish()
    }
}

/// Why the chrome could not be attached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChromeError {
    /// Not a Windows window handle.
    NoWindow,
    /// `SetWindowSubclass` refused (wrong thread).
    Refused,
}

impl std::fmt::Display for ChromeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChromeError::NoWindow => write!(f, "the window is not a Windows window"),
            ChromeError::Refused => write!(f, "the window's chrome could not be attached (it must be attached on the window's own thread)"),
        }
    }
}

impl std::error::Error for ChromeError {}

/// Attaches the chrome to the window. Call on the window's own thread (inside `iced::window::run`).
pub fn attach(window: &dyn HasWindowHandle) -> Result<Chrome, ChromeError> {
    let hwnd = hwnd_of(window).ok_or(ChromeError::NoWindow)?;
    attach_hwnd(hwnd)
}

pub(crate) fn attach_hwnd(hwnd: HWND) -> Result<Chrome, ChromeError> {
    let shared = Arc::new(Shared {
        regions: Mutex::new(Arc::new(ChromeRegions::default())),
        button: Mutex::new(MaxButton::default()),
        button_state: AtomicU8::new(0),
        fullscreen: AtomicBool::new(false),
        toggles: AtomicU32::new(0),
        wake: Mutex::new(None),
    });
    let data = Box::into_raw(Box::new(shared.clone()));
    // SAFETY: `hwnd` is a live window of the calling thread; `data` is owned by the subclass from here and freed in
    // `WM_NCDESTROY` (or below if the call fails).
    let ok = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, data as usize) };
    if ok == 0 {
        // SAFETY: the subclass did not take the pointer.
        drop(unsafe { Box::from_raw(data) });
        return Err(ChromeError::Refused);
    }
    Ok(Chrome { shared, hwnd: hwnd as usize })
}

impl Chrome {
    /// Publishes the places of the band after a layout, in physical client pixels. An empty set (the band is hidden)
    /// also ends any press in progress.
    pub fn publish(&self, regions: ChromeRegions) {
        let empty = regions == ChromeRegions::default();
        *Shared::lock(&self.shared.regions) = Arc::new(regions);
        if empty {
            self.shared.step(ButtonInput::Cancel(Cancel::ChromeGone));
        }
    }

    /// Fullscreen has no resize edges and no caption; entering it ends a press.
    pub fn set_fullscreen(&self, on: bool) {
        self.shared.fullscreen.store(on, Ordering::Release);
        if on {
            self.shared.step(ButtonInput::Cancel(Cancel::ChromeGone));
        }
    }

    /// How the maximize button looks now.
    pub fn max_button(&self) -> MaxButtonState {
        MaxButtonState::from_u8(self.shared.button_state.load(Ordering::Acquire))
    }

    /// How many times the maximize button was clicked since the last call; the interface toggles that many times.
    pub fn take_toggles(&self) -> u32 {
        self.shared.toggles.swap(0, Ordering::AcqRel)
    }

    /// Sets what is called, from the window's thread and without blocking, when the button's look or the toggle count
    /// changes. It should only post a message.
    pub fn on_change(&self, wake: impl Fn() + Send + Sync + 'static) {
        *Shared::lock(&self.shared.wake) = Some(Box::new(wake));
    }

    /// Takes the chrome off the window (the window is being closed by the application).
    pub fn detach(&self) {
        // SAFETY: removing our own subclass; the window's thread owns it. The data is freed by the subclass procedure's
        // final message, so a removal here leaves it to `WM_NCDESTROY`; only the callbacks are dropped.
        unsafe { RemoveWindowSubclass(self.hwnd as HWND, Some(subclass_proc), SUBCLASS_ID) };
        *Shared::lock(&self.shared.wake) = None;
    }
}

fn point(lparam: LPARAM) -> (i32, i32) {
    (i32::from(lparam as i16), i32::from((lparam >> 16) as i16))
}

fn border(hwnd: HWND) -> i32 {
    // SAFETY: metrics for the window's own DPI.
    unsafe {
        let dpi = GetDpiForWindow(hwnd).max(96);
        GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi)
    }
}

fn client_size(hwnd: HWND) -> (i32, i32) {
    // SAFETY: a read of the window's client rectangle.
    unsafe {
        let mut r: RECT = std::mem::zeroed();
        GetClientRect(hwnd, &mut r);
        (r.right, r.bottom)
    }
}

fn over_button(shared: &Shared, x: i32, y: i32) -> bool {
    Shared::lock(&shared.regions).maximize.is_some_and(|r: Rect| r.contains(x, y))
}

unsafe extern "system" fn subclass_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, data: usize) -> LRESULT {
    // SAFETY: `data` is the `Box<Arc<Shared>>` leaked by `attach_hwnd`; it lives until `WM_NCDESTROY`, below.
    let shared: &Arc<Shared> = unsafe { &*(data as *const Arc<Shared>) };
    match message {
        WM_NCHITTEST => {
            let regions = Shared::lock(&shared.regions).clone();
            let mut at = POINT { x: point(lparam).0, y: point(lparam).1 };
            // SAFETY: converts a screen point to this window's client coordinates.
            unsafe { ScreenToClient(hwnd, &mut at) };
            let (w, h) = client_size(hwnd);
            // SAFETY: a read of the window's state.
            let state = FrameState { maximized: unsafe { IsZoomed(hwnd) } != 0, fullscreen: shared.fullscreen.load(Ordering::Acquire) };
            return hit_test(&regions, state, border(hwnd), w, h, at.x, at.y) as LRESULT;
        }
        WM_NCMOUSEMOVE => {
            let over = wparam as i32 == ht::MAXBUTTON;
            if over {
                let mut track = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE | TME_NONCLIENT, hwndTrack: hwnd, dwHoverTime: 0 };
                // SAFETY: asks for one `WM_NCMOUSELEAVE` for this window.
                unsafe { TrackMouseEvent(&mut track) };
            }
            shared.step(ButtonInput::Move { over });
            if over {
                return 0;
            }
        }
        WM_NCMOUSELEAVE => {
            shared.step(ButtonInput::Leave);
        }
        WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK if wparam as i32 == ht::MAXBUTTON => {
            if shared.step(ButtonInput::Down { over: true }) == ButtonAction::Capture {
                // SAFETY: take the mouse so the release arrives wherever the pointer is.
                unsafe { SetCapture(hwnd) };
            }
            return 0;
        }
        WM_MOUSEMOVE if matches!(MaxButtonState::from_u8(shared.button_state.load(Ordering::Acquire)), MaxButtonState::Pressed { .. }) => {
            let (x, y) = point(lparam);
            shared.step(ButtonInput::Move { over: over_button(shared, x, y) });
            return 0;
        }
        WM_LBUTTONUP if matches!(MaxButtonState::from_u8(shared.button_state.load(Ordering::Acquire)), MaxButtonState::Pressed { .. }) => {
            let (x, y) = point(lparam);
            let action = shared.step(ButtonInput::Up { over: over_button(shared, x, y) });
            if matches!(action, ButtonAction::Toggle | ButtonAction::Release) {
                // SAFETY: give the mouse back.
                unsafe { ReleaseCapture() };
            }
            return 0;
        }
        WM_CAPTURECHANGED => {
            // SAFETY: reads which window holds the capture now.
            if unsafe { GetCapture() } != hwnd {
                shared.step(ButtonInput::Cancel(Cancel::CaptureLost));
            }
        }
        WM_CANCELMODE | WM_KILLFOCUS => {
            shared.step(ButtonInput::Cancel(Cancel::Deactivated));
        }
        WM_ACTIVATE if (wparam & 0xffff) as u32 == WA_INACTIVE => {
            shared.step(ButtonInput::Cancel(Cancel::Deactivated));
        }
        WM_NCDESTROY => {
            shared.step(ButtonInput::Cancel(Cancel::Destroyed));
            // SAFETY: the window is going away; remove the subclass, then free the data it owned. Nothing touches it
            // after this message.
            unsafe {
                RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                let result = DefSubclassProc(hwnd, message, wparam, lparam);
                drop(Box::from_raw(data as *mut Arc<Shared>));
                return result;
            }
        }
        _ => {}
    }
    // SAFETY: the next procedure in the chain.
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetCapture as capture_now;
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, SendMessageW, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER, WS_POPUP};

    const W: i32 = 1560;
    const H: i32 = 1000;
    const ORIGIN: i32 = -20000;

    fn window() -> HWND {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        // SAFETY: a system class, a plain popup far off-screen and never shown; no frame, so client and window coincide.
        let hwnd = unsafe { CreateWindowExW(0, class.as_ptr(), std::ptr::null(), WS_POPUP, ORIGIN, ORIGIN, W, H, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null()) };
        assert!(!hwnd.is_null());
        hwnd
    }

    fn regions() -> ChromeRegions {
        ChromeRegions {
            caption: vec![Rect::new(0, 0, W, 52)],
            no_drag: vec![Rect::new(200, 0, 300, 52)],
            maximize: Some(Rect::new(W - 88, 0, 44, 52)),
            buttons: vec![Rect::new(W - 132, 0, 44, 52), Rect::new(W - 44, 0, 44, 52)],
        }
    }

    fn hit(hwnd: HWND, x: i32, y: i32) -> i32 {
        let screen = ((ORIGIN + y) as i16 as u16 as isize) << 16 | (ORIGIN + x) as i16 as u16 as isize;
        // SAFETY: a message to our own window, handled on this thread by the subclass.
        unsafe { SendMessageW(hwnd, WM_NCHITTEST, 0, screen) as i32 }
    }

    fn client(x: i32, y: i32) -> isize {
        ((y as i16 as u16 as isize) << 16) | (x as i16 as u16 as isize)
    }

    fn setup() -> (HWND, Chrome) {
        let hwnd = window();
        let chrome = attach_hwnd(hwnd).expect("attached");
        chrome.publish(regions());
        (hwnd, chrome)
    }

    fn destroy(hwnd: HWND) {
        // SAFETY: the window was made by the test.
        unsafe { DestroyWindow(hwnd) };
    }

    #[test]
    fn the_window_answers_hit_tests_from_the_published_regions() {
        let (hwnd, _chrome) = setup();
        assert_eq!(hit(hwnd, 2, 500), ht::LEFT);
        assert_eq!(hit(hwnd, 2, 2), ht::TOPLEFT);
        assert_eq!(hit(hwnd, W - 3, H - 3), ht::BOTTOMRIGHT);
        assert_eq!(hit(hwnd, 700, 20), ht::CAPTION);
        assert_eq!(hit(hwnd, 300, 20), ht::CLIENT);
        assert_eq!(hit(hwnd, W - 66, 30), ht::MAXBUTTON);
        assert_eq!(hit(hwnd, 700, 500), ht::CLIENT);
        destroy(hwnd);
    }

    #[test]
    fn fullscreen_removes_every_edge_and_the_caption_and_the_hidden_band_leaves_no_stale_caption() {
        let (hwnd, chrome) = setup();
        chrome.set_fullscreen(true);
        for (x, y) in [(2, 500), (2, 2), (700, 20), (W - 66, 30)] {
            assert_eq!(hit(hwnd, x, y), ht::CLIENT, "({x},{y})");
        }
        chrome.set_fullscreen(false);
        assert_eq!(hit(hwnd, 700, 20), ht::CAPTION);
        chrome.publish(ChromeRegions::default());
        assert_eq!(hit(hwnd, 700, 20), ht::CLIENT, "the band is hidden: its caption is gone");
        assert_eq!(hit(hwnd, 2, 500), ht::LEFT, "the edges stay");
        destroy(hwnd);
    }

    fn send_nc(hwnd: HWND, message: u32, code: i32) {
        // SAFETY: a message to our own window.
        unsafe { SendMessageW(hwnd, message, code as usize, 0) };
    }

    fn send_client(hwnd: HWND, message: u32, x: i32, y: i32) {
        // SAFETY: a message to our own window.
        unsafe { SendMessageW(hwnd, message, 0, client(x, y)) };
    }

    #[test]
    fn hover_shows_and_leaving_clears_it_and_the_interface_is_woken_once_per_change() {
        let (hwnd, chrome) = setup();
        let wakes = Arc::new(AtomicUsize::new(0));
        let counter = wakes.clone();
        chrome.on_change(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        send_nc(hwnd, WM_NCMOUSEMOVE, ht::MAXBUTTON);
        send_nc(hwnd, WM_NCMOUSEMOVE, ht::MAXBUTTON);
        assert_eq!(chrome.max_button(), MaxButtonState::Hover);
        assert_eq!(wakes.load(Ordering::SeqCst), 1, "the second move changed nothing");
        send_nc(hwnd, WM_NCMOUSELEAVE, 0);
        assert_eq!(chrome.max_button(), MaxButtonState::Idle);
        assert_eq!(wakes.load(Ordering::SeqCst), 2);
        destroy(hwnd);
    }

    #[test]
    fn a_click_on_the_button_asks_for_one_toggle() {
        let (hwnd, chrome) = setup();
        send_nc(hwnd, WM_NCLBUTTONDOWN, ht::MAXBUTTON);
        assert_eq!(chrome.max_button(), MaxButtonState::Pressed { armed: true });
        // SAFETY: reads the capture of this thread.
        assert_eq!(unsafe { capture_now() }, hwnd, "the press took the mouse");
        send_client(hwnd, WM_LBUTTONUP, W - 66, 30);
        assert_eq!(chrome.max_button(), MaxButtonState::Idle);
        assert_eq!(chrome.take_toggles(), 1);
        assert_eq!(chrome.take_toggles(), 0, "taken once");
        destroy(hwnd);
    }

    #[test]
    fn dragging_off_the_button_and_releasing_elsewhere_toggles_nothing() {
        let (hwnd, chrome) = setup();
        send_nc(hwnd, WM_NCLBUTTONDOWN, ht::MAXBUTTON);
        send_client(hwnd, WM_MOUSEMOVE, 400, 400);
        assert_eq!(chrome.max_button(), MaxButtonState::Pressed { armed: false });
        send_client(hwnd, WM_MOUSEMOVE, W - 66, 30);
        assert_eq!(chrome.max_button(), MaxButtonState::Pressed { armed: true }, "coming back re-arms");
        send_client(hwnd, WM_MOUSEMOVE, 400, 400);
        send_client(hwnd, WM_LBUTTONUP, 400, 400);
        assert_eq!((chrome.max_button(), chrome.take_toggles()), (MaxButtonState::Idle, 0));
        destroy(hwnd);
    }

    #[test]
    fn losing_the_capture_deactivating_hiding_the_band_and_fullscreen_each_cancel_a_press() {
        let (hwnd, chrome) = setup();
        let press = || send_nc(hwnd, WM_NCLBUTTONDOWN, ht::MAXBUTTON);
        // SAFETY: handing the capture away, as another window taking it would.
        let release = || unsafe { ReleaseCapture() };

        press();
        release();
        assert_eq!(chrome.max_button(), MaxButtonState::Idle, "capture lost");
        press();
        // SAFETY: a message to our own window.
        unsafe { SendMessageW(hwnd, WM_ACTIVATE, WA_INACTIVE as usize, 0) };
        assert_eq!(chrome.max_button(), MaxButtonState::Idle, "deactivated");
        press();
        chrome.publish(ChromeRegions::default());
        assert_eq!(chrome.max_button(), MaxButtonState::Idle, "the band hid");
        chrome.publish(regions());
        press();
        chrome.set_fullscreen(true);
        assert_eq!(chrome.max_button(), MaxButtonState::Idle, "fullscreen");
        chrome.set_fullscreen(false);
        send_client(hwnd, WM_LBUTTONUP, W - 66, 30);
        assert_eq!(chrome.take_toggles(), 0, "no cancelled press ever toggles, even when a release follows");
        release();
        destroy(hwnd);
    }

    #[test]
    fn destroying_the_window_frees_the_chrome_and_a_stale_handle_is_harmless() {
        let (hwnd, chrome) = setup();
        send_nc(hwnd, WM_NCLBUTTONDOWN, ht::MAXBUTTON);
        destroy(hwnd);
        assert_eq!(chrome.max_button(), MaxButtonState::Idle, "destruction cancelled the press");
        chrome.publish(regions());
        chrome.detach();
    }

    #[test]
    fn another_subclass_installed_first_still_sees_what_the_chrome_does_not_handle() {
        let hwnd = window();
        static SEEN: AtomicUsize = AtomicUsize::new(0);
        unsafe extern "system" fn other(h: HWND, m: u32, w: WPARAM, l: LPARAM, _: usize, _: usize) -> LRESULT {
            if m == 0x0400 + 77 {
                SEEN.fetch_add(1, Ordering::SeqCst);
                return 99;
            }
            // SAFETY: the next procedure in the chain.
            unsafe { DefSubclassProc(h, m, w, l) }
        }
        // SAFETY: a second subclass with its own id, on the window's own thread.
        unsafe { SetWindowSubclass(hwnd, Some(other), 0x1234, 0) };
        let chrome = attach_hwnd(hwnd).unwrap();
        chrome.publish(regions());
        // SAFETY: a message to our own window.
        let answer = unsafe { SendMessageW(hwnd, 0x0400 + 77, 0, 0) };
        assert_eq!((answer, SEEN.load(Ordering::SeqCst)), (99, 1), "a message the chrome ignores reaches the other subclass");
        assert_eq!(hit(hwnd, 2, 500), ht::LEFT, "and the chrome still answers its own");
        // SAFETY: move a window of this test (keeps it off-screen).
        unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), ORIGIN, ORIGIN, W, H, SWP_NOZORDER | SWP_NOACTIVATE) };
        destroy(hwnd);
    }
}
