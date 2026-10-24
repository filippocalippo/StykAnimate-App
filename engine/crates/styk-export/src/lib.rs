//! Export frames: the pixels an export of a StykAnimate document encodes.
//!
//! The engine draws an export frame as it draws the stage: the same draw list (the
//! document evaluated at a tick, or the pose the editor shows, without onion skins), the
//! same GPU renderer, seen through the scene camera at the output's size. What an export
//! adds is here:
//!
//! - [`settings`]: the output size and Pivot's sampling choices, with the interface's limits.
//! - [`tiles`]: equal tiles of at most [`tiles::TILE_SIDE`] pixels, so GPU memory does not
//!   grow with the output.
//! - [`view`]: the canvas scaled to the output through the scene camera, for one tile.
//! - [`pixels`]: premultiplied pixels to straight RGBA, 2×2 averages for Smooth sprites,
//!   black matte for video without transparency.
//! - [`gpu`]: the renderer driven tile by tile, with read-back.
//! - [`cpu`]: the same tiles drawn by the CPU rasterizer (styk-raster), for a worker
//!   without a GPU device.
//! - [`svg`]: the frame's draw list written as vector SVG (the export that is not pixels).
//!
//! Encoders (PNG, GIF, APNG, ZIP, WebCodecs, FFmpeg) stay platform services of the
//! interface; see `docs/engine/rendering.md` (Exports) and `docs/export-sampling.md`.

pub mod cpu;
pub mod gpu;
pub mod pixels;
pub mod settings;
pub mod svg;
pub mod tiles;
pub mod view;

pub use cpu::CpuExport;
pub use gpu::GpuExport;
pub use settings::{Settings, Smoothing};
pub use tiles::{Tile, TILE_SIDE};
