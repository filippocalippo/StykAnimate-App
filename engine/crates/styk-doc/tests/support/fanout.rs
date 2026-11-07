//! Native threads for parallel codec tests; never part of a production build.
use super::*;
/// `threads` native threads taking tasks from one queue for tests without engine workers.
/// The order tasks finish in is not the order they start.
pub struct StdThreads(pub usize);

impl Fanout for StdThreads {
    fn threads(&self) -> usize {
        self.0
    }

    fn grain(&self) -> usize {
        1
    }

    fn spawn(&self, task: Task) -> Result<(), Task> {
        std::thread::spawn(task);
        Ok(())
    }

    fn run(&self, tasks: Vec<Task>) -> Result<(), Failed> {
        let queue = Arc::new(Mutex::new(tasks.into_iter().collect::<std::collections::VecDeque<_>>()));
        let handles: Vec<_> = (0..self.0)
            .map(|_| {
                let queue = queue.clone();
                std::thread::spawn(move || {
                    while let Some(task) = queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).pop_front() {
                        task();
                    }
                })
            })
            .collect();
        handles.into_iter().try_for_each(|handle| handle.join().map_err(|_| Failed))
    }
}
