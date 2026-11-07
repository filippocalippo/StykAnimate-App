//! The Inspector's number properties and the gesture that edits one through the session.
//!
//! A port of today's two routes for a number field (`src/app.mjs` `propertyChannel` and the PropertyControls callbacks,
//! `src/native-property-edit.mjs`): a property with an animation channel is one `beginAnimationEdit` ...
//! `previewAnimationEdit` ... `commitAnimationEdit` (or, over several frames, `addAnimationKeys`); a pose or camera
//! value is a session drag (`beginDrag` ... `commitDrag`); the project's fields and a sheet's exposure are one command
//! when the edit ends. Each gesture is one history entry, cancel leaves none, and every step is a call of the tab's
//! session: nothing here writes the document.

use styk_doc::{Obj, Value};

use crate::documents::{CallAnswer, Document, DocumentId, Documents, EditError};
use crate::i18n::Msg;

/// A number the Inspector edits (`data-property` today; [`PropertyKey::id`] is that name).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PropertyKey {
    RootX,
    RootY,
    Scale,
    Rotation,
    FigureOpacity,
    FigureZOrder,
    GroupX,
    GroupY,
    GroupWidth,
    GroupHeight,
    JointAngle,
    JointLength,
    JointBend,
    Thickness,
    SegmentOpacity,
    SegmentGradientOpacity,
    SegmentZOrder,
    CameraX,
    CameraY,
    CameraScale,
    CameraAngle,
    Fps,
    CanvasWidth,
    CanvasHeight,
    Duration,
}

impl PropertyKey {
    pub const ALL: [PropertyKey; 25] = [
        PropertyKey::RootX,
        PropertyKey::RootY,
        PropertyKey::Scale,
        PropertyKey::Rotation,
        PropertyKey::FigureOpacity,
        PropertyKey::FigureZOrder,
        PropertyKey::GroupX,
        PropertyKey::GroupY,
        PropertyKey::GroupWidth,
        PropertyKey::GroupHeight,
        PropertyKey::JointAngle,
        PropertyKey::JointLength,
        PropertyKey::JointBend,
        PropertyKey::Thickness,
        PropertyKey::SegmentOpacity,
        PropertyKey::SegmentGradientOpacity,
        PropertyKey::SegmentZOrder,
        PropertyKey::CameraX,
        PropertyKey::CameraY,
        PropertyKey::CameraScale,
        PropertyKey::CameraAngle,
        PropertyKey::Fps,
        PropertyKey::CanvasWidth,
        PropertyKey::CanvasHeight,
        PropertyKey::Duration,
    ];

