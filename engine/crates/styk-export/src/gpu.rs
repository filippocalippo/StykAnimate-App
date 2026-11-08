//! Export frames drawn by the GPU renderer and read back, tile by tile.
//!
//! The host owns the device (a worker's WebGPU or WebGL2 device in the app, a native
//! adapter in tools) and waits for each read-back its own way: `map_async` and the
//! event loop in a browser, [`GpuExport::render_blocking`] natively.
//!
//! A drawn tile is copied into one of several read-back **slots**, so a host can draw the
//! next tiles and frames while earlier ones are still being mapped: a browser delivers a
//! mapping only when its GPU process gets to it, which can take far longer than drawing
//! (measured in docs/engine/rendering.md, Exports). Commands run in queue order, so a
//! slot keeps the tile copied into it whatever is drawn afterwards.

use std::mem::ManuallyDrop;
use std::sync::Arc;

use styk_draw::DrawList;
use styk_eval::assets::{Assets, DecodedImage};
use styk_eval::doc::{Camera, Document};
use styk_render::{wgpu, Renderer};

use crate::interrupt::Interrupt;
use crate::pixels::resolve;
use crate::settings::Settings;
use crate::tiles::{tiles, Tile};
use crate::view::tile_view;

/// Read-back slots hold at most this many bytes together (at least two where frames overlap).
pub const READBACK_BYTES: u64 = 64 << 20;
/// Read-back slots at most.
pub const MAX_SLOTS: usize = 8;

pub struct GpuExport {
    // The GPU resources are disposed of by [`dispose`], off the thread that drops the exporter (see `Drop`).
    device: ManuallyDrop<wgpu::Device>,
    queue: ManuallyDrop<wgpu::Queue>,
    renderer: ManuallyDrop<Renderer>,
    settings: Settings,
    tiles: Vec<Tile>,
    /// Where drawn tiles are copied for reading: `stride` bytes a row (256-byte aligned).
    readbacks: ManuallyDrop<Vec<wgpu::Buffer>>,
    /// Whatever else must live exactly as long as the GPU resources and go with them ([`GpuExport::retain`]).
    retained: Vec<Box<dyn Send>>,
    stride: u32,
    /// The document lineage, page count and picture count the sprite atlas is laid out for.
    atlas: Option<(u64, u32, usize)>,
    /// The last resolved tile, straight RGBA.
    resolved: Vec<u8>,
    /// Ends a frame's wait for the GPU from any thread ([`GpuExport::interrupt`]).
    interrupt: Interrupt,
    /// Asks the poller thread to wait for the GPU (the frame's wait is on the interrupt, not on the GPU).
    #[cfg(not(target_arch = "wasm32"))]
    poller: Option<std::sync::mpsc::Sender<()>>,
}

