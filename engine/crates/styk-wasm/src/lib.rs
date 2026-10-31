//! The engine's WebAssembly boundary.
//!
//! Everything JavaScript can call is declared in this crate and nowhere else;
//! `src/engine/` is its only caller on the JavaScript side.
//!
//! - [`engine::EngineHandle`]: the document and background preparation. One per
//!   page, shared with the worker threads by address.
//! - [`stage::Stage`]: the GPU surface of one canvas, and the other views its device draws
//!   (`views`: the camera monitor, frame thumbnails). Interface thread only.
//! - [`open::OpenedDocument`]: a document opened on the engine's workers, read back in bounded pieces.
//! - [`edit::EditSession`]: the editor's calls run on the open document, which the engine publishes as it
//!   changes. Interface thread only.
//! - [`document_export::export_document`]: the document of a Pivot or figure export, made on a worker that joined the engine.
//! - [`export::ExportRenderer`]: export frames, drawn in a worker with a GPU device of its own,
//!   or by the CPU rasterizer where it has none.
//! - [`preview::Previews`]: library previews (the worker's GPU device, else the CPU) and the
//!   frame thumbnails the stage cannot draw (the CPU), in a worker.
//!
//! The module is instantiated once per thread over one shared memory. Workers
//! call [`engine::worker_run`] and stay inside it.

pub mod document_export;
pub mod edit;
pub mod engine;
pub mod export;
pub mod math;
pub mod open;
pub mod preview;
pub mod stage;
pub mod views;

use wasm_bindgen::prelude::*;

/// Memory grows ahead in large steps: a host `memory.grow` costs about a millisecond whatever its size (`styk-alloc`).
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOCATOR: styk_alloc::GrowAhead = styk_alloc::GrowAhead;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(message: &str);
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

pub(crate) fn clock() -> f64 {
    performance_now()
}

/// Runs once per instance (the interface thread and every worker): engine panics
/// reach the console with their message and location before the module aborts.
#[wasm_bindgen(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| console_error(&format!("StykAnimate engine panic: {info}"))));
}

/// Version of the command/query API. The JavaScript loader refuses a module
/// whose number differs from the one it was written for.
#[wasm_bindgen]
pub fn api_version() -> u32 {
    1
}

pub(crate) fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}