    /// Today's property name.
    pub fn id(self) -> &'static str {
        match self {
            PropertyKey::RootX => "root_x",
            PropertyKey::RootY => "root_y",
            PropertyKey::Scale => "scale",
            PropertyKey::Rotation => "rotation",
            PropertyKey::FigureOpacity => "figure_opacity",
            PropertyKey::FigureZOrder => "figure_z_order",
            PropertyKey::GroupX => "group_x",
            PropertyKey::GroupY => "group_y",
            PropertyKey::GroupWidth => "group_width",
            PropertyKey::GroupHeight => "group_height",
            PropertyKey::JointAngle => "joint_angle",
            PropertyKey::JointLength => "joint_length",
            PropertyKey::JointBend => "joint_bend",
            PropertyKey::Thickness => "thickness",
            PropertyKey::SegmentOpacity => "segment_opacity",
            PropertyKey::SegmentGradientOpacity => "segment_gradient_opacity",
            PropertyKey::SegmentZOrder => "segment_z_order",
            PropertyKey::CameraX => "camera_x",
            PropertyKey::CameraY => "camera_y",
            PropertyKey::CameraScale => "camera_scale",
            PropertyKey::CameraAngle => "camera_angle",
            PropertyKey::Fps => "fps",
            PropertyKey::CanvasWidth => "canvas_width",
            PropertyKey::CanvasHeight => "canvas_height",
            PropertyKey::Duration => "duration",
        }
    }

    /// The decimals a property edits with (`propertyPrecision`): none for counts, sizes, rates and draw orders.
    pub fn precision(self) -> u32 {
        match self {
            PropertyKey::Fps | PropertyKey::CanvasWidth | PropertyKey::CanvasHeight | PropertyKey::Duration | PropertyKey::FigureZOrder | PropertyKey::SegmentZOrder => 0,
            _ => 3,
        }
    }

    /// The history label of a gesture (`names` in `native-property-edit.mjs`; other keys read as their name).
    fn label(self) -> &'static str {
        match self {
            PropertyKey::Fps => "Frame rate",
            PropertyKey::CanvasWidth => "Canvas width",
            PropertyKey::CanvasHeight => "Canvas height",
            PropertyKey::Duration => "Keyframe hold",
            PropertyKey::Thickness => "Joint width",
            PropertyKey::SegmentOpacity => "Joint opacity",
            PropertyKey::SegmentGradientOpacity => "Gradient end opacity",
            PropertyKey::GroupX => "Selection X",
            PropertyKey::GroupY => "Selection Y",
            PropertyKey::GroupWidth => "Selection width",
            PropertyKey::GroupHeight => "Selection height",
            PropertyKey::JointAngle => "Joint angle",
            PropertyKey::JointLength => "Joint length",
            PropertyKey::JointBend => "Joint bend",
            PropertyKey::FigureZOrder => "Z-index",
            PropertyKey::FigureOpacity => "Figure opacity",
            PropertyKey::RootX => "root x",
            PropertyKey::RootY => "root y",
            PropertyKey::Scale => "scale",
            PropertyKey::Rotation => "rotation",
            PropertyKey::SegmentZOrder => "segment z order",
            PropertyKey::CameraX => "camera x",
            PropertyKey::CameraY => "camera y",
            PropertyKey::CameraScale => "camera scale",
            PropertyKey::CameraAngle => "camera angle",
        }
    }
}

/// `validate` of `native-property-edit.mjs`: the values the session's routes accept.
pub fn validate(key: PropertyKey, value: f64) -> Result<f64, Msg> {
    if !value.is_finite() || !(value as f32).is_finite() {
        return Err(Msg::new("errors.nativePropertyEdit.enterAFiniteNumberWithinTheNativeRange"));
    }
    use PropertyKey as K;
    let integer = matches!(key, K::Fps | K::CanvasWidth | K::CanvasHeight | K::Duration | K::FigureZOrder);
    let min = match key {
        K::FigureZOrder => -1_000_000.0,
        K::Duration => 0.0,
        _ if integer => 1.0,
        K::Thickness | K::JointLength | K::SegmentOpacity | K::SegmentGradientOpacity | K::FigureOpacity => 0.0,
        K::GroupWidth | K::GroupHeight | K::Scale | K::CameraScale => 0.01,
        _ => f64::NEG_INFINITY,
    };
    let max = match key {
        K::FigureZOrder => 1_000_000.0,
        K::Fps => 1000.0,
        K::Duration => 65535.0,
        K::CanvasWidth | K::CanvasHeight => 16384.0,
        K::SegmentOpacity | K::SegmentGradientOpacity | K::FigureOpacity => 100.0,
        K::Thickness => 1e6,
        _ => f64::INFINITY,
    };
    if integer && value.fract() != 0.0 {
        return Err(Msg::new("errors.nativePropertyEdit.enterAWholeNumber"));
    }
    if value < min || value > max {
        return Err(Msg::new("errors.nativePropertyEdit.enterAValueFromTo").with("min", min).with("max", max));
    }
    Ok(value)
}

/// What a gesture needs to know of the panel's state when it begins.
#[derive(Clone, Debug, Default)]
pub struct Reach {
    /// Frame indices (or, on a layer sheet, ticks) every chosen frame starts at, when Edit together reaches two or more.
    pub ticks: Option<Vec<f64>>,
    pub indices: Option<Vec<usize>>,
}

