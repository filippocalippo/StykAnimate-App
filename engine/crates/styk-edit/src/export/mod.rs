//! Documents for the file formats that cannot hold the editable document: Pivot `.piv` and `.stk`, and the figure files
//! `.stkz` and `.stykmov` (src/document-export-worker.mjs, pivot-export-materialize.mjs, pivot-style-materialize.mjs,
//! native-figure.mjs). The engine evaluates the document it holds: authored tracks, camera motion, parallax, styles and
//! movieclips bake into the stored frames Pivot has ([`pivot`]), a figure with its displayed pose becomes a document of its
//! own ([`figure`]). Encoding the result is `styk-piv`'s (the codec's export route), the container save of `.styk` is not
//! done here: it needs no evaluation.
//!
//! The work reads a snapshot of the engine's document (the tree, the loader that made its typed views and the views),
//! changes nothing of it, and checks a cancellation between ticks.

mod figure;
mod pivot;
mod pose_sequences;
mod save;
mod style;
#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::sync::Arc;

use styk_doc::Value;
use styk_eval::eval::Prepared;
use styk_eval::load::Loader;
use styk_eval::records::Records;

pub use figure::FigureRequest;
pub use save::{fold_movieclip, project_document};

use crate::{EditError, Editor, Options};

/// The file formats of an export of the open document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// A Pivot animation: the document as native frames.
    Piv,
    /// A Pivot figure: one figure type with the style it shows.
    Stk,
    /// A figure file (a reusable figure or set of figures).
    Stkz,
    /// A movieclip file.
    Stykmov,
}

impl Format {
    pub fn parse(name: &str) -> Option<Format> {
        Some(match name {
            "piv" => Format::Piv,
            "stk" => Format::Stk,
            "stkz" => Format::Stkz,
            "stykmov" => Format::Stykmov,
            _ => return None,
        })
    }
}

/// What an export asks of the document.
#[derive(Clone, Debug)]
pub struct Request {
    pub format: Format,
    /// The name the file is saved under, which the document carries.
    pub name: Option<String>,
    pub figure: FigureRequest,
}

/// The document an export saves.
#[derive(Debug)]
pub struct Exported {
    pub document: Value,
    /// For `.stk`: the figure type the file holds (the shown style makes a variant of the one asked for).
    pub figure_type_id: Option<f64>,
    /// A Pivot file cannot carry drawing cels: the interface flattens them into pictures (`drawing-flatten.mjs`).
    pub drawings: bool,
}

/// Whether the export is asked to stop.
pub struct Hold<'a> {
    pub cancel: &'a dyn Fn() -> bool,
}

/// The error an export raises when it is stopped; the caller tells it by this message.
pub const CANCELLED: &str = "cancelled";

impl Hold<'_> {
    fn check(&self) -> Result<(), EditError> {
        if (self.cancel)() { Err(EditError::Invalid(CANCELLED.into())) } else { Ok(()) }
    }
}

pub(crate) fn items(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::elements).map(|elements| elements.iter().collect()).unwrap_or_default()
}

pub(crate) fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

pub(crate) fn set(value: &mut Value, key: &str, new: Value) {
    if let Some(object) = value.make_obj() {
        object.set(key, new);
    }
}

pub(crate) fn remove(value: &mut Value, key: &str) {
    if let Some(object) = value.make_obj() {
        object.remove(key);
    }
}

/// What the geometry of a frame solved for a figure: where its root is, and the angles and lengths inverse kinematics gave it.
pub(crate) struct Solved {
    pub root: [f64; 2],
    pub angles: Option<Vec<f64>>,
    pub lengths: Option<Vec<f64>>,
}

/// A document to read frames of: the tree, its typed views, and an editor over it for the camera reads.
pub(crate) struct Context {
    pub report: Value,
    pub prepared: Arc<Prepared>,
    loader: RefCell<Loader>,
    editor: Editor,
}

impl Context {
    pub fn new(report: Value, prepared: Arc<Prepared>, loader: Loader) -> Context {
        let mut editor = Editor::new(report.clone(), Options { property_channels: true, layer_timeline: true, auto_key: false });
        editor.adopt_prepared(loader.clone(), prepared.clone());
        Context { report, prepared, loader: RefCell::new(loader), editor }
    }

