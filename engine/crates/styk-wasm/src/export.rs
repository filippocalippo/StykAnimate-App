//! Export frames drawn in a worker of their own (`src/engine/engine-export-worker.mjs`).
//!
//! The worker joins the engine's shared memory like the preparation workers, but keeps
//! its event loop: it holds a GPU device of its own (WebGPU, else WebGL2 on an
//! `OffscreenCanvas`), or, where it gets none, draws with the CPU rasterizer
//! (`ExportRenderer::create_cpu`, styk-raster); nothing of an export is drawn or read on
//! the interface thread (D7). Frames come from the document of the export's revision
//! ([`ExportFrames`]); the pose the editor shows comes as keyframe JSON, drawn as the stage
//! draws its edit frame but without onion skins.

use std::sync::{Arc, Mutex};

use styk_draw::DrawList;
use styk_engine::edit::{EditOptions, EditScene};
use styk_engine::export::{ExportFrames, AHEAD};
use styk_engine::Engine;
use styk_eval::doc::Camera;
use styk_export::{CpuExport, GpuExport, Settings, Smoothing};
use styk_render::{wgpu, Edges, Renderer};
use wasm_bindgen::prelude::*;

use crate::{clock, js_error};

/// Decoded pictures uploaded per call at most, so a document with many pictures
/// reports progress instead of stalling the worker in one call.
const IMAGE_UPLOAD_BYTES: usize = 32 << 20;

/// The GPU device of an export worker. Getting one (finding an adapter, its device, the
/// renderer's pipelines) takes a good part of a second, so the worker gets it while the export
/// dialog is open (`prewarm` in engine-export.mjs) and the export starts with it.
#[wasm_bindgen]
pub struct ExportDevice {
    device: wgpu::Device,
    queue: wgpu::Queue,
    /// WebGL2 draws through a context of this surface; WebGPU needs none.
    surface: Option<wgpu::Surface<'static>>,
    backend: String,
    /// What the device reported: lost, out of memory or a validation error (recoverable when
    /// a retry with smaller tiles may pass).
    failure: Arc<Mutex<Option<(bool, String)>>>,
    /// A renderer with smooth edges, its pipelines created (crisp edges make their own).
    renderer: Option<Renderer>,
    /// Finding an adapter, getting its device, creating the renderer (ms).
    start_ms: [f64; 3],
    /// WebGL2: read-backs complete when the device is polled.
    polled: bool,
}

fn adapter_options<'a, 'b>(surface: Option<&'a wgpu::Surface<'b>>) -> wgpu::RequestAdapterOptions<'a, 'b> {
    wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, compatible_surface: surface, ..Default::default() }
}

#[wasm_bindgen]
impl ExportDevice {
    /// WebGPU in this worker, else WebGL2 on `canvas`. Fails when neither gives a device.
    pub async fn create(canvas: Option<web_sys::OffscreenCanvas>) -> Result<ExportDevice, JsError> {
        let started = clock();
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::BROWSER_WEBGPU | wgpu::Backends::GL;
        let instance = wgpu::util::new_instance_with_webgpu_detection(descriptor).await;
        let (adapter, surface) = match instance.request_adapter(&adapter_options(None)).await {
            Ok(adapter) => (adapter, None),
            Err(first) => {
                let canvas = canvas.ok_or_else(|| js_error(format!("no GPU adapter in this worker ({first})")))?;
                let surface = instance.create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas)).map_err(js_error)?;
                let adapter = instance.request_adapter(&adapter_options(Some(&surface))).await.map_err(|e| js_error(format!("no GPU adapter in this worker ({e})")))?;
                (adapter, Some(surface))
            }
        };
        let info = adapter.get_info();
        let adapted = clock();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("styk export"),
                required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
                ..Default::default()
            })
            .await
            .map_err(js_error)?;
        let deviced = clock();
        let failure: Arc<Mutex<Option<(bool, String)>>> = Arc::default();
        let lost = failure.clone();
        device.set_device_lost_callback(move |_, message| {
            lost.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert((true, format!("the GPU device was lost: {message}")));
        });
        let errors = failure.clone();
        device.on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
            let memory = matches!(error, wgpu::Error::OutOfMemory { .. });
            errors.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert((memory, error.to_string()));
        }));
        let renderer = Renderer::with_edges(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, Edges::Smooth);
        let polled = info.backend == wgpu::Backend::Gl;
        Ok(ExportDevice { device, queue, surface, backend: format!("{:?} · {}", info.backend, info.name), failure, renderer: Some(renderer), start_ms: [adapted - started, deviced - adapted, clock() - deviced], polled })
    }

    /// Whether the device still works (it was not lost while waiting for the export).
    pub fn usable(&self) -> bool {
        self.failure.lock().unwrap_or_else(|e| e.into_inner()).is_none()
    }

    /// Releases a device no export took.
    pub fn dispose(&mut self) {
        self.renderer = None;
        self.device.destroy();
    }
}


