//! The Windows pointer source and its clock.

pub mod pointer;
pub mod qpc;

/// The ids of the window subclasses this crate installs (`SetWindowSubclass`'s `uIdSubclass`): one per owner, all in one place,
/// because a window's subclass chain is keyed by procedure and id and two owners must never share one. A subclass that lands
/// later (the window chrome) takes its own id here.
pub mod subclass_id {
    /// The pen, touch and mouse source ([`super::pointer::WindowsInput`]).
    pub const POINTER: usize = 0x5359_4B49;
}