/// How a property is edited.
#[derive(Clone, Debug)]
enum Route {
    /// An animation channel: the value is `display / factor`.
    Channel { target: Value, property: &'static str, factor: f64 },
    /// A session drag on the selection (`translation` moves, otherwise poses) or on the camera.
    Pose { translation: bool },
    /// The project's own fields: shown as typed, one command when the edit ends.
    Project,
    /// A layer sheet's exposure of the active layer at the playhead.
    SheetDuration { layer: Value, tick: f64 },
}

/// One open property gesture: what began it, what it shows, how it ends. Exactly one of `commit` and `cancel` ends it.
#[derive(Clone, Debug)]
pub struct Gesture {
    pub document: DocumentId,
    pub key: PropertyKey,
    route: Route,
    reach: Reach,
    pub initial: f64,
    pub value: f64,
    /// The selection and playhead it began on: an edit that finds them changed is cancelled, as `assertCurrent` does.
    selection: (Option<u32>, i64),
    tick: f64,
    revision: u64,
}

fn refusal(error: &EditError) -> Msg {
    crate::commands::refusal(error)
}

fn answer(answer: Result<CallAnswer, crate::documents::DocumentsError>) -> Result<Value, Msg> {
    match answer {
        Ok(CallAnswer { result: Ok(value), .. }) => Ok(value),
        Ok(CallAnswer { result: Err(error), .. }) => Err(refusal(&error)),
        Err(error) => Err(Msg::owned(error.message_key().to_string())),
    }
}

fn call(documents: &mut Documents, id: DocumentId, method: &str, args: &[Value]) -> Result<Value, Msg> {
    answer(documents.call(id, method, args, &Value::Null))
}

fn object(pairs: &[(&str, Value)]) -> Value {
    let mut obj = Obj::new();
    for (key, value) in pairs {
        obj.set(key, value.clone());
    }
    Value::object(obj)
}

fn label_options(label: &str) -> Value {
    object(&[("label", Value::str(label))])
}

/// A range command's options: its label and, on a layer sheet, the ticks the chosen frames start at (`sheetTicks`).
pub(crate) fn range_options(label: &str, ticks: Option<&[f64]>) -> Value {
    let mut pairs = vec![("label", Value::str(label))];
    if let Some(ticks) = ticks {
        pairs.push(("ticks", Value::array(ticks.iter().map(|tick| Value::Num(*tick)).collect())));
    }
    object(&pairs)
}

/// The figure the selection shows, its pose record and the selected joint's segment id: what the routes read.
pub(crate) struct Selected {
    pub uid: Option<u32>,
    pub count: usize,
    pub joint: i64,
    pub segment_id: Option<u32>,
    pub has_secondary: bool,
    pub movieclip: bool,
    pub sheet: bool,
}

pub(crate) fn selected(document: &Document) -> Selected {
    let selection = document.selection();
    let (segment_id, has_secondary, movieclip) = super::facts::figure_of_selection(document)
        .map(|(figure, _)| {
            let segment = usize::try_from(selection.joint).ok().and_then(|joint| figure.segments.get(joint));
            (segment.map(|segment| segment.id), segment.is_some_and(|segment| segment.secondary.is_some()), figure.movieclip.is_some())
        })
        .unwrap_or((None, false, false));
    Selected {
        uid: selection.uid,
        count: selection.uids.len(),
        joint: selection.joint,
        segment_id,
        has_secondary,
        movieclip,
        sheet: document.records().path(&["_styk", "layerSheet"]).is_some_and(Value::is_object),
    }
}

/// `propertyChannel(key)` of `src/app.mjs`, for the keys the Inspector shows (the session always has property channels).
fn channel(key: PropertyKey, selected: &Selected) -> Option<Route> {
    use PropertyKey as K;
    let camera = |property| Some(Route::Channel { target: object(&[("kind", Value::str("camera"))]), property, factor: 1.0 });
    match key {
        K::CameraX => camera("x"),
        K::CameraY => camera("y"),
        K::CameraScale => Some(Route::Channel { target: object(&[("kind", Value::str("camera"))]), property: "scale", factor: 100.0 }),
        K::CameraAngle => Some(Route::Channel { target: object(&[("kind", Value::str("camera"))]), property: "rotation", factor: 180.0 / std::f64::consts::PI }),
        K::Scale | K::FigureOpacity | K::FigureZOrder if selected.count == 1 && !selected.movieclip => {
            let uid = selected.uid?;
            let (property, factor) = match key {
                K::Scale => ("scale", 100.0),
                K::FigureOpacity => ("opacity", 100.0),
                _ => ("zIndex", 1.0),
            };
            Some(Route::Channel { target: object(&[("kind", Value::str("figure")), ("uid", Value::Num(f64::from(uid)))]), property, factor })
        }
        K::Thickness | K::SegmentOpacity | K::SegmentGradientOpacity if selected.count == 1 => {
            let (uid, handle) = (selected.uid?, selected.segment_id?);
            if key == K::SegmentGradientOpacity && !selected.has_secondary {
                return None;
            }
            let (property, factor) = match key {
                K::Thickness => ("thickness", 1.0),
                K::SegmentOpacity => ("opacity", 100.0),
                _ => ("gradientOpacity", 100.0),
            };
            // `segmentAnimationTarget(uid, handleId)`: the segment's target as the session normalises it.
            let target = object(&[("kind", Value::str("segment")), ("uid", Value::Num(f64::from(uid))), ("handleId", Value::Num(f64::from(handle)))]);
            Some(Route::Channel { target, property, factor })
        }
        _ => None,
    }
}

impl Gesture {
    /// Begins editing `key` from the value the panel shows (`value`): `PropertyControls._begin` and the app's `begin`.
    pub fn begin(documents: &mut Documents, id: DocumentId, key: PropertyKey, value: f64, reach: Reach) -> Result<Gesture, Msg> {
        use PropertyKey as K;
        let document = documents.get(id).ok_or_else(|| Msg::new("errors.editorSessions.thisProjectIsNoLongerOpen"))?;
        if !value.is_finite() {
            return Err(Msg::new("errors.nativePropertyEdit.theSelectedPropertyHasNoFiniteValue"));
        }
        let selected = selected(document);
        let view = document.view();
        let (tick, revision, selection) = (view.tick, view.revision, (selected.uid, selected.joint));
        let route = match channel(key, &selected) {
            Some(route) => route,
            None => match key {
                K::Fps | K::CanvasWidth | K::CanvasHeight => Route::Project,
                K::Duration if selected.sheet => {
                    let layer = document.records().path(&["_styk", "layers", "activeId"]).cloned().unwrap_or(Value::str("layer-1"));
                    Route::SheetDuration { layer, tick }
                }
                K::RootX | K::RootY | K::GroupX | K::GroupY => Route::Pose { translation: true },
                K::Scale | K::Rotation | K::FigureOpacity | K::FigureZOrder | K::GroupWidth | K::GroupHeight | K::JointAngle | K::JointLength | K::JointBend => {
                    Route::Pose { translation: false }
                }
                // The definition of a figure and the fields of a frame are edited by the engine's commands, never in place.
                _ => return Err(Msg::new("errors.engineOwner.notSupported")),
            },
        };
        if matches!(route, Route::Pose { .. }) && selected.uid.is_none() {
            return Err(Msg::new("errors.nativePropertyEdit.chooseAFigureFirst"));
        }
        if matches!(key, K::JointAngle | K::JointLength | K::JointBend) && selected.segment_id.is_none() {
            return Err(Msg::new("errors.nativePropertyEdit.selectThePropertyBeforeEditingIt"));
        }
        match &route {
            Route::Channel { target, property, .. } => {
                call(documents, id, "beginAnimationEdit", &[target.clone(), Value::str(property)])?;
            }
            Route::Pose { translation } => {
                let scope = if *translation { "translation" } else { "selection" };
                let began = call(documents, id, "beginDrag", &[Value::str(key.label()), object(&[("scope", Value::str(scope))])])?;
                if !began.truthy() {
                    return Err(Msg::new("errors.nativePropertyEdit.chooseAFigureFirst"));
                }
            }
            Route::Project | Route::SheetDuration { .. } => {}
        }
        Ok(Gesture { document: id, key, route, reach, initial: value, value, selection, tick, revision })
    }

