//! Rig relationships of the selected figure's definition (src/editor-rig-constraints.mjs):
//! behaviours of a joint (stretch, follow, response, angle locks, angle paths, weighted
//! joints, attachments), Smart Stretch over a branch, angle locks measured from the figure on
//! show, and parts bound to a stretch driver. Each is one `native-properties` history entry
//! of the `_stykRig` fields it changes, validated as `rigConstraintPlan` validates a rig
//! (`validate_rig`) and refusing to bind parts an enabled IK controller drives.

use std::collections::{HashMap, HashSet};

use styk_doc::{Obj, Value};

use crate::builder::{Entry, Key};
use crate::record::num;
use crate::{EditError, Editor};

const EPS: f64 = 1e-8;
const BEHAVIORS: [&str; 9] = ["connector", "stretch", "follow", "orientation", "response", "angleLock", "anglePath", "weighted", "spatial"];

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

fn items(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}

/// `value !== undefined`: present, even when null.
fn given(value: Option<&Value>) -> bool {
    value.is_some()
}

/// `Number.isFinite(n) && n >= min && n <= max` (`number(n, label, min, max)`).
fn number(value: Option<&Value>, label: &str, min: f64, max: f64) -> Result<(), EditError> {
    match value {
        Some(Value::Num(n)) if n.is_finite() && *n >= min && *n <= max => Ok(()),
        _ => Err(crate::out_of_range("errors.cameraMotion.mustBeBetweenAnd", label, ("min", "max"), (min, max))),
    }
}

fn integer(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite() && n.fract() == 0.0)
}

fn is_plain_object(value: &Value) -> bool {
    value.is_object()
}

fn keys_within(value: &Value, allowed: &[&str]) -> bool {
    value.as_obj().is_some_and(|o| o.keys().all(|k| allowed.contains(&&**k)))
}

/// `[x, y, z]` of finite numbers no larger than 1e6.
fn vector(value: Option<&Value>) -> bool {
    value.filter(|v| v.is_array()).and_then(Value::numbers).is_some_and(|v| v.len() == 3 && v.iter().all(|n| n.is_finite() && n.abs() <= 1e6))
}

/// `spatialBone(segment)`.
fn spatial_bone(segment: Option<&Value>) -> bool {
    segment.and_then(|s| s.path(&["_stykRig", "spatial", "origin"])).is_some_and(Value::truthy)
}

/// `spatialSkin(segment)`.
fn spatial_skin(segment: &Value) -> bool {
    segment.path(&["_stykRig", "spatial", "bindings"]).is_some_and(Value::truthy)
}

/// `rigIKAllowed(figure, index)`: an existing joint the rig does not derive.
fn rig_ik_allowed(segments: &[Value], index: Option<usize>) -> bool {
    let Some(segment) = index.and_then(|i| segments.get(i)) else { return false };
    let rig = |key: &str| segment.path(&["_stykRig", key]).is_some_and(Value::truthy);
    !(spatial_skin(segment) || rig("connector") || rig("angleLock") || rig("anglePath") || rig("weighted"))
}

/// The handles a rig refers to and the order they must be evaluated in, as `rigConstraintPlan`
/// checks them.
struct Checker<'a> {
    segments: &'a [Value],
    ids: HashMap<u64, usize>,
}

/// A handle id as a key: integers only (anything else is refused before it is looked up).
fn id_key(value: Option<&Value>) -> Option<u64> {
    integer(value).filter(|n| *n >= 0.0).map(|n| n as u64)
}

