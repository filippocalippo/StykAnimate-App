//! Explicit editable movieclip expansion.
//! Playback keeps immutable clips; only conversion commands call this owner.
//! Record sampling and world roots come from the existing evaluator and geometry.
use crate::{
    eval::Prepared,
    geometry,
    load::Loader,
    records::{Error, Records},
};
use std::collections::HashMap;
use std::sync::Arc;
use styk_doc::{Obj, Value};

fn items(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::elements).map(|e| e.iter().collect()).unwrap_or_default()
}
fn num(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}
fn clip(figure: &Value) -> bool {
    figure.path(&["_styk", "movieclip"]).is_some_and(Value::truthy)
}
fn unsupported<T>(reason: &str) -> Result<T, Error> {
    Err(Error::Unported(reason.into()))
}
fn invalid<T>(key: &str) -> Result<T, Error> {
    Err(Error::Invalid(format!("errors.movieclipMaterialize.{key}")))
}
fn signature(figure: &Value) -> String {
    let mut data = figure.as_obj().cloned().unwrap_or_default();
    data.remove("figure_type_id");
    styk_doc::json::to_string(&Value::object(data))
}
#[derive(Clone, Copy)]
struct Transform {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    x: f64,
    y: f64,
    angle: f64,
    flip: f64,
    scale: f64,
    opacity: f64,
}
impl Transform {
    fn point(self, p: [f64; 2]) -> [f64; 2] {
        [self.x + self.a * p[0] + self.c * p[1], self.y + self.b * p[0] + self.d * p[1]]
    }
}

/// What a conversion has allocated so far: the definitions it made and the identities it gave. A conversion in slices
/// (`Materializer::into_state`, `Materializer::resume`) carries it from one slice to the next.
pub struct MaterializerState {
    figures: Vec<Value>,
    identities: Obj,
    types: HashMap<(usize, u32), u32>,
    signatures: HashMap<String, u32>,
    next_type: u32,
    next_uid: u32,
}

/// One conversion's definition and identity allocator. Reuse it across frames so
/// a nested path keeps one UID and each imported definition is shared.
/// The largest object identity the editor allocates.
const MAX_ALLOCATED_UID: f64 = 2_147_483_646.0;

