//! StykAnimate engine core: file formats, the document model, frame
//! evaluation and world-space geometry. No UI and no GPU code lives here, so the
//! same crate serves desktop, mobile and WebAssembly front ends.

pub mod assets;
pub mod camera;
pub mod channels;
pub mod doc;
pub mod drawing;
pub mod drawlist;
pub mod edit;
pub mod eval;
pub mod follow;
pub mod geometry;
pub mod ik;
pub mod live;
pub mod load;
pub mod materialize;
pub mod onion;
pub mod origin;
pub mod par;
pub mod parallax;
pub mod parity;
pub mod picking;
pub mod records;
pub mod rig;
pub mod spatial;
pub mod sticknodes;
pub mod style;
pub mod text;
pub mod vfx;
pub mod view;

use std::path::Path;
use std::sync::Arc;

pub use doc::Document;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Format(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// Opens any supported file by extension: `.piv`, `.stk`, `.styk`, `.stkz`, `.stykmov`, `.json`.
pub fn open(path: &Path) -> Result<Document, Error> {
    let bytes = std::fs::read(path)?;
    let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled").to_string();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    open_bytes(&bytes, &ext, &name)
}

pub fn open_bytes(bytes: &[u8], ext: &str, name: &str) -> Result<Document, Error> {
    match ext {
        // Pivot files decode exactly as the editor imports them (the Rust codec, styk-piv).
        "piv" | "stk" => {
            let decoded = styk_piv::decode_document(bytes, &format!("{name}.{ext}"), &|| false).map_err(|e| Error::Format(e.to_string()))?;
            from_value(&decoded.document, name)
        }
        "styk" | "stkz" | "stykmov" | "json" => {
            let kind = styk_formats::Kind::from_extension(ext).expect("matched above");
            let decoded = styk_formats::container::decode(bytes, kind).map_err(|e| Error::Format(e.to_string()))?;
            let document = styk_formats::native::normalize_decoded(decoded.document, kind).map_err(|e| Error::Format(e.to_string()))?;
            let document = from_value(&document, name)?;
            if document.keyframes.is_empty() {
                return Err(Error::Format("The scene has no keyframes".into()));
            }
            Ok(document)
        }
        other => Err(Error::Unsupported(format!("Unsupported file type .{other}"))),
    }
}

/// Convenience: an evaluation-ready document.
pub fn prepare(doc: Document) -> eval::Prepared {
    eval::Prepared::new(Arc::new(doc))
}

/// Builds the typed views of a document tree once. A document that will change
/// keeps a [`load::Loader`] instead, which converts only what each change replaced.
pub fn from_value(document: &styk_doc::Value, name: &str) -> Result<Document, Error> {
    load::Loader::new().document(document, name)
}

/// A one-line-per-object description of an evaluated tick, for comparing builds of
/// the engine with each other (native against WebAssembly).
pub fn describe_tick(prepared: &eval::Prepared, tick: u32) -> String {
    let frame = prepared.evaluate(tick as f64);
    let scene = geometry::build(&prepared.doc, &frame);
    let mut out = format!("tick {tick}: {} objects, {} items, {} points, {} chains\n", frame.objects.len(), scene.items.len(), scene.points.len(), scene.chains.len());
    for (slot, object) in frame.objects.iter().enumerate() {
        let items = scene.items.iter().filter(|item| item.slot as usize == slot).count();
        out.push_str(&format!("  {slot}: uid {} figure {} clip {:?} items {items} root [{:.3}, {:.3}]\n", object.uid, object.figure, object.clip_time, object.root[0], object.root[1]));
    }
    out
}
