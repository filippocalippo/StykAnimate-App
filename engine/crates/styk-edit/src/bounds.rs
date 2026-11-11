//! The figure-bounds callbacks of `alignSelection`, `alignFiguresInFrames` and `centerCamera`.
//! The app's own callback (`boundsOf` in src/app.mjs) is measured here, from the engine's
//! geometry ([`Callback::App`]). A shadowing facade can instead hand over the measurements a
//! callback already made, which are replayed in order ([`Callback::Recorded`]); missing,
//! stale or differently ordered requests refuse the whole call. Any other callback is the
//! editor's.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use styk_doc::Value;
use crate::{EditError, Editor};
use crate::record::{num, uid};

const MAX_SAMPLES: usize = 8192;
fn unported() -> EditError { EditError::Unported("bounds callback measurements missing or for different requests".into()) }
pub(crate) type Shared = Rc<RefCell<Measurements>>;

/// The `boundsOf` a call was given.
#[derive(Clone, Debug)]
pub(crate) enum Callback {
    /// The app's callback, measured here by [`Editor::app_bounds`].
    App,
    /// Measurements the JavaScript owner made when it ran the callback itself.
    Recorded(Shared),
    /// Data where the editor needs a function; it throws.
    NotCallable,
}

impl Callback {
    /// `options.boundsOf` of a call, or `None` when it is absent (the editor's default callback).
    /// A function reaches the engine only as the app's own, as `{"@boundsCallback": "app"}`;
    /// any other object is data.
    pub(crate) fn of(editor: &Editor, method: &str, input: &[Value], options: &Value) -> Result<Option<Callback>, EditError> {
        let Some(given) = options.get("boundsOf") else { return Ok(None) };
        if given.get("@measuredBounds").is_some() {
            return Measurements::for_call(editor, method, input, options).map(|shared| Some(Callback::Recorded(shared)));
        }
        let app = given.as_obj().is_some_and(|marker| marker.len() == 1 && marker.get("@boundsCallback").and_then(Value::as_str) == Some("app"));
        Ok(Some(if app { Callback::App } else { Callback::NotCallable }))
    }

    /// What a call does with the callback it was given, once it has used it.
    pub(crate) fn finish(&self) -> Result<(), EditError> {
        match self {
            Callback::Recorded(shared) => shared.borrow().finish(),
            _ => Ok(()),
        }
    }
}

fn not_callable() -> EditError { EditError::Invalid("errors.editorCamera.provideAFigureBoundsFunction".into()) }

/// The error of `NotCallable`, for the call that needs a function.
pub(crate) fn require_function(callback: &Callback) -> Result<(), EditError> {
    if matches!(callback, Callback::NotCallable) { Err(not_callable()) } else { Ok(()) }
}
#[derive(Debug)]
pub(crate) struct Measurements { samples: Vec<Value>, next: usize }
impl Measurements {
    pub(crate) fn for_call(editor: &Editor, method: &str, input: &[Value], options: &Value) -> Result<Shared, EditError> {
        let data = options.get("boundsOf").and_then(|v| v.get("@measuredBounds")).ok_or_else(unported)?;
        let same = |a: Option<&Value>, b: &Value| a.is_some_and(|a| styk_doc::json::to_string(a) == styk_doc::json::to_string(b));
        let selected = Value::array(editor.selection.uids.iter().map(|&u| Value::Num(u as f64)).collect());
        let mut given = options.as_obj().cloned().ok_or_else(unported)?;
        given.set("boundsOf", Value::Null);
        let values = data.get("samples").filter(|v| v.array_len().is_some_and(|n| n <= MAX_SAMPLES)).and_then(Value::elements).ok_or_else(unported)?;
        let samples: Vec<Value> = values.iter().collect();
        if num(data, "version") != Some(1.0) || data.get("method").and_then(Value::as_str) != Some(method)
            || !same(data.get("input"), &Value::array(input.to_vec())) || !same(data.get("options"), &Value::object(given)) || num(data, "tick") != Some(editor.tick)
            || num(data, "frameIndex") != Some(editor.frame_index as f64) || !same(data.get("selectedUids"), &selected)
            || samples.len() > MAX_SAMPLES { return Err(unported()); }
        Ok(Rc::new(RefCell::new(Measurements { samples, next: 0 })))
    }
    pub(crate) fn request(&mut self, id: u32) -> Result<Value, EditError> {
        let sample = self.samples.get(self.next).filter(|sample| num(sample, "uid") == Some(id as f64)).ok_or_else(unported)?;
        let bounds = sample.get("bounds").cloned().ok_or_else(unported)?;
        self.next += 1;
        Ok(bounds)
    }
    pub(crate) fn finish(&self) -> Result<(), EditError> {
        if self.next == self.samples.len() { Ok(()) } else { Err(unported()) }
    }
}

