//! Parity with the JavaScript editor: compares what this engine evaluates with
//! a recorded reference dump of the editor's evaluation (every drawable and
//! every joint of the sampled ticks, the effects when the dump has them (see
//! [`crate::vfx::parity`]), what the scene camera does when it is shown, and the
//! background and outlines when the dump has them).
//!
//! `styk compare` and the fixture tests share this one comparison, so a
//! tolerance cannot drift between them.

use styk_doc::Value;

use crate::eval::Prepared;
use crate::geometry::{build, ItemKind, Scene};

/// Largest accepted difference of a coordinate or a thickness, in scene units.
pub const TOLERANCE: f64 = 2e-3;

/// The differences found at one tick, as readable lines.
#[derive(Clone, Debug)]
pub struct FrameReport {
    pub tick: f64,
    pub problems: Vec<String>,
}

/// The outcome of comparing a document with a reference dump.
#[derive(Clone, Debug, Default)]
pub struct Report {
    /// Sampled ticks in the reference.
    pub frames: usize,
    /// Drawables in the reference.
    pub primitives: usize,
    pub mismatched_primitives: usize,
    /// Joints in the reference (a root and one per segment of each object).
    pub joints: usize,
    pub mismatched_joints: usize,
    /// `(reference, engine)` when the timeline lengths differ.
    pub total_ticks: Option<(u32, u32)>,
    /// Effects, for references written with `--vfx`.
    pub vfx: crate::vfx::parity::Counts,
    /// Ticks whose shot camera and parallax offsets were compared (`--camera`).
    pub shots: usize,
    /// One entry per tick with differences, in tick order.
    pub bad_frames: Vec<FrameReport>,
}

impl Report {
    pub fn matches(&self) -> bool {
        self.bad_frames.is_empty()
    }
}

fn point(v: Option<&Value>) -> Option<[f64; 2]> {
    let a = v?.numbers()?;
    Some([*a.first()?, *a.get(1)?])
}

fn close(a: [f64; 2], b: [f64; 2]) -> bool {
    (a[0] - b[0]).abs() <= TOLERANCE && (a[1] - b[1]).abs() <= TOLERANCE
}

fn items(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_arr).unwrap_or(&[])
}

/// Lines kept per tick: enough to see what differs without flooding a report.
const LINES: usize = 6;

/// Compares every tick of `reference` (`frames[].drawables` and
/// `frames[].objects[].joints`) with the engine's scene at that tick.
pub fn compare(prepared: &Prepared, reference: &Value) -> Report {
    let mut report = Report::default();
    let reference_total = reference.get("totalTicks").and_then(Value::as_f64).unwrap_or(0.0) as u32;
    if reference_total != prepared.total_ticks {
        report.total_ticks = Some((reference_total, prepared.total_ticks));
    }
    for frame in items(reference.get("frames")) {
        let tick = frame.get("tick").and_then(Value::as_f64).unwrap_or(0.0);
        let evaluated = prepared.evaluate(tick);
        let scene: Scene = build(&prepared.doc, &evaluated);
        let mut problems: Vec<String> = Vec::new();
        report.frames += 1;
        drawables(&scene, items(frame.get("drawables")), items(frame.get("meshes")), &mut report, &mut problems);
        joints(prepared, &scene, items(frame.get("objects")), &mut report, &mut problems);
        outlines(prepared, &evaluated, items(frame.get("objects")), &mut problems);
        if let Some(expected) = frame.get("scene") {
            background_matches(&evaluated, expected, &mut problems);
        }
        if let Some(effects) = frame.get("vfx") {
            crate::vfx::parity::compare(prepared, &evaluated, effects, &mut report.vfx, &mut problems);
        }
        if let Some(shot) = frame.get("shot") {
            report.shots += 1;
            shot_matches(&evaluated, shot, &mut problems);
        }
        if !problems.is_empty() {
            report.bad_frames.push(FrameReport { tick, problems });
        }
    }
    report
}

/// Camera values and parallax offsets: the same arithmetic as the editor's, up to the
/// last bits of `Math.exp` and `Math.log` (follow clips' zoom).
fn close_value(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * a.abs().max(1.0)
}