impl Checker<'_> {
    /// `reference(id, label, root)`.
    fn reference(&self, id: Option<&Value>, label: &str, root: bool) -> Result<(), EditError> {
        let missing = || crate::invalid_with("errors.rigConstraints.refersToAMissingJointRemoveOrReconnect", vec![("label", crate::label(label))]);
        let Some(n) = integer(id) else { return Err(missing()) };
        let known = n >= 0.0 && self.ids.contains_key(&(n as u64));
        if !known && !(root && n == 0.0) {
            return Err(missing());
        }
        Ok(())
    }

    fn segment(&self, id: Option<&Value>) -> Option<&Value> {
        id_key(id).and_then(|k| self.ids.get(&k)).map(|&i| &self.segments[i])
    }

    /// `validateSpatial(s, reference, dependencies, segments, ids)`.
    fn spatial(&self, s: &Value, dependencies: &mut Vec<Value>) -> Result<(), EditError> {
        if !is_plain_object(s) {
            return Err(invalid("errors.rigSpatial.invalidSpatialJoint"));
        }
        let reference = |checker: &Checker, id: Option<&Value>, bone: bool, dependencies: &mut Vec<Value>| -> Result<(), EditError> {
            checker.reference(id, "Rig parent", true)?;
            add(dependencies, id);
            if id.is_some_and(Value::truthy) && bone && !spatial_bone(checker.segment(id)) {
                return Err(invalid("errors.rigSpatial.mustBeAnArticulatedSpatialJoint"));
            }
            Ok(())
        };
        if s.get("bindings").is_some_and(Value::truthy) {
            let bindings = s.get("bindings").unwrap();
            let list = items(Some(bindings));
            if !keys_within(s, &["point", "bindings", "viewPoints"]) || !vector(s.get("point")) || !bindings.is_array() || list.is_empty() || list.len() > 4 {
                return Err(invalid("errors.rigSpatial.aSkinPointNeedsAPositionAnd1"));
            }
            if let Some(views) = s.get("viewPoints") {
                let points = items(Some(views));
                if !views.is_array() || ![4, 8].contains(&points.len()) || points.iter().any(|p| !vector(Some(p))) || list.len() != 1 {
                    return Err(invalid("errors.rigSpatial.viewCorrectedSkinNeedsFourCardinalOrEight"));
                }
            }
            let mut seen: Vec<Value> = Vec::new();
            let mut sum = 0.0;
            for binding in &list {
                let weight = binding.get("weight").and_then(Value::as_f64);
                let joint = binding.get("joint").cloned().unwrap_or(Value::Null);
                if !binding.truthy() || !keys_within(binding, &["joint", "weight"]) || !weight.is_some_and(|w| w.is_finite() && w > 0.0 && w <= 1.0) || seen.iter().any(|j| same_value_zero(j, &joint)) {
                    return Err(invalid("errors.rigSpatial.skinWeightsMustUseDistinctJointsAndPositive"));
                }
                reference(self, binding.get("joint"), true, dependencies)?;
                if !joint.truthy() {
                    return Err(invalid("errors.rigSpatial.bindSkinToAnArticulatedJoint"));
                }
                seen.push(joint);
                sum += weight.unwrap();
            }
            if (sum - 1.0).abs() > 1e-6 {
                return Err(invalid("errors.rigSpatial.skinWeightsMustAddUpToOne"));
            }
        } else {
            if !keys_within(s, &["parent", "turn", "pitch", "origin", "tip", "motion"]) || !vector(s.get("origin")) || !vector(s.get("tip")) {
                return Err(invalid("errors.rigSpatial.anArticulatedJointNeedsARestOriginAnd"));
            }
            if let Some(m) = s.get("motion") {
                let bad = || invalid("errors.rigSpatial.aMechanicalJointNeedsASlideOrHinge");
                let kind = m.get("type").and_then(Value::as_str);
                let limit = if kind == Some("hinge") { 2.0 * std::f64::consts::PI } else { 1e6 };
                let bounds = [m.get("min"), m.get("max")].map(|v| v.and_then(Value::as_f64));
                let in_bounds = bounds.iter().all(|v| v.is_some_and(|v| v.is_finite() && v.abs() <= limit));
                let axis_bad = m.get("axis").is_some_and(|axis| kind != Some("hinge") || !vector(Some(axis)) || {
                    let v = axis.numbers().unwrap_or_default();
                    (styk_math::norm(&v) - 1.0).abs() > 1e-6
                });
                if !m.truthy() || !is_plain_object(m) || !keys_within(m, &["type", "min", "max", "axis", "driver"]) || !matches!(kind, Some("slide" | "hinge")) || !in_bounds || bounds[0] > bounds[1] || axis_bad {
                    return Err(bad());
                }
                if kind == Some("slide") {
                    let (origin, tip) = (s.get("origin").and_then(Value::numbers).unwrap_or_default(), s.get("tip").and_then(Value::numbers).unwrap_or_default());
                    let span = styk_math::norm(&[tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]]);
                    if span <= 1e-9 {
                        return Err(invalid("errors.rigSpatial.aSlidingJointSlidesFromItsOriginToward"));
                    }
                }
                if let Some(d) = m.get("driver") {
                    let multiplier = d.get("multiplier").and_then(Value::as_f64);
                    if !d.truthy() || !is_plain_object(d) || !keys_within(d, &["joint", "multiplier"]) || !d.get("joint").is_some_and(Value::truthy) || !multiplier.is_some_and(|x| x.is_finite() && x.abs() <= 10.0) {
                        return Err(bad());
                    }
                    reference(self, d.get("joint"), true, dependencies)?;
                    if !self.segment(d.get("joint")).and_then(|s| s.path(&["_stykRig", "spatial", "motion"])).is_some_and(Value::truthy) {
                        return Err(bad());
                    }
                }
            }
            reference(self, s.get("parent"), true, dependencies)?;
            reference(self, s.get("turn"), false, dependencies)?;
            reference(self, s.get("pitch"), false, dependencies)?;
            let (turn, pitch) = (s.get("turn").cloned().unwrap_or(Value::Null), s.get("pitch").cloned().unwrap_or(Value::Null));
            if !turn.truthy() || !pitch.truthy() || same_value_zero(&turn, &pitch) {
                return Err(invalid("errors.rigSpatial.chooseSeparateTurnAndTiltControls"));
            }
        }
        Ok(())
    }

    /// `validateWeightedJoint(value, reference, dependencies, depth)`.
    fn weighted(&self, value: &Value, dependencies: &mut Vec<Value>, depth: bool) -> Result<(), EditError> {
        let allowed: &[&str] = if depth { &["origin", "anchors"] } else { &["origin", "anchors", "depth"] };
        let anchors = value.get("anchors");
        let list = items(anchors);
        if !value.truthy() || !is_plain_object(value) || !keys_within(value, allowed) || !anchors.is_some_and(Value::is_array) || list.is_empty() || list.len() > 16 {
            return Err(invalid("errors.rigWeighted.aWeightedJointRequires116Anchors"));
        }
        self.reference(value.get("origin"), "Weighted origin", true)?;
        add(dependencies, value.get("origin"));
        let mut seen: Vec<Value> = Vec::new();
        let origin = value.get("origin").cloned().unwrap_or(Value::Null);
        for anchor in &list {
            if !anchor.truthy() || !is_plain_object(anchor) || !keys_within(anchor, &["joint", "weight"]) {
                return Err(invalid("errors.rigWeighted.invalidWeightedAnchor"));
            }
            self.reference(anchor.get("joint"), "Weighted anchor", true)?;
            add(dependencies, anchor.get("joint"));
            let joint = anchor.get("joint").cloned().unwrap_or(Value::Null);
            if seen.iter().any(|j| same_value_zero(j, &joint)) || same_value_zero(&joint, &origin) {
                return Err(invalid("errors.rigWeighted.chooseDistinctWeightedAnchorsOutsideTheOrigin"));
            }
            seen.push(joint);
            if !anchor.get("weight").and_then(Value::as_f64).is_some_and(|w| w.is_finite() && w.abs() <= 100.0) {
                return Err(invalid("errors.rigWeighted.anchorWeightMustBeBetween100And100"));
            }
        }
        if let Some(inner) = value.get("depth") {
            self.weighted(inner, dependencies, true)?;
        }
        Ok(())
    }

    /// `validateAnglePath(path, reference, dependencies)`.
    fn angle_path(&self, path: &Value, dependencies: &mut Vec<Value>) -> Result<(), EditError> {
        if !path.truthy() || !is_plain_object(path) {
            return Err(invalid("errors.rigAnglePath.invalidAnglePath"));
        }
        if let Some(source) = path.get("source") {
            if !keys_within(path, &["source"]) {
                return Err(invalid("errors.rigAnglePath.aDepthGuideOnlyReferencesItsAnglePath"));
            }
            self.reference(Some(source), "Angle-path depth source", false)?;
            add(dependencies, Some(source));
            return Ok(());
        }
        if !keys_within(path, &["driver", "pitch", "origin", "restAngle", "pitchRestAngle", "figureRestAngle", "keys"]) {
            return Err(invalid("errors.rigAnglePath.invalidAnglePathField"));
        }
        self.reference(path.get("driver"), "Angle-path driver", false)?;
        self.reference(path.get("origin"), "Angle-path origin", true)?;
        add(dependencies, path.get("driver"));
        add(dependencies, path.get("origin"));
        if let Some(pitch) = path.get("pitch") {
            self.reference(Some(pitch), "Angle-path pitch", false)?;
            add(dependencies, Some(pitch));
        }
        for key in ["restAngle", "pitchRestAngle", "figureRestAngle"] {
            if !path.get(key).and_then(Value::as_f64).is_some_and(|n| n.is_finite() && n.abs() <= 1e6) {
                return Err(invalid("errors.rigAnglePath.setFiniteAnglePathReferenceAngles"));
            }
        }
        let keys = path.get("keys");
        let list = items(keys);
        if !keys.is_some_and(Value::is_array) || list.len() < 2 || list.len() > 64 {
            return Err(invalid("errors.rigAnglePath.anAnglePathNeeds264OrderedSamples"));
        }
        let mut prior = f64::NEG_INFINITY;
        for key in &list {
            let values = key.numbers().filter(|_| key.is_array());
            let valid = values.as_ref().is_some_and(|v| v.len() == 4 && v.iter().all(|n| n.is_finite() && n.abs() <= 1e6) && v[0] >= 0.0 && v[0] < std::f64::consts::TAU && v[0] > prior);
            if !valid {
                return Err(invalid("errors.rigAnglePath.anglePathSamplesRequireIncreasingAnglesFrom0"));
            }
            prior = values.unwrap()[0];
        }
        Ok(())
    }
}

