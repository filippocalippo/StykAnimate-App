//! Other views the stage's device draws: the camera monitor and frame thumbnails.
//!
//! Each is a canvas of its own (an `OffscreenCanvas` the interface keeps and copies onto
//! the element that shows it) with a renderer of its own, so its frame, layer and depth
//! targets keep their size, sampling the stage's sprite atlas: the stage's pictures are
//! never uploaded twice. Only WebGPU presents one device to several canvases; where the
//! stage runs on WebGL2 these views are refused and the interface draws them itself.
//!
//! * The camera monitor shows the frame the stage drew last, through the scene camera,
//!   without onion skins (an edit frame is encoded again with the camera's parallax).
//! * A frame thumbnail is a tick of a revision the interface names, framed as the
//!   filmstrip frames it ([`styk_engine::thumbnails::card`]). Its frame is prepared on the
//!   engine's workers ([`ExportFrames`]); the interface thread only draws it (D7), and only
//!   once every picture of the document is in the atlas.

use std::sync::Arc;

use styk_draw::DrawList;
use styk_engine::edit::EditOptions;
use styk_engine::export::{ExportFrames, AHEAD};
use styk_engine::thumbnails::{card, Framing, CARD, MAX_SIDE};
use styk_engine::thumbnails::monitor::MonitorFrame;
use styk_eval::doc::Camera;
use styk_render::{DrawingGrid, Renderer, ViewParams, wgpu};
use wasm_bindgen::prelude::*;

use crate::js_error;
use crate::stage::{Shown, Stage};

/// One canvas drawn on the stage's device by a renderer of its own.
struct Aux {
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer,
    /// The stage atlas (lineage, pages) the renderer samples.
    shared: Option<(u64, u32, u32)>,
}

/// Browser presentation of the actual shown source. The shared native frame
/// still owns all preparation and cancellation; this only selects its painter grid.
pub(crate) struct MonitorRequest {
    pub frame: MonitorFrame,
    pub grid: DrawingGrid,
    /// The browser's immediate Canvas monitor reference is used only for the
    /// actual shown Edit snapshot. The worker resolves its scene-effect branch.
    pub direct_canvas: bool,
}

/// What a monitor list of the edit frame was built from.
#[derive(Clone, PartialEq)]
struct MonitorKey {
    generation: u64,
    edits: u64,
    effects: bool,
    hidden: Vec<u32>,
    translations: Vec<(u32, [f64; 2])>,
}

enum WorkerMonitorKey {
    Edit(MonitorKey, u32),
    // Keep allocation identity without making the UI key a dense frame owner.
    Prepared(u64, f64, u64, std::sync::Weak<styk_engine::FrameData>),
}

impl PartialEq for WorkerMonitorKey {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Edit(a, ap), Self::Edit(b, bp)) => a == b && ap == bp,
            (Self::Prepared(ag, at, ae, a), Self::Prepared(bg, bt, be, b)) => ag == bg && at == bt && ae == be && std::sync::Weak::ptr_eq(a, b),
            _ => false,
        }
    }
}

#[derive(Default)]
pub(crate) struct Views {
    monitor: Option<Aux>,
    /// The last edit frame's list through the camera, reused while nothing changed.
    monitor_list: Option<(MonitorKey, Arc<DrawList>, Option<Camera>)>,
    thumbnails: Option<Aux>,
    /// The revision thumbnails are drawn from, pinned while the interface asks for it.
    frames: Option<ExportFrames>,
    worker_monitor: Option<WorkerMonitorKey>,
    monitor_version: u32,
}

/// What [`Stage::prepare_thumbnail`] and [`Stage::render_thumbnail`] answer.
const READY: u32 = 0;
const WAIT: u32 = 1;
const STALE: u32 = 2;

/// Clears a canvas's current picture to opaque magenta, the colour the interface looks for to
/// tell that a GPU canvas's pixels reach the page here (`probe` in engine-stage.mjs and the
/// preview worker). Some setups present nothing from a WebGPU canvas (Xvfb without ANGLE on
/// Vulkan, here): the interface then keeps its own paths.
pub(crate) fn probe(surface: &wgpu::Surface<'static>, config: &wgpu::SurfaceConfiguration, device: &wgpu::Device, queue: &wgpu::Queue) -> bool {
    let target = match surface.get_current_texture() {
        wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
        _ => {
            surface.configure(device, config);
            return false;
        }
    };
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk canvas probe") });
    {
        let target_view = target.texture.create_view(&Default::default());
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("styk canvas probe"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &target_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 1.0, g: 0.0, b: 1.0, a: 1.0 }), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
    }
    queue.submit([encoder.finish()]);
    queue.present(target);
    true
}

