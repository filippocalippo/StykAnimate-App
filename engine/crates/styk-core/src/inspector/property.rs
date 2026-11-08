//! The Inspector's number properties and the gesture that edits one through the session.
//!
//! A port of today's routes for a number field (`src/app.mjs` `propertyChannel` and the PropertyControls callbacks,
//! `src/native-property-edit.mjs`, `src/editor-builder-style.mjs`): a property with an animation channel is one
//! `beginAnimationEdit` ... `previewAnimationEdit` ... `commitAnimationEdit` (over several frames, `addAnimationKeys`);
//! a draw order is the same edit over every drawable of the figure; a pose value is a session drag (`beginDrag` ...
//! `commitDrag`, `setPoseProperty`, `scaleSelection`); the project's fields and a sheet's exposure are one command when
//! the edit ends. Each gesture is one history entry; any end that does not commit cancels the session's gesture
//! explicitly, so a refusal never leaves the session editing. Every call goes through [`crate::answers`].

use std::borrow::Cow;

#[cfg(feature = "engine")]
use styk_doc::{Obj, Value};

#[cfg(feature = "engine")]
use super::order::{self, DrawKind, Drawable};
#[cfg(feature = "engine")]
use crate::answers::{self, Session};
#[cfg(feature = "engine")]
use crate::documents::{Document, DocumentId, Documents};
use crate::i18n::Msg;
#[cfg(feature = "engine")]
use crate::range::Range;

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
    /// A fill's opacity and draw order, by its index among the figure's fills.
    PolygonOpacity(u32),
    PolygonZOrder(u32),
}

impl PropertyKey {
    /// The keys that are not a fill's.
    pub const FIXED: [PropertyKey; 25] = [
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

    /// The key of today's property name (`root_x`, `polygon_2_opacity`).
    pub fn from_id(id: &str) -> Option<PropertyKey> {
        if let Some(found) = PropertyKey::FIXED.iter().find(|key| key.id() == id) {
            return Some(*found);
        }
        let rest = id.strip_prefix("polygon_")?;
        let (index, property) = rest.split_once('_')?;
        let index: u32 = index.parse().ok()?;
        match property {
            "opacity" => Some(PropertyKey::PolygonOpacity(index)),
            "z_order" => Some(PropertyKey::PolygonZOrder(index)),
            _ => None,
        }
    }

    /// Today's property name.
    pub fn id(self) -> Cow<'static, str> {
        Cow::Borrowed(match self {
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
            PropertyKey::PolygonOpacity(index) => return Cow::Owned(format!("polygon_{index}_opacity")),
            PropertyKey::PolygonZOrder(index) => return Cow::Owned(format!("polygon_{index}_z_order")),
        })
    }

    /// The decimals a property edits with (`propertyPrecision`): none for counts, sizes, rates and draw orders.
    pub fn precision(self) -> u32 {
        match self {
            PropertyKey::Fps | PropertyKey::CanvasWidth | PropertyKey::CanvasHeight | PropertyKey::Duration | PropertyKey::FigureZOrder | PropertyKey::SegmentZOrder | PropertyKey::PolygonZOrder(_) => 0,
            _ => 3,
        }
    }

    /// The history label of a gesture (`names` in `native-property-edit.mjs`; other keys read as their name).
    #[cfg(feature = "engine")]
    fn label(self) -> Cow<'static, str> {
        Cow::Borrowed(match self {
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
            other => return Cow::Owned(other.id().replace('_', " ")),
        })
    }
}

