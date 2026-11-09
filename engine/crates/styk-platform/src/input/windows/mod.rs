//! The Windows pointer source and its clock.

pub mod pointer;
pub mod qpc;

/// The ids of the window subclasses this crate installs (`SetWindowSubclass`'s `uIdSubclass`): one per owner, all in one place,
/// because a window's subclass chain is keyed by procedure and id and two owners must never share one. The window chrome
/// (non-client hit testing and the maximize button) and the pointer source are two owners of one chain: the chrome answers
/// only `WM_NCHITTEST` and its non-client mouse messages and forwards the rest, the pointer source consumes pen
/// `WM_POINTER*` on purpose and forwards the rest.
pub mod subclass_id {
    /// The pen, touch and mouse source ([`super::pointer::WindowsInput`]).
    pub const POINTER: usize = 0x5359_4B49;
    /// The off-screen automation cursor ([`crate::automation_input`]).
    pub const AUTOMATION: usize = 0x5359_4B41;
    /// The frameless window's non-client behaviour ([`crate::windows::chrome`]).
    pub const CHROME: usize = 0x5359_4B43;
}
