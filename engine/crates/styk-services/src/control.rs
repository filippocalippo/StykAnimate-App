//! Local developer-control transport contracts. Hosts poll the inbox without blocking.
use crate::Spawner;
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
pub const MAX_REQUEST: usize = 16 * 1024;
pub const MAX_RESPONSE: usize = 24 * 1024;
pub const QUEUE_BYTES: usize = 64 * 1024;
pub type Answer = Box<dyn FnOnce(Vec<u8>) -> Result<(), String> + Send>;
pub struct Request {
    pub bytes: Vec<u8>,
    pub cancelled: Arc<AtomicBool>,
    answer: Option<Answer>,
}
impl Request {
    pub fn new(bytes: Vec<u8>, cancelled: Arc<AtomicBool>, answer: Answer) -> Self {
        Self {
            bytes,
            cancelled,
            answer: Some(answer),
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    pub fn respond(mut self, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.capacity() > MAX_RESPONSE + 1 || bytes.len() > MAX_RESPONSE + 1 {
            return Err("response too large".into());
        }
        if self.is_cancelled() {
            return Err("request cancelled".into());
        }
        self.answer.take().ok_or("response already sent")?(bytes)
    }
}
#[derive(Default)]
pub struct Inbox {
    queue: Mutex<(VecDeque<Request>, usize)>,
    refused: AtomicU64,
}
impl Inbox {
    pub fn push(&self, request: Request) -> Result<(), Request> {
        let cost = request.bytes.capacity() + MAX_RESPONSE + std::mem::size_of::<Request>();
        if request.bytes.capacity() > MAX_REQUEST + 1 || request.bytes.len() > MAX_REQUEST {
            self.refused.fetch_add(1, Ordering::Relaxed);
            return Err(request);
        }
        if let Ok(mut queue) = self.queue.try_lock() {
            if cost <= QUEUE_BYTES - queue.1 {
                queue.1 += cost;
                queue.0.push_back(request);
                return Ok(());
            }
        }
        self.refused.fetch_add(1, Ordering::Relaxed);
        Err(request)
    }
    pub fn pop(&self) -> Option<Request> {
        let mut queue = self.queue.try_lock().ok()?;
        let request = queue.0.pop_front()?;
        queue.1 -= request.bytes.capacity() + MAX_RESPONSE + std::mem::size_of::<Request>();
        Some(request)
    }
    pub fn refused(&self) -> u64 {
        self.refused.load(Ordering::Relaxed)
    }
}
pub trait Running: Send + Sync {
    fn cancel(&self);
    fn is_finished(&self) -> bool;
}
pub struct Operation {
    pub completion: Arc<Mutex<Option<Result<Vec<u8>, String>>>>,
    pub cancel: Box<dyn Running>,
}
impl Operation {
    pub fn take(&self) -> Option<Result<Vec<u8>, String>> {
        self.completion.try_lock().ok()?.take()
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
pub trait Transport: Send + Sync {
    fn serve(
        &self,
        spawner: &dyn Spawner,
        endpoint: &str,
        inbox: Arc<Inbox>,
    ) -> Result<Box<dyn Running>, String>;
    fn request(
        &self,
        spawner: &dyn Spawner,
        endpoint: &str,
        message: Vec<u8>,
    ) -> Result<Operation, String>;
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_and_contended_queues_refuse_visibly() {
        let inbox = Inbox::default();
        let make = || {
            Request::new(
                vec![0; MAX_REQUEST],
                Arc::new(AtomicBool::new(false)),
                Box::new(|_| Ok(())),
            )
        };
        assert!(inbox.push(make()).is_ok());
        assert!(inbox.push(make()).is_err());
        assert_eq!(inbox.refused(), 1);
        assert!(inbox.pop().is_some());
        let lock = inbox.queue.lock().unwrap();
        assert!(inbox.push(make()).is_err());
        drop(lock);
        assert_eq!(inbox.refused(), 2);
    }
}
