//! Where the window goes: monitors, the saved frame per monitor setup, and fitting a frame to what is attached now.
//!
//! Everything is in physical pixels in screen coordinates, and only screen-coordinate calls place the window
//! (`SetWindowPos`, then `ShowWindow`): `WINDOWPLACEMENT` counts from the work area, so a top or left taskbar would
//! displace a window restored through it.

use super::geometry::Rect;
use super::instance::fnv1a;
use std::fmt::Write as _;

/// The window's default logical size (`desktop/main.cjs`).
pub const DEFAULT_SIZE: (i32, i32) = (1560, 1000);
/// The smallest logical size (`desktop/main.cjs`).
pub const MIN_SIZE: (i32, i32) = (1000, 680);
/// The band is 52 logical px, 44 in the compact chrome (`topbar.css`); the grip is as tall as the smaller.
pub const GRIP_BAND: i32 = 44;
/// The least width of the band that must be on screen to take hold of it, in logical px.
pub const GRIP_WIDTH: i32 = 64;
/// How long after the last change the frame is saved.
pub const SAVE_DELAY_MS: u64 = 500;
/// The most monitor setups remembered.
pub const MAX_SETUPS: usize = 16;
/// The largest state file read.
pub const MAX_FILE: usize = 16 * 1024;

/// One attached display.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MonitorInfo {
    /// The whole monitor.
    pub rect: Rect,
    /// The part not covered by the taskbar.
    pub work: Rect,
    /// Scale in thousandths (1000 = 100 %, 1500 = 150 %).
    pub scale_milli: u32,
    /// Whether it is the primary monitor.
    pub primary: bool,
}

/// The window's frame: its normal (restored) rectangle, whether it is maximized, and the scale it was made at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowFrame {
    /// The normal rectangle in screen coordinates.
    pub rect: Rect,
    /// Maximized.
    pub maximized: bool,
    /// The scale of the monitor it was on, in thousandths.
    pub scale_milli: u32,
}

/// Names a set of attached monitors: the same arrangement gives the same key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SetupKey(pub u64);

impl SetupKey {
    /// The key of these monitors. Order and the taskbar's place do not matter; position, size and scale do.
    pub fn of(monitors: &[MonitorInfo]) -> SetupKey {
        let mut tuples: Vec<(i32, i32, i32, i32, u32)> = monitors.iter().map(|m| (m.rect.x, m.rect.y, m.rect.w, m.rect.h, m.scale_milli)).collect();
        tuples.sort_unstable();
        let mut bytes = Vec::with_capacity(tuples.len() * 20);
        for (x, y, w, h, s) in tuples {
            for n in [x, y, w, h] {
                bytes.extend_from_slice(&n.to_le_bytes());
            }
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        SetupKey(fnv1a(&bytes))
    }
}

fn scaled(logical: i32, scale_milli: u32) -> i32 {
    ((i64::from(logical) * i64::from(scale_milli) + 999) / 1000) as i32
}

/// The monitor a rectangle mostly lies on; the primary (else the first) when it lies on none.
pub fn monitor_for<'a>(rect: &Rect, monitors: &'a [MonitorInfo]) -> Option<&'a MonitorInfo> {
    monitors
        .iter()
        .map(|m| (m.rect.intersect(rect).area(), m))
        .filter(|(area, _)| *area > 0)
        .max_by_key(|(area, _)| *area)
        .map(|(_, m)| m)
        .or_else(|| monitors.iter().find(|m| m.primary).or(monitors.first()))
}

/// Whether the band's strip can be taken hold of: as high as the band, and at least [`GRIP_WIDTH`] logical px wide
/// (or the window's whole width if narrower), inside one work area.
pub fn grip_reachable(rect: &Rect, scale_milli: u32, monitors: &[MonitorInfo]) -> bool {
    let band = scaled(GRIP_BAND, scale_milli);
    let wanted = scaled(GRIP_WIDTH, scale_milli).min(rect.w);
    let strip = Rect::new(rect.x, rect.y, rect.w, band);
    monitors.iter().any(|m| {
        let seen = strip.intersect(&m.work);
        seen.w >= wanted && seen.h >= band
    })
}