/// SameValueZero for the values a set of handles holds.
fn same_value_zero(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Num(x), Value::Num(y)) => x == y || (x.is_nan() && y.is_nan()),
        _ => crate::history::js_strict_eq(a, b),
    }
}

/// `dependencies.add(id)`.
fn add(dependencies: &mut Vec<Value>, id: Option<&Value>) {
    let id = id.cloned().unwrap_or(Value::Null);
    if !dependencies.iter().any(|d| same_value_zero(d, &id)) {
        dependencies.push(id);
    }
}

/// `rigConstraintPlan(figure)` as a check: every relationship valid, every reference existing,
/// and no joint depending on itself.
pub(crate) fn validate_rig(segments: &[Value]) -> Result<(), EditError> {
    let mut ids = HashMap::new();
    for (i, segment) in segments.iter().enumerate() {
        if let Some(key) = id_key(segment.get("segment_id")) {
            ids.insert(key, i);
        }
    }
    let checker = Checker { segments, ids };
    let mut outgoing: Vec<Vec<usize>> = vec![Vec::new(); segments.len()];
    let mut indegree = vec![0usize; segments.len()];
    for (i, segment) in segments.iter().enumerate() {
        let r = segment.get("_stykRig").filter(|r| r.truthy());
        if let Some(r) = r
            && (!r.is_object() || !keys_within(r, &BEHAVIORS))
        {
            return Err(invalid("errors.rigConstraints.invalidRigBehavior"));
        }
        let field = |key: &str| r.and_then(|r| r.get(key));
        let truthy = |key: &str| field(key).is_some_and(Value::truthy);
        if let Some(orientation) = field("orientation")
            && !matches!(orientation.as_str(), Some("inherit" | "world"))
        {
            return Err(invalid("errors.rigConstraints.chooseAValidAttachmentOrientation"));
        }
        let mut dependencies = vec![segment.get("parent_id").cloned().unwrap_or(Value::Null)];
        let (c, d, f) = (field("connector").filter(|v| v.truthy()), field("stretch").filter(|v| v.truthy()), field("follow").filter(|v| v.truthy()));
        if truthy("spatial") {
            if c.is_some() || d.is_some() || f.is_some() || truthy("response") || truthy("angleLock") || truthy("anglePath") || truthy("weighted") {
                return Err(invalid("errors.rigConstraints.spatialArticulationOwnsItsTransformApplyOtherRelationships"));
            }
            checker.spatial(field("spatial").unwrap(), &mut dependencies)?;
        }
        if truthy("weighted") {
            if c.is_some() || d.is_some() || f.is_some() || truthy("response") || truthy("angleLock") || truthy("anglePath") {
                return Err(invalid("errors.rigConstraints.aWeightedJointFollowsItsAnchorsApplyOther"));
            }
            checker.weighted(field("weighted").unwrap(), &mut dependencies, false)?;
        }
        if truthy("anglePath") {
            if c.is_some() || d.is_some() || f.is_some() || truthy("response") || truthy("angleLock") {
                return Err(invalid("errors.rigConstraints.anAnglePathJointIsPositionedByIts"));
            }
            let path = field("anglePath").unwrap();
            checker.angle_path(path, &mut dependencies)?;
            if let Some(source) = path.get("source")
                && !checker.segment(Some(source)).and_then(|s| s.path(&["_stykRig", "anglePath", "keys"])).is_some_and(Value::truthy)
            {
                return Err(invalid("errors.rigConstraints.chooseAnAnglePathJointAsTheDepth"));
            }
        }
        if let Some(c) = c {
            checker.reference(c.get("start"), "Connector start", true)?;
            checker.reference(c.get("end"), "Connector end", true)?;
            if same_value_zero(c.get("start").unwrap_or(&Value::Null), c.get("end").unwrap_or(&Value::Null)) {
                return Err(invalid("errors.rigConstraints.chooseTwoDifferentConnectorAnchors"));
            }
            number(c.get("restLength"), "Connector rest span", EPS, 1e6)?;
            add(&mut dependencies, c.get("start"));
            add(&mut dependencies, c.get("end"));
        }
        if let Some(d) = d {
            number(d.get("restLength"), "Stretch rest length", EPS, 1e6)?;
            number(d.get("min"), "Minimum stretch", 0.0, 100.0)?;
            let min = d.get("min").and_then(Value::as_f64).unwrap();
            number(d.get("max"), "Maximum stretch", 0.01f64.max(min), 100.0)?;
            if !matches!(d.get("width").and_then(Value::as_str), Some("keep" | "inverse" | "scale")) {
                return Err(invalid("errors.rigConstraints.chooseAValidStretchWidthResponse"));
            }
            if given(d.get("branch")) && d.get("branch").and_then(Value::as_bool).is_none() {
                return Err(invalid("errors.rigConstraints.invalidStretchBranchSetting"));
            }
            if let Some(source) = d.get("source")
                && (c.is_none() || !matches!(source.as_str(), Some("span" | "slide" | "combined")))
            {
                return Err(invalid("errors.rigConstraints.chooseAValidConnectorStretchSource"));
            }
            if given(d.get("restPosition")) {
                number(d.get("restPosition"), "Rest slide position", EPS, 1.0)?;
            }
            let source = d.get("source").filter(|s| s.truthy());
            if source.is_some_and(|s| s.as_str() != Some("span")) && !given(d.get("restPosition")) {
                return Err(invalid("errors.rigConstraints.setANonzeroRestSlidePositionFirst"));
            }
        }
        if let Some(f) = f {
            checker.reference(f.get("driver"), "Stretch driver", false)?;
            if !checker.segment(f.get("driver")).and_then(|s| s.path(&["_stykRig", "stretch"])).is_some_and(Value::truthy) {
                return Err(invalid("errors.rigConstraints.theSelectedStretchDriverIsNotEnabledRemove"));
            }
            if !matches!(f.get("mode").and_then(Value::as_str), Some("stretch" | "rigid")) {
                return Err(invalid("errors.rigConstraints.chooseStretchOrFollowWithoutDeforming"));
            }
            number(f.get("influence"), "Stretch influence", -4.0, 4.0)?;
            add(&mut dependencies, f.get("driver"));
            if given(f.get("automatic")) && f.get("automatic").and_then(Value::as_bool).is_none() {
                return Err(invalid("errors.rigConstraints.invalidAutomaticStretchBinding"));
            }
            if c.is_some() {
                return Err(invalid("errors.rigConstraints.aConnectorFollowsItsAnchorsApplyStretchTo"));
            }
        }
        let (response, lock) = (field("response"), field("angleLock"));
        for value in [response, lock].into_iter().flatten() {
            if !value.is_null() && !value.is_object() {
                return Err(invalid("errors.rigConstraints.invalidRigResponseOrAngleLock"));
            }
        }
        if let Some(response) = response.filter(|v| v.truthy()) {
            if !matches!(response.get("mode").filter(|m| !m.is_null()).map_or(Some("stretch"), Value::as_str), Some("stretch" | "rigid" | "stop")) {
                return Err(invalid("errors.rigConstraints.chooseAValidStretchResponse"));
            }
            if given(response.get("multiplier")) {
                number(response.get("multiplier"), "Stretch multiplier", -10.0, 10.0)?;
            }
            if given(response.get("reset")) && response.get("reset").and_then(Value::as_bool).is_none() {
                return Err(invalid("errors.rigConstraints.invalidStretchImpulseReset"));
            }
        }
        if let Some(lock) = lock.filter(|v| v.truthy()) {
            if c.is_some() {
                return Err(invalid("errors.rigConstraints.connectorAnglesAreControlledByTheirAnchorsLock"));
            }
            let mode = lock.get("mode").and_then(Value::as_str);
            if !matches!(mode, Some("world" | "figure" | "parent")) {
                return Err(invalid("errors.rigConstraints.chooseAValidAngleLock"));
            }
            if let Some(space) = lock.get("space")
                && !matches!(space.as_str(), Some("rendered" | "authored"))
            {
                return Err(invalid("errors.rigConstraints.chooseAValidAngleLockSpace"));
            }
            number(lock.get("angle"), "Locked angle", -1e6, 1e6)?;
            number(lock.get("multiplier"), "Angle multiplier", -10.0, 10.0)?;
            if mode == Some("parent") {
                checker.reference(lock.get("reference"), "Angle reference", false)?;
                add(&mut dependencies, lock.get("reference"));
                number(lock.get("restAngle"), "Reference angle", -1e6, 1e6)?;
            }
            if mode == Some("figure") {
                number(lock.get("restAngle"), "Figure reference angle", -1e6, 1e6)?;
            }
            if given(lock.get("figureRestAngle")) {
                number(lock.get("figureRestAngle"), "Parent lock figure reference angle", -1e6, 1e6)?;
            }
            if let Some(secondary) = lock.get("secondary").filter(|s| !s.is_null()) {
                if mode != Some("parent") || !secondary.is_object() {
                    return Err(invalid("errors.rigConstraints.aSecondAngleReferenceRequiresAParentAngle"));
                }
                checker.reference(secondary.get("reference"), "Second angle reference", false)?;
                add(&mut dependencies, secondary.get("reference"));
                number(secondary.get("restAngle"), "Second reference angle", -1e6, 1e6)?;
                number(secondary.get("multiplier"), "Second rotation multiplier", -10.0, 10.0)?;
            }
        }
        let mut seen = HashSet::new();
        for id in &dependencies {
            checker.reference(Some(id), "Rig parent", true)?;
            if id.truthy() {
                let parent = checker.ids[&id_key(Some(id)).unwrap()];
                if seen.insert(parent) {
                    outgoing[parent].push(i);
                    indegree[i] += 1;
                }
            }
        }
    }
    let mut order: Vec<usize> = (0..segments.len()).filter(|&i| indegree[i] == 0).collect();
    let mut q = 0;
    while q < order.len() {
        for &child in &outgoing[order[q]].clone() {
            indegree[child] -= 1;
            if indegree[child] == 0 {
                order.push(child);
            }
        }
        q += 1;
    }
    if order.len() != segments.len() {
        return Err(invalid("errors.rigConstraints.thisRigWouldDependOnItselfChooseAnchors"));
    }
    Ok(())
}

