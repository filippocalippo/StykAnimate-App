//! Selection and the playhead (`select`, `selectMany`, `seek`, `_selectionState`,
//! `_restoreSelection`), and the timeline's layer selection (`selectSheetLayer`,
//! `_followSheetSelection`, `keepSelectionOnSeek`, `setActiveLayer`).

use styk_doc::Value;

use crate::record::{join_target, uid};
use crate::timeline::{rows, total_ticks};
use crate::{EditError, Editor};

#[cfg(test)]
#[path = "selection_metadata_tests.rs"]
mod tests;

/// The selected figures and joint.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Selection {
    pub uid: Option<u32>,
    /// Selected figures in selection order (a JavaScript `Set`).
    pub uids: Vec<u32>,
    pub joint: i64,
}

/// `_selectionState()`: what a history entry restores.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct SelectionState {
    pub frame_index: usize,
    pub tick: f64,
    pub selection: Selection,
    /// `editor.activeLayerId`.
    pub active_layer: String,
    /// `editor._sheetSelection`.
    pub sheet: Option<SheetSelection>,
    pub polygon: Option<Value>,
    pub segment_ids: Option<Vec<Value>>,
    pub branch: Option<Value>,
}

/// The editor's `_polygonSelection`, `_segmentSelection` and `_branchSelection`.
/// Invalidated metadata can remain hidden until another selection makes it valid,
/// as in the JavaScript getters; history stores only the currently visible fields.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct SelectionMetadata {
    pub polygon: Option<Value>,
    pub segments: Option<SegmentSelection>,
    pub branch: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SegmentSelection {
    pub uid: Option<u32>,
    pub active: Option<Value>,
    pub ids: Vec<Value>,
}

/// `editor._sheetSelection`: a layer chosen on the timeline, and whether the selection
/// follows its figures as the playhead moves.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct SheetSelection {
    pub id: String,
    pub contents: bool,
}

impl SelectionState {
    /// The enumerable `_selectionState` retained by a command. Worker-only
    /// history sizing shares this owner rather than reconstructing view flags.
    pub(crate) fn history_value(&self) -> Value {
        let mut value = styk_doc::Obj::new();
        value.set("frameIndex", Value::Num(self.frame_index as f64));
        value.set("tick", Value::Num(self.tick));
        value.set("uid", self.selection.uid.map_or(Value::Null, |uid| Value::Num(uid as f64)));
        value.set("uids", Value::array(self.selection.uids.iter().map(|&uid| Value::Num(uid as f64)).collect()));
        value.set("joint", Value::Num(self.selection.joint as f64));
        value.set("activeLayerId", Value::str(&self.active_layer));
        let sheet = self.sheet.as_ref().map(|sheet| {
            let mut value = styk_doc::Obj::new();
            value.set("id", Value::str(&sheet.id));
            value.set("contents", Value::Bool(sheet.contents));
            Value::object(value)
        }).unwrap_or(Value::Null);
        value.set("sheetSelection", sheet);
        self.write_metadata(&mut value);
        Value::object(value)
    }

    pub(crate) fn write_metadata(&self, value: &mut styk_doc::Obj) {
        if let Some(polygon) = &self.polygon { value.set("polygonSelection", polygon.clone()); }
        if let Some(ids) = &self.segment_ids { value.set("segmentIds", Value::array(ids.clone())); }
        if let Some(branch) = &self.branch { value.set("branch", branch.clone()); }
    }
}

impl Editor {
    fn selection_figure(&self) -> Result<Option<Value>, EditError> {
        let Some((_, object)) = self.object()? else { return Ok(None) };
        Ok(self.report.get("figure_types").and_then(Value::elements).and_then(|figures| figures.iter().find(|figure| match (figure.get("figure_type_id"), object.get("figure_type_id")) {
            (Some(a), Some(b)) => crate::history::js_strict_eq(a, b), _ => false,
        })))
    }

    fn branch_selected(&self) -> bool {
        self.selection.joint >= 0 && self.selection_metadata.branch.as_ref().is_some_and(|branch|
            branch.get("uid").and_then(Value::as_f64) == self.selection.uid.map(|uid| uid as f64)
            && branch.get("joint").and_then(Value::as_f64) == Some(self.selection.joint as f64))
    }

