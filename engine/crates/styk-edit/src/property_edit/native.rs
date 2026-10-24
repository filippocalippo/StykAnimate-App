//! Native saved transform curves, inside the existing property-edit/history owner.
//! Native projection is explicit worker preparation with a borrowed check. The
//! draft is transient COW metadata; displayed poses use the existing Records cache.
mod projection;
use super::{
    Edit, channel_id, check_tick, invalid, items, normalize_target, strictly_equal, tick_of,
    validate_value,
};
use crate::history::{Command, CommandKind, Direction};
use crate::select::SelectionState;
use crate::{EditError, Editor};
use styk_doc::{Obj, Value};

#[derive(Clone, Debug)]
pub(super) struct NativeEdit {
    before: Option<Value>,
    before_channel: Option<Value>,
    preview: Option<(Value, usize, usize)>,
}
impl NativeEdit {
    pub(super) fn begin_value_worker(&self, edit: &Edit) -> Value {
        let mut out = Obj::new();
        out.set("target", edit.target.clone());out.set("property", Value::str(&edit.property));
        out.set("exactTarget", Value::Bool(edit.exact));out.set("tick", Value::Num(edit.tick));
        out.set("before", self.before.clone().unwrap_or(Value::Null));
        out.set("beforeChannel", self.before_channel.clone().unwrap_or(Value::Null));
        out.set("initialValue", edit.initial.clone());out.set("selection", edit.selection.history_value());
        out.set("changed", Value::Bool(edit.changed));
        Value::object(out)
    }
}

fn animation(editor: &Editor) -> Option<Value> {
    editor
        .report
        .path(&["_styk", "animation"])
        .filter(|value| !value.is_null())
        .cloned()
}
fn own_channel(editor: &Editor, id: &str) -> Option<Value> {
    items(editor.report.path(&["_styk", "animation", "channels"]))
        .into_iter()
        .find(|channel| channel.get("id").and_then(Value::as_str) == Some(id))
}
/// Shared native channel header admission; values/order stay with typed Records.
fn native_channel_header(channel: &Value, properties: &[&str], ids: &mut std::collections::HashSet<String>) -> bool {
    let property = channel.get("property").and_then(Value::as_str).unwrap_or("");
    let target = channel.get("target").unwrap_or(&Value::Null);
    target.get("kind").and_then(Value::as_str) == Some("figure")
        && properties.contains(&property)
        && normalize_target(target).and_then(|target| channel_id(&target, property)).is_ok_and(|id|
            channel.get("id").and_then(Value::as_str) == Some(id.as_str()) && ids.insert(id))
}
fn native_method(method: &str) -> bool {
    matches!(
        method,
        "select"
            | "@select"
            | "selectMany"
            | "seek"
            | "@seek"
            | "undo"
            | "redo"
            | "beginAnimationEdit"
            | "previewAnimationEdit"
            | "commitAnimationEdit"
            | "cancelAnimationEdit"
            | "addAnimationKey"
            | "addAnimationKeys"
    )
}
fn keys(channel: &Value) -> Vec<Value> {
    items(channel.get("keys"))
}
fn visible_key(channel: Option<&Value>, tick: f64) -> Option<Value> {
    channel.into_iter().flat_map(keys).find(|key| {
        key.get("tick").and_then(Value::as_f64) == Some(tick)
            && !key.get("hidden").is_some_and(Value::truthy)
    })
}
fn easing(key: &Value) -> Result<(String, Option<Value>), EditError> {
    crate::sheet_frames::valid_easing(key)?;
    let mode = key
        .get("interpolation")
        .and_then(Value::as_str)
        .unwrap_or("linear");
    let mode = if mode == "hold" { "constant" } else { mode };
    Ok((
        mode.into(),
        (mode == "bezier").then(|| {
            key.get("bezier")
                .cloned()
                .unwrap_or_else(|| Value::nums(&[0.42, 0.0, 0.58, 1.0]))
        }),
    ))
}
fn assign_easing(key: &mut Obj, mode: &str, bezier: Option<Value>) {
    key.remove("bezier");
    key.set("interpolation", Value::str(mode));
    if let Some(bezier) = bezier {
        key.set("bezier", bezier);
    }
}
fn clear_native(key: &mut Obj) {
    for name in [
        "passthrough",
        "nativeCurve",
        "nativeValueMode",
        "nativeRotation",
    ] {
        key.remove(name);
    }
}

