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
