//! Pen, touch and mouse input from `WM_POINTER`, through a window subclass (`docs/native/input.md` 3.2).
//!
//! winit gives an application a pen as touch with pressure and nothing else, and never calls `DefWindowProc` for it, so
//! Windows sends no mouse messages for the pen. The subclass runs on the interface thread before winit's procedure:
//!
//! - **Pen** pointer messages: the whole history is read (`GetPointerPenInfoHistory`), oldest entry first, every entry
//!   becomes a [`PenSample`] with the pen's tilt, pressure, eraser end, barrel button, `PerformanceCount` and the modifier
//!   keys at that moment, and `DefWindowProc` is called so Windows promotes the pen to mouse messages for the toolkit's
//!   hover and buttons. winit never sees the pen's pointer messages.
//! - **Promoted mouse messages** are told apart from a real mouse by their extra-info signature, never by timing; only
//!   real mouse messages become `Mouse` samples.
//! - **Touch** pointer messages become `Touch` samples (palm rejection and finger drawing) and pass on to winit.
//! - **Interruptions** (capture lost, a cancelled contact, `WM_CANCELMODE`, losing focus) are events of their own.
//! - Press-and-hold, flicks and the pen-tap feedback are switched off for the window.
//!
//! Everything here runs on the thread that owns the window; the [`InputQueue`] is the only thing shared.

use std::cell::{Cell, RefCell};
use std::mem::zeroed;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use styk_services::Clock;
use styk_services::input::{EntryTime, HistoryClock, InputCaps, InputEvent, InputQueue, InputSource, InterruptReason, Modifiers, PenButtons, PenSample, Phase, SampleFlags, Tool, Valid};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
use windows_sys::Win32::UI::Input::Pointer::{
    GetPointerDeviceRects, GetPointerInfo, GetPointerPenInfoHistory, GetPointerType, POINTER_FLAG_CANCELED, POINTER_FLAG_DOWN, POINTER_FLAG_INCONTACT, POINTER_FLAG_UP, POINTER_INFO, POINTER_PEN_INFO,
};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::TabletPC::{TABLET_DISABLE_FLICKS, TABLET_DISABLE_PENBARRELFEEDBACK, TABLET_DISABLE_PENTAPFEEDBACK, TABLET_DISABLE_PRESSANDHOLD};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DefWindowProcW, GetMessageExtraInfo, PEN_FLAG_BARREL, PEN_FLAG_ERASER, PEN_FLAG_INVERTED, PEN_MASK_PRESSURE, PEN_MASK_ROTATION, PEN_MASK_TILT_X, PEN_MASK_TILT_Y, PT_PEN, PT_TOUCH, RemovePropW, SetPropW,
    WM_ACTIVATE, WM_CANCELMODE, WM_CAPTURECHANGED, WM_CONTEXTMENU, WM_KILLFOCUS, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCDESTROY, WM_POINTERCAPTURECHANGED, WM_POINTERDOWN, WM_POINTERENTER, WM_POINTERUP, WM_POINTERUPDATE,
    WM_RBUTTONDOWN, WM_RBUTTONUP,
};

/// The pointer id of the mouse.
pub const MOUSE_POINTER: u32 = u32::MAX;

/// The device range of a Windows pen's pressure.
const PRESSURE_RANGE: u32 = 1024;

/// The tablet service's window property: bits that switch off press-and-hold, flicks and pen feedback.
const TABLET_PROPERTY: &[u16] = &wide(*b"MicrosoftTabletPenServiceProperty\0");

const fn wide<const N: usize>(text: [u8; N]) -> [u16; N] {
    let mut out = [0u16; N];
    let mut i = 0;
    while i < N {
        out[i] = text[i] as u16;
        i += 1;
    }
    out
}

/// Why a source could not be attached.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputError {
    NoWindow,
    Os(&'static str),
}

impl std::fmt::Display for InputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InputError::NoWindow => write!(f, "the window has no native handle"),
            InputError::Os(what) => write!(f, "{what} failed"),
        }
    }
}

impl std::error::Error for InputError {}

/// How a mouse message came to be, read from `GetMessageExtraInfo()` while the message is dispatched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Promotion {
    /// A real mouse (or injected mouse input).
    No,
    /// Windows promoted a pen's contact to this mouse message.
    Pen,
    /// Windows promoted a finger.
    Touch,
}