/// The default frame: 1560 x 1000 logical, centred on the primary monitor's work area and no larger than it.
pub fn default_frame(monitors: &[MonitorInfo]) -> Option<WindowFrame> {
    let monitor = monitors.iter().find(|m| m.primary).or(monitors.first())?;
    Some(centred(scaled(DEFAULT_SIZE.0, monitor.scale_milli), scaled(DEFAULT_SIZE.1, monitor.scale_milli), monitor, false))
}

fn centred(w: i32, h: i32, monitor: &MonitorInfo, maximized: bool) -> WindowFrame {
    let scale = monitor.scale_milli;
    let min_w = scaled(MIN_SIZE.0, scale).min(monitor.work.w);
    let min_h = scaled(MIN_SIZE.1, scale).min(monitor.work.h);
    let w = w.clamp(min_w, monitor.work.w.max(min_w));
    let h = h.clamp(min_h, monitor.work.h.max(min_h));
    let x = monitor.work.x + (monitor.work.w - w) / 2;
    let y = monitor.work.y + (monitor.work.h - h) / 2;
    WindowFrame { rect: Rect::new(x, y, w, h), maximized, scale_milli: scale }
}

/// Makes a saved frame fit the monitors attached now: never off-screen, never below the minimum size (at the scale of
/// the monitor it lands on) or above the work area, and the band's grip always reachable.
///
/// A frame on no monitor gets the default frame on the primary; one that overlaps a monitor keeps its position and
/// size when its grip is reachable, else it is centred there at its size.
pub fn fit_to_monitors(frame: &WindowFrame, monitors: &[MonitorInfo]) -> Option<WindowFrame> {
    if monitors.is_empty() {
        return None;
    }
    let overlapped = monitors.iter().any(|m| m.rect.intersect(&frame.rect).area() > 0);
    if !overlapped {
        return default_frame(monitors).map(|d| WindowFrame { maximized: frame.maximized, ..d });
    }
    let monitor = monitor_for(&frame.rect, monitors)?;
    let from = frame.scale_milli.max(1);
    let w = (i64::from(frame.rect.w) * i64::from(monitor.scale_milli) / i64::from(from)) as i32;
    let h = (i64::from(frame.rect.h) * i64::from(monitor.scale_milli) / i64::from(from)) as i32;
    let min_w = scaled(MIN_SIZE.0, monitor.scale_milli).min(monitor.work.w);
    let min_h = scaled(MIN_SIZE.1, monitor.scale_milli).min(monitor.work.h);
    let w = w.clamp(min_w, monitor.work.w.max(min_w));
    let h = h.clamp(min_h, monitor.work.h.max(min_h));
    let rect = Rect::new(frame.rect.x, frame.rect.y, w, h);
    if grip_reachable(&rect, monitor.scale_milli, monitors) {
        Some(WindowFrame { rect, maximized: frame.maximized, scale_milli: monitor.scale_milli })
    } else {
        Some(centred(w, h, monitor, frame.maximized))
    }
}

/// The attached displays.
pub trait MonitorSource {
    /// The monitors now attached, in physical pixels, with their work areas and scales.
    fn monitors(&self) -> Vec<MonitorInfo>;
}

/// A fixed set of monitors, for tests: two monitors, mixed scales, a taskbar on any edge.
pub struct FakeMonitors(pub Vec<MonitorInfo>);

impl MonitorSource for FakeMonitors {
    fn monitors(&self) -> Vec<MonitorInfo> {
        self.0.clone()
    }
}

/// The remembered frames: one per monitor setup, plus the last one for a setup never seen.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WindowStateFile {
    /// Oldest first.
    pub setups: Vec<(SetupKey, WindowFrame)>,
    /// The frame last saved, whatever the setup.
    pub last: Option<WindowFrame>,
}

impl WindowStateFile {
    /// The frame for this setup, else the last one saved.
    pub fn frame_for(&self, key: SetupKey) -> Option<WindowFrame> {
        self.setups.iter().rev().find(|(k, _)| *k == key).map(|(_, f)| *f).or(self.last)
    }