    fn selected_polygon_index(&self, figure: Option<&Value>, polygon: &Value) -> Option<usize> {
        let figure = figure?;
        if self.selection.joint >= 0 || polygon.get("uid").and_then(Value::as_f64) != self.selection.uid.map(|uid| uid as f64)
            || !matches!((polygon.get("typeId"), figure.get("figure_type_id")), (Some(a), Some(b)) if crate::history::js_strict_eq(a,b)) { return None; }
        let polygons = figure.get("polyfills")?.elements()?;
        match polygon.get("id") {
            None => index(polygon.get("index")).filter(|&at| polygons.len() > at),
            Some(id) => polygons.iter().position(|polygon| polygon.get("polyfill_id").is_some_and(|other| crate::history::js_strict_eq(other, id))),
        }
    }

    fn selected_segment_ids(&self, figure: Option<&Value>) -> Vec<Value> {
        let Some(active) = figure.and_then(|figure| figure.get("segments")).and_then(|segments| usize::try_from(self.selection.joint).ok().and_then(|joint| segments.item(joint))).and_then(|segment| segment.get("segment_id").cloned()) else { return Vec::new() };
        match self.selection_metadata.segments.as_ref() {
            Some(selection) if selection.uid == self.selection.uid && selection.active.as_ref().is_some_and(|id| crate::history::js_strict_eq(id, &active)) => selection.ids.clone(),
            _ => vec![active],
        }
    }

    /// Optional `_selectionState` fields from a JSON view. Stable native handle
    /// IDs are filtered at the same owner as `_restoreSelection`; unknown fields
    /// on polygon and branch records remain untouched.
    pub fn set_selection_metadata(&mut self, value: &Value) -> Result<(), EditError> {
        let mut metadata = SelectionMetadata { polygon: value.get("polygonSelection").filter(|value| value.truthy()).cloned(), branch: value.get("branch").filter(|value| value.truthy()).cloned(), segments: None };
        if let Some(given) = value.get("segmentIds").and_then(Value::elements) {
            let figure = self.selection_figure()?;
            let segments: Vec<Value> = figure.as_ref().and_then(|figure| figure.get("segments")).and_then(Value::elements).map(|items| items.iter().collect()).unwrap_or_default();
            let active = usize::try_from(self.selection.joint).ok().and_then(|at| segments.get(at)).and_then(|segment| segment.get("segment_id")).cloned();
            let mut ids = Vec::new();
            for id in given.iter() {
                if segments.iter().any(|segment| segment.get("segment_id").is_some_and(|valid| crate::history::js_strict_eq(valid, &id)))
                    && !ids.iter().any(|previous| crate::history::js_strict_eq(previous, &id)) { ids.push(id); }
            }
            if ids.len() > 1 && active.as_ref().is_some_and(|active| ids.iter().any(|id| crate::history::js_strict_eq(id, active))) {
                metadata.segments = Some(SegmentSelection { uid: self.selection.uid, active, ids });
            }
        }
        self.selection_metadata = metadata;Ok(())
    }

    /// Views may repeat a canonical selection without replacing hidden metadata.
    /// A changed optional field uses the same filtering owner as restoration.
    pub(crate) fn sync_selection_metadata(&mut self, value: &Value) -> Result<(), EditError> {
        // No optional metadata is visible or hidden, and none was supplied.
        // Explicit null fields and stale hidden records still use the same
        // restoration/filtering owner below.
        if self.selection_metadata.polygon.is_none() && self.selection_metadata.segments.is_none() && self.selection_metadata.branch.is_none()
            && ["polygonSelection", "segmentIds", "branch"].iter().all(|key| value.get(key).is_none())
        {
            return Ok(());
        }
        let mut current = styk_doc::Obj::new();self.selection_state().write_metadata(&mut current);
        let mut given = styk_doc::Obj::new();
        for key in ["polygonSelection", "segmentIds", "branch"] { if let Some(value) = value.get(key) { given.set(key, value.clone()); } }
        if Value::object(current) != Value::object(given.clone()) {
            self.set_selection_metadata(&Value::object(given))?;
        }
        Ok(())
    }