/// The shot camera (`cameraAtTime`) and each object's parallax offset against the
/// reference's `shot`. A missing or default camera is the identity, as drawing sees it.
fn shot_matches(frame: &crate::eval::Frame, shot: &Value, problems: &mut Vec<String>) {
    let identity = [0.0, 0.0, 1.0, 0.0];
    let expected = match shot.get("camera").filter(|c| !c.is_null()) {
        Some(c) if c.get("isDefault") != Some(&Value::Bool(true)) => ["x", "y", "scale", "angle"].map(|k| c.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN)),
        _ => identity,
    };
    let ours = match frame.camera {
        Some(c) if !c.is_default => [c.x, c.y, c.scale, c.angle],
        _ => identity,
    };
    if (0..4).any(|k| !close_value(expected[k], ours[k])) {
        problems.push(format!("shot camera {expected:?} vs {ours:?}"));
    }
    let offsets = items(shot.get("parallax"));
    if offsets.len() != frame.objects.len() {
        problems.push(format!("parallax: {} objects in the reference, {} in the engine", offsets.len(), frame.objects.len()));
        return;
    }
    for (slot, expected) in offsets.iter().enumerate() {
        let expected = point(Some(expected)).unwrap_or([f64::NAN; 2]);
        let ours = frame.parallax.as_ref().map_or([0.0, 0.0], |p| p.slots[slot]);
        // Lines are capped; a frame with any problem already counts as differing.
        if (!close_value(expected[0], ours[0]) || !close_value(expected[1], ours[1])) && problems.len() < LINES {
            problems.push(format!("parallax of slot {slot}: {expected:?} vs {ours:?}"));
        }
    }
}

/// The frame's background (`--scene`): image identities and mix exactly, and the colour key.
fn background_matches(frame: &crate::eval::Frame, expected: &Value, problems: &mut Vec<String>) {
    let ids = expected.get("background").and_then(Value::numbers).unwrap_or_default();
    let ours = [frame.background as f64, frame.background_b as f64, frame.background_mix];
    if ids.len() != 3 || (0..3).any(|k| ids[k] != ours[k]) {
        problems.push(format!("background {ids:?} vs {ours:?}"));
    }
    let color = expected.get("color").and_then(Value::as_f64);
    if color != frame.background_color.map(|c| c as f64) {
        problems.push(format!("background colour {color:?} vs {:?}", frame.background_color));
    }
}

/// Each object's outline (`--style`): what its resolved figure is drawn with.
fn outlines(prepared: &Prepared, frame: &crate::eval::Frame, expected: &[Value], problems: &mut Vec<String>) {
    for object in expected {
        let Some(want) = object.get("outline") else { continue };
        let slot = object.get("slot").and_then(Value::as_f64).unwrap_or(-1.0) as usize;
        let Some(ours) = frame.objects.get(slot) else { continue };
        let figure = ours.figure_override.as_ref().or_else(|| prepared.doc.figure(ours.figure));
        let have = figure.and_then(|f| f.outline.clone());
        let same = match (want, &have) {
            (Value::Null, None) => true,
            (Value::Null, Some(_)) | (_, None) => false,
            (want, Some(have)) => {
                let width = want.get("width").and_then(Value::as_f64).unwrap_or(f64::NAN);
                let rgb: Vec<u8> = want.get("rgb").and_then(Value::numbers).map(|a| a.iter().map(|&c| c as u8).collect()).unwrap_or_default();
                let alpha = want.get("alpha").and_then(Value::as_f64).unwrap_or(f64::NAN);
                (width - have.width).abs() <= TOLERANCE && rgb == have.rgb && (alpha - have.alpha).abs() <= 1e-4
            }
        };
        if !same && problems.len() < LINES {
            problems.push(format!("outline of slot {slot}: {want} vs {have:?}"));
        }
    }
}

/// Depths are ratios along a figure's reference axis or scene units over a
/// scale: compared within the coordinate tolerance, relative for large values.
fn close_depth(a: f64, b: f64) -> bool {
    (a - b).abs() <= TOLERANCE * a.abs().max(1.0)
}

