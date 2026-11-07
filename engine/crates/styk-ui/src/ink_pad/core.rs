//! What the pad shares between the interface thread (events, the inspector), the frame's `prepare` and the drawing worker.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use styk_core::drawing::wet::{LedgerStats, WetLedger};
use styk_core::drawing::worker::{HistoryOp, HistoryOutbox, Worker};
use styk_services::Clock;
use styk_services::input::{InputQueue, PenSample, QueueStats};

/// How many inter-sample gaps the inspector remembers.
const GAPS: usize = 512;
/// Rows the recorder keeps of each kind: minutes of 240 Hz input.
pub const RECORDER_ROWS: usize = 1 << 20;

/// The brush the pad paints with: what the lab can set, as the JSON the engine's brush reads.
#[derive(Clone, Debug, PartialEq)]
pub struct BrushConfig {
    pub size: f64,
    pub hardness: f64,
    pub opacity: f64,
    pub flow: f64,
    pub color: [u8; 3],
    pub stabilization: f64,
    pub pressure_curve: [f64; 4],
    pub spacing_ratio: f64,
}

impl Default for BrushConfig {
    /// A round ink brush with pressure-driven size, today's `ink` preset's spacing.
    fn default() -> BrushConfig {
        BrushConfig { size: 12.0, hardness: 1.0, opacity: 1.0, flow: 1.0, color: [37, 37, 37], stabilization: 0.0, pressure_curve: [0.25, 0.25, 0.75, 0.75], spacing_ratio: 0.08 }
    }
}

impl BrushConfig {
    pub fn to_json(&self) -> Arc<str> {
        let [r, g, b] = self.color;
        let [a, b2, c, d] = self.pressure_curve;
        format!(
            "{{\"size\":{},\"hardness\":{},\"opacity\":{},\"flow\":{},\"color\":[{r},{g},{b}],\"stabilization\":{},\"pressureCurve\":[{a},{b2},{c},{d}],\"spacingRatio\":{},\"pressureSize\":true}}",
            self.size, self.hardness, self.opacity, self.flow, self.stabilization, self.spacing_ratio
        )
        .into()
    }

    /// Whether the wet ink may preview a stroke of this brush. The JavaScript rule (normal blend, round tip, `flow >= .5`,
    /// `hardness >= .5`, no erase) plus full opacity: a translucent stroke needs a union layer the preview does not have yet.
    pub fn wet_eligible(&self, erase: bool) -> bool {
        !erase && self.opacity >= 0.999 && self.flow >= 0.5 && self.hardness >= 0.5
    }
}

/// The pad's view of the cel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    /// Window pixels per cel pixel.
    pub zoom: f64,
    /// The cel pixel at the pad's top-left corner.
    pub pan: (f64, f64),
}

impl Default for View {
    fn default() -> View {
        View { zoom: 1.0, pan: (0.0, 0.0) }
    }
}

/// What the pad is asked to do with the preview and prediction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Switches {
    pub wet_ink: bool,
    pub prediction: bool,
    pub erase_tool: bool,
    /// Symmetry across the vertical centre line of the pad.
    pub mirror_x: bool,
    /// A finger draws (Settings: Draw with a finger).
    pub finger_draws: bool,
}

impl Default for Switches {
    fn default() -> Switches {
        Switches { wet_ink: true, prediction: true, erase_tool: false, mirror_x: false, finger_draws: false }
    }
}

/// The newest pointer position and the prediction, in cel pixels, for the preview.
#[derive(Clone, Copy, Debug, Default)]
pub struct Live {
    pub raw: Option<(f32, f32, u64)>,
    pub predicted: Option<(f32, f32)>,
    /// Draw the raw point (the stabiliser is off).
    pub show: bool,
    /// The stroke the position belongs to, and whether that stroke may be previewed (decided when it began, from its own
    /// tool: a physical eraser with the brush selected is not previewed as paint).
    pub stroke: u64,
    pub eligible: bool,
}

/// One input sample as the recorder keeps it.
#[derive(Clone, Copy, Debug)]
pub struct SampleRow {
    pub sample: PenSample,
    /// When the pad read it from the queue.
    pub received_ns: u64,
}