    pub(crate) fn select_polygon(&mut self, selected: Option<u32>, at: Option<usize>) -> Result<bool, EditError> {
        let objects = self.selection_frame()?;
        let Some(object) = objects.iter().find(|object| uid(object) == selected) else { return Ok(false) };
        let figure = self.report.get("figure_types").and_then(Value::elements).and_then(|figures| figures.iter().find(|figure| figure.get("figure_type_id") == object.get("figure_type_id")));
        let Some((at, polygon, figure)) = figure.and_then(|figure| Some((at?, figure.get("polyfills")?.item(at?)?, figure))) else { return Ok(false) };
        self.origin_plain_targets(&[selected.unwrap()])?;
        let mut metadata = styk_doc::Obj::new();metadata.set("uid", Value::Num(selected.unwrap() as f64));metadata.set("index", Value::Num(at as f64));
        if let Some(id) = polygon.get("polyfill_id") { metadata.set("id", id.clone()); }
        metadata.set("typeId", figure.get("figure_type_id").cloned().unwrap_or(Value::Null));
        self.select(selected, -1, false, false)?;
        self.selection_metadata.polygon = Some(Value::object(metadata));self.emit("selection", vec![]);Ok(true)
    }

    pub(crate) fn toggle_segment(&mut self, selected: Option<u32>, joint: Option<usize>) -> Result<bool, EditError> {
        self.selection_metadata.polygon = None;
        let objects = self.selection_frame()?;
        let Some(object) = objects.iter().find(|object| uid(object) == selected) else { return Ok(false) };
        let figure = self.report.get("figure_types").and_then(Value::elements).and_then(|figures| figures.iter().find(|figure| figure.get("figure_type_id") == object.get("figure_type_id")));
        let Some(figure) = figure else { return Ok(false) };
        let Some(id) = joint.and_then(|joint| figure.get("segments")?.item(joint)).and_then(|segment| segment.get("segment_id").cloned()) else { return Ok(false) };
        self.origin_plain_targets(&[selected.unwrap()])?;
        let mut ids = if selected == self.selection.uid { self.selected_segment_ids(Some(&figure)) } else { Vec::new() };
        if let Some(at) = ids.iter().position(|other| crate::history::js_strict_eq(other, &id)) { ids.remove(at); } else { ids.push(id.clone()); }
        let active = ids.iter().find(|other| crate::history::js_strict_eq(other, &id)).cloned().or_else(|| ids.last().cloned());
        let joint = active.as_ref().and_then(|id| figure.get("segments")?.elements()?.iter().position(|segment| segment.get("segment_id").is_some_and(|other| crate::history::js_strict_eq(other, id)))).map_or(-1, |joint| joint as i64);
        self.selection = Selection { uid: selected, uids: selected.into_iter().collect(), joint };
        self.selection_metadata.branch = None;self.selection_metadata.segments = Some(SegmentSelection { uid: selected, active, ids });
        self.emit("selection", vec![]);Ok(true)
    }

