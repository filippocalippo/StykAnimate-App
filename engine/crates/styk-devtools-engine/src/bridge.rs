//! One control mutation in flight, delivered to the application's real command route.
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc::{self, SyncSender},
};
pub struct Mutation {
    pub name: String,
    pub value: Value,
    pub reply: SyncSender<Result<Value, String>>,
    pub cancel: styk_services::Cancel,
}
#[derive(Default)]
struct State {
    pending: Option<Mutation>,
    notify: Option<Arc<dyn Fn() + Send + Sync>>,
}
#[derive(Clone, Default)]
pub struct Bridge(Arc<Mutex<State>>, Arc<AtomicBool>);
impl Bridge {
    pub fn attach(&self, notify: Arc<dyn Fn() + Send + Sync>) -> Result<(), String> {
        self.0.try_lock().map_err(|_| "control bridge busy")?.notify = Some(notify);
        self.1.store(true, Ordering::Release);
        Ok(())
    }
    pub fn detach(&self) {
        self.1.store(false, Ordering::Release);
        if let Ok(mut state) = self.0.try_lock() {
            state.notify = None;
            if let Some(m) = state.pending.take() {
                let _ = m.reply.try_send(Err("developer window closed".into()));
            }
        }
    }
    pub fn take(&self) -> Option<Mutation> {
        if !self.1.load(Ordering::Acquire) {
            return None;
        }
        self.0
            .try_lock()
            .ok()?
            .pending
            .take()
            .filter(|m| !m.cancel.is_cancelled())
    }
    /// Control worker only. The UI never waits for a control peer.
    pub fn set(&self, name: String, value: Value) -> Result<Value, String> {
        if name.len() > 128
            || value.as_str().is_some_and(|s| s.len() > 2048)
            || value.is_array()
            || value.is_object()
        {
            return Err("invalid parameter payload".into());
        }
        let (reply, receive) = mpsc::sync_channel(1);
        let cancel = styk_services::Cancel::new();
        let notify = {
            let mut state = self.0.try_lock().map_err(|_| "control bridge busy")?;
            if !self.1.load(Ordering::Acquire) {
                return Err("no developer window attached".into());
            }
            if state.pending.is_some() {
                return Err("control mutation pending".into());
            }
            let notify = state.notify.clone().ok_or("no developer window attached")?;
            state.pending = Some(Mutation {
                name,
                value,
                reply,
                cancel: cancel.clone(),
            });
            notify
        };
        notify();
        match receive.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(result) => result,
            Err(_) => {
                cancel.cancel();
                Err("control mutation timed out".into())
            }
        }
    }
}