/// What draws an export's tiles: the worker's GPU device, or the CPU rasterizer where the
/// worker has none.
enum Backend {
    Gpu {
        gpu: Box<GpuExport>,
        device: wgpu::Device,
        /// WebGL2 draws through a context of this surface; WebGPU needs none.
        _surface: Option<wgpu::Surface<'static>>,
        /// What the device reported: lost, out of memory or a validation error.
        failure: Arc<Mutex<Option<(bool, String)>>>,
        /// Finding an adapter, getting its device, creating the renderer (ms).
        start_ms: [f64; 3],
        /// WebGL2: read-backs complete when the device is polled.
        polled: bool,
    },
    Cpu(CpuExport),
}

#[wasm_bindgen]
pub struct ExportRenderer {
    frames: ExportFrames,
    backend: Backend,
    backend_name: String,
    /// The pose the editor shows, when the export is of it.
    edit: EditScene,
    /// The frame being exported: its draw list and the camera it is seen through.
    current: Option<(Arc<DrawList>, Option<Camera>)>,
    frames_drawn: u32,
    last_evaluate_ms: f64,
}

/// The export's settings and its pinned frames, from the arguments of `create` and
/// `create_cpu`. `address` comes from `EngineHandle::address` and is consumed.
fn pinned(address: usize, revision: f64, width: u32, height: u32, smoothing: &str, max_pixels: f64) -> Result<(Settings, ExportFrames), JsError> {
    // SAFETY: `address` was produced by `EngineHandle::address` in this memory and is used once.
    let engine = unsafe { *Box::from_raw(address as *mut Engine) };
    let smoothing = Smoothing::parse(smoothing).ok_or_else(|| js_error("choose Smooth edges, No smoothing or Smooth sprites"))?;
    let settings = Settings::new(width, height, smoothing, max_pixels as u64).map_err(js_error)?;
    let frames = engine.export_frames(revision as u64).map_err(js_error)?;
    Ok((settings, frames))
}

#[wasm_bindgen]
impl ExportRenderer {
    /// Starts an export of `width`×`height` frames sampled as `smoothing` (`edges`, `none`,
    /// `sprites`), in tiles of at most `tile` pixels, on `device` (consumed). `address`
    /// comes from `EngineHandle::address` and is consumed. Fails when the engine does not
    /// hold the document of `revision`.
    #[allow(clippy::too_many_arguments)]
    pub fn create(address: usize, revision: f64, width: u32, height: u32, smoothing: String, max_pixels: f64, tile: u32, device: ExportDevice) -> Result<ExportRenderer, JsError> {
        let (settings, frames) = pinned(address, revision, width, height, &smoothing, max_pixels)?;
        let mut device = device;
        let mut gpu = GpuExport::with_renderer(&device.device, &device.queue, settings, tile, device.renderer.take());
        let generation = frames.generation().clone();
        gpu.prepare_sprites(generation.lineage, &generation.assets);
        frames.decode_images();
        let backend = Backend::Gpu { gpu: Box::new(gpu), device: device.device.clone(), _surface: device.surface.take(), failure: device.failure.clone(), start_ms: device.start_ms, polled: device.polled };
        Ok(ExportRenderer { frames, backend, backend_name: device.backend.clone(), edit: EditScene::default(), current: None, frames_drawn: 0, last_evaluate_ms: 0.0 })
    }