/// Classifies a mouse message by its extra info: the signature `0xFF515700` marks promoted input, and bit `0x80` a finger.
pub fn promotion(extra_info: isize) -> Promotion {
    const SIGNATURE_MASK: usize = 0xFFFF_FF00;
    const SIGNATURE: usize = 0xFF51_5700;
    const TOUCH: usize = 0x80;
    let extra = extra_info as usize;
    if extra & SIGNATURE_MASK != SIGNATURE {
        Promotion::No
    } else if extra & TOUCH != 0 {
        Promotion::Touch
    } else {
        Promotion::Pen
    }
}

/// Whether an entry's flags say the system cancelled the contact (a palm, a gesture it took over): with or without a lift.
pub fn cancels(flags: u32) -> bool {
    flags & POINTER_FLAG_CANCELED != 0
}

/// The phase a pointer entry's flags describe.
pub fn phase_of(flags: u32) -> Phase {
    if flags & POINTER_FLAG_UP != 0 {
        Phase::Up
    } else if flags & POINTER_FLAG_DOWN != 0 {
        Phase::Down
    } else if flags & POINTER_FLAG_INCONTACT != 0 {
        Phase::Move
    } else {
        Phase::Hover
    }
}

/// A coordinate on the digitizer, in its himetric units, mapped onto the display's pixels (sub-pixel).
pub fn scale_himetric(value: i32, device: (i32, i32), display: (i32, i32)) -> f64 {
    let span = (device.1 - device.0) as f64;
    if span <= 0.0 { display.0 as f64 } else { display.0 as f64 + (value - device.0) as f64 * (display.1 - display.0) as f64 / span }
}

