//! Running the independent pieces of one job side by side.
//!
//! Opening a document reads, checks and converts tens of thousands of records that need nothing from one another. The engine
//! has worker threads for that (`styk_engine::Engine::run_together`), but the crates that do the reading know nothing of
//! them: they are given a [`Fanout`] and cut their work into [`Task`]s. A host without threads (the command-line tools, the
//! tests, a page that is not cross-origin isolated) passes [`Sequential`], which runs the tasks in order on the calling
//! thread, so the result never depends on how many threads there were.
//!
//! A task owns everything it touches (`'static`): a worker may still be running one after the caller gave up (the open was
//! cancelled, a worker trapped), and nothing it reads or writes may be freed meanwhile. Documents are copy-on-write trees of
//! `Arc`s, so handing a task a clone of the record it works on costs a pointer copy.

use std::sync::{Arc, Condvar, Mutex};

/// One piece of work, run once on some thread.
pub type Task = Box<dyn FnOnce() + Send + 'static>;

/// Why [`Fanout::run`] did not run every task to its end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Failed;

/// Where tasks run.
pub trait Fanout {
    /// How many pieces of work are worth cutting: the threads that would take part, the calling one included. One means that
    /// everything runs on the calling thread and nothing is gained by cutting.
    fn threads(&self) -> usize;

    /// The least work (records, in the callers' own units) worth a task of its own; smaller jobs run on the calling thread.
    fn grain(&self) -> usize {
        64
    }

    /// Runs every task and returns when all are done; the calling thread takes part. Tasks start in the order given. `Err` when
    /// a task could not finish (it panicked, or the worker that had it stopped); the results of the others are not to be used.
    fn run(&self, tasks: Vec<Task>) -> Result<(), Failed>;

    /// Starts `task` on another thread and returns at once; hands it back when there is no other thread to give it to.
    fn spawn(&self, task: Task) -> Result<(), Task> {
        Err(task)
    }

    /// Whether the work is stopped (an open that was cancelled): readers ask between their steps and end with their own refusal.
    fn cancelled(&self) -> bool {
        false
    }

    /// Notes that the work reached `phase`, for the host to time. Nothing by default.
    fn mark(&self, _phase: &'static str) {}

    /// Whether a thread that was given a task by [`Fanout::spawn`] is known to have stopped before it ended.
    fn lost(&self) -> bool {
        false
    }
}

/// Everything on the calling thread, in order.
pub struct Sequential;

impl Fanout for Sequential {
    fn threads(&self) -> usize {
        1
    }

    fn run(&self, tasks: Vec<Task>) -> Result<(), Failed> {
        for task in tasks {
            task();
        }
        Ok(())
    }
}

enum State<R> {
    Pending,
    Done(R),
    /// The task ended without a result (it panicked, or was dropped unrun).
    Abandoned,
}

struct Cell<R> {
    state: Mutex<State<R>>,
    changed: Condvar,
    /// The work, until some thread takes it: the one it was given to, or the one that waits for it.
    job: Mutex<Option<Task>>,
}

/// A task started with [`start`]: its result, once it has one.
pub struct Started<R> {
    cell: Arc<Cell<R>>,
}

/// Sets the cell's state to abandoned unless the task got as far as its result. It does not keep the cell alive: the cell holds the
/// task, which holds this.
struct Guard<R>(std::sync::Weak<Cell<R>>);

impl<R> Guard<R> {
    fn finish(&self, state: State<R>) {
        if let Some(cell) = self.0.upgrade() {
            *cell.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = state;
            cell.changed.notify_all();
        }
    }
}

impl<R> Drop for Guard<R> {
    fn drop(&mut self) {
        if let Some(cell) = self.0.upgrade() {
            let mut state = cell.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if matches!(*state, State::Pending) {
                *state = State::Abandoned;
                cell.changed.notify_all();
            }
        }
    }
}

/// Runs `f` on another thread when `fan` has one, and returns at once; else `f` runs here, now. Either way [`Started::wait`]
/// gives its result. A task that no thread has started by then is run by the one that waits.
pub fn start<R: Send + 'static>(fan: &dyn Fanout, f: impl FnOnce() -> R + Send + 'static) -> Started<R> {
    let cell = Arc::new(Cell { state: Mutex::new(State::Pending), changed: Condvar::new(), job: Mutex::new(None) });
    let guard = Guard(Arc::downgrade(&cell));
    let job: Task = Box::new(move || {
        let result = f();
        guard.finish(State::Done(result));
    });
    *cell.job.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(job);
    let runner: Task = {
        let cell = cell.clone();
        Box::new(move || {
            let job = cell.job.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
            if let Some(job) = job {
                job();
            }
        })
    };
    if let Err(runner) = fan.spawn(runner) {
        runner();
    }
    Started { cell }
}