impl GpuExport {
    /// An exporter of `settings` frames drawing tiles of at most `max_tile` pixels a side
    /// (also within the device's texture limit).
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, settings: Settings, max_tile: u32) -> GpuExport {
        GpuExport::with_renderer(device, queue, settings, max_tile, None)
    }

    /// [`GpuExport::new`] drawing with `renderer` when it covers edges as `settings` ask (one
    /// made ahead of the export, its pipelines ready), else with a new one.
    pub fn with_renderer(device: &wgpu::Device, queue: &wgpu::Queue, settings: Settings, max_tile: u32, renderer: Option<Renderer>) -> GpuExport {
        let side = max_tile.min(device.limits().max_texture_dimension_2d).max(2);
        let tiles = tiles(settings.render_size(), side, settings.smoothing.factor());
        let size = tiles[0].size;
        let stride = (size[0] * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let bytes = stride as u64 * size[1] as u64;
        #[cfg(target_arch = "wasm32")]
        let slots = ((READBACK_BYTES / bytes.max(1)) as usize).clamp(2, MAX_SLOTS);
        // Native callbacks are local: retire each tile before encoding the next
        // one's transient masks and replacement targets. Browser hosts pipeline
        // tiles/frames to hide their cross-process mapping latency.
        #[cfg(not(target_arch = "wasm32"))]
        let slots = 1;
        let readbacks = (0..slots)
            .map(|_| device.create_buffer(&wgpu::BufferDescriptor { label: Some("styk export read-back"), size: bytes, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false }))
            .collect();
        let mut renderer = renderer.filter(|r| r.edges() == settings.smoothing.edges()).unwrap_or_else(|| Renderer::with_edges(device, queue, wgpu::TextureFormat::Rgba8Unorm, settings.smoothing.edges()));
        // A frame is the same whatever was drawn before it (the sizes of the layer pages and effect slots follow the frame alone).
        renderer.set_exact_sizes(true);
        let interrupt = Interrupt::new();
        #[cfg(not(target_arch = "wasm32"))]
        let poller = {
            let device = device.clone();
            spawn_poller(interrupt.clone(), move || device.poll(wgpu::PollType::wait_indefinitely()).map(|_| ()).map_err(|e| e.to_string()))
        };
        GpuExport {
            device: ManuallyDrop::new(device.clone()),
            queue: ManuallyDrop::new(queue.clone()),
            renderer: ManuallyDrop::new(renderer),
            settings,
            tiles,
            readbacks: ManuallyDrop::new(readbacks),
            retained: Vec::new(),
            stride,
            atlas: None,
            resolved: Vec::new(),
            interrupt,
            #[cfg(not(target_arch = "wasm32"))]
            poller,
        }
    }

    /// Keeps `item` alive as long as the GPU resources and disposes of it with them (a texture shared with the stage, or in a
    /// test a resource that is slow to release).
    #[doc(hidden)]
    pub fn retain(&mut self, item: Box<dyn Send>) {
        self.retained.push(item);
    }

    /// A handle that ends this exporter's waits for the GPU from any thread: the frame in progress returns an error, so
    /// does every later one, and the exporter is to be dropped.
    pub fn interrupt(&self) -> Interrupt {
        self.interrupt.clone()
    }

    /// Finishes an upload batch on the export worker, releasing its staging
    /// copies. Cancellation and device loss wake this wait just like readback.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn flush_uploads(&self) -> Result<(), String> {
        if self.interrupt.is_interrupted() { return Err(crate::interrupt::INTERRUPTED.into()); }
        self.queue.submit([]);
        self.interrupt.expect(1);
        let latch = self.interrupt.clone();
        self.queue.on_submitted_work_done(move || latch.completed(Ok(())));
        self.poller.as_ref().ok_or("the export has no thread to wait for the GPU")?.send(()).map_err(|e| e.to_string())?;
        self.interrupt.wait()
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn tiles(&self) -> &[Tile] {
        &self.tiles
    }

    /// Read-back slots: tiles that can be waiting to be read at once.
    pub fn slots(&self) -> usize {
        self.readbacks.len()
    }

    pub fn device(&self) -> &wgpu::Device {
        &self.device
    }

    pub fn queue(&self) -> &wgpu::Queue {
        &self.queue
    }

    /// Lays the sprite atlas out for a document's `assets` (`lineage`: the document's
    /// identity across revisions). Returns whether the atlas was allocated anew, in which case
    /// every image must be uploaded again.
    pub fn prepare_sprites(&mut self, lineage: u64, assets: &Assets) -> bool {
        let layout = (lineage, assets.pages, assets.atlas.len());
        if self.atlas == Some(layout) {
            return false;
        }
        self.renderer.prepare_sprites(assets);
        self.atlas = Some(layout);
        true
    }

    /// Lays the sprite atlas out for an export that keeps only the pages its frames draw from ([`crate::resident`]): two layers
    /// to begin with, none of the document's pages mapped, no soft copies.
    pub fn prepare_sprites_resident(&mut self, lineage: u64, assets: &Assets) {
        self.renderer.prepare_sprites_export(assets, 2);
        self.atlas = Some((lineage, assets.pages, assets.atlas.len()));
    }

    /// Layers the sprite texture has.
    pub fn sprite_layers(&self) -> u32 {
        self.renderer.sprite_memory().0
    }

    /// Gives the sprite texture `layers` layers, keeping what is in it.
    pub fn grow_sprite_layers(&mut self, layers: u32) {
        self.renderer.resize_sprite_layers(layers);
    }

    /// Page `page` of the layout is in layer `layer` of the sprite texture (`None`: it is not). Takes effect with
    /// [`GpuExport::flush_sprites`].
    pub fn map_page(&mut self, page: u32, layer: Option<u32>) {
        self.renderer.map_sprite_page(page, layer);
    }

    /// The picture at `entry` is in layer `layer` (`None`: it is not). Takes effect with [`GpuExport::flush_sprites`].
    pub fn set_picture(&mut self, entry: &styk_eval::assets::AtlasEntry, layer: Option<u32>) {
        self.renderer.set_picture(entry, layer);
    }

    /// Writes the pages and pictures set since the last call to the tables the shaders read.
    pub fn flush_sprites(&mut self) {
        self.renderer.flush_sprite_map();
        self.renderer.flush_pictures();
    }

    pub fn upload_images<'a>(&mut self, assets: &Assets, images: impl IntoIterator<Item = &'a DecodedImage>) {
        self.renderer.upload_images(assets, images);
    }

    /// Draws tile `index` of `list` seen through `camera`, and copies it into read-back `slot`.
    pub fn draw(&mut self, doc: &Document, list: &Arc<DrawList>, camera: Option<&Camera>, index: usize, slot: usize) {
        self.renderer.set_edges(self.settings.smoothing.edges_for(list));
        let tile = self.tiles[index];
        let view = tile_view(doc, camera, &self.settings, &tile);
        self.renderer.set_list(list);
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk export tile") });
        self.renderer.render(&mut encoder, &view, tile.size);
        let texture = self.renderer.frame_texture().expect("render() allocates the frame");
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &self.readbacks[slot], layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(self.stride), rows_per_image: Some(tile.size[1]) } },
            wgpu::Extent3d { width: tile.size[0], height: tile.size[1], depth_or_array_layers: 1 },
        );
        self.queue.submit([encoder.finish()]);
    }

    /// Read-back `slot`: map it for reading, then [`GpuExport::resolve`].
    pub fn readback(&self, slot: usize) -> &wgpu::Buffer {
        &self.readbacks[slot]
    }

    /// Converts the mapped read-back `slot`, holding tile `index`, into output pixels
    /// (straight RGBA, `tile.valid / factor` pixels, rows packed; over black with `matte`) and
    /// unmaps it.
    pub fn resolve(&mut self, index: usize, slot: usize, matte: bool) -> Result<&[u8], String> {
        let tile = self.tiles[index];
        {
            let data = self.readbacks[slot].slice(..).get_mapped_range().map_err(|e| format!("the export read-back is not mapped: {e:?}"))?;
            resolve(&data, self.stride as usize, tile.valid, self.settings.smoothing.factor(), matte, &mut self.resolved);
        }
        self.readbacks[slot].unmap();
        Ok(&self.resolved)
    }

    /// Draws, waits for the GPU and resolves tile `index`. Native hosts only: a browser's
    /// device delivers the mapping through its event loop.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn render_blocking(&mut self, doc: &Document, list: &Arc<DrawList>, camera: Option<&Camera>, index: usize, matte: bool) -> Result<&[u8], String> {
        self.draw(doc, list, camera, index, 0);
        let (sender, receiver) = std::sync::mpsc::channel();
        self.readbacks[0].slice(..).map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        receiver.recv().map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        self.resolve(index, 0, matte)
    }

    /// Renders a whole frame natively into straight RGBA of the output size.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn frame_blocking(&mut self, doc: &Document, list: &Arc<DrawList>, camera: Option<&Camera>, matte: bool) -> Result<Vec<u8>, String> {
        let (width, height) = (self.settings.width as usize, self.settings.height as usize);
        let factor = self.settings.smoothing.factor();
        let mut out = vec![0u8; width * height * 4];
        for index in 0..self.tiles.len() {
            let tile = self.tiles[index];
            let pixels = self.render_blocking(doc, list, camera, index, matte)?;
            place(&mut out, width, &tile, factor, pixels);
        }
        Ok(out)
    }

    /// Renders a whole frame natively into `out` (cleared and filled with straight RGBA of the output size; over black
    /// with `matte`), allocating nothing per frame. Tiles are drawn a batch at a time, as many as there are read-back
    /// slots, and all mapped by one wait, so the GPU draws the next tiles while the first are being read. The pixels
    /// are those of [`GpuExport::frame_blocking`].
    #[cfg(not(target_arch = "wasm32"))]
    pub fn frame_into(&mut self, doc: &Document, list: &Arc<DrawList>, camera: Option<&Camera>, matte: bool, out: &mut Vec<u8>) -> Result<(), String> {
        let (width, height) = (self.settings.width as usize, self.settings.height as usize);
        let factor = self.settings.smoothing.factor();
        out.clear();
        out.resize(width * height * 4, 0);
        let slots = self.readbacks.len();
        let mut first = 0;
        while first < self.tiles.len() {
            if self.interrupt.is_interrupted() {
                return Err(crate::interrupt::INTERRUPTED.to_string());
            }
            let batch = slots.min(self.tiles.len() - first);
            for k in 0..batch {
                self.draw(doc, list, camera, first + k, k);
            }
            self.interrupt.expect(batch);
            for k in 0..batch {
                let latch = self.interrupt.clone();
                self.readbacks[k].slice(..).map_async(wgpu::MapMode::Read, move |result| latch.completed(result.map_err(|e| e.to_string())));
            }
            // The GPU is waited for on the poller thread; this thread waits for the mappings, an interrupt or the poller's failure.
            self.poller.as_ref().ok_or("the export has no thread to wait for the GPU")?.send(()).map_err(|e| e.to_string())?;
            self.interrupt.wait()?;
            for k in 0..batch {
                let tile = self.tiles[first + k];
                let pixels = self.resolve(first + k, k, matte)?;
                place(out, width, &tile, factor, pixels);
            }
            first += batch;
        }
        Ok(())
    }

    /// The renderer's statistics for the last tile drawn.
    pub fn stats(&self) -> &styk_render::Stats {
        &self.renderer.stats
    }
}

