//! A synthetic pen: `CreateSyntheticPointerDevice` / `InjectSyntheticPointerInput`, for the tests and `cargo xtask pen-inject`.
//!
//! A synthetic pen has no eraser end: the system drops the eraser and inverted flags of an injected report (and refuses a lift
//! that carries them), so the eraser tool is tested through the field mapping and on a real tablet, not here.
//!
//! The system routes injected input like a real pen's: to the window under the pointer's screen position. A script is
//! replayed at its own timing (a hybrid sleep and spin on the performance counter), and the counter time of every
//! injection is returned so a latency measurement can start from it.

use std::time::Duration;
use styk_services::input::{Phase, Script, ScriptStep};
use windows_sys::Win32::UI::Controls::{CreateSyntheticPointerDevice, DestroySyntheticPointerDevice, HSYNTHETICPOINTERDEVICE, POINTER_FEEDBACK_NONE, POINTER_TYPE_INFO, POINTER_TYPE_INFO_0};
use windows_sys::Win32::UI::Input::Pointer::{
    InjectSyntheticPointerInput, POINTER_FLAG_FIRSTBUTTON, POINTER_FLAG_DOWN, POINTER_FLAG_INCONTACT, POINTER_FLAG_INRANGE, POINTER_FLAG_NEW, POINTER_FLAG_SECONDBUTTON, POINTER_FLAG_UP, POINTER_FLAG_UPDATE,
    POINTER_PEN_INFO,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{PEN_FLAG_BARREL, PEN_MASK_PRESSURE, PEN_MASK_TILT_X, PEN_MASK_TILT_Y, PT_PEN};

/// Why injection failed: what was called, and the system's error code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InjectError {
    pub call: &'static str,
    pub code: u32,
    /// The script step that was being injected.
    pub step: Option<usize>,
}

impl std::fmt::Display for InjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} failed (error {})", self.call, self.code)?;
        if let Some(step) = self.step {
            write!(f, " at step {step}")?;
        }
        Ok(())
    }
}

impl std::error::Error for InjectError {}

/// The pointer flags of one step. `entering` marks the first report of a pointer that was out of range.
pub fn pointer_flags(phase: Phase, barrel: bool, entering: bool) -> u32 {
    let mut flags = match phase {
        Phase::Hover => POINTER_FLAG_INRANGE | POINTER_FLAG_UPDATE,
        Phase::Down => POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT | POINTER_FLAG_FIRSTBUTTON | POINTER_FLAG_DOWN,
        Phase::Move => POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT | POINTER_FLAG_FIRSTBUTTON | POINTER_FLAG_UPDATE,
        Phase::Up => POINTER_FLAG_INRANGE | POINTER_FLAG_UP,
    };
    if barrel {
        flags |= POINTER_FLAG_SECONDBUTTON;
    }
    if entering {
        flags |= POINTER_FLAG_NEW;
    }
    flags
}

/// The primary display's size in pixels.
pub fn primary_screen_size() -> (i32, i32) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    // SAFETY: plain queries.
    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
}

/// Makes a window all but invisible (its opacity `alpha` of 255) while it still takes input.
///
/// Injected pointer input is delivered to the window under the pointer's screen position, so a window that is to receive
/// it must be on the screen; a test window made this nearly transparent, small and at the screen's corner is there without
/// being seen.
pub fn make_nearly_invisible(window: &dyn raw_window_handle::HasWindowHandle, alpha: u8) -> Result<(), InjectError> {
    use raw_window_handle::RawWindowHandle;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GWL_EXSTYLE, GetWindowLongPtrW, LWA_ALPHA, SetLayeredWindowAttributes, SetWindowLongPtrW, WS_EX_LAYERED};
    let Ok(handle) = window.window_handle() else { return Err(InjectError { call: "window handle", code: 0, step: None }) };
    let RawWindowHandle::Win32(handle) = handle.as_raw() else { return Err(InjectError { call: "window handle", code: 0, step: None }) };
    let hwnd = handle.hwnd.get() as windows_sys::Win32::Foundation::HWND;
    // SAFETY: the handle belongs to a live window of this process; these calls only change its own style and opacity.
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED as isize);
        if SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) == 0 {
            return Err(InjectError { call: "SetLayeredWindowAttributes", code: last_error(), step: None });
        }
    }
    Ok(())
}

/// A synthetic pen device.
pub struct PenInjector {
    device: HSYNTHETICPOINTERDEVICE,
    pointer: u32,
    in_range: bool,
}

impl PenInjector {
    pub fn new(pointer: u32) -> Result<PenInjector, InjectError> {
        // SAFETY: plain call; the device is destroyed in `Drop`.
        let device = unsafe { CreateSyntheticPointerDevice(PT_PEN, 1, POINTER_FEEDBACK_NONE) };
        if device.is_null() {
            return Err(InjectError { call: "CreateSyntheticPointerDevice", code: last_error(), step: None });
        }
        Ok(PenInjector { device, pointer, in_range: false })
    }