/// A mesh drawable against the reference: the same faces in the same order
/// (vertex indices and palette entries exactly), and, for the mesh they index,
/// the same vertices, depths, colours and bounds (docs/engine/spatial.md).
fn mesh_faces(scene: &Scene, it: &crate::geometry::Item, expected: Option<&Value>, meshes: &[Value], why: &mut Vec<String>) {
    let (Some(expected), Some(mesh)) = (expected, scene.mesh_of(it)) else {
        why.push("mesh: missing in the reference or the engine".into());
        return;
    };
    let (a, b) = (it.faces.0 as usize, it.faces.1 as usize);
    if expected.get("index").and_then(Value::as_f64) != Some(it.index as f64) {
        why.push(format!("mesh drawable {} vs {}", expected.get("index").unwrap_or(&Value::Null), it.index));
    }
    if expected.get("count").and_then(Value::as_f64) != Some((b - a) as f64) {
        why.push(format!("mesh faces {} vs {}", expected.get("count").unwrap_or(&Value::Null), b - a));
        return;
    }
    let triangles = expected.get("triangles").and_then(Value::numbers).unwrap_or_default();
    if let Some(k) = (0..triangles.len().min((b - a) * 3)).find(|&k| triangles[k] != mesh.triangles[a * 3 + k] as f64) {
        why.push(format!("mesh face {} vertex {} vs {}", k / 3, triangles[k], mesh.triangles[a * 3 + k]));
    }
    let materials = expected.get("materials").and_then(Value::numbers).unwrap_or_default();
    if let Some(k) = (0..materials.len().min(b - a)).find(|&k| materials[k] != mesh.materials[a + k] as f64) {
        why.push(format!("mesh face {k} colour {} vs {}", materials[k], mesh.materials[a + k]));
    }
    let Some(geometry) = expected.get("id").and_then(Value::as_f64).and_then(|id| meshes.get(id as usize)) else {
        why.push("mesh: the reference has no geometry for it".into());
        return;
    };
    let positions = geometry.get("positions").and_then(Value::numbers).unwrap_or_default();
    if positions.len() != mesh.positions.len() {
        why.push(format!("mesh vertices {} vs {}", positions.len() / 2, mesh.positions.len() / 2));
    } else if let Some(k) = (0..positions.len()).find(|&k| (positions[k] - mesh.positions[k] as f64).abs() > TOLERANCE) {
        why.push(format!("mesh vertex {} {} vs {}", k / 2, positions[k], mesh.positions[k]));
    }
    let depth = geometry.get("depth").and_then(Value::numbers).unwrap_or_default();
    if depth.len() == mesh.depth.len()
        && let Some(k) = (0..depth.len()).find(|&k| !close_depth(depth[k], mesh.depth[k] as f64))
    {
        why.push(format!("mesh depth {k} {} vs {}", depth[k], mesh.depth[k]));
    }
    let colors: Vec<Vec<f64>> = geometry.get("colors").and_then(Value::elements).map(|c| c.iter().filter_map(|c| c.numbers()).collect()).unwrap_or_default();
    if colors.len() != mesh.colors.len() || colors.iter().zip(&mesh.colors).any(|(e, c)| e.len() != 3 || (0..3).any(|k| e[k] != c[k] as f64)) {
        why.push(format!("mesh colours {colors:?} vs {:?}", mesh.colors));
    }
    let bounds = geometry.get("bounds").and_then(Value::numbers);
    match (bounds, mesh.bounds) {
        (Some(e), Some(ours)) if e.len() == 4 => {
            if (0..4).any(|k| (e[k] - ours[k] as f64).abs() > TOLERANCE) {
                why.push(format!("mesh bounds {e:?} vs {ours:?}"));
            }
        }
        (None, None) => {}
        (e, ours) => why.push(format!("mesh bounds {e:?} vs {ours:?}")),
    }
    for (key, ours) in [("zMin", mesh.z_min), ("zMax", mesh.z_max)] {
        if let Some(e) = geometry.get(key).and_then(Value::as_f64)
            && !close_depth(e, ours as f64)
        {
            why.push(format!("mesh {key} {e} vs {ours}"));
        }
    }
}