    pub fn of_editor(editor: &Editor) -> Result<Context, EditError> {
        let prepared = editor.prepared()?;
        let loader = editor.eval.borrow().loader.clone();
        Ok(Context::new(editor.report.clone(), prepared, loader))
    }

    /// The same read over another document (the typed views are made again for it unless it is this one).
    pub fn derive(&self, report: Value) -> Result<Context, EditError> {
        let mut loader = self.loader.borrow().clone();
        if report.same_node(&self.report) {
            return Ok(Context::new(report, self.prepared.clone(), loader));
        }
        let document = loader.document(&report, "").map_err(|error| EditError::Invalid(error.to_string()))?;
        Ok(Context::new(report, Arc::new(Prepared::new(Arc::new(document))), loader))
    }

    pub fn editor(&self) -> &Editor {
        &self.editor
    }

    pub fn loader(&self) -> Loader {
        self.loader.borrow().clone()
    }

    pub fn records(&self) -> Result<Records<'_>, EditError> {
        Ok(Records::new(&self.report, &self.prepared)?)
    }

    /// `evaluatedFrame` at `tick`, its row picked from the extended timeline.
    pub fn frame_at(&self, tick: f64) -> Result<Value, EditError> {
        let rows = crate::timeline::rows(&self.report);
        let mut index = 0;
        while index + 1 < rows.len() && rows[index + 1].start <= tick {
            index += 1;
        }
        let row = rows.get(index).copied().unwrap_or(crate::timeline::Row { start: 0.0, count: 0.0 });
        self.sample_interval(index, if row.count != 0.0 { ((tick - row.start) / row.count).clamp(0.0, 1.0) } else { 0.0 }, tick)
    }

    /// What the geometry of `frame` solved, by object slot (`None` for a figure it could not resolve).
    pub fn solved(&self, frame: &Value) -> Result<Vec<Option<Solved>>, EditError> {
        let doc = &self.prepared.doc;
        let typed = self.loader.borrow_mut().edit_frame(frame, None, doc).map_err(|error| EditError::Invalid(error.to_string()))?;
        let scene = styk_eval::geometry::build_shapes(doc, &typed, None);
        Ok(scene.objects.iter().map(|object| object.resolved.then(|| Solved {
            root: object.root,
            angles: object.solution.as_ref().map(|solution| solution.angles.clone()),
            lengths: object.solution.as_ref().and_then(|solution| solution.lengths.clone()),
        })).collect())
    }
}

/// Whether `check` holds anywhere in `document` or the movieclip documents it holds (each document once).
fn any_document(document: &Value, check: &dyn Fn(&Value) -> bool) -> bool {
    let mut pending = vec![document.clone()];
    let mut seen: Vec<Value> = Vec::new();
    while let Some(document) = pending.pop() {
        if !document.is_object() || seen.iter().any(|known| known.same_node(&document)) {
            continue;
        }
        seen.push(document.clone());
        if check(&document) {
            return true;
        }
        if let Some(source) = document.path(&["_styk", "movieclipSource", "document"]) {
            pending.push(source.clone());
        }
        for figure in items(document.get("figure_types")) {
            if let Some(clip) = figure.path(&["_styk", "movieclip", "document"]) {
                pending.push(clip.clone());
            }
        }
    }
    false
}

/// `documentHasVfx(report)`: effect clips, effect channels or saved effect stacks, anywhere.
fn has_vfx(report: &Value) -> bool {
    any_document(report, &|document| {
        if document.path(&["_styk", "vfxClips", "clips"]).and_then(Value::array_len).is_some_and(|clips| clips > 0) {
            return true;
        }
        let effects = |animation: Option<&Value>| items(animation.and_then(|animation| animation.get("channels"))).iter().any(|channel| channel.get("property").and_then(Value::as_str).is_some_and(styk_eval::vfx::parse::is_vfx_property));
        if effects(document.path(&["_styk", "animation"])) || effects(document.path(&["_styk", "layerSheet", "legacyAnimation"])) {
            return true;
        }
        let has = |frame: &Value| frame.get("_stykVfx").is_some_and(Value::truthy) || items(frame.get("objects")).iter().any(|object| object.get("_stykVfx").is_some_and(Value::truthy));
        items(document.get("keyframes")).iter().any(has) || document.path(&["_styk", "frameSources"]).and_then(Value::as_obj).is_some_and(|sources| sources.iter().any(|(_, frame)| has(frame)))
    })
}