/// What an entry says, as a number: its position, pressure, buttons and phase, to tell two entries of one millisecond apart.
fn content_of(sample: &PenSample) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for word in [sample.x.to_bits(), sample.y.to_bits(), u64::from(sample.raw_pressure), u64::from(sample.buttons.0), sample.phase as u64, sample.tool as u64] {
        hash = (hash ^ word).wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The sample one history entry of a pen message makes. `position` is in client pixels and `time_ns` the entry's time.
pub fn pen_sample(entry: &POINTER_PEN_INFO, position: (f64, f64), time_ns: u64, modifiers: Modifiers) -> PenSample {
    let flags = entry.pointerInfo.pointerFlags;
    let eraser = entry.penFlags & (PEN_FLAG_ERASER | PEN_FLAG_INVERTED) != 0;
    let mut sample = PenSample::at(time_ns, entry.pointerInfo.pointerId, if eraser { Tool::Eraser } else { Tool::Pen }, position.0, position.1);
    sample.phase = phase_of(flags);
    if flags & POINTER_FLAG_INCONTACT != 0 && sample.phase != Phase::Up {
        sample.buttons = PenButtons::TIP;
    }
    if entry.penFlags & PEN_FLAG_BARREL != 0 {
        sample.buttons = sample.buttons | PenButtons::BARREL;
    }
    if entry.penMask & PEN_MASK_PRESSURE != 0 {
        sample.valid = sample.valid | Valid::PRESSURE;
        sample.raw_pressure = entry.pressure.min(PRESSURE_RANGE);
        sample.pressure_max = PRESSURE_RANGE;
        sample.pressure = sample.raw_pressure as f32 / PRESSURE_RANGE as f32;
    }
    if entry.penMask & (PEN_MASK_TILT_X | PEN_MASK_TILT_Y) != 0 {
        sample.valid = sample.valid | Valid::TILT;
        sample.tilt_x = entry.tiltX as f32;
        sample.tilt_y = entry.tiltY as f32;
    }
    if entry.penMask & PEN_MASK_ROTATION != 0 {
        sample.valid = sample.valid | Valid::TWIST;
        sample.twist = entry.rotation as f32;
    }
    sample.modifiers = modifiers;
    sample
}

/// Counts of what the subclass saw, for the pen lab and the tests.
#[derive(Debug, Default)]
pub struct InputCounters {
    pub pen_messages: AtomicU64,
    pub pen_samples: AtomicU64,
    /// Samples recovered from the history of a message.
    pub history_samples: AtomicU64,
    /// History entries identical to the sample before them, dropped.
    pub repeated_entries: AtomicU64,
    pub touch_samples: AtomicU64,
    pub real_mouse_messages: AtomicU64,
    /// Mouse messages Windows promoted from a pen or a finger; none became samples.
    pub promoted_mouse_messages: AtomicU64,
    /// `WM_CONTEXTMENU` messages, which press-and-hold would raise.
    pub context_menus: AtomicU64,
    pub interrupts: AtomicU64,
}

struct Hook {
    queue: InputQueue,
    counters: Arc<InputCounters>,
    /// Pointers of pens and fingers in contact now.
    contacts: RefCell<Vec<u32>>,
    mouse_down: Cell<bool>,
    mouse_barrel: Cell<bool>,
    scratch: RefCell<Vec<POINTER_PEN_INFO>>,
    /// The last pen reports pushed, so an entry the history repeats is not delivered twice.
    pen_clock: RefCell<HistoryClock>,
    touch_clock: RefCell<HistoryClock>,
}

fn modifiers() -> Modifiers {
    let held = |key: u16| unsafe { GetKeyState(key as i32) } < 0;
    let mut out = Modifiers::NONE;
    if held(VK_SHIFT) {
        out = out | Modifiers::SHIFT;
    }
    if held(VK_CONTROL) {
        out = out | Modifiers::CTRL;
    }
    if held(VK_MENU) {
        out = out | Modifiers::ALT;
    }
    if held(VK_LWIN) || held(VK_RWIN) {
        out = out | Modifiers::META;
    }
    out
}

impl Hook {
    fn client_origin(hwnd: HWND) -> (i32, i32) {
        let mut origin = POINT { x: 0, y: 0 };
        // SAFETY: `origin` outlives the call; a failure leaves the origin at zero, which only offsets positions.
        unsafe { ClientToScreen(hwnd, &mut origin) };
        (origin.x, origin.y)
    }

    /// An entry's position in client pixels: the digitizer's own coordinates when the system can map them (sub-pixel),
    /// the integer pixel location otherwise.
    fn position(hwnd: HWND, info: &POINTER_INFO) -> (f64, f64) {
        let (ox, oy) = Self::client_origin(hwnd);
        let (mut device, mut display): (RECT, RECT) = unsafe { (zeroed(), zeroed()) };
        // SAFETY: both rectangles outlive the call, and `sourceDevice` came from the system with this message.
        let mapped = unsafe { GetPointerDeviceRects(info.sourceDevice, &mut device, &mut display) } != 0;
        let (x, y) = if mapped {
            (
                scale_himetric(info.ptHimetricLocation.x, (device.left, device.right), (display.left, display.right)),
                scale_himetric(info.ptHimetricLocation.y, (device.top, device.bottom), (display.top, display.bottom)),
            )
        } else {
            (info.ptPixelLocation.x as f64, info.ptPixelLocation.y as f64)
        };
        (x - ox as f64, y - oy as f64)
    }

    fn pen(&self, hwnd: HWND, pointer: u32) {
        self.counters.pen_messages.fetch_add(1, Ordering::Relaxed);
        let mut entries = self.scratch.borrow_mut();
        let mut count = 0u32;
        // SAFETY: with a null buffer the call only reports how many entries the history holds.
        if unsafe { GetPointerPenInfoHistory(pointer, &mut count, std::ptr::null_mut()) } == 0 || count == 0 {
            return;
        }
        entries.clear();
        entries.resize(count as usize, unsafe { zeroed() });
        // SAFETY: `entries` holds `count` entries and the call writes at most that many.
        if unsafe { GetPointerPenInfoHistory(pointer, &mut count, entries.as_mut_ptr()) } == 0 {
            return;
        }
        let keys = modifiers();
        let total = (count as usize).min(entries.len());
        // Newest first from the system; the application wants them oldest first. Each entry has one time however many
        // messages carry it (`HistoryClock`), and one that an earlier message delivered is not delivered again.
        let now = super::qpc::now_ns();
        let newest_millis = entries[0].pointerInfo.dwTime;
        let mut clock = self.pen_clock.borrow_mut();
        for (index, entry) in entries[..total].iter().rev().enumerate() {
            let flags = entry.pointerInfo.pointerFlags;
            if cancels(flags) {
                self.contacts.borrow_mut().retain(|p| *p != pointer);
                self.counters.interrupts.fetch_add(1, Ordering::Relaxed);
                self.queue.push(InputEvent::Interrupted { pointer, time_ns: now, reason: InterruptReason::Canceled });
                continue;
            }
            let mut sample = pen_sample(entry, Self::position(hwnd, &entry.pointerInfo), 0, keys);
            let entry_time = EntryTime { counter_ns: super::qpc::counter_ns(entry.pointerInfo.PerformanceCount), millis: entry.pointerInfo.dwTime };
            let content = content_of(&sample);
            let Some(time_ns) = clock.admit(pointer, entry_time, content, newest_millis, now) else {
                self.counters.repeated_entries.fetch_add(1, Ordering::Relaxed);
                continue;
            };
            sample.time_ns = time_ns;
            if index + 1 < total {
                sample.flags = sample.flags | SampleFlags::HISTORY;
                self.counters.history_samples.fetch_add(1, Ordering::Relaxed);
            }
            self.track(pointer, sample.phase);
            self.counters.pen_samples.fetch_add(1, Ordering::Relaxed);
            self.queue.push(InputEvent::Sample(sample));
        }
    }

    fn track(&self, pointer: u32, phase: Phase) {
        let mut contacts = self.contacts.borrow_mut();
        match phase {
            Phase::Down => {
                if !contacts.contains(&pointer) {
                    contacts.push(pointer);
                }
            }
            Phase::Up => contacts.retain(|p| *p != pointer),
            Phase::Move | Phase::Hover => {}
        }
    }

    fn touch(&self, hwnd: HWND, pointer: u32) {
        let mut info: POINTER_INFO = unsafe { zeroed() };
        // SAFETY: `info` outlives the call.
        if unsafe { GetPointerInfo(pointer, &mut info) } == 0 {
            return;
        }
        let (x, y) = Self::position(hwnd, &info);
        let now = super::qpc::now_ns();
        let time_ns = self.touch_clock.borrow_mut().admit(pointer, EntryTime { counter_ns: super::qpc::counter_ns(info.PerformanceCount), millis: info.dwTime }, 0, info.dwTime, now).unwrap_or(now);
        if cancels(info.pointerFlags) {
            self.contacts.borrow_mut().retain(|p| *p != pointer);
            self.counters.interrupts.fetch_add(1, Ordering::Relaxed);
            self.queue.push(InputEvent::Interrupted { pointer, time_ns, reason: InterruptReason::Canceled });
            return;
        }
        let mut sample = PenSample::at(time_ns, pointer, Tool::Touch, x, y);
        sample.phase = phase_of(info.pointerFlags);
        if sample.phase != Phase::Hover && sample.phase != Phase::Up {
            sample.buttons = PenButtons::TIP;
        }
        sample.modifiers = modifiers();
        self.track(pointer, sample.phase);
        self.counters.touch_samples.fetch_add(1, Ordering::Relaxed);
        self.queue.push(InputEvent::Sample(sample));
    }

    fn interrupt_all(&self, reason: InterruptReason) {
        let time_ns = super::qpc::now_ns();
        let pointers: Vec<u32> = self.contacts.borrow_mut().drain(..).collect();
        for pointer in pointers {
            self.counters.interrupts.fetch_add(1, Ordering::Relaxed);
            self.queue.push(InputEvent::Interrupted { pointer, time_ns, reason });
        }
        if self.mouse_down.replace(false) {
            self.counters.interrupts.fetch_add(1, Ordering::Relaxed);
            self.queue.push(InputEvent::Interrupted { pointer: MOUSE_POINTER, time_ns, reason });
        }
    }

    fn interrupt_mouse(&self, reason: InterruptReason) {
        if self.mouse_down.replace(false) {
            self.counters.interrupts.fetch_add(1, Ordering::Relaxed);
            self.queue.push(InputEvent::Interrupted { pointer: MOUSE_POINTER, time_ns: super::qpc::now_ns(), reason });
        }
    }

    fn capture_lost(&self, pointer: u32) {
        let was_in_contact = {
            let mut contacts = self.contacts.borrow_mut();
            let before = contacts.len();
            contacts.retain(|p| *p != pointer);
            contacts.len() != before
        };
        if was_in_contact {
            self.counters.interrupts.fetch_add(1, Ordering::Relaxed);
            self.queue.push(InputEvent::Interrupted { pointer, time_ns: super::qpc::now_ns(), reason: InterruptReason::CaptureLost });
        }
    }

    /// A mouse message: a real mouse becomes a sample, a promoted one is counted and ignored.
    fn mouse(&self, msg: u32, lparam: LPARAM) {
        if promotion(unsafe { GetMessageExtraInfo() }) != Promotion::No {
            self.counters.promoted_mouse_messages.fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.counters.real_mouse_messages.fetch_add(1, Ordering::Relaxed);
        let (x, y) = ((lparam & 0xFFFF) as u16 as i16 as f64, ((lparam >> 16) & 0xFFFF) as u16 as i16 as f64);
        let mut sample = PenSample::at(super::qpc::now_ns(), MOUSE_POINTER, Tool::Mouse, x, y);
        sample.modifiers = modifiers();
        let barrel = match msg {
            WM_RBUTTONDOWN => true,
            WM_RBUTTONUP => false,
            _ => self.mouse_barrel.get(),
        };
        self.mouse_barrel.set(barrel);
        let down = match msg {
            WM_LBUTTONDOWN => {
                self.mouse_down.set(true);
                sample.phase = Phase::Down;
                true
            }
            WM_LBUTTONUP => {
                let was = self.mouse_down.replace(false);
                sample.phase = Phase::Up;
                if !was {
                    return;
                }
                false
            }
            _ => {
                let held = self.mouse_down.get();
                sample.phase = if held { Phase::Move } else { Phase::Hover };
                held
            }
        };
        if down {
            sample.buttons = PenButtons::TIP;
        }
        if barrel {
            sample.buttons = sample.buttons | PenButtons::BARREL;
        }
        self.queue.push(InputEvent::Sample(sample));
    }
}

unsafe extern "system" fn subclass_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, data: usize) -> LRESULT {
    // SAFETY: `data` is the pointer to the `Hook` leaked by `WindowsInput::attach`; it lives until the subclass is removed,
    // and the procedure runs only on the window's thread, so the cells are never shared.
    let hook = unsafe { &*(data as *const Hook) };
    match msg {
        WM_POINTERDOWN | WM_POINTERUPDATE | WM_POINTERUP | WM_POINTERENTER => {
            let pointer = (wparam & 0xFFFF) as u32;
            let mut kind = 0;
            // SAFETY: `kind` outlives the call.
            if unsafe { GetPointerType(pointer, &mut kind) } != 0 {
                if kind == PT_PEN {
                    hook.pen(hwnd, pointer);
                    // The pen is the application's; Windows promotes it to mouse messages for the toolkit.
                    return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
                }
                if kind == PT_TOUCH {
                    hook.touch(hwnd, pointer);
                }
            }
        }
        WM_POINTERCAPTURECHANGED => hook.capture_lost((wparam & 0xFFFF) as u32),
        WM_CANCELMODE => hook.interrupt_all(InterruptReason::CaptureLost),
        // Another window took the mouse: the stroke it was drawing is over, wherever the button is released.
        WM_CAPTURECHANGED if lparam as isize != hwnd as isize => hook.interrupt_mouse(InterruptReason::CaptureLost),
        WM_KILLFOCUS => hook.interrupt_all(InterruptReason::FocusLost),
        WM_ACTIVATE if wparam & 0xFFFF == 0 => hook.interrupt_all(InterruptReason::FocusLost),
        WM_LBUTTONDOWN | WM_LBUTTONUP | WM_RBUTTONDOWN | WM_RBUTTONUP | WM_MOUSEMOVE => hook.mouse(msg, lparam),
        WM_CONTEXTMENU => {
            hook.counters.context_menus.fetch_add(1, Ordering::Relaxed);
        }
        WM_NCDESTROY => {
            // The window is going: take the hook off before it is gone. The `Hook` itself is freed by `detach`.
            unsafe { RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID) };
        }
        _ => {}
    }
    // SAFETY: forwards the message this procedure received, unchanged.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

const SUBCLASS_ID: usize = super::subclass_id::POINTER;

/// The Windows pen, touch and mouse source. Attach it on the thread that owns the window and drop it there.
pub struct WindowsInput {
    hwnd: HWND,
    hook: *mut Hook,
    counters: Arc<InputCounters>,
}

impl WindowsInput {
    /// Hooks the window and starts pushing events into `queue`.
    pub fn attach(window: &dyn HasWindowHandle, queue: InputQueue) -> Result<WindowsInput, InputError> {
        let RawWindowHandle::Win32(handle) = window.window_handle().map_err(|_| InputError::NoWindow)?.as_raw() else {
            return Err(InputError::NoWindow);
        };
        let hwnd = handle.hwnd.get() as HWND;
        let counters = Arc::new(InputCounters::default());
        let hook = Box::into_raw(Box::new(Hook {
            queue,
            counters: counters.clone(),
            contacts: RefCell::new(Vec::new()),
            mouse_down: Cell::new(false),
            mouse_barrel: Cell::new(false),
            scratch: RefCell::new(Vec::new()),
            pen_clock: RefCell::new(HistoryClock::new()),
            touch_clock: RefCell::new(HistoryClock::new()),
        }));
        // SAFETY: `hook` stays allocated until `detach`, which removes the subclass first; the property value is plain bits.
        unsafe {
            if SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, hook as usize) == 0 {
                drop(Box::from_raw(hook));
                return Err(InputError::Os("SetWindowSubclass"));
            }
            let switched_off = TABLET_DISABLE_PRESSANDHOLD | TABLET_DISABLE_PENTAPFEEDBACK | TABLET_DISABLE_PENBARRELFEEDBACK | TABLET_DISABLE_FLICKS;
            SetPropW(hwnd, TABLET_PROPERTY.as_ptr(), switched_off as usize as *mut _);
        }
        Ok(WindowsInput { hwnd, hook, counters })
    }

    pub fn counters(&self) -> Arc<InputCounters> {
        self.counters.clone()
    }
}

