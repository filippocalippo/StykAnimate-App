//! Parallel maps inside one frame.
//!
//! Native builds spread large maps over rayon's pool. The WebAssembly build runs
//! them in order: its parallelism is whole frames on the engine's worker threads,
//! and rayon would block the calling thread, which a browser's interface thread
//! may never do.

/// `items.iter().map(f)`, in parallel when `items` is at least `threshold` long.
#[cfg(not(target_arch = "wasm32"))]
pub fn map<T: Sync, R: Send>(items: &[T], threshold: usize, f: impl Fn(&T) -> R + Sync + Send) -> Vec<R> {
    use rayon::prelude::*;
    if items.len() >= threshold { items.par_iter().map(f).collect() } else { items.iter().map(f).collect() }
}

/// `items.iter().map(f)`.
#[cfg(target_arch = "wasm32")]
pub fn map<T: Sync, R: Send>(items: &[T], _threshold: usize, f: impl Fn(&T) -> R + Sync + Send) -> Vec<R> {
    items.iter().map(f).collect()
}