/// `documentHasRigConstraints(document)`.
pub(crate) fn has_rig_constraints(report: &Value) -> bool {
    any_document(report, &|document| items(document.get("figure_types")).iter().any(|figure| items(figure.get("segments")).iter().any(|segment| segment.get("_stykRig").is_some_and(Value::truthy))))
}

/// `documentHasSurfaces(document)`.
pub(crate) fn has_surfaces(report: &Value) -> bool {
    any_document(report, &|document| items(document.get("figure_types")).iter().any(|figure| {
        items(figure.get("polyfills")).iter().any(|polygon| polygon.get("_stykSurface").is_some_and(Value::truthy))
            || figure.path(&["_styk", "spatialMesh"]).is_some_and(Value::truthy)
            || figure.path(&["_styk", "movieclip", "spatialMeshes"]).is_some_and(Value::truthy)
    }))
}

/// `hasSourceShapes(document)`: Stick Nodes shapes and sprites, which Pivot cannot retain.
fn has_stick_nodes_shapes(report: &Value) -> bool {
    any_document(report, &|document| {
        items(document.get("figure_types")).iter().any(|figure| items(figure.get("segments")).iter().any(|segment| segment.get("_sticknodes").is_some_and(Value::truthy)))
            || items(document.get("keyframes")).iter().any(|frame| items(frame.get("objects")).iter().any(|object| object.get("_sticknodesSprite").is_some_and(Value::truthy)))
    })
}

/// Whether the document holds a drawing cel the interface must flatten into a picture first.
fn has_drawings(report: &Value) -> bool {
    any_document(report, &|document| items(document.get("figure_types")).iter().any(|figure| {
        figure.path(&["_styk", "drawing", "version"]).and_then(Value::as_f64) == Some(2.0) && figure.get("image_assets").and_then(|assets| assets.item(0)).is_some_and(|asset| asset.truthy())
    }))
}

/// Whether Pivot cannot draw a paint: only a solid one, or a vertical two-stop linear gradient from 0 to 1, has a native form.
fn unsupported_paint(paint: Option<&Value>) -> bool {
    let Some(paint) = paint.filter(|paint| paint.truthy()) else { return false };
    if paint.get("type").and_then(Value::as_str) == Some("solid") {
        return false;
    }
    let stops = items(paint.get("stops"));
    paint.get("type").and_then(Value::as_str) != Some("linear")
        || paint.get("angle").and_then(Value::as_f64).is_none_or(|angle| angle % 360.0 != 0.0)
        || stops.len() != 2
        || number(&stops[0], "offset") != Some(0.0)
        || number(&stops[1], "offset") != Some(1.0)
}

/// Gradient fills the native Pivot figure cannot represent.
fn has_unsupported_gradients(document: &Value, format: Format, figure_type_id: Option<f64>) -> bool {
    let figures: Vec<Value> = items(document.get("figure_types")).into_iter().filter(|figure| format != Format::Stk || number(figure, "figure_type_id") == figure_type_id).collect();
    // Native text gradients run vertically per glyph. A paint fill spans the entire text run, even when it is a two-stop
    // linear gradient.
    let segment_paints = figures.iter().any(|figure| items(figure.get("segments")).iter().any(|segment| {
        let paint = segment.get("paint").filter(|paint| paint.truthy());
        unsupported_paint(paint)
            || paint.is_some_and(|paint| paint.get("type").and_then(Value::as_str) != Some("solid"))
                && (number(segment, "primitive_code") == Some(5.0) || segment.get("segment_type").and_then(Value::as_str) == Some("text"))
    }));
    segment_paints || (format == Format::Piv && items(document.get("backgrounds")).iter().any(|background| background.get("paint").is_some_and(|paint| paint.truthy() && paint.get("type").and_then(Value::as_str) != Some("solid"))))
}

