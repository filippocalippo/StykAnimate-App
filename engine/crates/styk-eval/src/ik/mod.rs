//! Inverse kinematics as it affects what a frame looks like.
//!
//! A pose object carries target controllers (`_stykIK`), keyed by the handle
//! they end at. A controller that is enabled and pinned derives the angles (and,
//! with stretch, the lengths) of its chain when geometry is built; everything
//! else about the pose stays authored. Nothing here mutates a document: a solve
//! returns a [`Solution`] that geometry reads in place of the pose's channels.
//!
//! | Module | Holds |
//! | --- | --- |
//! | [`solve`] | the point solver and the bend reference |
//! | [`layout`] | chains, follower branches and attachment offsets |
//! | [`object`] | the solve of every pinned controller of one skeleton |
//! | [`rig`] | the adapter to rig relationships and the inverse of a rig joint's local space |
//! | [`spatial`] | 3D target space and the quaternion helpers only IK uses |
//! | [`joined`] | assemblies of joined figures |
//! | [`interpolate`] | the tween of controllers between keys |
//! | [`parse`] | the `_stykIK` table of a pose object |
//!
//! The arithmetic follows the JavaScript operation by operation: the editor is
//! the oracle the fixtures were recorded from (frozen), see docs/engine/rigs-ik.md.

pub mod interpolate;
pub mod joined;
pub mod layout;
pub mod object;
pub mod parse;
pub mod rig;
pub mod solve;
pub mod spatial;

use std::collections::BTreeMap;
use std::f64::consts::PI;

use crate::doc::{Figure, Object};

pub use interpolate::{interpolate, tween, Channel};
pub use object::{solve_object, solve_object_with, Outcome, Pose, Skeleton, Solution};
pub use solve::{bend_reference, solve_points, Solved};

/// `MAX_IK_CHAIN`: the most bones one chain may drive.
pub const MAX_CHAIN: usize = 256;

pub(crate) const EPS: f64 = 1e-10;

/// `wrap` in src/ik.mjs: an angle difference in [-π, π). Not `atan2(sin, cos)`:
/// the two differ at ±π and in their last bits.
pub fn wrap(a: f64) -> f64 {
    let tau = 2.0 * PI;
    ((a + PI) % tau + tau) % tau - PI
}

/// `Math.sign` for the finite values the solver compares.
pub(crate) fn sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        v
    }
}

/// `Math.hypot` as V8 computes it (styk-math): `sqrt(x² + y²)` and libm's `hypot`
/// differ from it in the last bit often enough to move a solver's accept/reject decisions.
pub(crate) use styk_math::{hypot, norm};

/// Angles by handle id, in the order JavaScript enumerates integer keys.
pub type Angles = BTreeMap<u32, f64>;
/// Unit quaternions `[x, y, z, w]` by handle id.
pub type Quaternions = BTreeMap<u32, [f64; 4]>;

/// Where a controller holds its endpoint (`controller.target`): a scene
/// position and the orientation its outgoing branches keep.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Target {
    pub x: f64,
    pub y: f64,
    pub rotation: f64,
}

/// `controller.bendReference`: the continuity reference of an automatic
/// ("Both") bend, written by the editor and read by the solver.
#[derive(Clone, Debug, PartialEq)]
pub struct BendReference {
    /// Which side of the base→end axis the chain bends to (+1 or -1).
    pub side: f64,
    /// Direction from the base to the pole joint.
    pub angle: f64,
    /// Direction from the base to the endpoint.
    pub axis: f64,
    /// Endpoint distance over the chain's reach.
    pub ratio: f64,
    /// Chord directions of a chain longer than two bones.
    pub shape: Option<Vec<f64>>,
}

/// `controller.spatialTarget`: the 3D target of a two-bone spatial limb.
#[derive(Clone, Debug, PartialEq)]
pub struct SpatialTarget {
    pub depth: f64,
    pub pole: [f64; 3],
    pub swivel: f64,
    /// Bend-plane normals captured in each bone's own frame.
    pub normals: Option<[[f64; 3]; 2]>,
}

/// One target controller (`object._stykIK[handle]` in src/ik.mjs).
#[derive(Clone, Debug, PartialEq)]
pub struct Controller {
    pub enabled: bool,
    pub pinned: bool,
    pub allow_stretch: bool,
    /// Bones counted from the endpoint toward the root.
    pub chain_length: u32,
    /// 1 and -1 choose a side; 0 ("Both") continues from [`BendReference`].
    pub bend_direction: f64,
    pub target: Target,
    /// Outgoing branch angles relative to the target rotation, by handle.
    pub followers: Angles,
    /// Legacy tables: branch angles relative to the endpoint bone.
    pub attachment_offsets: Option<Angles>,
    /// `followers` of branches that belong to joined figures, by figure uid.
    pub joined_followers: Option<BTreeMap<u32, Angles>>,
    pub joined_attachment_offsets: Option<BTreeMap<u32, Angles>>,
    /// Outgoing spatial bones' orientations relative to the target rotation.
    pub spatial_followers: Option<Quaternions>,
    pub joined_spatial_followers: Option<BTreeMap<u32, Quaternions>>,
    pub spatial_target: Option<SpatialTarget>,
    pub bend_reference: Option<BendReference>,
}

impl Controller {
    /// Whether geometry derives this controller's chain (`enabled && pinned`).
    pub fn active(&self) -> bool {
        self.enabled && self.pinned
    }
}

/// The controllers of one pose object (`object._stykIK`), by endpoint handle.
/// A `BTreeMap` iterates like `Object.entries` does for integer keys.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Table {
    pub controllers: BTreeMap<u32, Controller>,
}

impl Table {
    pub fn get(&self, handle: u32) -> Option<&Controller> {
        self.controllers.get(&handle)
    }

    /// `hasPinnedIK`: whether any controller is solved when geometry is built.
    pub fn has_pinned(&self) -> bool {
        self.controllers.values().any(Controller::active)
    }
}

/// `hasPinnedIK(object)`.
pub fn has_pinned(object: &Object) -> bool {
    object.ik.as_ref().is_some_and(|table| table.has_pinned())
}

/// `animationRotation(figure, object)`: how far the pose turned the figure from its rest
/// angle (its first bone's, or its animation origin's rotation reference).
pub fn figure_angle(figure: &Figure, object: &Object) -> f64 {
    crate::origin::rotation(figure, object)
}

/// The derived pose of one object: what `evaluateIKPose` returns for a figure
/// solved on its own. `None` when no controller is pinned (the pose is drawn as
/// authored). Objects of a joined assembly take their solution from
/// [`joined::solve`] instead.
pub fn solve_local(figure: &Figure, object: &Object, root: [f64; 2]) -> Option<Solution> {
    let table = object.ik.as_ref().filter(|table| table.has_pinned())?;
    let angles: Vec<f64> = figure.segments.iter().enumerate().map(|(i, s)| object.angles.get(i).copied().unwrap_or(s.angle)).collect();
    let skeleton = Skeleton { segments: &figure.segments, plan: &figure.plan, polygons: &figure.polyfills, sources: None };
    let pose = Pose {
        scale: object.scale,
        angles: &angles,
        lengths: object.lengths.as_deref(),
        bends: object.bends.as_deref(),
        mirror: object.image_text_flags,
        figure_angle: figure_angle(figure, object),
        shape: object.spatial.as_ref().and_then(|s| s.shape.as_ref()),
    };
    solve_object(&skeleton, &pose, root, table)
}
