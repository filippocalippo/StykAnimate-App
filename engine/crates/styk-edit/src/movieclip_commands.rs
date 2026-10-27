//! Movieclip definitions, sparse selection capture and displayed-frame conversion.
//! Record-level counterparts of src/editor-movieclips.mjs; existing sheet plans own
//! replacements, counters, resource retention and publication.
use crate::figures::{create_object, frame_order, normalize_frame, set_order};
use crate::frame::objects_of;
use crate::record::{num, uid};
use crate::sheet::{create_frame, items};
use crate::{EditError, Editor};
use std::collections::{HashMap, HashSet};
use styk_doc::{Obj, Value};

fn object(fields: &[(&str, Value)]) -> Value {
    let mut o = Obj::new();
    for (k, v) in fields {
        o.set(k, v.clone());
    }
    Value::object(o)
}
pub(crate) fn error(key: &str) -> EditError {
    EditError::Invalid(format!("errors.editorMovieclips.{key}"))
}
pub(crate) fn allocate_type(report: &Value) -> f64 {
    items(report.get("figure_types")).iter().fold(1.0f64, |id, f| id.max(num(f, "figure_type_id").unwrap_or(0.0) + 1.0))
}
fn presence(playback: &Value) -> Value {
    let mut out = object(&[("clock", Value::str("presence")), ("offset", Value::Num(0.0)), ("speed", Value::Num(1.0)), ("mode", Value::str("loop"))]).as_obj().cloned().unwrap();
    for (k, v) in playback.as_obj().map(|o| o.iter().collect::<Vec<_>>()).unwrap_or_default() {
        out.set(k, v.clone());
    }
    Value::object(out)
}
/// `presencePlayback({mode, speed})`: the presence clock from the start, in a copied instance's mode (loop by default) and speed.
pub(crate) fn presence_of(mode: Option<Value>, speed: Option<Value>) -> Value {
    let mut settings = Obj::new();
    settings.set("mode", mode.unwrap_or_else(|| Value::str("loop")));
    settings.set("speed", speed.unwrap_or(Value::Num(1.0)));
    presence(&Value::object(settings))
}
pub(crate) fn uses_presence(o: &Value) -> bool {
    o.path(&["_stykMovieclip", "clock"]).and_then(Value::as_str) == Some("presence")
}
fn set_continuations(frame: &mut Obj, values: Vec<Value>) {
    let mut styk = frame.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    if values.is_empty() {
        styk.remove("movieclipContinuations");
    } else {
        styk.set("movieclipContinuations", Value::array(values));
    }
    frame.set("_styk", Value::object(styk));
}
/// The new figure layer of a clip made of drawings (`sheetCreateMovieclip`'s `ownLayer`): named after the clip (at most 120 characters,
/// else "Movieclip"), in the folder of the anchor drawing layer, directly above it. Returns its id.
fn clip_layer(layers: &mut Value, above: &str, name: Option<&Value>) -> String {
    let title = name.and_then(Value::as_str).map(|name| String::from_utf16_lossy(&name.encode_utf16().take(120).collect::<Vec<_>>())).filter(|name| !name.is_empty()).unwrap_or_else(|| "Movieclip".to_string());
    let Some(state) = layers.make_obj() else { return above.to_string() };
    let next = state.get("nextId").and_then(Value::as_f64).unwrap_or(1.0);
    let id = format!("layer-{}", styk_doc::json::to_string(&Value::Num(next)));
    let folder = state.get("byId").and_then(|by_id| by_id.get(above)).and_then(|layer| layer.get("folderId")).filter(|folder| folder.truthy()).cloned();
    let mut layer = Obj::new();
    layer.set("name", Value::str(&title));
    layer.set("visible", Value::Bool(true));
    layer.set("locked", Value::Bool(false));
    if let Some(folder) = folder {
        layer.set("folderId", folder);
    }
    if let Some(by_id) = state.get_mut("byId").and_then(Value::make_obj) {
        by_id.set(&id, Value::object(layer));
    }
    let mut order: Vec<Value> = items(state.get("order"));
    let at = order.iter().position(|layer| layer.as_str() == Some(above)).map_or(order.len(), |at| at + 1);
    order.insert(at, Value::str(&id));
    state.set("order", Value::array(order));
    state.set("nextId", Value::Num(next + 1.0));
    id
}