/// `normalizedBounds`: finite ordered min/max coordinates or a rectangle.
pub(crate) fn normalized(raw: &Value) -> Result<[f64; 4], EditError> {
    let number = |key| num(raw, key).unwrap_or(f64::NAN);
    let b = if raw.get("minX").is_some() { [number("minX"), number("minY"), number("maxX"), number("maxY")] }
        else { [number("x"), number("y"), number("x") + number("width"), number("y") + number("height")] };
    if b.iter().all(|v| v.is_finite()) && b[2] >= b[0] && b[3] >= b[1] { Ok(b) }
    else { Err(EditError::Invalid("errors.editorSelection.figureBoundsMustContainFiniteOrderedCoordinates".into())) }
}

/// The selected members grouped by their assembly root, preserving selection slot order.
pub(crate) fn groups(objects: &[Value], ids: &[u32]) -> Result<Vec<(usize, Vec<usize>)>, EditError> {
    let mut out: Vec<(usize, Vec<usize>)> = Vec::new();
    for (selected, _) in objects.iter().enumerate().filter(|(_, o)| uid(o).is_some_and(|u| ids.contains(&u))) {
        let mut root = selected;
        let mut seen = std::collections::HashSet::new();
        while let Some(join) = objects[root].get("join").filter(|v| v.truthy()) {
            if !seen.insert(root) { return Err(EditError::Invalid("errors.editorSelection.figuresContainACyclicJoin".into())); }
            let Some(parent) = num(join, "target_object_slot").filter(|p| p.fract() == 0.0 && *p >= 0.0 && (*p as usize) < objects.len()) else {
                return Err(EditError::Invalid("errors.editorSelection.joinTargetIsMissing".into()));
            };
            root = parent as usize;
        }
        if let Some((_, members)) = out.iter_mut().find(|(slot, _)| *slot == root) { members.push(selected); }
        else { out.push((root, vec![selected])); }
    }
    Ok(out)
}

/// Measures the figure at a slot, identified by its unique id: its bounds as the editor's
/// callback returns them, or `None` for a figure the editor has no geometry for.
pub(crate) type Measure<'a> = dyn FnMut(usize, u32) -> Result<Option<[f64; 4]>, EditError> + 'a;

/// Measures through a callback: the measurements the owner made, in the order it made them,
/// or the engine's own for the app's.
pub(crate) fn measure_with<'a>(callback: &'a Callback, measured: &'a HashMap<usize, [f64; 4]>) -> impl FnMut(usize, u32) -> Result<Option<[f64; 4]>, EditError> + 'a {
    move |slot, id| match callback {
        Callback::Recorded(shared) => normalized(&shared.borrow_mut().request(id)?).map(Some),
        _ => Ok(measured.get(&slot).copied()),
    }
}

