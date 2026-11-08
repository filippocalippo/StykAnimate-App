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
            && invocation.source == Source::Keyboard
            && matches!(invocation.entry.id, "handle-left" | "handle-right" | "handle-up" | "handle-down")
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
    reserved_releases: usize,
}

impl Default for GestureQueue {
    fn default() -> Self { Self { pending: [None; CAPACITY], head: 0, len: 0, reserved_releases: 0 } }
}

impl GestureQueue {
    pub fn len(&self) -> usize { self.len }
    pub fn is_empty(&self) -> bool { self.len == 0 }
    pub fn reserved_releases(&self) -> usize { self.reserved_releases }

    fn records(&self) -> impl DoubleEndedIterator<Item = Invocation> + '_ {
        (0..self.len).filter_map(|index| self.pending[(self.head + index) % CAPACITY])
    }

    fn awaits_release(&self, key: Option<&str>) -> bool {
        key.is_some() && self.records().rev().find(|item| item.key == key && (item.held_press() || item.terminal()))
            .is_some_and(Invocation::held_press)
    }

    pub fn submit(&mut self, invocation: Invocation, activity: Activity) -> Submitted {
        let awaiting = self.awaits_release(invocation.key);
        let reserved = invocation.terminal() && awaiting;
        // Cancel/play-pan and a live key's release must reach their owner even while the queue is full.
        if (invocation.terminal() && !awaiting)
            || (!awaiting && activity.continues(invocation) && !activity.blocks(invocation))
            || (invocation.source == Source::Keyboard && matches!(invocation.entry.id, "cancel" | "play-pan"))
            || (self.is_empty() && !activity.blocks(invocation)) {
            return Submitted::Ready(invocation);
        }
        let reserve = usize::from(invocation.held_press() && !awaiting);
        if !reserved && self.len + self.reserved_releases + 1 + reserve > CAPACITY {
            return Submitted::Refused { invocation, reason: Refusal::Full };
        }
        if reserved { self.reserved_releases -= 1; }
        self.reserved_releases += reserve;
        self.pending[(self.head + self.len) % CAPACITY] = Some(invocation);
        self.len += 1;
        Submitted::Queued
    }

    fn remove(&mut self, index: usize) -> Option<Invocation> {
        if index >= self.len { return None; }
        let item = self.pending[(self.head + index) % CAPACITY]?;
        let awaiting = item.held_press() && self.awaits_release(item.key);
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
        if awaiting && !self.awaits_release(item.key) { self.reserved_releases -= 1; }
        Some(item)
    }

    /// Recheck after *each* command: the previous one may have started another operation or changed documents.
    pub fn next(&mut self, document: Option<DocumentId>, activity: Activity, settlement: Settlement) -> Next {
        let Some(front) = self.pending[self.head] else { return Next::Empty; };
        if front.document != document || settlement == Settlement::Failed {
            return self.remove(0).map_or(Next::Empty, Next::Cancelled);
        }
        let index = if activity.blocks(front) {
            // A waiting action must not trap the live gesture's repeats or release.
            // Scan in queue order, so an unstarted press still precedes its terminal.
            let Some(index) = self.records().position(|item| item.document == document
                && activity.continues(item) && !activity.blocks(item)) else { return Next::Blocked; };
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
