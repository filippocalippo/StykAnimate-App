//! The developer build's input check (`stykanimate --screen component-sheet --input-check <report.json>`).
//!
//! It drives the component sheet's first text field through the operating system's real input path, on the window's UI
//! thread, with the window off-screen and unfocused: switch the thread to the Arabic and the Hebrew keyboard layouts and
//! post the keys (the Arabic `B` key produces lam-alef, two scalars), then set and complete an input-method
//! composition on the window's input context and read where the candidate window was asked to appear. Each step writes
//! a line of the report; a step the machine cannot do (no input method installed) says why instead of passing.

use iced::{Task, window};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use styk_platform::input;

/// When each latency key was posted to the window.
static POSTED: OnceLock<Mutex<Vec<Instant>>> = OnceLock::new();

fn posted() -> &'static Mutex<Vec<Instant>> {
    POSTED.get_or_init(|| Mutex::new(Vec::new()))
}

/// How many keys the latency run types, and the gap between them.
const LATENCY_KEYS: usize = 150;
const LATENCY_GAP_MS: u64 = 40;

/// From each posted key to the start of the first redraw after it (the redraw that draws the edit), with the frames the
/// run saw. The redraw's own drawing and presenting come after its start, so this is a floor for keystroke to present.
pub fn latency_summary(frames: &[Instant]) -> String {
    let posted = posted().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut deltas: Vec<f64> = posted
        .iter()
        .filter_map(|&post| frames.iter().find(|&&frame| frame >= post).map(|&frame| (frame - post).as_secs_f64() * 1000.0))
        .collect();
    if deltas.is_empty() {
        return "no key reached a frame".to_owned();
    }
    deltas.sort_by(|a, b| a.total_cmp(b));
    let at = |p: f64| deltas[((deltas.len() as f64 * p) as usize).min(deltas.len() - 1)];
    format!("{} keys: p50 {:.1} ms, p95 {:.1} ms, p99 {:.1} ms, max {:.1} ms", deltas.len(), at(0.5), at(0.95), at(0.99), deltas[deltas.len() - 1])
}

/// One finished step.
#[derive(Clone, Debug)]
pub enum Step {
    /// The sheet's state after a step: the first field's text and whether a composition is open.
    Probe { label: &'static str },
    /// What the operating system answered.
    Result { label: &'static str, detail: String },
    /// The script ended.
    Finish,
}

const NAME: u64 = 10;

fn pause(millis: u64) -> Task<Step> {
    Task::future(async move {
        std::thread::sleep(Duration::from_millis(millis));
    })
    .discard()
}

fn on_ui_thread(id: window::Id, label: &'static str, work: impl FnOnce(&dyn window::Window) -> String + Send + 'static) -> Task<Step> {
    window::run(id, move |window| work(window)).map(move |detail| Step::Result { label, detail })
}

fn text_of(result: Result<(), styk_platform::window::WindowError>) -> String {
    match result {
        Ok(()) => "ok".to_owned(),
        Err(error) => format!("failed: {error}"),
    }
}

/// The steps, in order. `focus` gives the first field focus.
pub fn script(id: window::Id) -> Task<Step> {
    let vk_b = 0x42;
    let vk_a = 0x41;
    Task::none()
        .chain(pause(800))
        .chain(Task::done(Step::Probe { label: "start" }))
        .chain(on_ui_thread(id, "arabic layout", move |w| {
            let layout = input::activate_layout("00000401");
            let b_down = input::post_key(w, vk_b, true);
            let b_up = input::post_key(w, vk_b, false);
            format!("layout {layout:?}; key B down {}; up {}; the layout says B is {:?}", text_of(b_down), text_of(b_up), input::key_text("00000401", vk_b))
        }))
        .chain(pause(400))
        .chain(Task::done(Step::Probe { label: "after the Arabic B key" }))
        .chain(on_ui_thread(id, "hebrew layout", move |w| {
            let layout = input::activate_layout("0000040D");
            let a_down = input::post_key(w, vk_a, true);
            let a_up = input::post_key(w, vk_a, false);
            format!("layout {layout:?}; key A down {}; up {}; the layout says A is {:?}", text_of(a_down), text_of(a_up), input::key_text("0000040D", vk_a))
        }))
        .chain(pause(400))
        .chain(Task::done(Step::Probe { label: "after the Hebrew A key" }))
        .chain(on_ui_thread(id, "back to the US layout", |_| format!("{:?}", input::activate_layout("00000409"))))
        .chain(on_ui_thread(id, "compose", |w| {
            let composed = input::compose(w, "にほん");
            format!("SCS_SETSTR {}", text_of(composed))
        }))
        .chain(pause(400))
        .chain(Task::done(Step::Probe { label: "while composing" }))
        .chain(on_ui_thread(id, "candidate window", |w| format!("{:?}", input::candidate(w))))
        .chain(on_ui_thread(id, "complete", |w| format!("CPS_COMPLETE {}", text_of(input::complete(w)))))
        .chain(pause(400))
        .chain(Task::done(Step::Probe { label: "after completing" }))
        .chain(latency(id))
        .chain(Task::done(Step::Finish))
}

/// Types letters into the focused field, one every `LATENCY_GAP_MS`, recording when each was posted.
fn latency(id: window::Id) -> Task<Step> {
    let mut task = quietly(id, |_| {
        let _ = input::activate_layout("00000409");
    })
    .chain(pause(300));
    for n in 0..LATENCY_KEYS {
        let vk = 0x41 + (n % 26) as u16;
        task = task
            .chain(quietly(id, move |w| {
                posted().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(Instant::now());
                let _ = input::post_key(w, vk, true);
                let _ = input::post_key(w, vk, false);
            }))
            .chain(pause(LATENCY_GAP_MS));
    }
    task.chain(pause(300))
}

/// Like [`on_ui_thread`], for work whose answer the report does not need.
fn quietly(id: window::Id, work: impl FnOnce(&dyn window::Window) + Send + 'static) -> Task<Step> {
    window::run(id, move |window| work(window)).discard()
}

/// The ID of the field the script types into (the sheet's name field).
pub const FIELD: u64 = NAME;