    pub(crate) fn select_branch(&mut self, selected: Option<u32>, joint: Option<usize>) -> Result<bool, EditError> {
        self.selection_metadata.segments = None;
        let objects = self.selection_frame()?;
        let Some(slot) = objects.iter().position(|object| uid(object) == selected) else { return Ok(false) };
        let figure = self.report.get("figure_types").and_then(Value::elements).and_then(|figures| figures.iter().find(|figure| figure.get("figure_type_id") == objects[slot].get("figure_type_id")));
        let Some((joint, figure)) = figure.and_then(|figure| figure.get("segments")?.item(joint?).map(|_| (joint.unwrap(), figure))) else { return Ok(false) };
        self.origin_plain_targets(&[selected.unwrap()])?;
        let handles: Vec<Value> = crate::builder::branch(&figure, joint, true, false).indices.into_iter().filter_map(|at| figure.get("segments")?.item(at)?.get("segment_id").cloned()).collect();
        let mut children: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
        for (child, object) in objects.iter().enumerate() {
            let Some(target) = join_target(object) else { continue };
            if target == slot && !object.path(&["join", "target_handle_id"]).is_some_and(|id| handles.iter().any(|handle| crate::history::js_strict_eq(id, handle))) { continue; }
            children.entry(target).or_default().push(child);
        }
        let mut slots = std::collections::HashSet::from([slot]);let mut queue = vec![slot];let mut cursor = 0;
        while cursor < queue.len() { for &child in children.get(&queue[cursor]).map(Vec::as_slice).unwrap_or(&[]) { if slots.insert(child) { queue.push(child); } } cursor += 1; }
        let uids = objects.iter().enumerate().filter(|(slot, _)| slots.contains(slot)).filter_map(|(_, object)| uid(object)).collect();
        self.selection = Selection { uid: selected, uids, joint: joint as i64 };
        let mut branch = styk_doc::Obj::new();branch.set("uid", Value::Num(selected.unwrap() as f64));branch.set("joint", Value::Num(joint as f64));
        self.selection_metadata.branch = Some(Value::object(branch));self.emit("selection", vec![]);Ok(true)
    }

    pub(crate) fn selection_metadata_gate(&self, method: &str) -> Result<(), EditError> {
        if (self.selection_metadata.polygon.is_some() || self.selection_metadata.segments.as_ref().is_some_and(|selection| selection.ids.len() > 1) || self.branch_selected()) && !metadata_recorded_call(method) {
            return Err(EditError::Unported(format!("{method} with optional selection metadata")));
        }
        Ok(())
    }
    /// `select(uid, joint, {toggle, add})`.
    pub(crate) fn select(&mut self, uid: Option<u32>, joint: i64, toggle: bool, add: bool) -> Result<Value, EditError> {
        if self.branch_selected() && uid == self.selection.uid && joint == self.selection.joint && !toggle && !add {
            return Ok(self.object()?.map(|(_, o)| o).unwrap_or(Value::Null));
        }
        self.selection_metadata = SelectionMetadata::default();
        let frame = self.selection_frame()?;
        let valid = uid.filter(|&selected| frame.iter().any(|o| crate::record::uid(o) == Some(selected)));
        // On a layer sheet a selected figure makes its layer the active one.
        if let (Some(selected), true) = (valid, self.sheet()) {
            let layer = self.layer_of(selected);
            self.set_active_layer(&layer);
        }
        match valid {
            None => self.selection = Selection { uid: None, uids: Vec::new(), joint: -1 },
            Some(selected) if toggle || add => {
                if let Some(at) = self.selection.uids.iter().position(|&u| u == selected).filter(|_| toggle) {
                    self.selection.uids.remove(at);
                } else if !self.selection.uids.contains(&selected) {
                    self.selection.uids.push(selected);
                }
                self.selection.uid = if self.selection.uids.contains(&selected) { Some(selected) } else { self.selection.uids.last().copied() };
            }
            Some(selected) => self.selection = Selection { uid: Some(selected), uids: vec![selected], joint },
        }
        self.selection.joint = if self.selection.uids.len() == 1 { joint } else { -1 };
        self.emit("selection", vec![]);
        Ok(self.object()?.map(|(_, o)| o).unwrap_or(Value::Null))
    }

    /// `_selectIds`: new/published identities select the last entry and clear
    /// the branch through the existing selection owner. Other hidden metadata
    /// retains the editor's ordinary selection filtering semantics.
    pub(crate) fn select_ids(&mut self, ids: Vec<u32>) {
        self.selection_metadata.branch = None;
        self.selection = Selection { uid: ids.last().copied(), uids: ids, joint: -1 };
    }

    /// `selectMany(uids)`: returns the selected figures in slot order.
    pub(crate) fn select_many(&mut self, uids: &[u32]) -> Result<Value, EditError> {
        self.selection_metadata.branch = None;
        let frame = self.selection_frame()?;
        let mut selected = Vec::new();
        for &u in uids {
            if frame.iter().any(|o| uid(o) == Some(u)) && !selected.contains(&u) {
                selected.push(u);
            }
        }
        self.select_ids(selected);
        self.emit("selection", vec![]);
        Ok(Value::array(frame.into_iter().filter(|o| uid(o).is_some_and(|u| self.selection.uids.contains(&u))).collect()))
    }