/// `{...a, ...b}` of two optional objects (anything else spreads nothing).
fn merged(a: Option<&Value>, b: Option<&Value>) -> Obj {
    let mut out = a.and_then(Value::as_obj).cloned().unwrap_or_default();
    for (key, value) in b.and_then(Value::as_obj).map(|o| o.iter().collect::<Vec<_>>()).unwrap_or_default() {
        out.set(key, value.clone());
    }
    out
}

/// A value an object spread would take keys from that the engine does not reproduce
/// (strings and arrays spread their indices).
fn spreads_indices(value: Option<&Value>) -> bool {
    value.is_some_and(|v| v.is_array() || (v.as_str().is_some_and(|s| !s.is_empty())))
}

impl Editor {
    /// `change(editor, label, changes)`: the joints' new `_stykRig` (none to remove it) checked
    /// against the whole figure and the IK controllers of its poses, then one
    /// `native-properties` entry of the joints that changed.
    fn rig_change(&mut self, label: &str, changes: Vec<(usize, Option<Value>)>) -> Result<bool, EditError> {
        let Some((_, object)) = self.object()? else { return Ok(false) };
        if changes.is_empty() {
            return Ok(false);
        }
        if self.report.path(&["_styk", "simpleFrameDraft"]).is_some() {
            return Err(EditError::Unported("rig relationships with a frame draft".into()));
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let figures = items(self.report.get("figure_types"));
        let Some(index) = figures.iter().position(|f| f.get("figure_type_id") == object.get("figure_type_id")) else { return Ok(false) };
        let figure = &figures[index];
        let mut segments = items(figure.get("segments"));
        let original = segments.clone();
        for (i, rig) in &changes {
            if let Some(record) = segments.get_mut(*i).and_then(Value::make_obj) {
                // `{...segment, _stykRig: rig}`: an absent rig is `undefined` there.
                match rig {
                    Some(rig) => record.set("_stykRig", rig.clone()),
                    None => record.set("_stykRig", Value::Null),
                }
            }
        }
        let checked: Vec<Value> = segments
            .iter()
            .map(|s| {
                if s.get("_stykRig").is_some_and(Value::is_null) {
                    let mut record = s.as_obj().cloned().unwrap_or_default();
                    record.remove("_stykRig");
                    Value::object(record)
                } else {
                    s.clone()
                }
            })
            .collect();
        validate_rig(&checked)?;
        let type_id = figure.get("figure_type_id").cloned();
        for frame in self.all_source_frames() {
            for pose in items(frame.get("objects")) {
                if pose.get("figure_type_id").cloned() != type_id {
                    continue;
                }
                for (id, controller) in pose.get("_stykIK").and_then(Value::as_obj).map(|o| o.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<Vec<_>>()).unwrap_or_default() {
                    let wanted = id.parse::<f64>().ok();
                    let at = checked.iter().position(|s| num(s, "segment_id").is_some() && num(s, "segment_id") == wanted);
                    if controller.get("enabled").is_some_and(Value::truthy) && !rig_ik_allowed(&checked, at) {
                        return Err(invalid("errors.editorRigConstraints.disableIkOnTheAffectedPartsBeforeBinding"));
                    }
                }
            }
        }
        let mut entries = Vec::new();
        for (i, rig) in &changes {
            let old = original.get(*i).and_then(|s| s.get("_stykRig")).cloned();
            if old.as_ref().map(styk_doc::json::to_string) == rig.as_ref().map(styk_doc::json::to_string) {
                continue;
            }
            entries.push(Entry { path: vec![Key::Field("segments".into()), Key::Index(*i), Key::Field("_stykRig".into())], value: rig.clone() });
        }
        if entries.is_empty() {
            return Ok(false);
        }
        self.native_properties(label, index, entries)
    }

    /// Every frame a pose of a figure lives in (`_allSourceFrames`): the keyframes and the
    /// pose sources.
    pub(crate) fn all_source_frames(&self) -> Vec<Value> {
        let mut frames = items(self.report.get("keyframes"));
        if let Some(sources) = self.report.path(&["_styk", "frameSources"]).and_then(Value::as_obj) {
            frames.extend(sources.values().iter().cloned());
        }
        frames
    }

    /// The rig commands by their JavaScript names; `None` for other calls.
    pub(crate) fn rig_call(&mut self, method: &str, args: &[Value]) -> Option<Result<Value, EditError>> {
        let arg = |i: usize| args.get(i);
        if let Some(result) = self.rig_drag_call(method, args) {
            return Some(result);
        }
        Some(match method {
            "setRigBehavior" => self.set_rig_behavior(arg(0)).map(Value::Bool),
            "enableSmartStretch" => self.enable_smart_stretch(arg(0)).map(Value::Bool),
            "bindStretchParts" => self.bind_stretch_parts(arg(0), arg(1)).map(Value::Bool),
            "setAngleLock" => self.set_angle_lock(arg(0)).map(Value::Bool),
            "setSecondaryAngleReference" => self.set_secondary_angle_reference(arg(0)).map(Value::Bool),
            _ => return None,
        })
    }

    /// The selected joint, its definition's segments and the figure on show.
    fn rig_joint(&self) -> Result<Option<(usize, Vec<Value>, Value)>, EditError> {
        let Some((_, object)) = self.object()? else { return Ok(None) };
        let figure = self.figure_value(&object);
        let segments = items(figure.get("segments"));
        let joint = self.selection.joint;
        if joint < 0 || joint as usize >= segments.len() {
            return Ok(None);
        }
        Ok(Some((joint as usize, segments, object)))
    }

    /// `setRigBehavior(patch)`.
    fn set_rig_behavior(&mut self, patch: Option<&Value>) -> Result<bool, EditError> {
        let Some((index, segments, _)) = self.rig_joint()? else { return Ok(false) };
        let Some(patch) = patch.and_then(Value::as_obj) else { return Err(EditError::Unported("a rig behaviour that is not an object".into())) };
        let segment = &segments[index];
        let mut r = segment.get("_stykRig").and_then(Value::as_obj).cloned().unwrap_or_default();
        if segment.get("_stykRig").is_some_and(|v| v.truthy() && !v.is_object()) {
            return Err(EditError::Unported("a rig behaviour that is not an object".into()));
        }
        let mut changes: Vec<(usize, Option<Value>)> = Vec::new();
        for key in patch.keys() {
            if !BEHAVIORS.contains(&&**key) {
                return Err(invalid("errors.editorRigConstraints.unknownRigBehavior"));
            }
        }
        for key in ["response", "angleLock", "anglePath", "weighted", "spatial", "connector", "stretch", "follow"] {
            if spreads_indices(patch.get(key)) || spreads_indices(r.get(key).filter(|_| patch.contains(key))) {
                return Err(EditError::Unported("a rig behaviour spread from a list or text".into()));
            }
        }
        for key in ["response", "angleLock", "anglePath", "weighted", "spatial"] {
            if let Some(value) = patch.get(key) {
                if value.truthy() {
                    r.set(key, Value::object(merged(r.get(key), Some(value))));
                } else {
                    r.remove(key);
                }
            }
        }
        if let Some(orientation) = patch.get("orientation") {
            r.set("orientation", orientation.clone());
        }
        if let Some(connector) = patch.get("connector") {
            if !r.get("connector").is_some_and(Value::truthy) {
                return Err(invalid("errors.editorRigConstraints.createAConnectorWithConnectJoints"));
            }
            if !connector.truthy() {
                return Err(invalid("errors.editorRigConstraints.deleteTheConnectorToRemoveItOrReconnect"));
            }
            r.set("connector", Value::object(merged(r.get("connector"), Some(connector))));
        }
        if let Some(stretch) = patch.get("stretch") {
            if stretch.truthy() {
                let span = r.get("connector").filter(|c| c.truthy()).and_then(|c| c.get("restLength")).filter(|v| !v.is_null()).cloned().or_else(|| segment.get("length").cloned()).unwrap_or(Value::Null);
                let mut next = Obj::new();
                next.set("restLength", span);
                next.set("min", Value::Num(0.0));
                next.set("max", Value::Num(10.0));
                next.set("width", Value::str("keep"));
                let next = merged(Some(&Value::object(merged(Some(&Value::object(next)), r.get("stretch")))), Some(stretch));
                r.set("stretch", Value::object(next));
            } else {
                r.remove("stretch");
                let own = segment.get("segment_id").cloned().unwrap_or(Value::Null);
                for (i, s) in segments.iter().enumerate() {
                    if s.path(&["_stykRig", "follow", "driver"]).is_some_and(|d| crate::history::js_strict_eq(d, &own)) {
                        let mut next = s.get("_stykRig").and_then(Value::as_obj).cloned().unwrap_or_default();
                        next.remove("follow");
                        set_change(&mut changes, i, (!next.is_empty()).then(|| Value::object(next)));
                    }
                }
            }
        }
        if let Some(follow) = patch.get("follow") {
            if follow.truthy() {
                let mut base = Obj::new();
                base.set("mode", Value::str("stretch"));
                base.set("influence", Value::Num(1.0));
                let next = merged(Some(&Value::object(merged(Some(&Value::object(base)), r.get("follow")))), Some(follow));
                r.set("follow", Value::object(next));
            } else {
                r.remove("follow");
            }
        }
        set_change(&mut changes, index, (!r.is_empty()).then(|| Value::object(r)));
        self.rig_change("Edit rig behavior", changes)
    }

    /// `enableSmartStretch(enabled)`: the joint stretches from its length on show and the
    /// branch below it follows (connectors and other drivers' parts stop it).
    fn enable_smart_stretch(&mut self, enabled: Option<&Value>) -> Result<bool, EditError> {
        if !enabled.is_some_and(Value::truthy) {
            let mut patch = Obj::new();
            patch.set("stretch", Value::Null);
            return self.set_rig_behavior(Some(&Value::object(patch)));
        }
        let Some((index, segments, object)) = self.rig_joint()? else { return Ok(false) };
        let segment = &segments[index];
        if segment.get("_stykRig").is_some_and(|v| v.truthy() && !v.is_object()) {
            return Err(EditError::Unported("a rig behaviour that is not an object".into()));
        }
        let scale = num(&object, "scale").filter(|_| object.get("scale").is_some_and(|s| !s.is_null())).unwrap_or(1.0).abs().max(1e-8);
        let connector = segment.path(&["_stykRig", "connector"]).filter(|c| c.truthy());
        let current = match self.drawn_joint(index)? {
            // A connector's drawn end (its far anchor through the arc it bends along) is not kept by the engine's geometry.
            Some(_) if connector.is_some() => return Err(EditError::Unported("Smart Stretch on a connector".into())),
            Some(shape) => shape.length.abs() / scale,
            None => connector.and_then(|c| c.get("restLength")).filter(|v| !v.is_null()).and_then(Value::as_f64).unwrap_or_else(|| num(segment, "length").unwrap_or(f64::NAN).abs()),
        };
        let mut stretch = Obj::new();
        stretch.set("restLength", Value::Num(0.0001f64.max(current)));
        stretch.set("min", Value::Num(0.0));
        stretch.set("max", Value::Num(10.0));
        stretch.set("width", Value::str("keep"));
        let mut stretch = merged(Some(&Value::object(stretch)), segment.path(&["_stykRig", "stretch"]));
        stretch.set("branch", Value::Bool(true));
        let mut r = segment.get("_stykRig").and_then(Value::as_obj).cloned().unwrap_or_default();
        r.set("stretch", Value::object(stretch));
        let mut changes = vec![(index, Some(Value::object(r)))];
        let key = |v: Option<&Value>| v.map(styk_doc::json::to_string).unwrap_or_default();
        let mut children: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, s) in segments.iter().enumerate() {
            children.entry(key(s.get("parent_id"))).or_default().push(i);
        }
        let own = segment.get("segment_id").cloned().unwrap_or(Value::Null);
        let mut queue = vec![index];
        let mut q = 0;
        while q < queue.len() {
            for &i in children.get(&key(segments[queue[q]].get("segment_id"))).map(Vec::as_slice).unwrap_or(&[]) {
                let s = &segments[i];
                if s.path(&["_stykRig", "stretch"]).is_some_and(Value::truthy) {
                    continue;
                }
                queue.push(i);
                if s.path(&["_stykRig", "connector"]).is_some_and(Value::truthy) {
                    continue;
                }
                let follow = s.path(&["_stykRig", "follow"]);
                let mut next = s.get("_stykRig").and_then(Value::as_obj).cloned().unwrap_or_default();
                let mut binding = Obj::new();
                binding.set("driver", own.clone());
                binding.set("mode", follow.and_then(|f| f.get("mode")).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| Value::str("stretch")));
                binding.set("influence", follow.and_then(|f| f.get("influence")).filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(1.0)));
                binding.set("automatic", Value::Bool(true));
                next.set("follow", Value::object(binding));
                set_change(&mut changes, i, Some(Value::object(next)));
            }
            q += 1;
        }
        self.rig_change("Enable Smart Stretch", changes)
    }

    /// `bindStretchParts(driver, {mode, influence, branch})`: the selected joint (or its branch)
    /// follows a stretch driver, or with no driver stops following one.
    fn bind_stretch_parts(&mut self, driver: Option<&Value>, options: Option<&Value>) -> Result<bool, EditError> {
        let Some((index, segments, _)) = self.rig_joint()? else { return Ok(false) };
        let options = match options {
            None => Value::object(Obj::new()),
            Some(Value::Null) => return Err(EditError::Unported("stretch binding options that are null".into())),
            Some(options) => options.clone(),
        };
        let mode = options.get("mode").cloned().unwrap_or_else(|| Value::str("stretch"));
        let influence = options.get("influence").cloned().unwrap_or(Value::Num(1.0));
        let whole = options.get("branch").is_some_and(Value::truthy);
        let figure = Value::object({
            let mut f = Obj::new();
            f.set("segments", Value::array(segments.clone()));
            f
        });
        let indices = if whole { crate::builder::branch(&figure, index, true, false).indices } else { vec![index] };
        let driver = driver.cloned().unwrap_or(Value::Null);
        let mut changes = Vec::new();
        for i in indices {
            let s = &segments[i];
            if s.get("segment_id").is_some_and(|id| crate::history::js_strict_eq(id, &driver)) || s.path(&["_stykRig", "connector"]).is_some_and(Value::truthy) {
                continue;
            }
            if s.get("_stykRig").is_some_and(|v| v.truthy() && !v.is_object()) {
                return Err(EditError::Unported("a rig behaviour that is not an object".into()));
            }
            let mut r = s.get("_stykRig").and_then(Value::as_obj).cloned().unwrap_or_default();
            if driver.truthy() {
                let mut follow = Obj::new();
                follow.set("driver", driver.clone());
                follow.set("mode", mode.clone());
                follow.set("influence", influence.clone());
                r.set("follow", Value::object(follow));
                r.remove("response");
            } else {
                r.remove("follow");
                if spreads_indices(r.get("response")) {
                    return Err(EditError::Unported("a rig response spread from a list or text".into()));
                }
                let mut response = r.get("response").and_then(Value::as_obj).cloned().unwrap_or_default();
                response.set("mode", Value::str("stop"));
                r.set("response", Value::object(response));
            }
            set_change(&mut changes, i, (!r.is_empty()).then(|| Value::object(r)));
        }
        self.rig_change("Set stretch parts", changes)
    }

    /// `setAngleLock(mode)`: the joint's angle locked to the world, the figure or a movable
    /// parent, measured on the figure on show; `off` removes the lock.
    fn set_angle_lock(&mut self, mode: Option<&Value>) -> Result<bool, EditError> {
        let Some((index, segments, object)) = self.rig_joint()? else { return Ok(false) };
        if mode.and_then(Value::as_str) == Some("off") {
            let mut patch = Obj::new();
            patch.set("angleLock", Value::Null);
            return self.set_rig_behavior(Some(&Value::object(patch)));
        }
        let figure = self.figure_value(&object);
        validate_rig(&segments)?;
        let Some(shape) = self.drawn_joint(index)? else { return Err(EditError::Unported("an angle lock on a figure the engine does not draw".into())) };
        let mut lock = Obj::new();
        lock.set("mode", mode.cloned().unwrap_or(Value::Null));
        lock.set("angle", Value::Num(shape.angle));
        lock.set("multiplier", Value::Num(1.0));
        if mode.and_then(Value::as_str) == Some("figure") {
            lock.set("restAngle", Value::Num(self.rig_animation_rotation(&figure, &object)?));
        }
        if mode.and_then(Value::as_str) == Some("parent") {
            let ids: HashMap<u64, usize> = segments.iter().enumerate().filter_map(|(i, s)| id_key(s.get("segment_id")).map(|k| (k, i))).collect();
            let mut at = id_key(segments[index].get("parent_id")).and_then(|k| ids.get(&k).copied());
            while let Some(i) = at {
                if !is_static(&segments[i]) {
                    break;
                }
                at = id_key(segments[i].get("parent_id")).and_then(|k| ids.get(&k).copied());
            }
            let Some(parent) = at else { return Err(invalid("errors.editorRigConstraints.thisJointHasNoMovableParentUseWorld")) };
            let parent_shape = self.drawn_joint(parent)?.ok_or_else(|| EditError::Unported("an angle lock on a figure the engine does not draw".into()))?;
            lock.set("reference", segments[parent].get("segment_id").cloned().unwrap_or(Value::Null));
            lock.set("restAngle", Value::Num(parent_shape.angle));
            lock.set("figureRestAngle", Value::Num(self.rig_animation_rotation(&figure, &object)?));
        }
        lock.set("secondary", Value::Null);
        let mut patch = Obj::new();
        patch.set("angleLock", Value::object(lock));
        self.set_rig_behavior(Some(&Value::object(patch)))
    }

    /// `setSecondaryAngleReference(reference)`: a parent lock also follows a second joint, as
    /// it is on show; `0` removes it.
    fn set_secondary_angle_reference(&mut self, reference: Option<&Value>) -> Result<bool, EditError> {
        let joint = self.rig_joint()?;
        let lock = joint.as_ref().and_then(|(index, segments, _)| segments[*index].path(&["_stykRig", "angleLock"]).cloned());
        if lock.as_ref().and_then(|l| l.get("mode")).and_then(Value::as_str) != Some("parent") {
            return Err(invalid("errors.editorRigConstraints.chooseAParentAngleLockFirst"));
        }
        let (_, segments, object) = joint.unwrap();
        let lock = lock.unwrap();
        let reference = reference.cloned().unwrap_or(Value::Null);
        if reference.as_f64() == Some(0.0) {
            let mut inner = Obj::new();
            inner.set("secondary", Value::Null);
            let mut patch = Obj::new();
            patch.set("angleLock", Value::object(inner));
            return self.set_rig_behavior(Some(&Value::object(patch)));
        }
        let Some(at) = segments.iter().position(|s| s.get("segment_id").is_some_and(|id| crate::history::js_strict_eq(id, &reference))) else {
            return Err(invalid("errors.editorRigConstraints.chooseAnExistingSecondAngleReference"));
        };
        let shape = self.drawn_joint(at)?.ok_or_else(|| EditError::Unported("an angle reference on a figure the engine does not draw".into()))?;
        let angle = if lock.get("space").and_then(Value::as_str) == Some("authored") { shape.authored.unwrap_or(shape.angle) } else { shape.angle };
        let figure = self.figure_value(&object);
        let delta = match lock.get("figureRestAngle") {
            None => 0.0,
            // `rotation - null` is the rotation.
            Some(rest) => self.rig_animation_rotation(&figure, &object)? - if rest.is_null() { 0.0 } else { rest.as_f64().unwrap_or(f64::NAN) },
        };
        let mut secondary = Obj::new();
        secondary.set("reference", reference);
        secondary.set("restAngle", Value::Num(angle - delta));
        secondary.set("multiplier", Value::Num(1.0));
        let mut inner = Obj::new();
        inner.set("secondary", Value::object(secondary));
        let mut patch = Obj::new();
        patch.set("angleLock", Value::object(inner));
        self.set_rig_behavior(Some(&Value::object(patch)))
    }

    /// Origin definitions use the existing typed support/layout rotation owner.
    /// Ordinary figures retain the same raw numeric contract as before.
    fn rig_animation_rotation(&self, figure: &Value, object: &Value) -> Result<f64, EditError> {
        if figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy) {
            self.origin_rotation(figure, object)
        } else {
            animation_rotation(figure, object)
        }
    }

    /// The selected figure's segment `index` as its geometry draws it: angle, rig-evaluated
    /// length and authored angle. `None` when the figure is not on show.
    fn drawn_joint(&self, index: usize) -> Result<Option<Shape>, EditError> {
        let Some((slot, object)) = self.object()? else { return Ok(None) };
        let figure = self.figure_value(&object);
        let definition = items(figure.get("segments"));
        let (prepared, frame, scene) = self.evaluate()?;
        let Some(at) = frame.objects.iter().position(|o| Some(o.uid) == crate::record::uid(&object)) else { return Ok(None) };
        let _ = slot;
        let solved = crate::ik::solve_frame(&prepared, &frame, &scene);
        let shapes = crate::handle_edit::drawn_segments(&prepared, &frame, &scene, &solved, at, &definition)?;
        let Some(drawn) = shapes.get(index) else { return Ok(None) };
        let geometry = scene.objects.iter().find(|g| g.uid == frame.objects[at].uid && g.resolved);
        let rig = geometry.and_then(|g| g.rig.as_ref()).and_then(|r| r.get(index).copied());
        Ok(Some(Shape { angle: drawn.angle, length: rig.map_or(drawn.length, |r| r.length), authored: rig.map(|r| r.authored) }))
    }
}