/// Alignment offsets, after every selected member was measured; unselected joined members
/// travel with their root but do not affect the target.
pub(crate) fn offsets(objects: &[Value], groups: &[(usize, Vec<usize>)], axis: &str, edge: &str, measure: &mut Measure<'_>) -> Result<Vec<(usize, f64, f64)>, EditError> {
    let a = usize::from(axis != "x");
    let (mut start, mut end) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut extents = Vec::new();
    for (root, members) in groups {
        let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
        for &slot in members {
            let id = uid(&objects[slot]).ok_or_else(unported)?;
            let Some(b) = measure(slot, id)? else { continue };
            min = min.min(b[a]); max = max.max(b[a + 2]);
        }
        if !min.is_finite() { continue; }
        extents.push((*root, min, max)); start = start.min(min); end = end.max(max);
    }
    if extents.len() < 2 { return Ok(Vec::new()); }
    let at = |min: f64, max: f64| if edge == "start" { min } else if edge == "end" { max } else { (min + max) / 2.0 };
    let target = at(start, end);
    Ok(extents.into_iter().map(|(root, min, max)| (root, target, at(min, max))).collect())
}

impl Editor {
    /// The app's `boundsOf` of the figures at `slots` of a frame record, by slot: the figures
    /// the editor has geometry for. Figures with geometry the engine cannot build refuse.
    pub(crate) fn app_bounds(&self, record: &Value, slots: &[usize]) -> Result<HashMap<usize, [f64; 4]>, EditError> {
        let prepared = self.prepared()?;
        let mut frame = self.eval.borrow_mut().loader.edit_frame(record, None, &prepared.doc).map_err(|error| EditError::Invalid(error.to_string()))?;
        // The reach of the effects on each figure at the frame's tick (`drawableVfxPadding`).
        if prepared.has_vfx {
            frame.vfx = prepared.frame_vfx(&frame, &mut Vec::new());
        }
        let scene = styk_eval::geometry::build_only_measured(&prepared.doc, &frame, slots);
        if !scene.warnings.is_empty() { return Err(EditError::Unported("bounds of figures with unresolved joins".into())); }
        let bounds = styk_eval::drawlist::app_bounds(&scene, prepared.doc.as_ref());
        Ok(slots.iter().filter_map(|&slot| Some((slot, bounds.get(slot).copied().flatten()?))).collect())
    }

    pub(crate) fn align_selection(&mut self, axis: &str, edge: &str, options: &Value) -> Result<Value, EditError> {
        if !["x", "y"].contains(&axis) { return Err(EditError::Invalid("errors.editorSelection.alignmentAxisMustBeXOrY".into())); }
        if !["start", "center", "end"].contains(&edge) { return Err(EditError::Invalid("errors.editorSelection.alignmentEdgeMustBeStartCenterOrEnd".into())); }
        // The editor's default callback is not ported.
        let Some(callback) = Callback::of(self, "alignSelection", &[Value::str(axis), Value::str(edge)], options)? else { return Err(unported()) };
        require_function(&callback)?;
        if self.drag.is_some() { self.commit_drag()?; }
        let groups = groups(&self.selection_frame()?, &self.selection.uids)?;
        if groups.len() < 2 { callback.finish()?; return Ok(Value::Bool(false)); }
        let mut moved = false;
        self.object_edit("Align figures", |editor| {
            editor.expand_translation_drag()?;
            let objects = editor.frame_objects();
            // The geometry of the frame on show, once the gesture is expanded (`editor.geometry`).
            let measured = match matches!(callback, Callback::App) {
                true => editor.app_bounds(&editor.shown_frame()?, &groups.iter().flat_map(|(_, members)| members.iter().copied()).collect::<Vec<_>>())?,
                false => HashMap::new(),
            };
            let offsets = offsets(&objects, &groups, axis, edge, &mut measure_with(&callback, &measured))?;
            callback.finish()?;
            let position = if axis == "x" { "root_x" } else { "root_y" };
            for (root, target, position_at) in offsets {
                let delta = target - position_at;
                if delta == 0.0 { continue; }
                let value = num(&objects[root], position).unwrap_or(f64::NAN) + delta;
                editor.frame_object_mut(root).ok_or_else(unported)?.set(position, Value::Num(value)); moved = true;
            }
            Ok(())
        })?;
        Ok(Value::Bool(moved))
    }
}