impl Aux {
    /// The canvas's surface and renderer; its picture is cleared to the probe colour so the
    /// interface can check, in the same task, that the copy reaches the page.
    fn create(stage: &Stage, canvas: web_sys::OffscreenCanvas) -> Result<Aux, JsError> {
        let (width, height) = (canvas.width().max(1), canvas.height().max(1));
        let surface = stage.instance.create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas)).map_err(js_error)?;
        let config = wgpu::SurfaceConfiguration { width, height, ..stage.config.clone() };
        surface.configure(&stage.device, &config);
        probe(&surface, &config, &stage.device, &stage.queue);
        let renderer = Renderer::new(&stage.device, &stage.queue, config.format);
        Ok(Aux { surface, config, renderer, shared: None })
    }

    /// Draws `list` under `view` into the canvas, at `width × height`.
    fn draw(&mut self, stage: &Stage, list: &Arc<DrawList>, view: &ViewParams, width: u32, height: u32, grid: DrawingGrid) -> bool {
        self.renderer.set_drawing_grid(grid);
        let atlas = stage.atlas_of.map(|(lineage, pages)| (lineage, pages, stage.atlas_serial));
        if self.shared != atlas {
            self.renderer.share_sprites(&stage.renderer);
            self.shared = atlas;
        }
        let (width, height) = (width.max(1), height.max(1));
        if (width, height) != (self.config.width, self.config.height) {
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&stage.device, &self.config);
        }
        let target = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
            _ => {
                self.surface.configure(&stage.device, &self.config);
                return false;
            }
        };
        self.renderer.set_list(list);
        let mut encoder = stage.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk view") });
        self.renderer.render(&mut encoder, view, [width, height]);
        {
            let target_view = target.texture.create_view(&Default::default());
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("styk view present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            self.renderer.present(&mut pass);
        }
        stage.queue.submit([encoder.finish()]);
        stage.queue.present(target);
        true
    }
}

/// The view of a framing through the scene camera, clipped to its artboard, on `clear`.
fn view_of(framing: Framing, clear: [f64; 4]) -> ViewParams {
    ViewParams {
        matrix: framing.matrix,
        artboard: framing.artboard,
        clip_to_artboard: true,
        clear,
        zoom: framing.zoom,
        pan: framing.pan,
        stretch: 1.0,
        camera_view: true,
        camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
    }
}

#[wasm_bindgen]
impl Stage {
    /// Version of the stage frame for the worker's camera monitor, or zero with no
    /// displayed frame. Comparing only changed view data never evaluates a pose.
    pub fn monitor_version(&mut self) -> u32 {
        let key = match &self.shown {
            Shown::Nothing => return 0,
            Shown::Prepared { generation: shown_generation, tick, epoch } => {
                let Some(snapshot) = self.engine.prepared_frame(*tick, Some((*shown_generation, *epoch))) else { return 0; };
                WorkerMonitorKey::Prepared(snapshot.generation.id, *tick, *epoch, Arc::downgrade(&snapshot.frame))
            }
            Shown::Edit { generation: shown_generation, edits, effects, hidden, translations, .. } => {
                let Some(generation) = self.engine.try_generation_header().ok().flatten() else { return 0; };
                if *shown_generation != generation.generation { return 0; }
                let Some(images) = self.engine.try_images_pending() else { return 0; };
                WorkerMonitorKey::Edit(MonitorKey { generation: generation.generation, edits: *edits, effects: *effects, hidden: hidden.clone(), translations: translations.clone() }, images as u32)
            },
        };
        if self.views.worker_monitor.as_ref() != Some(&key) {
            self.views.worker_monitor = Some(key);
            self.views.monitor_version = self.views.monitor_version.wrapping_add(1).max(1);
        }
        self.views.monitor_version
    }