    pub(crate) fn seek(&mut self, tick: f64) -> Result<Value, EditError> { self.seek_checked(tick,&mut || Ok(())) }
    pub(crate) fn seek_checked(&mut self, tick: f64, check: &mut dyn FnMut() -> Result<(), EditError>) -> Result<Value, EditError> {
        check()?;
        if !tick.is_finite() {
            return Err(crate::transform::not_finite("Timeline tick"));
        }
        if self.drag.is_some() {
            self.commit_drag_checked(check)?;
        }
        let rows = rows(&self.report);
        let next = tick.clamp(0.0, (total_ticks(&rows) - 1.0).max(0.0));
        let index = rows.partition_point(|r| r.start <= next).saturating_sub(1);
        self.tick = next;
        self.frame_index = index;
        self.retained = None;
        self.emit("seek", vec![]);
        // `seek` returns the evaluated frame, a view the facade reads from its own copy.
        Ok(Value::Null)
    }

    /// `editor.activeLayerId`.
    pub(crate) fn active_layer(&self) -> String {
        let layers = self.report.path(&["_styk", "layers"]);
        let named = |key: &str| layers.and_then(|l| l.get(key)).and_then(Value::as_str).map(str::to_string);
        named("activeId").or_else(|| named("defaultLayerId")).unwrap_or_else(|| "layer-1".into())
    }

    /// `report._styk.layers.activeId = id`.
    pub(crate) fn set_active_layer(&mut self, id: &str) {
        if self.report.path(&["_styk", "layers", "activeId"]).and_then(Value::as_str) == Some(id) { return; }
        let layers = self.report.make_obj().and_then(|r| r.get_mut("_styk")).and_then(Value::make_obj).and_then(|s| s.get_mut("layers")).and_then(Value::make_obj);
        if let Some(layers) = layers {
            layers.set("activeId", Value::str(id));
        }
    }

    pub(crate) fn selection_state(&self) -> SelectionState {
        let metadata = &self.selection_metadata;
        // Ordinary selection queries never evaluate a frame for optional metadata.
        let figure = if metadata.polygon.is_some() || metadata.segments.is_some() { self.selection_figure().ok().flatten() } else { None };
        let polygon = metadata.polygon.as_ref().filter(|polygon| self.selected_polygon_index(figure.as_ref(), polygon).is_some()).cloned();
        let segment_ids = metadata.segments.as_ref().map(|_| self.selected_segment_ids(figure.as_ref())).filter(|ids| ids.len() > 1);
        let branch = metadata.branch.as_ref().filter(|_| self.branch_selected()).cloned();
        SelectionState { frame_index: self.frame_index, tick: self.tick, selection: self.selection.clone(), active_layer: self.active_layer(), sheet: self.sheet_selection.clone(), polygon, segment_ids, branch }
    }

    /// `getLayer(id)` exists: the scene, the camera or a user layer.
    pub(crate) fn layer_exists(&self, id: &str) -> bool {
        ["scene", "camera"].contains(&id) || self.report.path(&["_styk", "layers", "order"]).and_then(Value::elements).is_some_and(|order| order.iter().any(|layer| layer.as_str() == Some(id)))
    }

    /// `setActiveLayer(id)`.
    pub(crate) fn set_active_layer_command(&mut self, id: &Value) -> Result<bool, EditError> {
        let id = id.as_str().filter(|id| self.layer_exists(id)).ok_or_else(|| EditError::Invalid("errors.editorLayers.chooseAnExistingLayer".into()))?.to_string();
        if self.report.path(&["_styk", "layers"]).is_none() {
            return Err(EditError::Unported("an active layer without layer state".into()));
        }
        if self.report.path(&["_styk", "layers", "activeId"]).and_then(Value::as_str) == Some(id.as_str()) {
            return Ok(false);
        }
        self.set_active_layer(&id);
        self.emit("selection", vec![("layerSelection", Value::Bool(true)), ("activeLayerId", Value::str(&id)), ("layerRevision", Value::Num(self.layer_revision as f64))]);
        Ok(true)
    }