impl InputSource for WindowsInput {
    fn caps(&self) -> InputCaps {
        InputCaps { name: "Windows pointer input", pressure: true, pressure_max: PRESSURE_RANGE, tilt: true, twist: true, eraser: true, barrel: true, hover: true, history: true }
    }

    fn detach(&mut self) {
        if self.hook.is_null() {
            return;
        }
        // SAFETY: removes the subclass (a no-op if the window already did), then frees the hook it pointed to, once.
        unsafe {
            RemovePropW(self.hwnd, TABLET_PROPERTY.as_ptr());
            RemoveWindowSubclass(self.hwnd, Some(subclass_proc), SUBCLASS_ID);
            drop(Box::from_raw(self.hook));
        }
        self.hook = std::ptr::null_mut();
    }
}

/// The Windows input host: the `WM_POINTER` source, the performance counter and the display's refresh rate, behind
/// the traits the developer tools read.
pub struct WindowsInputHost;

struct CountersView(Arc<InputCounters>);

impl styk_services::input::InputDiagnostics for CountersView {
    fn counters(&self) -> styk_services::input::SourceCounters {
        let c = &self.0;
        let get = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        styk_services::input::SourceCounters {
            pen_messages: get(&c.pen_messages),
            pen_samples: get(&c.pen_samples),
            history_samples: get(&c.history_samples),
            repeated_entries: get(&c.repeated_entries),
            touch_samples: get(&c.touch_samples),
            real_mouse_messages: get(&c.real_mouse_messages),
            promoted_mouse_messages: get(&c.promoted_mouse_messages),
            context_menus: get(&c.context_menus),
        }
    }
}