/// What a dropped exporter hands to the disposer: every GPU resource it held. Dropping the last reference to a queue (or a
/// device) can wait for the GPU to go idle, which with a stalled submission is long, so no thread that matters does it.
struct Held {
    _readbacks: Vec<wgpu::Buffer>,
    _renderer: Renderer,
    _queue: wgpu::Queue,
    _device: wgpu::Device,
    _retained: Vec<Box<dyn Send>>,
}

impl Drop for GpuExport {
    fn drop(&mut self) {
        // SAFETY: each field is taken exactly once, here, and the exporter is not used again.
        let held = unsafe {
            Held {
                _readbacks: ManuallyDrop::take(&mut self.readbacks),
                _renderer: ManuallyDrop::take(&mut self.renderer),
                _queue: ManuallyDrop::take(&mut self.queue),
                _device: ManuallyDrop::take(&mut self.device),
                _retained: std::mem::take(&mut self.retained),
            }
        };
        // On the web there is nothing to wait for, and wgpu's objects are not `Send` there: they are dropped in place.
        #[cfg(target_arch = "wasm32")]
        drop(held);
        #[cfg(not(target_arch = "wasm32"))]
        dispose(Box::new(held));
    }
}

/// Cancelled resources waiting for disposal, at most: more than this are each disposed of on a thread of their own, so a
/// stalled GPU holds the resources it holds and never the thread that cancelled.
#[cfg(not(target_arch = "wasm32"))]
const RETAINED: usize = 4;