/// `clipDrawingKeys(document, localFrames)`: a captured clip's layer sheet with ordinary drawing keys. Without one, loading
/// derives imported-timing keys, which draw the cels but cannot be painted, copied or re-timed like drawing keys. Each
/// exposure gets its own pose frame; consecutive keys showing the same cel become one hold.
fn clip_drawing_keys(document: &mut Value, local: &[Value]) -> Result<(), EditError> {
    crate::load::initialize_layer_sheet(document)?;
    let mut starts = Vec::with_capacity(local.len());
    let mut elapsed = 0.0;
    for frame in local {
        starts.push(elapsed);
        elapsed += num(frame, "duration_raw").unwrap_or(f64::NAN);
    }
    let frame_at = |tick: f64| {
        let mut i = starts.len().saturating_sub(1);
        while i > 0 && starts[i] > tick {
            i -= 1;
        }
        local.get(i)
    };
    let layers = document.path(&["_styk", "layers"]).cloned().unwrap_or(Value::Null);
    let order: Vec<String> = items(layers.get("order")).iter().filter_map(|id| id.as_str().map(str::to_string)).collect();
    let mut sources = document.path(&["_styk", "frameSources"]).and_then(Value::as_obj).cloned().unwrap_or_default();
    let mut next = 1u64;
    let mut tracks: Vec<(String, Vec<Value>)> = Vec::new();
    for id in &order {
        if layers.path(&["byId", id, "drawing", "version"]).and_then(Value::as_f64) != Some(1.0) {
            continue;
        }
        let mut previous: Option<Option<Value>> = None;
        let mut keys: Vec<Value> = Vec::new();
        for key in items(document.path(&["_styk", "layerSheet", "tracks", id, "keys"])) {
            let tick = num(&key, "sourceTick").or_else(|| num(&key, "tick")).unwrap_or(f64::NAN);
            let frame = frame_at(tick).ok_or_else(|| EditError::Unported("a movieclip without frames".into()))?;
            let owned: Vec<Value> = objects_of(frame).into_iter().filter(|o| uid(o).is_some_and(|u| layers.path(&["assignments", &u.to_string()]).and_then(Value::as_str) == Some(id.as_str()))).collect();
            let cel = owned.first().and_then(|o| o.get("figure_type_id")).cloned();
            if !keys.is_empty() && previous.as_ref() == Some(&cel) {
                continue;
            }
            previous = Some(cel.clone());
            let mut kept = Obj::new();
            kept.set("id", key.get("id").cloned().unwrap_or(Value::Null));
            kept.set("tick", key.get("tick").cloned().unwrap_or(Value::Null));
            kept.set("interpolation", Value::str("constant"));
            if cel.is_none() {
                kept.set("value", object(&[("frameId", Value::Null)]));
                kept.set("empty", Value::Bool(true));
                keys.push(Value::object(kept));
                continue;
            }
            while sources.contains(&format!("frame-{next}")) {
                next += 1;
            }
            let frame_id = format!("frame-{next}");
            next += 1;
            let uids: Vec<f64> = owned.iter().filter_map(uid).map(f64::from).collect();
            let mut pose = styk_eval::records::snapshot_pose_frame_of(frame, Some(&uids)).as_obj().cloned().unwrap_or_default();
            let mut styk = pose.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
            styk.set("frameId", Value::str(&frame_id));
            pose.set("_styk", Value::object(styk));
            sources.set(&frame_id, Value::object(pose));
            kept.set("value", object(&[("frameId", Value::str(&frame_id))]));
            keys.push(Value::object(kept));
        }
        tracks.push((id.clone(), keys));
    }
    let styk = document.make_obj().and_then(|d| d.get_mut("_styk")).and_then(Value::make_obj).ok_or_else(|| EditError::Unported("a movieclip document without metadata".into()))?;
    styk.set("frameSources", Value::object(sources));
    if let Some(existing) = styk.get_mut("layerSheet").and_then(Value::make_obj).and_then(|sheet| sheet.get_mut("tracks")).and_then(Value::make_obj) {
        for (id, keys) in tracks {
            let mut track = existing.get(&id).and_then(Value::as_obj).cloned().unwrap_or_default();
            track.set("keys", Value::array(keys));
            existing.set(&id, Value::object(track));
        }
    }
    Ok(())
}
fn movieclip_figure(id: f64, name: Value, document: Value, duration: f64, pivot: Value) -> Value {
    let segment = object(&[
        ("segment_id", Value::Num(1.0)),
        ("parent_id", Value::Num(0.0)),
        ("length", Value::Num(40.0)),
        ("angle_rad", Value::Num(0.0)),
        ("thickness", Value::Num(0.0)),
        ("bend_rad", Value::Num(0.0)),
        ("primitive_code", Value::Num(0.0)),
        ("aux_code", Value::Num(0.0)),
        ("flags", Value::Num(0.0)),
        ("segment_type", Value::str("line")),
        ("segment_kind", Value::str("line")),
        ("color_rgb", Value::array(vec![Value::Num(0.0); 3])),
        ("transparency", Value::Num(0.0)),
        ("visible", Value::Bool(false)),
        ("z_order", Value::Num(1.0)),
    ]);
    object(&[
        ("figure_type_id", Value::Num(id)),
        ("name", name),
        ("segment_count", Value::Num(1.0)),
        ("segments", Value::array(vec![segment])),
        ("polyfills", Value::array(vec![])),
        ("image_assets", Value::array(vec![])),
        ("text_assets", Value::array(vec![])),
        ("_styk", object(&[("movieclip", object(&[("version", Value::Num(1.0)), ("document", document), ("duration", Value::Num(duration)), ("sourceStart", Value::Num(0.0)), ("pivot", pivot)]))])),
    ])
}
pub(crate) fn filtered_frame(frame: &Value, selected: &HashSet<u32>) -> Value {
    let source = objects_of(frame);
    let mut result = frame.as_obj().cloned().unwrap_or_default();
    let mut objects: Vec<Value> = source
        .iter()
        .filter(|o| uid(o).is_some_and(|u| selected.contains(&u)))
        .map(|o| {
            let mut o = o.as_obj().cloned().unwrap_or_default();
            o.remove("runtime_segments");
            o.remove("_movieclipSample");
            if let Some(join) = o.get_mut("join").filter(|v| v.truthy()).and_then(Value::make_obj) {
                if let Some(id) = join.get("target_object_slot").and_then(Value::as_f64).and_then(|s| source.get(s as usize)).and_then(|o| o.get("unique_id")) {
                    join.set("target_unique_id", id.clone());
                }
            }
            Value::object(o)
        })
        .collect();
    // `normalizeFrame` reads slots from this filtered list, so preserve the
    // source's saved parent UID before sorting/remapping it there.
    let slots: Vec<Option<u32>> = objects.iter().map(uid).collect();
    for object in &mut objects {
        if let Some(join) = object.make_obj().and_then(|o| o.get_mut("join")).filter(|j| j.truthy()).and_then(Value::make_obj) {
            match join.get("target_unique_id").and_then(Value::as_f64).and_then(|id| slots.iter().position(|uid| *uid == Some(id as u32))) {
                Some(slot) => join.set("target_object_slot", Value::Num(slot as f64)),
                None => { join.remove("target_object_slot"); }
            }
        }
    }
    result.set("objects", Value::array(objects));
    result.set("camera", object(&[("is_default", Value::Bool(true)), ("x", Value::Num(0.0)), ("y", Value::Num(0.0)), ("angle_rad", Value::Num(0.0)), ("scale", Value::Num(1.0))]));
    for k in ["background_id", "background_id_b", "background_mix"] {
        result.set(k, Value::Num(0.0));
    }
    for k in ["_stykBackgroundColor", "background_color", "_stykVfx"] {
        result.remove(k);
    }
    let steps = crate::sheet::continuations(frame).into_iter().filter(|s| num(s, "uid").is_some_and(|u| selected.contains(&(u as u32)))).collect();
    set_continuations(&mut result, steps);
    let ids = frame_order(frame.as_obj().unwrap()).into_iter().filter(|u| selected.contains(&(*u as u32))).collect::<Vec<_>>();
    set_order(&mut result, &ids);
    normalize_frame(&mut result);
    Value::object(result)
}

