//! Three coalesced wake reasons: bounded even if producers outpace the event loop.
use iced::futures::{Stream, future::poll_fn, stream, task::AtomicWaker};
use std::sync::{Arc, atomic::{AtomicU8, Ordering}};
use std::task::Poll;
use styk_platform::shell::{self, Wake};

#[derive(Default)]
struct Pending {
    bits: AtomicU8,
    waker: AtomicWaker,
}
#[derive(Clone, Default)]
pub struct Wakes(Arc<Pending>);
impl std::hash::Hash for Wakes {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        std::hash::Hash::hash(&Arc::as_ptr(&self.0), state);
    }
}
impl Wakes {
    pub fn new() -> Self { Self::default() }
    pub fn callback(&self) -> shell::Wakes {
        let wakes = self.clone();
        shell::Wakes(Arc::new(move |wake| wakes.send(wake)))
    }
    pub fn send(&self, wake: Wake) {
        let bit = match wake { Wake::Chrome => 1, Wake::Instance => 2, Wake::SaveCheck => 4 };
        self.0.bits.fetch_or(bit, Ordering::Release);
        self.0.waker.wake();
    }
    fn take(&self) -> Option<Wake> {
        let mut bits = self.0.bits.load(Ordering::Acquire);
        while bits != 0 {
            let bit = 1 << bits.trailing_zeros();
            match self.0.bits.compare_exchange_weak(bits, bits & !bit, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return Some(match bit { 1 => Wake::Chrome, 2 => Wake::Instance, _ => Wake::SaveCheck }),
                Err(now) => bits = now,
            }
        }
        None
    }
    pub fn stream(self) -> impl Stream<Item = Wake> {
        stream::unfold(self, |wakes| async move {
            let wake = poll_fn(|cx| {
                wakes.0.waker.register(cx.waker());
                wakes.take().map_or(Poll::Pending, Poll::Ready)
            }).await;
            Some((wake, wakes))
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coalescing_preserves_each_reason_without_growing_a_queue() {
        let wakes = Wakes::new();
        for _ in 0..10_000 {
            wakes.send(Wake::Chrome); wakes.send(Wake::Instance); wakes.send(Wake::SaveCheck);
        }
        assert!(matches!(wakes.take(), Some(Wake::Chrome)));
        assert!(matches!(wakes.take(), Some(Wake::Instance)));
        assert!(matches!(wakes.take(), Some(Wake::SaveCheck)));
        assert!(wakes.take().is_none());
        wakes.send(Wake::Instance);
        assert!(matches!(wakes.take(), Some(Wake::Instance)));
    }
    #[test]
    fn waiting_stream_is_woken_by_a_producer() {
        use iced::futures::{StreamExt, task::{ArcWake, waker}};
        struct Count(std::sync::atomic::AtomicUsize);
        impl ArcWake for Count { fn wake_by_ref(this: &Arc<Self>) { this.0.fetch_add(1, Ordering::Relaxed); } }
        let wakes = Wakes::new(); let mut stream = Box::pin(wakes.clone().stream());
        let count = Arc::new(Count(std::sync::atomic::AtomicUsize::new(0)));
        let waker = waker(count.clone()); let mut cx = std::task::Context::from_waker(&waker);
        assert!(stream.poll_next_unpin(&mut cx).is_pending());
        wakes.send(Wake::SaveCheck);
        assert_eq!(count.0.load(Ordering::Relaxed), 1);
        assert!(matches!(stream.poll_next_unpin(&mut cx), Poll::Ready(Some(Wake::SaveCheck))));
    }
}
