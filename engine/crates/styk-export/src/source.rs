//! The frame source of a video export: one renderer, GPU or CPU, drawing frame after frame into buffers the caller owns.
//!
//! The export draws on its own device, never on the interface's, so a read-back wait never waits for the interface's
//! frames and the interface never waits for it. Where no adapter exists (or the device is lost) the CPU rasterizer
//! draws the same draw lists.

use std::sync::Arc;

use styk_draw::DrawList;
use styk_eval::doc::{Camera, Document};

use crate::{CpuExport, GpuExport};

pub enum FrameRenderer {
    Gpu(GpuExport, Option<crate::resident::Resident>),
    Cpu(CpuExport),
}

impl FrameRenderer {
    /// Uploads a headless engine's export pictures in bounded batches. Pixels
    /// leave the decode queue as soon as they have been copied to their owner;
    /// the CPU renderer deliberately retains its source pixels.
    ///
    /// Call on a dedicated export thread, with no other thread stepping this
    /// engine. A pending decode without runnable work is an error, not success.
    pub fn load_images(&mut self, engine: &styk_engine::Engine, frames: &styk_engine::export::ExportFrames) -> Result<usize, String> {
        let generation = frames.generation();
        if let Self::Gpu(gpu, resident) = self
            && generation.assets.pages > 2
        {
            // Begin with two pages, retaining the union of adjacent complete
            // frames when it needs more. No visible page is lost to this budget.
            *resident = Some(crate::resident::Resident::begin_native(gpu, frames));
            while frames.images_left() != 0 {
                if !engine.step() { return Err("export cel bounds are pending without runnable decoding work".into()); }
            }
            return Ok(0);
        }
        match self {
            Self::Gpu(gpu, _) => { gpu.prepare_sprites(generation.lineage, &generation.assets); }
            Self::Cpu(cpu) => cpu.use_assets(generation.assets.clone()),
        }
        frames.decode_images();
        let mut count = 0;
        loop {
            let images = frames.take_images(crate::resident::UPLOAD_BYTES);
            count += images.len();
            let progressed = !images.is_empty();
            if progressed {
                match self {
                    Self::Gpu(gpu, _) => {
                        gpu.upload_images(&generation.assets, images.iter().map(|image| &**image));
                        // A write_texture also owns a staging copy. Bound that
                        // lifetime along with the decoded batch, before taking more.
                        gpu.flush_uploads()?;
                    }
                    Self::Cpu(cpu) => cpu.upload_images(&generation.assets, images.iter().cloned()),
                }
            }
            drop(images);
            if frames.images_pending() == 0 { return Ok(count); }
            // One cel can leave several ready batches after its final decoder
            // finishes. Draining a batch is progress even without another task.
            if !engine.step() && !progressed { return Err("export pictures are pending without runnable decoding work".into()); }
        }
    }

    /// Completes the current frame's picture working set on the export worker.
    /// It uses the same residency/refusal protocol as the browser exporter.
    /// No frame is rendered until all its pictures and cel tiles have landed.
    pub fn prepare_frame(&mut self, engine: &styk_engine::Engine, frames: &styk_engine::export::ExportFrames, list: &DrawList) -> Result<(), String> {
        if let Self::Gpu(gpu, Some(resident)) = self {
            loop {
                if gpu.interrupt().is_interrupted() { return Err(crate::interrupt::INTERRUPTED.into()); }
                if resident.ready(gpu, frames, list, None, 0) { break; }
                gpu.flush_uploads()?;
                if !engine.step() && frames.pictures_in_flight() == 0 {
                    return Err("export pictures are missing without runnable decoding work".into());
                }
            }
        }
        Ok(())
    }

    /// A handle that ends the frame in progress and every later one, from any thread (wire it to the job's cancel).
    pub fn interrupt(&self) -> crate::Interrupt {
        match self {
            FrameRenderer::Gpu(gpu, _) => gpu.interrupt(),
            FrameRenderer::Cpu(cpu) => cpu.interrupt(),
        }
    }

    /// Draws a frame into `out` (cleared and filled with RGBA of the output size): straight, or over black with
    /// `matte`. `list` must be the draw list of the frame to draw; nothing is allocated per frame.
    pub fn frame_into(&mut self, doc: &Document, list: &Arc<DrawList>, camera: Option<&Camera>, matte: bool, out: &mut Vec<u8>) -> Result<(), String> {
        match self {
            FrameRenderer::Gpu(gpu, _) => gpu.frame_into(doc, list, camera, matte, out),
            FrameRenderer::Cpu(cpu) => cpu.frame_into(doc, list, camera, matte, out),
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            FrameRenderer::Gpu(..) => "GPU",
            FrameRenderer::Cpu(_) => "CPU (styk-raster)",
        }
    }
}
