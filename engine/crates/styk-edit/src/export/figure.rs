//! A reusable native figure: the displayed pose of a figure, a set of figures or a movieclip with its definition, as a
//! document of its own. Library files, the
//! rig test and `.stkz`/`.stykmov` exports save it.

use styk_doc::{Obj, Value};

use super::{items, number, set, Context};
use crate::sheet::create_frame;
use crate::{EditError, Editor};

/// The offsets of the original import archive a portable record leaves out.
const SOURCE_LOCATORS: [&str; 9] = ["record_offset", "record_end", "records_start", "records_end", "source_start", "source_end", "source_offset", "source_size", "image_start"];

fn blank(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_null)
}

/// `a ?? b ?? …`: the first of the fields that is not null.
fn first<'a>(object: &'a Obj, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| object.get(key).filter(|v| !v.is_null()))
}

/// `next.field ??= value` where `value` is a field that may be missing: a missing one leaves the field out.
fn assign_if_blank(next: &mut Obj, field: &str, value: Option<Value>) {
    if !blank(next.get(field)) {
        return;
    }
    match value {
        Some(value) => next.set(field, value),
        None => {
            next.remove(field);
        }
    }
}

/// `portableAsset(asset, {image})`: the asset without where it sat in the import archive; an image in the form a
/// native record has.
fn portable_asset(asset: &Value, image: bool) -> Value {
    let mut next = asset.as_obj().cloned().unwrap_or_default();
    for key in SOURCE_LOCATORS {
        next.remove(key);
    }
    if image {
        next.set("kind", Value::str("image"));
        let index = first(&next, &["asset_index", "table_index", "image_index", "sprite_index"]).cloned().unwrap_or(Value::Num(0.0));
        if blank(next.get("asset_index")) {
            next.set("asset_index", index);
        }
        let index = next.get("asset_index").cloned().unwrap_or(Value::Null);
        next.set("table_index", index);
        let pivot = next.get("pivot").cloned();
        assign_if_blank(&mut next, "anchor_start", pivot);
        let endpoint = next.get("endpoint").cloned();
        assign_if_blank(&mut next, "anchor_end", endpoint);
        let uri = next.get("data_uri").cloned();
        assign_if_blank(&mut next, "data_url", uri);
        if next.get("data_url").is_some_and(Value::truthy) {
            next.remove("data_uri");
            next.remove("data_base64");
        }
        let mime = next.get("data_url").and_then(Value::as_str).and_then(|url| {
            let rest = url.strip_prefix("data:")?;
            let end = rest.find(";base64,")?;
            (end > 0 && !rest[..end].contains(';')).then(|| rest[..end].to_string())
        });
        if let Some(mime) = mime {
            next.set("mime_type", Value::str(&mime));
        }
    }
    Value::object(next)
}

/// `portableFigure(figure, legacy)`: a figure definition for a file of its own, nested movieclip documents too.
pub(crate) fn portable_figure(figure: &Value, legacy: bool) -> Value {
    let mut next = figure.as_obj().cloned().unwrap_or_default();
    if let Some(decode) = next.get("segment_decode").filter(|decode| decode.truthy()) {
        let mut decode = decode.as_obj().cloned().unwrap_or_default();
        for key in SOURCE_LOCATORS {
            decode.remove(key);
        }
        next.set("segment_decode", Value::object(decode));
    }
    let assets = |key: &str, image: bool| Value::array(items(figure.get(key)).iter().map(|asset| portable_asset(asset, image)).collect());
    next.set("image_assets", assets("image_assets", true));
    next.set("text_assets", assets("text_assets", false));
    next.remove("side_tables");
    let segments: Vec<Value> = items(figure.get("segments")).iter().map(|segment| {
        let mut segment = segment.as_obj().cloned().unwrap_or_default();
        for key in SOURCE_LOCATORS {
            segment.remove(key);
        }
        if legacy {
            let flag = first(&segment, &["is_static", "static_raw"]).is_some_and(Value::truthy);
            let aux = (to_int32(segment.get("aux_code").and_then(Value::as_f64).unwrap_or(0.0)) & 254) | i32::from(flag);
            segment.set("aux_code", Value::Num(f64::from(aux)));
            let primitive = segment.get("primitive_code").and_then(Value::as_f64);
            if matches!(primitive, Some(2.0 | 5.0)) {
                let index = first(&segment, &["image_asset_index", "sprite_index"]).cloned().unwrap_or(Value::Num(0.0));
                if blank(segment.get("extra_u16")) {
                    segment.set("extra_u16", index);
                }
                let flip = first(&segment, &["image_flip", "sprite_flip"]).cloned().unwrap_or(Value::Num(0.0));
                if blank(segment.get("extra_u8_a")) {
                    segment.set("extra_u8_a", flip);
                }
                if blank(segment.get("extra_u8_b")) {
                    segment.set("extra_u8_b", Value::Num(0.0));
                }
            }
            segment.set("flags", Value::Num(f64::from(to_int32(primitive.unwrap_or(0.0)) | (aux << 8))));
        }
        Value::object(segment)
    }).collect();
    next.set("segments", Value::array(segments));
    if legacy {
        next.set("implicit", Value::Bool(false));
    }
    if let Some(clip) = figure.path(&["_styk", "movieclip"]).filter(|clip| clip.truthy()) {
        if let Some(document) = clip.get("document") {
            let mut asset = clip.as_obj().cloned().unwrap_or_default();
            asset.set("document", portable_clip_document(document));
            let mut styk = figure.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
            styk.set("movieclip", Value::object(asset));
            next.set("_styk", Value::object(styk));
        }
    }
    Value::object(next)
}