    fn current(&self, documents: &Documents) -> Result<(), Msg> {
        let document = documents.get(self.document).ok_or_else(|| Msg::new("errors.nativePropertyEdit.thisPropertyGestureHasEnded"))?;
        let selection = document.selection();
        if (selection.uid, selection.joint) != self.selection || document.view().tick != self.tick {
            return Err(Msg::new("errors.nativePropertyEdit.theSelectedPropertyChangedDuringTheGesture"));
        }
        Ok(())
    }

    /// Shows `value` while the gesture is open (`previewNativePropertyEdit` and `previewAnimationEdit`).
    pub fn preview(&mut self, documents: &mut Documents, value: f64) -> Result<bool, Msg> {
        use PropertyKey as K;
        self.current(documents)?;
        validate(self.key, value)?;
        if value == self.value {
            return Ok(false);
        }
        let id = self.document;
        match &self.route {
            Route::Project | Route::SheetDuration { .. } => {}
            Route::Channel { factor, .. } => {
                call(documents, id, "previewAnimationEdit", &[Value::Num(value / factor)])?;
            }
            Route::Pose { .. } => match self.key {
                K::RootX | K::RootY | K::GroupX | K::GroupY => {
                    let delta = value - self.initial;
                    let (dx, dy) = if matches!(self.key, K::RootX | K::GroupX) { (delta, 0.0) } else { (0.0, delta) };
                    call(documents, id, "moveSelection", &[Value::Num(dx), Value::Num(dy), object(&[("fromStart", Value::Bool(true))])])?;
                }
                K::Scale => {
                    call(documents, id, "updateObject", &[object(&[("scale", Value::Num(value / 100.0))])])?;
                }
                K::Rotation => {
                    let shown = documents.get(id).and_then(super::facts::rotation_of_selection).unwrap_or(self.value);
                    call(documents, id, "rotateFigure", &[Value::Num(radians(value - shown))])?;
                }
                K::FigureOpacity => {
                    call(documents, id, "updateObject", &[object(&[("field28", Value::Num(((1.0 - value / 100.0) * 255.0).round()))])])?;
                }
                // A stacking number of zero is the figure without one.
                K::FigureZOrder => {
                    let z = if value == 0.0 { Value::Null } else { Value::Num(value) };
                    call(documents, id, "updateObject", &[object(&[("_stykZIndex", z)])])?;
                }
                K::GroupWidth | K::GroupHeight => {
                    if self.initial <= 0.0 {
                        return Err(Msg::new("errors.nativePropertyEdit.increaseTheSelectionSizeBeforeScaling"));
                    }
                    // The size is applied when the edit ends (a scale is relative to the figures as they are).
                }
                K::JointAngle => {
                    call(documents, id, "updateSegment", &[object(&[("angle_rad", Value::Num(radians(value)))])])?;
                }
                K::JointLength => {
                    call(documents, id, "updateSegment", &[object(&[("length", Value::Num(value))])])?;
                }
                K::JointBend => {
                    call(documents, id, "updateSegment", &[object(&[("bend_rad", Value::Num(radians(value)))])])?;
                }
                _ => return Err(Msg::new("errors.engineOwner.notSupported")),
            },
        }
        self.value = value;
        Ok(true)
    }

