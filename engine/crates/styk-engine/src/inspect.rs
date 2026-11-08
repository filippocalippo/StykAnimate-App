//! One-shot scalar scheduler snapshot. Contention returns Busy, never waits.
use crate::{Engine, FrameStats};
#[derive(Clone, Copy)]
pub struct SchedulerStats {
    pub queued: usize,
    pub idle: usize,
    pub retiring: usize,
    pub revision: Option<u64>,
    pub frames: FrameStats,
    pub pictures_refused: usize,
}
impl Engine {
    pub fn inspect_stats(&self) -> Option<SchedulerStats> {
        let state = self.inner.state.try_lock()?;
        Some(SchedulerStats {
            queued: state.tasks.len(),
            idle: state.idle_tasks.len(),
            retiring: state.retained_tasks.len(),
            revision: state.current.as_ref().map(|g| g.revision),
            frames: state.frames.inspection_stats(),
            pictures_refused: self.pictures_refused(),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_busy_scheduler_does_not_block_inspection() {
        let engine = Engine::new(|| 0., crate::Budgets::for_device(None));
        let guard = engine.inner.state.lock();
        assert!(engine.inspect_stats().is_none());
        drop(guard);
        let snapshot = engine.inspect_stats().unwrap();
        assert_eq!(snapshot.queued, 0);
        assert_eq!(snapshot.revision, None);
    }
}
