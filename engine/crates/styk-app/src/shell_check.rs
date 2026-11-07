//! `--shell-check`: the shell's behaviour on the real window, asked in process.
//!
//! Every question is a message to the window's own procedure from its own thread, or a read of its state; nothing is
//! injected and no window is placed on the screen (decision N6). It runs only in an unattended run, whose window is
//! outside every monitor. What a person has to try with a real pointer is listed in `docs/native/shell.md`.

use iced::window::Window;
use styk_platform::windows::chrome::Chrome;
use styk_platform::windows::probe;
use styk_services::shell::Rect;
use styk_services::shell::chrome::{band_regions, ht};

/// One finished check.
#[derive(Clone, Debug)]
pub struct Line {
    /// What was checked.
    pub name: String,
    /// `None` when it passed, else what was wrong.
    pub failure: Option<String>,
}

fn pass_if(name: &str, ok: bool, detail: impl FnOnce() -> String) -> Line {
    Line { name: name.to_string(), failure: (!ok).then(detail) }
}

/// What the check wants to know about the DPI step afterwards.
#[derive(Clone, Copy, Debug)]
pub struct DpiProbe {
    /// The client size before the DPI message, physical.
    pub before: (i32, i32),
    /// The client size right after, physical.
    pub after: (i32, i32),
    /// The logical size before the message (what the interface was told last).
    pub logical_before: (f32, f32),
}

/// The synchronous checks, run on the window's thread. `scale` is physical pixels per logical pixel.
pub fn run(window: &dyn Window, chrome: &Chrome, scale: f32, logical: (f32, f32), foreground_before: isize) -> (Vec<Line>, Option<DpiProbe>) {
    let mut lines = Vec::new();
    let Some((w, h)) = probe::client_size(window) else {
        return (vec![Line { name: "client size".into(), failure: Some("the window has none".into()) }], None);
    };
    let band = styk_services::shell::chrome::band_height(1.0, h < (801.0 * scale) as i32);
    let regions = band_regions(w, scale, band, false, &[]);
    chrome.publish(regions.clone());
    let at = |x: i32, y: i32| probe::hit_test_at(window, x, y).unwrap_or(-1);
    let maximize = regions.maximize.expect("the band has a maximize button");
    let close = regions.buttons[1];
    let cases: [(&str, i32, i32, i32); 9] = [
        ("left edge gives HTLEFT", 2, h / 2, ht::LEFT),
        ("top-left corner gives HTTOPLEFT", 2, 2, ht::TOPLEFT),
        ("bottom-right corner gives HTBOTTOMRIGHT", w - 3, h - 3, ht::BOTTOMRIGHT),
        ("bottom edge gives HTBOTTOM", w / 2, h - 3, ht::BOTTOM),
        ("top edge gives HTTOP", w / 3, 2, ht::TOP),
        ("empty band gives HTCAPTION", w / 3, band as i32 / 2, ht::CAPTION),
        ("maximize button centre gives HTMAXBUTTON", maximize.x + maximize.w / 2, maximize.y + maximize.h / 2, ht::MAXBUTTON),
        ("maximize button top pixels still give HTMAXBUTTON (snap flyout)", maximize.x + maximize.w / 2, 1, ht::MAXBUTTON),
        ("close button centre is client", close.x + close.w / 2, close.y + close.h / 2, ht::CLIENT),
    ];
    for (name, x, y, want) in cases {
        let got = at(x, y);
        lines.push(pass_if(name, got == want, || format!("({x},{y}) gave {got}, wanted {want}")));
    }
    lines.push(pass_if("below the band is client", at(w / 2, h / 2) == ht::CLIENT, || format!("gave {}", at(w / 2, h / 2))));

    chrome.set_fullscreen(true);
    let fullscreen_edges = [at(2, h / 2), at(w / 3, band as i32 / 2), at(maximize.x + 5, 5)];
    chrome.set_fullscreen(false);
    lines.push(pass_if("fullscreen has no edges, caption or maximize button", fullscreen_edges.iter().all(|c| *c == ht::CLIENT), || format!("{fullscreen_edges:?}")));
    chrome.publish(Default::default());
    lines.push(pass_if("a hidden band leaves no caption", at(w / 3, band as i32 / 2) == ht::CLIENT, || format!("gave {}", at(w / 3, band as i32 / 2))));
    chrome.publish(regions);

    lines.push(pass_if("DPI awareness is per-monitor v2", probe::is_per_monitor_v2(window) == Some(true), || "it is not".into()));

    let min = probe::min_track_size(window).unwrap_or((0, 0));
    let want = ((1000.0 * scale).ceil() as i32, (680.0 * scale).ceil() as i32);
    lines.push(pass_if("the minimum size is 1000 x 680 logical", (min.0 - want.0).abs() <= 1 && (min.1 - want.1).abs() <= 1, || format!("{min:?}, wanted {want:?}")));

    // Snap zones against a work area far outside every monitor: the window must take each zone's rectangle, except that
    // a zone below the minimum size is clamped up to it (Windows documents the same for snap layouts).
    let work = Rect::new(-30000, -30000, 2560, 1392);
    let original = probe_rect(window);
    let zones = [
        ("left half", Rect::new(work.x, work.y, work.w / 2, work.h)),
        ("right half", Rect::new(work.x + work.w / 2, work.y, work.w / 2, work.h)),
        ("top-left quarter", Rect::new(work.x, work.y, work.w / 2, work.h / 2)),
        ("bottom-right quarter", Rect::new(work.x + work.w / 2, work.y + work.h / 2, work.w / 2, work.h / 2)),
        ("left third", Rect::new(work.x, work.y, work.w / 3, work.h)),
    ];
    for (name, zone) in zones {
        let got = probe::place(window, zone);
        let expect = Rect::new(zone.x, zone.y, zone.w.max(min.0), zone.h.max(min.1));
        lines.push(pass_if(&format!("snap zone {name} is taken (clamped to the minimum)"), got == Some(expect), || format!("{got:?}, wanted {expect:?}")));
    }
    if let Some(original) = original {
        probe::place(window, original);
    }

    lines.push(pass_if("an unattended window has no taskbar button", probe::has_no_taskbar_button(window) == Some(true), || "it has one".into()));
    lines.push(pass_if("the foreground window did not change", probe::foreground() == foreground_before, || "it changed".into()));

    // The DPI step: the message goes in now; the events it causes are read by the caller afterwards.
    let before = probe::client_size(window).unwrap_or((0, 0));
    let current = original.unwrap_or(Rect::new(-20000, -20000, w, h));
    let suggested = scaled(current, 1.5);
    probe::send_dpi_changed(window, 144, suggested);
    let after = probe::client_size(window).unwrap_or((0, 0));
    (lines, Some(DpiProbe { before, after, logical_before: logical }))
}