    /// Consumed by `Previews::monitor_begin` in the shared-memory preview worker.
    /// Captures shared pointers only; no camera preparation, geometry or raster work
    /// runs on the interface thread. Made only when a queued request is sent.
    pub fn monitor_address(&self) -> usize {
        let (frame, grid) = match &self.shown {
            Shown::Nothing => return 0,
            Shown::Prepared { generation: shown_generation, tick, epoch } => {
                let Some(generation) = self.engine.generation_for_frame_epoch(*shown_generation, *epoch) else { return 0; };
                (MonitorFrame::prepared_ticket(self.engine.clone(), generation, *tick, *epoch), DrawingGrid::World)
            }
            Shown::Edit { generation: shown_generation, scene, effects, hidden, translations, .. } => {
                let Some(generation) = self.engine.try_generation() else { return 0; };
                if *shown_generation != generation.id { return 0; }
                (MonitorFrame::edit(self.engine.clone(), generation, scene, hidden.clone(), translations.clone(), *effects), DrawingGrid::Destination)
            },
        };
        let direct_canvas = matches!(&self.shown, Shown::Edit { .. });
        Box::into_raw(Box::new(MonitorRequest { frame, grid, direct_canvas })) as usize
    }

    /// A message which failed to transfer never reached the worker: release its ticket.
    pub fn forget_monitor(&self, address: usize) {
        if address != 0 {
            // SAFETY: the caller owns the untransferred address produced above.
            drop(unsafe { Box::from_raw(address as *mut MonitorRequest) });
        }
    }
    /// Gives the camera monitor a canvas (`canvas`, drawn by a renderer of its own that
    /// samples the stage's pictures), its picture cleared to the probe colour ([`probe`]).
    /// `false` where the device cannot present to a second canvas (WebGL2): the interface
    /// draws the monitor itself there.
    pub fn attach_monitor(&mut self, canvas: web_sys::OffscreenCanvas) -> Result<bool, JsError> {
        if !self.is_webgpu {
            return Ok(false);
        }
        self.views.monitor = Some(Aux::create(self, canvas)?);
        Ok(true)
    }

    /// Draws the frame the stage drew last into the camera monitor, through the scene camera:
    /// `width × height` device pixels, `zoom` device pixels per scene unit, `pan` where the
    /// scene's origin lands. An edit frame is seen with its parallax layers moved and without
    /// onion skins, as the editor's monitor shows it. `false` when there is nothing to draw
    /// (no monitor, no frame yet, a prepared frame the cache no longer holds).
    pub fn render_monitor(&mut self, width: u32, height: u32, zoom: f64, pan_x: f64, pan_y: f64) -> Result<bool, JsError> {
        let Some(generation) = self.engine.generation() else { return Ok(false) };
        if self.views.monitor.is_none() {
            return Ok(false);
        }
        let grid = if matches!(self.shown, Shown::Prepared { .. }) { DrawingGrid::World } else { DrawingGrid::Destination };
        let (list, camera) = match self.shown.clone() {
            Shown::Nothing => return Ok(false),
            // Never evaluated here: the stage drew this tick from the cache a moment ago.
            Shown::Prepared { generation: shown_generation, tick, epoch } => {
                let Some(snapshot) = self.engine.prepared_frame(tick, Some((shown_generation, epoch))) else { return Ok(false); };
                if snapshot.generation.id != generation.id { return Ok(false); }
                (snapshot.frame.list.clone(), snapshot.frame.camera)
            },
            Shown::Edit { generation: shown_generation, edits, effects, scene, hidden, translations } => {
                if shown_generation != generation.id { return Ok(false); }
                let key = MonitorKey { generation: generation.id, edits, effects, hidden, translations };
                match self.views.monitor_list.as_ref().filter(|(known, _, _)| *known == key) {
                    Some((_, list, camera)) => (list.clone(), *camera),
                    None => {
                        let options = EditOptions { hidden: &key.hidden, translations: &key.translations, background: None, onions: &[], bypass_effects: !effects, camera: true, prepare_camera: true, clock: Some(crate::clock), anchor_budget_ms: 6.0, live: None };
                        let mut scene = scene.snapshot();
                        let Some(list) = scene.draw_list(&generation, &options).map_err(js_error)? else { return Ok(false) };
                        let camera = scene.camera();
                        // Generated effects still being refined are built again next time.
                        self.views.monitor_list = (!scene.refining()).then(|| (key, list.clone(), camera));
                        (list, camera)
                    }
                }
            }
        };
        let doc = &generation.prepared.doc;
        let pan = [pan_x, pan_y];
        let framing = Framing {
            matrix: styk_eval::view::camera_matrix(doc, camera.as_ref(), zoom, pan),
            artboard: [pan[0], pan[1], pan[0] + doc.canvas[0] as f64 * zoom, pan[1] + doc.canvas[1] as f64 * zoom],
            zoom,
            pan,
        };
        let mut monitor = self.views.monitor.take().expect("checked above");
        let drawn = monitor.draw(self, &list, &view_of(framing, [0.0; 4]), width, height, grid);
        self.views.monitor = Some(monitor);
        Ok(drawn)
    }