/// `draftAnimation`/`putKey` for the recorded scalar subset. Channels and keys
/// stay in saved order; only a touched channel and its key array are copied.
#[derive(Clone, Debug)]
pub(crate) struct Draft {
    before: Option<Value>,
    after: Obj,
    channels: Vec<Value>,
    touched: Vec<usize>,
    changed: bool,
    /// The same transient `draftAnimation.sources`, not a published source store.
    sources: Vec<(String, Value)>,
}
impl Draft {
    pub(crate) fn new(editor: &Editor) -> Self {
        let before = animation(editor);
        let mut after = before
            .as_ref()
            .and_then(Value::as_obj)
            .cloned()
            .unwrap_or_default();
        after.set("version", Value::Num(1.0));
        after.set(
            "nextKeyId",
            before
                .as_ref()
                .and_then(|value| value.get("nextKeyId"))
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or(Value::Num(1.0)),
        );
        let channels = items(before.as_ref().and_then(|value| value.get("channels")));
        // The assignment happens at draft construction, before adding new keys.
        after.set("channels", Value::array(channels.clone()));
        Self {
            before,
            after,
            channels,
            touched: Vec::new(),
            changed: false,
            sources: Vec::new(),
        }
    }
    pub(crate) fn put(&mut self, editor: &Editor, entry: &Value) -> Result<(Value, usize, usize), EditError> {
        self.put_checked(editor, entry, &mut || Ok(()))
    }

