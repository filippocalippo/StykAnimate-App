//! Engine types for core logic. Views must never name this module: they receive plain view models.
pub use styk_doc::Value;
pub use styk_edit::session::{NativeCall as CallAnswer, SessionView as DocumentView};
pub use styk_edit::{EditError, Selection};
pub use styk_engine::document::OpenError;
pub use styk_doc::json;
pub use styk_engine::{Budgets, Engine};
pub use styk_eval::doc::Document as TypedDocument;
pub use styk_engine::frame_builder::{Onion, Options as SceneOptions};
#[cfg(not(target_arch = "wasm32"))]
pub use styk_alloc::Counting;
pub use styk_alloc::set_limit as set_memory_limit;