/// Puts the DPI back after the step.
pub fn restore_dpi(window: &dyn Window, current_dpi: u32, original: Rect) {
    let suggested = scaled(original, 1.0);
    probe::send_dpi_changed(window, current_dpi, suggested);
}

fn probe_rect(window: &dyn Window) -> Option<Rect> {
    styk_platform::windows::monitors::hwnd_of(window).and_then(styk_platform::windows::monitors::window_rect)
}

fn scaled(rect: Rect, factor: f32) -> Rect {
    Rect::new(rect.x, rect.y, (rect.w as f32 * factor) as i32, (rect.h as f32 * factor) as i32)
}

/// Judges the DPI step once the events have arrived: the logical size stayed within a pixel, the scale factor became
/// 1.5, and the physical client followed it.
pub fn judge_dpi(probe: DpiProbe, logical_now: (f32, f32), scales_seen: &[f32]) -> Vec<Line> {
    let logical_ok = (logical_now.0 - probe.logical_before.0).abs() < 1.0 && (logical_now.1 - probe.logical_before.1).abs() < 1.0;
    let physical_ok = (probe.after.0 as f32 - probe.before.0 as f32 * 1.5).abs() <= 2.0 && (probe.after.1 as f32 - probe.before.1 as f32 * 1.5).abs() <= 2.0;
    vec![
        pass_if("a DPI change 96 to 144 keeps the logical size within 1 px", logical_ok, || format!("{:?} became {logical_now:?}", probe.logical_before)),
        pass_if("a DPI change 96 to 144 scales the physical client by 1.5", physical_ok, || format!("{:?} became {:?}", probe.before, probe.after)),
        pass_if("the interface was told the scale factor 1.5", scales_seen.iter().any(|s| (*s - 1.5).abs() < 1e-3), || format!("saw {scales_seen:?}")),
    ]
}