/// The imported animation of a clip keeps the channels of the figures it holds and of the layers they are on.
fn keep_channels(animation: &mut Obj, selected: &HashSet<u32>, layers: &HashSet<String>) {
    let channels = items(animation.get("channels"))
        .into_iter()
        .filter(|c| match c.path(&["target", "kind"]).and_then(Value::as_str) {
            Some("figure" | "segment" | "polygon") => c.path(&["target", "uid"]).and_then(Value::as_f64).is_some_and(|u| selected.contains(&(u as u32))),
            Some("layer") => c.path(&["target", "id"]).and_then(Value::as_str).is_some_and(|id| layers.contains(id)),
            _ => false,
        })
        .collect();
    animation.set("channels", Value::array(channels));
}
/// The effect clips of a clip are those on the figures it holds (none on the scene).
fn keep_vfx_clips(vfx: &mut Obj, selected: &HashSet<u32>) {
    let clips = items(vfx.get("clips"))
        .into_iter()
        .filter(|c| c.path(&["target", "kind"]).and_then(Value::as_str) != Some("scene") && c.path(&["target", "uid"]).and_then(Value::as_f64).is_some_and(|u| selected.contains(&(u as u32))))
        .collect();
    vfx.set("clips", Value::array(clips));
}
/// `captureMovieclip`'s `prune`: a clip made inside a movieclip retains the scene the outer clip retains (a chain of `movieclipSource`
/// documents), cut down to the figures the new clip holds: their poses, effect clips and imported animation.
fn prune_retained(document: &mut Value, selected: &HashSet<u32>, layers: &HashSet<String>) {
    let Some(document) = document.make_obj() else { return };
    if let Some(frames) = document.get("keyframes") {
        let frames = items(Some(frames)).iter().map(|frame| filtered_frame(frame, selected)).collect();
        document.set("keyframes", Value::array(frames));
    }
    let Some(styk) = document.get_mut("_styk").and_then(Value::make_obj) else { return };
    if let Some(vfx) = styk.get_mut("vfxClips").filter(|v| v.truthy()).and_then(Value::make_obj) {
        keep_vfx_clips(vfx, selected);
    }
    if let Some(sources) = styk.get_mut("frameSources").filter(|v| v.truthy()).and_then(Value::make_obj) {
        let filtered: Vec<(String, Value)> = sources.iter().map(|(id, frame)| (id.to_string(), filtered_frame(frame, selected))).collect();
        for (id, frame) in filtered {
            sources.set(&id, frame);
        }
    }
    if let Some(animation) = styk.get_mut("animation").filter(|v| v.truthy()).and_then(Value::make_obj) {
        keep_channels(animation, selected, layers);
    }
    if let Some(retained) = styk.get_mut("movieclipSource").filter(|v| v.truthy()).and_then(Value::make_obj).and_then(|source| source.get_mut("document")) {
        prune_retained(retained, selected, layers);
    }
}

pub(crate) fn materialize_error(error: styk_eval::records::Error) -> EditError {
    match error {
        styk_eval::records::Error::Unported(reason) => EditError::Unported(reason),
        styk_eval::records::Error::Invalid(reason) => EditError::Invalid(reason),
    }
}

impl Editor {
    pub(crate) fn add_sheet_movieclip_figure(&mut self, type_id: Option<&Value>, worker: &mut crate::movieclip_planning::TimelineWorker<'_>) -> Result<Value, EditError> {
        let figures = items(self.report.get("figure_types"));
        let wanted = type_id.cloned().or_else(|| figures.first().and_then(|figure| figure.get("figure_type_id").cloned()));
        let Some(definition) = figures.iter().find(|figure| figure.get("figure_type_id") == wanted.as_ref()) else {
            return Err(EditError::Invalid("errors.editor.chooseAFigureFromTheLibrary".into()));
        };
        if !definition.path(&["_styk", "movieclip"]).is_some_and(Value::truthy) {
            return Err(EditError::Unported("worker movieclip insertion of an ordinary figure".into()));
        }
        self.add_movieclip_range(definition.get("figure_type_id").unwrap(), Some(worker))?;
        Ok(self.object()?.map(|(_, object)| object).unwrap_or(Value::Null))
    }

    /// `addMovieclipToNextKeyframes` on sheets: only existing non-patch
    /// boundaries are considered, and an already present instance is skipped.
    pub(crate) fn extend_sheet_movieclip(&mut self, count: f64, worker: &mut crate::movieclip_planning::TimelineWorker<'_>) -> Result<Value, EditError> {
        let (_, instance, _) = self.selected_movieclip()?;
        if !count.is_finite() || count.fract() != 0.0 || !(1.0..=9_007_199_254_740_991.0).contains(&count) {
            return Err(error("enterAPositiveWholeNumberOfKeyframes"));
        }
        let selected = uid(&instance).unwrap();
        let id = self.layer_of(selected);
        if self.track_locked(&id) {
            return Err(error("unlockTheMovieclipLayerBeforeEditingIt"));
        }
        (worker.check)()?;
        let mut plan = self.planner(std::slice::from_ref(&id))?;
        let keys = plan.keys(&id).into_iter().filter(|key| !key.get("patchOnly").is_some_and(Value::truthy) && num(key, "tick").is_some_and(|tick| tick > self.tick && tick < plan.end(&id))).take(count as usize).collect::<Vec<_>>();
        let shown = self.shown_frame()?;
        let steps = crate::sheet::continuations(&shown).into_iter().filter(|step| num(step, "uid") == Some(selected as f64)).collect::<Vec<_>>();
        let source = self.owned_frame(&shown, &[selected], &steps)?;
        let order_index = frame_order(shown.as_obj().unwrap()).into_iter().filter(|u| self.layer_of(*u as u32) == id).position(|u| u == selected as f64).map_or(-1.0, |i| i as f64);
        let mut added = 0;
        for key in keys {
            (worker.check)()?;
            let tick = num(&key, "tick").unwrap();
            if objects_of(&self.evaluated(tick, false)?).iter().any(|object| uid(object) == Some(selected)) { continue; }
            let current = plan.keys(&id);
            let index = current.iter().position(|candidate| candidate.get("id") == key.get("id")).unwrap();
            let end = current.get(index + 1).and_then(|key| num(key, "tick")).unwrap_or_else(|| plan.end(&id));
            self.replace_at(&mut plan, &id, tick, selected, &source, Some(("orderIndex", Value::Num(order_index))), end)?;
            added += 1;
        }
        if added > 0 { worker.publish_plan(self, plan, "Add movieclip to next keyframes")?; }
        Ok(Value::Num(added as f64))
    }

