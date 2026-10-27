//! Figure controls across frames (`applyFigureRange` and the
//! `*InFrames` commands): a figure operation planned on each frame of a range
//! ([`crate::range_plan`]) and committed as one history entry, through the layer sheet's
//! range commit (`_commitSheetRange`) or, on a native timeline, as a `figure-range` entry
//! patching the keyframes. Also the commands that reach it: figure order
//! (`bringToFront`, `sendToBack`, `moveSelectionLayer`, `orderSelection`), flipping a branch
//! (`mirrorSelection` and `mirrorFigure` on a joint), `mirrorFigure` itself, and moving figures
//! across frames (`moveSelectionInFrames`, `sheetMoveSelection`). Recolouring goes through the
//! same operation ([`crate::recolor`]).
//!
//! Movieclips, pasting across frames, aligning (the app measures bounds with a function of
//! its own) and figures with effect clips answer `Unported`.

use std::collections::HashMap;

use styk_doc::{Obj, Value};

use crate::frame::objects_of;
use crate::history::{Command, CommandKind, Direction as HistoryDirection};
use crate::range_plan::{integer, native_finite, Direction, Joints, Kind, Operation, Part, Planned};
use crate::record::{num, uid};
use crate::{EditError, Editor};

fn invalid(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

const MAX_SHEET_TICKS: f64 = 10_000_000.0;

/// A keyframe index list as the app passes it: an array, which on a layer sheet carries the
/// timeline's chosen ticks (`sheetTicks`); across JSON `{"@array": [...], "sheetTicks": [...]}`.
#[derive(Clone, Debug, Default)]
pub(crate) struct Indices {
    pub list: Vec<Value>,
    pub sheet_ticks: Option<Vec<Value>>,
}

impl Indices {
    /// `None` for `undefined` and `null` (the caller's default applies).
    pub(crate) fn parse(value: Option<&Value>) -> Option<Indices> {
        let value = value.filter(|v| !v.is_null())?;
        let elements = |v: &Value| v.elements().map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default();
        Some(match value.get("@array") {
            Some(list) => Indices { list: elements(list), sheet_ticks: value.get("sheetTicks").filter(|t| !t.is_null()).map(elements) },
            None => Indices { list: elements(value), sheet_ticks: None },
        })
    }
}

/// The options of a range command (`{uids, atPlayhead, ticks, indices, label}`).
#[derive(Clone, Debug, Default)]
pub(crate) struct Options {
    uids: Option<Vec<u32>>,
    at_playhead: bool,
    ticks: Option<Vec<Value>>,
    indices: Option<Indices>,
    label: Option<String>,
}

impl Options {
    /// `{...options, indices}` from a command's options and its index argument.
    pub(crate) fn of(options: &Value, indices: Option<&Value>) -> Options {
        let list = |v: &Value| v.elements().map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default();
        Options {
            uids: options.get("uids").filter(|u| !u.is_null()).map(|u| list(u).iter().filter_map(Value::as_f64).map(|u| u as u32).collect()),
            at_playhead: options.get("atPlayhead").is_some_and(Value::truthy),
            ticks: options.get("ticks").filter(|t| !t.is_null()).map(list),
            indices: Indices::parse(indices),
            label: options.get("label").and_then(Value::as_str).map(str::to_string),
        }
    }
}

/// An operation as a range command asks for it, before validation.
#[derive(Clone, Debug)]
pub(crate) enum Request {
    Add { type_id: Value, x: Value, y: Value },
    Duplicate { offset: Value },
    Delete,
    Appearance(Value),
    Order(Value),
    Join { target: Value, handle: Value },
    Detach,
    Mirror(Value),
    Scale { value: Value, relative: bool },
    Rotate { radians: Value, center: Value },
    Center,
    Align { axis: String, edge: String, bounds: crate::bounds::Callback },
    Reset,
    /// Recolouring (its label comes with the options).
    Recolor(Box<crate::recolor::Recolor>),
    /// A pose property at one value (the label comes with the options; the entry says how many frames it changed).
    Pose(crate::pose_value::Pose),
}

impl Request {
    fn label(&self) -> &'static str {
        match self {
            Request::Add { .. } => "Add figures across frames",
            Request::Duplicate { .. } => "Duplicate figures across frames",
            Request::Delete => "Delete figures across frames",
            Request::Appearance(_) => "Set figure appearance across frames",
            Request::Order(_) => "Order figures across frames",
            Request::Join { .. } => "Join figures across frames",
            Request::Detach => "Detach figures across frames",
            Request::Mirror(_) => "Flip figures across frames",
            Request::Scale { .. } => "Scale figures across frames",
            Request::Rotate { .. } => "Rotate figures across frames",
            Request::Center => "Center figures across frames",
            Request::Align { .. } => "Align figures across frames",
            Request::Reset => "Reset poses across frames",
            Request::Recolor(_) => "Edit figure colors",
            Request::Pose(_) => "Edit pose",
        }
    }
}

/// A frame of the range: its keyframe index, tick and record.
struct Target {
    index: usize,
    tick: f64,
    frame: Value,
}

/// What an insertion adds (`insertionPlan`, or the identities a duplicate takes).
struct Payload {
    objects: Vec<Value>,
    order: Vec<u32>,
    hints: HashMap<u32, String>,
    next_uid: u64,
}

/// One frame's change in a `figure-range` history entry (`diffFrame`).
#[derive(Clone, Debug)]
pub struct FrameChange {
    index: usize,
    patches: Vec<(u32, Patch, Patch)>,
    slots: Option<(Vec<Value>, Vec<Value>)>,
    order: Option<(Vec<f64>, Vec<f64>)>,
    fields: Option<(Vec<Field>, Vec<Field>)>,
}

/// A figure before or after: absent, a whole record, or some of its fields.
#[derive(Clone, Debug)]
enum Patch {
    Missing,
    Object(Value),
    Fields(Vec<Field>),
}

/// A field before or after: its key and its value, `None` when the key is absent.
type Field = (String, Option<Value>);

impl FrameChange {
    /// The range diff owner's enumerable change, for worker history sizing.
    pub(crate) fn history_value(&self) -> Value {
        fn fields(values: &[Field]) -> Value {
            Value::array(values.iter().map(|(key, value)| {
                let mut field = Obj::new(); field.set("key", Value::str(key)); field.set("exists", Value::Bool(value.is_some()));
                if let Some(value) = value { field.set("value", value.clone()); }
                Value::object(field)
            }).collect())
        }
        fn side(patch: &Patch) -> Value {
            let mut value = Obj::new(); value.set("exists", Value::Bool(!matches!(patch, Patch::Missing)));
            match patch { Patch::Missing => {}, Patch::Object(object) => value.set("object", object.clone()), Patch::Fields(entries) => value.set("fields", fields(entries)) }
            Value::object(value)
        }
        let mut change = Obj::new(); change.set("index", Value::Num(self.index as f64));
        change.set("patches", Value::array(self.patches.iter().map(|(uid, before, after)| {
            let mut value = Obj::new(); value.set("uid", Value::Num(*uid as f64)); value.set("before", side(before)); value.set("after", side(after)); Value::object(value)
        }).collect()));
        if let Some((before, after)) = &self.slots { change.set("beforeSlots", Value::array(before.clone())); change.set("afterSlots", Value::array(after.clone())); }
        if let Some((before, after)) = &self.order { change.set("beforeOrder", Value::nums(before)); change.set("afterOrder", Value::nums(after)); }
        if let Some((before, after)) = &self.fields { change.set("beforeFields", fields(before)); change.set("afterFields", fields(after)); }
        Value::object(change)
    }
}

fn json(value: Option<&Value>) -> Option<String> {
    value.map(styk_doc::json::to_string)
}

/// `fieldChanges(before, after)`: the keys whose values differ or exist on one side only.
fn field_changes(before: &Obj, after: &Obj, skip: &[&str]) -> (Vec<Field>, Vec<Field>) {
    let mut keys: Vec<String> = before.keys().map(|k| k.to_string()).collect();
    for key in after.keys() {
        if !keys.iter().any(|k| **k == **key) {
            keys.push(key.to_string());
        }
    }
    let (mut left, mut right) = (Vec::new(), Vec::new());
    for key in keys.into_iter().filter(|k| !skip.contains(&k.as_str())) {
        let (a, b) = (before.get(&key), after.get(&key));
        if json(a) != json(b) || a.is_some() != b.is_some() {
            left.push((key.clone(), a.cloned()));
            right.push((key, b.cloned()));
        }
    }
    (left, right)
}

