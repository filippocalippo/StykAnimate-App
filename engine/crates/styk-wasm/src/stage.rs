//! One canvas: the GPU surface and the renderer that draws prepared frames into it.

use std::sync::Arc;

use styk_engine::edit::{EditOptions, EditScene, Onion};
use styk_engine::{Engine, Generation, Uploaded};
use styk_render::{Renderer, ViewParams, wgpu};
use wasm_bindgen::prelude::*;

use crate::engine::EngineHandle;
use crate::js_error;

/// Pixels of decoded images uploaded per frame at most, so a document with many
/// sprites fills its atlas over a few frames instead of stalling one.
const IMAGE_UPLOAD_BYTES: usize = 8 << 20;

/// Device errors kept for the interface between two reads; later ones are dropped.
const MAX_REPORTED_ERRORS: usize = 8;

/// [`Stage::pictures_pending`]: the last frame drawn has all its pictures (or none it
/// lacks can still come), lacks some that are decoded and wait for upload (draw again
/// on the next frame), or lacks some still being decoded (draw again once the engine's
/// progress counter advances).
const PICTURES_COMPLETE: u32 = 0;
const PICTURES_DECODED: u32 = 1;
const PICTURES_DECODING: u32 = 2;

/// What the stage drew last: the camera monitor shows the same frame (`views.rs`).
#[derive(Clone, Default)]
pub(crate) enum Shown {
    #[default]
    Nothing,
    Edit { generation: u64, edits: u64, effects: bool, scene: std::sync::Arc<EditScene>, hidden: Vec<u32>, translations: Vec<(u32, [f64; 2])> },
    Prepared { generation: u64, tick: f64, epoch: u64 },
}

/// One onion skin as the stage draws it: the pose it is kept as (`EditScene::update_ghost`) and what is not drawn of it.
struct Skin {
    id: u32,
    opacity: f64,
    tint: Option<[u8; 3]>,
    show_on_top: bool,
    hidden: Vec<u32>,
}

#[wasm_bindgen]
pub struct Stage {
    pub(crate) engine: Engine,
    pub(crate) instance: wgpu::Instance,
    /// The device presents through WebGPU (a second canvas can share it), not WebGL2.
    pub(crate) is_webgpu: bool,
    surface: wgpu::Surface<'static>,
    pub(crate) config: wgpu::SurfaceConfiguration,
    pub(crate) device: wgpu::Device,
    pub(crate) queue: wgpu::Queue,
    pub(crate) renderer: Renderer,
    backend: String,
    /// The document lineage and page count the sprite atlas is allocated for.
    pub(crate) atlas_of: Option<(u64, u32)>,
    /// Counts the sprite textures allocated, so the views sharing the stage's follow a new one.
    pub(crate) atlas_serial: u32,
    /// Drawing cels the interface holds live, drawn in place of their published tiles
    /// (`styk_eval::live`), and the atlas pages after the document's own allocated for their slots.
    pub(crate) live: styk_eval::live::LiveCels,
    live_pages: u32,
    /// The atlas places uploaded so far, and whether the last frame drawn lacked a
    /// picture ([`Stage::pictures_pending`]).
    uploaded: Uploaded,
    pictures: u32,
    /// Bytes of pictures the last frame uploaded to the atlas.
    upload_bytes: usize,
    pub(crate) edit: EditScene,
    /// What a click on artwork draws with ([`Stage::pick_artwork`]).
    picker: styk_export::pick::Picker,
    /// The onion skins drawn behind the frame ([`Stage::set_onions`]): the set the session planned and how each is drawn.
    skins: Option<(Arc<styk_edit::OnionSet>, Vec<Skin>)>,
    /// Effects are drawn (the editor's effects preview is on).
    pub(crate) effects: bool,
    /// The workspace view's rotation (radians) and mirroring, applied to every frame drawn
    /// ([`Stage::set_view_orientation`]).
    rotation: f64,
    flip: bool,
    /// Edit and ghost poses received, so a camera monitor list knows when it is stale.
    pub(crate) edits: u64,
    pub(crate) shown: Shown,
    /// Why the device was lost, once it is (polled by the interface: `Stage::device_lost`).
    lost: Arc<std::sync::OnceLock<String>>,
    /// Errors the device reported that nobody captured, until the interface takes them.
    errors: Arc<std::sync::Mutex<Vec<String>>>,
    /// The last frame drawn nothing because the surface had no texture to give (lost or resizing).
    surface_missed: bool,
    /// The camera monitor and frame thumbnails, drawn on this device (`views.rs`).
    pub(crate) views: crate::views::Views,
}