/// One frame as the recorder keeps it.
#[derive(Clone, Copy, Debug, Default)]
pub struct FrameRow {
    pub frame: u64,
    pub prepare_start_ns: u64,
    pub prepare_end_ns: u64,
    /// The newest sample time the frame's preview shows (0 when it shows none).
    pub newest_wet_ns: u64,
    /// The newest sample time whose tiles are on the GPU by this frame.
    pub newest_exact_ns: u64,
    pub wet_dabs: u32,
    pub tiles_uploaded: u32,
    /// Where the `prepare` spent its time, microseconds: taking replies, installing tiles, building the preview.
    pub replies_us: u32,
    pub install_us: u32,
    pub wet_us: u32,
    /// Of the `prepare`, the microseconds spent inside the graphics API's queue calls (the driver's time, not the pad's own work).
    pub wgpu_us: u32,
    /// The application's own view build and the pad's last `update`, microseconds, as of this frame.
    pub view_us: u32,
    pub update_us: u32,
}

/// What the pen lab's inspector shows and the self-test reads.
#[derive(Clone, Debug, Default)]
pub struct Inspector {
    pub last: Option<PenSample>,
    pub samples: u64,
    pub hover_samples: u64,
    pub contact_samples: u64,
    pub history_samples: u64,
    pub touch_samples: u64,
    pub mouse_samples: u64,
    /// Mouse samples in contact: a stroke from a mouse. A pen promoted to mouse must never make one.
    pub mouse_contact_samples: u64,
    pub duplicates: u64,
    pub interrupts: u64,
    pub overflows: u64,
    pub strokes: u64,
    pub finished_strokes: u64,
    pub palette_opens: u64,
    pub color_picks: u64,
    pub resizes: u64,
    pub limit_errors: u64,
    /// Strokes ended early because the worker was too far behind to take their samples.
    pub worker_refusals: u64,
    pub gaps_ns: VecDeque<u64>,
    pub queue: QueueStats,
    pub worker_queued: usize,
    pub last_generate_ms: f64,
    pub last_raster_ms: f64,
    pub max_generate_ms: f64,
    pub max_raster_ms: f64,
    pub worker_errors: Vec<String>,
    pub update_max_us: u64,
    pub update_last_us: u64,
    /// Undo, redo or clear the worker refused that are kept to be sent, and ones that could not even be kept.
    pub history_kept: usize,
    pub history_lost: u64,
}

impl Inspector {
    pub fn push_gap(&mut self, gap_ns: u64) {
        if self.gaps_ns.len() == GAPS {
            self.gaps_ns.pop_front();
        }
        self.gaps_ns.push_back(gap_ns);
    }

    /// The median gap between samples, if any.
    pub fn median_gap_ns(&self) -> Option<u64> {
        if self.gaps_ns.is_empty() {
            return None;
        }
        let mut gaps: Vec<u64> = self.gaps_ns.iter().copied().collect();
        gaps.sort_unstable();
        Some(gaps[gaps.len() / 2])
    }
}

/// What the GPU side did.
#[derive(Clone, Copy, Debug, Default)]
pub struct GpuStats {
    pub frames: u64,
    pub tiles_uploaded: u64,
    pub tiles_resident: usize,
    /// The atlas's counters: see `SyncStats`.
    pub sync: styk_core::drawing::tile_sync::SyncStats,
    /// Replies the `prepare` left in the channel for the next frame (its budget ran out first).
    pub replies_left: bool,
    /// Batches installed but not yet shown whole (waiting for a slot or the frame's budget).
    pub batches_waiting: usize,
    pub wet_instances: usize,
    pub wet_overflow: u64,
    /// The whole `prepare`, microseconds.
    /// Pages the atlas has grown to (its soft budget is the first).
    pub pages: usize,
    pub prepare_last_us: u64,
    pub prepare_max_us: u64,
    /// The `prepare` less the graphics API's queue calls: the pad's own work, which its budget governs.
    pub own_last_us: u64,
    pub own_max_us: u64,
    /// The queue calls alone (uploads of tiles, instances and uniforms).
    pub wgpu_last_us: u64,
    pub wgpu_max_us: u64,
    /// Uniform writes skipped because nothing in them changed.
    pub uniform_writes_skipped: u64,
    pub ledger: LedgerStats,
    /// The pad's size in physical pixels, as the last frame saw it.
    pub pad_px: (f32, f32),
}