/// `roundEven(value)`.
fn round_even(value: f64) -> f64 {
    let floor = value.floor();
    let fraction = value - floor;
    if fraction < 0.5 {
        floor
    } else if fraction > 0.5 {
        floor + 1.0
    } else {
        floor + (floor % 2.0).abs()
    }
}

/// `synchronizeExistingDerived(report)`: the display aliases a record already has are brought in line with its authoritative
/// fields; no alias is added, and unknown data stays as it is.
fn synchronize_derived(report: &Value) -> Result<Value, EditError> {
    let mut report = report.clone();
    let version = number(&report, "version").unwrap_or(f64::NAN);
    let segment_color_types: Vec<f64> = items(report.get("figure_types")).iter().filter(|figure| figure.path(&["_styk", "colorMode"]).and_then(Value::as_str) == Some("segments")).filter_map(|figure| number(figure, "figure_type_id")).collect();
    let present = |value: &Value, key: &str| value.as_obj().is_some_and(|object| object.contains(key));
    if report.get("auto_easing_source").and_then(Value::as_str) == Some("application_default") && present(&report, "auto_easing_disabled_raw") {
        set(&mut report, "auto_easing_disabled_raw", Value::Null);
    }
    // Figures: their segment counts and the flags each segment's kind implies.
    let figures = items(report.get("figure_types"));
    let mut changed_figures: Option<Vec<Value>> = None;
    for (at, figure) in figures.iter().enumerate() {
        let mut next = figure.clone();
        let segments = items(figure.get("segments"));
        if present(figure, "segment_count") && number(figure, "segment_count") != Some(segments.len() as f64) {
            set(&mut next, "segment_count", Value::Num(segments.len() as f64));
        }
        let mut rewritten: Option<Vec<Value>> = None;
        for (index, segment) in segments.iter().enumerate() {
            if let Some(paint) = segment.get("paint").filter(|paint| paint.truthy()) {
                styk_eval::records::paint::normalize_paint(paint)?;
            }
            let (Some(primitive), Some(aux)) = (number(segment, "primitive_code"), number(segment, "aux_code")) else { continue };
            let mut updated = segment.clone();
            let flags = f64::from(crate::recolor::to_int32(primitive) | (crate::recolor::to_int32(aux) << 8));
            let is_static = crate::recolor::to_int32(aux) & 1 != 0;
            if present(segment, "flags") {
                set(&mut updated, "flags", Value::Num(flags));
            }
            if present(segment, "is_static") {
                set(&mut updated, "is_static", Value::Bool(is_static));
            }
            if let Some(bits) = segment.get("flag_bits").filter(|bits| bits.truthy()) {
                let mut bits = bits.as_obj().cloned().unwrap_or_default();
                let had_static = bits.contains("is_static");
                bits.set("is_static", Value::Bool(is_static));
                for (key, value) in [("raw", Value::Num(flags)), ("low_byte", Value::Num(primitive)), ("high_byte", Value::Num(aux)), ("set_bits", Value::array((0..16).filter(|bit| (flags as i32) & (1 << bit) != 0).map(|bit| Value::Num(f64::from(bit))).collect()))] {
                    if bits.contains(key) {
                        bits.set(key, value);
                    }
                }
                if !had_static {
                    bits.remove("is_static");
                }
                set(&mut updated, "flag_bits", Value::object(bits));
            }
            let kind = match primitive as i64 {
                0 => Some("line"),
                1 => Some("circle"),
                2 => Some("image"),
                3 => Some("circleFill"),
                4 => Some("circleClear"),
                5 => Some("text"),
                6 => Some("squareLine"),
                _ => None,
            };
            if present(segment, "segment_kind") {
                match kind {
                    Some(kind) => set(&mut updated, "segment_kind", Value::str(kind)),
                    None => remove(&mut updated, "segment_kind"),
                }
            }
            if present(segment, "segment_type") {
                let kind = if matches!(primitive as i64, 1 | 3 | 4) { "circle" } else if primitive == 2.0 { "image" } else if primitive == 5.0 { "text" } else { "line" };
                set(&mut updated, "segment_type", Value::str(kind));
            }
            if present(segment, "visible") {
                let visible = number(segment, "thickness").is_some_and(|thickness| thickness > 0.01) || (1..=6).contains(&(primitive as i64));
                set(&mut updated, "visible", Value::Bool(visible));
            }
            if !updated.same_node(segment) && styk_doc::json::to_string(&updated) != styk_doc::json::to_string(segment) {
                rewritten.get_or_insert_with(|| segments.clone())[index] = updated;
            }
        }
        if let Some(list) = rewritten {
            set(&mut next, "segments", Value::array(list));
        }
        if !next.same_node(figure) {
            changed_figures.get_or_insert_with(|| figures.clone())[at] = next;
        }
    }
    if let Some(list) = changed_figures {
        set(&mut report, "figure_types", Value::array(list));
    }
    if version < 5.0 {
        if let Some(delay) = number(&report, "frame_delay_ms").filter(|delay| *delay != 0.0) {
            set(&mut report, "fps", Value::Num(round_even(1000.0 / delay)));
        }
    }
    if report.get("auto_easing").is_some() && report.get("auto_easing_source").and_then(Value::as_str) != Some("application_default") && present(&report, "auto_easing_disabled_raw") {
        let disabled = if report.get("auto_easing").is_some_and(Value::truthy) { 0.0 } else { 1.0 };
        set(&mut report, "auto_easing_disabled_raw", Value::Num(disabled));
    }
    let total: f64 = crate::timeline::rows(&report).iter().map(|row| row.count).sum();
    if present(&report, "total_output_frames") {
        set(&mut report, "total_output_frames", Value::Num(total));
    }
    if present(&report, "duration_seconds") {
        let fps = number(&report, "fps").unwrap_or(f64::NAN);
        set(&mut report, "duration_seconds", Value::Num(total / fps));
    }
    let frames = items(report.get("keyframes"));
    let mut changed_frames: Option<Vec<Value>> = None;
    for (at, frame) in frames.iter().enumerate() {
        let mut next = frame.clone();
        let duration = number(frame, "duration_raw").unwrap_or(f64::NAN);
        for (key, value) in [("inbetweens", Value::Num(if version >= 5.0 { duration - 1.0 } else { 0.0 })), ("hidden", Value::Bool(duration == 0.0)), ("duration_frames", Value::Num(duration))] {
            if present(frame, key) && (key != "duration_frames" || version < 5.0) && frame.get(key) != Some(&value) {
                set(&mut next, key, value);
            }
        }
        let objects = items(frame.get("objects"));
        let mut rewritten: Option<Vec<Value>> = None;
        for (index, object) in objects.iter().enumerate() {
            let raw = crate::recolor::to_uint32(object.get("color_override_raw").map_or(0.0, |raw| raw.as_f64().unwrap_or(f64::NAN)));
            let type_id = number(object, "figure_type_id").unwrap_or(f64::NAN);
            let segment_colors = segment_color_types.contains(&type_id) || object.path(&["_styk", "colorMode"]).and_then(Value::as_str) == Some("segments");
            let rgb = if version < 5.0 && !segment_colors && (raw as i32) < 0 { [0.0; 3] } else { [f64::from(raw & 255), f64::from((raw >> 8) & 255), f64::from((raw >> 16) & 255)] };
            let transparency = object.get("field28").filter(|v| !v.is_null()).map_or(0.0, |v| v.as_f64().unwrap_or(f64::NAN));
            let mut updated = object.clone();
            if present(object, "color_override_rgb") && object.get("color_override_rgb").and_then(Value::numbers).as_deref() != Some(&rgb[..]) {
                set(&mut updated, "color_override_rgb", Value::array(rgb.iter().map(|&channel| Value::Num(channel)).collect()));
            }
            if (version >= 5.0 || segment_colors) && present(object, "color_override_mix") && number(object, "color_override_mix") != Some(f64::from(raw >> 24)) {
                set(&mut updated, "color_override_mix", Value::Num(f64::from(raw >> 24)));
            }
            if present(object, "transparency") && number(object, "transparency") != Some(transparency) {
                set(&mut updated, "transparency", Value::Num(transparency));
            }
            if present(object, "opacity") && number(object, "opacity") != Some(1.0 - transparency / 255.0) {
                set(&mut updated, "opacity", Value::Num(1.0 - transparency / 255.0));
            }
            if !updated.same_node(object) {
                rewritten.get_or_insert_with(|| objects.clone())[index] = updated;
            }
        }
        if let Some(list) = rewritten {
            set(&mut next, "objects", Value::array(list));
        }
        if !next.same_node(frame) {
            changed_frames.get_or_insert_with(|| frames.clone())[at] = next;
        }
    }
    if let Some(list) = changed_frames {
        set(&mut report, "keyframes", Value::array(list));
    }
    Ok(report)
}