    /// `selectSheetLayer(id, {contents})`: the layer becomes active and, with its contents,
    /// its figures on show are selected and stay selected as the playhead moves.
    pub(crate) fn select_sheet_layer(&mut self, id: &Value, options: &Value) -> Result<bool, EditError> {
        let Some(id) = id.as_str().filter(|id| self.layer_exists(id)).map(str::to_string) else { return Ok(false) };
        let contents = options.get("contents").is_none_or(Value::truthy);
        self.set_active_layer_command(&Value::str(&id))?;
        self.sheet_selection = Some(SheetSelection { id, contents });
        if contents {
            self.follow_sheet_selection()?;
        }
        self.emit("selection", vec![("sheetSelection", Value::Bool(true))]);
        Ok(true)
    }

    /// `keepSelectionOnSeek()`: the figure selection stays as it is across seeks.
    pub(crate) fn keep_selection_on_seek(&mut self) {
        if let Some(selection) = self.sheet_selection.as_mut().filter(|s| s.contents) {
            selection.contents = false;
        }
    }

    /// `_followSheetSelection()`: the figures of the chosen layer on show are the selection.
    pub(crate) fn follow_sheet_selection(&mut self) -> Result<(), EditError> {
        let Some(chosen) = self.sheet_selection.clone().filter(|s| s.contents) else { return Ok(()) };
        if !self.sheet() {
            return Ok(());
        }
        let objects: Vec<Value> = crate::frame::objects_of(&self.shown_frame()?).into_iter().filter(|o| uid(o).is_some_and(|u| self.layer_of(u) == chosen.id)).collect();
        let ids: Vec<u32> = objects.iter().filter_map(uid).collect();
        if ids.len() != self.selection.uids.len() || ids.iter().any(|u| !self.selection.uids.contains(u)) {
            self.selection.uids = ids.clone();
        }
        let unjoined = objects.iter().find(|o| !o.get("join").is_some_and(Value::truthy)).and_then(uid);
        self.selection.uid = unjoined.or_else(|| ids.first().copied());
        self.selection.joint = -1;
        self.selection_metadata.branch = None;
        Ok(())
    }

    /// `_restoreSelection`.
    pub(crate) fn restore_selection(&mut self, state: &SelectionState) -> Result<(), EditError> {
        let _scope = crate::prof::scope("select::restore");
        let frames = self.report.get("keyframes").and_then(Value::array_len).unwrap_or(1);
        self.frame_index = state.frame_index.min(frames.saturating_sub(1));
        let total = total_ticks(&rows(&self.report));
        self.tick = state.tick.clamp(0.0, (total - 1.0).max(0.0));
        let existing: Vec<u32> = self.selection_frame()?.iter().filter_map(uid).collect();
        let selected = state.selection.uid.filter(|u| existing.contains(u));
        let mut uids = Vec::new();
        for &uid in &state.selection.uids { if existing.contains(&uid) && !uids.contains(&uid) { uids.push(uid); } }
        let selected = if selected.is_some_and(|u| uids.contains(&u)) { selected } else { uids.last().copied() };
        self.selection = Selection { uid: selected, uids, joint: if selected.is_none() { -1 } else { state.selection.joint } };
        let mut metadata = styk_doc::Obj::new();state.write_metadata(&mut metadata);
        self.set_selection_metadata(&Value::object(metadata))?;
        // The active layer comes back too, or the default one when it is gone.
        if let Some(layers) = self.report.path(&["_styk", "layers"]) {
            let known = ["scene", "camera"].contains(&state.active_layer.as_str())
                || layers.get("order").and_then(Value::elements).is_some_and(|order| order.iter().any(|id| id.as_str() == Some(state.active_layer.as_str())));
            let active = if known { state.active_layer.clone() } else { layers.get("defaultLayerId").and_then(Value::as_str).unwrap_or("").to_string() };
            self.set_active_layer(&active);
        }
        self.sheet_selection = state.sheet.clone();
        Ok(())
    }
}