    pub(crate) fn put_checked(&mut self, editor: &Editor, entry: &Value, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<(Value, usize, usize), EditError> {
        check()?;
        if entry
            .get("exactTarget")
            .is_some_and(|value| !matches!(value, Value::Bool(_)))
        {
            return Err(invalid(
                "errors.editorAnimation.exactAnimationTargetingMustBeABoolean",
            ));
        }
        let target = normalize_target(entry.get("target").unwrap_or(&Value::Null))?;
        let property = entry.get("property").and_then(Value::as_str).unwrap_or("");
        let tick = check_tick(&tick_of(entry, editor.tick))?;
        let id = channel_id(&target, property)?;
        let channel_index = match self.channels.iter().position(|channel| channel.get("id").and_then(Value::as_str) == Some(&id)) {
            Some(index) => index,
            None => {
                let mut channel = if editor.options.property_channels && property == "pose" && target.get("kind").and_then(Value::as_str) == Some("figure") {
                    let mut channel = editor.native_baseline_pose_checked(target.get("uid").and_then(Value::as_f64).unwrap() as u32, check)?.as_obj().unwrap().clone();
                    channel.set("source", Value::str("authored"));
                    self.changed = true;
                    channel
                } else if editor.options.property_channels && property == "pose" && target.get("kind").and_then(Value::as_str) == Some("layer") {
                    let mut channel = editor.native_layer_pose_counted(target.get("id").and_then(Value::as_str).unwrap_or(""))?.as_obj().unwrap().clone();
                    channel.set("source", Value::str("authored"));
                    channel
                } else if editor.options.property_channels && property != "pose" {
                    let mut channel = editor.native_property_channel_checked(&target, property, check)?.as_obj().unwrap().clone();
                    channel.set("source", Value::str("authored"));
                    self.changed = true;
                    channel
                } else {
                    let mut channel = Obj::new();
                    channel.set("id", Value::str(&id)); channel.set("target", target.clone());
                    channel.set("property", Value::str(property)); channel.set("keys", Value::array(Vec::new()));
                    channel
                };
                channel.remove("useBasePose");
                self.channels.push(Value::object(channel));
                self.channels.len() - 1
            }
        };
        let mut channel = self.channels[channel_index]
            .as_obj()
            .cloned()
            .ok_or_else(|| EditError::Unported("an unavailable native scalar channel".into()))?;
        channel.remove("useBasePose");
        let raw = match entry.get("value") {
            Some(value) => Some(value.clone()),
            None => editor.native_animation_value(
                &target,
                property,
                tick,
                entry.get("exactTarget").is_some_and(Value::truthy),
            )?,
        }
        .ok_or_else(|| invalid("errors.editorAnimation.theSelectedFigureIsNotPresentAtThis"))?;
        let value = validate_value(&target, property, Some(&raw))?;
        let mut sequence = keys(&Value::object(channel.clone()));
        let existing = sequence.iter().rposition(|key| {
            key.get("tick").and_then(Value::as_f64) == Some(tick)
                && !key.get("hidden").is_some_and(Value::truthy)
        });
        let previous = sequence
            .iter()
            .filter(|key| {
                !key.get("hidden").is_some_and(Value::truthy)
                    && key
                        .get("tick")
                        .and_then(Value::as_f64)
                        .is_some_and(|at| at < tick)
            })
            .max_by(|a, b| {
                a.get("tick")
                    .unwrap()
                    .as_f64()
                    .unwrap()
                    .total_cmp(&b.get("tick").unwrap().as_f64().unwrap())
            });
        let mut timing = Obj::new();
        let inherited = previous
            .and_then(|key| key.get("interpolation"))
            .cloned()
            .unwrap_or_else(|| {
                Value::str(if previous.is_some() {
                    if property == "pose" && editor.report.get("auto_easing").is_some_and(Value::truthy) { "auto" } else { "linear" }
                } else {
                    "constant"
                })
            });
        timing.set(
            "interpolation",
            entry
                .get("interpolation")
                .cloned()
                .or_else(|| existing.and_then(|at| sequence[at].get("interpolation").cloned()))
                .unwrap_or(inherited),
        );
        if timing.get("interpolation").and_then(Value::as_str) == Some("bezier") {
            timing.set(
                "bezier",
                entry
                    .get("bezier")
                    .cloned()
                    .or_else(|| existing.and_then(|at| sequence[at].get("bezier").cloned()))
                    .or_else(|| previous.and_then(|key| key.get("bezier")).cloned())
                    .unwrap_or_else(|| Value::nums(&[0.42, 0.0, 0.58, 1.0])),
            );
        }
        let (mode, bezier) = easing(&Value::object(timing))?;
        let at = match existing {
            Some(at) => {
                let original = &sequence[at];
                if original.get("value") != Some(&value)
                    || original.get("interpolation").and_then(Value::as_str) != Some(mode.as_str())
                    || original.get("bezier") != bezier.as_ref()
                    || original.get("passthrough").is_some_and(Value::truthy)
                {
                    let mut key = original.as_obj().cloned().ok_or_else(|| {
                        EditError::Unported("an unavailable native scalar key".into())
                    })?;
                    key.set("value", value);
                    assign_easing(&mut key, &mode, bezier);
                    clear_native(&mut key);
                    sequence[at] = Value::object(key);
                    self.changed = true;
                }
                at
            }
            None => {
                let name = loop {
                    let identity = self
                        .after
                        .get("nextKeyId")
                        .and_then(Value::as_f64)
                        .unwrap_or(f64::NAN);
                    if !identity.is_finite()
                        || identity.fract() != 0.0
                        || !(1.0..=9_007_199_254_740_991.0).contains(&identity)
                    {
                        return Err(invalid(
                            "errors.cameraBakeAuthored.animationKeyIdentityCapacityExceeded",
                        ));
                    }
                    self.after.set("nextKeyId", Value::Num(identity + 1.0));
                    let name = format!("key-{}", styk_doc::json::to_string(&Value::Num(identity)));
                    if !sequence
                        .iter()
                        .any(|key| key.get("id").and_then(Value::as_str) == Some(&name))
                    {
                        break name;
                    }
                };
                let mut key = Obj::new();
                key.set("id", Value::str(&name));
                key.set("tick", Value::Num(tick));
                key.set("value", value);
                assign_easing(&mut key, &mode, bezier);
                sequence.push(Value::object(key));
                self.changed = true;
                sequence.len() - 1
            }
        };
        let key = sequence[at].clone();
        channel.set("keys", Value::array(sequence));
        self.channels[channel_index] = Value::object(channel);
        if !self.touched.contains(&channel_index) {
            self.touched.push(channel_index);
        }
        Ok((key, channel_index, at))
    }
    pub(crate) fn channels(&self) -> &[Value] { &self.channels }
    #[cfg(test)]
    pub(crate) fn sources(&self) -> &[(String, Value)] { &self.sources }
    pub(crate) fn write_source(&mut self, id: String, source: Value) {
        if let Some((_, value)) = self.sources.iter_mut().find(|(known, _)| *known == id) { *value = source; }
        else { self.sources.push((id, source)); }
    }
    /// Read-only worker projection of this same draft, as `refreshSession` does.
    pub(crate) fn project_report(&self, canonical: &Value) -> Value {
        let mut report = canonical.clone();
        // The typed channel reader requires canonical ordering. Finalize a COW
        // projection only; the live draft retains the editor's insertion order.
        let (_, after, _) = self.clone().finish();
        let metadata = report.make_obj().unwrap().get_mut("_styk").and_then(Value::make_obj).unwrap();
        metadata.set("animation", after);
        if !self.sources.is_empty() {
            if metadata.get("frameSources").is_none() { metadata.set("frameSources", Value::object(Obj::new())); }
            let table = metadata.get_mut("frameSources").and_then(Value::make_obj).unwrap();
            for (id, source) in &self.sources { table.set(id, source.clone()); }
        }
        report
    }
    /// `recordAnimation`: finalize only at commit, register captures through the
    /// existing source/membership owner, then record the same Animation carrier.
    pub(crate) fn publish(self, editor: &mut Editor, label: &str, selection: SelectionState) -> Result<bool, EditError> {
        self.publish_checked(editor,label,selection,label,&mut || Ok(()))
    }
    pub(crate) fn publish_checked(self, editor: &mut Editor, label: &str, selection: SelectionState, event_label: &str, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        check()?;
        let sources = self.sources.clone();
        let (before, after, changed) = self.finish();
        if !changed { return Ok(false); }
        editor.publish_native_pose_sources(&sources)?;
        check()?;
        editor.record_native_animation_checked(before, after, label, selection, false, check)?;
        editor.emit("edit", vec![("label", Value::str(event_label)), ("animation", Value::Bool(true)), ("timing", Value::Bool(true))]);
        Ok(true)
    }
    fn finish(mut self) -> (Option<Value>, Value, bool) {
        for at in &self.touched {
            let mut sequence = keys(&self.channels[*at]);
            sequence.sort_by(|a, b| {
                a.get("tick")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    .total_cmp(&b.get("tick").and_then(Value::as_f64).unwrap_or(0.0))
                    .then_with(|| {
                        b.get("hidden")
                            .is_some_and(Value::truthy)
                            .cmp(&a.get("hidden").is_some_and(Value::truthy))
                    })
            });
            self.channels[*at]
                .make_obj()
                .unwrap()
                .set("keys", Value::array(sequence));
        }
        self.after.set("channels", Value::array(self.channels));
        (self.before, Value::object(self.after), self.changed)
    }
}

impl Editor {
    pub(crate) fn recorded_native_transform_call(&self, method: &str) -> bool {
        if self.sheet()
            || self.options.property_channels
            || self.options.layer_timeline
            || self.selection_metadata.polygon.is_some()
            || self.selection_metadata.segments.is_some()
            || self.selection_metadata.branch.is_some()
            || !native_method(method)
            || self.report.path(&["_styk", "movieclipSource"]).is_some()
            || self.report.path(&["_styk", "simpleFrameDraft"]).is_some()
            || self
                .report
                .get("_styk")
                .is_some_and(|metadata| !metadata.is_object())
        {
            return false;
        }
        let animation = animation(self);
        if animation.as_ref().is_some_and(|animation| {
            !animation.is_object()
                || animation
                    .get("channels")
                    .is_some_and(|channels| !channels.is_null() && !channels.is_array())
        }) {
            return false;
        }
        // Inspect channel headers only. Key values/order are validated by the
        // existing typed Records owner before a property operation can commit.
        let mut ids = std::collections::HashSet::new();
        items(
            animation
                .as_ref()
                .and_then(|animation| animation.get("channels")),
        )
        .iter()
        .all(|channel| native_channel_header(channel, &["x", "y", "scale", "rotation"], &mut ids))
    }

