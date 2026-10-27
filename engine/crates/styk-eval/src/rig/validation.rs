//! Strict raw validation before editing the native 2D relationship family.
//! `src/rig-constraints.mjs::rigConstraintPlanSteps` is the oracle. Unknown
//! nested metadata is retained; spatial, weighted and angle-path validation
//! remains with their owners and is unavailable through this entry point.
use std::collections::HashMap;
use styk_doc::Value;

const RANGE: &str = "errors.cameraMotion.mustBeBetweenAnd";
/// What [`validate_2d`] answers for a figure whose rig uses a family it does not validate.
pub const UNAVAILABLE: &str = "2D validation is unavailable for spatial, weighted or angle-path relationships";
const REFERENCE: &str = "errors.rigConstraints.refersToAMissingJointRemoveOrReconnect";

fn number(value: Option<&Value>, min: f64, max: f64) -> Result<f64, &'static str> {
    value.and_then(Value::as_f64).filter(|value| value.is_finite() && *value >= min && *value <= max).ok_or(RANGE)
}

fn reference(value: Option<&Value>, root: bool, ids: &HashMap<u32, usize>) -> Result<Option<u32>, &'static str> {
    let value = value.and_then(Value::as_f64).filter(|value| value.is_finite() && value.fract() == 0.0 && *value >= 0.0 && *value <= 65535.0).ok_or(REFERENCE)? as u32;
    if root && value == 0 { return Ok(None); }
    ids.get(&value).map(|&index| Some(index as u32)).ok_or(REFERENCE)
}

