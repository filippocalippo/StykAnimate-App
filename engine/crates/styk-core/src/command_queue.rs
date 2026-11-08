//! Nonblocking admission of registry commands across a gesture/drawing barrier (SH-012).
//!
//! The feature owns the gesture and its settlement. This queue never waits, starts a
//! worker or holds a document. Its fixed-size records carry only registry identities
//! and input metadata; callers dispatch at most one `next` result per pump step and
//! re-read the owning features before the next. Release capacity is reserved at press
//! admission, so a full queue cannot lose a terminal key event.

use crate::command_registry::{Entry, Polygon};
use crate::documents::DocumentId;
use crate::shortcuts::{Activation, Release};

pub const CAPACITY: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source { Action, Keyboard }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase { Invoke, Press, Release { cancelled: bool } }

/// Routing metadata for a registry command; the application's `Command` remains the execution API.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Invocation {
    pub entry: &'static Entry,
    pub document: Option<DocumentId>,
    pub source: Source,
    pub phase: Phase,
    pub key: Option<&'static str>,
    pub shift: bool,
}

impl Invocation {
    pub fn action(entry: &'static Entry, document: Option<DocumentId>) -> Self {
        Self { entry, document, source: Source::Action, phase: Phase::Invoke, key: None, shift: false }
    }
    pub fn press(activation: Activation, document: Option<DocumentId>) -> Self {
        Self { entry: activation.entry, document, source: Source::Keyboard, phase: Phase::Press,
            key: Some(activation.key), shift: activation.shift }
    }
    pub fn release(release: Release, document: Option<DocumentId>) -> Self {
        Self { phase: Phase::Release { cancelled: release.cancelled }, ..Self::press(release.activation, document) }
    }
    fn held_press(self) -> bool {
        self.phase == Phase::Press && self.entry.shortcut.is_some_and(|shortcut| shortcut.hold)
    }
    fn terminal(self) -> bool { matches!(self.phase, Phase::Release { .. }) }
    fn handle(self) -> bool { self.source == Source::Keyboard && self.entry.id.starts_with("handle-") }
}

/// Read from the gesture/drawing owners, never maintained as a second busy state.
#[derive(Clone, Copy, Debug, Default)]
pub struct Activity {
    pub gesture: bool,
    /// The document whose keyboard-handle owner already has an open gesture.
    pub keyboard_handles: Option<DocumentId>,
    pub stroke: bool,
    pub loading: bool,
    pub selection: bool,
    pub selection_committing: bool,
    pub operation: bool,
}

impl Activity {
    fn continues(self, invocation: Invocation) -> bool {
        self.keyboard_handles.is_some() && invocation.document == self.keyboard_handles
            && invocation.handle()
    }

