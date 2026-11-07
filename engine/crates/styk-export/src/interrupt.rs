//! A way to end an export frame that is waiting for the GPU.
//!
//! The wait for a frame's read-back is a wait on a condition variable that the mapping callbacks and
//! [`Interrupt::interrupt`] both notify, so a cancel from any thread wakes it at once; the GPU's own wait
//! (`Device::poll`) runs on a poller thread of the exporter, which is bounded by the GPU's work and which nothing waits
//! for. After an interrupt the exporter is finished with: its read-back buffers may still be mapped or pending, and
//! it is dropped, not reused.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

/// The error an interrupted frame returns.
pub const INTERRUPTED: &str = "the export frame was interrupted";

#[derive(Default)]
struct State {
    expected: usize,
    completed: usize,
    error: Option<String>,
}

#[derive(Default)]
struct Latch {
    interrupted: AtomicBool,
    state: Mutex<State>,
    changed: Condvar,
}

/// Shared by clones: the exporter waits on it, any thread may interrupt it.
#[derive(Clone, Default)]
pub struct Interrupt {
    latch: Arc<Latch>,
}

impl Interrupt {
    pub fn new() -> Interrupt {
        Interrupt::default()
    }

    /// Ends the wait for the GPU, now and for every later frame. Returns at once.
    pub fn interrupt(&self) {
        self.latch.interrupted.store(true, Ordering::SeqCst);
        // Taking the lock first means a waiter that checked the flag is either not yet waiting or inside `wait`.
        drop(self.latch.state.lock().unwrap_or_else(|e| e.into_inner()));
        self.latch.changed.notify_all();
    }

    pub fn is_interrupted(&self) -> bool {
        self.latch.interrupted.load(Ordering::SeqCst)
    }

    /// Starts waiting for `expected` completions.
    pub fn expect(&self, expected: usize) {
        *self.latch.state.lock().unwrap_or_else(|e| e.into_inner()) = State { expected, completed: 0, error: None };
    }

    /// One completion (a mapped read-back), or its error.
    pub fn completed(&self, result: Result<(), String>) {
        let mut state = self.latch.state.lock().unwrap_or_else(|e| e.into_inner());
        state.completed += 1;
        if let Err(error) = result {
            state.error.get_or_insert(error);
        }
        drop(state);
        self.latch.changed.notify_all();
    }

    /// Blocks until the expected completions arrived or the interrupt came.
    pub fn wait(&self) -> Result<(), String> {
        let mut state = self.latch.state.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if self.is_interrupted() {
                return Err(INTERRUPTED.to_string());
            }
            if state.completed >= state.expected {
                return state.error.take().map_or(Ok(()), Err);
            }
            state = self.latch.changed.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completions_end_the_wait() {
        let interrupt = Interrupt::new();
        interrupt.expect(2);
        let feeder = {
            let interrupt = interrupt.clone();
            std::thread::spawn(move || {
                interrupt.completed(Ok(()));
                interrupt.completed(Ok(()));
            })
        };
        assert_eq!(interrupt.wait(), Ok(()));
        feeder.join().unwrap();
    }

    #[test]
    fn a_failed_mapping_is_reported() {
        let interrupt = Interrupt::new();
        interrupt.expect(1);
        interrupt.completed(Err("device lost".into()));
        assert_eq!(interrupt.wait(), Err("device lost".to_string()));
    }

    /// The GPU never answers (nothing completes); the interrupt must end the wait.
    #[test]
    fn an_interrupt_wakes_a_wait_that_nothing_will_complete() {
        let interrupt = Interrupt::new();
        interrupt.expect(3);
        let (sender, result) = std::sync::mpsc::channel();
        {
            let interrupt = interrupt.clone();
            std::thread::spawn(move || {
                let _ = sender.send(interrupt.wait());
            });
        }
        assert!(result.recv_timeout(std::time::Duration::from_millis(100)).is_err(), "still waiting for the GPU");
        interrupt.interrupt();
        // A wait that is not woken fails here instead of hanging the test.
        assert_eq!(result.recv_timeout(std::time::Duration::from_secs(5)), Ok(Err(INTERRUPTED.to_string())));
        // And it stays interrupted for the frames after.
        interrupt.expect(1);
        assert_eq!(interrupt.wait(), Err(INTERRUPTED.to_string()));
    }
}
