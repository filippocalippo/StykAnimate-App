//! StykAnimate engine core: file formats, the document model, frame
//! evaluation and world-space geometry. No UI and no GPU code lives here, so the
//! same crate serves desktop, mobile and WebAssembly front ends.

pub mod assets;
pub mod camera;
pub mod container;
pub mod doc;
pub mod drawing;
pub mod drawlist;
pub mod edit;
pub mod eval;
pub mod geometry;
pub mod load;
pub mod piv;
pub mod rig;
pub mod sticknodes;
pub mod style;
pub mod text;
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

/// Opens any supported file by extension: `.piv`, `.styk`, `.stkz`, `.stykmov`.
pub fn open(path: &Path) -> Result<Document, Error> {
    let bytes = std::fs::read(path)?;
    let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled").to_string();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    open_bytes(&bytes, &ext, &name)
}

pub fn open_bytes(bytes: &[u8], ext: &str, name: &str) -> Result<Document, Error> {
    match ext {
        "piv" => piv::decode(bytes, name),
        "styk" | "stkz" | "stykmov" | "json" => {
            let timing = std::env::var_os("STYK_TIMING").is_some();
            let t0 = std::time::Instant::now();
            let container = container::decode(bytes, if ext == "json" { "styk" } else { ext })?;
            if timing {
                eprintln!("  container decode {:.1} ms", t0.elapsed().as_secs_f64() * 1000.0);
            }
            let t0 = std::time::Instant::now();
            let mut loader = load::Loader::new(container::Resolver::new(&container.sections));
            let mut doc = loader.document(&container.json, name)?;
            if timing {
                eprintln!("  typed document {:.1} ms", t0.elapsed().as_secs_f64() * 1000.0);
            }
            doc.images = std::mem::take(&mut loader.images);
            doc.unsupported = loader.unsupported;
            for fig in &doc.figures {
                for f in &fig.unsupported {
                    if !doc.unsupported.iter().any(|u| u == f) {
                        doc.unsupported.push(f.to_string());
                    }
                }
            }
            if doc.name.is_empty() {
                doc.name = name.to_string();
            }
            Ok(doc)
        }
        other => Err(Error::Unsupported(format!("Unsupported file type .{other}"))),
    }
}

/// Convenience: an evaluation-ready document.
pub fn prepare(doc: Document) -> eval::Prepared {
    eval::Prepared::new(Arc::new(doc))
}