fn drawables(scene: &Scene, expected: &[Value], meshes: &[Value], report: &mut Report, problems: &mut Vec<String>) {
    report.primitives += expected.len();
    if expected.len() != scene.items.len() {
        problems.push(format!("drawable count: reference {}, engine {}", expected.len(), scene.items.len()));
    }
    for (i, (e, it)) in expected.iter().zip(scene.items.iter()).enumerate() {
        let uid = scene.objects[it.slot as usize].uid;
        let mut why = Vec::new();
        if e.get("uid").and_then(Value::as_f64) != Some(uid as f64) {
            why.push(format!("uid {} vs {}", e.get("uid").unwrap_or(&Value::Null), uid));
        }
        if e.get("type").and_then(Value::as_str) != Some(it.kind.name()) {
            why.push(format!("type {} vs {}", e.get("type").unwrap_or(&Value::Null), it.kind.name()));
        }
        if let Some(z) = e.get("z").and_then(Value::as_f64)
            && (z - it.z).abs() > 1e-6
        {
            why.push(format!("z {z} vs {}", it.z));
        }
        let rgb: Vec<u8> = e.get("rgb").and_then(Value::numbers).map(|a| a.iter().map(|&x| x as u8).collect()).unwrap_or_default();
        if rgb.len() == 3 && rgb != it.rgb {
            why.push(format!("rgb {rgb:?} vs {:?}", it.rgb));
        }
        for (key, value) in [("alpha", it.alpha), ("opacity", it.opacity)] {
            if let Some(v) = e.get(key).and_then(Value::as_f64)
                && (v - value).abs() > 1e-4
            {
                why.push(format!("{key} {v} vs {value}"));
            }
        }
        if it.kind == ItemKind::Mesh {
            mesh_faces(scene, it, e.get("mesh"), meshes, &mut why);
        } else if it.kind == ItemKind::Poly {
            let points: Vec<[f64; 2]> = e.get("points").and_then(Value::elements).map(|a| a.iter().filter_map(|p| point(Some(&p))).collect()).unwrap_or_default();
            let ours = scene.points_of(it);
            if points.len() != ours.len() {
                why.push(format!("poly points {} vs {}", points.len(), ours.len()));
            } else if let Some(k) = (0..points.len()).find(|&k| !close(points[k], ours[k])) {
                why.push(format!("poly point {k} {:?} vs {:?}", points[k], ours[k]));
            }
            // A depth-tested surface: one depth per point (`depthValues`).
            let depth = e.get("depth").and_then(Value::numbers).unwrap_or_default();
            let ours = scene.depths_of(it);
            if depth.len() != ours.len() {
                why.push(format!("surface depths {} vs {}", depth.len(), ours.len()));
            } else if let Some(k) = (0..depth.len()).find(|&k| !close_depth(depth[k], ours[k])) {
                why.push(format!("surface depth {k} {} vs {}", depth[k], ours[k]));
            }
        } else {
            if let Some(corners) = e.get("image") {
                image_corners(scene, it, corners, &mut why);
            }
            if let Some(expected) = e.get("secondary") {
                let ours = scene.figures.get(it.figure as usize).and_then(|f| f.segments.get(it.index as usize)).and_then(|s| s.secondary);
                let want = expected.numbers().filter(|v| v.len() == 4).map(|v| ([v[0] as u8, v[1] as u8, v[2] as u8], v[3] as u8));
                if want != ours {
                    why.push(format!("secondary {want:?} vs {ours:?}"));
                }
            }
            if let (Some(start), Some(end)) = (point(e.get("start")), point(e.get("end"))) {
                if !close(start, it.start) {
                    why.push(format!("start {start:?} vs {:?}", it.start));
                }
                if !close(end, it.end) {
                    why.push(format!("end {end:?} vs {:?}", it.end));
                }
            }
            if let Some(thickness) = e.get("thickness").and_then(Value::as_f64)
                && (thickness - it.thickness).abs() > TOLERANCE
            {
                why.push(format!("thickness {thickness} vs {}", it.thickness));
            }
        }
        if !why.is_empty() {
            report.mismatched_primitives += 1;
            if problems.len() < LINES {
                problems.push(format!("#{i} {} uid {} seg/poly {}: {}", it.kind.name(), uid, it.index, why.join("; ")));
            }
        }
    }
}

