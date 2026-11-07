//! The app's table of clipboard requests (`docs/native/text-input.md` section 5).
//!
//! A clipboard read is asynchronous: its reply can come after the focus moved. Every request has an ID and a target, and a
//! reply is delivered only to the target that asked, only while that target is still the one allowed to take it. The
//! table is bounded; a full table refuses new requests instead of growing.

use std::time::{Duration, Instant};

/// A request's identity; replies carry it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct RequestId(pub u64);

/// What a request is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Text,
    Figures,
    Image,
}

/// The most requests in flight.
pub const MAX_IN_FLIGHT: usize = 8;

/// How long a request lives before its reply is dropped.
pub const LIFETIME: Duration = Duration::from_secs(10);

#[derive(Clone, Debug)]
struct Pending<Target> {
    id: RequestId,
    target: Target,
    kind: Kind,
    deadline: Instant,
}

/// Why a reply was not delivered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dropped {
    /// No such request (already answered, expired or cancelled).
    Unknown,
    /// The request was made for another target than the one that is allowed to take it now.
    WrongTarget,
    /// The request expired.
    Expired,
}

/// The table of requests in flight; `Target` identifies who asked (a field, the stage).
#[derive(Clone, Debug)]
pub struct Requests<Target> {
    next: u64,
    pending: Vec<Pending<Target>>,
}

impl<Target> Default for Requests<Target> {
    fn default() -> Self {
        Requests { next: 1, pending: Vec::new() }
    }
}

impl<Target: PartialEq + Copy> Requests<Target> {
    /// An empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a request. `None` when `MAX_IN_FLIGHT` are already waiting (after dropping the expired).
    pub fn request(&mut self, target: Target, kind: Kind, now: Instant) -> Option<RequestId> {
        self.pending.retain(|p| p.deadline > now);
        if self.pending.len() >= MAX_IN_FLIGHT {
            return None;
        }
        let id = RequestId(self.next);
        self.next += 1;
        self.pending.push(Pending { id, target, kind, deadline: now + LIFETIME });
        Some(id)
    }

    /// A reply arrived. `current` is who may take it now (the focused field); the reply is delivered, and its request
    /// forgotten, only when the request's target is that one. A reply to the wrong target is dropped and forgotten.
    pub fn deliver(&mut self, id: RequestId, current: Option<Target>, now: Instant) -> Result<(Target, Kind), Dropped> {
        let index = self.pending.iter().position(|p| p.id == id).ok_or(Dropped::Unknown)?;
        let pending = self.pending.remove(index);
        if pending.deadline <= now {
            return Err(Dropped::Expired);
        }
        if current != Some(pending.target) {
            return Err(Dropped::WrongTarget);
        }
        Ok((pending.target, pending.kind))
    }

    /// Forgets every request a target made (it lost focus or was removed).
    pub fn cancel_target(&mut self, target: Target) {
        self.pending.retain(|p| p.target != target);
    }

    /// Requests in flight.
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    /// Whether none is in flight.
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_reaches_only_the_field_that_asked() {
        let now = Instant::now();
        let mut table = Requests::new();
        let id = table.request(1u32, Kind::Text, now).unwrap();
        // Focus moved to field 2 before the reply.
        assert_eq!(table.deliver(id, Some(2), now), Err(Dropped::WrongTarget));
        assert!(table.is_empty(), "a dropped reply is forgotten");
        let id = table.request(1u32, Kind::Text, now).unwrap();
        assert_eq!(table.deliver(id, Some(1), now), Ok((1, Kind::Text)));
    }

    #[test]
    fn a_reply_is_delivered_once_and_an_unknown_one_is_refused() {
        let now = Instant::now();
        let mut table = Requests::new();
        let id = table.request(1u32, Kind::Text, now).unwrap();
        assert!(table.deliver(id, Some(1), now).is_ok());
        assert_eq!(table.deliver(id, Some(1), now), Err(Dropped::Unknown));
        assert_eq!(table.deliver(RequestId(999), Some(1), now), Err(Dropped::Unknown));
    }

    #[test]
    fn a_late_reply_is_dropped() {
        let now = Instant::now();
        let mut table = Requests::new();
        let id = table.request(1u32, Kind::Image, now).unwrap();
        assert_eq!(table.deliver(id, Some(1), now + LIFETIME), Err(Dropped::Expired));
    }

    #[test]
    fn the_table_is_bounded_and_forgets_expired_requests() {
        let now = Instant::now();
        let mut table = Requests::new();
        for target in 0..MAX_IN_FLIGHT as u32 {
            assert!(table.request(target, Kind::Text, now).is_some());
        }
        assert!(table.request(99, Kind::Text, now).is_none(), "full");
        assert!(table.request(99, Kind::Text, now + LIFETIME).is_some(), "the expired made room");
    }

    #[test]
    fn losing_focus_forgets_the_fields_requests() {
        let now = Instant::now();
        let mut table = Requests::new();
        let a = table.request(1u32, Kind::Text, now).unwrap();
        let b = table.request(2u32, Kind::Text, now).unwrap();
        table.cancel_target(1);
        assert_eq!(table.deliver(a, Some(1), now), Err(Dropped::Unknown));
        assert!(table.deliver(b, Some(2), now).is_ok());
    }
}