pub struct Materializer<'a> {
    report: &'a Value,
    prepared: &'a Prepared,
    figures: Vec<Value>,
    identities: Obj,
    types: HashMap<(usize, u32), u32>,
    signatures: HashMap<String, u32>,
    next_type: u32,
    next_uid: u32,
}
impl<'a> Materializer<'a> {
    pub fn new(report: &'a Value, prepared: &'a Prepared) -> Result<Self, Error> {
        let all = items(report.get("figure_types"));
        let figures: Vec<_> = all.iter().filter(|f| !clip(f)).cloned().collect();
        let next_type = all.iter().filter_map(|f| num(f, "figure_type_id")).fold(1.0f64, |n, id| n.max(id + 1.0)) as u32;
        let sources = report.path(&["_styk", "frameSources"]).and_then(Value::as_obj);
        let mut next_uid = 1u32;
        for frame in items(report.get("keyframes")).into_iter().chain(sources.into_iter().flat_map(|s| s.iter().map(|(_, f)| f.clone()))) {
            for object in items(frame.get("objects")) {
                // Pivot writes identities above 2^31: they stay as they are and never collide with the ones allocated here
                // (`nextUidAfter`).
                if let Some(id) = num(&object, "unique_id").filter(|id| *id <= MAX_ALLOCATED_UID) {
                    next_uid = next_uid.max(id as u32 + 1);
                }
            }
        }
        let signatures = figures.iter().filter_map(|f| Some((signature(f), num(f, "figure_type_id")? as u32))).collect();
        Ok(Self { report, prepared, figures, identities: Obj::new(), types: HashMap::new(), signatures, next_type, next_uid })
    }
    /// The conversion carried on from `state`, over the same document.
    pub fn resume(report: &'a Value, prepared: &'a Prepared, state: MaterializerState) -> Self {
        let MaterializerState { figures, identities, types, signatures, next_type, next_uid } = state;
        Self { report, prepared, figures, identities, types, signatures, next_type, next_uid }
    }
    /// What the conversion has allocated, to carry on with later.
    pub fn into_state(self) -> MaterializerState {
        MaterializerState { figures: self.figures, identities: self.identities, types: self.types, signatures: self.signatures, next_type: self.next_type, next_uid: self.next_uid }
    }
    pub fn figures(&self) -> &[Value] {
        &self.figures
    }
    pub fn identities(&self) -> impl Iterator<Item = (&str, u32)> {
        self.identities.iter().map(|(path, id)| (&**path, id.as_f64().unwrap() as u32))
    }
    fn identity(&mut self, path: &str) -> Result<u32, Error> {
        if let Some(id) = self.identities.get(path).and_then(Value::as_f64) {
            return Ok(id as u32);
        }
        let id = self.next_uid;
        self.next_uid = id.checked_add(1).ok_or_else(|| Error::Unported("materialization exhausted native identities".into()))?;
        self.identities.set(path, Value::Num(id as f64));
        Ok(id)
    }
    fn figure_type(&mut self, document: &Value, object: &Value) -> Result<u32, Error> {
        let id = num(object, "figure_type_id").unwrap_or(0.0) as u32;
        if document.same_node(self.report) {
            return Ok(id);
        }
        let address = match document {
            Value::Obj(o) => Arc::as_ptr(o) as usize,
            _ => return unsupported("invalid materialization document"),
        };
        if let Some(id) = self.types.get(&(address, id)) {
            return Ok(*id);
        }
        let figure = items(document.get("figure_types")).into_iter().find(|f| num(f, "figure_type_id") == Some(id as f64)).ok_or_else(|| Error::Invalid("missing materialized figure".into()))?;
        let signature = signature(&figure);
        let next = if let Some(id) = self.signatures.get(&signature) {
            *id
        } else {
            if self.next_type > 65535 {
                return invalid("flatteningMovieclipsExceedsTheFigureLimit");
            }
            let next = self.next_type;
            self.next_type += 1;
            let mut figure = figure.as_obj().cloned().unwrap();
            figure.set("figure_type_id", Value::Num(next as f64));
            self.figures.push(Value::object(figure));
            self.signatures.insert(signature, next);
            next
        };
        self.types.insert((address, id), next);
        Ok(next)
    }
    /// `materializeMeshGeometry`: a 3D mesh clip as the figure of its own that draws the faces it shows now (each triangle a
    /// depth-tested fill over three reference joints and a depth guide for each corner), and its instance.
    fn bake_mesh(&mut self, scene: &geometry::Scene, slot: usize, clip: &Value, object: &Value, transform: Transform, path: &str) -> Result<Value, Error> {
        if self.next_type > 65535 {
            return invalid("flatteningMovieclipsExceedsTheFigureLimit");
        }
        let type_id = self.next_type;
        self.next_type += 1;
        let uid = self.identity(path)?;
        let mut segments: Vec<Value> = Vec::new();
        let mut add = |x: f64, y: f64| -> f64 {
            let id = segments.len() as f64 + 1.0;
            let mut segment = Obj::new();
            segment.set("segment_id", Value::Num(id));
            segment.set("parent_id", Value::Num(0.0));
            segment.set("length", Value::Num(styk_math::hypot(x, y)));
            segment.set("angle_rad", Value::Num(styk_math::atan2(y, x)));
            segment.set("thickness", Value::Num(0.0));
            segment.set("bend_rad", Value::Num(0.0));
            segment.set("primitive_code", Value::Num(0.0));
            segment.set("aux_code", Value::Num(1.0));
            segment.set("flags", Value::Num(256.0));
            segment.set("visible", Value::Bool(false));
            segment.set("color_rgb", Value::nums(&[0.0, 0.0, 0.0]));
            segment.set("z_order", Value::Num(0.0));
            segments.push(Value::object(segment));
            id
        };
        let (x, y) = (add(1.0, 0.0), add(0.0, 1.0));
        let basis = Value::nums(&[0.0, x, y]);
        // A corner is a pair of joints, its position and its depth; corners that coincide share them (-0 and 0 alike, as keys of text).
        let norm = |value: f64| if value == 0.0 { 0u64 } else { value.to_bits() };
        let mut corners: HashMap<(u64, u64, u64), [f64; 2]> = HashMap::new();
        let mut fills: Vec<Value> = Vec::new();
        for item in scene.items.iter().filter(|item| item.slot as usize == slot && item.kind == geometry::ItemKind::Mesh) {
            let Some(mesh) = scene.mesh_of(item) else { continue };
            for face in item.faces.0 as usize..item.faces.1 as usize {
                let mut points = [[0.0f64; 2]; 3];
                let mut depths = [0.0f64; 3];
                let mut joints = [[0.0f64; 2]; 3];
                for k in 0..3 {
                    let vertex = mesh.triangles[face * 3 + k] as usize;
                    points[k] = transform.point([f64::from(mesh.positions[vertex * 2]), f64::from(mesh.positions[vertex * 2 + 1])]);
                    depths[k] = f64::from(mesh.depth[vertex]);
                    let key = (norm(points[k][0]), norm(points[k][1]), norm(depths[k]));
                    joints[k] = match corners.get(&key) {
                        Some(known) => *known,
                        None => {
                            let made = [add(points[k][0], points[k][1]), add(depths[k], 0.0)];
                            corners.insert(key, made);
                            made
                        }
                    };
                }
                let [a, b, c] = points;
                let flipped = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0.0;
                let mut surface = Obj::new();
                surface.set("basis", basis.clone());
                surface.set("depth", Value::nums(&joints.map(|joint| joint[1])));
                surface.set("depthTest", Value::Bool(true));
                surface.set("flipped", Value::Bool(flipped));
                let color = mesh.colors.get(mesh.materials[face] as usize).copied().unwrap_or([0, 0, 0]);
                let mut fill = Obj::new();
                fill.set("polyfill_id", Value::Num(fills.len() as f64 + 1.0));
                fill.set("segment_ids", Value::nums(&joints.map(|joint| joint[0])));
                fill.set("color_rgb", Value::nums(&color.map(f64::from)));
                fill.set("color_alpha", Value::Num(1.0));
                fill.set("z_order", Value::Num(0.0));
                fill.set("_stykSurface", Value::object(surface));
                fills.push(Value::object(fill));
            }
        }
        let angles: Vec<f64> = segments.iter().map(|segment| num(segment, "angle_rad").unwrap_or(f64::NAN)).collect();
        let mut figure = Obj::new();
        figure.set("figure_type_id", Value::Num(f64::from(type_id)));
        if let Some(name) = clip.get("name") {
            figure.set("name", name.clone());
        }
        let count = segments.len() as f64;
        figure.set("segments", Value::array(segments));
        figure.set("segment_count", Value::Num(count));
        figure.set("polyfills", Value::array(fills));
        figure.set("image_assets", Value::array(Vec::new()));
        figure.set("text_assets", Value::array(Vec::new()));
        self.figures.push(Value::object(figure));
        let opacity = transform.opacity * (1.0 - num(object, "field28").unwrap_or(0.0) / 255.0);
        let mut baked = Obj::new();
        baked.set("object_slot", Value::Num(0.0));
        baked.set("unique_id", Value::Num(f64::from(uid)));
        baked.set("figure_type_id", Value::Num(f64::from(type_id)));
        baked.set("root_x", Value::Num(0.0));
        baked.set("root_y", Value::Num(0.0));
        baked.set("scale", Value::Num(1.0));
        baked.set("color_override_raw", Value::Num(0.0));
        baked.set("field28", Value::Num((255.0 * (1.0 - opacity) + 0.5).floor()));
        baked.set("angles", Value::nums(&angles));
        baked.set("len_flag", Value::Num(0.0));
        baked.set("lengths", Value::array(Vec::new()));
        baked.set("bend_flag", Value::Num(0.0));
        baked.set("bends", Value::array(Vec::new()));
        baked.set("join", Value::Null);
        Ok(Value::object(baked))
    }

