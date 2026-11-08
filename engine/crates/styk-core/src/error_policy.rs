//! SH-014/015: classify a failure without formatting text or owning a timer.
//!
//! Both synchronous handler errors and asynchronous job replies use `classify`.
//! The reference slice owns `i18n::Msg` and the notice/effect types. This module
//! only supplies policy, so a worker's key and scalar parameters pass through
//! unchanged; external diagnostic text is never interpreted as a catalogue key.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { User, Cancelled, Failure }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation { Command, Save, Export, Import }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone { Warning, Error }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lifetime { Timed { milliseconds: u32 }, UntilDismissed }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NoticePolicy {
    pub tone: Tone,
    pub lifetime: Lifetime,
    pub dismissible: bool,
}

/// User errors remain warnings even when marked persistent; cancellation is always silent.
/// Today's toast defaults are 6 s for warnings, 8 s for other routine failures.
pub fn classify(kind: Kind, operation: Operation) -> Option<NoticePolicy> {
    match kind {
        Kind::Cancelled => None,
        Kind::User => Some(NoticePolicy { tone: Tone::Warning, lifetime: Lifetime::Timed { milliseconds: 6000 }, dismissible: false }),
        Kind::Failure => Some(NoticePolicy { tone: Tone::Error,
            lifetime: if operation == Operation::Command { Lifetime::Timed { milliseconds: 8000 } } else { Lifetime::UntilDismissed },
            dismissible: true }),
    }
}