fn to_int32(x: f64) -> i32 {
    crate::recolor::to_int32(x)
}

/// The nested document of a portable movieclip: every figure portable, down the retained sources.
fn portable_clip_document(document: &Value) -> Value {
    let legacy = document.get("version").and_then(Value::as_f64).is_some_and(|version| version < 5.0);
    let mut next = document.as_obj().cloned().unwrap_or_default();
    next.set("figure_types", Value::array(items(document.get("figure_types")).iter().map(|figure| portable_figure(figure, legacy)).collect()));
    if let Some(source) = document.path(&["_styk", "movieclipSource", "document"]).filter(|source| source.truthy()) {
        let mut styk = document.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        let mut retained = styk.get("movieclipSource").and_then(Value::as_obj).cloned().unwrap_or_default();
        retained.set("document", portable_clip_document(source));
        styk.set("movieclipSource", Value::object(retained));
        next.set("_styk", Value::object(styk));
    }
    Value::object(next)
}

/// `portableBackground(background)`.
pub(crate) fn portable_background(background: &Value) -> Value {
    let mut next = portable_asset(background, false);
    // A background that is not an object (a document the engine would not have opened) is left as it is.
    if let Some(object) = next.make_obj() {
        if !object.get("data_url").is_some_and(Value::truthy) && object.get("data_uri").is_some_and(Value::truthy) {
            let uri = object.get("data_uri").cloned().unwrap_or(Value::Null);
            object.set("data_url", uri);
        }
        if object.get("data_url").is_some_and(Value::truthy) {
            object.remove("data_uri");
            object.remove("data_base64");
        }
        if let Some(kind) = object.get("kind").and_then(Value::as_str) {
            let jpeg = kind.contains("jpg") || kind.contains("jpeg");
            object.set("kind", Value::Num(if jpeg { 1.0 } else { 0.0 }));
        }
    }
    next
}

/// `portableFigures(figures)` of a document that is not legacy: the definitions as the file keeps them. Movieclip
/// documents leave out the import archive they carry (original sources belong to projects, not portable clips).
fn portable_figures(figures: &[Value]) -> Vec<Value> {
    figures.iter().map(|figure| {
        let Some(clip) = figure.path(&["_styk", "movieclip"]).filter(|clip| clip.get("document").is_some()) else { return figure.clone() };
        let mut asset = clip.as_obj().cloned().unwrap_or_default();
        asset.set("document", without_source(clip.get("document").unwrap()));
        let mut styk = figure.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        styk.set("movieclip", Value::object(asset));
        let mut next = figure.as_obj().cloned().unwrap_or_default();
        next.set("_styk", Value::object(styk));
        Value::object(next)
    }).collect()
}

/// `portableDocument(document)`: a clip document without its `_stykSource`, nested clips likewise.
fn without_source(document: &Value) -> Value {
    let mut result = document.as_obj().cloned().unwrap_or_default();
    result.remove("_stykSource");
    result.set("figure_types", Value::array(portable_figures(&items(document.get("figure_types")))));
    if let Some(source) = document.path(&["_styk", "movieclipSource", "document"]).filter(|source| source.truthy()) {
        let mut styk = document.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        let mut retained = document.path(&["_styk", "movieclipSource"]).and_then(Value::as_obj).cloned().unwrap_or_default();
        retained.set("document", without_source(source));
        styk.set("movieclipSource", Value::object(retained));
        result.set("_styk", Value::object(styk));
    }
    Value::object(result)
}