    /// `frame` is an editor-shaped evaluated record, including `_movieclipSample`.
    pub fn frame(&mut self, frame: &Value) -> Result<Value, Error> {
        let mut output = Vec::new();
        self.expand(self.report, self.prepared, frame, Transform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, x: 0.0, y: 0.0, angle: 0.0, flip: 1.0, scale: 1.0, opacity: 1.0 }, "", &mut output)?;
        let mut result = frame.as_obj().cloned().unwrap_or_default();
        for (slot, object) in output.iter_mut().enumerate() {
            object.make_obj().unwrap().set("object_slot", Value::Num(slot as f64));
        }
        result.set("object_draw_order", Value::array((0..output.len()).map(|i| Value::Num(i as f64)).collect()));
        result.set("object_draw_order_unique_ids", Value::array(output.iter().map(|o| o.get("unique_id").cloned().unwrap_or(Value::Null)).collect()));
        result.set("objects", Value::array(output));
        let mut styk = result.get("_styk").and_then(Value::as_obj).cloned().unwrap_or_default();
        styk.remove("movieclipContinuations");
        result.set("_styk", Value::object(styk));
        Ok(Value::object(result))
    }
    fn expand(&mut self, document: &Value, prepared: &Prepared, frame: &Value, transform: Transform, path: &str, output: &mut Vec<Value>) -> Result<(), Error> {
        let typed = Loader::new().edit_frame(frame, None, &prepared.doc).map_err(|e| Error::Invalid(e.to_string()))?;
        // Shapes are built for the inverse kinematics each figure solved (`solvedAngles`, `solvedLengths`).
        let scene = geometry::build_shapes(&prepared.doc, &typed, None);
        let objects = items(frame.get("objects"));
        let order = frame.get("object_draw_order").and_then(Value::numbers).unwrap_or_else(|| (0..objects.len()).map(|i| i as f64).collect());
        let definitions = items(document.get("figure_types"));
        let mut anchors = HashMap::new();
        let mut joined = Vec::new();
        for slot in order.into_iter().map(|i| i as usize) {
            let (Some(object), Some(g), Some(pose)) = (objects.get(slot), scene.objects.get(slot), typed.objects.get(slot)) else { continue };
            if !g.resolved {
                continue;
            }
            if let Some(layers) = &prepared.doc.layers {
                let layer = layers.assignments.get(&pose.uid).unwrap_or(&layers.default_layer);
                if layers.hidden.contains(layer) {
                    continue;
                }
            }
            let Some(figure) = definitions.iter().find(|f| num(f, "figure_type_id") == Some(pose.figure as f64)) else { continue };
            let Some(typed_figure) = prepared.doc.figure(pose.figure) else { continue };
            let id = if path.is_empty() { pose.uid.to_string() } else { format!("{path}/{}", pose.uid) };
            if let Some(asset) = &typed_figure.movieclip {
                if object.get("_movieclipSample").is_some_and(Value::is_null) {
                    continue;
                }
                if object.get("_stykVfx").is_some_and(Value::truthy) {
                    return invalid("thisMovieclipHasContainerEffectsKeepItAs");
                }
                if asset.meshes.is_some() {
                    // A 3D mesh clip becomes a figure of its own, with a face for each triangle it shows.
                    anchors.insert(slot, output.len());
                    let baked = self.bake_mesh(&scene, slot, figure, object, transform, &id)?;
                    output.push(baked);
                    continue;
                }
                let drawing = geometry::drawing_view(&typed, &scene, slot);
                let raw = figure.path(&["_styk", "movieclip", "document"]).ok_or_else(|| Error::Invalid("missing movieclip document".into()))?;
                let local = Records::new(raw, &asset.prepared)?.evaluated_with(asset.source_start + drawing.map_or(pose.clip_time.unwrap_or(0.0), |view| view.frame), true)?;
                if local.get("_stykVfx").is_some_and(Value::truthy) {
                    return invalid("thisMovieclipHasSceneEffectsKeepItAs");
                }
                let angle = drawing.map_or(pose.angles.first().copied().unwrap_or(0.0), |view| view.angle);
                let scale = drawing.map_or(pose.scale, |view| view.scale);
                let c = styk_math::cos(angle) * scale;
                let d = styk_math::sin(angle) * scale;
                let root = transform.point(g.root);
                let flip = drawing.map_or(if pose.image_text_flags { -1.0 } else { 1.0 }, |view| view.flip);
                let a = transform.a * c + transform.c * d;
                let b = transform.b * c + transform.d * d;
                let cy = (-transform.a * d + transform.c * c) * flip;
                let dy = (-transform.b * d + transform.d * c) * flip;
                let opacity = transform.opacity * (1.0 - num(object, "field28").unwrap_or(0.0) / 255.0);
                if opacity < 1.0 && items(local.get("objects")).len() > 1 {
                    return invalid("pivotCannotPreserveMovieclipGroupOpacityAcrossMultiple");
                }
                anchors.insert(slot, output.len());
                self.expand(
                    raw,
                    &asset.prepared,
                    &local,
                    Transform {
                        a,
                        b,
                        c: cy,
                        d: dy,
                        x: root[0] - a * asset.pivot[0] - cy * asset.pivot[1],
                        y: root[1] - b * asset.pivot[0] - dy * asset.pivot[1],
                        angle: transform.angle + angle * transform.flip,
                        flip: transform.flip * flip,
                        scale: transform.scale * scale,
                        opacity,
                    },
                    &id,
                    output,
                )?;
                continue;
            }
            anchors.insert(slot, output.len());
            let root = transform.point(g.root);
            let mut next = object.as_obj().cloned().unwrap_or_default();
            next.set("unique_id", Value::Num(if path.is_empty() { pose.uid } else { self.identity(&id)? } as f64));
            let type_id = self.figure_type(document, object)? as f64;
            next.set("figure_type_id", Value::Num(type_id));
            next.set("root_x", Value::Num(root[0]));
            next.set("root_y", Value::Num(root[1]));
            next.set("join", object.get("join").filter(|v| v.truthy()).cloned().unwrap_or(Value::Null));
            next.set("scale", Value::Num(pose.scale * transform.scale));
            // A figure with enabled IK controllers is expanded as they solved it; a rig, an origin or a 3D pose is copied as it is.
            let solved = g.solution.as_ref();
            let angles = solved.map_or(&pose.angles[..], |solution| &solution.angles[..]);
            next.set("angles", Value::array(angles.iter().map(|a| Value::Num(a * transform.flip + transform.angle)).collect()));
            next.set("field28", Value::Num((255.0 * (1.0 - transform.opacity * (1.0 - num(object, "field28").unwrap_or(0.0) / 255.0)) + 0.5).floor()));
            if transform.flip < 0.0 {
                next.set("image_text_flags", Value::Num(if object.get("image_text_flags").is_some_and(Value::truthy) { 0.0 } else { 1.0 }));
                next.set("bend_flag", Value::Num(1.0));
                next.set("bends", Value::array(typed_figure.segments.iter().enumerate().map(|(i, s)| Value::Num(-pose.bends.as_ref().and_then(|b| b.get(i)).copied().unwrap_or(s.bend))).collect()));
            }
            crate::vfx::remap_owner(&mut next, type_id, None, pose.figure as f64);
            if let Some(lengths) = solved.and_then(|solution| solution.lengths.as_ref()) {
                next.set("len_flag", Value::Num(1.0));
                next.set("lengths", Value::array(lengths.iter().map(|&length| Value::Num(length)).collect()));
            }
            for key in ["runtime_segments", "_stykIK", "_stykAnimationOrigin", "_stykMovieclip", "_movieclipSample", "_stykMovieclipPart"] {
                next.remove(key);
            }
            if next.get("join").is_some_and(Value::truthy) {
                joined.push(output.len());
            }
            output.push(Value::object(next));
        }
        for index in joined {
            let object = output[index].as_obj().unwrap();
            let join = object.get("join").unwrap();
            let target = num(join, "target_object_slot").unwrap_or(f64::NAN) as usize;
            let anchor = anchors.get(&target).copied();
            let target_clip = objects.get(target).and_then(|o| num(o, "figure_type_id")).and_then(|id| definitions.iter().find(|f| num(f, "figure_type_id") == Some(id))).is_some_and(clip);
            let join = match anchor.filter(|_| !target_clip) {
                Some(anchor) => {
                    let mut join = join.as_obj().cloned().unwrap();
                    join.set("target_object_slot", Value::Num(anchor as f64));
                    join.set("target_unique_id", output[anchor].get("unique_id").cloned().unwrap_or(Value::Null));
                    Value::object(join)
                }
                None => Value::Null,
            };
            output[index].make_obj().unwrap().set("join", join);
        }
        Ok(())
    }
}
