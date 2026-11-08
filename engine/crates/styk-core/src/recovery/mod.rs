//! The recovery views' logic: the start-up offer, the chooser and the close prompt (`docs/native/recovery.md`, "The views").
//!
//! The documents host owns recovery itself ([`crate::documents::recovery`]: the copies, the worker, the deadlines). This is
//! what a person sees of it and answers: [`model`] is the plain data the views in `styk-ui` draw and the [`model::Event`]s they
//! send, and [`Panel`] (with the engine) is the state behind them: the offer as the stage's message, the chooser and the close
//! prompt as dialogs on the overlay stack, each event a request to the documents host and each answer read back from its
//! view on the next [`crate::app::Core::refresh`]. Nothing here draws, reads a clock or touches a file.

pub mod model;
#[cfg(feature = "engine")]
mod panel;
mod when;

#[cfg(feature = "engine")]
pub use panel::Panel;