/// `validate` of `native-property-edit.mjs` (and the fill opacity's of `editor-builder-style.mjs`).
pub fn validate(key: PropertyKey, value: f64) -> Result<f64, Msg> {
    if !value.is_finite() || !(value as f32).is_finite() {
        return Err(Msg::new("errors.nativePropertyEdit.enterAFiniteNumberWithinTheNativeRange"));
    }
    use PropertyKey as K;
    if let K::PolygonOpacity(_) = key
        && !(0.0..=100.0).contains(&value)
    {
        return Err(Msg::new("errors.editorBuilderStyle.polygonOpacityMustBeFrom0To100"));
    }
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

/// How a property is edited.
#[cfg(feature = "engine")]
#[derive(Clone, Debug)]
enum Route {
    /// An animation channel: the value is `display / factor`.
    Channel { target: Value, property: &'static str, factor: f64 },
    /// A figure's draw order: one edit of every drawable's `zIndex` (`orderAnimation`).
    Order { entries: Vec<Drawable>, targets: Vec<Value>, selected: (DrawKind, usize), values: Option<Vec<f64>> },
    /// A session drag on the selection (`translation` moves, otherwise poses).
    Pose { translation: bool },
    /// The project's own fields: shown as typed, one command when the edit ends.
    Project,
    /// A layer sheet's exposure of the active layer at the playhead.
    SheetDuration { layer: Value, tick: f64 },
}

/// One open property gesture: what began it, what it shows, how it ends. Exactly one of `commit` and `cancel` ends it.
#[cfg(feature = "engine")]
#[derive(Clone, Debug)]
pub struct Gesture {
    pub document: DocumentId,
    pub key: PropertyKey,
    route: Route,
    range: Option<Range>,
    pub initial: f64,
    pub value: f64,
    /// The selection and playhead it began on: an edit that finds them changed is cancelled, as `assertCurrent` does.
    selection: (Option<u32>, i64),
    tick: f64,
}

#[cfg(feature = "engine")]
fn object(pairs: &[(&str, Value)]) -> Value {
    let mut obj = Obj::new();
    for (key, value) in pairs {
        obj.set(key, value.clone());
    }
    Value::object(obj)
}

#[cfg(feature = "engine")]
fn label_options(label: &str) -> Value {
    object(&[("label", Value::str(label))])
}

/// What the routes read of the selection.
#[cfg(feature = "engine")]
pub(crate) struct Selected {
    pub uid: Option<u32>,
    pub count: usize,
    pub joint: i64,
    pub figure_type: Option<u32>,
    pub segment_id: Option<u32>,
    pub has_secondary: bool,
    pub movieclip: bool,
    pub sheet: bool,
    pub polygons: Vec<u32>,
    pub drawables: Vec<Drawable>,
}

#[cfg(feature = "engine")]
pub(crate) fn selected(document: &Document) -> Selected {
    let selection = super::facts::selection(document);
    let found = super::facts::figure_of_selection(document);
    let (segment_id, has_secondary, movieclip, figure_type, polygons, drawables) = found
        .as_ref()
        .map(|(figure, object)| {
            let segment = usize::try_from(selection.joint).ok().and_then(|joint| figure.segments.get(joint));
            (
                segment.map(|segment| segment.id),
                segment.is_some_and(|segment| segment.secondary.is_some()),
                figure.movieclip.is_some(),
                Some(figure.id),
                figure.polyfills.iter().map(|polygon| polygon.id).collect(),
                order::drawables(figure, object),
            )
        })
        .unwrap_or((None, false, false, None, Vec::new(), Vec::new()));
    Selected {
        uid: selection.uid,
        count: selection.uids.len(),
        joint: selection.joint,
        figure_type,
        segment_id,
        has_secondary,
        movieclip,
        sheet: super::facts::records(document).path(&["_styk", "layerSheet"]).is_some_and(Value::is_object),
        polygons,
        drawables,
    }
}

/// The animation target of a drawable of the figure on show (`builderOrderTargets`).
#[cfg(feature = "engine")]
fn drawable_target(uid: u32, figure_type: u32, drawable: &Drawable) -> Value {
    let (kind, id_key) = match drawable.kind {
        DrawKind::Segment => ("segment", "handleId"),
        DrawKind::Polygon => ("polygon", "polygonId"),
    };
    object(&[("kind", Value::str(kind)), ("uid", Value::Num(f64::from(uid))), ("figureTypeId", Value::Num(f64::from(figure_type))), (id_key, Value::Num(f64::from(drawable.id)))])
}

/// The route of a key for this selection: `propertyChannel(key)` of `src/app.mjs`, `builderStyleProperty` for draw
/// orders and fill opacity, and `beginNativePropertyEdit`'s for the rest.
#[cfg(feature = "engine")]
fn route(key: PropertyKey, selected: &Selected, document: &Document) -> Result<Route, Msg> {
    use PropertyKey as K;
    let camera = |property, factor| Ok(Route::Channel { target: object(&[("kind", Value::str("camera"))]), property, factor });
    let figure = || selected.uid.filter(|_| selected.count == 1 && !selected.movieclip);
    Ok(match key {
        K::CameraX => return camera("x", 1.0),
        K::CameraY => return camera("y", 1.0),
        K::CameraScale => return camera("scale", 100.0),
        K::CameraAngle => return camera("rotation", 180.0 / std::f64::consts::PI),
        K::Scale | K::FigureOpacity | K::FigureZOrder if figure().is_some() => {
            let uid = figure().unwrap_or_default();
            let (property, factor) = match key {
                K::Scale => ("scale", 100.0),
                K::FigureOpacity => ("opacity", 100.0),
                _ => ("zIndex", 1.0),
            };
            Route::Channel { target: object(&[("kind", Value::str("figure")), ("uid", Value::Num(f64::from(uid)))]), property, factor }
        }
        K::Thickness | K::SegmentOpacity | K::SegmentGradientOpacity if selected.count == 1 && selected.uid.is_some() && selected.segment_id.is_some() => {
            if key == K::SegmentGradientOpacity && !selected.has_secondary {
                return Err(Msg::new("errors.nativePropertyEdit.selectThePropertyBeforeEditingIt"));
            }
            let (property, factor) = match key {
                K::Thickness => ("thickness", 1.0),
                K::SegmentOpacity => ("opacity", 100.0),
                _ => ("gradientOpacity", 100.0),
            };
            let (uid, handle) = (selected.uid.unwrap_or_default(), selected.segment_id.unwrap_or_default());
            // `segmentAnimationTarget(uid, handleId)`: the segment's target as the session normalises it.
            Route::Channel { target: object(&[("kind", Value::str("segment")), ("uid", Value::Num(f64::from(uid))), ("handleId", Value::Num(f64::from(handle)))]), property, factor }
        }
        K::PolygonOpacity(index) => {
            let (Some(uid), Some(figure_type), Some(id)) = (selected.uid, selected.figure_type, selected.polygons.get(index as usize)) else {
                return Err(Msg::new("errors.editorBuilderStyle.selectAnExistingSegmentOrPolygon"));
            };
            let target = object(&[("kind", Value::str("polygon")), ("uid", Value::Num(f64::from(uid))), ("polygonId", Value::Num(f64::from(*id))), ("figureTypeId", Value::Num(f64::from(figure_type)))]);
            Route::Channel { target, property: "opacity", factor: 100.0 }
        }
        K::SegmentZOrder | K::PolygonZOrder(_) => {
            let selected_entry = match key {
                K::PolygonZOrder(index) => (DrawKind::Polygon, index as usize),
                _ => (DrawKind::Segment, usize::try_from(selected.joint).unwrap_or(usize::MAX)),
            };
            let (Some(uid), Some(figure_type)) = (selected.uid, selected.figure_type) else {
                return Err(Msg::new("errors.editorBuilderStyle.selectAnExistingSegmentOrPolygon"));
            };
            if order::position(&selected.drawables, selected_entry.0, selected_entry.1).is_none() {
                return Err(Msg::new("errors.editorBuilderStyle.selectAnExistingSegmentOrPolygon"));
            }
            let targets = selected.drawables.iter().map(|drawable| drawable_target(uid, figure_type, drawable)).collect();
            Route::Order { entries: selected.drawables.clone(), targets, selected: selected_entry, values: None }
        }
        K::Fps | K::CanvasWidth | K::CanvasHeight => Route::Project,
        K::Duration if selected.sheet => {
            let layer = super::facts::records(document).path(&["_styk", "layers", "activeId"]).cloned().unwrap_or(Value::str("layer-1"));
            Route::SheetDuration { layer, tick: super::facts::tick(document) }
        }
        K::RootX | K::RootY | K::GroupX | K::GroupY => Route::Pose { translation: true },
        K::Scale | K::Rotation | K::FigureOpacity | K::FigureZOrder | K::GroupWidth | K::GroupHeight | K::JointAngle | K::JointLength | K::JointBend => Route::Pose { translation: false },
        // The definition of a figure and the fields of a frame are edited by the engine's commands, never in place.
        _ => return Err(Msg::new("errors.engineOwner.notSupported")),
    })
}

#[cfg(feature = "engine")]
impl Gesture {
    /// Begins editing `key` from the value the panel shows (`value`): `PropertyControls._begin` and the app's `begin`.
    pub fn begin(documents: &mut Documents, id: DocumentId, key: PropertyKey, value: f64, range: Option<Range>, session: &mut Session) -> Result<Gesture, Msg> {
        use PropertyKey as K;
        let document = documents.get(id).ok_or_else(|| Msg::new("errors.editorSessions.thisProjectIsNoLongerOpen"))?;
        if !value.is_finite() {
            return Err(Msg::new("errors.nativePropertyEdit.theSelectedPropertyHasNoFiniteValue"));
        }
        let selected = selected(document);
        let tick = super::facts::tick(document);
        let route = route(key, &selected, document)?;
        if matches!(route, Route::Pose { .. }) && selected.uid.is_none() {
            return Err(Msg::new("errors.nativePropertyEdit.chooseAFigureFirst"));
        }
        if matches!(key, K::JointAngle | K::JointLength | K::JointBend) && selected.segment_id.is_none() {
            return Err(Msg::new("errors.nativePropertyEdit.selectThePropertyBeforeEditingIt"));
        }
        let mut call = |method: &str, args: &[Value]| answers::call(documents, id, method, args, session);
        match &route {
            Route::Channel { target, property, .. } => {
                call("beginAnimationEdit", &[target.clone(), Value::str(property)])?;
            }
            Route::Order { targets, .. } => {
                call("beginAnimationEdit", &[Value::array(targets.clone()), Value::str("zIndex"), object(&[("exactTarget", Value::Bool(true))])])?;
            }
            Route::Pose { translation } => {
                let scope = if *translation { "translation" } else { "selection" };
                let began = call("beginDrag", &[Value::str(&key.label()), object(&[("scope", Value::str(scope))])])?;
                if !began.truthy() {
                    return Err(Msg::new("errors.nativePropertyEdit.chooseAFigureFirst"));
                }
            }
            Route::Project | Route::SheetDuration { .. } => {}
        }
        Ok(Gesture { document: id, key, route, range, initial: value, value, selection: (selected.uid, selected.joint), tick })
    }

    fn current(&self, documents: &Documents) -> Result<(), Msg> {
        let document = documents.get(self.document).ok_or_else(|| Msg::new("errors.nativePropertyEdit.thisPropertyGestureHasEnded"))?;
        let selection = super::facts::selection(document);
        if (selection.uid, selection.joint) != self.selection || super::facts::tick(document) != self.tick {
            return Err(Msg::new("errors.nativePropertyEdit.theSelectedPropertyChangedDuringTheGesture"));
        }
        Ok(())
    }

    /// Shows `value` while the gesture is open. On a refusal the caller cancels the gesture.
    pub fn preview(&mut self, documents: &mut Documents, value: f64, session: &mut Session) -> Result<bool, Msg> {
        use PropertyKey as K;
        self.current(documents)?;
        if !matches!(self.route, Route::Order { .. }) {
            validate(self.key, value)?;
        }
        if value == self.value {
            return Ok(false);
        }
        let id = self.document;
        let shown_rotation = documents.get(id).and_then(super::facts::rotation_of_selection);
        let (method, args): (&str, Vec<Value>) = match &mut self.route {
            Route::Project | Route::SheetDuration { .. } => {
                self.value = value;
                return Ok(true);
            }
            Route::Channel { factor, .. } => ("previewAnimationEdit", vec![Value::Num(value / *factor)]),
            Route::Order { entries, selected, values, .. } => {
                let next = order::values(entries, *selected, value)?;
                let args = vec![Value::array(next.iter().map(|value| Value::Num(*value)).collect())];
                *values = Some(next);
                ("previewAnimationEdit", args)
            }
            Route::Pose { .. } => match self.key {
                K::RootX | K::RootY | K::GroupX | K::GroupY => {
                    let delta = value - self.initial;
                    let (dx, dy) = if matches!(self.key, K::RootX | K::GroupX) { (delta, 0.0) } else { (0.0, delta) };
                    ("moveSelection", vec![Value::Num(dx), Value::Num(dy), object(&[("fromStart", Value::Bool(true))])])
                }
                K::Scale => ("updateObject", vec![object(&[("scale", Value::Num(value / 100.0))])]),
                K::Rotation => ("rotateFigure", vec![Value::Num(radians(value - shown_rotation.unwrap_or(self.value)))]),
                K::FigureOpacity => ("updateObject", vec![object(&[("field28", Value::Num(((1.0 - value / 100.0) * 255.0).round()))])]),
                // A stacking number of zero is the figure without one.
                K::FigureZOrder => ("updateObject", vec![object(&[("_stykZIndex", if value == 0.0 { Value::Null } else { Value::Num(value) })])]),
                K::GroupWidth | K::GroupHeight => {
                    if self.initial <= 0.0 {
                        return Err(Msg::new("errors.nativePropertyEdit.increaseTheSelectionSizeBeforeScaling"));
                    }
                    // The size is applied when the edit ends (a scale is relative to the figures as they are).
                    self.value = value;
                    return Ok(true);
                }
                K::JointAngle => ("updateSegment", vec![object(&[("angle_rad", Value::Num(radians(value)))])]),
                K::JointLength => ("updateSegment", vec![object(&[("length", Value::Num(value))])]),
                K::JointBend => ("updateSegment", vec![object(&[("bend_rad", Value::Num(radians(value)))])]),
                _ => return Err(Msg::new("errors.engineOwner.notSupported")),
            },
        };
        answers::call(documents, id, method, &args, session)?;
        self.value = value;
        Ok(true)
    }

    /// Ends the gesture with `value` (the field model's committed value): one history entry, or none when nothing
    /// changed. Every path that does not commit cancels the session's gesture before returning.
    pub fn commit(mut self, documents: &mut Documents, value: f64, session: &mut Session) -> Result<bool, Msg> {
        if let Err(error) = self.preview(documents, value, session).and_then(|_| self.current(documents)) {
            self.cancel(documents, session);
            return Err(error);
        }
        if !matches!(self.route, Route::Order { .. })
            && let Err(error) = validate(self.key, self.value)
        {
            self.cancel(documents, session);
            return Err(error);
        }
        if self.value == self.initial {
            self.cancel(documents, session);
            return Ok(false);
        }
        let result = self.finish(documents, session);
        if result.is_err() {
            self.cancel(documents, session);
        }
        result
    }

    fn finish(&self, documents: &mut Documents, session: &mut Session) -> Result<bool, Msg> {
        use PropertyKey as K;
        let id = self.document;
        let value = self.value;
        let ticks = match (&self.range, documents.get(id)) {
            (Some(range), Some(document)) if range.len() > 1 => Some(range.ticks(document)),
            _ => None,
        };
        let mut call = |method: &str, args: &[Value]| answers::call(documents, id, method, args, session);
        let result = match &self.route {
            Route::Project => {
                let options = label_options(&self.key.label());
                if self.key == K::Fps {
                    call("setFPS", &[Value::Num(value), options])
                } else {
                    call("updateProject", &[object(&[(&self.key.id(), Value::Num(value))]), options])
                }
            }
            Route::SheetDuration { layer, tick } => call("sheetSetDuration", &[Value::Num(value), layer.clone(), Value::Num(*tick)]),
            Route::Channel { target, property, factor } => match &ticks {
                Some(ticks) => {
                    call("cancelAnimationEdit", &[])?;
                    let entries = ticks.iter().map(|tick| object(&[("target", target.clone()), ("property", Value::str(property)), ("tick", Value::Num(*tick)), ("value", Value::Num(value / factor))])).collect();
                    call("addAnimationKeys", &[Value::array(entries)])
                }
                None => call("commitAnimationEdit", &[]),
            },
            Route::Order { targets, values, .. } => match (&ticks, values) {
                (Some(ticks), Some(values)) => {
                    call("cancelAnimationEdit", &[])?;
                    let entries = ticks
                        .iter()
                        .flat_map(|tick| {
                            targets.iter().zip(values).map(move |(target, value)| {
                                object(&[("target", target.clone()), ("property", Value::str("zIndex")), ("tick", Value::Num(*tick)), ("value", Value::Num(*value)), ("exactTarget", Value::Bool(true)), ("interpolation", Value::str("constant"))])
                            })
                        })
                        .collect();
                    call("addAnimationKeys", &[Value::array(entries)])
                }
                _ => call("commitAnimationEdit", &[]),
            },
            Route::Pose { .. } => match (&self.range, self.key) {
                (Some(range), _) if range.len() > 1 => {
                    // The preview was the frame on show: the value is set in every chosen frame, from where each one stands.
                    call("cancelDrag", &[])?;
                    call("setPoseProperty", &[Value::str(&self.key.id()), Value::Num(value), pose_frames(range), label_options(&self.key.label())])
                        .map(|changed| Value::Bool(changed.get("changedFrames").and_then(Value::as_f64).unwrap_or(0.0) > 0.0))
                }
                (_, K::GroupWidth | K::GroupHeight) => {
                    call("cancelDrag", &[])?;
                    call("scaleSelection", &[Value::Num(value / self.initial), label_options(&self.key.label())])
                }
                _ => call("commitDrag", &[]),
            },
        };
        result.map(|value| value.truthy())
    }

    /// Abandons the gesture: the session's own gesture is cancelled, so the document shows what it did before and the
    /// session is not left editing. Nothing to cancel when the document is gone.
    pub fn cancel(self, documents: &mut Documents, session: &mut Session) {
        let id = self.document;
        if documents.get(id).is_none() {
            return;
        }
        // A refused cancel has nothing left to roll back: the session's own gesture state is what it restores.
        let _ = match self.route {
            Route::Channel { .. } | Route::Order { .. } => answers::call(documents, id, "cancelAnimationEdit", &[], session),
            Route::Pose { .. } => answers::call(documents, id, "cancelDrag", &[], session),
            Route::Project | Route::SheetDuration { .. } => Ok(Value::Null),
        };
    }
}

/// A pose edit's frames: `editor._frameIndices([...indices, frameIndex])` with `sheetTicks = sheetEditTimes(...)`,
/// that is sorted and once each.
#[cfg(feature = "engine")]
fn pose_frames(range: &Range) -> Value {
    let mut sorted = range.clone();
    sorted.indices.sort_unstable();
    sorted.indices.dedup();
    if let Some(ticks) = sorted.sheet_ticks.as_mut() {
        ticks.sort_by(f64::total_cmp);
        ticks.dedup();
    }
    sorted.value()
}

/// Degrees to radians in today's order of operations, `value * Math.PI / 180`.
#[cfg(feature = "engine")]
fn radians(degrees: f64) -> f64 {
    degrees * std::f64::consts::PI / 180.0
}

#[cfg(feature = "engine")]
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
        assert_eq!(validate(PropertyKey::PolygonOpacity(0), 101.0).unwrap_err().key, "errors.editorBuilderStyle.polygonOpacityMustBeFrom0To100");
    }
}
