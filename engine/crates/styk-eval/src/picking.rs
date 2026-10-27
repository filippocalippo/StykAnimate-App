//! Numeric canvas handle queries over already prepared geometry. This module
//! borrows the owning frame and scene; it never evaluates, shapes or rebuilds a
//! missing object. A caller can retain the returned descriptors for overlays and
//! repeated pointer queries without serializing the geometry they came from.

use std::collections::HashSet;

use crate::doc::{Figure, Object};
use crate::eval::Frame;
use crate::geometry::{ObjectGeometry, Scene};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Origin,
    Segment,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Origin => "origin",
            Self::Segment => "segment",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Move,
    Pose,
    Select,
}

impl Action {
    pub fn name(self) -> &'static str {
        match self {
            Self::Move => "move",
            Self::Pose => "pose",
            Self::Select => "select",
        }
    }
}

/// Only what the existing handle painter and pointer routing consume. No
/// geometry, document values, JavaScript callbacks or browser state are copied.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Handle {
    /// Routing into the same prepared scene, replacing the source's geometry
    /// reference. Overlay descriptor transport does not need this field.
    pub slot: u32,
    pub uid: u32,
    pub joint: i32,
    pub id: u32,
    pub kind: Kind,
    pub point: [f64; 2],
    pub selected: bool,
    pub joined: bool,
    pub is_static: bool,
    pub ik: bool,
    pub connector: bool,
    pub action: Action,
    /// RGB bytes in the existing overlay's colour space.
    pub color: [u8; 3],
    pub radius: f64,
    pub screen_radius: f64,
}

/// Each UID's contiguous descriptor range, in native painter order. Empty
/// artwork can still have a range, and a fully hidden group can be empty.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Group {
    pub uid: u32,
    pub offset: usize,
    pub count: usize,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Handles {
    pub handles: Vec<Handle>,
    pub groups: Vec<Group>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpatialMode {
    #[default]
    Pose,
    Rotate,
    Figure,
}

/// The actual canvas owner's options. Membership tables are borrowed, so a
/// dense selection does not turn a pointer query into quadratic scanning.
#[derive(Clone, Copy, Debug)]
pub struct HandleOptions<'a> {
    pub selected_uid: Option<u32>,
    pub selected_uids: Option<&'a HashSet<u32>>,
    pub selected_joint: i32,
    pub selected_handle_ids: Option<&'a HashSet<u32>>,
    pub selected_branch: bool,
    pub builder: bool,
    pub hidden_uids: Option<&'a HashSet<u32>>,
    pub locked_uids: Option<&'a HashSet<u32>>,
    pub show_unselected: bool,
    pub show_static: bool,
    pub attaching: bool,
    pub allow_static_manipulation: bool,
    pub select_static: bool,
    pub join_target_uids: Option<&'a HashSet<u32>>,
    pub spatial_mode: SpatialMode,
    pub show_detailed: bool,
    pub view_scale: f64,
    pub auto_size: bool,
    pub min_diameter: f64,
    pub max_diameter: f64,
}