    /// `addSegment` and `addSegments` with nothing selected, drawing a new figure into a native
    /// timeline with saved property channels (`commit_native_transaction_checked`), and the
    /// history around it (the recordings' `@select` and `@seek` too: the interface's own `select`
    /// and `seek` stay with the editor's view): recorded when the channels are figure transforms
    /// and layer poses, and no gesture is open.
    pub(crate) fn recorded_native_draw_call(&self, method: &str, reason: &str) -> bool {
        let draws = matches!(method, "addSegment" | "addSegments");
        if reason != "with property channels on a native timeline"
            || !(draws || matches!(method, "@seek" | "@select" | "undo" | "redo"))
            || !self.native_channel_transaction()
            || (draws && (self.selection.uid.is_some() || !self.selection.uids.is_empty()))
            || self.drag.is_some()
            || self.property_edit.is_some()
            || self.authored.is_some()
            || self.native_token.is_some()
            || self.report.path(&["_styk", "movieclipSource"]).is_some()
            || self.report.path(&["_styk", "simpleFrameDraft"]).is_some()
            || items(self.report.get("figure_types")).iter().any(|figure| figure.path(&["_styk", "animationOrigin"]).is_some_and(Value::truthy))
        {
            return false;
        }
        let Some(animation) = animation(self) else { return false };
        if !animation.is_object() || animation.get("channels").is_some_and(|channels| !channels.is_null() && !channels.is_array()) {
            return false;
        }
        let mut ids = std::collections::HashSet::new();
        items(animation.get("channels")).iter().all(|channel| {
            let layer_pose = channel.get("property").and_then(Value::as_str) == Some("pose")
                && channel.path(&["target", "kind"]).and_then(Value::as_str) == Some("layer")
                && normalize_target(channel.get("target").unwrap_or(&Value::Null)).and_then(|target| channel_id(&target, "pose")).is_ok_and(|id| channel.get("id").and_then(Value::as_str) == Some(id.as_str()) && ids.insert(id));
            layer_pose || native_channel_header(channel, &["x", "y", "scale", "rotation"], &mut ids)
        })
    }