fn unsupported(key: &str) -> EditError {
    EditError::Invalid(key.into())
}

/// The document an export of `request.format` saves, made from the engine's document: `tree` with `prepared` its typed views
/// and `loader` what made them.
pub fn export_document(tree: &Value, loader: &Loader, prepared: &Arc<Prepared>, request: &Request, hold: &Hold<'_>) -> Result<Exported, EditError> {
    let context = Context::new(tree.clone(), prepared.clone(), loader.clone());
    let pivot = matches!(request.format, Format::Piv | Format::Stk);
    hold.check()?;
    if pivot && has_vfx(tree) {
        return Err(unsupported("errors.documentExportWorker.pivotFilesCannotPreserveVfxSaveAsStyk"));
    }
    crate::load::validate_animation(tree)?;
    if !pivot {
        let document = context.native_figure_document(&request.figure, None)?;
        if request.format == Format::Stykmov && !document.path(&["figure_types"]).and_then(|figures| figures.item(0)).is_some_and(|figure| figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy)) {
            return Err(unsupported("errors.documentExportWorker.selectAMovieclipToExportAsStykmov"));
        }
        let mut exported = finish(document, request.format, None, false, hold)?;
        // The poses a movieclip's channels share are stored once, as the file keeps them.
        exported.document = pose_sequences::pack_pose_sequences(&exported.document);
        return Ok(exported);
    }
    if has_rig_constraints(tree) || has_surfaces(tree) {
        return Err(unsupported("errors.documentExportWorker.pivotCannotPreserveConnectorsSmartStretchOrOne"));
    }
    if has_stick_nodes_shapes(tree) {
        return Err(unsupported("errors.documentExportWorker.pivotCannotRetainTheseStickNodesShapesSave"));
    }
    let drawings = has_drawings(tree);
    let mut figure_type_id = request.figure.figure_type_id;
    let document = if request.format == Format::Piv {
        pivot::materialize(hold, &context)?
    } else {
        let figure = items(tree.get("figure_types")).into_iter().find(|figure| number(figure, "figure_type_id") == figure_type_id);
        if figure.is_some_and(|figure| figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy)) {
            return Err(unsupported("errors.documentExportWorker.saveMovieclipsAsStykmovUseBreakApartTo"));
        }
        let (document, variant) = styled_figure(&context, &request.figure)?;
        figure_type_id = variant.or(figure_type_id);
        document
    };
    if has_unsupported_gradients(&document, request.format, figure_type_id) {
        return Err(unsupported("errors.documentExportWorker.pivotFilesCannotRepresentTheseGradientFillsSave"));
    }
    // The metadata the editable document carries.
    let mut document = document;
    let mut styk = document.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
    styk.set("format", Value::str("StykAnimate"));
    styk.set("format_version", Value::Num(1.0));
    if let Some(name) = request.name.as_deref().filter(|name| !name.is_empty()) {
        styk.set("name", Value::str(name));
    }
    set(&mut document, "_styk", Value::object(styk));
    if request.format == Format::Piv {
        document = without_frame_ids(&document);
    }
    finish(document, request.format, figure_type_id, drawings, hold)
}