    fn blocks(self, invocation: Invocation) -> bool {
        if invocation.terminal() { return false; }
        if invocation.source == Source::Keyboard && matches!(invocation.entry.id, "cancel" | "play-pan") { return false; }
        (self.gesture && !self.continues(invocation)) || self.stroke || self.loading || self.operation
            || if invocation.source == Source::Action { self.selection } else { self.selection_committing }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal { Full }

impl Refusal {
    pub fn message_key(self) -> &'static str { "errors.editorSessions.finishTheCurrentOperationFirst" }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Submitted {
    Ready(Invocation),
    /// Ask the feature to settle; it must report success/failure before `next` can run.
    Queued,
    /// The caller still owns the refused command and must show the warning, undoing its admission bookkeeping.
    Refused { invocation: Invocation, reason: Refusal },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    Empty,
    Blocked,
    Ready(Invocation),
    /// A document changed or settlement failed. Feed this terminal outcome to the caller; never replay on another tab.
    Cancelled(Invocation),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settlement { Ready, Failed }

pub struct GestureQueue {
    pending: [Option<Invocation>; CAPACITY],
    head: usize,
    len: usize,
}

impl Default for GestureQueue {
    fn default() -> Self { Self { pending: [None; CAPACITY], head: 0, len: 0 } }
}

impl GestureQueue {
    pub fn len(&self) -> usize { self.len }
    pub fn is_empty(&self) -> bool { self.len == 0 }
    /// One terminal slot per open physical key, including holds already dispatched.
    /// `held` is the current `Shortcuts::held()` snapshot, after the incoming input event.
    pub fn reserved_releases(&self, held: &[Activation]) -> usize { self.reservations(held, None) }

    fn reservations(&self, held: &[Activation], incoming: Option<Invocation>) -> usize {
        let records = || self.records().chain(incoming);
        // Shortcuts owns unique physical keys. Queue records contribute only their last open press
        // for a key not already counted there. No cached counter or subtract-on-removal can drift.
        held.len() + records().enumerate().filter(|(index, event)| {
            event.held_press() && event.key.is_some()
                && !held.iter().any(|key| Some(key.key) == event.key)
                && !records().skip(index + 1).any(|later| later.key == event.key && (later.held_press() || later.terminal()))
        }).count()
    }

    fn records(&self) -> impl DoubleEndedIterator<Item = Invocation> + '_ {
        (0..self.len).filter_map(|index| self.pending[(self.head + index) % CAPACITY])
    }

    fn awaits_release(&self, key: Option<&str>) -> bool {
        key.is_some() && self.records().rev().find(|item| item.key == key && (item.held_press() || item.terminal()))
            .is_some_and(Invocation::held_press)
    }

    /// The caller supplies its current holds and immediately rolls back a refusal with `Shortcuts::reject`.
    pub fn submit(&mut self, invocation: Invocation, activity: Activity, held: &[Activation]) -> Submitted {
        let awaiting = self.awaits_release(invocation.key);
        let earlier_handle = invocation.handle() && self.records().any(Invocation::handle);
        // A handle can pass unrelated waiters, never another handle event, including a blocked repeat.
        let ready = !earlier_handle && ((invocation.terminal() && !awaiting)
            || (!awaiting && activity.continues(invocation) && !activity.blocks(invocation))
            || (invocation.source == Source::Keyboard && matches!(invocation.entry.id, "cancel" | "play-pan"))
            || (self.is_empty() && !activity.blocks(invocation)));
        let incoming = if ready { None } else { Some(invocation) };
        if self.len + usize::from(!ready) + self.reservations(held, incoming) > CAPACITY {
            return Submitted::Refused { invocation, reason: Refusal::Full };
        }
        if ready { return Submitted::Ready(invocation); }
        self.pending[(self.head + self.len) % CAPACITY] = Some(invocation);
        self.len += 1;
        Submitted::Queued
    }

    fn remove(&mut self, index: usize) -> Option<Invocation> {
        if index >= self.len { return None; }
        let item = self.pending[(self.head + index) % CAPACITY]?;
        if index == 0 {
            self.pending[self.head] = None;
            self.head = (self.head + 1) % CAPACITY;
        } else {
            for offset in index..self.len - 1 {
                self.pending[(self.head + offset) % CAPACITY] = self.pending[(self.head + offset + 1) % CAPACITY];
            }
            self.pending[(self.head + self.len - 1) % CAPACITY] = None;
        }
        self.len -= 1;
        Some(item)
    }

    /// Recheck after *each* command: the previous one may have started another operation or changed documents.
    pub fn next(&mut self, document: Option<DocumentId>, activity: Activity, settlement: Settlement) -> Next {
        let Some(front) = self.pending[self.head] else { return Next::Empty; };
        if front.document != document || settlement == Settlement::Failed {
            return self.remove(0).map_or(Next::Empty, Next::Cancelled);
        }
        let index = if activity.blocks(front) {
            // Only the first handle is eligible to bypass unrelated waiters. Readiness cannot
            // turn a later terminal into a candidate ahead of a blocked press or repeat.
            let Some((index, first)) = self.records().enumerate().find(|(_, item)| item.handle()) else { return Next::Blocked; };
            if first.document != document || !activity.continues(first) || activity.blocks(first) { return Next::Blocked; }
            index
        } else { 0 };
        self.remove(index).map_or(Next::Empty, Next::Ready)
    }
}

/// The wrapper's polygon gate is separate from the keyboard's earlier allow-list:
/// e.g. Save is keyboard-allowed, but its wrapped action still asks to finish the polygon.
pub fn polygon_action(entry: &Entry, polygon: bool) -> Polygon {
    if polygon { entry.polygon } else { Polygon::Allow }
}

pub const POLYGON_MESSAGE: &str = "app.finishOrCancelThePolygonFirst";