    pub(crate) fn native_transform_gate(
        &self,
        method: &str,
        args: &[Value],
        projected_native: bool,
    ) -> Result<(), EditError> {
        if self.sheet() || !crate::origin::property_call(method) {
            return Ok(());
        }
        if self.selection_metadata.polygon.is_some()
            || self.selection_metadata.segments.is_some()
            || self.selection_metadata.branch.is_some()
        {
            return Err(EditError::Unported(
                "native scalar authoring with optional selection metadata".into(),
            ));
        }
        if !self.recorded_native_transform_call(method) && !projected_native {
            return Err(EditError::Unported(
                "unrecorded native channel authoring or projection".into(),
            ));
        }
        if method == "addAnimationKey"
            && args
                .get(4)
                .and_then(|options| options.get("exactTarget"))
                .is_some_and(|exact| !matches!(exact, Value::Bool(_)))
        {
            return Err(EditError::Unported(
                "an unrecorded nonboolean native exact target option".into(),
            ));
        }
        if self.property_edit.is_some() || self.drag.is_some() {
            // JavaScript commits the prior gesture before validating a new
            // mutation. Invalid calls with those side effects are recorded as
            // unavailable; an atomic refusal preserves its fallback view.
            let validate = |entry: &Value| -> Result<(), EditError> {
                let target = normalize_target(entry.get("target").unwrap_or(&Value::Null))?;
                let property = entry.get("property").and_then(Value::as_str).unwrap_or("");
                channel_id(&target, property)?;
                check_tick(&tick_of(entry, self.tick))?;
                if let Some(value) = entry.get("value") {
                    validate_value(&target, property, Some(value))?;
                }
                if entry.get("interpolation").is_some() {
                    crate::sheet_frames::valid_easing(entry)?;
                }
                if entry
                    .get("exactTarget")
                    .is_some_and(|exact| !matches!(exact, Value::Bool(_)))
                {
                    return Err(invalid(
                        "errors.editorAnimation.exactAnimationTargetingMustBeABoolean",
                    ));
                }
                Ok(())
            };
            let checked = match method {
                "beginAnimationEdit" => check_tick(&Value::Num(self.tick)).map(|_| ()),
                "addAnimationKey" => {
                    let mut entry = Obj::new();
                    entry.set("target", args.first().cloned().unwrap_or(Value::Null));
                    entry.set("property", args.get(1).cloned().unwrap_or(Value::Null));
                    entry.set(
                        "tick",
                        args.get(2)
                            .filter(|tick| !tick.is_null())
                            .cloned()
                            .unwrap_or(Value::Num(self.tick)),
                    );
                    if let Some(value) = args.get(3) {
                        entry.set("value", value.clone());
                    }
                    validate(&Value::object(entry))
                }
                "addAnimationKeys" => items(args.first()).iter().try_for_each(validate),
                _ => Ok(()),
            };
            if checked.is_err() {
                return Err(EditError::Unported(
                    "invalid native key input with an open editing gesture".into(),
                ));
            }
        }
        // Reuse the recorded property target/ancestor owner at the actual key tick,
        // before a begin/add operation can commit any existing live gesture.
        self.origin_property_gate(method, args)?;
        if !projected_native && self.drag.is_some()
            && self
                .report
                .path(&["_styk", "animation", "channels"])
                .and_then(Value::array_len)
                .unwrap_or(0)
                > 0
        {
            return Err(EditError::Unported(
                "a native saved-channel pose gesture".into(),
            ));
        }
        Ok(())
    }
    fn native_animation_value(
        &self,
        target: &Value,
        property: &str,
        tick: f64,
        exact: bool,
    ) -> Result<Option<Value>, EditError> {
        let visible = self.animation_value(target, property, &Value::Num(tick))?;
        if exact && visible.is_some() {
            self.with_records(|records| {
                Ok(records
                    .sample_channel_value(target, property, tick)?
                    .or(visible))
            })
        } else {
            Ok(visible)
        }
    }
    /// The shared native animation assignment owner. History and live previews
    /// retain the immutable table; displaying it uses the existing Records cache.
    fn assign_native_animation(&mut self, value: Option<&Value>) {
        let report = self.report.make_obj().unwrap();
        if report.get("_styk").is_none() {
            report.set("_styk", Value::object(Obj::new()));
        }
        let metadata = report.get_mut("_styk").and_then(Value::make_obj).unwrap();
        match value {
            Some(value) => metadata.set("animation", value.clone()),
            None => {
                metadata.remove("animation");
            }
        }
        self.retained = None;
    }
    pub(crate) fn record_native_animation(
        &mut self,
        before: Option<Value>,
        after: Value,
        label: &str,
        selection: SelectionState,
        structural: bool,
    ) -> Result<bool, EditError> {
        self.record_native_animation_checked(before, after, label, selection, structural, &mut || Ok(()))
    }
    pub(crate) fn record_native_animation_checked(
        &mut self,
        before: Option<Value>,
        after: Value,
        label: &str,
        selection: SelectionState,
        structural: bool,
        check: &mut dyn FnMut() -> Result<(), EditError>,
    ) -> Result<bool, EditError> {
        check()?;
        self.assign_native_animation(Some(&after));
        self.record_checked(Command {
            kind: CommandKind::Animation {
                before,
                after,
                structural,
            },
            label: label.into(),
            before_selection: selection,
            after_selection: self.selection_state(),
            before_revision: 0,
            after_revision: 0,
            layer_changes: Vec::new(),
            captured_source_bytes: 0,
            layers: false,
        }, &mut || check())?;
        Ok(true)
    }
    // Extracted from the immutable native movieclip Animation history owner;
    // structural is now retained per command rather than assumed for all curves.
    pub(crate) fn apply_native_animation(
        &mut self,
        command: &Command,
        direction: Direction,
    ) -> Result<(), EditError> {
        let CommandKind::Animation {
            before,
            after,
            structural,
        } = &command.kind
        else {
            return Ok(());
        };
        self.assign_native_animation(if direction == Direction::Before {
            before.as_ref()
        } else {
            Some(after)
        });
        self.apply_attached_layer_changes(&command.layer_changes, direction);
        self.restore_selection(if direction == Direction::Before {
            &command.before_selection
        } else {
            &command.after_selection
        })?;
        self.revision = if direction == Direction::Before {
            command.before_revision
        } else {
            command.after_revision
        };
        self.emit(
            "history",
            vec![
                ("label", Value::str(&command.label)),
                ("structural", Value::Bool(*structural)),
                ("timing", Value::Bool(true)),
                ("definition", Value::Bool(false)),
                ("animation", Value::Bool(true)),
            ],
        );
        Ok(())
    }
    pub(super) fn add_native_animation_keys(
        &mut self,
        entries: &[Value],
    ) -> Result<Value, EditError> {
        if self.property_edit.is_some() {
            self.commit_animation_edit()?;
        }
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let selection = self.selection_state();
        let mut draft = Draft::new(self);
        let mut returned = Vec::with_capacity(entries.len());
        for entry in entries {
            let (key, channel_index, _) = draft.put(self, entry)?;
            returned.push((key, channel_index));
        }
        let (before, after, changed) = draft.finish();
        // The editor returns references to draft keys. Repeated writes to one
        // key therefore all report its final value, after the entire mutation.
        let result = returned
            .into_iter()
            .map(|(key, channel_index)| {
                after
                    .get("channels")
                    .and_then(|channels| channels.item(channel_index))
                    .and_then(|channel| {
                        keys(&channel)
                            .into_iter()
                            .find(|candidate| candidate.get("id") == key.get("id"))
                    })
                    .unwrap_or(key)
            })
            .collect();
        if changed {
            self.record_native_animation(before, after, "Add animation keys", selection, false)?;
            self.emit(
                "edit",
                vec![
                    ("label", Value::str("Add animation keys")),
                    ("animation", Value::Bool(true)),
                    ("timing", Value::Bool(true)),
                ],
            );
        }
        Ok(Value::array(result))
    }
    pub(super) fn begin_native_animation_edit_checked(&mut self, target: &Value, property: &Value, exact: bool, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<Value, EditError> {
        check()?;
        if self.property_edit.is_some() {
            self.commit_animation_edit_checked(check)?;
        }
        if self.drag.is_some() {
            self.commit_drag_checked(check)?;
        }
        let target = normalize_target(target)?;
        let property = property.as_str().unwrap_or("");
        let id = channel_id(&target, property)?;
        check_tick(&Value::Num(self.tick))?;
        let initial = self
            .native_animation_value(&target, property, self.tick, exact)?
            .ok_or_else(|| invalid("errors.editorAnimation.theSelectedFigureIsNotPresentAtThis"))?;
        let native = NativeEdit {
            before: animation(self),
            before_channel: own_channel(self, &id),
            preview: None,
        };
        self.property_edit = Some(Edit {
            native: Some(native),
            target: target.clone(),
            property: property.into(),
            exact,
            tick: self.tick,
            initial: initial.clone(),
            value: initial,
            frame: Value::Null,
            selection: self.selection_state(),
            changed: false,
            preview: None,
        });
        Ok(Value::Null) // The existing replay/facade treats the edit record as a view.
    }
    pub(super) fn preview_native_animation_edit_checked(&mut self, value: Option<Value>, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<Value, EditError> {
        check()?;
        let Some(edit) = self.property_edit.clone() else {
            return Err(invalid(
                "errors.editorAnimation.beginAPropertyEditBeforePreviewingIt",
            ));
        };
        let value = validate_value(&edit.target, &edit.property, value.as_ref())?;
        let native = edit
            .native
            .as_ref()
            .ok_or_else(|| EditError::Unported("a non-native property edit".into()))?;
        let (after, channel_index, key_index) = if let Some((preview, channel_index, key_index)) =
            native.preview.as_ref().filter(|(preview, _, _)| {
                animation(self)
                    .as_ref()
                    .is_some_and(|current| current.same_node(preview))
            }) {
            let mut channels = items(preview.get("channels"));
            let mut channel = channels[*channel_index].as_obj().cloned().unwrap();
            let mut sequence = keys(&Value::object(channel.clone()));
            if sequence[*key_index].get("value") == Some(&value) {
                return Ok(value);
            }
            let mut key = sequence[*key_index].as_obj().cloned().unwrap();
            let (mode, bezier) = easing(&Value::object(key.clone()))?;
            key.set("value", value.clone());
            assign_easing(&mut key, &mode, bezier);
            clear_native(&mut key);
            sequence[*key_index] = Value::object(key);
            channel.set("keys", Value::array(sequence));
            channels[*channel_index] = Value::object(channel);
            let mut after = preview.as_obj().cloned().unwrap();
            after.set("channels", Value::array(channels));
            (Value::object(after), *channel_index, *key_index)
        } else {
            let mut entry = Obj::new();
            entry.set("target", edit.target.clone());
            entry.set("property", Value::str(&edit.property));
            entry.set("tick", Value::Num(edit.tick));
            entry.set("value", value.clone());
            entry.set("exactTarget", Value::Bool(edit.exact));
            let mut draft = Draft::new(self);
            let (key, channel_index, _) = draft.put_checked(self, &Value::object(entry), check)?;
            let (_, after, changed) = draft.finish();
            if !changed {
                return Ok(value);
            }
            let key_index = keys(&after.get("channels").unwrap().item(channel_index).unwrap())
                .iter()
                .position(|candidate| candidate.get("id") == key.get("id"))
                .unwrap();
            (after, channel_index, key_index)
        };
        self.assign_native_animation(Some(&after));
        let open = self.property_edit.as_mut().unwrap();
        open.changed = true;
        open.value = value.clone();
        open.native.as_mut().unwrap().preview = Some((after, channel_index, key_index));
        self.emit(
            "edit",
            vec![
                ("live", Value::Bool(true)),
                ("animation", Value::Bool(true)),
                (
                    "changedChannels",
                    Value::array(vec![Value::str(&channel_id(&edit.target, &edit.property)?)]),
                ),
            ],
        );
        Ok(value)
    }
    pub(super) fn commit_native_animation_edit_checked(&mut self, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<bool, EditError> {
        check()?;
        let Some(edit) = self.property_edit.take() else {
            return Ok(false);
        };
        if !edit.changed {
            return Ok(false);
        }
        let native = edit
            .native
            .ok_or_else(|| EditError::Unported("a non-native property edit".into()))?;
        let channel = own_channel(self, &channel_id(&edit.target, &edit.property)?);
        let original = visible_key(native.before_channel.as_ref(), edit.tick);
        let key = visible_key(channel.as_ref(), edit.tick);
        if native.before_channel == channel
            || original.is_none()
                && key
                    .as_ref()
                    .is_some_and(|key| strictly_equal(&edit.initial, key.get("value")))
        {
            self.assign_native_animation(native.before.as_ref());
            self.emit(
                "edit",
                vec![
                    ("animation", Value::Bool(true)),
                    ("label", Value::str("Cancel unchanged property edit")),
                ],
            );
            return Ok(false);
        }
        let after = animation(self)
            .ok_or_else(|| EditError::Unported("an unavailable native animation edit".into()))?;
        self.record_native_animation_checked(
            native.before,
            after,
            &format!("Animate {}", edit.property),
            edit.selection,
            false,
            check,
        )?;
        self.emit(
            "edit",
            vec![
                ("label", Value::str(&format!("Animate {}", edit.property))),
                ("animation", Value::Bool(true)),
                ("timing", Value::Bool(true)),
            ],
        );
        Ok(true)
    }
    pub(super) fn cancel_native_animation_edit(&mut self) -> Result<bool, EditError> {
        let Some(edit) = self.property_edit.take() else {
            return Ok(false);
        };
        let native = edit
            .native
            .ok_or_else(|| EditError::Unported("a non-native property edit".into()))?;
        self.assign_native_animation(native.before.as_ref());
        self.emit(
            "edit",
            vec![
                ("animation", Value::Bool(true)),
                ("label", Value::str("Cancel property edit")),
            ],
        );
        Ok(true)
    }
}

#[cfg(test)]
mod live_tests;