    /// Releases the camera monitor's canvas and renderer.
    pub fn detach_monitor(&mut self) {
        self.views.monitor = None;
        self.views.monitor_list = None;
        self.views.worker_monitor = None;
    }

    /// Gives frame thumbnails a canvas, as [`Stage::attach_monitor`] does the monitor
    /// (cleared to the probe colour too).
    pub fn attach_thumbnails(&mut self, canvas: web_sys::OffscreenCanvas) -> Result<bool, JsError> {
        if !self.is_webgpu {
            return Ok(false);
        }
        self.views.thumbnails = Some(Aux::create(self, canvas)?);
        Ok(true)
    }

    /// Asks the engine's workers for `tick` of the document at `revision`, for a thumbnail.
    /// 0: ready to draw; 1: being prepared (wait for the engine's progress, then ask again);
    /// 2: the engine holds another revision (or none). Fails for a tick past the end.
    pub fn prepare_thumbnail(&mut self, revision: f64, tick: u32) -> Result<u32, JsError> {
        let Some(frames) = self.thumbnail_frames(revision as u64) else { return Ok(STALE) };
        if tick >= frames.ticks() {
            return Err(js_error(format!("The document has no tick {tick} ({} ticks).", frames.ticks())));
        }
        if frames.ready(tick).is_some() {
            return Ok(READY);
        }
        // Frames asked for and never drawn (a cancelled thumbnail) give their places back.
        if frames.waiting() >= AHEAD {
            frames.forget();
        }
        frames.prefetch([tick]);
        Ok(WAIT)
    }

    /// Draws the thumbnail of `tick` of `revision` on a `width × height` card into the
    /// thumbnails' canvas. 0: drawn; 1: its frame or some of the document's pictures are not
    /// ready yet (they are uploaded as they come: wait for the engine's progress, then ask
    /// again); 2: the engine holds another revision.
    pub fn render_thumbnail(&mut self, revision: f64, tick: u32, width: u32, height: u32) -> Result<u32, JsError> {
        if !(1..=MAX_SIDE).contains(&width) || !(1..=MAX_SIDE).contains(&height) {
            return Err(js_error(format!("Thumbnails are 1 to {MAX_SIDE} pixels a side ({width}×{height} asked).")));
        }
        if self.views.thumbnails.is_none() {
            return Err(js_error("attach the thumbnails' canvas first"));
        }
        let Some(frames) = self.thumbnail_frames(revision as u64) else { return Ok(STALE) };
        let Some(frame) = frames.ready(tick) else {
            frames.prefetch([tick]);
            return Ok(WAIT);
        };
        let generation = frames.generation().clone();
        // A thumbnail never shows a frame without its pictures: they reach the atlas first.
        self.sync_images(&generation);
        if self.engine.images_pending() > 0 {
            return Ok(WAIT);
        }
        let framing = card(&generation.prepared.doc, frame.camera.as_ref(), width, height);
        let mut thumbnails = self.views.thumbnails.take().expect("checked above");
        let drawn = thumbnails.draw(self, &frame.list, &view_of(framing, CARD), width, height, DrawingGrid::Destination);
        self.views.thumbnails = Some(thumbnails);
        if drawn {
            // Drawn: its place among the frames prepared ahead is free again.
            let _ = self.views.frames.as_ref().and_then(|frames| frames.take(tick));
        }
        Ok(if drawn { READY } else { WAIT })
    }

    /// Releases the thumbnails' canvas, renderer and pinned frames.
    pub fn detach_thumbnails(&mut self) {
        self.views.thumbnails = None;
        self.views.frames = None;
    }
}

impl Stage {
    /// The frames of `revision`, pinned for thumbnails; `None` when the engine holds another.
    fn thumbnail_frames(&mut self, revision: u64) -> Option<&ExportFrames> {
        let generation = self.engine.generation().filter(|g| g.revision == revision)?;
        if !self.views.frames.as_ref().is_some_and(|frames| frames.generation().id == generation.id) {
            // A new revision: frames prepared for the old one are abandoned.
            self.views.frames = self.engine.export_frames(revision).ok();
        }
        self.views.frames.as_ref()
    }
}