    /// Starts an export as [`ExportRenderer::create`] does, drawn by the CPU rasterizer
    /// (styk-raster): for a worker that has no GPU device. Tiles are at most
    /// `styk_export::cpu::TILE_SIDE` pixels a side; each is drawn when asked for.
    pub fn create_cpu(address: usize, revision: f64, width: u32, height: u32, smoothing: String, max_pixels: f64, tile: u32) -> Result<ExportRenderer, JsError> {
        let (settings, frames) = pinned(address, revision, width, height, &smoothing, max_pixels)?;
        frames.decode_images();
        let mut cpu = CpuExport::new(settings, tile);
        cpu.use_assets(frames.generation().assets.clone());
        let backend = Backend::Cpu(cpu);
        Ok(ExportRenderer { frames, backend, backend_name: "CPU · styk-raster".into(), edit: EditScene::default(), current: None, frames_drawn: 0, last_evaluate_ms: 0.0 })
    }

    /// The graphics backend and adapter, for reports.
    pub fn backend(&self) -> String {
        self.backend_name.clone()
    }

    /// Uploads pictures decoded so far and returns how many are still to come. A frame is
    /// drawn only once every picture is in (an export never shows a frame without one).
    pub fn upload_images(&mut self) -> u32 {
        let generation = self.frames.generation().clone();
        match &mut self.backend {
            Backend::Gpu { gpu, .. } => {
                let images = self.frames.take_images(IMAGE_UPLOAD_BYTES);
                if !images.is_empty() {
                    gpu.upload_images(&generation.assets, images.iter().map(|image| &**image));
                }
            }
            // The CPU keeps the decoded pictures themselves, shared with nothing else.
            Backend::Cpu(cpu) => cpu.upload_images(&generation.assets, self.frames.take_images(usize::MAX)),
        }
        self.frames.images_pending() as u32
    }

    /// Makes `tick` the frame to draw, and asks the engine's workers for the next ones up to
    /// `last`. `false` while a worker is still preparing it: wait for the engine's progress.
    /// Fails for a tick the document does not have.
    pub fn prepare(&mut self, tick: u32, last: u32) -> Result<bool, JsError> {
        if tick >= self.frames.ticks() {
            return Err(js_error(format!("Choose an export frame inside this animation (tick {tick} of {}).", self.frames.ticks())));
        }
        let started = clock();
        let Some(frame) = self.frames.take(tick) else { return Ok(false) };
        self.last_evaluate_ms = clock() - started;
        self.current = Some((frame.list.clone(), frame.camera));
        let ahead = (tick + 1..=last.min(tick + AHEAD as u32)).collect::<Vec<_>>();
        self.frames.prefetch(ahead);
        Ok(true)
    }

    /// Makes the editor's pose the frame to draw: keyframe JSON whose `objects` are poses,
    /// with the times it carries (`_vfxTimelineTick`, `_cameraMotionTick`).
    pub fn prepare_pose(&mut self, json: &str) -> Result<(), JsError> {
        let started = clock();
        let generation = self.frames.generation().clone();
        self.edit.update(&generation, json.as_bytes()).map_err(js_error)?;
        // Every earlier anchor of generated effects is evaluated: an export has no frame budget.
        let options = EditOptions { camera: true, prepare_camera: true, clock: None, anchor_budget_ms: f64::INFINITY, ..Default::default() };
        let list = self.edit.draw_list(&generation, &options).map_err(js_error)?.ok_or_else(|| js_error("the pose has no frame"))?;
        self.current = Some((list, self.edit.camera()));
        self.last_evaluate_ms = clock() - started;
        Ok(())
    }

    /// The prepared frame as SVG: vector artwork where the frame has a vector form, else one
    /// picture of it (styk-export `svg`). An SVG export is created with `create_cpu`; the picture
    /// is drawn by the CPU rasterizer once every picture of the document is in.
    pub fn svg(&mut self, title: &str) -> Result<String, JsError> {
        let generation = self.frames.generation().clone();
        let (list, camera) = self.current.clone().ok_or_else(|| js_error("prepare a frame before exporting it"))?;
        let settings = *self.settings();
        let size = [settings.width, settings.height];
        let frame = styk_export::svg::Frame { doc: &generation.prepared.doc, assets: &generation.assets, list: &list, camera: camera.as_ref(), size, title };
        if let Some(text) = styk_export::svg::vector(&frame) {
            return Ok(text);
        }
        let Backend::Cpu(cpu) = &mut self.backend else { return Err(js_error("an SVG export is drawn by the CPU rasterizer")) };
        let pixels = cpu.frame(&generation.prepared.doc, &list, camera.as_ref(), false).map_err(js_error)?;
        styk_export::svg::picture(size, title, &pixels).map_err(js_error)
    }