impl<R> Started<R> {
    /// The result, waiting for the task if it has not ended. `Err` when it ended without one, or when `fan` knows the thread that
    /// had it stopped.
    pub fn wait(self, fan: &dyn Fanout) -> Result<R, Failed> {
        // A task no thread has started is done here: waiting for a worker that is busy, or gone, would be waiting for nothing.
        let unstarted = self.cell.job.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
        if let Some(job) = unstarted {
            // A task that panics ends without a result, as it would on its own thread (where panics abort, it never returns).
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
        }
        let mut state = self.cell.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            match std::mem::replace(&mut *state, State::Abandoned) {
                State::Done(result) => return Ok(result),
                State::Abandoned => return Err(Failed),
                State::Pending => *state = State::Pending,
            }
            if fan.lost() {
                return Err(Failed);
            }
            state = self.cell.changed.wait_timeout(state, std::time::Duration::from_millis(25)).unwrap_or_else(|poisoned| poisoned.into_inner()).0;
        }
    }
}

#[cfg(any(test, feature = "test-fakes"))]
mod test_fakes;
#[cfg(any(test, feature = "test-fakes"))]
pub use test_fakes::StdThreads;

/// Cuts `count` items into the contiguous ranges a fan-out should work on, or one range when cutting would not pay. More ranges
/// than threads, so that an uneven one does not leave the others idle.
pub fn ranges(fan: &dyn Fanout, count: usize) -> Vec<std::ops::Range<usize>> {
    let threads = fan.threads();
    if threads <= 1 || count < 2 * fan.grain() {
        return vec![0..count];
    }
    let pieces = (threads * 3).min(count / fan.grain()).max(1);
    let size = count.div_ceil(pieces);
    (0..count).step_by(size).map(|start| start..(start + size).min(count)).collect()
}

/// `f` on every input, side by side, and the results in the order of the inputs. `Err` as for [`Fanout::run`].
pub fn map<T, R, F>(fan: &dyn Fanout, inputs: Vec<T>, f: F) -> Result<Vec<R>, Failed>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> R + Send + Sync + 'static,
{
    if inputs.len() <= 1 || fan.threads() <= 1 {
        return Ok(inputs.into_iter().map(f).collect());
    }
    let count = inputs.len();
    let results: Arc<Mutex<Vec<Option<R>>>> = Arc::new(Mutex::new((0..count).map(|_| None).collect()));
    let f = Arc::new(f);
    let tasks: Vec<Task> = inputs
        .into_iter()
        .enumerate()
        .map(|(index, input)| {
            let (results, f) = (results.clone(), f.clone());
            Box::new(move || {
                let value = f(input);
                results.lock().unwrap_or_else(|poisoned| poisoned.into_inner())[index] = Some(value);
            }) as Task
        })
        .collect();
    fan.run(tasks)?;
    let mut results = results.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    results.iter_mut().map(|slot| slot.take().ok_or(Failed)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn results_come_back_in_the_order_of_the_inputs() {
        let done = Arc::new(AtomicUsize::new(0));
        let counted = done.clone();
        let squares = map(&StdThreads(4), (0..100u64).collect(), move |n| {
            counted.fetch_add(1, Ordering::Relaxed);
            n * n
        })
        .unwrap();
        assert_eq!(squares, (0..100u64).map(|n| n * n).collect::<Vec<_>>());
        assert_eq!(done.load(Ordering::Relaxed), 100);
        assert_eq!(map(&Sequential, vec![3, 1, 2], |n| n + 1).unwrap(), vec![4, 2, 3]);
    }

    #[test]
    fn a_started_task_gives_its_result_wherever_it_ran() {
        for fan in [&StdThreads(2) as &dyn Fanout, &Sequential] {
            let started = start(fan, || (1..=10u64).product::<u64>());
            assert_eq!(started.wait(fan), Ok(3_628_800));
        }
        let fan = StdThreads(2);
        let started = start(&fan, || -> u32 { panic!("a task that ends without a result") });
        assert_eq!(started.wait(&fan), Err(Failed));
    }

    #[test]
    fn ranges_tile_the_items_and_stay_whole_when_cutting_does_not_pay() {
        assert_eq!(ranges(&Sequential, 10_000), vec![0..10_000]);
        assert_eq!(ranges(&StdThreads(4), 1), vec![0..1]);
        let cut = ranges(&StdThreads(4), 1000);
        assert!(cut.len() > 4, "more pieces than threads: {}", cut.len());
        assert_eq!(cut.first().unwrap().start, 0);
        assert_eq!(cut.last().unwrap().end, 1000);
        assert!(cut.windows(2).all(|pair| pair[0].end == pair[1].start));
    }
}