/// Where a picture is drawn (`--images`): the corners of its displayed rectangle under
/// drawGeometry's transform, from the asset the item's figure holds (a Stick Nodes sprite's
/// stretched one), sized by its displayed size, else its recorded one.
fn image_corners(scene: &Scene, it: &crate::geometry::Item, expected: &Value, why: &mut Vec<String>) {
    let fig = &scene.figures[it.figure as usize];
    let Some(seg) = fig.segments.get(it.index as usize) else { return };
    let Some(a) = fig.image(seg.asset).filter(|a| a.anchor_length != 0.0) else {
        why.push("image: no anchored asset in the engine".into());
        return;
    };
    let Some([w, h]) = a.display_size.or(a.size) else {
        why.push("image: no size in the engine".into());
        return;
    };
    let mirror = seg.mirror != it.image_text_flags;
    let start = if seg.reverse { it.end } else { it.start };
    let scale = (it.end[0] - it.start[0]).hypot(it.end[1] - it.start[1]) / a.anchor_length;
    let angle = (if mirror { it.angle + a.anchor_angle - std::f64::consts::PI } else { it.angle - a.anchor_angle }) + if seg.reverse { std::f64::consts::PI } else { 0.0 };
    let (sin, cos) = (styk_math::sin(angle), styk_math::cos(angle));
    let mx = if mirror { -1.0 } else { 1.0 };
    let corner = |x: f64, y: f64| {
        let (px, py) = (mx * scale * (x - a.anchor_start[0]), scale * (y - a.anchor_start[1]));
        [start[0] + px * cos - py * sin, start[1] + px * sin + py * cos]
    };
    let ours = [corner(0.0, 0.0), corner(w, 0.0), corner(0.0, h), corner(w, h)];
    let expected: Vec<[f64; 2]> = expected.elements().map(|c| c.iter().filter_map(|p| point(Some(&p))).collect()).unwrap_or_default();
    if expected.len() != 4 || expected.iter().zip(&ours).any(|(e, o)| !close(*e, *o)) {
        why.push(format!("image corners {expected:?} vs {ours:?}"));
    }
}

/// Joints are the positions children and joined figures attach to: each
/// object's root (handle 0) and the handle of each of its segments.
fn joints(prepared: &Prepared, scene: &Scene, expected: &[Value], report: &mut Report, problems: &mut Vec<String>) {
    let mut lines = 0;
    for object in expected {
        let uid = object.get("uid").and_then(Value::as_f64).unwrap_or(-1.0);
        let slot = object.get("slot").and_then(Value::as_f64).unwrap_or(-1.0);
        let ours = scene.objects.get(slot as usize).filter(|g| g.resolved && g.uid as f64 == uid);
        let figure = ours.and_then(|g| prepared.doc.figure(g.figure));
        for joint in object.get("joints").and_then(Value::elements).into_iter().flatten() {
            let Some(values) = joint.numbers().filter(|v| v.len() == 3) else { continue };
            let (handle, position) = (values[0] as u32, [values[1], values[2]]);
            report.joints += 1;
            let found = match (ours, figure) {
                (Some(geometry), Some(figure)) => geometry.joint(figure, handle),
                _ => None,
            };
            if found.is_some_and(|p| close(position, p)) {
                continue;
            }
            report.mismatched_joints += 1;
            if lines < LINES {
                lines += 1;
                problems.push(match found {
                    Some(p) => format!("joint {handle} of uid {uid}: {position:?} vs {p:?}"),
                    None => format!("joint {handle} of uid {uid} (slot {slot}): missing in the engine"),
                });
            }
        }
    }
}