    fn frame(&self, step: &ScriptStep, screen: (i32, i32), flags: u32) -> POINTER_TYPE_INFO {
        let mut pen: POINTER_PEN_INFO = unsafe { std::mem::zeroed() };
        pen.pointerInfo.pointerType = PT_PEN;
        pen.pointerInfo.pointerId = self.pointer;
        pen.pointerInfo.pointerFlags = flags;
        // The system stamps an injection itself, with a millisecond clock; setting the time here is refused (error 87).
        pen.pointerInfo.ptPixelLocation.x = screen.0 + step.x.round() as i32;
        pen.pointerInfo.ptPixelLocation.y = screen.1 + step.y.round() as i32;
        pen.penMask = PEN_MASK_PRESSURE | PEN_MASK_TILT_X | PEN_MASK_TILT_Y;
        pen.pressure = step.raw_pressure;
        pen.tiltX = step.tilt_x;
        pen.tiltY = step.tilt_y;
        if step.barrel {
            pen.penFlags |= PEN_FLAG_BARREL;
        }
        POINTER_TYPE_INFO { r#type: PT_PEN, Anonymous: POINTER_TYPE_INFO_0 { penInfo: pen } }
    }

    /// Injects one step at a client-area position, given the client area's screen origin.
    pub fn inject(&mut self, step: &ScriptStep, screen_origin: (i32, i32)) -> Result<(), InjectError> {
        let flags = pointer_flags(step.phase, step.barrel, !self.in_range);
        let frame = self.frame(step, screen_origin, flags);
        // SAFETY: `frame` is a fully initialised frame that outlives the call; one pointer, count one.
        if unsafe { InjectSyntheticPointerInput(self.device, &frame, 1) } == 0 {
            return Err(InjectError { call: "InjectSyntheticPointerInput", code: last_error(), step: None });
        }
        self.in_range = true;
        Ok(())
    }

    /// Replays a script at its own timing from the moment of the call. `before` runs just before each injection with the
    /// step index. Returns the counter time (ns) of each injection; stops at the first error.
    pub fn play(&mut self, script: &Script, screen_origin: (i32, i32), mut before: impl FnMut(usize)) -> Result<Vec<u64>, InjectError> {
        let start = super::qpc::now_ns();
        let mut times = Vec::with_capacity(script.steps.len());
        for (index, step) in script.steps.iter().enumerate() {
            wait_until(start + step.t_ns);
            before(index);
            times.push(super::qpc::now_ns());
            self.inject(step, screen_origin).map_err(|error| InjectError { step: Some(index), ..error })?;
        }
        Ok(times)
    }
}

impl Drop for PenInjector {
    fn drop(&mut self) {
        // SAFETY: the device was created in `new` and is destroyed once.
        unsafe { DestroySyntheticPointerDevice(self.device) };
    }
}

fn last_error() -> u32 {
    // SAFETY: reads the calling thread's last-error value.
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

/// Sleeps until the counter reaches `target_ns`, spinning for the last stretch: a sleep alone is only as exact as the
/// scheduler's tick.
fn wait_until(target_ns: u64) {
    loop {
        let now = super::qpc::now_ns();
        if now >= target_ns {
            return;
        }
        let left = target_ns - now;
        if left > 2_000_000 {
            std::thread::sleep(Duration::from_nanos(left - 1_500_000));
        } else {
            std::hint::spin_loop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    

    #[test]
    fn a_step_becomes_the_flags_the_system_expects() {
        let down = pointer_flags(Phase::Down, false, true);
        assert!(down & POINTER_FLAG_NEW != 0 && down & POINTER_FLAG_DOWN != 0 && down & POINTER_FLAG_INCONTACT != 0);
        let hover = pointer_flags(Phase::Hover, false, false);
        assert!(hover & POINTER_FLAG_INCONTACT == 0 && hover & POINTER_FLAG_INRANGE != 0 && hover & POINTER_FLAG_NEW == 0);
        let up = pointer_flags(Phase::Up, false, false);
        assert!(up & POINTER_FLAG_UP != 0 && up & POINTER_FLAG_INCONTACT == 0);
        assert!(pointer_flags(Phase::Move, true, false) & POINTER_FLAG_SECONDBUTTON != 0);
    }

    #[test]
    fn playing_waits_for_each_steps_time() {
        let start = super::super::qpc::now_ns();
        wait_until(start + 30_000_000);
        let waited = super::super::qpc::now_ns() - start;
        assert!((30_000_000..32_500_000).contains(&waited), "{waited}");
    }
}