/// What every export ends with: no cache of the editor in the frames, the display aliases in line with the authoritative
/// fields, and the document a valid one.
fn finish(document: Value, format: Format, figure_type_id: Option<f64>, drawings: bool, hold: &Hold<'_>) -> Result<Exported, EditError> {
    let document = without_runtime_segments(&document);
    hold.check()?;
    let document = synchronize_derived(&document)?;
    // Zero stored frames are a valid native PIV boundary. The materializer already validated the editable placeholder before
    // removing it; retain full figure-table validation without inventing an exported exposure.
    if format == Format::Piv && items(document.get("keyframes")).is_empty() {
        let mut probe = document.clone();
        let mut frame = crate::sheet::create_frame(&[]);
        set(&mut frame, "duration_raw", Value::Num(0.0));
        set(&mut probe, "keyframes", Value::array(vec![frame]));
        crate::load::validate_scene(&probe)?;
    } else {
        crate::load::validate_scene(&document)?;
    }
    Ok(Exported { document, figure_type_id, drawings })
}

/// `materializeStyledFigureForStk(report, {figureTypeId, figureUid, tick})`: the style the selected figure shows at the tick, as
/// a figure type of the document, and the type to export.
fn styled_figure(context: &Context, request: &FigureRequest) -> Result<(Value, Option<f64>), EditError> {
    let frame = context.frame_at(request.tick)?;
    let object = items(frame.get("objects")).into_iter().find(|object| match request.figure_uid {
        None => number(object, "figure_type_id") == request.figure_type_id,
        Some(uid) => number(object, "unique_id") == Some(uid),
    });
    let Some(object) = object.filter(|object| object.get("_stykStyle").is_some_and(Value::truthy)) else { return Ok((context.report.clone(), None)) };
    let mut figures = items(context.report.get("figure_types"));
    let mut table = style::StyleTable::new(&figures);
    let variant = table.id(&object, &mut figures)?;
    let mut document = context.report.clone();
    set(&mut document, "figure_types", Value::array(figures));
    Ok((document, Some(variant)))
}

