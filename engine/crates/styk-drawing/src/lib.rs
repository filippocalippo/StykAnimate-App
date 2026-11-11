//! The raster drawing engine (docs/DRAWING.md, docs/engine/drawing.md): what the
//! JavaScript drawing workspace runs off the interface thread, ported from its modules
//! with their arithmetic, so that the same input produces the same pixels.
//!
//! | Module | JavaScript |
//! | --- | --- |
//! | [`tiles`] | `drawing-tiles.mjs`, undo records of `drawing-pixels.mjs` |
//! | [`brush`] | `drawing-brush.mjs`, `drawing-smoother.mjs` |
//! | [`textures`] | `drawing-brush-textures.mjs` |
//! | [`stroke`] | `DrawingStroke` (`drawing-pixels.mjs`), `drawing-stroke-engine.mjs` |
//! | [`region`] | `drawing-stroke-region.mjs` |
//! | [`mask`] | selections and the magic wand (`drawing-pixels.mjs`, `drawing-lasso.mjs`) |
//! | [`fill`] | `drawing-fill.mjs` |
//! | [`filters`] | `filterTiles` (`drawing-pixels.mjs`) |
//! | [`lasso`] | selection capture (`drawing-lasso.mjs`) |
//! | [`transform`] | `drawing-transform.mjs`, `transformSelectedPixels` (`drawing-selection.mjs`) |
//! | [`levels`] | reduced levels (`drawing-raster.mjs`) |
//! | [`zlib`], [`png`] | `zlib-sync.mjs`, `drawing-png.mjs` |
//! | [`codec`] | `drawing-tile-codec.mjs` |
//! | [`history`] | `drawing-history-codec.mjs` |
//! | [`prepare`] | `materializeDrawingTiles` (`drawing-preparation.mjs`) |
//! | [`clipboard`] | `drawing-clipboard.mjs` (the worker side) |
//!
//! No clock, threads or I/O: callers (the WebAssembly module the drawing workers load,
//! native tools and tests) bring their own.

// The modules follow the JavaScript loop for loop and index for index, so that the order
// of every floating-point operation stays recognizably the oracle's; these lints would
// rewrite that shape.
#![allow(
    clippy::needless_range_loop,
    clippy::collapsible_if,
    clippy::type_complexity,
    clippy::manual_is_multiple_of,
    clippy::same_item_push,
    clippy::chunks_exact_to_as_chunks
)]

pub mod brush;
pub mod clipboard;
pub mod codec;
pub mod error;
pub mod fill;
pub mod filters;
pub mod history;
pub mod js;
pub mod lasso;
pub mod levels;
pub mod mask;
pub mod png;
pub mod prepare;
pub mod region;
pub mod stroke;
pub mod textures;
pub mod tiles;
pub mod transform;
pub mod zlib;

pub use error::{DrawingError, Result};
pub use tiles::{Rect, TileChange, TileStore, TILE, TILE_BYTES};