pub(crate) fn metadata_recorded_call(method: &str) -> bool {
    matches!(method, "select" | "@select" | "selectMany" | "selectPolygon" | "toggleSegment" | "selectBranch" | "seek" | "@seek" | "setFPS" | "setCanvasSize" | "updateProject" | "undo" | "redo")
}

pub(crate) fn index(value: Option<&Value>) -> Option<usize> {
    value.and_then(Value::as_f64).filter(|value| value.is_finite() && value.fract() == 0.0 && *value >= 0.0 && *value <= usize::MAX as f64).map(|value| value as usize)
}

/// Replay restoration uses the same canonical state as a history entry.
pub(crate) fn selection_state_of(value: &Value) -> SelectionState {
    let number = |key| value.get(key).and_then(Value::as_f64);
    let selected = number("uid").map(|uid| uid as u32);
    let uids = value.get("uids").and_then(Value::numbers).map(|uids| uids.into_iter().map(|uid| uid as u32).collect()).unwrap_or_else(|| selected.into_iter().collect());
    SelectionState {
        frame_index: index(value.get("frameIndex")).unwrap_or(0), tick: number("tick").unwrap_or(0.0),
        selection: Selection { uid: selected, uids, joint: number("joint").unwrap_or(-1.0) as i64 },
        active_layer: value.get("activeLayerId").and_then(Value::as_str).unwrap_or("").into(),
        sheet: value.get("sheetSelection").filter(|sheet| sheet.truthy()).and_then(|sheet| Some(SheetSelection { id: sheet.get("id")?.as_str()?.into(), contents: sheet.get("contents").is_some_and(Value::truthy) })),
        polygon: value.get("polygonSelection").filter(|value| value.truthy()).cloned(),
        segment_ids: value.get("segmentIds").and_then(Value::elements).map(|ids| ids.iter().collect()),
        branch: value.get("branch").filter(|value| value.truthy()).cloned(),
    }
}

/// `resolveJoinSelection` (src/pivot/structure.mjs): the slots a gesture on
/// `uids` affects. With `ancestors`, a selected joined figure stands for the
/// root of its assembly. Returns the affected slots in slot order.
pub(crate) fn resolve_join_selection(objects: &[Value], uids: &[u32], ancestors: bool) -> Result<Vec<usize>, EditError> {
    let mut selected = Vec::new();
    let mut children: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for (slot, object) in objects.iter().enumerate() {
        if uid(object).is_some_and(|u| uids.contains(&u)) {
            selected.push(slot);
        }
        if let Some(parent) = join_target(object) {
            children.entry(parent).or_default().push(slot);
        }
    }
    let mut roots = Vec::new();
    let mut resolved: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for &start in &selected {
        let mut slot = start;
        if ancestors {
            let (mut path, mut visiting) = (Vec::new(), std::collections::HashSet::new());
            while !resolved.contains_key(&slot) && objects.get(slot).and_then(join_target).is_some() {
                if !visiting.insert(slot) {
                    return Err(EditError::Invalid("errors.editorSelection.figuresContainACyclicJoin".into()));
                }
                path.push(slot);
                slot = join_target(&objects[slot]).unwrap();
                if objects.get(slot).is_none() {
                    return Err(EditError::Invalid("errors.editorSelection.joinTargetIsMissing".into()));
                }
            }
            slot = resolved.get(&slot).copied().unwrap_or(slot);
            for visited in path {
                resolved.insert(visited, slot);
            }
        }
        if !roots.contains(&slot) {
            roots.push(slot);
        }
    }
    let mut affected: Vec<usize> = roots.clone();
    let mut queue = roots;
    let mut q = 0;
    while q < queue.len() {
        for &child in children.get(&queue[q]).map(Vec::as_slice).unwrap_or(&[]) {
            if !affected.contains(&child) {
                affected.push(child);
                queue.push(child);
            }
        }
        q += 1;
    }
    affected.sort_unstable();
    Ok(affected)
}
