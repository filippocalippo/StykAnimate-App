//! One bounded background lane. Interface calls only try the exchange; they never wait for its worker.
//! The worker keeps the final owner of the exchange and disposes queued/retired payloads on shutdown.
use std::future::Future;
use std::pin::pin;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use crate::{SpawnError, Spawner};

type Retired = Box<dyn Send>;
struct State<I, O> { input: Option<I>, output: Option<O>, retired: Option<Vec<Retired>>, busy: bool }
struct Shared<I, O> {
    state: Mutex<State<I, O>>,
    stopping: AtomicBool,
    final_owner: AtomicPtr<Retired>,
}

/// One input, one output, one retirement batch. Callers bound the bytes of each input before submission.
pub struct Worker<I: Send + 'static, O: Send + 'static> {
    shared: Arc<Shared<I, O>>,
    wake: SyncSender<()>,
    notify: Arc<dyn Fn() + Send + Sync>,
}

impl<I: Send + 'static, O: Send + 'static> Worker<I, O> {
    pub fn start(spawner: &dyn Spawner, name: &str, mut run: impl FnMut(I) -> O + Send + 'static, notify: Arc<dyn Fn() + Send + Sync>) -> Result<Self, SpawnError> {
        let shared = Arc::new(Shared { state: Mutex::new(State { input: None, output: None, retired: None, busy: false }), stopping: AtomicBool::new(false), final_owner: AtomicPtr::new(ptr::null_mut()) });
        let (wake, receive) = sync_channel(1);
        let worker = shared.clone();
        let retry = notify.clone();
        spawner.spawn(name, Box::new(move || {
            // Only this background task waits. No resource is freed while the exchange is locked.
            while receive.recv().is_ok() {
                let (input, retired) = {
                    let mut state = worker.state.lock().unwrap_or_else(|error| error.into_inner());
                    (state.input.take(), state.retired.take())
                };
                let reclaimed = retired.is_some();
                drop(retired);
                if reclaimed { notify(); }
                if worker.stopping.load(Ordering::Acquire) { drop(input); break; }
                if let Some(input) = input {
                    let output = run(input);
                    if worker.stopping.load(Ordering::Acquire) { drop(output); break; }
                    let previous = {
                        let mut state = worker.state.lock().unwrap_or_else(|error| error.into_inner());
                        state.output.replace(output)
                    };
                    drop(previous);
                    notify();
                }
            }
            let (input, output, retired) = {
                let mut state = worker.state.lock().unwrap_or_else(|error| error.into_inner());
                (state.input.take(), state.output.take(), state.retired.take())
            };
            drop((input, output, retired));
            let final_owner = worker.final_owner.swap(ptr::null_mut(), Ordering::AcqRel);
            if !final_owner.is_null() {
                // SAFETY: shutdown publishes one owned Box before stopping; only this worker takes it.
                drop(unsafe { Box::from_raw(final_owner) });
            }
        }))?;
        Ok(Self { shared, wake, notify: retry })
    }

    /// A refusal gives the input back. Nothing is submitted and no terminal request is silently lost.
    pub fn submit(&self, input: I) -> Result<(), I> {
        let Ok(mut state) = self.shared.state.try_lock() else { (self.notify)(); return Err(input); };
        if state.busy || self.shared.stopping.load(Ordering::Acquire) { return Err(input); }
        state.busy = true;
        state.input = Some(input);
        drop(state);
        let _ = self.wake.try_send(()); // full means the worker already has a wake
        Ok(())
    }

    /// Poll at most one completion. A contended exchange is simply not ready this frame.
    pub fn take(&self) -> Option<O> {
        let Ok(mut state) = self.shared.state.try_lock() else { (self.notify)(); return None; };
        let output = state.output.take()?;
        state.busy = false;
        Some(output)
    }

    pub fn retire(&self, value: Vec<Retired>) -> Result<(), Vec<Retired>> {
        let Ok(mut state) = self.shared.state.try_lock() else { (self.notify)(); return Err(value); };
        if state.retired.is_some() { return Err(value); }
        state.retired = Some(value);
        drop(state);
        let _ = self.wake.try_send(());
        Ok(())
    }

    /// One final bounded owner (for example the at-most-twelve open tabs), reclaimed by the worker.
    pub fn shutdown(mut self, owner: Retired) {
        self.stop(Some(owner));
    }

    fn stop(&mut self, owner: Option<Retired>) {
        if let Some(owner) = owner {
            self.shared.final_owner.store(Box::into_raw(Box::new(owner)), Ordering::Release);
        }
        self.shared.stopping.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
    }
}

impl<I: Send + 'static, O: Send + 'static> Drop for Worker<I, O> {
    fn drop(&mut self) { self.stop(None); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    #[derive(Default)]
    struct Queued(Mutex<Option<crate::Job>>);
    impl Spawner for Queued {
        fn spawn(&self, _: &str, job: crate::Job) -> Result<(), SpawnError> {
            *self.0.lock().unwrap() = Some(job); Ok(())
        }
    }
    #[test]
    fn contended_exchange_retains_operands_and_notifies_retry_without_waiting() {
        let spawner = Queued::default();
        let notified = Arc::new(AtomicUsize::new(0));
        let count = notified.clone();
        let worker = Worker::start(&spawner, "exchange", |n: u32| n, Arc::new(move || { count.fetch_add(1, Ordering::SeqCst); })).unwrap();
        let guard = worker.shared.state.lock().unwrap();
        assert_eq!(worker.submit(7), Err(7));
        assert_eq!(worker.take(), None);
        assert_eq!(worker.retire(vec![Box::new(9u32)]).err().unwrap().len(), 1);
        assert_eq!(notified.load(Ordering::SeqCst), 3, "each refused exchange must schedule its retry even with no running job");
        drop(guard);
        assert!(worker.submit(7).is_ok());
        assert_eq!(worker.take(), None);
        assert_eq!(notified.load(Ordering::SeqCst), 3, "an ordinary pending result must not busy-poll");
    }
}

struct FutureWake(SyncSender<()>);
impl Wake for FutureWake {
    fn wake(self: Arc<Self>) { let _ = self.0.try_send(()); }
    fn wake_by_ref(self: &Arc<Self>) { let _ = self.0.try_send(()); }
}

/// A background lane hands one job to its engine scheduler and waits for that one completion.
/// Both the input and completion are bounded by the caller's single-flight lane. Worker-only.
pub fn run_scheduled<T: Send + 'static>(enqueue: impl FnOnce(Box<dyn FnOnce() + Send>), run: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (send, receive) = sync_channel(1);
    enqueue(Box::new(move || { let _ = send.try_send(run()); }));
    receive.recv().ok()
}

/// Poll an asynchronous platform service on a background task. Never call from dispatch/update/view.
pub fn run_future<T>(future: impl Future<Output = T>) -> T {
    let (send, receive) = sync_channel(1);
    let waker = Waker::from(Arc::new(FutureWake(send)));
    let mut context = Context::from_waker(&waker);
    let mut future = pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => { let _ = receive.recv(); }
        }
    }
}