/// `Math.max(1, Math.ceil(clip.duration * fps / clip.document.fps))`: how long the instance plays a clip in this document's ticks.
fn clip_instance(clip: &Value, fps: f64) -> Value {
    let duration = number(clip, "duration").unwrap_or(f64::NAN);
    let clip_fps = clip.get("document").and_then(|document| number(document, "fps")).unwrap_or(f64::NAN);
    let end = (duration * fps / clip_fps).ceil();
    let mut playback = Obj::new();
    playback.set("start", Value::Num(0.0));
    playback.set("end", Value::Num(if end.is_nan() { f64::NAN } else { end.max(1.0) }));
    playback.set("offset", Value::Num(0.0));
    playback.set("speed", Value::Num(1.0));
    playback.set("mode", Value::str("loop"));
    Value::object(playback)
}

/// What a library file or a figure export saves.
#[derive(Clone, Debug, Default)]
pub struct FigureRequest {
    pub figure_type_id: Option<f64>,
    pub figure_uid: Option<f64>,
    pub figure_uids: Vec<f64>,
    pub tick: f64,
}

impl Context {
    /// `nativeFigureDocument(report, {figureTypeId, figureUid, figureUids, tick, sourceFrame})`.
    pub(crate) fn native_figure_document(&self, request: &FigureRequest, source_frame: Option<&Value>) -> Result<Value, EditError> {
        let report = &self.report;
        let fps = number(report, "fps").unwrap_or(f64::NAN);
        let frame = match source_frame {
            Some(frame) => frame.clone(),
            None => self.frame_at(request.tick)?,
        };
        let objects = items(frame.get("objects"));
        let of = |key: &str| report.get(key).cloned().unwrap_or(Value::Null);
        let mut document = Obj::new();
        for key in ["version", "canvas_width", "canvas_height", "fps"] {
            document.set(key, of(key));
        }
        document.set("auto_easing", Value::Bool(false));
        document.set("auto_easing_disabled_raw", Value::Num(1.0));
        let figures_of = |wanted: &dyn Fn(f64) -> bool| -> Vec<Value> {
            items(report.get("figure_types")).into_iter().filter(|figure| number(figure, "figure_type_id").is_some_and(wanted)).collect()
        };
        if !request.figure_uids.is_empty() {
            let selected = |uid: Option<f64>| uid.is_some_and(|uid| request.figure_uids.contains(&uid));
            let sources: Vec<&Value> = objects.iter().filter(|object| selected(number(object, "unique_id"))).collect();
            if sources.is_empty() {
                return Err(EditError::Invalid("errors.nativeFigure.selectFiguresToSaveToTheLibrary".into()));
            }
            let slots: Vec<Option<f64>> = sources.iter().map(|object| number(object, "object_slot")).collect();
            let solved = self.solved(&frame)?;
            let types: Vec<f64> = sources.iter().filter_map(|object| number(object, "figure_type_id")).collect();
            let figures = figures_of(&|id| types.contains(&id));
            if figures.is_empty() {
                return Err(EditError::Invalid("errors.nativeFigure.selectFiguresToSaveToTheLibrary".into()));
            }
            let mut saved: Vec<Value> = Vec::new();
            for (at, source) in sources.iter().enumerate() {
                let mut object = source.as_obj().cloned().unwrap_or_default();
                object.set("object_slot", Value::Num(at as f64));
                for key in ["_stykMovieclipPart", "runtime_segments", "_movieclipSample"] {
                    object.remove(key);
                }
                let join = source.get("join").filter(|join| join.truthy());
                let target = join.and_then(|join| number(join, "target_object_slot"));
                match (join, target.and_then(|target| slots.iter().position(|slot| *slot == Some(target)))) {
                    (Some(join), Some(position)) => {
                        let mut join = join.as_obj().cloned().unwrap_or_default();
                        join.set("target_object_slot", Value::Num(position as f64));
                        object.set("join", Value::object(join));
                    }
                    _ => {
                        object.set("join", Value::Null);
                        if join.is_some() || source.get("_stykIK").is_some_and(Value::truthy) {
                            let slot = number(source, "object_slot").map(|slot| slot as usize);
                            let solved = slot.and_then(|slot| solved.get(slot)).and_then(Option::as_ref).ok_or_else(|| EditError::Unported("an exported figure without geometry".into()))?;
                            object.set("root_x", Value::Num(solved.root[0]));
                            object.set("root_y", Value::Num(solved.root[1]));
                            if let Some(angles) = &solved.angles {
                                object.set("angles", Value::array(angles.iter().map(|&angle| Value::Num(angle)).collect()));
                            }
                        }
                    }
                }
                let type_id = number(&Value::object(object.clone()), "figure_type_id");
                if let Some(clip) = figures.iter().find(|figure| number(figure, "figure_type_id") == type_id).and_then(|figure| figure.path(&["_styk", "movieclip"])).filter(|clip| clip.truthy()) {
                    object.set("_stykMovieclip", clip_instance(clip, fps));
                }
                saved.push(Value::object(object));
            }
            let mut frame_out = create_frame(&saved);
            let chosen: Vec<Value> = frame_order(&frame).into_iter().filter(|id| request.figure_uids.contains(id)).map(Value::Num).collect();
            set_order(&mut frame_out, &chosen);
            document.set("figure_types", Value::array(portable_figures(&figures)));
            document.set("backgrounds", Value::array(Vec::new()));
            document.set("keyframes", Value::array(vec![frame_out]));
            let mut styk = Obj::new();
            styk.set("format", Value::str("StykAnimate"));
            styk.set("format_version", Value::Num(1.0));
            let name = |figure: &Value| figure.get("name").filter(|name| name.truthy()).cloned().unwrap_or_else(|| Value::str("Figure"));
            styk.set("name", if sources.len() == 1 { name(&figures[0]) } else { Value::str("Figure set") });
            styk.set("libraryKind", Value::str(if sources.len() > 1 { "set" } else if figures[0].path(&["_styk", "movieclip"]).is_some_and(Value::truthy) { "movieclip" } else { "figure" }));
            document.set("_styk", Value::object(styk));
            return Ok(Value::object(document));
        }
        let source = objects.iter().find(|object| match request.figure_uid {
            None => number(object, "figure_type_id") == request.figure_type_id,
            Some(uid) => number(object, "unique_id") == Some(uid),
        });
        let figure = source.and_then(|source| items(report.get("figure_types")).into_iter().find(|figure| number(figure, "figure_type_id") == number(source, "figure_type_id")));
        let (Some(source), Some(figure)) = (source, figure) else {
            return Err(EditError::Invalid("errors.nativeFigure.selectAFigureOrMovieclipToExport".into()));
        };
        let mut object = source.as_obj().cloned().unwrap_or_default();
        object.set("object_slot", Value::Num(0.0));
        object.set("join", Value::Null);
        object.remove("_stykMovieclipPart");
        if source.get("_stykIK").is_some_and(Value::truthy) || source.get("join").is_some_and(Value::truthy) {
            let solved = self.solved(&frame)?;
            let slot = number(source, "object_slot").map(|slot| slot as usize);
            let solved = slot.and_then(|slot| solved.get(slot)).and_then(Option::as_ref).ok_or_else(|| EditError::Unported("an exported figure without geometry".into()))?;
            object.set("root_x", Value::Num(solved.root[0]));
            object.set("root_y", Value::Num(solved.root[1]));
            if let Some(angles) = &solved.angles {
                object.set("angles", Value::array(angles.iter().map(|&angle| Value::Num(angle)).collect()));
            }
        }
        object.remove("runtime_segments");
        object.remove("_movieclipSample");
        if let Some(clip) = figure.path(&["_styk", "movieclip"]).filter(|clip| clip.truthy()) {
            object.set("_stykMovieclip", clip_instance(clip, fps));
        }
        document.set("figure_types", Value::array(portable_figures(&[figure.clone()])));
        document.set("backgrounds", Value::array(Vec::new()));
        document.set("keyframes", Value::array(vec![create_frame(&[Value::object(object)])]));
        let mut styk = Obj::new();
        styk.set("format", Value::str("StykAnimate"));
        styk.set("format_version", Value::Num(1.0));
        styk.set("name", figure.get("name").filter(|name| name.truthy()).cloned().unwrap_or_else(|| Value::str("Figure")));
        document.set("_styk", Value::object(styk));
        Ok(Value::object(document))
    }
}