impl Default for HandleOptions<'_> {
    fn default() -> Self {
        Self {
            selected_uid: None,
            selected_uids: None,
            selected_joint: -1,
            selected_handle_ids: None,
            selected_branch: false,
            builder: false,
            hidden_uids: None,
            locked_uids: None,
            show_unselected: true,
            show_static: false,
            attaching: false,
            allow_static_manipulation: false,
            select_static: false,
            join_target_uids: None,
            spatial_mode: SpatialMode::Pose,
            show_detailed: false,
            view_scale: 1.0,
            auto_size: true,
            min_diameter: 4.0,
            max_diameter: 10.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueryError {
    /// A filtered/cold snapshot lacks this queried object's geometry or its
    /// exact resolved definition. Publish a prepared snapshot before querying.
    NotReady { slot: usize },
    /// The supplied frame's painter order names an absent object.
    InvalidFrame { slot: usize },
    /// The supplied all-joint traversal is not a complete permutation of the
    /// frame's slots. Never replace the source's order with painter/slot order.
    InvalidOrder,
}

fn contains(set: Option<&HashSet<u32>>, value: u32) -> bool {
    set.is_some_and(|set| set.contains(&value))
}

// Math.min/max propagate NaN, whereas Rust's f64::min/max ignore it.
fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

fn clamp(value: f64, low: f64, high: f64) -> f64 {
    min(high, max(low, value))
}

fn is_static(figure: &Figure, index: usize) -> bool {
    // Virtual clip handles are synthetic segments, without `static`, even if
    // their source definition carried the bit. The editor's clip owner decides.
    figure.movieclip.is_none() && figure.segments[index].is_static
}

/// Both native size clamps, using the existing build's solved scaled lengths.
/// The incoming bone is omitted when its own parent is static; all outgoing
/// bones still contribute. Connector handles use a fixed diameter in `handles`.
fn radius(geometry: &ObjectGeometry, figure: &Figure, object: &Object, id: u32, options: &HandleOptions<'_>) -> f64 {
    let scale = object.scale.abs();
    let mut length = f64::INFINITY;
    let mut thickness = f64::INFINITY;
    let candidate = |index: usize| {
        let segment = &figure.segments[index];
        let posed = geometry.lengths[index];
        let l = if posed.is_finite() && scale > 0.0 {
            posed.abs() / scale
        } else {
            object.lengths.as_ref().and_then(|lengths| lengths.get(index)).copied().unwrap_or(segment.length)
        };
        (l, segment.thickness)
    };
    if let Some(&index) = figure.plan.index_of.get(&id) {
        let parent = figure.plan.parent[index as usize];
        if parent == u32::MAX || !is_static(figure, parent as usize) {
            let (l, t) = candidate(index as usize);
            length = min(length, l);
            thickness = min(thickness, t);
        }
    }
    // Reuse the existing plan instead of scanning the whole tree per endpoint.
    // Only the free origin needs the root list, once per figure.
    let roots;
    let outgoing = if let Some(&index) = figure.plan.index_of.get(&id) {
        &figure.plan.children[figure.plan.child_start[index as usize] as usize..figure.plan.child_start[index as usize + 1] as usize]
    } else {
        roots = figure.segments.iter().enumerate().filter_map(|(index, segment)| (segment.parent == id).then_some(index as u32)).collect::<Vec<_>>();
        &roots
    };
    for &index in outgoing {
        let (l, t) = candidate(index as usize);
        length = min(length, l);
        thickness = min(thickness, t);
        if length == 0.0 && thickness == 0.0 {
            break;
        }
    }
    let diameter = (if options.auto_size { 0.7 * length } else { max(0.7 * length, 1.4 * thickness) }) * scale;
    let base = 0.5 * clamp(if diameter.is_nan() { options.max_diameter } else { diameter }, options.min_diameter, options.max_diameter);
    clamp(base * options.view_scale.abs(), options.min_diameter / 2.0, options.max_diameter / 2.0)
}

fn color(selected: bool, active: bool, origin: bool, joined: bool, static_: bool) -> [u8; 3] {
    if selected && active && !origin {
        if joined { [255, 214, 214] } else if static_ { [204, 68, 68] } else { [255, 102, 102] }
    } else if joined {
        if selected { [255, 255, 255] } else { [211, 211, 211] }
    } else if static_ {
        if selected { [176, 64, 64] } else { [128, 128, 128] }
    } else if !selected {
        if origin { [0, 128, 255] } else { [0, 0, 255] }
    } else if origin {
        [255, 136, 0]
    } else {
        [255, 0, 0]
    }
}

fn ready<'a>(scene: &'a Scene, frame: &Frame, slot: usize) -> Result<(&'a ObjectGeometry, &'a Figure), QueryError> {
    let object = frame.objects.get(slot).ok_or(QueryError::InvalidFrame { slot })?;
    let geometry = scene.objects.get(slot).filter(|g| g.resolved && g.uid == object.uid && g.figure == object.figure).ok_or(QueryError::NotReady { slot })?;
    let figure = scene.figure_for(slot).filter(|f| f.id == object.figure).ok_or(QueryError::NotReady { slot })?;
    let count = figure.segments.len();
    if geometry.ends.len() != count || geometry.starts.len() != count || geometry.lengths.len() != count {
        return Err(QueryError::NotReady { slot });
    }
    Ok((geometry, figure))
}

/// Authoritative frame order, then remaining slots; origins precede their own
/// stable z-sorted endpoints. A readiness error returns no partial descriptors.
pub fn handles(scene: &Scene, frame: &Frame, options: &HandleOptions<'_>) -> Result<Handles, QueryError> {
    let mut result = Handles::default();
    let mut order = Vec::with_capacity(frame.objects.len());
    let mut seen = vec![false; frame.objects.len()];
    for &slot in &frame.draw_order {
        let slot = slot as usize;
        let entry = seen.get_mut(slot).ok_or(QueryError::InvalidFrame { slot })?;
        *entry = true;
        order.push(slot);
    }
    order.extend(seen.iter().enumerate().filter_map(|(slot, seen)| (!seen).then_some(slot)));
    let mut targets = vec![HashSet::new(); frame.objects.len()];
    for object in &frame.objects {
        if let Some(join) = object.join {
            if let Some(targets) = targets.get_mut(join.slot as usize) {
                targets.insert(join.handle);
            }
        }
    }
    for slot in order {
        let object = &frame.objects[slot];
        let uid = object.uid;
        if contains(options.hidden_uids, uid) || contains(options.locked_uids, uid)
            || options.attaching && options.join_target_uids.is_some_and(|set| !set.contains(&uid))
        {
            continue;
        }
        let (geometry, figure) = ready(scene, frame, slot)?;
        let selected = options.selected_uid == Some(uid) || contains(options.selected_uids, uid);
        let all_endpoints = selected || options.show_unselected || object.join.is_some() || options.attaching;
        let primary = options.selected_uid == Some(uid);
        let selected_joint = options.selected_joint >= 0 && (options.selected_joint as usize) < figure.segments.len();
        let mut active = HashSet::new();
        if primary && selected_joint {
            if let Some(ids) = options.selected_handle_ids.filter(|ids| !ids.is_empty()) {
                active.extend(figure.segments.iter().enumerate().filter_map(|(index, segment)| ids.contains(&segment.id).then_some(index)));
            } else {
                active.insert(options.selected_joint as usize);
            }
            if options.selected_branch {
                let mut queue = vec![options.selected_joint as usize];
                let mut at = 0;
                while at < queue.len() {
                    let index = queue[at];
                    for &child in &figure.plan.children[figure.plan.child_start[index] as usize..figure.plan.child_start[index + 1] as usize] {
                        if active.insert(child as usize) {
                            queue.push(child as usize);
                        }
                    }
                    at += 1;
                }
            }
        }
        let rotate_spatial = !options.builder && selected && options.spatial_mode != SpatialMode::Pose;
        let scale = max(1e-9, options.view_scale.abs());
        let offset = result.handles.len();
        let mut add = |joint: i32, id: u32, kind: Kind, static_: bool, joined: bool| {
            let origin = kind == Kind::Origin;
            let index = joint as usize;
            let spatial = !origin && rotate_spatial && geometry.spatial.as_ref().is_some_and(|s| s.frames.get(index).is_some_and(Option::is_some));
            let connector = !origin && geometry.rig.as_ref().is_some_and(|rig| rig.get(index).is_some_and(|r| r.connector));
            let screen_radius = if connector { options.max_diameter / 2.0 } else { radius(geometry, figure, object, id, options) };
            let ik = !options.builder && object.ik.as_ref().is_some_and(|table| table.get(id).is_some_and(|controller| controller.enabled));
            let point = if origin { geometry.root } else if spatial { geometry.starts[index] } else { geometry.ends[index] };
            let action = if spatial { Action::Select } else if origin { Action::Move }
                else if static_ && !ik && !options.attaching && !options.allow_static_manipulation { Action::Select } else { Action::Pose };
            let color = if options.attaching {
                if static_ { [255, 255, 255] } else if origin { [255, 136, 0] } else { [255, 0, 0] }
            } else if options.builder && static_ && !joined && !active.contains(&index) {
                [153, 153, 153]
            } else {
                color(selected, active.contains(&index), origin, joined, static_)
            };
            result.handles.push(Handle { slot: slot as u32, uid, joint, id, kind, point, selected, joined, is_static: static_, ik, connector, action, color, radius: screen_radius / scale, screen_radius });
        };
        if object.join.is_none() {
            add(-1, 0, Kind::Origin, false, false);
        }
        let mut ordered: Vec<usize> = (0..figure.segments.len()).collect();
        ordered.sort_by(|&a, &b| figure.segments[a].z.partial_cmp(&figure.segments[b].z).unwrap_or(std::cmp::Ordering::Equal));
        for index in ordered {
            let segment = &figure.segments[index];
            let static_ = is_static(figure, index);
            let ik = object.ik.as_ref().is_some_and(|table| table.get(segment.id).is_some_and(|controller| controller.enabled));
            if static_ && !options.show_static && !options.select_static && !options.attaching && !active.contains(&index) && !ik {
                continue;
            }
            let joined = targets[slot].contains(&segment.id);
            if segment.control_detail && !options.show_detailed && !options.builder && !options.attaching && !joined
                && !(primary && options.selected_joint == index as i32)
            {
                continue;
            }
            if all_endpoints || joined || options.select_static && static_ {
                add(index as i32, segment.id, Kind::Segment, static_, joined);
            }
        }
        result.groups.push(Group { uid, offset, count: result.handles.len() - offset });
    }
    Ok(result)
}

/// A numeric affine projection already produced by the canvas camera owner.
/// Arbitrary JavaScript callback projections are not represented by this API.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Projection(pub [f64; 6]);

impl Projection {
    pub const IDENTITY: Self = Self([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    pub fn point(self, point: [f64; 2]) -> [f64; 2] {
        let [a, b, c, d, e, f] = self.0;
        [a * point[0] + c * point[1] + e, b * point[0] + d * point[1] + f]
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PickOptions {
    pub nearest: bool,
    pub preferred_uid: Option<u32>,
    pub min_radius: f64,
    pub radius: Option<f64>,
    pub projection: Option<Projection>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    /// Index into the caller's retained descriptor array.
    pub handle: usize,
    pub distance_squared: f64,
}

/// Native reverse painter priority, strict square/circle boundaries and optional
/// preferred UID. A nonfinite input point has the JavaScript owner's null result.
pub fn pick_handle(handles: &[Handle], point: [f64; 2], options: &PickOptions) -> Option<Hit> {
    if !point.iter().all(|v| v.is_finite()) {
        return None;
    }
    let project = |p| options.projection.map_or(p, |projection| projection.point(p));
    let p = project(point);
    let mut best: Option<Hit> = None;
    for (index, handle) in handles.iter().enumerate().rev() {
        let center = project(handle.point);
        let radius = max(options.min_radius, options.radius.unwrap_or(if options.projection.is_some() { handle.screen_radius } else { handle.radius }));
        let dx = p[0] - center[0];
        let dy = p[1] - center[1];
        let distance_squared = dx * dx + dy * dy;
        let inside = if options.nearest { distance_squared < radius * radius } else { dx.abs() < radius && dy.abs() < radius };
        if !inside {
            continue;
        }
        let hit = Hit { handle: index, distance_squared };
        if !options.nearest && options.preferred_uid.is_none() {
            return Some(hit);
        }
        let preferred = options.preferred_uid == Some(handle.uid);
        let best_preferred = best.is_some_and(|hit| options.preferred_uid == Some(handles[hit.handle].uid));
        if best.is_none() || preferred && !best_preferred || preferred == best_preferred && options.nearest && distance_squared < best.unwrap().distance_squared {
            best = Some(hit);
        }
    }
    best
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// Origin marquee selection is an inclusive projected-root test, independent
/// of artwork alpha/bounds. Missing queried geometry is a readiness error.
pub fn origin_intersects_marquee(scene: &Scene, frame: &Frame, slot: usize, rect: Rect, projection: Projection) -> Result<bool, QueryError> {
    let (geometry, _) = ready(scene, frame, slot)?;
    let [x, y] = projection.point(geometry.root);
    Ok(x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
}

/// Inclusive marquee overlap with the existing bounds owner's measured box.
/// `bounds` uses world-space min/max coordinates; it is never reconstructed from
/// handle extents or drawable geometry here. The host must pair the measurement
/// with this exact ready scene/resource identity. Missing measurements or cold
/// geometry refuse without evaluating or changing either borrowed input.
///
/// Hidden/locked membership and the pointer's three CSS pixel slop stay with the
/// caller, as in the actual canvas owner. All four projected corners matter for
/// rotated or reflected views. Nonfinite numeric values keep JavaScript's
/// arithmetic/comparison behavior rather than being silently normalized.
pub fn bounds_intersects_marquee(scene: &Scene, frame: &Frame, slot: usize, bounds: Option<Rect>, rect: Rect, projection: Projection) -> Result<bool, QueryError> {
    ready(scene, frame, slot)?;
    let bounds = bounds.ok_or(QueryError::NotReady { slot })?;
    let a = projection.point([bounds.left, bounds.top]);
    let b = projection.point([bounds.right, bounds.top]);
    let c = projection.point([bounds.right, bounds.bottom]);
    let d = projection.point([bounds.left, bounds.bottom]);
    Ok(max(max(max(a[0], b[0]), c[0]), d[0]) >= rect.left && min(min(min(a[0], b[0]), c[0]), d[0]) <= rect.right &&
        max(max(max(a[1], b[1]), c[1]), d[1]) >= rect.top && min(min(min(a[1], b[1]), c[1]), d[1]) <= rect.bottom)
}

/// The exact source geometry-map traversal, borrowed from an already prepared
/// query snapshot. Construction validates it once with temporary scratch; no
/// scene field/cache or per-pointer allocation is retained. The producer owns
/// the order's document/draft/display identity and incremental append semantics.
pub struct JointOrder<'a> {
    scene: &'a Scene,
    frame: &'a Frame,
    slots: &'a [u32],
}

impl<'a> JointOrder<'a> {
    pub fn new(scene: &'a Scene, frame: &'a Frame, ordered_slots: &'a [u32]) -> Result<Self, QueryError> {
        if ordered_slots.len() != frame.objects.len() { return Err(QueryError::InvalidOrder); }
        let mut seen = vec![false; frame.objects.len()];
        for &slot in ordered_slots {
            let Some(seen) = seen.get_mut(slot as usize) else { return Err(QueryError::InvalidOrder); };
            if std::mem::replace(seen, true) { return Err(QueryError::InvalidOrder); }
        }
        Ok(Self {scene, frame, slots: ordered_slots})
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ClosestJointOptions<'a> {
    pub uid: Option<u32>,
    pub excluded_uid: Option<u32>,
    pub hidden_uids: Option<&'a HashSet<u32>>,
    pub locked_uids: Option<&'a HashSet<u32>>,
    /// Source threshold is ten CSS pixels divided by this exact view scale.
    pub view_scale: f64,
}

impl Default for ClosestJointOptions<'_> {
    fn default() -> Self { Self {uid: None, excluded_uid: None, hidden_uids: None, locked_uids: None, view_scale: 1.0} }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct JointHit {
    pub slot: u32,
    pub uid: u32,
    pub joint: i32,
    pub id: u32,
    pub point: [f64; 2],
}

/// The app's `closestHandle`: all joints, including joined roots, static and
/// invisible nodes. The radius is inclusive, and later equal-distance joints
/// in the supplied geometry-map order win. This is not exposed-handle picking
/// or construction KD nearest; both have distinct owning selection contracts.
/// Numeric nonfinite behavior follows the source, which has no finite guard.
pub fn closest_joint(order: &JointOrder<'_>, point: [f64; 2], options: &ClosestJointOptions<'_>) -> Result<Option<JointHit>, QueryError> {
    let radius = 10.0 / options.view_scale;
    let mut distance = radius * radius;
    let mut hit = None;
    for &slot in order.slots {
        let slot = slot as usize;
        let object = &order.frame.objects[slot];
        if options.excluded_uid == Some(object.uid) || options.uid.is_some_and(|uid| uid != object.uid) ||
            contains(options.hidden_uids, object.uid) || contains(options.locked_uids, object.uid) { continue; }
        let (geometry, figure) = ready(order.scene, order.frame, slot)?;
        let mut visit = |id, joint, candidate: [f64; 2]| {
            let dx = candidate[0] - point[0];
            let dy = candidate[1] - point[1];
            let d = dx * dx + dy * dy;
            if d <= distance {
                distance = d;
                hit = Some(JointHit {slot: slot as u32, uid: object.uid, joint, id, point: candidate});
            }
        };
        visit(0, -1, geometry.root);
        let joints = figure.plan.rig.as_ref().map_or(&figure.plan.order, |rig| &rig.order);
        for &index in joints {
            let index = index as usize;
            let segment = figure.segments.get(index).ok_or(QueryError::NotReady {slot})?;
            let point = *geometry.ends.get(index).ok_or(QueryError::NotReady {slot})?;
            visit(segment.id, index as i32, point);
        }
    }
    Ok(hit)
}

#[derive(Clone, Copy, Debug)]
pub struct SegmentPickOptions {
    pub uid: Option<u32>,
    pub scale: f64,
    pub padding: f64,
}

impl Default for SegmentPickOptions {
    fn default() -> Self {
        Self { uid: None, scale: 1.0, padding: 8.0 }
    }
}

fn raw_ready<'a>(scene: &'a Scene, frame: &Frame, slot: usize) -> Result<(&'a ObjectGeometry, &'a Figure), QueryError> {
    let (geometry, figure) = ready(scene, frame, slot)?;
    if geometry.raw_segments.len() != figure.segments.len() {
        return Err(QueryError::NotReady { slot });
    }
    Ok((geometry, figure))
}

fn raw_points<'a>(scene: &'a Scene, geometry: &ObjectGeometry, index: usize, straight: &'a mut [[f64; 2]; 2]) -> Result<&'a [[f64; 2]], QueryError> {
    let raw = geometry.raw_segments[index];
    let points = scene.points.get(raw.points.0 as usize..raw.points.1 as usize).ok_or(QueryError::NotReady {slot: geometry.slot as usize})?;
    if raw.points.0 == raw.points.1 {
        *straight = [geometry.starts[index], raw.drawing_end];
        Ok(straight)
    } else {
        Ok(points)
    }
}

/// Click-only expansion of movable raw line targets; the endpoint descriptor
/// still owns the pose action. Visibility, alpha and permissions come from the
/// same typed owners; Stick Nodes drawable expansion is not used as a proxy.
pub fn pick_segment(scene: &Scene, frame: &Frame, handles: &[Handle], point: [f64; 2], options: &SegmentPickOptions) -> Result<Option<Hit>, QueryError> {
    if !point.iter().all(|v| v.is_finite()) {
        return Ok(None);
    }
    let pad = options.padding / max(0.01, options.scale.abs());
    for (index, handle) in handles.iter().enumerate().rev() {
        if options.uid.is_some_and(|uid| uid != handle.uid) || handle.action != Action::Pose || handle.joint < 0 {
            continue;
        }
        let slot = handle.slot as usize;
        let (geometry, figure) = raw_ready(scene, frame, slot)?;
        if geometry.uid != handle.uid {
            return Err(QueryError::NotReady { slot });
        }
        if figure.movieclip.is_some() {
            continue;
        }
        let joint = handle.joint as usize;
        let segment = figure.segments.get(joint).ok_or(QueryError::NotReady { slot })?;
        if segment.id != handle.id {
            return Err(QueryError::NotReady { slot });
        }
        let raw = geometry.raw_segments[joint];
        if !matches!(segment.prim, crate::doc::Prim::Line | crate::doc::Prim::SquareLine) || !segment.visible
            || !(raw.thickness > 0.0) || !(segment.alpha > 0.0) || !(geometry.opacity > 0.0)
        {
            continue;
        }
        let radius = raw.thickness / 2.0 + pad;
        let mut straight = [[0.0; 2]; 2];
        let points = raw_points(scene, geometry, joint, &mut straight)?;
        for pair in points.windows(2) {
            let [a, b] = [pair[0], pair[1]];
            let dx = b[0] - a[0];
            let dy = b[1] - a[1];
            let length_squared = dx * dx + dy * dy;
            let t = if length_squared != 0.0 { clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length_squared, 0.0, 1.0) } else { 0.0 };
            let x = point[0] - a[0] - t * dx;
            let y = point[1] - a[1] - t * dy;
            let distance_squared = x * x + y * y;
            if distance_squared <= radius * radius {
                return Ok(Some(Hit { handle: index, distance_squared }));
            }
        }
    }
    Ok(None)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapKind {
    Joint,
    Midpoint,
    Align,
    Length,
}

impl SnapKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Joint => "Joint", Self::Midpoint => "Midpoint", Self::Align => "Align", Self::Length => "Length",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnapPoint {
    pub point: [f64; 2],
    pub id: Option<u32>,
    pub kind: Option<SnapKind>,
}

#[derive(Clone, Copy, Debug)]
struct Node {
    point: usize,
    axis: usize,
    left: Option<usize>,
    right: Option<usize>,
}

/// The existing construction tool's gesture-local index and latch. It is built
/// from one prepared object's joints/raw lines, never unrelated scene geometry.
/// Prepare it off UI for dense figures; no global index/cache is introduced.
pub struct ConstructionIndex {
    points: Vec<SnapPoint>,
    axes: [Vec<usize>; 2],
    lengths: Vec<f64>,
    nodes: Vec<Node>,
    root: Option<usize>,
    latched: Option<SnapPoint>,
}

fn compare(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
}

fn tree(points: &[SnapPoint], indices: &mut [usize], depth: usize, nodes: &mut Vec<Node>) -> Option<usize> {
    if indices.is_empty() {
        return None;
    }
    let axis = depth % 2;
    indices.sort_by(|&a, &b| compare(points[a].point[axis], points[b].point[axis]));
    let middle = indices.len() >> 1;
    let index = nodes.len();
    nodes.push(Node { point: indices[middle], axis, left: None, right: None });
    let (left, right) = indices.split_at_mut(middle);
    nodes[index].left = tree(points, left, depth + 1, nodes);
    nodes[index].right = tree(points, &mut right[1..], depth + 1, nodes);
    Some(index)
}

fn lower_bound(indices: &[usize], value: f64, points: &[SnapPoint], axis: usize) -> usize {
    let mut lo = 0;
    let mut hi = indices.len();
    while lo < hi {
        let middle = (lo + hi) >> 1;
        if points[indices[middle]].point[axis] < value { lo = middle + 1 } else { hi = middle }
    }
    lo
}

impl ConstructionIndex {
    pub fn new(scene: &Scene, frame: &Frame, slot: usize, excluded: &HashSet<u32>) -> Result<Self, QueryError> {
        let (geometry, figure) = raw_ready(scene, frame, slot)?;
        let mut points = Vec::new();
        let mut lengths = Vec::new();
        if !excluded.contains(&0) {
            points.push(SnapPoint { point: geometry.root, id: Some(0), kind: Some(SnapKind::Joint) });
        }
        let order = figure.plan.rig.as_ref().map_or(&figure.plan.order, |rig| &rig.order);
        for &index in order {
            let index = index as usize;
            let id = figure.segments[index].id;
            if !excluded.contains(&id) {
                points.push(SnapPoint { point: geometry.ends[index], id: Some(id), kind: Some(SnapKind::Joint) });
            }
        }
        for (index, segment) in figure.segments.iter().enumerate() {
            if excluded.contains(&segment.id) {
                continue;
            }
            let mut straight = [[0.0; 2]; 2];
            let raw = raw_points(scene, geometry, index, &mut straight)?;
            let middle = (raw.len() - 1) as f64 / 2.0;
            let a = raw[middle.floor() as usize];
            let b = raw[middle.ceil() as usize];
            points.push(SnapPoint { point: [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0], id: None, kind: Some(SnapKind::Midpoint) });
            let end = geometry.raw_segments[index].drawing_end;
            let start = geometry.starts[index];
            lengths.push(styk_math::hypot(end[0] - start[0], end[1] - start[1]));
        }
        let mut axes = [Vec::new(), Vec::new()];
        for axis in 0..2 {
            axes[axis] = (0..points.len()).collect();
            axes[axis].sort_by(|&a, &b| compare(points[a].point[axis], points[b].point[axis]));
        }
        lengths.sort_by(|&a, &b| compare(a, b));
        let mut nodes = Vec::with_capacity(points.len());
        let mut indices: Vec<_> = (0..points.len()).collect();
        let root = tree(&points, &mut indices, 0, &mut nodes);
        Ok(Self { points, axes, lengths, nodes, root, latched: None })
    }

    pub fn nearest(&self, point: [f64; 2], radius: f64, joints_only: bool) -> Option<SnapPoint> {
        fn visit(index: &ConstructionIndex, node: Option<usize>, point: [f64; 2], joints_only: bool, best: &mut Option<SnapPoint>, distance: &mut f64) {
            let Some(node) = node else { return };
            let node = index.nodes[node];
            let candidate = index.points[node.point];
            let delta = point[node.axis] - candidate.point[node.axis];
            let (first, last) = if delta < 0.0 { (node.left, node.right) } else { (node.right, node.left) };
            visit(index, first, point, joints_only, best, distance);
            let dx = point[0] - candidate.point[0];
            let dy = point[1] - candidate.point[1];
            let d = dx * dx + dy * dy;
            if d <= *distance && (!joints_only || candidate.kind == Some(SnapKind::Joint)) {
                *best = Some(candidate);
                *distance = d;
            }
            if delta * delta < *distance {
                visit(index, last, point, joints_only, best, distance);
            }
        }
        let mut best = None;
        let mut distance = radius * radius;
        visit(self, self.root, point, joints_only, &mut best, &mut distance);
        best
    }

    pub fn snap(&mut self, point: [f64; 2], radius: f64, origin: Option<[f64; 2]>, disabled: bool) -> SnapPoint {
        let mut result = SnapPoint { point, id: None, kind: None };
        if disabled {
            self.latched = None;
            return result;
        }
        let joint = self.nearest(point, radius, true);
        let held = self.latched.filter(|held| styk_math::hypot(point[0] - held.point[0], point[1] - held.point[1]) <= radius * 1.4);
        let nearest = joint.or(held).or_else(|| self.nearest(point, radius, false));
        self.latched = nearest;
        if let Some(nearest) = nearest {
            return nearest;
        }
        for axis in 0..2 {
            let values = &self.axes[axis];
            let i = lower_bound(values, point[axis], &self.points, axis);
            let mut choices = Vec::with_capacity(3);
            if let Some(&index) = values.get(i) { choices.push(self.points[index].point) }
            if i > 0 { choices.push(self.points[values[i - 1]].point) }
            if let Some(origin) = origin { choices.push(origin) }
            choices.sort_by(|a, b| compare((a[axis] - point[axis]).abs(), (b[axis] - point[axis]).abs()));
            if let Some(choice) = choices.first().filter(|choice| (choice[axis] - point[axis]).abs() <= radius) {
                result.point[axis] = choice[axis];
                result.kind = Some(SnapKind::Align);
            }
        }
        if result.kind.is_none() && let Some(origin) = origin {
            let length = styk_math::hypot(point[0] - origin[0], point[1] - origin[1]);
            let mut lo = 0;
            let mut hi = self.lengths.len();
            while lo < hi {
                let middle = (lo + hi) >> 1;
                if self.lengths[middle] < length { lo = middle + 1 } else { hi = middle }
            }
            let mut choices = Vec::with_capacity(2);
            if let Some(&candidate) = self.lengths.get(lo).filter(|candidate| candidate.is_finite()) { choices.push(candidate) }
            if lo > 0 && self.lengths[lo - 1].is_finite() { choices.push(self.lengths[lo - 1]) }
            choices.sort_by(|&a, &b| compare((a - length).abs(), (b - length).abs()));
            if let Some(target) = choices.first().filter(|&target| length > radius && (*target - length).abs() <= radius) {
                let ratio = target / length;
                result.point = [origin[0] + (point[0] - origin[0]) * ratio, origin[1] + (point[1] - origin[1]) * ratio];
                result.kind = Some(SnapKind::Length);
            }
        }
        result
    }
}
