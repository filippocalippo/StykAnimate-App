//! Running the independent pieces of a job side by side on the engine's workers, with the calling thread taking part.
//!
//! A save hashes and compresses three blocks of up to a hundred megabytes each; those are four jobs (the three hashes and the frames in turn) that need nothing from one
//! another. They go to the workers that are free as ordinary tasks ([`Engine::spawn`]), and the calling thread claims whatever no
//! worker has started, so a host without workers (the tools, the tests, a page that is not cross-origin isolated) runs them all
//! itself, one after another, and nothing waits for a worker that never comes. The caller returns when every job is done.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use styk_formats::files::Job;

use crate::Engine;

/// How often a thread waiting for a worker's job asks whether the work is stopped.
const POLL: Duration = Duration::from_millis(25);

type Erased = Box<dyn FnOnce(&dyn Fn() -> bool) + Send + 'static>;

/// One job: taken by whoever starts it first, and done when it has run.
struct Slot {
    job: Mutex<Option<Erased>>,
    done: Mutex<bool>,
    finished: Condvar,
}

impl Slot {
    fn new(job: Erased) -> Slot {
        Slot { job: Mutex::new(Some(job)), done: Mutex::new(false), finished: Condvar::new() }
    }

    /// Runs the job unless a thread has taken it already. `ask` is the stop question that suits the running thread.
    fn run(&self, ask: &dyn Fn() -> bool) {
        let job = self.job.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(job) = job {
            job(ask);
            *self.done.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
            self.finished.notify_all();
        }
    }

    /// Waits for the job to be done, calling `poll` every [`POLL`] while it is not.
    fn wait(&self, poll: &dyn Fn()) {
        loop {
            let done = self.done.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if *done {
                return;
            }
            let (done, _) = self.finished.wait_timeout(done, POLL).unwrap_or_else(|poisoned| poisoned.into_inner());
            let finished = *done;
            drop(done);
            if finished {
                return;
            }
            poll();
        }
    }
}

impl Engine {
    /// Runs `jobs` side by side and returns when all are done. At most `helpers` workers take part (the others stay free for the frame on
    /// show, which waits behind a task); each takes the next job nobody has started, in the order given, until none is left. This thread
    /// does the same and, while it waits for a worker's job, asks `cancelled` and sets `stop` for the jobs on workers to see (they
    /// cannot call the host's own question).
    pub fn run_together<'a>(&self, jobs: Vec<Job<'a>>, stop: &Arc<AtomicBool>, cancelled: &dyn Fn() -> bool, helpers: usize) {
        let ask_here = || {
            if !stop.load(Ordering::Relaxed) && cancelled() {
                stop.store(true, Ordering::Relaxed);
            }
            stop.load(Ordering::Relaxed)
        };
        let slots: Arc<Vec<Slot>> = Arc::new(jobs
            .into_iter()
            .map(|job| {
                // SAFETY: the job borrows from the caller's frame, and this function returns only when every slot is done, and a slot
                // is done only once its job has run to its end; no thread can start a job after `take` has emptied the slot.
                let job: Erased = unsafe { std::mem::transmute::<Job<'a>, Erased>(job) };
                Slot::new(job)
            })
            .collect());
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
        }
        for slot in slots.iter() {
            slot.wait(&|| {
                ask_here();
            });
        }
    }
}