    /// Remembers a frame for a setup (and as the last), forgetting the oldest setups past [`MAX_SETUPS`].
    pub fn record(&mut self, key: SetupKey, frame: WindowFrame) {
        self.setups.retain(|(k, _)| *k != key);
        self.setups.push((key, frame));
        while self.setups.len() > MAX_SETUPS {
            self.setups.remove(0);
        }
        self.last = Some(frame);
    }

    /// The file's text.
    pub fn to_text(&self) -> String {
        let mut out = String::from("styk-window-state 1\n");
        for (key, frame) in &self.setups {
            let _ = writeln!(out, "setup {:016x} {}", key.0, frame_text(frame));
        }
        if let Some(frame) = &self.last {
            let _ = writeln!(out, "last {}", frame_text(frame));
        }
        out
    }

    /// Reads a file's text. Unknown or malformed lines are skipped; an unknown version, or text past [`MAX_FILE`], gives
    /// an empty state: a damaged state file must never stop the window from opening.
    pub fn parse(text: &str) -> WindowStateFile {
        let mut file = WindowStateFile::default();
        if text.len() > MAX_FILE {
            return file;
        }
        let mut lines = text.lines();
        if lines.next() != Some("styk-window-state 1") {
            return file;
        }
        for line in lines {
            let mut parts = line.split_whitespace();
            match parts.next() {
                Some("setup") => {
                    let key = parts.next().and_then(|k| u64::from_str_radix(k, 16).ok());
                    if let (Some(key), Some(frame)) = (key, parse_frame(&mut parts)) {
                        file.setups.retain(|(k, _)| k.0 != key);
                        file.setups.push((SetupKey(key), frame));
                    }
                }
                Some("last") => file.last = parse_frame(&mut parts).or(file.last),
                _ => {}
            }
        }
        while file.setups.len() > MAX_SETUPS {
            file.setups.remove(0);
        }
        file
    }
}

fn frame_text(f: &WindowFrame) -> String {
    format!("{} {} {} {} {} {}", f.rect.x, f.rect.y, f.rect.w, f.rect.h, u8::from(f.maximized), f.scale_milli)
}

fn parse_frame<'a>(parts: &mut impl Iterator<Item = &'a str>) -> Option<WindowFrame> {
    let mut number = || parts.next()?.parse::<i64>().ok();
    let (x, y, w, h, max, scale) = (number()?, number()?, number()?, number()?, number()?, number()?);
    let fits = |n: i64| (-1_000_000..=1_000_000).contains(&n);
    if !(fits(x) && fits(y) && (1..=100_000).contains(&w) && (1..=100_000).contains(&h) && (0..=1).contains(&max) && (250..=8000).contains(&scale)) {
        return None;
    }
    Some(WindowFrame { rect: Rect::new(x as i32, y as i32, w as i32, h as i32), maximized: max == 1, scale_milli: scale as u32 })
}

/// Collects changes and says when the frame is due to be saved: [`SAVE_DELAY_MS`] after the last one.
#[derive(Clone, Copy, Debug, Default)]
pub struct SaveDebounce {
    last_change: Option<u64>,
}

impl SaveDebounce {
    /// A move, resize or maximise happened at this time (milliseconds, any monotonic clock).
    pub fn changed(&mut self, now_ms: u64) {
        self.last_change = Some(now_ms);
    }

    /// Whether a save is due; true once per burst of changes.
    pub fn due(&mut self, now_ms: u64) -> bool {
        match self.last_change {
            Some(at) if now_ms.saturating_sub(at) >= SAVE_DELAY_MS => {
                self.last_change = None;
                true
            }
            _ => false,
        }
    }

    /// Whether a change is waiting to be saved (the close path saves it at once).
    pub fn pending(&self) -> bool {
        self.last_change.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: i32, y: i32, w: i32, h: i32, scale: u32, primary: bool) -> MonitorInfo {
        MonitorInfo { rect: Rect::new(x, y, w, h), work: Rect::new(x, y, w, h - 48), scale_milli: scale, primary }
    }