    /// Ends the gesture with its value: one history entry, or none when nothing changed.
    pub fn commit(self, documents: &mut Documents) -> Result<bool, Msg> {
        use PropertyKey as K;
        if let Err(error) = self.current(documents).and_then(|()| validate(self.key, self.value).map(|_| ())) {
            self.cancel(documents);
            return Err(error);
        }
        if self.value == self.initial {
            self.cancel(documents);
            return Ok(false);
        }
        let id = self.document;
        let value = self.value;
        let result = match &self.route {
            Route::Project => {
                let options = label_options(self.key.label());
                if self.key == K::Fps {
                    call(documents, id, "setFPS", &[Value::Num(value), options])
                } else {
                    call(documents, id, "updateProject", &[object(&[(self.key.id(), Value::Num(value))]), options])
                }
            }
            Route::SheetDuration { layer, tick } => call(documents, id, "sheetSetDuration", &[Value::Num(value), layer.clone(), Value::Num(*tick)]),
            Route::Channel { target, property, factor } => match &self.reach.ticks {
                Some(ticks) if ticks.len() > 1 => {
                    call(documents, id, "cancelAnimationEdit", &[])?;
                    let entries = ticks
                        .iter()
                        .map(|tick| object(&[("target", target.clone()), ("property", Value::str(property)), ("tick", Value::Num(*tick)), ("value", Value::Num(value / factor))]))
                        .collect();
                    call(documents, id, "addAnimationKeys", &[Value::array(entries)])
                }
                _ => call(documents, id, "commitAnimationEdit", &[]),
            },
            Route::Pose { .. } => match (&self.reach.indices, self.key) {
                (Some(indices), _) if indices.len() > 1 => {
                    // The preview was the frame on show: the value is set in every chosen frame, from where each one stands.
                    call(documents, id, "cancelDrag", &[])?;
                    let frames = Value::array(indices.iter().map(|index| Value::Num(*index as f64)).collect());
                    call(documents, id, "setPoseProperty", &[Value::str(self.key.id()), Value::Num(value), frames, range_options(self.key.label(), self.reach.ticks.as_deref())])
                        .map(|changed| Value::Bool(changed.get("changedFrames").and_then(Value::as_f64).unwrap_or(0.0) > 0.0))
                }
                (_, K::GroupWidth | K::GroupHeight) => {
                    call(documents, id, "cancelDrag", &[])?;
                    call(documents, id, "scaleSelection", &[Value::Num(value / self.initial), label_options(self.key.label())])
                }
                _ => call(documents, id, "commitDrag", &[]),
            },
        };
        match result {
            Ok(value) => Ok(value.truthy()),
            Err(error) => {
                self.cancel(documents);
                Err(error)
            }
        }
    }