/// `applyFields(target, fields)`.
fn apply_fields(target: &mut Obj, fields: &[Field]) {
    for (key, value) in fields {
        match value {
            Some(value) => target.set(key, value.clone()),
            None => {
                target.remove(key);
            }
        }
    }
}

/// `diffFrame(index, before, after)`.
fn diff_frame(index: usize, before: &Value, after: &Value) -> FrameChange {
    let (old, next) = (objects_of(before), objects_of(after));
    let find = |list: &[Value], id: u32| list.iter().find(|o| uid(o) == Some(id)).cloned();
    let mut ids: Vec<u32> = old.iter().filter_map(uid).collect();
    for id in next.iter().filter_map(uid) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut patches = Vec::new();
    for id in ids {
        let (a, b) = (find(&old, id), find(&next, id));
        match (a, b) {
            (Some(a), Some(b)) if a.same_node(&b) => {}
            (Some(a), Some(b)) => {
                let (left, right) = field_changes(a.as_obj().unwrap(), b.as_obj().unwrap(), &[]);
                if !left.is_empty() {
                    patches.push((id, Patch::Fields(left), Patch::Fields(right)));
                }
            }
            (a, b) => patches.push((id, a.map_or(Patch::Missing, Patch::Object), b.map_or(Patch::Missing, Patch::Object))),
        }
    }
    let ids_of = |list: &[Value]| list.iter().map(|o| o.get("unique_id").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>();
    let (before_slots, after_slots) = (ids_of(&old), ids_of(&next));
    let order_of = |frame: &Value| crate::figures::frame_order(frame.as_obj().unwrap());
    let (before_order, after_order) = (order_of(before), order_of(after));
    let skip = ["objects", "object_draw_order", "object_draw_order_unique_ids"];
    let (left, right) = field_changes(before.as_obj().unwrap(), after.as_obj().unwrap(), &skip);
    FrameChange {
        index,
        patches,
        slots: (json(Some(&Value::array(before_slots.clone()))) != json(Some(&Value::array(after_slots.clone())))).then_some((before_slots, after_slots)),
        order: (before_order != after_order).then_some((before_order, after_order)),
        fields: (!left.is_empty()).then_some((left, right)),
    }
}

/// `{changedFrames: 0, changedTicks: [], insertedUids: []}` and its fuller forms.
fn outcome(ticks: &[f64], inserted: &[u32]) -> Value {
    let mut out = Obj::new();
    out.set("changedFrames", Value::Num(ticks.len() as f64));
    out.set("changedTicks", Value::array(ticks.iter().map(|&t| Value::Num(t)).collect()));
    out.set("insertedUids", Value::array(inserted.iter().map(|&u| Value::Num(u as f64)).collect()));
    Value::object(out)
}

/// `validateOperation(report, operation)` for the operations the planner runs.
fn validate(request: &Request, version: f64, canvas: [f64; 2], reference: Option<u32>, part: Option<Part>, numeric: bool, map: Option<Vec<(u32, u32)>>) -> Result<Operation, EditError> {
    let kind = match request {
        Request::Appearance(patch) => {
            let entries: Vec<(String, Value)> = patch.as_obj().map(|o| o.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()).unwrap_or_default();
            let owns = |key: &str| entries.iter().any(|(k, _)| k == key);
            let mut out: Vec<(String, f64)> = Vec::new();
            let mut opacity = None;
            for (key, value) in &entries {
                match key.as_str() {
                    "color_override_raw" => out.push((key.clone(), integer(value.as_f64(), if version < 5.0 { -2147483648.0 } else { 0.0 }, 4294967295.0, "figure color")?)),
                    "field28" => out.push((key.clone(), integer(value.as_f64(), 0.0, 255.0, "figure transparency")?)),
                    "opacity" => {
                        let value = native_finite(value.as_f64(), "Opacity")?;
                        if !(0.0..=1.0).contains(&value) || owns("field28") {
                            return Err(invalid("errors.rangeFigureOperations.opacityMustBeBetween0And1And"));
                        }
                        opacity = Some(value);
                    }
                    other => return Err(crate::invalid_with("errors.rangeFigureOperations.unsupportedAppearanceField", vec![("key", Value::str(other))])),
                }
            }
            if let Some(value) = opacity {
                out.push(("field28".into(), crate::range_plan::js_round((1.0 - value) * 255.0)));
            }
            Kind::Appearance(out)
        }
        Request::Order(direction) => {
            let direction = match (direction.as_str(), direction.as_f64()) {
                (Some("front"), _) => Direction::Front,
                (Some("back"), _) => Direction::Back,
                (_, Some(n)) if n.fract() == 0.0 && n.abs() <= 9007199254740991.0 => Direction::Steps(n),
                _ => return Err(invalid("errors.rangeFigureOperations.figureOrderNeedsFrontBackOrAWhole")),
            };
            Kind::Order { direction, numeric }
        }
        Request::Join { target, handle } => {
            let target = integer(target.as_f64(), 0.0, 4294967295.0, "join target identity")?;
            let handle = if handle.is_null() { 0.0 } else { integer(handle.as_f64(), 0.0, 65535.0, "join target handle")? };
            Kind::Join { target, handle }
        }
        Request::Scale { value, relative } => {
            let value = native_finite(value.as_f64(), "Scale")?;
            if value < 0.0 {
                return Err(invalid("errors.editor.scaleCannotBeNegative"));
            }
            // `referenceUid: this.selectedUid`, checked even when it is `null`.
            let reference = Value::Num(integer(reference.map(f64::from), 0.0, 4294967295.0, "scale reference identity")?);
            if *relative { Kind::Scale { factor: Some(value), value: None, reference: Some(reference) } } else { Kind::Scale { factor: None, value: Some(value), reference: Some(reference) } }
        }
        Request::Mirror(axis) => {
            let horizontal = match axis.as_str() {
                None if axis.is_null() => true,
                Some("horizontal") => true,
                Some("vertical") => false,
                _ => return Err(invalid("errors.editorBuilderTopology.chooseAHorizontalOrVerticalFlip")),
            };
            Kind::Mirror { horizontal, part }
        }
        Request::Duplicate { offset } => {
            let offset = if offset.is_null() { 24.0 } else { native_finite(offset.as_f64(), "Duplicate offset")? };
            Kind::Duplicate { map: map.unwrap_or_default(), offset }
        }
        Request::Rotate { radians, .. } => Kind::Rotate(native_finite(radians.as_f64(), "Rotation")?),
        Request::Center => {
            native_finite(Some(canvas[0]), "Canvas width")?;
            native_finite(Some(canvas[1]), "Canvas height")?;
            Kind::Center
        }
        Request::Align { axis, edge, bounds } => {
            if !["x", "y"].contains(&axis.as_str()) || !["start", "center", "end"].contains(&edge.as_str()) {
                return Err(invalid("errors.rangeFigureOperations.chooseAnAlignmentAxisAndEdge"));
            }
            crate::bounds::require_function(bounds)?;
            Kind::Align { axis: axis.clone(), edge: edge.clone(), bounds: bounds.clone() }
        }
        Request::Delete => Kind::Delete,
        Request::Detach => Kind::Detach,
        Request::Reset => Kind::Reset,
        Request::Recolor(recolor) => Kind::Recolor(recolor.clone()),
        Request::Pose(pose) => Kind::Pose(pose.clone()),
        Request::Add { .. } => unreachable!("an insertion is not planned"),
    };
    let center = match request {
        Request::Rotate { center, .. } if !center.is_null() => Some([native_finite(num(center, "x"), "Transform center X")?, native_finite(num(center, "y"), "Transform center Y")?]),
        _ => None,
    };
    Ok(Operation { kind, center })
}

/// The arguments of a range command: `(indices, options)` from where they stand.
fn range_args(args: &[Value], at: usize) -> Options {
    Options::of(args.get(at + 1).unwrap_or(&Value::Null), args.get(at))
}

impl Editor {
    /// The figure-range commands by their JavaScript names; `None` for other calls.
    pub(crate) fn range_call(&mut self, method: &str, args: &[Value]) -> Option<Result<Value, EditError>> {
        if let Some(result) = self.recolor_call(method, args) {
            return Some(result);
        }
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        let result = match method {
            "addFigureInFrames" => {
                let options = arg(2);
                self.apply_figure_range(Request::Add { type_id: arg(0), x: options.get("x").cloned().unwrap_or(Value::Null), y: options.get("y").cloned().unwrap_or(Value::Null) }, range_args(args, 1))
            }
            "pasteFiguresInFrames" => self.paste_figures_in_frames(range_args(args, 0), &arg(1)),
            "duplicateFiguresInFrames" | "duplicateInFrames" => self.apply_figure_range(Request::Duplicate { offset: arg(1).get("offset").cloned().unwrap_or(Value::Null) }, range_args(args, 0)),
            "deleteFiguresInFrames" => self.apply_figure_range(Request::Delete, range_args(args, 0)),
            "updateFiguresInFrames" => self.apply_figure_range(Request::Appearance(arg(0)), range_args(args, 1)),
            "orderFiguresInFrames" => self.apply_figure_range(Request::Order(arg(0)), range_args(args, 1)),
            "joinFiguresInFrames" => self.apply_figure_range(Request::Join { target: arg(0), handle: arg(1) }, range_args(args, 2)),
            "detachFiguresInFrames" => self.apply_figure_range(Request::Detach, range_args(args, 0)),
            "mirrorFiguresInFrames" => self.apply_figure_range(Request::Mirror(arg(0)), range_args(args, 1)),
            "scaleFiguresInFrames" => self.apply_figure_range(Request::Scale { value: arg(0), relative: arg(2).get("relative").is_some_and(Value::truthy) }, range_args(args, 1)),
            "rotateFiguresInFrames" => self.apply_figure_range(Request::Rotate { radians: arg(0), center: arg(2).get("center").cloned().unwrap_or(Value::Null) }, range_args(args, 1)),
            "centerFiguresInFrames" => self.apply_figure_range(Request::Center, range_args(args, 0)),
            "alignFiguresInFrames" => {
                // The editor's default callback is not ported.
                let callback = crate::bounds::Callback::of(self, method, &args[..3.min(args.len())], &arg(3))
                    .and_then(|callback| callback.ok_or_else(|| EditError::Unported("figure bounds without a callback".into())));
                callback.and_then(|callback| {
                    let request = Request::Align { axis: arg(0).as_str().unwrap_or("").to_string(), edge: arg(1).as_str().unwrap_or("").to_string(), bounds: callback.clone() };
                    let result = self.apply_figure_range(request, range_args(args, 2))?;
                    callback.finish()?;
                    Ok(result)
                })
            }
            "resetPoseInFrames" => self.apply_figure_range(Request::Reset, range_args(args, 0)),
            "setPoseProperty" => crate::pose_value::Pose::validated(arg(0).as_str().unwrap_or(""), &arg(1), self.selection.uid, self.selection.joint)
                .and_then(|pose| self.apply_figure_range(Request::Pose(pose), range_args(args, 2))),
            "bringToFront" => self.partition_layers(true),
            "sendToBack" => self.partition_layers(false),
            "moveSelectionLayer" => self.move_selection_layer(&arg(0)),
            "orderSelection" => self.order_selection(&arg(0), &arg(1)),
            "moveSelectionInFrames" => self.move_selection_in_frames(&arg(0), &arg(1), args.get(2), &arg(3)),
            "mirrorFigure" => self.mirror_figure(&arg(0)),
            // `mirrorSelection` on one figure's joint flips the branch; whole figures stay in transform.rs.
            "mirrorSelection" => match self.selection.joint >= 0 && axis_valid(&arg(0)) {
                true => match self.selected_objects() {
                    Ok(objects) if objects.len() == 1 || self.branch_selected() => self.apply_figure_range(Request::Mirror(arg(0)), Options { at_playhead: true, ..Options::default() }),
                    Ok(_) => return None,
                    Err(error) => Err(error),
                },
                false => return None,
            },
            _ => return None,
        };
        Some(result)
    }

    /// `pasteFiguresInFrames(indices, {offset, pasteMode, pasteDepth})`: what the figure clipboard holds, pasted into
    /// every chosen frame; one history entry and nothing if the clipboard is empty.
    fn paste_figures_in_frames(&mut self, options: Options, given: &Value) -> Result<Value, EditError> {
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        if self.property_edit.is_some() {
            self.commit_animation_edit()?;
        }
        let (authored, targets) = self.range_targets(&options)?;
        if targets.is_empty() {
            return Ok(outcome(&[], &[]));
        }
        let Some(clipboard) = self.figure_clipboard.clone() else { return Ok(outcome(&[], &[])) };
        if !authored {
            return Err(EditError::Unported("figures pasted across frames on a native timeline".into()));
        }
        let ticks: Vec<f64> = targets.iter().map(|t| t.tick).collect();
        let frames: Vec<(f64, Value)> = targets.into_iter().map(|t| (t.tick, t.frame)).collect();
        let mut paste = Obj::new();
        paste.set("pasteMode", given.get("pasteMode").filter(|m| !m.is_null()).cloned().unwrap_or_else(|| Value::str("default")));
        if let Some(depth) = given.get("pasteDepth") {
            paste.set("pasteDepth", depth.clone());
        }
        let offset = given.get("offset").filter(|o| !o.is_null()).cloned();
        let label = options.label.clone().unwrap_or_else(|| "Paste figures across frames".to_string());
        let inserted = self.paste_figures_across(&clipboard, &Value::object(paste), offset.as_ref(), 0.0, None, &label, Some(&frames))?;
        Ok(outcome(&ticks, &inserted))
    }

    /// `applyFigureRange(operation, options)`.
    pub(crate) fn apply_figure_range(&mut self, request: Request, options: Options) -> Result<Value, EditError> {
        self.apply_figure_range_with(request, options, false, None)
    }

    /// The recorded library movieclip insertion still uses the same range
    /// planner, native frame patches and authored publication owner.
    pub(crate) fn add_movieclip_range(&mut self, type_id: &Value, worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>) -> Result<Value, EditError> {
        self.apply_figure_range_with(
            Request::Add { type_id: type_id.clone(), x: Value::Null, y: Value::Null },
            Options { at_playhead: true, label: Some("Add figure".into()), ..Options::default() },
            true,
            worker,
        )
    }

    fn apply_figure_range_with(&mut self, request: Request, options: Options, movieclip_insertion: bool, worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>) -> Result<Value, EditError> {
        let label = options.label.clone().unwrap_or_else(|| request.label().to_string());
        let mut uids: Vec<u32> = Vec::new();
        for id in options.uids.clone().unwrap_or_else(|| self.selection.uids.clone()) {
            if !uids.contains(&id) {
                uids.push(id);
            }
        }
        // Duplicated figures keep their timeline effects in the same undo step.
        let effects = if matches!(request, Request::Duplicate { .. }) { self.figure_effect_clips(&uids) } else { Vec::new() };
        if !effects.is_empty() && self.batch.is_none() {
            return self.movieclip_batch(&label, |editor| editor.apply_figure_range_with(request, options, movieclip_insertion, worker));
        }
        let mut part = None;
        if matches!(request, Request::Mirror(_)) && self.selection.joint >= 0 && (self.selected_objects()?.len() == 1 || self.branch_selected()) {
            // The joints selected (several with Shift), and with a selected branch everything below them.
            let figure = self.object()?.and_then(|(_, object)| self.figure_of(&object));
            let handles = self.selected_segment_ids(figure.as_ref()).iter().map(|id| id.as_f64().unwrap_or(f64::NAN)).collect();
            part = Some(Part { uid: self.selection.uid, handles, branch: self.branch_selected() });
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        if matches!(request, Request::Align { .. }) && self.property_edit.is_some() {
            self.commit_animation_edit()?;
        }
        let (mut authored, mut targets) = self.range_targets(&options)?;
        if movieclip_insertion && !self.sheet() && self.report.path(&["_styk", "animation", "channels"]).and_then(Value::array_len).unwrap_or(0) > 0 {
            authored = true;
            for target in &mut targets { target.frame = self.shown_frame()?; }
        }
        if targets.is_empty() {
            return Ok(outcome(&[], &[]));
        }
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        let movieclip = |object: &Value| object.get("_stykMovieclip").is_some_and(|m| !m.is_null()) || figures.iter().any(|f| num(f, "figure_type_id") == num(object, "figure_type_id") && f.path(&["_styk", "movieclip"]).is_some_and(Value::truthy));
        let mut payload: Option<Payload> = None;
        let mut map = None;
        match &request {
            Request::Add { type_id, x, y } => payload = Some(self.add_payload(type_id, x, y, &figures, movieclip_insertion)?),
            Request::Duplicate { .. } => {
                let present: Vec<u32> = targets.iter().flat_map(|t| objects_of(&t.frame)).filter_map(|o| uid(&o)).filter(|u| uids.contains(u)).collect();
                let mut next = self.next_uid;
                let (mut renamed, mut hints) = (Vec::new(), HashMap::new());
                for &id in uids.iter().filter(|u| present.contains(u)) {
                    if next > 0x7fff_fffe {
                        return Err(invalid("errors.editorLayerSheet.objectIdentityCapacityReached"));
                    }
                    renamed.push((id, next as u32));
                    hints.insert(next as u32, self.layer_of(id));
                    next += 1;
                }
                if renamed.is_empty() {
                    return Ok(outcome(&[], &[]));
                }
                payload = Some(Payload { objects: Vec::new(), order: renamed.iter().map(|(_, to)| *to).collect(), hints, next_uid: next });
                map = Some(renamed);
            }
            _ => {}
        }
        if payload.is_none() && uids.is_empty() {
            return Ok(outcome(&[], &[]));
        }
        if !authored && ((payload.is_some() && !movieclip_insertion) || matches!(request, Request::Delete)) {
            return Err(EditError::Unported("figures added or removed across frames on a native timeline".into()));
        }
        let version = num(&self.report, "version").unwrap_or(f64::NAN);
        let canvas = [num(&self.report, "canvas_width").unwrap_or(f64::NAN), num(&self.report, "canvas_height").unwrap_or(f64::NAN)];
        let operation = match &request {
            Request::Add { .. } => None,
            _ => Some(validate(&request, version, canvas, self.selection.uid, part, matches!(request, Request::Order(_)) && authored, map.clone())?),
        };
        let mut plans: Vec<(Target, Planned)> = Vec::new();
        let origins = figures.iter().any(|figure| figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy));
        for target in targets {
            if origins { self.origin_range_gate(&objects_of(&target.frame), &uids, if let Request::Join { target, .. } = &request { target.as_f64().map(|id| id as u32) } else { None })?; }
            let planned = match (&operation, &payload) {
                (None, Some(payload)) => {
                    let frame = crate::figure_clipboard::insert(&target.frame, &payload.objects, &payload.order)?;
                    Some(Planned { frame, changed: payload.objects.iter().filter_map(uid).collect(), structural: true })
                }
                (Some(operation), _) => self.plan_frame(&target.frame, &uids, operation, &figures, canvas)?,
                (None, None) => None,
            };
            let Some(mut planned) = planned else { continue };
            // On a layer sheet movieclips are deleted through frame replacements and duplicated
            // onto the presence clock; on a native timeline they are not ported.
            let before = objects_of(&target.frame);
            let after = objects_of(&planned.frame);
            if !authored && !movieclip_insertion && before.iter().chain(&after).filter(|o| uid(o).is_some_and(|u| planned.changed.contains(&u))).any(movieclip) {
                return Err(EditError::Unported("figure-range operations on movieclips on a native timeline".into()));
            }
            if let Some(payload) = payload.as_ref().filter(|_| matches!(request, Request::Duplicate { .. })) {
                // Copies leave a broken-apart movieclip's part behind.
                let objects: Vec<Value> = after
                    .into_iter()
                    .map(|o| match uid(&o).filter(|u| payload.order.contains(u)) {
                        Some(_) if o.get("_stykMovieclipPart").is_some() || (self.sheet() && o.get("_stykMovieclip").is_some_and(Value::truthy)) => {
                            let mut record = o.as_obj().cloned().unwrap();
                            record.remove("_stykMovieclipPart");
                            // A duplicated movieclip plays on the presence clock from its start.
                            if let Some(previous) = record.get("_stykMovieclip").filter(|p| p.truthy()).cloned().filter(|_| self.sheet()) {
                                let mut playback = Obj::new();
                                playback.set("clock", Value::str("presence"));
                                playback.set("offset", Value::Num(0.0));
                                playback.set("speed", previous.get("speed").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Num(1.0)));
                                playback.set("mode", previous.get("mode").filter(|v| !v.is_null()).cloned().unwrap_or(Value::str("loop")));
                                record.set("_stykMovieclip", Value::object(playback));
                            }
                            Value::object(record)
                        }
                        _ => o,
                    })
                    .collect();
                let mut frame = planned.frame.as_obj().cloned().unwrap();
                frame.set("objects", Value::array(objects));
                planned.frame = Value::object(frame);
            }
            self.synchronize_origin_frame(&mut planned.frame, &before, true)?;
            plans.push((target, planned));
        }
        if plans.is_empty() {
            return Ok(outcome(&[], &[]));
        }
        let label = if matches!(request, Request::Pose(_)) {
            // The poses are ones the document may hold (`validateObjectChanges`); the entry says how many frames it changed.
            for (_, planned) in &plans {
                for object in objects_of(&planned.frame).iter().filter(|object| uid(object).is_some_and(|id| planned.changed.contains(&id))) {
                    if let Some(figure) = self.figure_of(object) {
                        crate::load::validate_object_pose(&self.report, object, &figure)?;
                    }
                }
            }
            format!("{label} in {} frames", plans.len())
        } else {
            label
        };
        let selection = self.selection_state();
        let ticks: Vec<f64> = plans.iter().map(|(t, _)| t.tick).collect();
        let inserted: Vec<u32> = payload.as_ref().map(|p| p.order.clone()).unwrap_or_default();
        if authored {
            if !self.sheet() {
                if movieclip_insertion {
                    self.commit_native_movieclip_range(&plans, payload.as_ref().unwrap(), &label, selection)?;
                    return Ok(outcome(&ticks, &inserted));
                }
                return Err(EditError::Unported("figure-range operations on property channels of a native timeline".into()));
            }
            let befores: Vec<Value> = plans.iter().map(|(t, _)| t.frame.clone()).collect();
            let entries: Vec<(f64, Value, Vec<u32>)> = plans.into_iter().map(|(t, p)| (t.tick, p.frame, p.changed)).collect();
            let deletion = matches!(request, Request::Delete).then_some((uids.as_slice(), befores.as_slice()));
            let (previous_selection, previous_next) = (self.selection.clone(), self.next_uid);
            let hints = payload.as_ref().map(|p| p.hints.clone()).unwrap_or_default();
            if let Some(payload) = &payload {
                // `publish(…, {selectUids, nextUid})`: published, the new figures are selected.
                self.select_ids(payload.order.clone());
                self.next_uid = payload.next_uid;
            }
            // Movieclips alone inserted inside a layer's span are replacements of their own.
            let insertion = payload.as_ref().filter(|payload| movieclip_insertion || (!payload.objects.is_empty() && payload.objects.iter().all(|o| o.get("_stykMovieclip").is_some_and(Value::truthy)))).map(|payload| (payload.objects.as_slice(), false));
            if let Err(error) = self.commit_sheet_range_worker(&entries, &inserted, &hints, Vec::new(), &label, selection, insertion, deletion, worker) {
                self.selection = previous_selection;
                self.next_uid = previous_next;
                return Err(error);
            }
        } else {
            if movieclip_insertion { self.ensure_counts(); }
            let changes: Vec<FrameChange> = plans.iter().map(|(t, p)| diff_frame(t.index, &t.frame, &p.frame)).collect();
            let structural = plans.iter().any(|(_, p)| p.structural);
            let mut changed: Vec<u32> = Vec::new();
            for id in plans.iter().flat_map(|(_, p)| p.changed.iter().copied()) {
                if !changed.contains(&id) {
                    changed.push(id);
                }
            }
            let indices: Vec<usize> = plans.iter().map(|(t, _)| t.index).collect();
            let befores: Vec<Value> = plans.iter().filter(|_| movieclip_insertion).map(|(target, _)| target.frame.clone()).collect();
            let afters: Vec<Value> = plans.iter().filter(|_| movieclip_insertion).map(|(_, planned)| planned.frame.clone()).collect();
            for (target, planned) in plans {
                if let Some(slot) = self.report.make_obj().and_then(|r| r.get_mut("keyframes")).and_then(Value::make_arr).and_then(|k| k.get_mut(target.index)) {
                    *slot = planned.frame;
                }
            }
            if let Some(payload) = &payload {
                self.next_uid = payload.next_uid;
                self.new_layer_hints = payload.hints.clone();
                self.select_ids(payload.order.clone());
            }
            self.retained = None;
            let layers = movieclip_insertion && self.track_frames(&befores, &afters, true)?;
            let after_selection = self.selection_state();
            self.record(Command { kind: CommandKind::FigureRange { changes, structural, retain_geometry: movieclip_insertion }, label: label.clone(), before_selection: selection, after_selection, before_revision: 0, after_revision: 0, layer_changes: Vec::new(), captured_source_bytes: 0, layers })?;
            self.emit(
                "edit",
                vec![
                    ("label", Value::str(&label)),
                    ("structural", Value::Bool(structural)),
                    ("changedUids", Value::array(changed.iter().map(|&u| Value::Num(u as f64)).collect())),
                    ("frameIndices", Value::array(indices.iter().map(|&i| Value::Num(i as f64)).collect())),
                ],
            );
        }
        if !effects.is_empty() {
            self.paste_figure_vfx_clips(&effects, &map.unwrap_or_default(), &[], 0.0)?;
        }
        Ok(outcome(&ticks, &inserted))
    }

    /// The recorded pose-only native insertion subset of
    /// `_commitAuthoredFigureRange`/`authoredDraft`. Publication and capture use
    /// their existing owners; native keys remain unchanged.
    fn commit_native_movieclip_range(&mut self, plans: &[(Target, Planned)], payload: &Payload, label: &str, selection: crate::select::SelectionState) -> Result<(), EditError> {
        self.ensure_counts();
        let before = self.report.path(&["_styk", "animation"]).cloned();
        let mut after = before.as_ref().and_then(Value::as_obj).cloned().unwrap_or_default();
        after.set("version", Value::Num(1.0));
        let mut next_key = num(&Value::object(after.clone()), "nextKeyId").unwrap_or(1.0);
        let mut channels = crate::sheet::items(after.get("channels"));
        let mut entries = Vec::new();
        for (target, plan) in plans {
            let mut layers = Vec::new();
            for id in &plan.changed {
                let layer = self.owner_with(*id, &payload.hints)?;
                if !layers.contains(&layer) { layers.push(layer); }
            }
            for layer in layers {
                let mut channel = self.native_layer_pose(&layer)?.as_obj().cloned().unwrap();
                channel.set("source", Value::str("authored"));
                let mut keys = crate::sheet::items(channel.get("keys"));
                let value = { let mut value = Obj::new(); value.set("frameId", Value::str(&format!("frame-{}", self.next_frame_identity + entries.len() as u64))); Value::object(value) };
                if let Some(key) = keys.iter_mut().find(|key| num(key, "tick") == Some(target.tick) && !key.get("hidden").is_some_and(Value::truthy)) {
                    let key = key.make_obj().unwrap(); key.set("value", value); key.remove("passthrough");
                } else {
                    let mut key = Obj::new();
                    let id = loop {
                        if !next_key.is_finite() || next_key.fract() != 0.0 || !(1.0..=9_007_199_254_740_991.0).contains(&next_key) {
                            return Err(invalid("errors.animationChannels.invalidAnimationKeyIdentityCounter"));
                        }
                        let id = format!("key-{}", next_key as u64);
                        next_key += 1.0;
                        if !keys.iter().any(|key| key.get("id").and_then(Value::as_str) == Some(id.as_str())) { break id; }
                    };
                    key.set("id", Value::str(&id)); key.set("tick", Value::Num(target.tick)); key.set("value", value);
                    let previous = keys.iter().filter(|key| !key.get("hidden").is_some_and(Value::truthy) && num(key, "tick").is_some_and(|tick| tick < target.tick)).max_by(|a,b| num(a, "tick").unwrap().total_cmp(&num(b, "tick").unwrap()));
                    let mut easing = previous.cloned().unwrap_or_else(crate::sheet::constant).as_obj().cloned().unwrap();
                    if previous.is_some() && easing.get("interpolation").is_none() { easing.set("interpolation", Value::str(if self.report.get("auto_easing").is_some_and(Value::truthy) { "auto" } else { "linear" })); }
                    for (name, value) in crate::sheet::key_easing(&Value::object(easing)) { key.set(name, value); }
                    keys.push(Value::object(key));
                }
                keys.sort_by(|a,b| num(a,"tick").unwrap().total_cmp(&num(b,"tick").unwrap()).then_with(|| b.get("hidden").is_some_and(Value::truthy).cmp(&a.get("hidden").is_some_and(Value::truthy))));
                channel.set("keys", Value::array(keys));
                let channel = Value::object(channel);
                match channels.iter().position(|old| old.get("id") == channel.get("id")) { Some(index) => channels[index] = channel, None => channels.push(channel) }
            }
            entries.push(plan.frame.clone());
        }
        // The editor validates the completed authored draft before it registers
        // sources/counters or changes selection. MAX allocation consumes the
        // last safe counter and must fail here even without a collision.
        if !next_key.is_finite() || next_key.fract() != 0.0 || !(1.0..=9_007_199_254_740_991.0).contains(&next_key) {
            return Err(invalid("errors.animationChannels.invalidAnimationKeyIdentityCounter"));
        }
        // validateAnimationDocument checks the counter header before the
        // authored key ticks. Keep that priority without publishing either.
        if plans.iter().any(|(target, _)| target.tick.fract() != 0.0 || !target.tick.is_finite() || target.tick < 0.0) {
            return Err(invalid("errors.animationChannels.animationKeysMustBeSortedAtValidWhole"));
        }
        after.set("nextKeyId", Value::Num(next_key));
        after.set("channels", Value::array(channels));
        self.next_uid = payload.next_uid;
        self.new_layer_hints = payload.hints.clone();
        for frame in &entries { self.capture_native_pose(frame, None)?; }
        self.select_ids(payload.order.clone());
        let changed = plans.iter().flat_map(|(_, plan)| plan.changed.iter().copied()).collect::<Vec<_>>();
        self.publish_native_animation(before, Value::object(after), label, selection, Some(&changed))
    }

    /// `targets(editor, options)`: whether the range is authored (a layer sheet), and its frames.
    fn range_targets(&self, options: &Options) -> Result<(bool, Vec<Target>), EditError> {
        if options.at_playhead {
            let frame = if self.sheet() { self.shown_frame()? } else { self.report.get("keyframes").and_then(|k| k.item(self.frame_index)).unwrap_or(Value::Null) };
            return Ok((self.sheet(), vec![Target { index: self.frame_index, tick: self.tick, frame }]));
        }
        let sheet_ticks = options.indices.as_ref().and_then(|i| i.sheet_ticks.clone()).filter(|_| self.sheet());
        if let Some(ticks) = sheet_ticks.or_else(|| options.ticks.clone()) {
            let mut unique: Vec<f64> = Vec::new();
            for tick in &ticks {
                let Some(tick) = tick.as_f64().filter(|t| t.fract() == 0.0 && *t >= 0.0 && *t <= MAX_SHEET_TICKS) else {
                    return Err(invalid("errors.editorRangeCommands.selectWholeAnimationTicksFrom0To10"));
                };
                if !unique.contains(&tick) {
                    unique.push(tick);
                }
            }
            unique.sort_by(f64::total_cmp);
            let mut frames = Vec::new();
            for tick in unique {
                frames.push(self.sample(tick)?);
            }
            return Ok((true, frames));
        }
        let indices = self.frame_indices(options.indices.as_ref())?;
        let rows = crate::timeline::rows(&self.report);
        if self.sheet() || self.options.property_channels {
            let mut ticks: Vec<f64> = Vec::new();
            for index in indices {
                let tick = rows.get(index).map(|r| r.start).ok_or_else(|| EditError::Unported("a keyframe past the layer sheet's end".into()))?;
                if !ticks.contains(&tick) {
                    ticks.push(tick);
                }
            }
            let mut frames = Vec::new();
            for tick in ticks {
                frames.push(self.sample(tick)?);
            }
            return Ok((true, frames));
        }
        let frames = indices
            .into_iter()
            .map(|index| Target { index, tick: rows.get(index).map_or(0.0, |r| r.start), frame: self.report.get("keyframes").and_then(|k| k.item(index)).unwrap_or(Value::Null) })
            .collect();
        Ok((false, frames))
    }

    /// `sample(editor, tick)`: the evaluated frame at `tick` and the row it falls in.
    fn sample(&self, tick: f64) -> Result<Target, EditError> {
        let rows = crate::timeline::rows(&self.report);
        let index = rows.partition_point(|r| r.start <= tick).saturating_sub(1);
        Ok(Target { index, tick, frame: self.evaluated(tick, true)? })
    }

    /// `_frameIndices(indices)`: existing keyframe indices, sorted, once each.
    pub(crate) fn frame_indices(&self, indices: Option<&Indices>) -> Result<Vec<usize>, EditError> {
        let count = self.report.get("keyframes").and_then(Value::array_len).unwrap_or(0) as f64;
        let list = indices.map_or_else(|| vec![Value::Num(self.frame_index as f64)], |i| i.list.clone());
        let mut out: Vec<f64> = Vec::new();
        for index in &list {
            let Some(index) = index.as_f64().filter(|i| i.fract() == 0.0 && *i >= 0.0 && *i < count) else { return Err(invalid("errors.editor.selectExistingKeyframes")) };
            if !out.contains(&index) {
                out.push(index);
            }
        }
        out.sort_by(f64::total_cmp);
        Ok(out.into_iter().map(|i| i as usize).collect())
    }

    /// `sheetEditTimes(indices)`: the ticks a range edit keys, the app's chosen ticks first.
    pub(crate) fn sheet_edit_times(&self, indices: Option<&Indices>) -> Result<Vec<f64>, EditError> {
        let times: Vec<f64> = match indices.and_then(|i| i.sheet_ticks.as_ref()) {
            Some(ticks) => ticks.iter().map(|t| t.as_f64().unwrap_or(f64::NAN)).collect(),
            None => {
                let given = indices.map_or(1, |i| i.list.len());
                let rows = crate::timeline::rows(&self.report);
                let mut times = Vec::new();
                for index in self.frame_indices(indices)? {
                    times.push(if given == 1 && index == self.frame_index {
                        self.tick
                    } else {
                        rows.get(index).map(|row| row.start).ok_or_else(|| EditError::Unported("a keyframe past the layer sheet's end".into()))?
                    });
                }
                times
            }
        };
        let mut unique: Vec<f64> = Vec::new();
        for time in times {
            if !(time.fract() == 0.0 && (0.0..MAX_SHEET_TICKS).contains(&time)) {
                return Err(invalid("errors.editorLayerSheet.chooseAValidWholeFrame"));
            }
            if !unique.contains(&time) {
                unique.push(time);
            }
        }
        unique.sort_by(f64::total_cmp);
        Ok(unique)
    }

    pub(crate) fn figure_of(&self, object: &Value) -> Option<Value> {
        let id = num(object, "figure_type_id")?;
        self.report.get("figure_types").and_then(Value::elements).and_then(|e| e.iter().find(|f| num(f, "figure_type_id") == Some(id)))
    }

    /// `figureVfxClips(report, uids)`: the effect clips that target one of the figures.
    fn figure_effect_clips(&self, uids: &[u32]) -> Vec<Value> {
        let clips = self.report.path(&["_styk", "vfxClips", "clips"]).and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>()).unwrap_or_default();
        clips.into_iter().filter(|c| c.path(&["target", "kind"]).and_then(Value::as_str) != Some("scene") && c.path(&["target", "uid"]).and_then(Value::as_f64).is_some_and(|u| uids.contains(&(u as u32)))).collect()
    }

    /// `insertionPlan(editor, {kind: 'add', typeId, x, y})`: a new figure of a library definition.
    fn add_payload(&self, type_id: &Value, x: &Value, y: &Value, figures: &[Value], movieclip_insertion: bool) -> Result<Payload, EditError> {
        let wanted = if type_id.is_null() { figures.first().and_then(|f| f.get("figure_type_id").cloned()).unwrap_or(Value::Null) } else { type_id.clone() };
        let Some(figure) = figures.iter().find(|f| !wanted.is_null() && f.get("figure_type_id") == Some(&wanted)) else {
            return Err(invalid("errors.editorRangeCommands.chooseAnExistingFigureDefinition"));
        };
        if self.next_uid > 0x7fff_fffe {
            return Err(invalid("errors.editorLayerSheet.objectIdentityCapacityReached"));
        }
        let identity = self.next_uid as u32;
        let coordinate = |value: &Value, key: &str| if value.is_null() { num(&self.report, key).unwrap_or(f64::NAN) / 2.0 } else { value.as_f64().unwrap_or(f64::NAN) };
        let (x, y) = (coordinate(x, "canvas_width"), coordinate(y, "canvas_height"));
        if !x.is_finite() || !y.is_finite() {
            return Err(invalid("errors.editorRangeCommands.figurePositionMustBeFinite"));
        }
        let movieclip = figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy);
        if movieclip && !movieclip_insertion && !self.sheet() {
            return Err(EditError::Unported("adding a movieclip on a native timeline".into()));
        }
        let mut object = crate::figures::with_origin_pivot(figure, crate::figures::create_object(figure, identity, x, y));
        if movieclip {
            let mut playback = Obj::new();
            if self.sheet() {
                playback.set("clock", Value::str("presence"));
            } else {
                playback.set("start", Value::Num(self.tick));
                playback.set("end", Value::Null);
            }
            playback.set("offset", Value::Num(0.0));
            playback.set("speed", Value::Num(1.0));
            playback.set("mode", Value::str("loop"));
            object.make_obj().unwrap().set("_stykMovieclip", Value::object(playback));
        }
        Ok(Payload { objects: vec![object], order: vec![identity], hints: HashMap::new(), next_uid: self.next_uid + 1 })
    }

    /// `planFigureFrameOperation(report, frame, uids, operation)` with the editor's geometry.
    fn plan_frame(&self, frame: &Value, uids: &[u32], operation: &Operation, figures: &[Value], canvas: [f64; 2]) -> Result<Option<Planned>, EditError> {
        let layer_of = |id: u32| self.layer_of(id);
        let geometry = |record: &Value, slots: &[usize]| self.joints_of(record, slots);
        let version = num(&self.report, "version").unwrap_or(f64::NAN);
        let mirror_origin = |figure: &Value, source: &Value, record: &mut Obj, horizontal| self.mirror_origin_support(figure, source, record, horizontal);
        let bounds = |record: &Value, slots: &[usize]| self.app_bounds(record, slots);
        let context = crate::range_plan::Context { figures, version, canvas, layer_of: &layer_of, geometry: &geometry, bounds: &bounds, mirror_origin: &mirror_origin };
        crate::range_plan::plan(&context, frame, uids, operation)
    }

    /// The joints of the figures at `slots` of a frame record (`buildGeometry` on the part of
    /// the frame they hang from).
    pub(crate) fn joints_of(&self, record: &Value, slots: &[usize]) -> Result<HashMap<usize, Joints>, EditError> {
        let prepared = self.prepared()?;
        let frame = self.eval.borrow_mut().loader.edit_frame(record, None, &prepared.doc).map_err(|error| EditError::Invalid(error.to_string()))?;
        let scene = styk_eval::geometry::build_only(&prepared.doc, &frame, slots);
        let unresolved = || invalid("errors.rangeFigureOperations.cannotTransformAFrameWithUnresolvedFigureGeometry");
        if !scene.warnings.is_empty() {
            return Err(unresolved());
        }
        let objects = objects_of(record);
        let mut out = HashMap::new();
        for &slot in slots {
            let (Some(geometry), Some(object)) = (scene.objects.get(slot).filter(|g| g.resolved), objects.get(slot)) else { return Err(unresolved()) };
            let type_id = num(object, "figure_type_id").unwrap_or(f64::NAN) as u32;
            let figure = prepared.doc.figure(type_id).ok_or_else(unresolved)?;
            let mut points = vec![(0.0, geometry.root)];
            let segments = self.figure_of(object).and_then(|f| f.get("segments").and_then(Value::elements).map(|e| e.iter().collect::<Vec<_>>())).unwrap_or_default();
            for segment in segments {
                let Some(handle) = num(&segment, "segment_id") else { continue };
                if let Some(point) = geometry.joint(figure, handle as u32) {
                    points.push((handle, point));
                }
            }
            out.insert(slot, Joints { points });
        }
        Ok(out)
    }

    /// `partitionLayers(editor, front)`: `bringToFront` and `sendToBack`.
    fn partition_layers(&mut self, front: bool) -> Result<Value, EditError> {
        if !self.ordered_by_depth()? {
            return Err(EditError::Unported("reordering figures without property channels".into()));
        }
        self.apply_figure_range(Request::Order(Value::str(if front { "front" } else { "back" })), Options { ticks: Some(vec![Value::Num(self.tick)]), ..Options::default() })
    }

    /// Whether figure order goes through the range operation (`propertyChannels`, channels, or
    /// depths on show): always in the app.
    fn ordered_by_depth(&self) -> Result<bool, EditError> {
        Ok(self.options.property_channels || self.selection_frame()?.iter().any(|o| o.get("_stykZIndex").is_some()))
    }

    /// `moveSelectionLayer(direction)`: a step up or down within the figures' layers.
    fn move_selection_layer(&mut self, direction: &Value) -> Result<Value, EditError> {
        if self.selected_objects()?.is_empty() {
            return Ok(Value::Bool(false));
        }
        if !direction.as_f64().is_some_and(|d| d.fract() == 0.0) {
            return Err(invalid("errors.editor.layerDirectionMustBeAWholeNumber"));
        }
        if !self.ordered_by_depth()? {
            return Err(EditError::Unported("reordering figures without property channels".into()));
        }
        self.apply_figure_range(Request::Order(direction.clone()), Options { ticks: Some(vec![Value::Num(self.tick)]), ..Options::default() })
    }

    /// `orderSelection(direction, {frameIndices})`: whole figures among the others; part of one
    /// figure reorders its segments (a builder command, not ported).
    fn order_selection(&mut self, direction: &Value, options: &Value) -> Result<Value, EditError> {
        let valid = matches!(direction.as_str(), Some("front" | "back")) || matches!(direction.as_f64(), Some(d) if d == 1.0 || d == -1.0);
        if !valid {
            return Err(invalid("errors.editorBuilderStyle.chooseAValidDrawOrderDirection"));
        }
        let objects = self.selected_objects()?;
        if objects.is_empty() {
            return Ok(Value::Bool(false));
        }
        if objects.len() == 1 && self.selection.joint >= 0 {
            let figure = self.object()?.and_then(|(_, o)| self.figure_of(&o));
            let count = |key: &str| figure.as_ref().and_then(|f| f.get(key)).and_then(Value::array_len).unwrap_or(0);
            let branch = self.branch_selected();
            // The drawables the order edit moves (`builderStyleTargets`) are part of the figure's own order.
            let moved = match (&figure, branch) {
                (Some(figure), true) => crate::builder::style_target_count(figure, self.selection.joint as usize, true)?,
                _ => 1,
            };
            if (self.selection.joint as usize) < count("segments") && moved < count("segments") + count("polyfills") {
                // A segment of one figure moves in the figure's own drawing order (`moveBuilderOrder`).
                let mut target = styk_doc::Obj::new();
                target.set("kind", Value::str("segment"));
                target.set("index", Value::Num(self.selection.joint as f64));
                let step = match direction.as_f64() {
                    Some(1.0) => Value::str("up"),
                    Some(_) => Value::str("down"),
                    None => direction.clone(),
                };
                let mut options = styk_doc::Obj::new();
                options.set("branch", Value::Bool(branch));
                return self.move_builder_order(&Value::object(target), &step, Some(&Value::object(options)));
            }
        }
        let frame_indices = Indices::parse(options.get("frameIndices"));
        if self.sheet() {
            let ticks = match &frame_indices {
                Some(indices) => self.sheet_edit_times(Some(indices))?,
                None => vec![self.tick],
            };
            return self.apply_figure_range(Request::Order(direction.clone()), Options { ticks: Some(ticks.into_iter().map(Value::Num).collect()), ..Options::default() });
        }
        if let Some(indices) = frame_indices {
            return self.apply_figure_range(Request::Order(direction.clone()), Options { indices: Some(indices), ..Options::default() });
        }
        match direction.as_str() {
            Some(front) => self.partition_layers(front == "front"),
            None => self.move_selection_layer(direction),
        }
    }

    /// `mirrorFigure(axis)`: the selected figure and those joined below it turned over; a
    /// joint flips its branch, several figures flip as a group.
    fn mirror_figure(&mut self, axis: &Value) -> Result<Value, EditError> {
        let Some(horizontal) = axis_horizontal(axis) else { return Err(invalid("errors.editorBuilderTopology.chooseAHorizontalOrVerticalFlip")) };
        let selected = self.selected_objects()?.len();
        if self.selection.joint >= 0 && (selected == 1 || self.branch_selected()) {
            return self.apply_figure_range(Request::Mirror(axis.clone()), Options { at_playhead: true, ..Options::default() });
        }
        if selected > 1 {
            return self.mirror_selection(axis, &Value::Null).map(Value::Bool);
        }
        let figures: Vec<Value> = self.report.get("figure_types").and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default();
        self.object_edit("Flip figure", |editor| {
            let ids: Vec<u32> = editor.drag.as_ref().unwrap().before.iter().filter_map(uid).collect();
            for (slot, object) in editor.frame_objects().iter().enumerate() {
                if !uid(object).is_some_and(|u| ids.contains(&u)) {
                    continue;
                }
                let figure = figures.iter().find(|f| num(f, "figure_type_id") == num(object, "figure_type_id"));
                let previous = figure.map(|figure| editor.origin_rotation(figure, object)).transpose()?.unwrap_or(0.0);
                let mut record = object.as_obj().cloned().unwrap_or_default();
                let angles: Vec<Value> = numbers(record.get("angles")).into_iter().map(|a| Value::Num(if horizontal { std::f64::consts::PI - a } else { -a })).collect();
                record.set("angles", Value::array(angles));
                let bends: Vec<f64> = if record.get("bend_flag").is_some_and(Value::truthy) {
                    numbers(record.get("bends")).into_iter().map(|b| -b).collect()
                } else {
                    figure.and_then(|f| f.get("segments")).and_then(Value::elements).map(|e| e.iter().map(|s| -num(&s, "bend_rad").unwrap_or(0.0)).collect()).unwrap_or_default()
                };
                record.set("bends", Value::array(bends.into_iter().map(Value::Num).collect()));
                record.set("bend_flag", Value::Num(1.0));
                let flipped = !record.get("image_text_flags").is_some_and(Value::truthy);
                record.set("image_text_flags", Value::Num(if flipped { 1.0 } else { 0.0 }));
                if let Some(figure) = figure {
                    crate::origin::mirror_support(figure, &mut record, horizontal);
                    editor.reflect_origin_offset(figure, &mut record, horizontal, previous)?;
                }
                record.remove("runtime_segments");
                editor.replace_frame_object(slot, record).unwrap();
            }
            Ok(())
        })
        .map(Value::Bool)
    }

    /// `moveSelectionInFrames(dx, dy, indices, {movePins})`: on a layer sheet the selection's
    /// whole connected figures move at every tick of the range (`sheetMoveSelection`).
    fn move_selection_in_frames(&mut self, dx: &Value, dy: &Value, indices: Option<&Value>, options: &Value) -> Result<Value, EditError> {
        let finite = |v: &Value, label: &str| v.as_f64().filter(|n| n.is_finite()).ok_or_else(|| crate::transform::not_finite(label));
        let (dx, dy) = (finite(dx, "Translation X")?, finite(dy, "Translation Y")?);
        if !self.sheet() {
            return Err(EditError::Unported("moving figures across keyframes of a native timeline".into()));
        }
        let move_pins = options.get("movePins").is_some_and(Value::truthy);
        let indices = match indices {
            None => Indices { list: vec![Value::Num(self.frame_index as f64)], sheet_ticks: None },
            Some(value) => Indices::parse(Some(value)).ok_or_else(|| EditError::Unported("frame indices that are not a list".into()))?,
        };
        let rows = crate::timeline::rows(&self.report);
        let ticks: Vec<f64> = match &indices.sheet_ticks {
            Some(ticks) => ticks.iter().map(|t| t.as_f64().unwrap_or(f64::NAN)).collect(),
            None => {
                let mut ticks = Vec::new();
                for index in &indices.list {
                    ticks.push(if indices.list.len() == 1 {
                        self.tick
                    } else {
                        index.as_f64().filter(|i| i.fract() == 0.0 && *i >= 0.0).and_then(|i| rows.get(i as usize)).map(|r| r.start).ok_or_else(|| EditError::Unported("a keyframe past the layer sheet's end".into()))?
                    });
                }
                ticks
            }
        };
        let mut entries: Vec<(f64, Value, Vec<u32>)> = Vec::new();
        for tick in ticks {
            let before = self.evaluated(tick, false)?;
            let objects = objects_of(&before);
            if self.unported_document().is_some_and(|reason| reason.starts_with("with animation origins")) {
                self.origin_range_gate(&objects, &self.selection.uids, None)?;
            }
            let affected = crate::select::resolve_join_selection(&objects, &self.selection.uids, true)?;
            let roots = translation_roots(&objects, &self.selection.uids);
            let mut changed = Vec::new();
            let mut moved_objects = Vec::with_capacity(objects.len());
            for (slot, object) in objects.iter().enumerate() {
                let mut record = object.as_obj().cloned().unwrap_or_default();
                let mut moved = false;
                if roots.contains(&slot) {
                    record.set("root_x", Value::Num(num(object, "root_x").unwrap_or(f64::NAN) + dx));
                    record.set("root_y", Value::Num(num(object, "root_y").unwrap_or(f64::NAN) + dy));
                    moved = true;
                }
                if move_pins && affected.contains(&slot) {
                    moved = crate::ik::translate_targets(&mut record, dx, dy, object, true) || moved;
                }
                if moved {
                    record.remove("runtime_segments");
                    changed.extend(uid(object));
                    moved_objects.push(Value::object(record));
                } else {
                    moved_objects.push(object.clone());
                }
            }
            if !changed.is_empty() {
                let mut frame = before.as_obj().cloned().unwrap_or_default();
                frame.set("objects", Value::array(moved_objects));
                let mut frame = Value::object(frame);
                self.synchronize_origin_frame(&mut frame, &objects, false)?;
                entries.push((tick, frame, changed));
            }
        }
        if entries.is_empty() {
            return Ok(Value::Num(0.0));
        }
        let selection = self.selection_state();
        let count = entries.len();
        self.commit_sheet_range(&entries, &[], &HashMap::new(), Vec::new(), "Move figures across frames", selection, None, None)?;
        Ok(Value::Num(count as f64))
    }

    /// `_applyFigureRangeCommand(command, direction)`: the keyframes' figures, slots, order and
    /// fields as they were before or after.
    pub(crate) fn apply_figure_range_command(&mut self, command: &Command, direction: HistoryDirection) -> Result<(), EditError> {
        let CommandKind::FigureRange { changes, structural, .. } = &command.kind else { return Ok(()) };
        let after = direction == HistoryDirection::After;
        if command.layers { self.ensure_counts(); }
        let previous: Vec<Value> = changes.iter().filter(|_| command.layers).filter_map(|change| self.report.get("keyframes").and_then(|frames| frames.item(change.index))).collect();
        for change in changes {
            let Some(frame) = crate::record::frame_mut(&mut self.report, change.index) else { continue };
            let mut objects: Vec<(u32, Value)> = frame.get("objects").and_then(Value::elements).map(|e| e.iter().filter_map(|o| Some((uid(&o)?, o))).collect()).unwrap_or_default();
            for (id, before_state, after_state) in &change.patches {
                let state = if after { after_state } else { before_state };
                let at = objects.iter().position(|(u, _)| u == id);
                match state {
                    Patch::Missing => {
                        if let Some(at) = at {
                            objects.remove(at);
                        }
                    }
                    Patch::Object(object) => match at {
                        Some(at) => objects[at].1 = object.clone(),
                        None => objects.push((*id, object.clone())),
                    },
                    Patch::Fields(fields) => {
                        let mut record = at.and_then(|at| objects[at].1.as_obj().cloned()).unwrap_or_default();
                        apply_fields(&mut record, fields);
                        match at {
                            Some(at) => objects[at].1 = Value::object(record),
                            None => objects.push((*id, Value::object(record))),
                        }
                    }
                }
            }
            let find = |id: &Value| id.as_f64().and_then(|id| objects.iter().find(|(u, _)| f64::from(*u) == id)).map(|(_, o)| o.clone()).unwrap_or(Value::Null);
            let list: Vec<Value> = match &change.slots {
                Some((before, after_slots)) => (if after { after_slots } else { before }).iter().map(find).collect(),
                None => frame.get("objects").and_then(Value::elements).map(|e| e.iter().map(|o| find(o.get("unique_id").unwrap_or(&Value::Null))).collect()).unwrap_or_default(),
            };
            frame.set("objects", Value::array(list));
            if let Some((before, after_order)) = &change.order {
                crate::figures::set_order(frame, if after { after_order } else { before });
            }
            if let Some((before, after_fields)) = &change.fields {
                apply_fields(frame, if after { after_fields } else { before });
            }
        }
        let current: Vec<Value> = changes.iter().filter(|_| command.layers).filter_map(|change| self.report.get("keyframes").and_then(|frames| frames.item(change.index))).collect();
        if command.layers { self.track_frames(&previous, &current, false)?; }
        self.apply_attached_layer_changes(&command.layer_changes, direction);
        let (selection, revision) = if after { (&command.after_selection, command.after_revision) } else { (&command.before_selection, command.before_revision) };
        self.restore_selection(selection)?;
        self.revision = revision;
        self.emit(
            "history",
            vec![("label", Value::str(&command.label)), ("structural", Value::Bool(*structural)), ("timing", Value::Bool(false)), ("definition", Value::Bool(false)), ("animation", Value::Bool(false))],
        );
        Ok(())
    }
}

fn axis_horizontal(axis: &Value) -> Option<bool> {
    match axis.as_str() {
        None if axis.is_null() => Some(true),
        Some("horizontal") => Some(true),
        Some("vertical") => Some(false),
        _ => None,
    }
}

fn axis_valid(axis: &Value) -> bool {
    axis_horizontal(axis).is_some()
}

fn numbers(value: Option<&Value>) -> Vec<f64> {
    value.and_then(Value::elements).map(|e| e.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect()).unwrap_or_default()
}

/// `resolveJoinSelection(frame, uids, true).rootSlots`: the root of each selected figure's assembly.
fn translation_roots(objects: &[Value], uids: &[u32]) -> Vec<usize> {
    let mut roots = Vec::new();
    for (slot, object) in objects.iter().enumerate() {
        if !uid(object).is_some_and(|u| uids.contains(&u)) {
            continue;
        }
        let mut at = slot;
        let mut steps = 0;
        while let Some(parent) = crate::record::join_target(&objects[at]).filter(|&p| p < objects.len()) {
            at = parent;
            steps += 1;
            if steps > objects.len() {
                break;
            }
        }
        if !roots.contains(&at) {
            roots.push(at);
        }
    }
    roots
}