    fn frame(x: i32, y: i32, w: i32, h: i32) -> WindowFrame {
        WindowFrame { rect: Rect::new(x, y, w, h), maximized: false, scale_milli: 1000 }
    }

    const ONE: fn() -> Vec<MonitorInfo> = || vec![mon(0, 0, 2560, 1440, 1000, true)];

    #[test]
    fn a_frame_on_screen_is_kept_exactly() {
        let f = frame(111, 222, 1234, 777);
        assert_eq!(fit_to_monitors(&f, &ONE()), Some(f));
    }

    #[test]
    fn a_frame_fully_off_screen_opens_centred_at_the_default_size_on_the_primary() {
        let fitted = fit_to_monitors(&frame(-20000, -20000, 1234, 777), &ONE()).unwrap();
        assert_eq!((fitted.rect.w, fitted.rect.h), (1560, 1000));
        assert_eq!((fitted.rect.x, fitted.rect.y), ((2560 - 1560) / 2, (1392 - 1000) / 2));
    }

    #[test]
    fn a_small_display_gets_a_window_that_fits_it() {
        let small = vec![mon(0, 0, 1366, 768, 1000, true)];
        let fitted = fit_to_monitors(&frame(5000, 0, 1560, 1000), &small).unwrap();
        assert!(fitted.rect.w <= 1366 && fitted.rect.h <= 720, "{fitted:?}");
        assert!(fitted.rect.w >= 1000 && fitted.rect.h >= 680);
        assert!(grip_reachable(&fitted.rect, 1000, &small));
    }

    #[test]
    fn a_display_smaller_than_the_minimum_clamps_the_minimum_to_the_work_area() {
        let tiny = vec![mon(0, 0, 800, 600, 1000, true)];
        let fitted = fit_to_monitors(&frame(0, 0, 1560, 1000), &tiny).unwrap();
        assert_eq!((fitted.rect.w, fitted.rect.h), (800, 552));
    }

    #[test]
    fn the_minimum_scales_with_the_monitor() {
        let m = vec![mon(0, 0, 3840, 2160, 1500, true)];
        let fitted = fit_to_monitors(&WindowFrame { scale_milli: 1500, ..frame(10, 10, 400, 300) }, &m).unwrap();
        assert_eq!((fitted.rect.w, fitted.rect.h), (1500, 1020));
    }

    #[test]
    fn a_frame_moved_to_another_scale_keeps_its_logical_size() {
        let m = vec![mon(0, 0, 1920, 1080, 1000, true), mon(1920, 0, 3840, 2160, 2000, false)];
        let fitted = fit_to_monitors(&WindowFrame { rect: Rect::new(2000, 100, 1560, 1000), maximized: false, scale_milli: 1000 }, &m).unwrap();
        assert_eq!(fitted.scale_milli, 2000);
        assert_eq!((fitted.rect.w, fitted.rect.h), (3120, 2000));
    }

    #[test]
    fn the_band_must_be_reachable_at_the_band_height_not_a_square() {
        let monitors = ONE();
        // Only the 44 px band's strip (and not 64 px of height) is visible at the top of the work area.
        assert!(grip_reachable(&Rect::new(100, 0, 1560, 1000), 1000, &monitors));
        // Pushed up so the band is clipped by the screen's top edge.
        assert!(!grip_reachable(&Rect::new(100, -20, 1560, 1000), 1000, &monitors));
        // Only 30 px of the band's width remain on screen at the right edge.
        assert!(!grip_reachable(&Rect::new(2530, 100, 1560, 1000), 1000, &monitors));
        assert!(grip_reachable(&Rect::new(2480, 100, 1560, 1000), 1000, &monitors));
    }

    #[test]
    fn an_unreachable_band_is_centred_where_the_window_overlaps() {
        let fitted = fit_to_monitors(&frame(100, -400, 1560, 1000), &ONE()).unwrap();
        assert_eq!((fitted.rect.w, fitted.rect.h), (1560, 1000));
        assert!(grip_reachable(&fitted.rect, 1000, &ONE()));
    }

