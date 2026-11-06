//! Where a session call spends its time, natively (`STYK_EDIT_PROFILE=1`): scoped timers
//! summed by name, printed by `styk edit-session`. Free when the variable is unset; absent
//! from WebAssembly builds.

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::time::Instant;

    thread_local! {
        static ENABLED: bool = std::env::var_os("STYK_EDIT_PROFILE").is_some();
        static TOTALS: RefCell<HashMap<&'static str, (u64, f64)>> = RefCell::new(HashMap::new());
    }

    pub struct Scope(Option<(&'static str, Instant)>);

    impl Drop for Scope {
        fn drop(&mut self) {
            if let Some((name, started)) = self.0.take() {
                let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                TOTALS.with(|totals| { let mut totals = totals.borrow_mut(); let entry = totals.entry(name).or_default(); entry.0 += 1; entry.1 += elapsed; });
            }
        }
    }

    pub fn scope(name: &'static str) -> Scope {
        Scope(ENABLED.with(|on| *on).then(|| (name, Instant::now())))
    }

    /// The totals so far, slowest first, and clears them.
    pub fn take() -> Vec<(&'static str, u64, f64)> {
        TOTALS.with(|totals| {
            let mut all: Vec<_> = totals.borrow_mut().drain().map(|(name, (count, ms))| (name, count, ms)).collect();
            all.sort_by(|a, b| b.2.total_cmp(&a.2));
            all
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::{scope, take};

#[cfg(target_arch = "wasm32")]
pub fn scope(_name: &'static str) {}

#[cfg(target_arch = "wasm32")]
pub fn take() -> Vec<(&'static str, u64, f64)> { Vec::new() }