impl styk_services::input::InputHost for WindowsInputHost {
    fn clock(&self) -> Arc<dyn Clock> {
        Arc::new(super::qpc::QpcClock)
    }

    fn attach(&self, window: &dyn HasWindowHandle, queue: InputQueue) -> Result<styk_services::input::AttachedInput, String> {
        let source = WindowsInput::attach(window, queue).map_err(|error| error.to_string())?;
        Ok(styk_services::input::AttachedInput { diagnostics: Arc::new(CountersView(source.counters())), refresh_hz: refresh_hz(window), hook: Box::new(source) })
    }
}

impl Drop for WindowsInput {
    fn drop(&mut self) {
        self.detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::Input::Pointer::{POINTER_FLAG_INRANGE, POINTER_FLAG_UPDATE};

    fn entry(flags: u32, pen_flags: u32, mask: u32, pressure: u32, tilt: (i32, i32)) -> POINTER_PEN_INFO {
        let mut e: POINTER_PEN_INFO = unsafe { zeroed() };
        e.pointerInfo.pointerId = 5;
        e.pointerInfo.pointerFlags = flags;
        e.penFlags = pen_flags;
        e.penMask = mask;
        e.pressure = pressure;
        e.tiltX = tilt.0;
        e.tiltY = tilt.1;
        e
    }

    #[test]
    fn promoted_mouse_messages_are_told_from_real_ones_by_the_signature() {
        assert_eq!(promotion(0), Promotion::No);
        assert_eq!(promotion(0x1234), Promotion::No);
        assert_eq!(promotion(0xFF51_5700u32 as isize), Promotion::Pen);
        assert_eq!(promotion(0xFF51_5780u32 as isize), Promotion::Touch);
        assert_eq!(promotion(0xFF51_5701u32 as isize), Promotion::Pen, "the low bits carry the pointer, not the kind");
        assert_eq!(promotion(0xFF51_5600u32 as isize), Promotion::No);
    }

    #[test]
    fn a_cancel_is_read_with_or_without_a_lift() {
        assert!(cancels(POINTER_FLAG_UP | POINTER_FLAG_CANCELED));
        assert!(cancels(POINTER_FLAG_UPDATE | POINTER_FLAG_INCONTACT | POINTER_FLAG_CANCELED), "Windows also cancels with an update");
        assert!(!cancels(POINTER_FLAG_UP | POINTER_FLAG_INRANGE));
    }

    #[test]
    fn flags_map_to_phases() {
        assert_eq!(phase_of(POINTER_FLAG_INRANGE | POINTER_FLAG_UPDATE), Phase::Hover);
        assert_eq!(phase_of(POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT | POINTER_FLAG_DOWN), Phase::Down);
        assert_eq!(phase_of(POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT | POINTER_FLAG_UPDATE), Phase::Move);
        assert_eq!(phase_of(POINTER_FLAG_INRANGE | POINTER_FLAG_UP), Phase::Up);
    }

    #[test]
    fn a_pen_entry_becomes_a_sample_with_every_field() {
        let e = entry(POINTER_FLAG_INCONTACT | POINTER_FLAG_UPDATE, PEN_FLAG_BARREL, PEN_MASK_PRESSURE | PEN_MASK_TILT_X | PEN_MASK_TILT_Y, 512, (-30, 45));
        let s = pen_sample(&e, (10.5, 20.25), 1234, Modifiers::SHIFT);
        assert_eq!((s.tool, s.phase, s.pointer, s.time_ns), (Tool::Pen, Phase::Move, 5, 1234));
        assert_eq!((s.x, s.y), (10.5, 20.25));
        assert_eq!((s.pressure, s.raw_pressure, s.pressure_max), (0.5, 512, 1024));
        assert_eq!((s.tilt_x, s.tilt_y), (-30.0, 45.0));
        assert!(s.valid.contains(Valid::PRESSURE | Valid::TILT) && !s.valid.contains(Valid::TWIST));
        assert!(s.buttons.contains(PenButtons::TIP | PenButtons::BARREL));
        assert_eq!(s.modifiers, Modifiers::SHIFT);
    }

    #[test]
    fn the_eraser_end_is_the_eraser_tool_and_a_lift_has_no_tip() {
        let e = entry(POINTER_FLAG_UP, PEN_FLAG_INVERTED | PEN_FLAG_ERASER, PEN_MASK_PRESSURE, 0, (0, 0));
        let s = pen_sample(&e, (0.0, 0.0), 1, Modifiers::NONE);
        assert_eq!((s.tool, s.phase), (Tool::Eraser, Phase::Up));
        assert!(!s.buttons.contains(PenButtons::TIP));
    }

    #[test]
    fn a_pen_without_pressure_or_tilt_says_so_instead_of_reporting_zero() {
        let e = entry(POINTER_FLAG_INCONTACT | POINTER_FLAG_UPDATE, 0, 0, 900, (12, 12));
        let s = pen_sample(&e, (0.0, 0.0), 1, Modifiers::NONE);
        assert!(s.valid.is_empty());
        assert_eq!((s.pressure, s.tilt_x), (0.0, 0.0));
        // Pressure beyond the range is clamped, never above 1.
        let over = pen_sample(&entry(POINTER_FLAG_INCONTACT, 0, PEN_MASK_PRESSURE, 5000, (0, 0)), (0.0, 0.0), 1, Modifiers::NONE);
        assert_eq!(over.pressure, 1.0);
    }

    #[test]
    fn digitizer_units_map_onto_display_pixels_with_a_fraction() {
        // A tablet 20000 units wide across 2000 pixels: 10 units a pixel.
        assert_eq!(scale_himetric(10_005, (0, 20_000), (0, 2_000)), 1000.5);
        assert_eq!(scale_himetric(7, (0, 0), (100, 200)), 100.0, "an empty device range does not divide by zero");
        assert_eq!(scale_himetric(500, (500, 1500), (1920, 3840)), 1920.0, "a second monitor's origin");
    }
}

/// Where the window's client area starts on the screen, in physical pixels.
pub fn client_origin(window: &dyn HasWindowHandle) -> Result<(i32, i32), InputError> {
    let RawWindowHandle::Win32(handle) = window.window_handle().map_err(|_| InputError::NoWindow)?.as_raw() else {
        return Err(InputError::NoWindow);
    };
    Ok(Hook::client_origin(handle.hwnd.get() as HWND))
}

/// The refresh rate of the display the window is on, in hertz (0 when the system does not say).
pub fn refresh_hz(window: &dyn HasWindowHandle) -> f64 {
    use windows_sys::Win32::Graphics::Gdi::{DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplaySettingsW, GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFOEXW, MonitorFromWindow};
    let Ok(handle) = window.window_handle() else { return 0.0 };
    let RawWindowHandle::Win32(handle) = handle.as_raw() else { return 0.0 };
    // SAFETY: the structures outlive the calls and carry their size fields as the API requires.
    unsafe {
        let monitor = MonitorFromWindow(handle.hwnd.get() as HWND, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFOEXW = zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(monitor, &mut info as *mut MONITORINFOEXW as *mut _) == 0 {
            return 0.0;
        }
        let mut mode: DEVMODEW = zeroed();
        mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        if EnumDisplaySettingsW(info.szDevice.as_ptr(), ENUM_CURRENT_SETTINGS, &mut mode) == 0 { 0.0 } else { mode.dmDisplayFrequency as f64 }
    }
}

/// The window's subclass chain holds every owner: the pointer source passes on what is not its own, and subclasses installed before
/// and after it (the window chrome will be one) see their messages and keep their ids.
#[cfg(test)]
mod chain_tests {
    use super::*;
    use crate::input::{ImePhase, send_ime};
    use raw_window_handle::{Win32WindowHandle, WindowHandle};
    use std::num::NonZeroIsize;
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE, SendMessageW, WM_CHAR, WM_IME_STARTCOMPOSITION, WM_KEYDOWN};

    thread_local! {
        /// `(subclass id, message)` in the order the subclasses saw them.
        static SEEN: RefCell<Vec<(usize, u32)>> = const { RefCell::new(Vec::new()) };
    }

    unsafe extern "system" fn recorder(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, id: usize, _: usize) -> LRESULT {
        SEEN.with(|seen| seen.borrow_mut().push((id, msg)));
        // SAFETY: forwards the message unchanged.
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }

    struct Handle(HWND);

    impl HasWindowHandle for Handle {
        fn window_handle(&self) -> Result<WindowHandle<'_>, raw_window_handle::HandleError> {
            let raw = RawWindowHandle::Win32(Win32WindowHandle::new(NonZeroIsize::new(self.0 as isize).unwrap()));
            // SAFETY: the window outlives the handle in this test.
            Ok(unsafe { WindowHandle::borrow_raw(raw) })
        }
    }