    fn tile_list(&self) -> &[styk_export::Tile] {
        match &self.backend {
            Backend::Gpu { gpu, .. } => gpu.tiles(),
            Backend::Cpu(cpu) => cpu.tiles(),
        }
    }

    fn settings(&self) -> &Settings {
        match &self.backend {
            Backend::Gpu { gpu, .. } => gpu.settings(),
            Backend::Cpu(cpu) => cpu.settings(),
        }
    }

    /// Tiles of a frame.
    pub fn tiles(&self) -> u32 {
        self.tile_list().len() as u32
    }

    /// Read-back slots: tiles that can wait to be read at once (the worker draws ahead into
    /// free ones while earlier tiles are mapped). On the CPU, the tiles of one frame (at most
    /// four), so nothing is drawn ahead.
    pub fn slots(&self) -> u32 {
        match &self.backend {
            Backend::Gpu { gpu, .. } => gpu.slots() as u32,
            Backend::Cpu(cpu) => cpu.slots() as u32,
        }
    }

    /// Where tile `index` lands in the output and its pixels there: x, y, width, height of
    /// the part inside the frame, then the width and height every tile has.
    pub fn tile_rect(&self, index: u32) -> Box<[u32]> {
        let tile = self.tile_list()[index as usize];
        let f = self.settings().smoothing.factor();
        Box::new([tile.x / f, tile.y / f, tile.valid[0] / f, tile.valid[1] / f, tile.size[0] / f, tile.size[1] / f])
    }

    /// Draws tile `index` of the prepared frame into read-back `slot`; the promise resolves once
    /// its pixels can be read (at once on the CPU, which draws it here).
    pub fn draw_tile(&mut self, index: u32, slot: u32) -> Result<js_sys::Promise, JsError> {
        self.check()?;
        let generation = self.frames.generation().clone();
        let (list, camera) = self.current.clone().ok_or_else(|| js_error("prepare a frame before drawing it"))?;
        match &mut self.backend {
            Backend::Gpu { gpu, device, .. } => {
                gpu.draw(&generation.prepared.doc, &list, camera.as_ref(), index as usize, slot as usize);
                let readback = gpu.readback(slot as usize).clone();
                let promise = js_sys::Promise::new(&mut |resolve, reject| {
                    readback.slice(..).map_async(wgpu::MapMode::Read, move |result| {
                        let _ = match result {
                            Ok(()) => resolve.call0(&JsValue::UNDEFINED),
                            Err(error) => reject.call1(&JsValue::UNDEFINED, &JsValue::from_str(&format!("the export frame could not be read: {error}"))),
                        };
                    });
                });
                // WebGL2 maps on the next poll; WebGPU through the mapping's own promise.
                let _ = device.poll(wgpu::PollType::Poll);
                Ok(promise)
            }
            Backend::Cpu(cpu) => {
                cpu.draw(&generation.prepared.doc, &list, camera.as_ref(), index as usize, slot as usize).map_err(js_error)?;
                Ok(js_sys::Promise::resolve(&JsValue::UNDEFINED))
            }
        }
    }

    /// Writes tile `index`, read into `slot`, into `out` (the RGBA of a tile-sized `ImageData`,
    /// rows of the tile's full width), straight alpha, over black with `matte`.
    pub fn resolve_tile(&mut self, index: u32, slot: u32, matte: bool, out: &js_sys::Uint8ClampedArray) -> Result<(), JsError> {
        let tile = self.tile_list()[index as usize];
        let count = self.tile_list().len() as u32;
        let f = self.settings().smoothing.factor();
        let (row, full) = ((tile.valid[0] / f * 4) as usize, tile.size[0] / f * 4);
        let pixels = match &mut self.backend {
            Backend::Gpu { gpu, .. } => gpu.resolve(index as usize, slot as usize, matte),
            Backend::Cpu(cpu) => cpu.resolve(index as usize, slot as usize, matte),
        }
        .map_err(js_error)?;
        if out.length() < full * (tile.size[1] / f) {
            return Err(js_error("the tile's pixels do not fit"));
        }
        // SAFETY: the view is used at once, before anything here can allocate.
        let view = unsafe { js_sys::Uint8Array::view(pixels) };
        for (y, start) in (0..pixels.len()).step_by(row.max(1)).enumerate() {
            out.set(&view.subarray(start as u32, (start + row) as u32), y as u32 * full);
        }
        self.frames_drawn += (index + 1 == count) as u32;
        Ok(())
    }

