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
    Gpu(GpuExport),
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
        match self {
            Self::Gpu(gpu) => { gpu.prepare_sprites(generation.lineage, &generation.assets); }
            Self::Cpu(cpu) => cpu.use_assets(generation.assets.clone()),
        }
        frames.decode_images();
        let mut count = 0;
        loop {
            let images = frames.take_images(crate::resident::UPLOAD_BYTES);
            count += images.len();
            if !images.is_empty() {
                match self {
                    Self::Gpu(gpu) => {
                        gpu.upload_images(&generation.assets, images.iter().map(|image| &**image));
                        // A write_texture also owns a staging copy. Bound that
                        // lifetime along with the decoded batch, before taking more.
                        gpu.queue().submit([]);
                        gpu.device().poll(styk_render::wgpu::PollType::wait_indefinitely()).map_err(|e| e.to_string())?;
                    }
                    Self::Cpu(cpu) => cpu.upload_images(&generation.assets, images.iter().cloned()),
                }
            }
            drop(images);
            if frames.images_pending() == 0 { return Ok(count); }
            if !engine.step() { return Err("export pictures are pending without runnable decoding work".into()); }
        }
    }

    /// A handle that ends the frame in progress and every later one, from any thread (wire it to the job's cancel).
    pub fn interrupt(&self) -> crate::Interrupt {
        match self {
            FrameRenderer::Gpu(gpu) => gpu.interrupt(),
            FrameRenderer::Cpu(cpu) => cpu.interrupt(),
        }
    }

    /// Draws a frame into `out` (cleared and filled with RGBA of the output size): straight, or over black with
    /// `matte`. `list` must be the draw list of the frame to draw; nothing is allocated per frame.
    pub fn frame_into(&mut self, doc: &Document, list: &Arc<DrawList>, camera: Option<&Camera>, matte: bool, out: &mut Vec<u8>) -> Result<(), String> {
        match self {
            FrameRenderer::Gpu(gpu) => gpu.frame_into(doc, list, camera, matte, out),
            FrameRenderer::Cpu(cpu) => cpu.frame_into(doc, list, camera, matte, out),
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            FrameRenderer::Gpu(_) => "GPU",
            FrameRenderer::Cpu(_) => "CPU (styk-raster)",
        }
    }
}