    pub(crate) fn movieclip_batch<T>(&mut self, label: &str, operation: impl FnOnce(&mut Editor) -> Result<T, EditError>) -> Result<T, EditError> {
        self.begin_batch(label)?;
        match operation(self) {
            Ok(value) => {
                self.end_batch()?;
                Ok(value)
            }
            Err(error) => {
                self.abort_batch()?;
                Err(error)
            }
        }
    }
    pub(crate) fn create_empty_movieclip(&mut self, name: &Value) -> Result<Value, EditError> {
        let name = if name.is_null() { Value::str("Movieclip") } else { name.clone() };
        let frame = create_frame(&[]).as_obj().cloned().unwrap();
        let document = object(&[
            ("version", Value::Num(5.0)),
            ("canvas_width", self.report.get("canvas_width").cloned().unwrap_or(Value::Null)),
            ("canvas_height", self.report.get("canvas_height").cloned().unwrap_or(Value::Null)),
            ("fps", self.report.get("fps").cloned().unwrap_or(Value::Null)),
            ("auto_easing", Value::Bool(false)),
            ("auto_easing_disabled_raw", Value::Num(1.0)),
            ("auto_easing_source", Value::str("file")),
            ("backgrounds", Value::array(vec![])),
            ("figure_types", Value::array(vec![])),
            ("keyframes", Value::array(vec![Value::object(frame)])),
            ("_styk", object(&[("format", Value::str("StykAnimate")), ("format_version", Value::Num(1.0)), ("name", Value::str("Untitled animation"))])),
        ]);
        let pivot = object(&[("x", Value::Num(num(&self.report, "canvas_width").unwrap_or(0.0) / 2.0)), ("y", Value::Num(num(&self.report, "canvas_height").unwrap_or(0.0) / 2.0))]);
        let figure = movieclip_figure(allocate_type(&self.report), name, document, 1.0, pivot);
        self.publish_definition(items(self.report.get("figure_types")).len(), figure.clone(), "Create movieclip")?;
        Ok(figure)
    }
    pub(crate) fn make_movieclip_unique(&mut self) -> Result<Value, EditError> {
        let (_, original, definition) = self.selected_movieclip()?;
        if !self.sheet() {
            return self.make_native_movieclip_unique(definition);
        }
        let tick = (self.tick + 0.5).floor();
        let previous = uid(&original).unwrap();
        let identity = self.next_uid as u32;
        if self.next_uid > 0x7fff_fffe {
            return Err(EditError::Invalid("errors.editorLayerSheet.objectIdentityCapacityReached".into()));
        }
        let mut figure = definition.as_obj().cloned().unwrap();
        figure.set("figure_type_id", Value::Num(allocate_type(&self.report)));
        figure.set("name", Value::str(&format!("{} copy", definition.get("name").and_then(Value::as_str).unwrap_or(""))));
        let figure = Value::object(figure);
        let shown = self.shown_frame()?;
        let mut frame = styk_eval::records::snapshot_pose_frame_of(&shown, Some(&[previous as f64])).as_obj().cloned().unwrap();
        let sampled = original
            .get("_movieclipSample")
            .filter(|v| !v.is_null())
            .cloned()
            .or_else(|| {
                self.evaluated(tick, true).ok().and_then(|f| objects_of(&f).into_iter().find(|o| uid(o) == Some(previous))).and_then(|o| o.get("_movieclipSample").filter(|v| !v.is_null()).cloned())
            })
            .or_else(|| original.path(&["_stykMovieclip", "offset"]).cloned())
            .unwrap_or(Value::Num(0.0));
        if let Some(objects) = frame.get_mut("objects").and_then(Value::make_arr) {
            for o in objects {
                let mut out = o.as_obj().cloned().unwrap();
                if uid(o) == Some(previous) {
                    out.set("unique_id", Value::Num(identity as f64));
                    out.set("figure_type_id", figure.get("figure_type_id").cloned().unwrap());
                    out.set(
                        "_stykMovieclip",
                        presence(&object(&[
                            ("mode", o.path(&["_stykMovieclip", "mode"]).cloned().unwrap_or(Value::str("loop"))),
                            ("speed", o.path(&["_stykMovieclip", "speed"]).cloned().unwrap_or(Value::Num(1.0))),
                            ("offset", sampled.clone()),
                        ])),
                    );
                }
                if let Some(join) = out.get_mut("join").and_then(Value::make_obj) {
                    if join.get("target_unique_id").and_then(Value::as_f64) == Some(previous as f64) {
                        join.set("target_unique_id", Value::Num(identity as f64));
                    }
                }
                *o = Value::object(out);
            }
        }
        let order = frame_order(&frame).into_iter().map(|u| if u == previous as f64 { identity as f64 } else { u }).collect::<Vec<_>>();
        set_order(&mut frame, &order);
        normalize_frame(&mut frame);
        let steps = if uses_presence(&original) {
            vec![object(&[("uid", Value::Num(previous as f64)), ("typeId", original.get("figure_type_id").cloned().unwrap()), ("playback", original.get("_stykMovieclip").cloned().unwrap())])]
        } else {
            vec![]
        };
        set_continuations(&mut frame, steps);
        self.movieclip_batch("Make movieclip unique", |editor| {
            editor.next_uid += 1;
            editor.publish_definition(items(editor.report.get("figure_types")).len(), figure.clone(), "Create movieclip")?;
            let id = editor.layer_of(previous);
            let mut plan = editor.planner(std::slice::from_ref(&id))?;
            plan.assign(identity, &id);
            editor.replace_at(&mut plan, &id, tick, previous, &Value::object(frame), Some(("replacementUid", Value::Num(identity as f64))), tick + 1.0)?;
            editor.publish(plan, "Make movieclip unique", editor.selection_state(), None)?;
            editor.seek(tick)?;
            editor.select(Some(identity), -1, false, false)?;
            Ok(figure)
        })
    }
    pub(crate) fn create_movieclip(&mut self, options: &Value) -> Result<Value, EditError> {
        if self.drag.is_some() {
            self.commit_drag()?;
        }
        let start = num(options, "start").unwrap_or(self.tick);
        let end = num(options, "end").unwrap_or(start + 1.0);
        let total = crate::timeline::total_ticks(&crate::timeline::rows(&self.report));
        if start.fract() != 0.0 || end.fract() != 0.0 || start < 0.0 || end <= start || end > total.max(start + 1.0) {
            return Err(error("chooseAValidMovieclipRange"));
        }
        let mut selected_ids = if options.get("uids").is_none() { self.selection.uids.clone() } else { items(options.get("uids")).iter().filter_map(Value::as_f64).map(|u| u as u32).collect() };
        let mut selected = HashSet::new();
        selected_ids.retain(|u| selected.insert(*u));
        if selected_ids.is_empty() {
            for f in items(self.report.get("keyframes")) {
                for u in objects_of(&f).iter().filter_map(uid) {
                    if selected.insert(u) {
                        selected_ids.push(u);
                    }
                }
            }
            for t in start as u32..end as u32 {
                for u in objects_of(&self.evaluated(t as f64, false)?).iter().filter_map(uid) {
                    if selected.insert(u) {
                        selected_ids.push(u);
                    }
                }
            }
        }
        if selected.is_empty() {
            return Err(error("selectFiguresToCreateAMovieclip"));
        }
        let frames = items(self.report.get("keyframes"));
        let sources = self.report.path(&["_styk", "frameSources"]).and_then(Value::as_obj).map(|s| s.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<Vec<_>>()).unwrap_or_default();
        let mut neighbors: HashMap<u32, Vec<u32>> = HashMap::new();
        for f in frames.iter().chain(sources.iter().map(|(_, f)| f)) {
            let objects = objects_of(f);
            for o in &objects {
                if let Some(parent) = o.path(&["join", "target_object_slot"]).and_then(Value::as_f64).and_then(|s| objects.get(s as usize)).and_then(uid) {
                    let child = uid(o).unwrap_or(0);
                    for (a, b) in [(child, parent), (parent, child)] {
                        let neighbors = neighbors.entry(a).or_default();
                        if !neighbors.contains(&b) {
                            neighbors.push(b);
                        }
                    }
                }
            }
        }
        let mut index = 0;
        while index < selected_ids.len() {
            for u in neighbors.get(&selected_ids[index]).into_iter().flatten() {
                if selected.insert(*u) {
                    selected_ids.push(*u);
                }
            }
            index += 1;
        }
        let selected_layers: HashSet<String> = selected.iter().map(|u| self.layer_of(*u)).collect();
        let filtered = frames.iter().map(|f| filtered_frame(f, &selected)).collect::<Vec<_>>();
        let mut source_table = Obj::new();
        for (k, f) in &sources {
            source_table.set(k, filtered_frame(f, &selected));
        }
        let used_types: HashSet<u32> = filtered.iter().chain(source_table.iter().map(|(_, f)| f)).flat_map(objects_of).filter_map(|o| num(&o, "figure_type_id").map(|n| n as u32)).collect();
        let mut figures = items(self.report.get("figure_types")).into_iter().filter(|f| num(f, "figure_type_id").is_some_and(|n| used_types.contains(&(n as u32)))).collect::<Vec<_>>();
        // Captured drawings become the clip's own cels, as copied keys do: sharing the project's cel identities would show and
        // edit the project's pixels. They are the published pixels the definitions carry.
        for figure in figures.iter_mut() {
            if figure.path(&["_styk", "drawing"]).is_some_and(|d| !d.is_null()) {
                let cel = format!("cel-{}", self.draw_uuid()?);
                if let Some(drawing) = figure.make_obj().and_then(|f| f.get_mut("_styk")).and_then(Value::make_obj).and_then(|styk| styk.get_mut("drawing")).and_then(Value::make_obj) {
                    drawing.set("celId", Value::str(&cel));
                }
            }
        }
        let mut metadata = self.report.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        let mut animation = metadata.get("animation").and_then(Value::as_obj).cloned().unwrap_or_default();
        animation.set("version", Value::Num(1.0));
        if animation.get("nextKeyId").is_none() {
            animation.set("nextKeyId", Value::Num(1.0));
        }
        keep_channels(&mut animation, &selected, &selected_layers);
        metadata.set("animation", Value::object(animation));
        metadata.set("frameSources", Value::object(source_table));
        metadata.remove("simpleFrameDraft");
        // What the clip it is made in retains is cut down to its figures too.
        if let Some(retained) = metadata.get_mut("movieclipSource").and_then(Value::make_obj).and_then(|source| source.get_mut("document")) {
            prune_retained(retained, &selected, &selected_layers);
        }
        if let Some(layers) = metadata.get_mut("layers").and_then(Value::make_obj) {
            if let Some(assignments) = layers.get_mut("assignments").and_then(Value::make_obj) {
                let removed = assignments.iter().filter(|(u, _)| u.parse::<u32>().ok().is_none_or(|u| !selected.contains(&u))).map(|(u, _)| u.to_string()).collect::<Vec<_>>();
                for u in removed {
                    assignments.remove(&u);
                }
            }
        }
        if let Some(vfx) = metadata.get_mut("vfxClips").and_then(Value::make_obj) {
            keep_vfx_clips(vfx, &selected);
        }
        let mut source = self.report.as_obj().cloned().unwrap();
        source.set("figure_types", Value::array(figures));
        source.set("keyframes", Value::array(filtered));
        source.set("backgrounds", Value::array(vec![]));
        source.set("_styk", Value::object(metadata.clone()));
        let mut ticks = vec![start, end - 1.0];
        for row in crate::timeline::rows(&self.report) {
            if row.start > start && row.start < end {
                ticks.push(row.start);
            }
        }
        for (_, track) in metadata.get("layerSheet").and_then(Value::as_obj).and_then(|s| s.get("tracks")).and_then(Value::as_obj).map(|o| o.iter().collect::<Vec<_>>()).unwrap_or_default() {
            for k in items(track.get("keys")) {
                if let Some(t) = num(&k, "tick").filter(|t| *t > start && *t < end) {
                    ticks.push(t);
                }
            }
        }
        ticks.sort_by(f64::total_cmp);
        ticks.dedup();
        let mut local = vec![];
        for (i, t) in ticks.iter().enumerate() {
            let mut frame = filtered_frame(&self.evaluated(*t, false)?, &selected).as_obj().cloned().unwrap();
            if let Some(objects) = frame.get_mut("objects").and_then(Value::make_arr) {
                for o in objects {
                    if uses_presence(o) {
                        let figure = items(self.report.get("figure_types")).into_iter().find(|f| f.get("figure_type_id") == o.get("figure_type_id")).unwrap();
                        let elapsed = self.prepared()?.presence_elapsed(uid(o).unwrap(), start);
                        let offset = o.path(&["_stykMovieclip", "offset"]).and_then(Value::as_f64).unwrap_or(0.0)
                            + elapsed * figure.path(&["_styk", "movieclip", "document", "fps"]).and_then(Value::as_f64).unwrap_or(24.0) / num(&self.report, "fps").unwrap_or(24.0);
                        o.make_obj().unwrap().get_mut("_stykMovieclip").unwrap().make_obj().unwrap().set("offset", Value::Num(offset));
                    }
                }
            }
            frame.set("duration_raw", Value::Num(ticks.get(i + 1).copied().unwrap_or(end) - t));
            let mut styk = Obj::new();
            if let Some(easing) = frame.get("_styk").and_then(|styk| styk.get("easing")) {
                styk.set("easing", easing.clone());
            }
            styk.set("movieclipSourceTick", Value::Num(*t));
            let steps = crate::sheet::continuations(&Value::object(frame.clone()));
            if !steps.is_empty() {
                styk.set("movieclipContinuations", Value::array(steps));
            }
            frame.set("_styk", Value::object(styk));
            local.push(Value::object(frame));
        }
        let first = self.evaluated(start, false)?;
        let first_objects = objects_of(&first);
        let root = first_objects
            .iter()
            .find(|o| uid(o).is_some_and(|u| selected.contains(&u)) && !o.get("join").is_some_and(Value::truthy))
            .or_else(|| first_objects.iter().find(|o| uid(o).is_some_and(|u| selected.contains(&u))));
        let pivot = if let Some(root) = root {
            let prepared = self.prepared()?;
            let frame = self.eval.borrow_mut().loader.edit_frame(&first, None, &prepared.doc).map_err(|e| EditError::Invalid(e.to_string()))?;
            let geometry = styk_eval::geometry::build(&prepared.doc, &frame);
            let xy = geometry.objects.get(num(root, "object_slot").unwrap_or(0.0) as usize).map(|g| g.root).unwrap_or([0.0; 2]);
            object(&[("x", Value::Num(xy[0])), ("y", Value::Num(xy[1]))])
        } else {
            object(&[("x", Value::Num(0.0)), ("y", Value::Num(0.0))])
        };
        let name = options.get("name").cloned().unwrap_or(Value::str("Movieclip"));
        let mut retained = source.clone();
        retained.set("figure_types", Value::array(vec![]));
        let mut doc = source;
        doc.set("keyframes", Value::array(local.clone()));
        let mut styk = object(&[("format", Value::str("StykAnimate")), ("format_version", Value::Num(1.0)), ("name", name.clone())]).as_obj().cloned().unwrap();
        if let Some(layers) = metadata.get("layers") {
            styk.set("layers", layers.clone());
        }
        styk.set("movieclipSource", object(&[("document", Value::object(retained)), ("inheritFigures", Value::Bool(true))]));
        doc.set("_styk", Value::object(styk));
        let mut doc = Value::object(doc);
        // The clip of a drawing layer gets drawing keys of its own.
        let drawing_layers = metadata.get("layers").and_then(|layers| layers.get("byId")).and_then(Value::as_obj).is_some_and(|layers| layers.iter().any(|(_, layer)| layer.path(&["drawing", "version"]).and_then(Value::as_f64) == Some(1.0)));
        if drawing_layers {
            clip_drawing_keys(&mut doc, &local)?;
        }
        let figure = movieclip_figure(allocate_type(&self.report), name, doc, end - start, pivot);
        if options.get("replace").and_then(Value::as_bool) == Some(false) {
            return self.movieclip_batch("Create movieclip", |editor| {
                editor.publish_definition(items(editor.report.get("figure_types")).len(), figure.clone(), "Create movieclip")?;
                Ok(figure)
            });
        }
        let actual_end = if options.get("end").is_none() { crate::timeline::rows(&self.report).into_iter().find(|r| r.start > start).map_or(total, |r| r.start) } else { end };
        self.validate_movieclip_order(&selected, start, end)?;
        let order = frame_order(first.as_obj().unwrap());
        let anchor = order.iter().find(|u| selected.contains(&(**u as u32))).copied().map(|u| u as u32).unwrap_or_else(|| selected_ids[0]);
        if !self.sheet() {
            return self.create_native_movieclip_replacement(figure, &selected_ids, start, actual_end, anchor);
        }
        let identity = self.next_uid as u32;
        if self.next_uid > 0x7fff_fffe {
            return Err(EditError::Invalid("errors.editorLayerSheet.objectIdentityCapacityReached".into()));
        }
        let asset = figure.path(&["_styk", "movieclip"]).unwrap();
        let pivot = asset.get("pivot").unwrap();
        let mut instance = create_object(&figure, identity, num(pivot, "x").unwrap(), num(pivot, "y").unwrap()).as_obj().cloned().unwrap();
        instance.set("_stykMovieclip", presence(&Value::Null));
        let instance = Value::object(instance);
        self.movieclip_batch("Create movieclip", |editor| {
            editor.publish_definition(items(editor.report.get("figure_types")).len(), figure.clone(), "Create movieclip")?;
            editor.next_uid += 1;
            let ids = selected_ids.iter().map(|u| editor.layer_of(*u)).fold(vec![], |mut ids: Vec<String>, id| {
                if !ids.contains(&id) {
                    ids.push(id);
                }
                ids
            });
            let mut plan = editor.planner(&ids)?;
            let mut owner = editor.layer_of(anchor);
            // Drawing layers hold only drawing cels: a clip made of drawings alone gets its own figure layer directly above the anchor drawing layer.
            let own_layer = plan.layers.path(&["byId", &owner, "drawing", "version"]).and_then(Value::as_f64) == Some(1.0);
            if own_layer {
                owner = clip_layer(&mut plan.layers, &owner, figure.get("name"));
            }
            plan.assign(identity, &owner);
            if own_layer {
                let blank = crate::sheet::Write { blank: true, ..crate::sheet::Write::default() };
                if start > 0.0 {
                    plan.write(&owner, 0.0, &create_frame(&[]), blank)?;
                }
                plan.write(&owner, start, &create_frame(std::slice::from_ref(&instance)), crate::sheet::Write::default())?;
                if actual_end < plan.duration {
                    plan.write(&owner, actual_end, &create_frame(&[]), blank)?;
                }
            }
            let mut captures = HashMap::new();
            for id in ids {
                let uids = selected_ids.iter().filter(|u| editor.layer_of(**u) == id).copied().collect::<Vec<_>>();
                if id == owner && actual_end > plan.end(&id) {
                    let old_end = plan.end(&id);
                    plan.write(&id, old_end, &create_frame(&[]), crate::sheet::Write { blank: true, ..crate::sheet::Write::default() })?;
                    plan.set_end(&id, actual_end);
                }
                let mut times = vec![start];
                times.extend(plan.keys(&id).iter().filter_map(|k| num(k, "tick")).filter(|t| *t > start && *t < actual_end));
                for (i, t) in times.iter().enumerate() {
                    if *t >= plan.end(&id) {
                        continue;
                    }
                    let original = editor.evaluated(*t, false)?;
                    for u in &uids {
                        let mut frame = create_frame(if *u == anchor && !own_layer { std::slice::from_ref(&instance) } else { &[] }).as_obj().cloned().unwrap();
                        let original_object = objects_of(&original).into_iter().find(|o| uid(o) == Some(*u));
                        let step = original_object
                            .as_ref()
                            .filter(|o| uses_presence(o))
                            .map(|o| object(&[("uid", Value::Num(*u as f64)), ("typeId", o.get("figure_type_id").cloned().unwrap()), ("playback", o.get("_stykMovieclip").cloned().unwrap())]))
                            .or_else(|| crate::sheet::continuations(&original).into_iter().find(|s| num(s, "uid") == Some(*u as f64)));
                        if let Some(step) = step {
                            set_continuations(&mut frame, vec![step]);
                        }
                        let frame = Value::object(frame);
                        let signature = styk_doc::json::to_string(&Value::array(vec![Value::str(&id), frame.clone()]));
                        let frame_id = captures.entry(signature).or_insert_with(|| plan.capture(&frame, &id).get("frameId").cloned().unwrap()).clone();
                        let until = times.get(i + 1).copied().unwrap_or(actual_end).min(plan.end(&id));
                        editor.replace_at(&mut plan, &id, *t, *u, &frame, Some(("frameId", frame_id)), until)?;
                    }
                }
            }
            editor.publish(plan, "Create movieclip", editor.selection_state(), None)?;
            editor.seek(start)?;
            editor.select(Some(identity), -1, false, false)?;
            Ok(figure)
        })
    }
    pub(crate) fn break_apart_movieclip(&mut self) -> Result<Value, EditError> {
        self.break_apart_movieclip_with(None)
    }

