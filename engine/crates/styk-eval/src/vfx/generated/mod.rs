//! Generated effects: particles, auras, energy beams, explosions and smoke
//! (docs/engine/vfx.md, Generated effects).
//!
//! Each frame, the generator clips active at its tick (and those of movieclips
//! drawn in it) compile into layers ([`styles`]), which [`batch::build`] packs
//! into one [`Batch`]: a draw per layer and a table of per-tick birth values
//! and outlines. A particle is a pure function of its draw, the table, its
//! instance index and the tick ([`particle::Evaluator`]): nothing is simulated or
//! kept between frames. Where a target was on earlier ticks comes from a
//! [`Sampler`] ([`anchors`]), which the engine backs with a cache.
//!
//! Drawing is the draw list's ([`crate::drawlist`]): each draw's particles
//! become records placed before or after their target's artwork.

pub mod anchors;
pub mod atlas;
pub mod batch;
pub mod fastmath;
pub mod layers;
pub mod particle;
pub mod stage;
pub mod styles;

pub use anchors::{Anchor, Evaluate, Sample, Sampler};
pub use batch::{build, build_within, clip_tail, has_generators, Batch, Draw, EDIT_DRAWN, MAX_DRAWN};