fn choice(value: Option<&Value>, choices: &[&str], error: &'static str) -> Result<(), &'static str> {
    if value.and_then(Value::as_str).is_some_and(|value| choices.contains(&value)) { Ok(()) } else { Err(error) }
}

/// Validates raw 2D connector/stretch/follow/orientation/response/angle-lock
/// definitions before an edit consumes them. This does not rewrite metadata or
/// change the loader's permissive read path. Dependency ordering shares `plan`'s
/// compiler. Other relationship families return an unavailable-validation error.
pub fn validate_2d(figure: &Value) -> Result<(), &'static str> {
    let segments: Vec<Value> = figure.get("segments").and_then(Value::elements).ok_or("errors.rigConstraints.invalidRigBehavior")?.iter().collect();
    let mut ids = HashMap::new();
    for (index, segment) in segments.iter().enumerate() {
        let id = segment.get("segment_id").and_then(Value::as_f64).filter(|id| id.is_finite() && id.fract() == 0.0 && *id > 0.0 && *id <= 65535.0).ok_or("errors.model.invalidOrRepeatedSegmentHandle")? as u32;
        if ids.insert(id, index).is_some() { return Err("errors.model.invalidOrRepeatedSegmentHandle"); }
    }
    let mut dependencies = vec![Vec::new(); segments.len()];
    for (index, segment) in segments.iter().enumerate() {
        let rig = segment.get("_stykRig").filter(|rig| rig.truthy());
        if rig.is_some_and(|rig| !rig.as_obj().is_some_and(|rig| rig.keys().all(|key| ["connector", "stretch", "follow", "orientation", "response", "angleLock", "anglePath", "weighted", "spatial"].contains(&key.as_ref())))) {
            return Err("errors.rigConstraints.invalidRigBehavior");
        }
        let field = |key: &str| rig.and_then(|rig| rig.get(key));
        if field("orientation").is_some() { choice(field("orientation"), &["inherit", "world"], "errors.rigConstraints.chooseAValidAttachmentOrientation")?; }
        if ["spatial", "weighted", "anglePath"].iter().any(|key| field(key).is_some_and(Value::truthy)) {
            return Err(UNAVAILABLE);
        }
        let (connector, stretch, follow) = (field("connector").filter(|value| value.truthy()), field("stretch").filter(|value| value.truthy()), field("follow").filter(|value| value.truthy()));
        let mut add = |value: Option<&Value>, root| -> Result<(), &'static str> {
            if let Some(dependency) = reference(value, root, &ids)? {
                if !dependencies[index].contains(&dependency) { dependencies[index].push(dependency); }
            }
            Ok(())
        };
        if let Some(connector) = connector {
            add(connector.get("start"), true)?;add(connector.get("end"), true)?;
            if connector.get("start") == connector.get("end") { return Err("errors.rigConstraints.chooseTwoDifferentConnectorAnchors"); }
            number(connector.get("restLength"), super::EPS, 1e6)?;
        }
        if let Some(stretch) = stretch {
            number(stretch.get("restLength"), super::EPS, 1e6)?;
            let min = number(stretch.get("min"), 0.0, 100.0)?;
            number(stretch.get("max"), min.max(0.01), 100.0)?;
            choice(stretch.get("width"), &["keep", "inverse", "scale"], "errors.rigConstraints.chooseAValidStretchWidthResponse")?;
            if stretch.get("branch").is_some_and(|value| !matches!(value, Value::Bool(_))) { return Err("errors.rigConstraints.invalidStretchBranchSetting"); }
            if let Some(source) = stretch.get("source") {
                if connector.is_none() { return Err("errors.rigConstraints.chooseAValidConnectorStretchSource"); }
                choice(Some(source), &["span", "slide", "combined"], "errors.rigConstraints.chooseAValidConnectorStretchSource")?;
            }
            if let Some(position) = stretch.get("restPosition") { number(Some(position), super::EPS, 1.0)?; }
            if stretch.get("source").is_some_and(|source| source.truthy() && source.as_str() != Some("span")) && stretch.get("restPosition").is_none() {
                return Err("errors.rigConstraints.setANonzeroRestSlidePositionFirst");
            }
        }
        if let Some(follow) = follow {
            let driver = reference(follow.get("driver"), false, &ids)?.ok_or(REFERENCE)? as usize;
            if !segments[driver].path(&["_stykRig", "stretch"]).is_some_and(Value::truthy) { return Err("errors.rigConstraints.theSelectedStretchDriverIsNotEnabledRemove"); }
            choice(follow.get("mode"), &["stretch", "rigid"], "errors.rigConstraints.chooseStretchOrFollowWithoutDeforming")?;
            number(follow.get("influence"), -4.0, 4.0)?;
            add(follow.get("driver"), false)?;
            if follow.get("automatic").is_some_and(|value| !matches!(value, Value::Bool(_))) { return Err("errors.rigConstraints.invalidAutomaticStretchBinding"); }
            if connector.is_some() { return Err("errors.rigConstraints.aConnectorFollowsItsAnchorsApplyStretchTo"); }
        }
        let (response, lock) = (field("response"), field("angleLock"));
        for value in [response, lock].into_iter().flatten().filter(|value| !value.is_null()) {
            if !value.is_object() { return Err("errors.rigConstraints.invalidRigResponseOrAngleLock"); }
        }
        if let Some(response) = response.filter(|value| value.truthy()) {
            if let Some(mode) = response.get("mode").filter(|value| !value.is_null()) { choice(Some(mode), &["stretch", "rigid", "stop"], "errors.rigConstraints.chooseAValidStretchResponse")?; }
            if let Some(multiplier) = response.get("multiplier") { number(Some(multiplier), -10.0, 10.0)?; }
            if response.get("reset").is_some_and(|value| !matches!(value, Value::Bool(_))) { return Err("errors.rigConstraints.invalidStretchImpulseReset"); }
        }
        if let Some(lock) = lock.filter(|value| value.truthy()) {
            if connector.is_some() { return Err("errors.rigConstraints.connectorAnglesAreControlledByTheirAnchorsLock"); }
            choice(lock.get("mode"), &["world", "figure", "parent"], "errors.rigConstraints.chooseAValidAngleLock")?;
            if lock.get("space").is_some() { choice(lock.get("space"), &["rendered", "authored"], "errors.rigConstraints.chooseAValidAngleLockSpace")?; }
            number(lock.get("angle"), -1e6, 1e6)?;number(lock.get("multiplier"), -10.0, 10.0)?;
            if lock.get("mode").and_then(Value::as_str) == Some("parent") {
                add(lock.get("reference"), false)?;number(lock.get("restAngle"), -1e6, 1e6)?;
            }
            if lock.get("mode").and_then(Value::as_str) == Some("figure") { number(lock.get("restAngle"), -1e6, 1e6)?; }
            if let Some(angle) = lock.get("figureRestAngle") { number(Some(angle), -1e6, 1e6)?; }
            if let Some(secondary) = lock.get("secondary").filter(|value| !value.is_null()) {
                if lock.get("mode").and_then(Value::as_str) != Some("parent") || !secondary.is_object() { return Err("errors.rigConstraints.aSecondAngleReferenceRequiresAParentAngle"); }
                add(secondary.get("reference"), false)?;
                number(secondary.get("restAngle"), -1e6, 1e6)?;number(secondary.get("multiplier"), -10.0, 10.0)?;
            }
        }
        add(segment.get("parent_id"), true)?;
    }
    super::dependency_order(&dependencies).map(|_| ()).ok_or("errors.rigConstraints.thisRigWouldDependOnItselfChooseAnchors")
}