/// Drops `item` on the disposal thread (on a thread of its own when that one is busy with [`RETAINED`] others): the caller
/// never waits for the GPU.
#[cfg(not(target_arch = "wasm32"))]
fn dispose(item: Box<dyn Send>) {
    {
        use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
        use std::sync::OnceLock;
        static DISPOSER: OnceLock<Option<SyncSender<Box<dyn Send>>>> = OnceLock::new();
        let sender = DISPOSER.get_or_init(|| {
            let (sender, items) = sync_channel::<Box<dyn Send>>(RETAINED);
            std::thread::Builder::new().name("styk gpu disposal".into()).spawn(move || items.into_iter().for_each(drop)).ok().map(|_| sender)
        });
        let item = match sender.as_ref() {
            Some(sender) => match sender.try_send(item) {
                Ok(()) => return,
                Err(TrySendError::Full(item) | TrySendError::Disconnected(item)) => item,
            },
            None => item,
        };
        // Busy or unavailable: a thread for this one.
        if let Err(spawned) = std::thread::Builder::new().name("styk gpu disposal (extra)".into()).spawn(move || drop(item)) {
            let _ = spawned;
        }
    }
}

/// The thread that waits for the GPU on behalf of one exporter. It runs `poll` once for every request; a failure of the
/// wait goes to `interrupt` as a terminal error, which wakes the producer at once (pending mapping callbacks that the
/// failure will keep from ever coming must not hold it). The thread ends when its sender is dropped, after the wait it is
/// in; it owns what `poll` holds (the device), so that is dropped here, off the thread that drops the exporter.
#[cfg(not(target_arch = "wasm32"))]
fn spawn_poller(interrupt: Interrupt, mut poll: impl FnMut() -> Result<(), String> + Send + 'static) -> Option<std::sync::mpsc::Sender<()>> {
    let (sender, requests) = std::sync::mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("styk export gpu wait".into())
        .spawn(move || {
            for () in requests {
                if let Err(error) = poll() {
                    interrupt.fail(format!("the wait for the GPU failed: {error}"));
                }
            }
        })
        .ok()
        .map(|_| sender)
}

