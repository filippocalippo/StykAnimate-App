//! Document state and frame production.
//!
//! The UI thread never evaluates a frame during playback if it can avoid it:
//! a dedicated worker pool prepares draw lists ahead of the playhead into a
//! byte-bounded cache. Each document revision is an immutable `Arc<Prepared>`,
//! so workers keep evaluating the revision they were given while an edit
//! publishes the next one; stale results are dropped by revision.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crossbeam_channel::{Receiver, Sender};
use styk_core::assets::Assets;
use styk_core::doc::Document;
use styk_core::drawlist::{encode, DrawList};
use styk_core::edit::{History, PoseRef};
use styk_core::eval::{Frame, Prepared};
use styk_core::geometry::{build, Scene};
use styk_render::DecodedImage;

pub struct FrameData {
    pub list: Arc<DrawList>,
    pub camera: Option<styk_core::doc::Camera>,
    pub ms: f32,
}

/// Everything produced off the UI thread when a file opens.
pub struct Loaded {
    pub path: PathBuf,
    pub prepared: Arc<Prepared>,
    pub assets: Arc<Assets>,
    pub images: Arc<Vec<DecodedImage>>,
    pub open_ms: f64,
    pub assets_ms: f64,
}

pub fn load(path: &Path) -> Result<Loaded, String> {
    let started = Instant::now();
    let doc = styk_core::open(path).map_err(|e| e.to_string())?;
    let prepared = Arc::new(Prepared::new(Arc::new(doc)));
    let open_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    let assets = Arc::new(Assets::build(&prepared.doc));
    let images = Arc::new(styk_render::decode_images(&prepared.doc, &assets));
    let assets_ms = started.elapsed().as_secs_f64() * 1000.0;
    Ok(Loaded { path: path.to_path_buf(), prepared, assets, images, open_ms, assets_ms })
}

/// `STYK_SLOWDOWN=N` repeats each frame's preparation N times: a crude stand-in
/// for an N-times slower CPU when judging headroom on phone-class hardware.
fn slowdown() -> u32 {
    static VALUE: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *VALUE.get_or_init(|| std::env::var("STYK_SLOWDOWN").ok().and_then(|v| v.parse().ok()).unwrap_or(1).max(1))
}

pub fn produce(prepared: &Prepared, assets: &Assets, tick: u32) -> FrameData {
    let started = Instant::now();
    for _ in 1..slowdown() {
        let frame = prepared.evaluate(tick as f64);
        let scene = build(&prepared.doc, &frame);
        std::hint::black_box(encode(&prepared.doc, assets, &scene));
    }
    let frame = prepared.evaluate(tick as f64);
    let scene = build(&prepared.doc, &frame);
    let list = Arc::new(encode(&prepared.doc, assets, &scene));
    FrameData { list, camera: scene.camera, ms: started.elapsed().as_secs_f32() * 1000.0 }
}

struct Entry {
    data: Arc<FrameData>,
    bytes: usize,
}

pub struct Engine {
    pub prepared: Arc<Prepared>,
    pub assets: Arc<Assets>,
    pub images: Arc<Vec<DecodedImage>>,
    pub path: PathBuf,
    pub revision: u64,
    pub history: History,
    pub open_ms: f64,
    pub assets_ms: f64,
    cache: HashMap<u32, Entry>,
    cache_bytes: usize,
    pub cache_budget: usize,
    inflight: HashSet<u32>,
    pool: Arc<rayon::ThreadPool>,
    tx: Sender<(u64, u32, FrameData)>,
    rx: Receiver<(u64, u32, FrameData)>,
    /// Paused-frame geometry for handles and picking.
    scene: Option<(u64, u32, Arc<Frame>, Arc<Scene>)>,
    pub stats: EngineStats,
}

#[derive(Default, Clone)]
pub struct EngineStats {
    pub produced: u64,
    pub produce_ms_total: f64,
    pub produce_ms_worst: f32,
    pub sync_frames: u64,
}

impl Engine {
    pub fn new(loaded: Loaded, pool: Arc<rayon::ThreadPool>) -> Engine {
        let (tx, rx) = crossbeam_channel::unbounded();
        Engine {
            prepared: loaded.prepared,
            assets: loaded.assets,
            images: loaded.images,
            path: loaded.path,
            revision: 1,
            history: History::default(),
            open_ms: loaded.open_ms,
            assets_ms: loaded.assets_ms,
            cache: HashMap::new(),
            cache_bytes: 0,
            cache_budget: 768 * 1024 * 1024,
            inflight: HashSet::new(),
            pool,
            tx,
            rx,
            scene: None,
            stats: EngineStats::default(),
        }
    }

