//! Running the independent pieces of a job side by side on the engine's workers, with the calling thread taking part.
//!
//! A save hashes and compresses three blocks of up to a hundred megabytes each; those are four jobs (the three hashes and the frames in
//! turn) that need nothing from one another. They go to the workers that are free as ordinary tasks ([`Engine::spawn`]), and the calling
//! thread claims whatever no worker has started, so a host without workers (the tools, the tests, a page that is not cross-origin
//! isolated) runs them all itself, one after another, and nothing waits for a worker that never comes. The caller returns when every job
//! is done, or when one cannot be: a job that panicked, or a worker of the engine that stopped.
//!
//! A job owns everything it touches (`'static`): a worker may still be running one when the caller has returned, because the caller
//! failed, was stopped, or lost its thread (WebAssembly aborts on a panic, and the thread's stack is given back with the save worker),
//! and nothing the worker reads or writes may be freed meanwhile. Borrowing from the caller's frame, as an earlier version did through
//! an erased lifetime, made exactly that a write into freed memory.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use styk_formats::files::{Job, JobsFailed};

use crate::Engine;

/// How often a thread waiting for a worker's job asks whether the work is stopped and whether a worker is lost.
const POLL: Duration = Duration::from_millis(25);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Progress {
    Waiting,
    Running,
    Done,
    Panicked,
}

/// One job: taken by whoever starts it first, and done when it has run.
struct Slot {
    job: Mutex<Option<Job>>,
    progress: Mutex<Progress>,
    changed: Condvar,
}

impl Slot {
    fn new(job: Job) -> Slot {
        Slot { job: Mutex::new(Some(job)), progress: Mutex::new(Progress::Waiting), changed: Condvar::new() }
    }

    fn set(&self, progress: Progress) {
        *self.progress.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = progress;
        self.changed.notify_all();
    }

    /// Runs the job unless a thread has taken it already. `ask` is the stop question that suits the running thread. A panic is
    /// caught and recorded (where panics unwind), so that whoever waits for the job does not wait for ever.
    fn run(&self, ask: &dyn Fn() -> bool) {
        let job = self.job.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(job) = job {
            self.set(Progress::Running);
            let finished = catch_unwind(AssertUnwindSafe(|| job(ask)));
            self.set(if finished.is_ok() { Progress::Done } else { Progress::Panicked });
        }
    }

    /// Waits for the job to be done, calling `poll` every [`POLL`] while it is not (it says whether the wait must end).
    fn wait(&self, poll: &dyn Fn() -> Option<JobsFailed>) -> Result<(), JobsFailed> {
        loop {
            let progress = self.progress.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match *progress {
                Progress::Done => return Ok(()),
                Progress::Panicked => return Err(JobsFailed::Panicked),
                Progress::Waiting | Progress::Running => {}
            }
            let (progress, _) = self.changed.wait_timeout(progress, POLL).unwrap_or_else(|poisoned| poisoned.into_inner());
            let now = *progress;
            drop(progress);
            match now {
                Progress::Done => return Ok(()),
                Progress::Panicked => return Err(JobsFailed::Panicked),
                _ => {}
            }
            if let Some(failure) = poll() {
                return Err(failure);
            }
        }
    }
}

impl Engine {
    /// Starts `job` on a worker that is free, to run beside what the caller does next, and returns what waits for it: it runs the job
    /// itself if no worker took it, and ends like [`Engine::run_together`] when the job panicked or a worker was lost meanwhile. The job
    /// owns what it touches, so a caller that never waits for it (it failed first) leaves nothing dangling.
    pub fn start_later<'a>(&'a self, job: Job, stop: &Arc<AtomicBool>, cancelled: &'a dyn Fn() -> bool) -> impl FnOnce() -> Result<(), JobsFailed> + 'a {
        let lost_before = self.workers_lost();
        let slot = Arc::new(Slot::new(job));
        {
            let (slot, stop) = (slot.clone(), stop.clone());
            self.spawn(move |_| slot.run(&|| stop.load(Ordering::Relaxed)));
        }
        let stop = stop.clone();
        move || {
            let ask_here = || {
                if !stop.load(Ordering::Relaxed) && cancelled() {
                    stop.store(true, Ordering::Relaxed);
                }
                stop.load(Ordering::Relaxed)
            };
            slot.run(&ask_here);
            slot.wait(&|| {
                ask_here();
                (self.workers_lost() != lost_before).then_some(JobsFailed::WorkerLost)
            })
        }
    }

    /// Runs `jobs` side by side and returns when all are done. At most `helpers` workers take part (the others stay free for the frame on
    /// show, which waits behind a task); each takes the next job nobody has started, in the order given, until none is left. This thread
    /// does the same and, while it waits for a worker's job, asks `cancelled` and sets `stop` for the jobs on workers to see (they
    /// cannot call the host's own question).
    ///
    /// It returns an error, with the file and the document untouched by it, when a job panicked ([`JobsFailed::Panicked`]) or when a
    /// worker of the engine stopped while this waited ([`JobsFailed::WorkerLost`]: [`Engine::note_worker_lost`], which the host calls
    /// when a thread traps): the job that worker had may never finish. The jobs left running only touch what they own.
    pub fn run_together(&self, jobs: Vec<Job>, stop: &Arc<AtomicBool>, cancelled: &dyn Fn() -> bool, helpers: usize) -> Result<(), JobsFailed> {
        let ask_here = || {
            if !stop.load(Ordering::Relaxed) && cancelled() {
                stop.store(true, Ordering::Relaxed);
            }
            stop.load(Ordering::Relaxed)
        };
        let lost_before = self.workers_lost();
        let slots: Arc<Vec<Slot>> = Arc::new(jobs.into_iter().map(Slot::new).collect());
        for _ in 0..helpers.min(slots.len().saturating_sub(1)) {
            let (slots, stop) = (slots.clone(), stop.clone());
            self.spawn(move |_| {
                for slot in slots.iter() {
                    slot.run(&|| stop.load(Ordering::Relaxed));
                }
            });
        }
        for slot in slots.iter() {
            slot.run(&ask_here);
            let progress = *slot.progress.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if progress == Progress::Panicked {
                stop.store(true, Ordering::Relaxed);
                return Err(JobsFailed::Panicked);
            }
        }
        for slot in slots.iter() {
            let failure = slot.wait(&|| {
                ask_here();
                (self.workers_lost() != lost_before).then_some(JobsFailed::WorkerLost)
            });
            if let Err(failure) = failure {
                // Whatever still runs is told to end; it owns what it touches.
                stop.store(true, Ordering::Relaxed);
                return Err(failure);
            }
        }
        Ok(())
    }
}
