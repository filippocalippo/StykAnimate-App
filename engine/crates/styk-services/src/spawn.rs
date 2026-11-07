//! Starting named background tasks, as a service.
//!
//! Portable code never calls `std::thread::spawn`: a browser build has no such call, and its workers start asynchronously and can
//! fail (`docs/native/web.md`, constraint 2). It asks a [`Spawner`] for a named task that runs a closure. The platform implements
//! it with a thread (`styk-platform`); a test uses [`ManualSpawner`], which holds the jobs until the test runs them. The drawing
//! worker starts through it, and so will the frame worker pool.

use std::collections::VecDeque;
use std::sync::Mutex;

/// What a task runs, once.
pub type Job = Box<dyn FnOnce() + Send + 'static>;

/// A task that could not be started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnError(pub String);

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "a background task could not be started: {}", self.0)
    }
}

impl std::error::Error for SpawnError {}

/// Starts background tasks. Starting can fail, and the task may begin running some time after the call returns.
pub trait Spawner: Send + Sync {
    /// Runs `job` as a task called `name` (shown in profilers and debuggers), on a thread or worker of its own that ends with it.
    fn spawn(&self, name: &str, job: Job) -> Result<(), SpawnError>;
}

/// A spawner that keeps the jobs it is given until a test runs them, one at a time, on the thread that asks.
#[derive(Default)]
pub struct ManualSpawner {
    jobs: Mutex<VecDeque<(String, Job)>>,
}

impl ManualSpawner {
    pub fn new() -> ManualSpawner {
        ManualSpawner::default()
    }

    /// Jobs started and not yet run.
    pub fn waiting(&self) -> usize {
        self.jobs.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    /// The names of the jobs started and not yet run, oldest first.
    pub fn names(&self) -> Vec<String> {
        self.jobs.lock().unwrap_or_else(|p| p.into_inner()).iter().map(|(name, _)| name.clone()).collect()
    }

    /// Runs the oldest waiting job to its end; false if none was waiting.
    pub fn run_next(&self) -> bool {
        let job = self.jobs.lock().unwrap_or_else(|p| p.into_inner()).pop_front();
        match job {
            Some((_, job)) => {
                job();
                true
            }
            None => false,
        }
    }
}

impl Spawner for ManualSpawner {
    fn spawn(&self, name: &str, job: Job) -> Result<(), SpawnError> {
        self.jobs.lock().unwrap_or_else(|p| p.into_inner()).push_back((name.to_string(), job));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn a_manual_spawner_runs_its_jobs_only_when_asked_and_in_order() {
        let spawner = ManualSpawner::new();
        let ran = Arc::new(AtomicUsize::new(0));
        for name in ["first", "second"] {
            let ran = ran.clone();
            spawner.spawn(name, Box::new(move || { ran.fetch_add(1, Ordering::SeqCst); })).unwrap();
        }
        assert_eq!((spawner.waiting(), ran.load(Ordering::SeqCst)), (2, 0));
        assert_eq!(spawner.names(), ["first", "second"]);
        assert!(spawner.run_next());
        assert_eq!((spawner.waiting(), ran.load(Ordering::SeqCst)), (1, 1));
        assert!(spawner.run_next() && !spawner.run_next());
        assert_eq!(ran.load(Ordering::SeqCst), 2);
    }
}