    /// `_expandMovieclipPose`: the SAME geometry and materializer owners are
    /// shared by one-frame break and the awaited worker bake.
    pub(crate) fn expand_movieclip_pose(&self, frame: &Value, previous: u32, materializer: &mut styk_eval::materialize::Materializer<'_>) -> Result<Value, EditError> {
        let source = if let Some(selected) = objects_of(frame).into_iter().find(|object| uid(object) == Some(previous)) {
            let scene = self.record_geometry(frame)?;
            let root = scene.objects.iter().find(|object| object.slot as f64 == num(&selected, "object_slot").unwrap()).map(|object| object.root).unwrap_or([num(&selected, "root_x").unwrap_or(0.0), num(&selected, "root_y").unwrap_or(0.0)]);
            let mut selected = selected.as_obj().cloned().unwrap();
            selected.set("join", Value::Null);
            selected.set("root_x", Value::Num(root[0]));
            selected.set("root_y", Value::Num(root[1]));
            create_frame(&[Value::object(selected)])
        } else { return Ok(create_frame(&[])); };
        materializer.frame(&source).map_err(materialize_error)
    }

    pub(crate) fn break_apart_movieclip_with(&mut self, worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>) -> Result<Value, EditError> {
        let (_, original, _) = self.selected_movieclip()?;
        // A clip on the document's own clock is first given the presence clock, which samples the layer.
        if worker.is_none() && self.sheet() && !uses_presence(&original) {
            return self.inline_timeline(|editor, worker| editor.break_apart_movieclip_with(Some(worker)));
        }
        let tick = (self.tick + 0.5).floor();
        let previous = uid(&original).unwrap();
        let shown = self.shown_frame()?;
        let report = self.report.clone();
        let prepared = self.prepared()?;
        let mut materializer = styk_eval::materialize::Materializer::new(&report, &prepared).map_err(materialize_error)?;
        let source = self.expand_movieclip_pose(&shown, previous, &mut materializer)?;
        let definitions = materializer.figures().to_vec();
        let paths: HashMap<u32, String> = materializer.identities().map(|(path, uid)| (uid, path.into())).collect();
        self.publish_movieclip_expansion_with(vec![(tick, source)], previous, (tick, tick + 1.0), definitions, paths, "Break apart frame", true, &original, worker)
    }