/// `frameOrder(frame)`: the unique ids in drawing order.
fn frame_order(frame: &Value) -> Vec<f64> {
    let objects = items(frame.get("objects"));
    let order: Vec<f64> = frame.get("object_draw_order").and_then(Value::numbers).unwrap_or_else(|| (0..objects.len()).map(|slot| slot as f64).collect());
    order.into_iter().filter_map(|slot| objects.get(slot as usize).and_then(|object| number(object, "unique_id"))).collect()
}

/// `setOrder(frame, ids)`.
fn set_order(frame: &mut Value, ids: &[Value]) {
    let objects = items(frame.get("objects"));
    let slots: Vec<Value> = ids.iter().map(|id| objects.iter().position(|object| object.get("unique_id") == Some(id)).map_or(Value::Null, |slot| Value::Num(slot as f64))).collect();
    set(frame, "object_draw_order_unique_ids", Value::array(ids.to_vec()));
    set(frame, "object_draw_order", Value::array(slots));
}

impl Editor {
    /// `nativeFigureDocument` of the open document for the figures `request` names, from the frame on show when the
    /// interface has one (`source_frame`).
    pub fn native_figure(&self, request: &FigureRequest, source_frame: Option<&Value>) -> Result<Value, EditError> {
        let context = Context::of_editor(self)?;
        context.native_figure_document(request, source_frame)
    }
}