    pub fn total_ticks(&self) -> u32 {
        self.prepared.total_ticks
    }

    pub fn doc(&self) -> &Document {
        &self.prepared.doc
    }

    pub fn cached_frames(&self) -> usize {
        self.cache.len()
    }
    pub fn cached_bytes(&self) -> usize {
        self.cache_bytes
    }

    /// Collect finished worker frames.
    pub fn poll(&mut self) {
        while let Ok((revision, tick, data)) = self.rx.try_recv() {
            self.inflight.remove(&tick);
            if revision != self.revision {
                continue;
            }
            self.note(&data);
            self.insert(tick, data);
        }
    }

    fn note(&mut self, data: &FrameData) {
        self.stats.produced += 1;
        self.stats.produce_ms_total += data.ms as f64;
        self.stats.produce_ms_worst = self.stats.produce_ms_worst.max(data.ms);
    }

    fn insert(&mut self, tick: u32, data: FrameData) -> Arc<FrameData> {
        let bytes = data.list.bytes() + 256;
        let data = Arc::new(data);
        if let Some(old) = self.cache.insert(tick, Entry { data: data.clone(), bytes }) {
            self.cache_bytes -= old.bytes;
        }
        self.cache_bytes += bytes;
        data
    }

    /// Keep the cache within budget, dropping frames farthest ahead of `tick`.
    fn trim(&mut self, tick: u32) {
        if self.cache_bytes <= self.cache_budget {
            return;
        }
        let total = self.total_ticks().max(1);
        let mut ticks: Vec<u32> = self.cache.keys().copied().collect();
        ticks.sort_by_key(|&t| std::cmp::Reverse((t + total - tick % total) % total));
        for t in ticks {
            if self.cache_bytes <= self.cache_budget * 9 / 10 {
                break;
            }
            if let Some(e) = self.cache.remove(&t) {
                self.cache_bytes -= e.bytes;
            }
        }
    }

    /// Schedule ticks for background preparation.
    pub fn prefetch(&mut self, ticks: impl IntoIterator<Item = u32>) {
        let limit = self.pool.current_num_threads() * 2;
        for tick in ticks {
            if self.inflight.len() >= limit {
                break;
            }
            if self.cache.contains_key(&tick) || self.inflight.contains(&tick) {
                continue;
            }
            self.inflight.insert(tick);
            let (prepared, assets, tx, revision) = (self.prepared.clone(), self.assets.clone(), self.tx.clone(), self.revision);
            self.pool.spawn(move || {
                let data = produce(&prepared, &assets, tick);
                let _ = tx.send((revision, tick, data));
            });
        }
    }

    pub fn get(&self, tick: u32) -> Option<Arc<FrameData>> {
        self.cache.get(&tick).map(|e| e.data.clone())
    }

    /// The frame at `tick`, preparing it here if no worker has.
    pub fn frame(&mut self, tick: u32) -> Arc<FrameData> {
        if let Some(d) = self.get(tick) {
            return d;
        }
        let data = produce(&self.prepared, &self.assets, tick);
        self.stats.sync_frames += 1;
        self.note(&data);
        let d = self.insert(tick, data);
        self.trim(tick);
        d
    }

    /// Geometry of the paused frame (joints for handles and picking).
    pub fn scene(&mut self, tick: u32) -> (Arc<Frame>, Arc<Scene>) {
        if let Some((rev, t, frame, scene)) = &self.scene
            && *rev == self.revision
            && *t == tick
        {
            return (frame.clone(), scene.clone());
        }
        let frame = Arc::new(self.prepared.evaluate(tick as f64));
        let scene = Arc::new(build(&self.prepared.doc, &frame));
        self.scene = Some((self.revision, tick, frame.clone(), scene.clone()));
        (frame, scene)
    }

    /// Publishes an edited document as a new revision.
    pub fn publish(&mut self, doc: Document) {
        self.prepared = Arc::new(Prepared::new(Arc::new(doc)));
        self.revision += 1;
        self.cache.clear();
        self.cache_bytes = 0;
        self.inflight.clear();
        self.scene = None;
    }

    pub fn object(&self, at: &PoseRef) -> Option<Arc<styk_core::doc::Object>> {
        styk_core::edit::object(&self.prepared.doc, at)
    }

    pub fn undo(&mut self) -> bool {
        match self.history.undo(&self.prepared.doc) {
            Some(doc) => {
                self.publish(doc);
                true
            }
            None => false,
        }
    }

    pub fn redo(&mut self) -> bool {
        match self.history.redo(&self.prepared.doc) {
            Some(doc) => {
                self.publish(doc);
                true
            }
            None => false,
        }
    }

    pub fn after_tick(&mut self, tick: u32) {
        self.trim(tick);
    }
}