/// The keyframes' objects without the editor's runtime caches.
fn without_runtime_segments(document: &Value) -> Value {
    let frames = items(document.get("keyframes"));
    let mut changed: Option<Vec<Value>> = None;
    for (at, frame) in frames.iter().enumerate() {
        let objects = items(frame.get("objects"));
        let mut rewritten: Option<Vec<Value>> = None;
        for (index, object) in objects.iter().enumerate() {
            if object.as_obj().is_some_and(|object| object.contains("runtime_segments")) {
                let mut next = object.clone();
                remove(&mut next, "runtime_segments");
                rewritten.get_or_insert_with(|| objects.clone())[index] = next;
            }
        }
        if let Some(list) = rewritten {
            let mut next = frame.clone();
            set(&mut next, "objects", Value::array(list));
            changed.get_or_insert_with(|| frames.clone())[at] = next;
        }
    }
    match changed {
        Some(list) => {
            let mut next = document.clone();
            set(&mut next, "keyframes", Value::array(list));
            next
        }
        None => document.clone(),
    }
}

/// Native source frames acquire editor reference identities on load. They are not Pivot data and must not force a
/// changed-source rewrite.
fn without_frame_ids(document: &Value) -> Value {
    let frames = items(document.get("keyframes"));
    let mut changed: Option<Vec<Value>> = None;
    for (at, frame) in frames.iter().enumerate() {
        let Some(styk) = frame.get("_styk").filter(|styk| styk.as_obj().is_some_and(|styk| styk.contains("frameId"))) else { continue };
        let mut metadata = styk.as_obj().cloned().unwrap_or_default();
        metadata.remove("frameId");
        let mut next = frame.clone();
        if metadata.is_empty() { remove(&mut next, "_styk") } else { set(&mut next, "_styk", Value::object(metadata)) }
        changed.get_or_insert_with(|| frames.clone())[at] = next;
    }
    match changed {
        Some(list) => {
            let mut next = document.clone();
            set(&mut next, "keyframes", Value::array(list));
            next
        }
        None => document.clone(),
    }
}

impl Editor {
    /// The document `request` saves, from this editor's own document (the interface's synchronous reads, as the rig test and
    /// the library take a figure).
    pub fn export_view(&self, request: &Request) -> Result<Exported, EditError> {
        let context = Context::of_editor(self)?;
        export_document(&context.report, &context.loader(), &context.prepared, request, &Hold { cancel: &|| false })
    }
}