#[wasm_bindgen]
impl Stage {
    /// Actual successful shown head only: kind, generation, exact sample or edit
    /// stamp, prepared cache epoch, and edit-effects flag. The host derives its
    /// shown token alongside view/resource/input lifetime epochs; no scene walk.
    pub fn shown_identity(&self) -> Vec<f64> {
        match &self.shown {
            Shown::Nothing => vec![0.0; 5],
            Shown::Prepared { generation, tick, epoch } => vec![1.0, *generation as f64, *tick, *epoch as f64, 0.0],
            Shown::Edit { generation, edits, effects, .. } => vec![2.0, *generation as f64, *edits as f64, 0.0, if *effects { 1.0 } else { 0.0 }],
        }
    }

    /// Creates the surface of `canvas`: WebGPU where the browser has it, WebGL2 otherwise.
    pub async fn create(canvas: web_sys::HtmlCanvasElement, engine: &EngineHandle) -> Result<Stage, JsError> {
        let (width, height) = (canvas.width().max(1), canvas.height().max(1));
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::BROWSER_WEBGPU | wgpu::Backends::GL;
        let instance = wgpu::util::new_instance_with_webgpu_detection(descriptor).await;
        let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas)).map_err(js_error)?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, compatible_surface: Some(&surface), ..Default::default() })
            .await
            .map_err(js_error)?;
        let info = adapter.get_info();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("styk stage"),
                required_limits: wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
                ..Default::default()
            })
            .await
            .map_err(js_error)?;
        let capabilities = surface.get_capabilities(&adapter);
        let format = capabilities.formats.iter().copied().find(|f| !f.is_srgb()).or(capabilities.formats.first().copied()).ok_or_else(|| js_error("the canvas has no surface format"))?;
        // The pasteboard around the document is the page showing through. Every WebGPU canvas
        // supports premultiplied alpha, but wgpu's WebGPU backend lists only opaque (which
        // presented the pasteboard black).
        let alpha_mode = if info.backend == wgpu::Backend::BrowserWebGpu || capabilities.alpha_modes.contains(&wgpu::CompositeAlphaMode::PreMultiplied) {
            wgpu::CompositeAlphaMode::PreMultiplied
        } else {
            capabilities.alpha_modes[0]
        };
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width,
            height,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode,
            view_formats: vec![],
            color_space: Default::default(),
        };
        surface.configure(&device, &config);
        let lost = Arc::new(std::sync::OnceLock::new());
        let reason = lost.clone();
        device.set_device_lost_callback(move |why, message| {
            let _ = reason.set(format!("{why:?}: {message}"));
        });
        // An error nobody captures would otherwise panic and stop the whole engine module: it is
        // kept for the interface to report, and running out of memory ends the device.
        let errors: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
        let (reported, exhausted) = (errors.clone(), lost.clone());
        device.on_uncaptured_error(Arc::new(move |error: wgpu::Error| {
            if matches!(error, wgpu::Error::OutOfMemory { .. }) {
                let _ = exhausted.set(format!("out of memory: {error}"));
            }
            let mut kept = reported.lock().unwrap_or_else(|e| e.into_inner());
            if kept.len() < MAX_REPORTED_ERRORS {
                kept.push(error.to_string());
            }
        }));
        let renderer = Renderer::new(&device, &queue, format);
        // A stage over a document that is already open (the canvas was replaced after a lost device):
        // the pictures decoded so far went to the stage before it.
        engine.engine.redecode_images();
        let is_webgpu = info.backend == wgpu::Backend::BrowserWebGpu;
        Ok(Stage {
            engine: engine.engine.clone(),
            instance,
            is_webgpu,
            surface,
            config,
            device,
            queue,
            renderer,
            backend: format!("{:?} · {}", info.backend, info.name),
            atlas_of: None,
            atlas_serial: 0,
            live: Default::default(),
            live_pages: 0,
            uploaded: Uploaded::default(),
            pictures: PICTURES_COMPLETE,
            upload_bytes: 0,
            edit: EditScene::default(),
            picker: Default::default(),
            skins: None,
            effects: true,
            rotation: 0.0,
            flip: false,
            edits: 0,
            shown: Shown::Nothing,
            lost,
            errors,
            surface_missed: false,
            views: Default::default(),
        })
    }

    /// Why the graphics device was lost (the browser reset it, the driver stopped), or an empty
    /// string while it is not. A lost stage draws nothing more: the page makes a new one.
    pub fn device_lost(&self) -> String {
        self.lost.get().cloned().unwrap_or_default()
    }

    /// The errors the device reported that nothing captured since the last call (validation
    /// errors, out of memory), newline-separated: empty when there are none.
    pub fn take_device_errors(&self) -> String {
        std::mem::take(&mut *self.errors.lock().unwrap_or_else(|e| e.into_inner())).join("\n")
    }

    /// Destroys the graphics device as a driver reset would: the stage then reports it lost
    /// ([`Stage::device_lost`]). For tests of the interface's recovery.
    pub fn lose_device(&self) {
        self.device.destroy();
    }

    /// Whether the last frame drew nothing because the surface had no texture to give (it was lost
    /// or being resized and is configured again): asking again on the next animation frame works.
    pub fn surface_pending(&self) -> bool {
        self.surface_missed
    }

    /// Turns effects on or off (the editor's effects preview).
    pub fn set_effects(&mut self, on: bool) {
        self.effects = on;
    }

    /// Rotates the workspace view by `rotation` radians about the artboard's centre and mirrors it
    /// horizontally when `flip` (the Draw view): every frame drawn from now on, edited or prepared.
    pub fn set_view_orientation(&mut self, rotation: f64, flip: bool) {
        self.rotation = if rotation.is_finite() { rotation } else { 0.0 };
        self.flip = flip;
    }

    /// Lowers (`false`) or restores (`true`) the multisampling of the stage's edges: the preview's
    /// quality ladder under load.
    pub fn set_multisampled(&mut self, on: bool) {
        self.renderer.set_multisampled(on);
    }

    /// The largest texture side the device allows: the surface cannot be larger.
    pub fn max_texture(&self) -> u32 {
        self.device.limits().max_texture_dimension_2d
    }

    /// The selected browser presenter uses direct Canvas drawing semantics.
    /// Prepared playback explicitly restores the portable world-grid policy.
    pub fn set_canvas_drawing(&mut self, direct: bool) {
        self.renderer.set_drawing_grid(if direct { styk_render::DrawingGrid::Destination } else { styk_render::DrawingGrid::World });
    }

    /// The graphics backend and adapter in use, for the status line and reports.
    pub fn backend(&self) -> String {
        self.backend.clone()
    }

    /// Sets the drawing buffer size in device pixels.
    pub fn resize(&mut self, width: u32, height: u32) {
        // A surface larger than the device's textures cannot be configured.
        let limit = self.device.limits().max_texture_dimension_2d;
        let (width, height) = (width.clamp(1, limit), height.clamp(1, limit));
        if (width, height) != (self.config.width, self.config.height) {
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
        }
    }

    /// Draws `tick`. `zoom` is device pixels per scene unit and `pan` the device-pixel
    /// position of the scene's origin; with `camera`, the scene's own camera applies on
    /// top (playback), otherwise the view is the editor's neutral one. With `wait`, a
    /// frame no worker has prepared is prepared here; otherwise nothing is drawn and
    /// `false` is returned.
    #[allow(clippy::too_many_arguments)]
    pub fn render(&mut self, tick: u32, zoom: f64, pan_x: f64, pan_y: f64, camera: bool, clip_to_artboard: bool, wait: bool) -> Result<bool, JsError> {
        let snapshot = if wait { self.engine.prepared_frame_now_at(tick as f64) } else { self.engine.prepared_frame(tick as f64, None) };
        let Some(snapshot) = snapshot else { return Ok(false) };
        self.present_prepared(&snapshot, zoom, [pan_x, pan_y], camera, clip_to_artboard)
    }

    /// Presents an already prepared finite sample. A cold sample returns false and
    /// preserves the actual shown frame; evaluation always runs on the worker.
    pub fn render_sample(&mut self, tick: f64, zoom: f64, pan_x: f64, pan_y: f64, camera: bool, clip_to_artboard: bool) -> Result<bool, JsError> {
        let Some(snapshot) = self.engine.prepared_frame(tick, None) else { return Ok(false) };
        self.present_prepared(&snapshot, zoom, [pan_x, pan_y], camera, clip_to_artboard)
    }

    /// An external packet must match native readiness at the drawing boundary,
    /// even when a worker publishes between a JavaScript readiness read and draw.
    #[allow(clippy::too_many_arguments)]
    pub fn render_ticket(&mut self, generation: f64, epoch: f64, tick: f64, zoom: f64, pan_x: f64, pan_y: f64, camera: bool, clip_to_artboard: bool) -> Result<bool, JsError> {
        let (Some(generation), Some(epoch)) = (crate::engine::counter(generation), crate::engine::counter(epoch)) else { return Ok(false); };
        let Some(snapshot) = self.engine.prepared_frame(tick, Some((generation, epoch))) else { return Ok(false) };
        self.present_prepared(&snapshot, zoom, [pan_x, pan_y], camera, clip_to_artboard)
    }

    fn present_prepared(&mut self, snapshot: &styk_engine::FrameSnapshot, zoom: f64, pan: [f64; 2], camera: bool, clip_to_artboard: bool) -> Result<bool, JsError> {
        let generation = &snapshot.generation;
        let frame = &snapshot.frame;
        let drawn = self.draw(generation, &frame.list, if camera { frame.camera } else { None }, zoom, pan, clip_to_artboard)?;
        if drawn {
            self.shown = Shown::Prepared { generation: generation.id, tick: frame.tick, epoch: snapshot.epoch };
        }
        Ok(drawn)
    }

    /// Replaces the frame the editor is showing: keyframe-shaped JSON whose `objects`
    /// are poses, or `null` for an object unchanged since the last call.
    pub fn edit_frame(&mut self, json: &str) -> Result<(), JsError> {
        let generation = self.engine.generation().ok_or_else(|| js_error("no document is open"))?;
        self.edits += 1;
        self.edit.update(&generation, json.as_bytes()).map_err(js_error)
    }

    /// Replaces the frame the editor is showing with the one `session` shows at `view` (the call's view): the
    /// gesture in progress, else the document at the playhead; with `motion`, the motion-path edit's display where
    /// it shows one. No pose crosses from the interface.
    pub fn edit_session(&mut self, session: &mut crate::edit::EditSession, view: &str, motion: bool) -> Result<(), JsError> {
        let generation = self.engine.generation().ok_or_else(|| js_error("no document is open"))?;
        let record = session.show(view, motion)?;
        self.edits += 1;
        self.edit.update_record(&generation, &record).map_err(js_error)
    }

    /// Sets the onion skins drawn behind the frame: the ones `session` plans for `request` (the settings, JSON) at `view` (the
    /// call's view), from its document. Poses already kept are not made again, and a set already held is not described again.
    pub fn set_onions(&mut self, session: &mut crate::edit::EditSession, view: &str, request: &str) -> Result<(), JsError> {
        let generation = self.engine.generation().ok_or_else(|| js_error("no document is open"))?;
        let set = session.onions(view, request)?;
        let held = self.skins.as_ref().is_some_and(|(held, _)| Arc::ptr_eq(held, &set));
        let mut skins = Vec::with_capacity(if held { 0 } else { set.ghosts.len() });
        let mut changed = !held;
        for ghost in &set.ghosts {
            // A pose is kept by the tick it samples (a whole number).
            let id = ghost.tick as u32;
            if !self.edit.has_ghost(id, &ghost.record) {
                self.edit.update_ghost(&generation, id, &ghost.record).map_err(js_error)?;
                changed = true;
            }
            if !held {
                skins.push(Skin { id, opacity: ghost.opacity, tint: ghost.tint, show_on_top: ghost.show_on_top, hidden: ghost.hidden.clone() });
            }
        }
        if !held {
            self.skins = Some((set, skins));
        }
        if changed {
            self.edits += 1;
        }
        Ok(())
    }

    /// Draws no onion skins.
    pub fn clear_onions(&mut self) {
        if self.skins.take().is_some() {
            self.edits += 1;
        }
    }

    /// Whether the last edit frame's generated effects still lack some of their targets'
    /// earlier positions (they used the current pose): the interface draws again.
    pub fn refining(&self) -> bool {
        self.edit.refining()
    }

    /// Whether the last frame drawn lacked pictures that are still to come: 0 when it had
    /// every picture it shows (or the ones it lacks will never come: a picture that failed
    /// to decode), 1 when some are decoded and wait for upload (each frame uploads a
    /// slice: draw again on the next frame), 2 when some are still being decoded on the
    /// engine's workers (draw again once the progress counter advances). Without this a
    /// still frame shown while its drawing cels decode lacked them until something else
    /// drew again.
    pub fn pictures_pending(&self) -> u32 {
        if self.edit.camera_pending().is_some() { 2 } else { self.pictures }
    }

    /// Uploads a slice of the pictures decoded since the last frame, without drawing one: the document's pictures
    /// the frame shown does not need are taken in while the interface is idle, so decoded pixels do not wait in the
    /// engine's memory (and the engine decodes the next ones). Answers like [`Stage::pictures_pending`] for the
    /// document: 0 when every picture is in, 1 when some are decoded and wait for the next slice, 2 when the
    /// rest is still being decoded.
    pub fn upload_pictures(&mut self) -> u32 {
        if self.lost.get().is_some() {
            return PICTURES_COMPLETE;
        }
        let Some(generation) = self.engine.generation() else { return PICTURES_COMPLETE };
        self.sync_images(&generation);
        let (decoding, decoded) = self.engine.images_backlog();
        if decoded > 0 { PICTURES_DECODED } else if decoding > 0 { PICTURES_DECODING } else { PICTURES_COMPLETE }
    }

    /// A cold followed pose is accepted but awaits the engine worker's shared path.
    pub fn camera_pending(&self) -> bool { self.edit.camera_pending().is_some() }

    /// The figure whose artwork is under a point of the frame on show, for a click: `request` is
    /// `{x, y, scale, hidden: [uid], locked: [uid]}` (the point in scene units, the view's scale, the figures
    /// that cannot be picked), the answer `{slot, uid}` of the topmost figure drawn there, or `null`
    /// ([`styk_export::pick`]).
    pub fn pick_artwork(&mut self, request: &str) -> Result<String, JsError> {
        let request = styk_doc::json::parse(request.as_bytes()).map_err(js_error)?;
        let number = |key: &str| request.get(key).and_then(styk_doc::Value::as_f64).ok_or_else(|| js_error(format!("a pick needs {key}")));
        let uids = |key: &str| -> std::collections::HashSet<u32> { request.get(key).and_then(styk_doc::Value::elements).map(|list| list.iter().filter_map(|uid| uid.as_f64()).map(|uid| uid as u32).collect()).unwrap_or_default() };
        let (generation, frame) = match (self.engine.generation(), self.edit.frame()) {
            (Some(generation), Some(frame)) => (generation, frame),
            _ => return Ok("null".into()),
        };
        let hit = styk_export::pick::artwork(&mut self.picker, &generation.prepared.doc, &generation.assets, &frame, [number("x")?, number("y")?], request.get("scale").and_then(styk_doc::Value::as_f64).unwrap_or(1.0), &uids("hidden"), &uids("locked")).map_err(js_error)?;
        Ok(match hit {
            Some(hit) => format!("{{\"slot\":{},\"uid\":{}}}", hit.slot, hit.uid),
            None => "null".into(),
        })
    }

    /// Draws the edit frame with the onion skins set by [`Stage::set_onions`]. `hidden` lists object slots not drawn;
    /// `translations` holds `slot, dx, dy` triples of dragged objects; `background` is an ARGB canvas colour
    /// replacing the scene background, or a negative number for none.
    #[allow(clippy::too_many_arguments)]
    pub fn render_edit(&mut self, zoom: f64, pan_x: f64, pan_y: f64, camera: bool, clip_to_artboard: bool, hidden: &[u32], translations: &[f64], background: f64) -> Result<bool, JsError> {
        let Some(generation) = self.engine.generation() else { return Ok(false) };
        let translations: Vec<(u32, [f64; 2])> = translations.chunks_exact(3).map(|t| (t[0] as u32, [t[1], t[2]])).collect();
        let onion_list: Vec<Onion<'_>> = self
            .skins
            .iter()
            .flat_map(|(_, skins)| skins)
            .map(|skin| Onion { id: skin.id, opacity: skin.opacity, tint: skin.tint, show_on_top: skin.show_on_top, hidden: &skin.hidden })
            .collect();
        // Generated effects evaluate earlier anchors for at most 6 ms a frame, as the editor does
        // (`INTERACTIVE_SAMPLING_MS`); the rest refine over the next frames (`refining`).
        let options = EditOptions { hidden, translations: &translations, background: (background >= 0.0).then_some(background as u32), onions: &onion_list, bypass_effects: !self.effects, camera, prepare_camera: false, clock: Some(crate::clock), anchor_budget_ms: 6.0, live: (!self.live.is_empty()).then_some(&self.live) };
        let Some(list) = self.edit.draw_list(&generation, &options).map_err(js_error)? else {
            if let Some(tick) = self.edit.camera_pending()
                && !generation.prepared.doc.keyframes.is_empty()
            {
                // Both neighbours are bounded existing frame tickets. At a follow
                // clip's end ceil(tick) can be inactive; floor(tick) warms its last row.
                // Presentation still waits on travel_ready for this exact Prepared.
                let last = generation.playable_ticks().saturating_sub(1);
                let before = (tick.floor().max(0.0) as u32).min(last);
                let after = (tick.ceil().max(0.0) as u32).min(last);
                self.engine.request(before, &[after, before]);
            }
            // A definitions-only mirror has no target poses. Its adapter first
            // syncs frames asynchronously; sampling its empty projection would
            // publish a camera path for the wrong document.
            return Ok(false);
        };
        let scene_camera = if camera { self.edit.camera() } else { None };
        let drawn = self.draw(&generation, &list, scene_camera, zoom, [pan_x, pan_y], clip_to_artboard)?;
        if drawn {
            self.shown = Shown::Edit { generation: generation.id, edits: self.edits, effects: self.effects, scene: std::sync::Arc::new(self.edit.snapshot()), hidden: hidden.to_vec(), translations };
        }
        Ok(drawn)
    }

    /// Lays the sprite atlas out for `generation` and uploads a slice of the pictures decoded
    /// since (the camera monitor and thumbnails sample the same atlas).
    pub(crate) fn sync_images(&mut self, generation: &Generation) {
        self.sync_atlas(generation);
        let images = self.engine.take_images(IMAGE_UPLOAD_BYTES);
        self.upload_bytes = images.iter().map(|image| image.rgba.len()).sum();
        if !images.is_empty() {
            self.renderer.upload_images(&generation.assets, images.iter().map(|image| &**image));
            for image in &images {
                self.uploaded.record(&generation.assets, image);
            }
        }
    }

    /// Lays the sprite atlas out for `generation`, with room for the live drawing cels' slots.
    fn sync_atlas(&mut self, generation: &Generation) {
        let layout = (generation.lineage, generation.assets.pages);
        let live_pages = self.live.pages();
        if self.atlas_of != Some(layout) {
            // Another project, or more atlas pages than before: the texture is allocated
            // again and every image decoded so far is uploaded again by the engine.
            self.renderer.prepare_sprites_live(&generation.assets, live_pages);
            self.live_pages = live_pages;
            self.atlas_serial += 1;
            self.uploaded.clear();
            if self.atlas_of.is_some_and(|(lineage, _)| lineage == layout.0) {
                self.engine.redecode_images();
            }
            self.atlas_of = Some(layout);
            // The live slots lived in the texture that was replaced.
            let uploads = self.live.uploads();
            self.write_live(&uploads);
        } else if live_pages > self.live_pages {
            // More live slots than pages: the texture grows and keeps what it holds.
            self.renderer.grow_sprites(&generation.assets, live_pages);
            self.live_pages = live_pages;
            self.atlas_serial += 1;
        }
    }

    /// Writes live drawing slots into the atlas laid out for the document drawn last.
    fn write_live(&mut self, uploads: &[styk_eval::live::Upload]) {
        let Some((_, base)) = self.atlas_of else { return };
        self.renderer.upload_live(base, uploads);
        for upload in uploads {
            self.uploaded.mark(base + upload.page, upload.x, upload.y);
        }
    }

    /// What [`Stage::pictures_pending`] reports after drawing `list`. The list is looked
    /// through only while pictures of the document are still on their way.
    fn pictures_after(&self, list: &styk_eval::drawlist::DrawList) -> u32 {
        let (decoding, decoded) = self.engine.images_backlog();
        if decoding + decoded == 0 || !self.uploaded.lacks(list) {
            PICTURES_COMPLETE
        } else if decoded > 0 {
            PICTURES_DECODED
        } else {
            PICTURES_DECODING
        }
    }

    fn draw(&mut self, generation: &Arc<Generation>, list: &Arc<styk_eval::drawlist::DrawList>, camera: Option<styk_eval::doc::Camera>, zoom: f64, pan: [f64; 2], clip_to_artboard: bool) -> Result<bool, JsError> {
        // A lost device draws nothing more (the interface makes a new stage); drawing on it would only raise errors.
        if self.lost.get().is_some() {
            return Ok(false);
        }
        self.sync_images(generation);
        let doc = &generation.prepared.doc;
        // The Draw view turns and mirrors about the artboard's centre, after the scene camera.
        let orientation = styk_eval::view::orientation(self.rotation, self.flip, [pan[0] + doc.canvas[0] as f64 * zoom / 2.0, pan[1] + doc.canvas[1] as f64 * zoom / 2.0]);
        let upright = styk_eval::view::camera_matrix(doc, camera.as_ref(), zoom, pan);
        let m = orientation.map_or(upright, |o| styk_eval::view::compose(o, upright));
        self.renderer.set_orientation(orientation);
        // The artboard is the scene rectangle under the workspace view alone: the camera moves the scene inside it.
        let (p0, p1) = (pan, [pan[0] + doc.canvas[0] as f64 * zoom, pan[1] + doc.canvas[1] as f64 * zoom]);
        let view = ViewParams {
            matrix: m,
            artboard: [p0[0].min(p1[0]), p0[1].min(p1[1]), p0[0].max(p1[0]), p0[1].max(p1[1])],
            clip_to_artboard,
            clear: [0.0; 4],
            zoom,
            pan,
            stretch: 1.0,
            camera_view: camera.is_some(),
            camera_limit: styk_render::CAMERA_PREVIEW_LIMIT,
        };
        let target = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) | wgpu::CurrentSurfaceTexture::Suboptimal(texture) => texture,
            _ => {
                // The surface was lost or is being resized: configure it again and draw next frame.
                self.surface.configure(&self.device, &self.config);
                self.surface_missed = true;
                return Ok(false);
            }
        };
        self.surface_missed = false;
        self.renderer.set_list(list);
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("styk frame") });
        self.renderer.render(&mut encoder, &view, [self.config.width, self.config.height]);
        {
            let target_view = target.texture.create_view(&Default::default());
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("styk present"),
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
        self.queue.submit([encoder.finish()]);
        self.queue.present(target);
        self.pictures = self.pictures_after(list);
        Ok(true)
    }

    /// Replaces tiles of the drawing cel `id` the interface holds live, so edit frames draw its
    /// pixels before they are published (`styk_eval::live`). `tiles` holds records of the tile
    /// coordinates (two little-endian `i32`) and its 64×64 straight-alpha RGBA pixels; `removed`
    /// pairs of coordinates of tiles that are gone. `float` addresses the floating selection
    /// instead of the cel itself. The cel is hidden until [`Stage::live_cel_show`]. Fails with
    /// "full" when the live slots are used up (the cel is dropped).
    pub fn live_cel_tiles(&mut self, id: &str, float: bool, tiles: &[u8], removed: &[i32]) -> Result<(), JsError> {
        const RECORD: usize = 8 + styk_eval::live::TILE_BYTES;
        if tiles.len() % RECORD != 0 || removed.len() % 2 != 0 {
            return Err(js_error("a live tile list is cut short"));
        }
        let generation = self.engine.generation().ok_or_else(|| js_error("no document is open"))?;
        let mut changes: Vec<((i32, i32), Option<Vec<u8>>)> = tiles
            .chunks_exact(RECORD)
            .map(|record| {
                let coordinate = |at: usize| i32::from_le_bytes(record[at..at + 4].try_into().expect("four bytes"));
                ((coordinate(0), coordinate(4)), Some(record[8..].to_vec()))
            })
            .collect();
        changes.extend(removed.chunks_exact(2).map(|pair| ((pair[0], pair[1]), None)));
        let uploads = self.live.update(id, float, changes).map_err(|_| js_error("the live drawing slots are full"))?;
        self.sync_atlas(&generation);
        self.write_live(&uploads);
        Ok(())
    }

    /// Chooses what the live cel `id` shows: its own pixels in place of the published cel, and
    /// its floating selection over them.
    pub fn live_cel_show(&mut self, id: &str, base: bool, float: bool) {
        self.live.show(id, base, float);
    }

    /// Sets the transform of the live cel's floating selection: `[a, b, c, d, e, f]` taking cel
    /// pixel `(x, y)` to `(a x + c y + e, b x + d y + f)`.
    pub fn live_cel_matrix(&mut self, id: &str, matrix: &[f64]) -> Result<(), JsError> {
        let matrix: [f64; 6] = matrix.try_into().map_err(|_| js_error("a transform has six numbers"))?;
        if !matrix.iter().all(|v| v.is_finite()) {
            return Err(js_error("a transform has finite numbers"));
        }
        self.live.set_matrix(id, matrix);
        Ok(())
    }

    /// Empties the live cel's floating selection and gives its slots back.
    pub fn live_cel_clear_float(&mut self, id: &str) {
        self.live.clear_float(id);
    }

    /// Lets go of the live cel `id`: edit frames draw its published tiles again.
    pub fn live_cel_drop(&mut self, id: &str) {
        self.live.drop_cel(id);
    }

    /// Lets go of every live cel (another document is open).
    pub fn live_cel_reset(&mut self) {
        self.live.clear();
    }

    /// The live cels held: `{cels, tiles, slots, pages}` as JSON.
    pub fn live_cel_stats(&self) -> String {
        let s = self.live.stats();
        format!("{{\"cels\":{},\"tiles\":{},\"slots\":{},\"pages\":{}}}", s.cels, s.tiles, s.slots, s.pages)
    }

    /// Primitive, isolation group and pass counts of the last frame, its effect layers and
    /// passes, the GPU memory of the effect slots, isolation atlases and depth buffers, and the
    /// glyph masks kept, filled by the last frame and their memory, the picture bytes the last frame
    /// uploaded, the pictures held and whether edges are multisampled, as JSON.
    pub fn stats(&self) -> String {
        let s = &self.renderer.stats;
        format!(
            "{{\"prims\":{},\"groups\":{},\"passes\":{},\"downscaled\":{},\"rounds\":{},\"effectLayers\":{},\"effectPasses\":{},\"effectBytes\":{},\"layerBytes\":{},\"depthBytes\":{},\"materialBytes\":{},\"glyphMasks\":{},\"glyphMasksFilled\":{},\"glyphBytes\":{},\"uploadBytes\":{},\"pictures\":{},\"multisampled\":{}}}",
            s.prims, s.groups, s.passes, s.downscaled, s.rounds, s.effect_layers, s.effect_passes, s.effect_bytes, s.layer_bytes, s.depth_bytes, s.material_bytes, s.glyph_masks, s.glyph_masks_filled, s.glyph_bytes,
            self.upload_bytes, self.uploaded.len(), self.renderer.multisampled()
        )
    }
}
