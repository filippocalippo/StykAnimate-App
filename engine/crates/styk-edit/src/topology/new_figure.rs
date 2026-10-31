//! The no-selection branch of `addSegments`, through the existing authored
//! transaction or the native editor's figure-splice history entry.
use super::{StrokeSpec, invalid, items};
use crate::figures::{create_object, frame_order, normalize_frame, set_order};
use crate::history::{Command, CommandKind};
use crate::record::num;
use crate::{EditError, Editor};
use styk_doc::{Obj, Value};

fn segment(spec: &StrokeSpec, index: usize) -> Value {
    let id = index as f64 + 1.0;
    let thickness = spec.thickness.unwrap_or(8.0);
    let mut record = Obj::new();
    for (key, value) in [
        ("segment_id", id),
        (
            "parent_id",
            spec.parent
                .as_ref()
                .filter(|v| !v.is_null())
                .and_then(Value::as_f64)
                .unwrap_or(index as f64),
        ),
        ("length", spec.length),
        ("angle_rad", spec.angle),
        ("thickness", thickness),
        ("bend_rad", 0.0),
        ("primitive_code", spec.code),
        ("aux_code", 0.0),
        ("flags", spec.code),
    ] {
        record.set(key, Value::Num(value));
    }
    record.set(
        "segment_type",
        Value::str(if [1.0, 3.0, 4.0].contains(&spec.code) {
            "circle"
        } else {
            "line"
        }),
    );
    record.set(
        "segment_kind",
        Value::str(crate::builder::KINDS[spec.code as usize]),
    );
    record.set("color_rgb", Value::nums(&[106.0, 77.0, 234.0]));
    record.set("transparency", Value::Num(0.0));
    record.set("visible", Value::Bool(thickness > 0.0 || spec.code > 0.0));
    record.set("z_order", Value::Num(id));
    Value::object(record)
}
fn splice_side(figures: Vec<Value>, frame: Value) -> Value {
    let mut side = Obj::new();
    side.set("figures", Value::array(figures));
    side.set("frame", frame);
    Value::object(side)
}
impl Editor {
    pub(super) fn add_drawn_figure(
        &mut self,
        specs: &Value,
        prepared: &[StrokeSpec],
        first: &Value,
    ) -> Result<Value, EditError> {
        if self.report.path(&["_styk", "simpleFrameDraft"]).is_some() {
            return Err(EditError::Unported(
                "drawing a new figure into a Simple frame draft".into(),
            ));
        }
        if (self.sheet() || self.native_channel_transaction()) && self.authored.is_none() {
            let mut result = Value::Null;
            self.transaction("Draw figure", |editor| {
                result = editor.add_segments(specs)?;
                Ok(())
            })?;
            return Ok(result);
        }
        if !self.sheet()
            && !self.native_channel_transaction()
            && self
                .report
                .path(&["_styk", "animation", "channels"])
                .and_then(Value::array_len)
                .is_some_and(|n| n > 0)
        {
            return Err(EditError::Unported(
                "drawing a new figure into native animation channels".into(),
            ));
        }
        // A new definition's parents can only be the native origin. Links later
        // in the stroke are chosen implicitly, exactly as the editor validates.
        if prepared.iter().any(|s| {
            s.parent
                .as_ref()
                .filter(|v| !v.is_null())
                .is_some_and(|p| p.as_f64() != Some(0.0))
        }) {
            return Err(invalid("errors.editor.theSegmentParentDoesNotExist"));
        }
        let coordinate = |key: &str, fallback: f64| -> Result<f64, EditError> {
            let label = format!("Figure {}", key.to_uppercase());
            match first
                .get("start")
                .and_then(|v| v.get(key))
                .filter(|v| !v.is_null())
            {
                None => Ok(fallback),
                Some(value) => value
                    .as_f64()
                    .filter(|v| v.is_finite())
                    .ok_or_else(|| crate::transform::not_finite(&label)),
            }
        };
        let x = coordinate(
            "x",
            num(&self.report, "canvas_width").unwrap_or(f64::NAN) / 2.0,
        )?;
        let y = coordinate(
            "y",
            num(&self.report, "canvas_height").unwrap_or(f64::NAN) / 2.0,
        )?;
        if !x.is_finite() {
            return Err(crate::transform::not_finite("Figure X"));
        }
        if !y.is_finite() {
            return Err(crate::transform::not_finite("Figure Y"));
        }
        if self.next_uid > 0x7fff_fffe {
            return Err(invalid(
                "errors.editorLayerSheet.objectIdentityCapacityReached",
            ));
        }
        let figures = items(self.report.get("figure_types"));
        let figure_index = figures.len();
        let type_id = figures
            .iter()
            .filter_map(|f| num(f, "figure_type_id"))
            .fold(0.0, f64::max)
            + 1.0;
        let segments: Vec<_> = prepared
            .iter()
            .enumerate()
            .map(|(i, s)| segment(s, i))
            .collect();
        let mut figure = Obj::new();
        figure.set("figure_type_id", Value::Num(type_id));
        figure.set(
            "name",
            Value::str(if segments.len() > 1 {
                "Chain"
            } else if [1.0, 3.0, 4.0].contains(&prepared[0].code) {
                "Circle"
            } else {
                "Line"
            }),
        );
        figure.set("segment_count", Value::Num(segments.len() as f64));
        figure.set("segments", Value::array(segments.clone()));
        for key in ["polyfills", "image_assets", "text_assets"] {
            figure.set(key, Value::array(Vec::new()));
        }
        let figure = Value::object(figure);
        let before_frame = self
            .authored
            .as_ref()
            .map(|edit| edit.frame.clone())
            .or_else(|| {
                self.report
                    .get("keyframes")
                    .and_then(|frames| frames.item(self.frame_index))
            })
            .unwrap_or(Value::Null);
        let selection = self.selection_state();
        let record_command = !self.authored.as_ref().is_some_and(|edit| edit.transaction);
        if record_command {
            // Membership is counted from the old published frames, before the
            // native frame can contain the new identity.
            self.ensure_counts();
        }
        let identity = self.next_uid;
        self.next_uid += 1;
        self.report
            .make_obj()
            .unwrap()
            .get_mut("figure_types")
            .unwrap()
            .make_arr()
            .unwrap()
            .push(figure.clone());
        let object = create_object(&figure, identity as u32, x, y);
        let mut frame = before_frame.as_obj().cloned().unwrap_or_default();
        let mut order = frame_order(&frame);
        let mut objects = items(frame.get("objects"));
        objects.push(object);
        frame.set("objects", Value::array(objects));
        order.push(identity as f64);
        set_order(&mut frame, &order);
        normalize_frame(&mut frame);
        let after_frame = Value::object(frame);
        if let Some(edit) = self.authored.as_mut() {
            edit.frame = after_frame.clone();
        } else if let Some(frame) = self
            .report
            .make_obj()
            .and_then(|r| r.get_mut("keyframes"))
            .and_then(Value::make_arr)
            .and_then(|frames| frames.get_mut(self.frame_index))
        {
            *frame = after_frame.clone();
        }
        self.selection = crate::Selection {
            uid: Some(identity as u32),
            uids: vec![identity as u32],
            joint: segments.len() as i64 - 1,
        };
        // `selectedUid = uid`: no fill, joints or branch of the figure drawn from stays chosen.
        self.selection_metadata = crate::select::SelectionMetadata::default();
        if record_command {
            let layers = self.track_frames(
                std::slice::from_ref(&before_frame),
                std::slice::from_ref(&after_frame),
                true,
            )?;
            self.record(Command {
                kind: CommandKind::FigureSplice {
                    index: self.frame_index,
                    figure_index,
                    before: splice_side(Vec::new(), before_frame),
                    after: splice_side(vec![figure], after_frame),
                },
                label: "Draw figure".into(),
                before_selection: selection,
                after_selection: self.selection_state(),
                before_revision: 0,
                after_revision: 0,
                layer_changes: Vec::new(),
                captured_source_bytes: 0,
                layers,
            })?;
        }
        self.retained = None;
        self.emit(
            "edit",
            vec![
                ("label", Value::str("Draw figure")),
                ("structural", Value::Bool(true)),
            ],
        );
        Ok(Value::array(segments))
    }
}