/// Copies a resolved tile (`tile.valid / factor` pixels, rows packed) into the output frame
/// `out` (`width` pixels a row).
pub fn place(out: &mut [u8], width: usize, tile: &Tile, factor: u32, pixels: &[u8]) {
    let f = factor.max(1) as usize;
    let (x, y) = (tile.x as usize / f, tile.y as usize / f);
    let w = tile.valid[0] as usize / f;
    for (row, line) in pixels.chunks_exact(w * 4).enumerate() {
        let at = ((y + row) * width + x) * 4;
        out[at..at + w * 4].copy_from_slice(line);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use std::sync::{Condvar, Mutex};
    use std::time::{Duration, Instant};

    /// Re-check finding 3: a failure of the wait was dropped, and the producer went on waiting for mappings that would never
    /// come. Here the wait fails with a device error and nothing completes.
    #[test]
    fn a_failing_wait_for_the_gpu_wakes_the_producer_with_its_error() {
        let interrupt = Interrupt::new();
        let poller = spawn_poller(interrupt.clone(), || Err("device lost".to_string())).expect("the poller thread");
        interrupt.expect(3);
        poller.send(()).unwrap();
        let (sender, result) = std::sync::mpsc::channel();
        {
            let interrupt = interrupt.clone();
            std::thread::spawn(move || {
                let _ = sender.send(interrupt.wait());
            });
        }
        // A wait that does not hear the failure fails here instead of hanging the test.
        let outcome = result.recv_timeout(Duration::from_secs(5)).expect("the producer was woken");
        assert_eq!(outcome, Err("the wait for the GPU failed: device lost".to_string()));
    }

    /// A resource whose drop stands in for a queue that waits for a stalled GPU.
    struct Stalled {
        gate: Arc<(Mutex<bool>, Condvar)>,
        dropped: Arc<Mutex<usize>>,
    }

    impl Drop for Stalled {
        fn drop(&mut self) {
            let mut open = self.gate.0.lock().unwrap();
            while !*open {
                open = self.gate.1.wait(open).unwrap();
            }
            *self.dropped.lock().unwrap() += 1;
        }
    }

    /// Re-check finding 2: dropping a cancelled exporter waited for the GPU. Items whose drop never returns (until the GPU
    /// "recovers") are handed over from this thread, more of them than the disposer retains, and no hand-over waits.
    #[test]
    fn disposing_of_resources_that_wait_for_a_stalled_gpu_never_waits_on_the_caller() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let dropped = Arc::new(Mutex::new(0));
        let (sender, handed_over) = std::sync::mpsc::channel();
        {
            let (gate, dropped) = (gate.clone(), dropped.clone());
            std::thread::spawn(move || {
                let asked = Instant::now();
                for _ in 0..RETAINED + 3 {
                    dispose(Box::new(Stalled { gate: gate.clone(), dropped: dropped.clone() }));
                }
                let _ = sender.send(asked.elapsed());
            });
        }
        // A hand-over that waits for the stalled resources fails here instead of hanging the test.
        let took = handed_over.recv_timeout(Duration::from_secs(5)).expect("the hand-over returned without waiting for the GPU");
        assert!(took < Duration::from_millis(500), "handing over took {took:?}");
        assert_eq!(*dropped.lock().unwrap(), 0, "nothing was dropped on the handing thread");
        // The GPU recovers: every item is dropped, by the threads that own them.
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        let mut waited = 0;
        while *dropped.lock().unwrap() < RETAINED + 3 && waited < 100 {
            std::thread::sleep(Duration::from_millis(50));
            waited += 1;
        }
        assert_eq!(*dropped.lock().unwrap(), RETAINED + 3);
    }
}
