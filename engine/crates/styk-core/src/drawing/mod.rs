//! Drawing input, from pointer samples to tiles (`docs/native/input.md`).
//!
//! - [`mapping`]: window pixels to cel pixels, in the order the JavaScript drawing controller does it.
//! - [`stroke_input`]: today's rules over input events (de-duplication, pressure floor, tilt lean, eraser, barrel, palm
//!   rejection, slop, the queue bound, modifiers, interruption) as a state machine that emits stroke commands.
//! - [`worker`]: the drawing worker thread that turns stroke commands into dabs and tiles.

pub mod mapping;
pub mod stroke_input;
pub mod worker;