    /// Abandons the gesture: the document shows what it did before it began, and history is unchanged.
    pub fn cancel(self, documents: &mut Documents) {
        let id = self.document;
        // `cancelNativePropertyEdit`: a document that changed under the gesture (an undo, another tab) is left alone.
        if documents.get(id).is_none_or(|document| document.revision() != self.revision) {
            return;
        }
        // A refused cancel has nothing left to roll back: the session's own gesture state is what it restores.
        let _ = match self.route {
            Route::Channel { .. } => call(documents, id, "cancelAnimationEdit", &[]),
            Route::Pose { .. } => call(documents, id, "cancelDrag", &[]),
            Route::Project | Route::SheetDuration { .. } => Ok(Value::Null),
        };
    }
}

/// Degrees to radians in today's order of operations, `value * Math.PI / 180`.
fn radians(degrees: f64) -> f64 {
    degrees * std::f64::consts::PI / 180.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_matches_today_s_ranges() {
        assert!(validate(PropertyKey::Fps, 24.0).is_ok());
        assert_eq!(validate(PropertyKey::Fps, 24.5).unwrap_err().key, "errors.nativePropertyEdit.enterAWholeNumber");
        assert_eq!(validate(PropertyKey::Fps, 1001.0).unwrap_err().key, "errors.nativePropertyEdit.enterAValueFromTo");
        assert!(validate(PropertyKey::Duration, 0.0).is_ok());
        assert!(validate(PropertyKey::FigureZOrder, -1_000_000.0).is_ok());
        assert!(validate(PropertyKey::Scale, 0.0).is_err());
        assert!(validate(PropertyKey::RootX, -1e9).is_ok());
        assert!(validate(PropertyKey::RootX, 1e300).is_err(), "beyond a float the session would store");
        assert!(validate(PropertyKey::SegmentOpacity, 100.0).is_ok() && validate(PropertyKey::SegmentOpacity, 100.5).is_err());
    }

}