/// A segment as drawn (`geometry.objects.get(slot).segments[i]`).
struct Shape {
    angle: f64,
    length: f64,
    authored: Option<f64>,
}

/// `changes.set(index, rig)`: a joint changed again keeps its place.
fn set_change(changes: &mut Vec<(usize, Option<Value>)>, index: usize, rig: Option<Value>) {
    match changes.iter_mut().find(|(i, _)| *i == index) {
        Some(entry) => entry.1 = rig,
        None => changes.push((index, rig)),
    }
}

/// Whether a joint is static (`aux_code & 1`, else the raw static flags).
fn is_static(segment: &Value) -> bool {
    match segment.get("aux_code") {
        // `aux_code !== undefined ? Boolean(aux_code & 1) : …` (null is 0 there).
        Some(aux) => (aux.as_f64().map_or(0, |a| if a.is_finite() { a.trunc() as i64 } else { 0 }) & 1) != 0,
        _ => {
            let pick = ["static_raw"].iter().find_map(|k| segment.get(k).filter(|v| !v.is_null()).cloned())
                .or_else(|| segment.path(&["flag_bits", "is_static"]).filter(|v| !v.is_null()).cloned())
                .or_else(|| segment.get("is_static").filter(|v| !v.is_null()).cloned());
            match pick {
                Some(value) => value.truthy(),
                None => (num(segment, "flags").map_or(0, |f| if f.is_finite() { f.trunc() as i64 } else { 0 }) & 256) != 0,
            }
        }
    }
}

/// `animationRotation(figure, object)` of a figure without an animation origin.
fn animation_rotation(figure: &Value, object: &Value) -> Result<f64, EditError> {
    if figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy) {
        return Err(EditError::Unported("an angle lock on a figure with an animation origin".into()));
    }
    let number = |v: Option<Value>| v.map_or(0.0, |v| if v.is_null() { 0.0 } else { v.as_f64().unwrap_or(f64::NAN) });
    let first = object.get("angles").and_then(|a| a.item(0));
    let rest = figure.get("segments").and_then(|s| s.item(0)).and_then(|s| s.get("angle_rad").cloned());
    Ok(number(first) - number(rest))
}
