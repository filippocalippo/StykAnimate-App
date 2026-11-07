//! Background tasks on operating-system threads: the implementation of [`styk_services::Spawner`] for the desktop targets.

use styk_services::{Job, SpawnError, Spawner};

/// Starts each task on a thread of its own, named after the task. The thread ends with the closure.
#[derive(Clone, Copy, Debug, Default)]
pub struct ThreadSpawner;

impl Spawner for ThreadSpawner {
    fn spawn(&self, name: &str, job: Job) -> Result<(), SpawnError> {
        // The thread is never joined: whoever started the task tells it to end by its own means.
        std::thread::Builder::new().name(name.to_string()).spawn(job).map(|_| ()).map_err(|error| SpawnError(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn a_task_runs_on_a_thread_that_carries_its_name() {
        let (sender, receiver) = channel();
        ThreadSpawner
            .spawn("styk-test-task", Box::new(move || {
                let _ = sender.send(std::thread::current().name().map(str::to_string));
            }))
            .unwrap();
        let name = receiver.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(name.as_deref(), Some("styk-test-task"));
    }
}