    const INNER: usize = 0x7001;
    const OUTER: usize = 0x7002;

    #[test]
    fn subclasses_installed_before_and_after_the_pointer_source_all_see_the_messages_and_the_source_still_samples() {
        // A message-only window: it is never on the screen, and it needs no input from the person at the computer.
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        // SAFETY: a plain window of a system class owned by this thread.
        let hwnd = unsafe { CreateWindowExW(0, class.as_ptr(), std::ptr::null(), 0, 0, 0, 0, 0, HWND_MESSAGE, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null()) };
        assert!(!hwnd.is_null(), "the message-only window was created");
        let handle = Handle(hwnd);
        // SAFETY: both are removed (the window is destroyed) on this thread before the test ends.
        assert_ne!(unsafe { SetWindowSubclass(hwnd, Some(recorder), INNER, 0) }, 0);
        let queue = InputQueue::new();
        let source = WindowsInput::attach(&handle, queue.clone()).expect("the pointer source attaches");
        assert_ne!(unsafe { SetWindowSubclass(hwnd, Some(recorder), OUTER, 0) }, 0);
        assert!(![INNER, OUTER].contains(&super::super::subclass_id::POINTER), "each owner has an id of its own");

        send_ime(&handle, ImePhase::Start).expect("the composition message is delivered");
        // SAFETY: plain messages to our own window on its own thread.
        unsafe {
            SendMessageW(hwnd, WM_KEYDOWN, 0x42, 0);
            SendMessageW(hwnd, WM_CHAR, 0x62, 0);
            SendMessageW(hwnd, WM_LBUTTONDOWN, 1, (20 << 16) | 10);
        }
        let seen = SEEN.with(|seen| seen.borrow().clone());
        for message in [WM_IME_STARTCOMPOSITION, WM_KEYDOWN, WM_CHAR, WM_LBUTTONDOWN] {
            let order: Vec<usize> = seen.iter().filter(|s| s.1 == message).map(|s| s.0).collect();
            assert_eq!(order, [OUTER, INNER], "message {message:#x} went through the whole chain, outermost first: {seen:?}");
        }
        let mut events = Vec::new();
        queue.drain(&mut events);
        assert!(events.iter().any(|e| matches!(e, InputEvent::Sample(s) if s.tool == Tool::Mouse && s.phase == Phase::Down)), "and the source made the press a sample: {events:?}");

        drop(source);
        let before = SEEN.with(|seen| seen.borrow().len());
        // SAFETY: as above.
        unsafe { SendMessageW(hwnd, WM_KEYDOWN, 0x43, 0) };
        assert_eq!(SEEN.with(|seen| seen.borrow().len()) - before, 2, "unhooking the source leaves the other subclasses in the chain");
        // SAFETY: this thread made the window.
        unsafe { DestroyWindow(hwnd) };
    }
}
