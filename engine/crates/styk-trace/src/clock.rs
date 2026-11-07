//! The host installs a shared clock before starting workers. Readers never initialize or wait.
use std::{
    cell::RefCell,
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, OnceLock},
};
use styk_services::clock::Clock;
static CLOCK: OnceLock<Arc<dyn Clock>> = OnceLock::new();
static MISSING: AtomicU64 = AtomicU64::new(0);
thread_local! { static LOCAL: RefCell<Option<Arc<dyn Clock>>> = const { RefCell::new(None) }; }
pub fn install(clock: Arc<dyn Clock>) -> Result<(), Arc<dyn Clock>> {
    CLOCK.set(clock)
}
pub fn missing_reads() -> u64 {
    MISSING.load(Ordering::Relaxed)
}
pub struct Scope(
    Option<Arc<dyn Clock>>,
    std::marker::PhantomData<std::rc::Rc<()>>,
);
impl Drop for Scope {
    fn drop(&mut self) {
        LOCAL.with(|slot| *slot.borrow_mut() = self.0.take());
    }
}
/// Override only this worker, restoring the previous clock when its task ends.
pub fn scoped(clock: Arc<dyn Clock>) -> Scope {
    Scope(
        LOCAL.with(|slot| slot.replace(Some(clock))),
        std::marker::PhantomData,
    )
}
pub fn now_ns() -> u64 {
    LOCAL.with(|slot| {
        let local = slot.borrow();
        match local.as_ref().or_else(|| CLOCK.get()) {
            Some(clock) => clock.now().as_nanos().min(u64::MAX as u128) as u64,
            None => {
                MISSING.fetch_add(1, Ordering::Relaxed);
                0
            }
        }
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn injected_time_is_exact_and_scopes_restore() {
        let clock = styk_services::clock::FixedClock::new();
        let _scope = scoped(Arc::new(clock.clone()));
        assert_eq!(now_ns(), 0);
        clock.advance(std::time::Duration::from_secs(10));
        assert_eq!(now_ns(), 10_000_000_000);
        {
            let _other = scoped(Arc::new(styk_services::clock::FixedClock::new()));
            assert_eq!(now_ns(), 0);
        }
        assert_eq!(now_ns(), 10_000_000_000);
    }
}