/// Shared by the pad's widget, its primitive and the lab.
pub struct PadCore {
    pub queue: InputQueue,
    pub worker: Worker,
    pub clock: Arc<dyn Clock>,
    brush: Mutex<BrushConfig>,
    view: Mutex<View>,
    switches: Mutex<Switches>,
    pub live: Mutex<Live>,
    pub ledger: Mutex<WetLedger>,
    pub inspector: Mutex<Inspector>,
    pub gpu: Mutex<GpuStats>,
    samples: Mutex<Vec<SampleRow>>,
    frames: Mutex<Vec<FrameRow>>,
    recording: AtomicBool,
    scale: AtomicU32,
    /// Set by Escape or the lab's button: the stroke in progress is discarded.
    discard: AtomicBool,
    frame: AtomicU64,
    history: Mutex<HistoryOutbox>,
    /// How long the application took to build its view last (the lab sets it), for a frame's record.
    view_us: AtomicU64,
}

impl std::fmt::Debug for PadCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PadCore").finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl PadCore {
    pub fn new(queue: InputQueue, worker: Worker, clock: Arc<dyn Clock>) -> Arc<PadCore> {
        Arc::new(PadCore {
            queue,
            worker,
            clock,
            brush: Mutex::new(BrushConfig::default()),
            view: Mutex::new(View::default()),
            switches: Mutex::new(Switches::default()),
            live: Mutex::new(Live::default()),
            ledger: Mutex::new(WetLedger::new()),
            inspector: Mutex::new(Inspector::default()),
            gpu: Mutex::new(GpuStats::default()),
            samples: Mutex::new(Vec::new()),
            frames: Mutex::new(Vec::new()),
            recording: AtomicBool::new(false),
            scale: AtomicU32::new(1.0f32.to_bits()),
            discard: AtomicBool::new(false),
            frame: AtomicU64::new(0),
            history: Mutex::new(HistoryOutbox::default()),
            view_us: AtomicU64::new(0),
        })
    }

    pub fn now_ns(&self) -> u64 {
        self.clock.now().as_nanos() as u64
    }

    pub fn brush(&self) -> BrushConfig {
        lock(&self.brush).clone()
    }

    pub fn set_brush(&self, brush: BrushConfig) {
        *lock(&self.brush) = brush;
    }

    pub fn view(&self) -> View {
        *lock(&self.view)
    }

    pub fn set_view(&self, view: View) {
        *lock(&self.view) = view;
    }

    pub fn switches(&self) -> Switches {
        *lock(&self.switches)
    }

    pub fn set_switches(&self, switches: Switches) {
        *lock(&self.switches) = switches;
    }

    /// Physical pixels per logical pixel, as the last frame saw it.
    pub fn scale(&self) -> f32 {
        f32::from_bits(self.scale.load(Ordering::Relaxed))
    }

    pub fn set_scale(&self, scale: f32) {
        self.scale.store(scale.to_bits(), Ordering::Relaxed);
    }

    pub fn request_discard(&self) {
        self.discard.store(true, Ordering::SeqCst);
    }

    pub fn take_discard(&self) -> bool {
        self.discard.swap(false, Ordering::SeqCst)
    }

    pub fn set_view_us(&self, us: u64) {
        self.view_us.store(us, Ordering::Relaxed);
    }

    pub fn view_us(&self) -> u64 {
        self.view_us.load(Ordering::Relaxed)
    }

    pub fn next_frame(&self) -> u64 {
        self.frame.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn set_recording(&self, on: bool) {
        self.recording.store(on, Ordering::Relaxed);
    }

    pub fn recording(&self) -> bool {
        self.recording.load(Ordering::Relaxed)
    }

    pub fn record_sample(&self, row: SampleRow) {
        if self.recording() {
            let mut rows = lock(&self.samples);
            if rows.len() < RECORDER_ROWS {
                rows.push(row);
            }
        }
    }

    pub fn record_frame(&self, row: FrameRow) {
        if self.recording() {
            let mut rows = lock(&self.frames);
            if rows.len() < RECORDER_ROWS {
                rows.push(row);
            }
        }
    }

    /// Takes everything recorded so far.
    pub fn take_recording(&self) -> (Vec<SampleRow>, Vec<FrameRow>) {
        (std::mem::take(&mut *lock(&self.samples)), std::mem::take(&mut *lock(&self.frames)))
    }

    pub fn inspector(&self) -> Inspector {
        let mut copy = lock(&self.inspector).clone();
        copy.queue = self.queue.stats();
        copy.worker_queued = self.worker.queued();
        copy
    }

    /// The pad's last `update` slice, microseconds.
    pub fn inspector_update_us(&self) -> u64 {
        lock(&self.inspector).update_last_us
    }

    pub fn with_inspector<R>(&self, f: impl FnOnce(&mut Inspector) -> R) -> R {
        f(&mut lock(&self.inspector))
    }

    pub fn gpu_stats(&self) -> GpuStats {
        *lock(&self.gpu)
    }

    pub fn with_gpu<R>(&self, f: impl FnOnce(&mut GpuStats) -> R) -> R {
        f(&mut lock(&self.gpu))
    }

    pub fn with_ledger<R>(&self, f: impl FnOnce(&mut WetLedger) -> R) -> R {
        f(&mut lock(&self.ledger))
    }

    pub fn with_live<R>(&self, f: impl FnOnce(&mut Live) -> R) -> R {
        f(&mut lock(&self.live))
    }

    /// Clears the preview's pointer position if it belongs to `stroke` (a stroke that ended, was cancelled or was refused; another
    /// stroke's preview is not touched).
    pub fn clear_live_of(&self, stroke: u64) {
        self.with_live(|live| {
            if live.stroke == stroke {
                *live = Live::default();
            }
        });
    }

    /// Undo, redo or clear: sent after any the worker refused earlier; a refusal is kept for `retry_history` and reported in the
    /// inspector, never dropped silently.
    pub fn history(&self, op: HistoryOp) {
        let (kept, lost) = {
            let mut outbox = lock(&self.history);
            outbox.submit(&self.worker, op);
            (outbox.kept(), outbox.lost)
        };
        self.with_inspector(|inspector| {
            inspector.history_kept = kept;
            inspector.history_lost = lost;
        });
    }

    /// Sends the history changes the worker refused, in order, until it refuses one again.
    pub fn retry_history(&self) {
        let kept = {
            let mut outbox = lock(&self.history);
            if outbox.kept() == 0 {
                return;
            }
            outbox.flush(&self.worker);
            outbox.kept()
        };
        self.with_inspector(|inspector| inspector.history_kept = kept);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_brush_becomes_the_json_the_engine_reads() {
        let json = BrushConfig::default().to_json();
        assert!(json.starts_with('{') && json.ends_with('}'));
        assert!(json.contains("\"pressureSize\":true") && json.contains("\"color\":[37,37,37]") && json.contains("\"pressureCurve\":[0.25,0.25,0.75,0.75]"));
    }

    #[test]
    fn wet_ink_needs_a_normal_firm_full_opacity_stroke() {
        let brush = BrushConfig::default();
        assert!(brush.wet_eligible(false));
        assert!(!brush.wet_eligible(true), "an erase shows exact pixels only");
        assert!(!BrushConfig { opacity: 0.5, ..brush.clone() }.wet_eligible(false));
        assert!(!BrushConfig { hardness: 0.4, ..brush.clone() }.wet_eligible(false));
        assert!(!BrushConfig { flow: 0.4, ..brush }.wet_eligible(false));
    }

    #[test]
    fn the_inspector_keeps_the_last_gaps_and_their_median() {
        let mut inspector = Inspector::default();
        assert_eq!(inspector.median_gap_ns(), None);
        for gap in 0..(GAPS as u64 + 10) {
            inspector.push_gap(gap);
        }
        assert_eq!(inspector.gaps_ns.len(), GAPS);
        assert_eq!(inspector.gaps_ns.front(), Some(&10));
        assert_eq!(inspector.median_gap_ns(), Some(10 + GAPS as u64 / 2));
    }
}