    /// SAME replacement Plan and publication owner for break and worker bake.
    pub(crate) fn publish_movieclip_expansion_with(
        &mut self, mut frames: Vec<(f64, Value)>, previous: u32, bounds: (f64, f64),
        definitions: Vec<Value>, paths: HashMap<u32, String>, label: &str, reuse_parts: bool,
        original: &Value, mut worker: Option<&mut crate::movieclip_planning::TimelineWorker<'_>>,
    ) -> Result<Value, EditError> {
        if !self.sheet() {
            return self.publish_native_movieclip_expansions(frames, previous, bounds, definitions, paths, label, reuse_parts, worker);
        }
        let start = bounds.0;
        let prepare = !uses_presence(&original) && self.batch.is_none();
        self.movieclip_batch(label, |editor| {
            if prepare { worker.as_deref_mut().unwrap().prepare(editor)?; }
            let mut parts = HashMap::new();
            for channel in items(editor.report.path(&["_styk", "layerSheet", "legacyAnimation", "channels"])) {
                if reuse_parts && channel.get("property").and_then(Value::as_str) == Some("pose") && channel.path(&["movieclipPart", "instance"]).and_then(Value::as_f64) == Some(previous as f64) {
                    if let (Some(path), Some(uid)) = (channel.path(&["movieclipPart", "path"]).and_then(Value::as_str), channel.path(&["target", "uid"]).and_then(Value::as_f64)) {
                        parts.insert(path.to_string(), uid as u32);
                    }
                }
            }
            if let Some(sources) = editor.report.path(&["_styk", "frameSources"]).and_then(Value::as_obj) {
                for (_, frame) in sources.iter() {
                    for object in objects_of(frame) {
                        if reuse_parts && object.path(&["_stykMovieclipPart", "instance"]).and_then(Value::as_f64) == Some(previous as f64) {
                            if let (Some(path), Some(uid)) = (object.path(&["_stykMovieclipPart", "path"]).and_then(Value::as_str), uid(&object)) {
                                parts.entry(path.to_string()).or_insert(uid);
                            }
                        }
                    }
                }
            }
            let mut existing: HashSet<u32> = items(editor.report.get("figure_types")).iter().filter_map(|f| num(f, "figure_type_id").map(|u| u as u32)).collect();
            for figure in definitions {
                let id = num(&figure, "figure_type_id").unwrap() as u32;
                if existing.insert(id) {
                    editor.publish_definition(items(editor.report.get("figure_types")).len(), figure, "Create movieclip")?;
                }
            }
            let mut ids = Vec::new();
            let mut mapping = HashMap::new();
            for object in frames.iter().flat_map(|(_, frame)| objects_of(frame)) {
                let old = uid(&object).unwrap();
                if mapping.contains_key(&old) {
                    continue;
                }
                let path = paths.get(&old).cloned().unwrap_or_default();
                let id = if let Some(id) = parts.get(&path) {
                    *id
                } else {
                    if editor.next_uid > 0x7fff_fffe {
                        return Err(EditError::Invalid("errors.editorLayerSheet.objectIdentityCapacityReached".into()));
                    }
                    let id = editor.next_uid as u32;
                    editor.next_uid += 1;
                    id
                };
                mapping.insert(old, (id, path));
                ids.push(id);
            }
            for (_, source) in &mut frames {
                let mut frame = source.as_obj().cloned().unwrap();
                let order = frame_order(&frame).iter().filter_map(|old| mapping.get(&(*old as u32)).map(|(id, _)| *id as f64)).collect::<Vec<_>>();
                if let Some(objects) = frame.get_mut("objects").and_then(Value::make_arr) {
                    for object in objects {
                        let (id, path) = mapping.get(&uid(object).unwrap()).unwrap();
                        let object = object.make_obj().unwrap();
                        object.set("unique_id", Value::Num(*id as f64));
                        if reuse_parts { object.set("_stykMovieclipPart", crate::movieclip_commands::object(&[("instance", Value::Num(previous as f64)), ("path", Value::str(path))])); }
                    }
                }
                set_order(&mut frame, &order);
                normalize_frame(&mut frame);
                *source = Value::object(frame);
            }
            let layer = editor.layer_of(previous);
            let mut plan = editor.planner(std::slice::from_ref(&layer))?;
            for id in &ids { plan.assign(*id, &layer); }
            let mut replaced = false;
            for (tick, source) in frames {
                if let Some(worker) = worker.as_deref_mut() { (worker.check)()?; }
                let mut frame = source.as_obj().cloned().unwrap();
                let at = editor.evaluated(tick, true)?;
                let original = objects_of(&at).into_iter().find(|o| uid(o) == Some(previous));
                if let Some(original) = original {
                    let steps = if uses_presence(&original) {
                        vec![object(&[("uid", Value::Num(previous as f64)), ("typeId", original.get("figure_type_id").cloned().unwrap()), ("playback", original.get("_stykMovieclip").cloned().unwrap())])]
                    } else {
                        vec![]
                    };
                    set_continuations(&mut frame, steps);
                    editor.replace_at(&mut plan, &layer, tick, previous, &Value::object(frame), None, tick + 1.0)?;
                    replaced = true;
                }
            }
            if replaced {
                if let Some(worker) = worker.as_deref_mut() { worker.publish_plan(editor, plan, label)?; }
                else { editor.publish(plan, label, editor.selection_state(), None)?; }
            }
            editor.seek(start)?;
            editor.select_many(&ids)?;
            Ok(Value::array(ids.into_iter().map(|id| Value::Num(id as f64)).collect()))
        })
    }
    fn validate_movieclip_order(&self, selected: &HashSet<u32>, start: f64, end: f64) -> Result<(), EditError> {
        if selected.len() < 2 {
            return Ok(());
        }
        let mut ticks = vec![start, end - 1.0];
        ticks.extend(crate::timeline::rows(&self.report).into_iter().map(|r| r.start).filter(|t| *t > start && *t < end));
        for tick in ticks {
            let frame = self.evaluated(tick, false)?;
            let order = frame_order(frame.as_obj().unwrap());
            let positions = order.iter().enumerate().filter(|(_, u)| selected.contains(&(**u as u32))).map(|(i, _)| i).collect::<Vec<_>>();
            if positions.first().zip(positions.last()).is_some_and(|(a, b)| b - a + 1 != positions.len()) {
                return Err(crate::invalid_with("errors.editorMovieclips.selectedFiguresCrossOtherFiguresInTheStacking", vec![("value", Value::Num(tick + 1.0))]));
            }
        }
        Ok(())
    }
}