    #[test]
    fn an_unplugged_monitor_moves_the_window_to_the_primary() {
        let two = vec![mon(0, 0, 1920, 1080, 1000, true), mon(1920, 0, 1920, 1080, 1000, false)];
        let on_second = frame(2200, 100, 1400, 900);
        assert_eq!(fit_to_monitors(&on_second, &two), Some(on_second));
        let after = fit_to_monitors(&on_second, &two[..1]).unwrap();
        assert!(two[0].work.intersect(&after.rect).area() > 0 && after.rect.right() <= 1920);
    }

    #[test]
    fn no_monitors_is_no_answer() {
        assert_eq!(fit_to_monitors(&frame(0, 0, 100, 100), &[]), None);
        assert_eq!(default_frame(&[]), None);
    }

    #[test]
    fn the_setup_key_ignores_order_and_taskbar_and_notices_scale_and_arrangement() {
        let a = mon(0, 0, 1920, 1080, 1000, true);
        let b = mon(1920, 0, 2560, 1440, 1500, false);
        assert_eq!(SetupKey::of(&[a, b]), SetupKey::of(&[b, a]));
        let mut moved_taskbar = a;
        moved_taskbar.work = Rect::new(0, 40, 1920, 1040);
        assert_eq!(SetupKey::of(&[a, b]), SetupKey::of(&[moved_taskbar, b]));
        assert_ne!(SetupKey::of(&[a, b]), SetupKey::of(&[a, MonitorInfo { scale_milli: 1250, ..b }]));
        assert_ne!(SetupKey::of(&[a, b]), SetupKey::of(&[a]));
        assert_ne!(SetupKey::of(&[a, b]), SetupKey::of(&[a, MonitorInfo { rect: Rect::new(-2560, 0, 2560, 1440), ..b }]));
    }

    #[test]
    fn the_file_round_trips_and_an_unseen_setup_uses_the_last_frame() {
        let (one, two) = (SetupKey(1), SetupKey(2));
        let (fa, fb) = (frame(111, 222, 1234, 777), WindowFrame { maximized: true, ..frame(-5, 7, 1500, 900) });
        let mut file = WindowStateFile::default();
        file.record(one, fa);
        file.record(two, fb);
        let again = WindowStateFile::parse(&file.to_text());
        assert_eq!(again, file);
        assert_eq!(again.frame_for(one), Some(fa));
        assert_eq!(again.frame_for(SetupKey(99)), Some(fb), "an unseen setup uses the last frame saved");
    }

    #[test]
    fn recording_a_setup_again_replaces_it_and_old_setups_are_forgotten() {
        let mut file = WindowStateFile::default();
        for n in 0..(MAX_SETUPS as u64 + 5) {
            file.record(SetupKey(n), frame(n as i32, 0, 1000, 700));
        }
        assert_eq!(file.setups.len(), MAX_SETUPS);
        assert!(file.frame_for(SetupKey(0)).is_some_and(|f| f.rect.x != 0), "setup 0 is forgotten and falls back to the last");
        file.record(SetupKey(20), frame(7, 7, 1000, 700));
        assert_eq!(file.setups.iter().filter(|(k, _)| k.0 == 20).count(), 1);
    }

    #[test]
    fn a_damaged_file_never_stops_the_window() {
        for text in ["", "garbage", "styk-window-state 2\nlast 1 2 3 4 0 1000", &"x".repeat(MAX_FILE + 1)] {
            assert_eq!(WindowStateFile::parse(text), WindowStateFile::default());
        }
        let mixed = "styk-window-state 1\nsetup zz 1 2 3 4 0 1000\nsetup 0000000000000005 1 2 0 4 0 1000\nsetup 0000000000000006 1 2 300 400 0 1000\nlast 1 2 3\nnoise\n";
        let file = WindowStateFile::parse(mixed);
        assert_eq!(file.setups.len(), 1);
        assert_eq!(file.last, None);
    }

    #[test]
    fn two_relaunches_within_200_ms_save_once_per_burst() {
        let mut debounce = SaveDebounce::default();
        debounce.changed(0);
        debounce.changed(100);
        assert!(!debounce.due(550) && debounce.pending());
        assert!(debounce.due(600));
        assert!(!debounce.due(10_000) && !debounce.pending());
    }
}