    /// Whether read-backs complete only when polled: WebGL2 maps on [`ExportRenderer::poll`],
    /// WebGPU through the mapping's own promise, the CPU at once.
    pub fn needs_poll(&self) -> bool {
        matches!(self.backend, Backend::Gpu { polled: true, .. })
    }

    /// Lets WebGL2 complete the read-backs whose drawing has finished.
    pub fn poll(&self) {
        if let Backend::Gpu { device, .. } = &self.backend {
            let _ = device.poll(wgpu::PollType::Poll);
        }
    }

    /// Gives back read-back `slot`, mapped and not read: a frame drawn ahead that the export
    /// did not ask for.
    pub fn discard(&mut self, slot: u32) {
        match &mut self.backend {
            Backend::Gpu { gpu, .. } => gpu.readback(slot as usize).unmap(),
            Backend::Cpu(cpu) => cpu.discard(slot as usize),
        }
    }

    /// Fails with what the device reported since the export started (lost, out of memory).
    /// `recoverable` in the error's message prefix tells a retry with smaller tiles may help.
    pub fn check(&self) -> Result<(), JsError> {
        let Backend::Gpu { failure, .. } = &self.backend else { return Ok(()) };
        match failure.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            Some((recoverable, message)) => Err(js_error(format!("{}{message}", if *recoverable { "recoverable: " } else { "" }))),
            None => Ok(()),
        }
    }

    /// Draws later frames in tiles of at most `tile` pixels (a retry after a GPU memory failure).
    pub fn retile(&mut self, tile: u32) {
        let settings = *self.settings();
        let generation = self.frames.generation().clone();
        match &mut self.backend {
            Backend::Gpu { gpu, device, .. } => {
                let queue = gpu.queue().clone();
                **gpu = GpuExport::new(device, &queue, settings, tile);
                gpu.prepare_sprites(generation.lineage, &generation.assets);
                self.frames.forget();
                self.frames.decode_images();
            }
            // The pictures already taken stay.
            Backend::Cpu(cpu) => cpu.retile(tile),
        }
    }

    /// The export's figures as JSON: backend, tiles, read-back slots, tile size, frames drawn, the last
    /// evaluation, and the renderer's counts of the last tile.
    pub fn stats(&self) -> String {
        let size = self.tile_list()[0].size;
        let head = format!(
            "\"backend\":{:?},\"tiles\":{},\"slots\":{},\"tileWidth\":{},\"tileHeight\":{},\"framesDrawn\":{},\"evaluateMs\":{:.3}",
            self.backend_name,
            self.tile_list().len(),
            self.slots(),
            size[0],
            size[1],
            self.frames_drawn,
            self.last_evaluate_ms
        );
        match &self.backend {
            Backend::Gpu { gpu, start_ms, .. } => {
                let s = gpu.stats();
                format!(
                    "{{{head},\"startMs\":[{:.1},{:.1},{:.1}],\"prims\":{},\"passes\":{},\"rounds\":{},\"layerBytes\":{},\"effectBytes\":{},\"depthBytes\":{},\"glyphBytes\":{}}}",
                    start_ms[0], start_ms[1], start_ms[2], s.prims, s.passes, s.rounds, s.layer_bytes, s.effect_bytes, s.depth_bytes, s.glyph_bytes
                )
            }
            Backend::Cpu(cpu) => {
                let s = cpu.stats();
                let (images, slots) = cpu.bytes();
                format!(
                    "{{{head},\"cpu\":true,\"layers\":{},\"effectLayers\":{},\"effectPasses\":{},\"peakBytes\":{},\"glyphBytes\":{},\"imageBytes\":{images},\"slotBytes\":{slots}}}",
                    s.layers, s.effect_layers, s.effect_passes, s.peak_bytes, s.glyph_bytes
                )
            }
        }
    }

    /// Releases the GPU device (if any) and everything the export holds. The worker ends afterwards.
    pub fn dispose(&mut self) {
        self.current = None;
        if let Backend::Gpu { device, .. } = &self.backend {
            device.destroy();
        }
    }
}
