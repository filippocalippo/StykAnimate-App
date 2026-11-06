//! 3D: perspective, one-sided surfaces, figure meshes and attached movieclip
//! meshes (docs/engine/spatial.md). The JavaScript editor is the oracle:
//! `src/spatial-projection.mjs`, `src/pivot/surfaces.mjs`, `src/spatial-mesh.mjs`
//! and `src/movieclip-mesh.mjs`, followed operation for operation.
//!
//! Evaluated positions and depths are rounded to single precision exactly where
//! the editor stores them in `Float32Array`s, and trigonometry is V8's
//! (`styk-math`): whether an edge-on face is culled is decided by a relative
//! tolerance of 2e-7, so the engine must not differ in the last bits.

use std::collections::BTreeMap;
use std::sync::Arc;

use styk_doc::Value;
use styk_math::{atan2, cos, sin};

use crate::doc::{Object, SpatialCamera, SpatialPose, SpatialShape, Surface};
use crate::rig::{spatial_point, view_interpolation, SpatialFrame};

/// The nearest a perspective divisor gets (`NEAR`).
pub const NEAR: f64 = 0.05;
const EPS: f64 = 1e-9;

/// `Math.max(a, b)`: NaN when either is.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// `Math.sign(v)`.
fn js_sign(v: f64) -> f64 {
    if v.is_nan() || v == 0.0 { v } else { v.signum() }
}

/// The perspective of one pose (`projection(object, root)`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub root: [f64; 2],
    pub k: f64,
    pub scale: f64,
}

impl Camera {
    /// `projection(object, root)`: none without strength or scale.
    pub fn of(object: &Object, root: [f64; 2]) -> Option<Camera> {
        let c = object.spatial.as_ref()?.camera?;
        let falsy = |v: f64| v == 0.0 || v.is_nan();
        if falsy(c.strength) || falsy(object.scale) {
            return None;
        }
        Some(Camera { root: [c.center[0].unwrap_or(root[0]), c.center[1].unwrap_or(root[1])], k: c.strength / (c.distance * object.scale.abs()), scale: object.scale.abs() })
    }

    /// The divisor of a point at depth `z`.
    fn divisor(&self, z: f64) -> f64 {
        js_max(NEAR, 1.0 - self.k * z)
    }

    /// `unprojectSpatial(p, depth, object, root)` with this camera: the scene point at
    /// `depth` that projects to `p`.
    pub fn unproject(&self, p: [f64; 2], depth: f64) -> [f64; 2] {
        let d = self.divisor(depth);
        [self.root[0] + (p[0] - self.root[0]) * d, self.root[1] + (p[1] - self.root[1]) * d]
    }

    /// `projectSpatial(p, camera)`.
    pub fn project(&self, p: [f64; 3]) -> [f64; 2] {
        let d = self.divisor(p[2]);
        [self.root[0] + (p[0] - self.root[0]) / d, self.root[1] + (p[1] - self.root[1]) / d]
    }

    /// The depth beyond which a point is behind the near plane.
    fn near(&self) -> f64 {
        (1.0 - NEAR) / self.k
    }
}

/// `interpolateSpatialPose(a, b, t)`: the pose between two keys. Always has a
/// camera; a centre a key does not set is that key's root.
pub fn interpolate_pose(a: &Object, b: &Object, t: f64) -> SpatialPose {
    let lerp = |x: f64, y: f64, min: f64, max: f64| js_max(min, {
        let v = x + (y - x) * t;
        if v.is_nan() { v } else { v.min(max) }
    });
    let camera = |o: &Object| {
        let c = o.spatial.as_ref().and_then(|s| s.camera);
        (c.map_or(0.0, |c| c.strength), c.map_or(600.0, |c| c.distance), c.and_then(|c| c.center[0]).unwrap_or(o.root[0]), c.and_then(|c| c.center[1]).unwrap_or(o.root[1]))
    };
    let (ca, cb) = (camera(a), camera(b));
    let shapes = |o: &Object| o.spatial.as_ref().and_then(|s| s.shape.clone()).unwrap_or_default();
    let (sa, sb) = (shapes(a), shapes(b));
    let rest = SpatialShape { width: 1.0, taper: 0.0 };
    let mut shape = BTreeMap::new();
    for id in sa.keys().chain(sb.keys()) {
        let (x, y) = (sa.get(id).copied().unwrap_or(rest), sb.get(id).copied().unwrap_or(rest));
        shape.insert(*id, SpatialShape { width: lerp(x.width, y.width, 0.1, 5.0), taper: lerp(x.taper, y.taper, -0.9, 3.0) });
    }
    SpatialPose {
        camera: Some(SpatialCamera {
            strength: lerp(ca.0, cb.0, 0.0, 1.0),
            distance: lerp(ca.1, cb.1, 10.0, 100000.0),
            center: [Some(lerp(ca.2, cb.2, -1e7, 1e7)), Some(lerp(ca.3, cb.3, -1e7, 1e7))],
        }),
        shape: (!shape.is_empty()).then_some(shape),
    }
}

/// `_stykSpatial` of a pose.
pub fn parse_pose(v: &Value) -> Option<SpatialPose> {
    if !v.is_object() {
        return None;
    }
    let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64);
    let camera = v.get("camera").filter(|c| c.is_object()).map(|c| SpatialCamera {
        strength: num(c, "strength").unwrap_or(0.0),
        distance: num(c, "distance").unwrap_or(600.0),
        center: [num(c, "centerX"), num(c, "centerY")],
    });
    let shape = match v.get("shape") {
        Some(Value::Obj(map)) => {
            Some(map.iter().filter_map(|(id, s)| Some((id.parse::<u32>().ok()?, SpatialShape { width: num(s, "width").unwrap_or(1.0), taper: num(s, "taper").unwrap_or(0.0) }))).collect::<BTreeMap<_, _>>())
        }
        _ => None,
    };
    Some(SpatialPose { camera, shape })
}

/// `_stykSurface` of a polygon.
pub fn parse_surface(v: &Value) -> Option<Surface> {
    let basis = v.get("basis")?.numbers()?;
    if basis.len() != 3 {
        return None;
    }
    Some(Surface {
        basis: [basis[0] as u32, basis[1] as u32, basis[2] as u32],
        back: v.get("side").and_then(Value::as_str) == Some("back"),
        flipped: v.get("flipped") == Some(&Value::Bool(true)),
        depth: v.get("depth").and_then(Value::numbers).map(|d| d.into_iter().map(|id| id as u32).collect()).unwrap_or_default(),
        depth_test: v.get("depthTest") == Some(&Value::Bool(true)),
    })
}

// ------------------------------------------------------------ surfaces

/// What geometry knows about a joint of a spatial figure, beyond its position.
#[derive(Clone, Copy, Debug, Default)]
pub struct JointDepth {
    /// `depthOffset`: the joint's depth along the surface reference X, from the root.
    pub offset: Option<[f64; 2]>,
    /// `rawPoint`: the joint before perspective.
    pub raw: Option<[f64; 3]>,
}

/// One evaluated surface (`surfaceEvaluation(poly, points, projected)`).
pub struct SurfaceResult {
    pub culled: bool,
    pub z: f64,
    /// One depth per point of a depth-tested face.
    pub depth_values: Option<Vec<f64>>,
}

/// `projectSpatialFace(points, camera)`: a depth-tested face clipped against the
/// near plane before projection. `None` when the pose has no perspective or a
/// point has no depth; `Ok(depths)` keeps the points; `Err` replaces them.
#[allow(clippy::type_complexity)]
pub fn project_face(points: &[[f64; 2]], raws: &[Option<[f64; 3]>], camera: Option<&Camera>) -> Option<Result<Vec<f64>, (Vec<[f64; 2]>, Vec<f64>)>> {
    let camera = camera?;
    if points.is_empty() || raws.iter().any(Option::is_none) {
        return None;
    }
    let raw: Vec<[f64; 3]> = raws.iter().map(|r| r.unwrap()).collect();
    let near = camera.near();
    if !raw.iter().any(|p| p[2] > near) {
        return Some(Ok(raw.iter().map(|p| p[2] / (1.0 - camera.k * p[2]) / camera.scale).collect()));
    }
    let mut clipped: Vec<[f64; 3]> = Vec::with_capacity(raw.len() + 1);
    for i in 0..raw.len() {
        let (a, b) = (raw[i], raw[(i + 1) % raw.len()]);
        let (inside, next) = (a[2] <= near, b[2] <= near);
        if inside {
            clipped.push(a);
        }
        if inside != next {
            let t = (near - a[2]) / (b[2] - a[2]);
            clipped.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near]);
        }
    }
    let projected = clipped.iter().map(|p| camera.project(*p)).collect();
    let depths = clipped.iter().map(|p| p[2] / camera.divisor(p[2]) / camera.scale).collect();
    Some(Err((projected, depths)))
}

/// `surfaceCulled(poly, points, joints, parity)`: the face looks away, or is edge-on.
fn surface_culled(surface: &Surface, points: &[[f64; 2]], parity: f64) -> bool {
    if points.len() < 3 {
        return true;
    }
    let p = points[0];
    let (mut area, mut extent) = (0.0f64, 0.0f64);
    for i in 1..points.len() {
        let (x, y) = (points[i][0] - p[0], points[i][1] - p[1]);
        extent = js_max(extent, x * x + y * y);
        if i + 1 < points.len() {
            area += x * (points[i + 1][1] - p[1]) - y * (points[i + 1][0] - p[0]);
        }
    }
    let facing = if surface.back { -1.0 } else { 1.0 } * if surface.flipped { -1.0 } else { 1.0 };
    area * js_sign(parity) * facing <= extent * 2e-7
}

/// `createSurfaceEvaluation(joints)` for one face. `joint` answers a handle's
/// position, `depth` what else is known about it; handle 0 is the root.
pub fn evaluate_surface(
    surface: &Surface,
    base: f64,
    points: &[[f64; 2]],
    projected: Option<Vec<f64>>,
    root: [f64; 2],
    joint: &dyn Fn(u32) -> Option<[f64; 2]>,
    depth: &dyn Fn(u32) -> JointDepth,
) -> SurfaceResult {
    let (Some(o), Some(x), Some(y)) = (joint(surface.basis[0]), joint(surface.basis[1]), joint(surface.basis[2])) else {
        return SurfaceResult { culled: true, z: base, depth_values: None };
    };
    let (dx, dy) = (x[0] - o[0], x[1] - o[1]);
    let den = dx * dx + dy * dy;
    let parity = dx * (y[1] - o[1]) - dy * (y[0] - o[0]);
    if let Some(mut values) = projected {
        let mut sum = 0.0;
        for v in values.iter_mut() {
            sum += *v;
            *v += base;
        }
        let count = if values.is_empty() { 1.0 } else { values.len() as f64 };
        return SurfaceResult { culled: surface_culled(surface, points, parity), z: base + sum / count, depth_values: Some(values) };
    }
    let mut sum = 0.0;
    let mut values = surface.depth_test.then(|| Vec::with_capacity(surface.depth.len()));
    for &id in &surface.depth {
        let value = match joint(id) {
            None => 0.0,
            Some(_) if den < 1e-16 => 0.0,
            Some(p) => match depth(id).offset {
                Some(offset) => ((root[0] + offset[0] - o[0]) * dx + (root[1] + offset[1] - o[1]) * dy) / den,
                None => ((p[0] - o[0]) * dx + (p[1] - o[1]) * dy) / den,
            },
        };
        sum += value;
        if let Some(values) = &mut values {
            values.push(base + value);
        }
    }
    let z = base + if surface.depth.is_empty() { 0.0 } else { sum / surface.depth.len() as f64 };
    SurfaceResult { culled: surface_culled(surface, points, parity), z, depth_values: values }
}

// ------------------------------------------------------------ evaluated meshes

/// An evaluated mesh: the visible faces of one pose, with depth
/// (`evaluateSpatialMeshSteps` and `buildMovieclipMeshSteps` return this record).
#[derive(Clone, Debug, Default)]
pub struct MeshGeometry {
    /// Screen x and y per vertex (the mesh's own, then those a near clip added).
    pub positions: Vec<f32>,
    /// Depth per vertex: larger is nearer.
    pub depth: Vec<f32>,
    /// Three vertex indices per visible face, in the order they are drawn:
    /// definition order within each painter-order bucket ([`MeshGeometry::split`]).
    pub triangles: Vec<u32>,
    /// Palette index per visible face.
    pub materials: Vec<u16>,
    /// Painter depth per visible face.
    pub z: Vec<f32>,
    /// The palette as this pose draws it (the object's colour override applied).
    pub colors: Vec<[u8; 3]>,
    /// Bounds of the visible faces (x0, y0, x1, y1), if any face is visible.
    pub bounds: Option<[f32; 4]>,
    pub z_min: f32,
    pub z_max: f32,
}

/// One painter-order drawable of a mesh (`spatialMeshDrawables`): faces
/// `faces.0..faces.1` of [`MeshGeometry::triangles`], drawn at `z`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MeshDrawable {
    pub index: u32,
    pub faces: (u32, u32),
    pub z: f64,
}

impl MeshGeometry {
    pub fn count(&self) -> usize {
        self.materials.len()
    }

    /// `spatialMeshDrawables(mesh, owner, others)`: the other visible primitives
    /// of the figure split the faces where per-face painter order would place
    /// them; a face tied with a level goes below it. Faces are regrouped by
    /// bucket, keeping their order within each.
    pub fn split(&mut self, others: &[f64]) -> Vec<MeshDrawable> {
        let count = self.count();
        if count == 0 {
            return Vec::new();
        }
        let mut levels: Vec<f64> = others.iter().copied().filter(|v| v.is_finite()).collect();
        levels.sort_by(|a, b| a.total_cmp(b));
        levels.dedup();
        if levels.is_empty() || (self.z_max as f64) < levels[0] {
            let z = if levels.is_empty() { self.z_min as f64 } else { levels[0] };
            return vec![MeshDrawable { index: 0, faces: (0, count as u32), z }];
        }
        let bucket: Vec<u32> = self.z.iter().map(|&value| levels.partition_point(|&level| level < value as f64) as u32).collect();
        let mut sizes = vec![0u32; levels.len() + 1];
        for &b in &bucket {
            sizes[b as usize] += 1;
        }
        let mut starts = vec![0u32; levels.len() + 2];
        for k in 0..=levels.len() {
            starts[k + 1] = starts[k] + sizes[k];
        }
        let mut next = starts.clone();
        let mut triangles = vec![0u32; count * 3];
        let mut materials = vec![0u16; count];
        let mut z = vec![0f32; count];
        for t in 0..count {
            let at = next[bucket[t] as usize] as usize;
            next[bucket[t] as usize] += 1;
            triangles[at * 3..at * 3 + 3].copy_from_slice(&self.triangles[t * 3..t * 3 + 3]);
            materials[at] = self.materials[t];
            z[at] = self.z[t];
        }
        self.triangles = triangles;
        self.materials = materials;
        self.z = z;
        (0..=levels.len())
            .filter(|&k| sizes[k] > 0)
            .map(|k| MeshDrawable { index: k as u32, faces: (starts[k], starts[k + 1]), z: if k < levels.len() { levels[k] } else { self.z_max as f64 } })
            .collect()
    }
}

/// Collects visible faces and the bounds and depth range of their vertices.
struct Faces {
    positions: Vec<f32>,
    depth: Vec<f32>,
    triangles: Vec<u32>,
    materials: Vec<u16>,
    z: Vec<f32>,
    bounds: [f32; 4],
    range: [f32; 2],
}

impl Faces {
    fn new(positions: Vec<f32>, depth: Vec<f32>, triangles: usize) -> Faces {
        Faces {
            positions,
            depth,
            triangles: Vec::with_capacity(triangles * 3),
            materials: Vec::with_capacity(triangles),
            z: Vec::with_capacity(triangles),
            bounds: [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY],
            range: [f32::INFINITY, f32::NEG_INFINITY],
        }
    }

    fn include(&mut self, v: usize) {
        let (x, y, d) = (self.positions[v * 2], self.positions[v * 2 + 1], self.depth[v]);
        if x < self.bounds[0] {
            self.bounds[0] = x;
        }
        if x > self.bounds[2] {
            self.bounds[2] = x;
        }
        if y < self.bounds[1] {
            self.bounds[1] = y;
        }
        if y > self.bounds[3] {
            self.bounds[3] = y;
        }
        if d < self.range[0] {
            self.range[0] = d;
        }
        if d > self.range[1] {
            self.range[1] = d;
        }
    }

    fn push(&mut self, a: u32, b: u32, c: u32, material: u16, z: f64) {
        self.triangles.extend_from_slice(&[a, b, c]);
        self.materials.push(material);
        self.z.push(z as f32);
    }

    /// Adds a projected vertex a near clip produced.
    fn vertex(&mut self, x: f64, y: f64, d: f64) -> u32 {
        self.positions.push(x as f32);
        self.positions.push(y as f32);
        self.depth.push(d as f32);
        let at = self.depth.len() - 1;
        self.include(at);
        at as u32
    }

    fn finish(self, colors: Vec<[u8; 3]>) -> MeshGeometry {
        let visible = !self.materials.is_empty() && self.bounds[0] <= self.bounds[2];
        MeshGeometry {
            positions: self.positions,
            depth: self.depth,
            triangles: self.triangles,
            materials: self.materials,
            z: self.z,
            colors,
            bounds: visible.then_some(self.bounds),
            z_min: self.range[0],
            z_max: self.range[1],
        }
    }
}

/// A triangle crossing the near plane, clipped before projection: its corners
/// (X, Y, Z before perspective) in order.
fn clip_near(raw: &[f64], [a, b, c]: [usize; 3], near: f64) -> Vec<[f64; 3]> {
    let mut clipped = Vec::with_capacity(4);
    for (p, q) in [(a, b), (b, c), (c, a)] {
        let (pz, qz) = (raw[p * 3 + 2], raw[q * 3 + 2]);
        let (inside, next) = (pz <= near, qz <= near);
        if inside {
            clipped.push([raw[p * 3], raw[p * 3 + 1], pz]);
        }
        if inside != next {
            let s = (near - pz) / (qz - pz);
            clipped.push([raw[p * 3] + (raw[q * 3] - raw[p * 3]) * s, raw[p * 3 + 1] + (raw[q * 3 + 1] - raw[p * 3 + 1]) * s, near]);
        }
    }
    clipped
}

// ------------------------------------------------------------ figure meshes

/// A figure's mesh (`_styk.spatialMesh`) compiled against its joints
/// (`spatialMeshPlan`): vertex slots hold bone ordinals, `bones[ordinal]` is
/// the segment index.
#[derive(Clone, Debug, Default)]
pub struct MeshPlan {
    pub vertices: usize,
    pub triangles: usize,
    /// Bind-space x, y, z per vertex.
    pub positions: Vec<f64>,
    /// Four slots per vertex: a bone ordinal, packed to the front.
    pub slots: Vec<u32>,
    pub weights: Vec<f64>,
    /// Bones bound per vertex (1 to 4).
    pub counts: Vec<u8>,
    pub bones: Vec<u32>,
    pub indices: Vec<u32>,
    pub materials: Vec<u16>,
    /// The definition's palette.
    pub palette: Vec<[u8; 3]>,
    /// Origin, X and Y reference joints (handle ids).
    pub basis: [u32; 3],
    /// `z`: the depth-order offset of every face.
    pub base: f64,
    /// 0, 4 or 8 view targets per view-corrected vertex.
    pub views: usize,
    /// Per vertex: its row in `view_points`, or `u32::MAX`.
    pub view_slot: Vec<u32>,
    pub view_points: Vec<f64>,
}

impl MeshPlan {
    /// Reads and compiles `_styk.spatialMesh`. `index_of` maps a joint handle to
    /// its segment index. Returns the reason when the mesh cannot be evaluated
    /// (the editor rejects such a file when it loads).
    pub fn compile(mesh: &Value, index_of: &dyn Fn(u32) -> Option<u32>) -> Result<MeshPlan, String> {
        let numbers = |key: &str| mesh.get(key).and_then(Value::numbers).ok_or_else(|| format!("a 3D mesh needs `{key}`"));
        let positions = numbers("positions")?;
        let (bones, weights, indices, materials, basis) = (numbers("bones")?, numbers("weights")?, numbers("indices")?, numbers("materials")?, numbers("basis")?);
        let vertices = positions.len() / 3;
        if positions.len() % 3 != 0 || vertices < 3 || bones.len() != vertices * 4 || weights.len() != vertices * 4 {
            return Err("a 3D mesh needs xyz positions and four bindings per vertex".into());
        }
        let triangles = indices.len() / 3;
        if indices.len() % 3 != 0 || triangles == 0 || materials.len() != triangles || basis.len() != 3 {
            return Err("a 3D mesh needs triangles, one colour each, and three reference joints".into());
        }
        if indices.iter().any(|&i| i < 0.0 || i as usize >= vertices) {
            return Err("3D mesh triangles must reference existing vertices".into());
        }
        let palette: Vec<[u8; 3]> = mesh
            .get("colors")
            .and_then(Value::elements)
            .map(|colors| colors.iter().filter_map(|c| c.numbers().filter(|c| c.len() == 3).map(|c| [c[0] as u8, c[1] as u8, c[2] as u8])).collect())
            .unwrap_or_default();
        if palette.is_empty() || materials.iter().any(|&m| m < 0.0 || m as usize >= palette.len()) {
            return Err("each 3D mesh triangle needs a colour".into());
        }
        let mut ordinals: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
        let mut order: Vec<u32> = Vec::new();
        let mut slots = vec![u32::MAX; vertices * 4];
        let mut packed = vec![0.0; vertices * 4];
        let mut counts = vec![0u8; vertices];
        for v in 0..vertices {
            for k in 0..4 {
                let bone = bones[v * 4 + k] as u32;
                if bone == 0 {
                    continue;
                }
                let index = index_of(bone).ok_or("a 3D mesh references a missing bone")?;
                let ordinal = *ordinals.entry(index).or_insert_with(|| {
                    order.push(index);
                    order.len() as u32 - 1
                });
                let at = v * 4 + counts[v] as usize;
                slots[at] = ordinal;
                packed[at] = weights[v * 4 + k];
                counts[v] += 1;
            }
            if counts[v] == 0 {
                return Err("every 3D mesh vertex needs a bone".into());
            }
        }
        let views = mesh.get("views").and_then(Value::as_f64).unwrap_or(0.0) as usize;
        let view_vertices = mesh.get("viewVertices").and_then(Value::numbers).unwrap_or_default();
        let view_points = mesh.get("viewPoints").and_then(Value::numbers).unwrap_or_default();
        let mut view_slot = vec![u32::MAX; vertices];
        if views != 0 {
            if ![4, 8].contains(&views) || view_points.len() != view_vertices.len() * views * 3 {
                return Err("view-corrected mesh vertices need four or eight positions each".into());
            }
            for (i, &v) in view_vertices.iter().enumerate() {
                *view_slot.get_mut(v as usize).ok_or("view-corrected vertices must exist")? = i as u32;
            }
        }
        Ok(MeshPlan {
            vertices,
            triangles,
            positions,
            slots,
            weights: packed,
            counts,
            bones: order,
            indices: indices.into_iter().map(|i| i as u32).collect(),
            materials: materials.into_iter().map(|m| m as u16).collect(),
            palette,
            basis: [basis[0] as u32, basis[1] as u32, basis[2] as u32],
            base: mesh.get("z").and_then(Value::as_f64).unwrap_or(0.0),
            views,
            view_slot,
            view_points,
        })
    }
}

/// Per-pose values of one bone, as `boneValues` lays them out.
#[derive(Clone, Copy)]
struct Bone {
    q: [f64; 4],
    t: [f64; 3],
    origin: [f64; 3],
    axis: [f64; 3],
    stretch: f64,
    choice: Option<f64>,
    shape: Option<SpatialShape>,
    rest_length: f64,
    dual: [f64; 4],
    stretched: bool,
    /// `spatialViewInterpolation` for the mesh's view count.
    view: (usize, usize, f64, f64, f64, f64),
}

impl Bone {
    fn of(f: &SpatialFrame, views: usize) -> Bone {
        Bone {
            q: f.q,
            t: f.t,
            origin: f.origin,
            axis: f.axis,
            stretch: f.stretch,
            choice: f.choice_scale,
            shape: f.shape,
            rest_length: f.rest_length,
            dual: f.dual,
            stretched: (f.stretch - 1.0).abs() > EPS,
            view: if views != 0 { view_interpolation(f, views) } else { (0, 0, 0.0, 1.0, 0.0, 0.0) },
        }
    }

    /// `framePoint`: `spatialPoint(frame, [x, y, z])` from the cached values, in the same order.
    fn point(&self, [x0, y0, z0]: [f64; 3]) -> [f64; 3] {
        let (mut x, mut y, mut z) = (x0, y0, z0);
        let [ox, oy, oz] = self.origin;
        let [ax, ay, az] = self.axis;
        if let Some(shape) = self.shape {
            let (rx, ry, rz) = (x0 - ox, y0 - oy, z0 - oz);
            let d = rx * ax + ry * ay + rz * az;
            let u = (d / self.rest_length).clamp(0.0, 1.0);
            let amount = shape.width * (1.0 + shape.taper * u * u * (3.0 - 2.0 * u)) - 1.0;
            x = x0 + (rx - d * ax) * amount;
            y = y0 + (ry - d * ay) * amount;
            z = z0 + (rz - d * az) * amount;
        }
        if let Some(choice) = self.choice {
            x = ox + (x - ox) * choice;
            y = oy + (y - oy) * choice;
            z = oz + (z - oz) * choice;
        } else if self.stretched {
            let s = self.stretch;
            let d = (x0 - ox) * ax + (y0 - oy) * ay + (z0 - oz) * az;
            x += d * (s - 1.0) * ax;
            y += d * (s - 1.0) * ay;
            z += d * (s - 1.0) * az;
        }
        let [qx, qy, qz, qw] = self.q;
        let (tx, ty, tz) = (2.0 * (qy * z - qz * y), 2.0 * (qz * x - qx * z), 2.0 * (qx * y - qy * x));
        [x + qw * tx + qy * tz - qz * ty + self.t[0], y + qw * ty + qz * tx - qx * tz + self.t[1], z + qw * tz + qx * ty - qy * tx + self.t[2]]
    }
}

/// `blendedVertex`: a vertex bound to several bones. Dual-quaternion blend, or a
/// linear blend of bone positions while any bone stretches.
fn blended(plan: &MeshPlan, bones: &[Bone], v: usize, [px, py, pz]: [f64; 3]) -> [f64; 3] {
    let count = plan.counts[v] as usize;
    let base = v * 4;
    let first = &bones[plan.slots[base] as usize];
    let (mut x, mut y, mut z, mut w, mut dx, mut dy, mut dz, mut dw) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut stretch, mut shaped) = (false, false);
    for k in 0..count {
        let b = &bones[plan.slots[base + k] as usize];
        stretch |= b.stretched;
        shaped |= b.shape.is_some();
        let facing = b.q[0] * first.q[0] + b.q[1] * first.q[1] + b.q[2] * first.q[2] + b.q[3] * first.q[3];
        let weight = plan.weights[base + k] * if facing < 0.0 { -1.0 } else { 1.0 };
        x += b.q[0] * weight;
        y += b.q[1] * weight;
        z += b.q[2] * weight;
        w += b.q[3] * weight;
        dx += b.dual[0] * weight;
        dy += b.dual[1] * weight;
        dz += b.dual[2] * weight;
        dw += b.dual[3] * weight;
    }
    if stretch {
        let (mut sx, mut sy, mut sz) = (0.0, 0.0, 0.0);
        for k in 0..count {
            let p = bones[plan.slots[base + k] as usize].point([px, py, pz]);
            let weight = plan.weights[base + k];
            sx += p[0] * weight;
            sy += p[1] * weight;
            sz += p[2] * weight;
        }
        return [sx, sy, sz];
    }
    let norm = styk_math::norm(&[x, y, z, w]);
    let (x, y, z, w, dx, dy, dz, dw) = (x / norm, y / norm, z / norm, w / norm, dx / norm, dy / norm, dz / norm, dw / norm);
    let (tx, ty, tz) = (2.0 * (y * pz - z * py), 2.0 * (z * px - x * pz), 2.0 * (x * py - y * px));
    let mut rx = px + w * tx + y * tz - z * ty + 2.0 * (-dw * x + dx * w - dy * z + dz * y);
    let mut ry = py + w * ty + z * tx - x * tz + 2.0 * (-dw * y + dx * z + dy * w - dz * x);
    let mut rz = pz + w * tz + x * ty - y * tx + 2.0 * (-dw * z - dx * y + dy * x + dz * w);
    if shaped {
        // Radial offsets blend in bind space, then rotate with the blended frame.
        let (mut ox, mut oy, mut oz) = (0.0, 0.0, 0.0);
        for k in 0..count {
            let b = &bones[plan.slots[base + k] as usize];
            let Some(shape) = b.shape else { continue };
            let [ax, ay, az] = b.axis;
            let (rx0, ry0, rz0) = (px - b.origin[0], py - b.origin[1], pz - b.origin[2]);
            let d = rx0 * ax + ry0 * ay + rz0 * az;
            let u = (d / b.rest_length).clamp(0.0, 1.0);
            let amount = shape.width * (1.0 + shape.taper * u * u * (3.0 - 2.0 * u)) - 1.0;
            let weight = plan.weights[base + k];
            ox += (rx0 - d * ax) * amount * weight;
            oy += (ry0 - d * ay) * amount * weight;
            oz += (rz0 - d * az) * amount * weight;
        }
        let (ux, uy, uz) = (2.0 * (y * oz - z * oy), 2.0 * (z * ox - x * oz), 2.0 * (x * oy - y * ox));
        rx += ox + w * ux + y * uz - z * uy;
        ry += oy + w * uy + z * ux - x * uz;
        rz += oz + w * uz + x * uy - y * ux;
    }
    [rx, ry, rz]
}

/// What a pose gives a figure mesh besides its bone frames.
pub struct MeshContext<'a> {
    pub root: [f64; 2],
    pub scale: f64,
    pub figure_angle: f64,
    pub mirror: bool,
    pub camera: Option<Camera>,
    /// A handle's position (0 is the root).
    pub joint: &'a dyn Fn(u32) -> Option<[f64; 2]>,
    /// The palette as this pose draws it.
    pub colors: Vec<[u8; 3]>,
}

/// `evaluateSpatialMeshSteps(plan, frames, context)`: skins and projects the
/// vertices, then keeps the faces that look at the viewer, clipped against the
/// near plane. `frame(i)` is the spatial frame of segment `i`. `None` when a
/// bone was not evaluated.
pub fn evaluate_mesh(plan: &MeshPlan, frame: &dyn Fn(usize) -> Option<SpatialFrame>, context: MeshContext<'_>) -> Option<MeshGeometry> {
    let MeshContext { root, scale, figure_angle, mirror, camera, joint, colors } = context;
    let bones: Vec<Bone> = plan.bones.iter().map(|&i| frame(i as usize).map(|f| Bone::of(&f, plan.views))).collect::<Option<_>>()?;
    let (o, bx, by) = (joint(plan.basis[0]), joint(plan.basis[1]), joint(plan.basis[2]));
    let n = plan.vertices;
    let (cs, sn) = (cos(figure_angle), sin(figure_angle));
    let sign = if mirror { -1.0 } else { 1.0 };
    let base = plan.base;
    let near = camera.map_or(f64::INFINITY, |c| c.near());
    let stride = plan.views * 3;
    let mut positions = vec![0f32; n * 2];
    let mut depth = vec![0f32; n];
    let mut raw = if camera.is_some() { vec![0f64; n * 3] } else { Vec::new() };
    let (dx, dy) = match (bx, o) {
        (Some(bx), Some(o)) => (bx[0] - o[0], bx[1] - o[1]),
        _ => (0.0, 0.0),
    };
    let den = dx * dx + dy * dy;
    let flat = o.filter(|_| den >= 1e-16);
    for v in 0..n {
        let (mut px, mut py, mut pz) = (plan.positions[v * 3], plan.positions[v * 3 + 1], plan.positions[v * 3 + 2]);
        let point = if plan.counts[v] == 1 {
            let bone = &bones[plan.slots[v * 4] as usize];
            let view = plan.view_slot[v];
            if view != u32::MAX {
                let (index, next, t, cos, sin, k) = bone.view;
                let (a, c) = (view as usize * stride + index * 3, view as usize * stride + next * 3);
                let views = &plan.view_points;
                let (x, y, z) = (views[a] + (views[c] - views[a]) * t, views[a + 1] + (views[c + 1] - views[a + 1]) * t, views[a + 2] + (views[c + 2] - views[a + 2]) * t);
                px += (bone.origin[0] + x * cos - z * sin - px) * k;
                py += (bone.origin[1] + y - py) * k;
                pz += (bone.origin[2] + x * sin + z * cos - pz) * k;
            }
            bone.point([px, py, pz])
        } else {
            blended(plan, &bones, v, [px, py, pz])
        };
        let x = root[0] + (point[0] * cs - point[1] * sign * sn) * scale;
        let y = root[1] + (point[0] * sn + point[1] * sign * cs) * scale;
        let (sx, sy, d);
        match &camera {
            Some(camera) => {
                let rz = point[2] * scale;
                let q = camera.divisor(rz);
                sx = camera.root[0] + (x - camera.root[0]) / q;
                sy = camera.root[1] + (y - camera.root[1]) / q;
                d = base + rz / q / camera.scale;
                raw[v * 3] = x;
                raw[v * 3 + 1] = y;
                raw[v * 3 + 2] = rz;
            }
            None => {
                sx = x;
                sy = y;
                d = match flat {
                    Some(o) => base + ((root[0] + point[2] * scale * cs - o[0]) * dx + (root[1] + point[2] * scale * sn - o[1]) * dy) / den,
                    None => base,
                };
            }
        }
        positions[v * 2] = sx as f32;
        positions[v * 2 + 1] = sy as f32;
        depth[v] = d as f32;
    }
    let parity = match (o, bx, by) {
        (Some(o), Some(_), Some(by)) => js_sign(dx * (by[1] - o[1]) - dy * (by[0] - o[0])),
        _ => 0.0,
    };
    let mut faces = Faces::new(positions, depth, plan.triangles);
    let mut used = vec![false; n];
    // A parity of zero (a flattened reference) or NaN hides every face.
    if parity == 1.0 || parity == -1.0 {
        for t in 0..plan.triangles {
            let (a, b, c) = (plan.indices[t * 3] as usize, plan.indices[t * 3 + 1] as usize, plan.indices[t * 3 + 2] as usize);
            let whole = camera.is_none() || (raw[a * 3 + 2] <= near && raw[b * 3 + 2] <= near && raw[c * 3 + 2] <= near);
            if whole {
                let p = &faces.positions;
                let (ax, ay) = (p[a * 2] as f64, p[a * 2 + 1] as f64);
                let (ux, uy, vx, vy) = (p[b * 2] as f64 - ax, p[b * 2 + 1] as f64 - ay, p[c * 2] as f64 - ax, p[c * 2 + 1] as f64 - ay);
                if (ux * vy - uy * vx) * parity <= js_max(ux * ux + uy * uy, vx * vx + vy * vy) * 2e-7 {
                    continue;
                }
                let z = (faces.depth[a] as f64 + faces.depth[b] as f64 + faces.depth[c] as f64) / 3.0;
                faces.push(a as u32, b as u32, c as u32, plan.materials[t], z);
                used[a] = true;
                used[b] = true;
                used[c] = true;
                continue;
            }
            let camera = camera.as_ref().expect("only a perspective pose clips");
            let clipped = clip_near(&raw, [a, b, c], near);
            if clipped.len() < 3 {
                continue;
            }
            let projected: Vec<[f64; 3]> = clipped
                .iter()
                .map(|&[x, y, z]| {
                    let d = camera.divisor(z);
                    [camera.root[0] + (x - camera.root[0]) / d, camera.root[1] + (y - camera.root[1]) / d, base + z / d / camera.scale]
                })
                .collect();
            let p0 = projected[0];
            let (mut area, mut extent) = (0.0f64, 0.0f64);
            for i in 1..projected.len() {
                let (ux, uy) = (projected[i][0] - p0[0], projected[i][1] - p0[1]);
                extent = js_max(extent, ux * ux + uy * uy);
                if i + 1 < projected.len() {
                    area += ux * (projected[i + 1][1] - p0[1]) - uy * (projected[i + 1][0] - p0[0]);
                }
            }
            if area * parity <= extent * 2e-7 {
                continue;
            }
            let ids: Vec<u32> = projected.iter().map(|&[x, y, d]| faces.vertex(x, y, d)).collect();
            let value = projected.iter().fold(0.0, |s, p| s + p[2]) / projected.len() as f64;
            for i in 1..ids.len() - 1 {
                faces.push(ids[0], ids[i], ids[i + 1], plan.materials[t], value);
            }
        }
    }
    for v in (0..n).filter(|&v| used[v]) {
        faces.include(v);
    }
    Some(faces.finish(colors))
}

// ------------------------------------------------------------ movieclip meshes

/// One form of an attached movieclip mesh (`spatialMeshes[frame]`).
#[derive(Clone, Debug, Default)]
pub struct ClipMesh {
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub colors: Vec<[u8; 3]>,
    pub materials: Vec<u16>,
    /// `viewPositions`: four or eight complete position sets, or none.
    pub view_positions: Vec<Vec<f64>>,
    /// `viewTurns`, `viewPivot` and `viewTurnWeights`.
    pub view_turns: Option<Vec<f64>>,
    pub view_pivot: [f64; 3],
    pub view_turn_weights: Option<Vec<f64>>,
}

impl ClipMesh {
    /// Reads one mesh of `spatialMeshes`; `None` when it is not a valid indexed mesh.
    pub fn parse(mesh: &Value) -> Option<ClipMesh> {
        let positions = mesh.get("positions")?.numbers()?;
        let indices = mesh.get("indices")?.numbers()?;
        let materials = mesh.get("materials")?.numbers()?;
        let colors: Vec<[u8; 3]> = mesh.get("colors")?.elements()?.iter().filter_map(|c| c.numbers().filter(|c| c.len() == 3).map(|c| [c[0] as u8, c[1] as u8, c[2] as u8])).collect();
        let vertices = positions.len() / 3;
        if positions.len() % 3 != 0 || vertices < 3 || indices.len() % 3 != 0 || indices.is_empty() || materials.len() != indices.len() / 3 || colors.is_empty() {
            return None;
        }
        if indices.iter().any(|&i| i < 0.0 || i as usize >= vertices) || materials.iter().any(|&m| m < 0.0 || m as usize >= colors.len()) {
            return None;
        }
        let view_positions: Vec<Vec<f64>> = match mesh.get("viewPositions").and_then(Value::elements) {
            Some(views) => views.iter().map(|v| v.numbers().filter(|v| v.len() == positions.len())).collect::<Option<_>>()?,
            None => Vec::new(),
        };
        if !view_positions.is_empty() && ![4, 8].contains(&view_positions.len()) {
            return None;
        }
        let view_turns = mesh.get("viewTurns").and_then(Value::numbers).filter(|t| t.len() == view_positions.len() && !t.is_empty());
        let pivot = mesh.get("viewPivot").and_then(Value::numbers).filter(|p| p.len() == 3);
        if view_turns.is_some() && pivot.is_none() {
            return None;
        }
        let view_turn_weights = mesh.get("viewTurnWeights").and_then(Value::numbers).filter(|w| w.len() == vertices && view_turns.is_some());
        Some(ClipMesh {
            positions,
            indices: indices.into_iter().map(|i| i as u32).collect(),
            colors,
            materials: materials.into_iter().map(|m| m as u16).collect(),
            view_positions,
            view_turns,
            view_pivot: pivot.map_or([0.0; 3], |p| [p[0], p[1], p[2]]),
            view_turn_weights,
        })
    }
}

/// The spatial bone an attached mesh hangs from, and its figure's pose.
pub struct Attachment<'a> {
    pub frame: &'a SpatialFrame,
    /// `animationRotation(parent.fig, parent.obj)`.
    pub figure_angle: f64,
    pub root: [f64; 2],
    pub scale: f64,
    pub mirror: bool,
    pub camera: Option<Camera>,
}

/// The placement of an attached mesh (`buildMovieclipMeshSteps`).
pub struct ClipPose<'a> {
    /// The instance's root: the bone's start when attached to one.
    pub root: [f64; 2],
    /// The instance's own angle, used when no bone owns its orientation.
    pub angle: f64,
    pub scale: f64,
    pub mirror: bool,
    /// The clip's pivot.
    pub pivot: [f64; 2],
    pub attachment: Option<Attachment<'a>>,
    pub colors: Vec<[u8; 3]>,
}

/// `buildMovieclipMeshSteps`: an attached mesh evaluated through its bone's
/// frame (or placed flat by its own angle), with the same face and depth
/// contract as native surfaces.
pub fn evaluate_clip_mesh(mesh: &ClipMesh, pose: ClipPose<'_>) -> MeshGeometry {
    let attachment = pose.attachment.as_ref();
    let frame = attachment.map(|a| a.frame);
    let angle = attachment.map_or(pose.angle, |a| a.figure_angle);
    let (cs, sn) = (cos(angle), sin(angle));
    let scale = pose.scale;
    let flip = |mirrored: bool| if mirrored { -1.0 } else { 1.0 };
    let mirror = flip(pose.mirror) * flip(attachment.is_some_and(|a| a.mirror));
    let camera = attachment.and_then(|a| a.camera);
    let parent_scale = attachment.map_or(1.0, |a| a.scale);
    let ratio = if frame.is_some() && parent_scale.abs() > 1e-12 { scale / parent_scale } else { 0.0 };
    let n = mesh.positions.len() / 3;
    let (flip_y, parent_flip) = (flip(pose.mirror), flip(attachment.is_some_and(|a| a.mirror)));
    // Most attachments are affine: the bone is evaluated four times, not once per vertex.
    let affine = frame.filter(|f| !f.shape.is_some_and(|s| s.taper != 0.0 && !s.taper.is_nan())).map(|f| {
        let o = spatial_point(f, f.origin);
        let column = |i: usize| {
            let mut p = f.origin;
            p[i] += 1.0;
            let q = spatial_point(f, p);
            [q[0] - o[0], q[1] - o[1], q[2] - o[2]]
        };
        [o, column(0), column(1), column(2)]
    });
    // Art-directed views blend around the bone's heading, like view-corrected skin.
    let view = frame.filter(|_| !mesh.view_positions.is_empty()).map(|f| view_interpolation(f, mesh.view_positions.len()));
    let wrap = |a: f64| atan2(sin(a), cos(a));
    let turn = match (view, &mesh.view_turns) {
        (Some((index, next, blend, _, _, strength)), Some(turns)) => (turns[index] + wrap(turns[next] - turns[index]) * blend) * strength,
        _ => 0.0,
    };
    let pivot = mesh.view_pivot;
    let (mut tc, mut ts, mut weight) = (cos(turn), sin(turn), 1.0);
    let authored = |k: usize| -> f64 {
        let base = mesh.positions[k];
        let Some((index, next, blend, _, _, strength)) = view else { return base };
        let (from, to) = (&mesh.view_positions[index], &mesh.view_positions[next]);
        let target = from[k] + (to[k] - from[k]) * blend;
        base + (target - base) * strength
    };
    let near = camera.map_or(f64::INFINITY, |c| c.near());
    let mut positions = vec![0f32; n * 2];
    let mut depth = vec![0f32; n];
    let mut raw = vec![0f64; n * 3];
    for i in 0..n {
        let at = i * 3;
        let (mut vx, vy, mut vz) = (authored(at), authored(at + 1), authored(at + 2));
        if turn != 0.0 && !turn.is_nan() {
            if let Some(weights) = &mesh.view_turn_weights
                && weights[i] != weight
            {
                weight = weights[i];
                tc = cos(turn * weight);
                ts = sin(turn * weight);
            }
            let (x, z) = (vx - pivot[0], vz - pivot[2]);
            vx = pivot[0] + x * tc + z * ts;
            vz = pivot[2] - x * ts + z * tc;
        }
        let (px, py, pz) = (vx - pose.pivot[0], (vy - pose.pivot[1]) * flip_y, vz);
        let (x, y, z);
        match (attachment, frame) {
            (Some(a), Some(f)) => {
                let [bx, by, bz] = match &affine {
                    Some(m) => [
                        m[0][0] + ratio * (px * m[1][0] + py * m[2][0] + pz * m[3][0]),
                        m[0][1] + ratio * (px * m[1][1] + py * m[2][1] + pz * m[3][1]),
                        m[0][2] + ratio * (px * m[1][2] + py * m[2][2] + pz * m[3][2]),
                    ],
                    None => spatial_point(f, [f.origin[0] + px * ratio, f.origin[1] + py * ratio, f.origin[2] + pz * ratio]),
                };
                x = a.root[0] + (bx * cs - by * parent_flip * sn) * parent_scale;
                y = a.root[1] + (bx * sn + by * parent_flip * cs) * parent_scale;
                z = bz * parent_scale;
            }
            _ => {
                x = pose.root[0] + (px * cs - py * sn) * scale;
                y = pose.root[1] + (px * sn + py * cs) * scale;
                z = pz * scale;
            }
        }
        raw[at] = x;
        raw[at + 1] = y;
        raw[at + 2] = z;
        match &camera {
            Some(camera) => {
                let d = camera.divisor(z);
                positions[i * 2] = (camera.root[0] + (x - camera.root[0]) / d) as f32;
                positions[i * 2 + 1] = (camera.root[1] + (y - camera.root[1]) / d) as f32;
                depth[i] = (z / (d * camera.scale)) as f32;
            }
            None => {
                positions[i * 2] = x as f32;
                positions[i * 2 + 1] = y as f32;
                depth[i] = (z / js_max(1e-12, scale.abs())) as f32;
            }
        }
    }
    let count = mesh.materials.len();
    let mut faces = Faces::new(positions, depth, count);
    for t in 0..count {
        let (a, b, c) = (mesh.indices[t * 3] as usize, mesh.indices[t * 3 + 1] as usize, mesh.indices[t * 3 + 2] as usize);
        if raw[a * 3 + 2] <= near && raw[b * 3 + 2] <= near && raw[c * 3 + 2] <= near {
            // Closed meshes wind outward; screen coordinates have Y down.
            let p = &faces.positions;
            let (ax, ay) = (p[a * 2] as f64, p[a * 2 + 1] as f64);
            let area = (p[b * 2] as f64 - ax) * (p[c * 2 + 1] as f64 - ay) - (p[b * 2 + 1] as f64 - ay) * (p[c * 2] as f64 - ax);
            if area * mirror > 1e-10 {
                let z = (faces.depth[a] as f64 + faces.depth[b] as f64 + faces.depth[c] as f64) / 3.0;
                faces.push(a as u32, b as u32, c as u32, mesh.materials[t], z);
                faces.include(a);
                faces.include(b);
                faces.include(c);
            }
            continue;
        }
        let Some(camera) = &camera else { continue };
        let clipped = clip_near(&raw, [a, b, c], near);
        if clipped.len() < 3 {
            continue;
        }
        let projected: Vec<[f64; 3]> = clipped
            .iter()
            .map(|&[x, y, z]| {
                let d = camera.divisor(z);
                [camera.root[0] + (x - camera.root[0]) / d, camera.root[1] + (y - camera.root[1]) / d, z / d / camera.scale]
            })
            .collect();
        let (p0, p1, p2) = (projected[0], projected[1], projected[2]);
        if ((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])) * mirror <= 1e-10 {
            continue;
        }
        let ids: Vec<u32> = projected.iter().map(|&[x, y, d]| faces.vertex(x, y, d)).collect();
        let value = projected.iter().fold(0.0, |s, p| s + p[2]) / projected.len() as f64;
        for i in 1..ids.len() - 1 {
            faces.push(ids[0], ids[i], ids[i + 1], mesh.materials[t], value);
        }
    }
    faces.finish(pose.colors)
}

/// Shares one evaluated mesh between the scene and its items.
pub type SharedMesh = Arc<MeshGeometry>;

/// Whether a document (or a movieclip in it) uses 3D: a figure mesh, a one-sided
/// surface, an attached movieclip mesh or a pose with `_stykSpatial`.
pub fn document_has_3d(doc: &crate::doc::Document) -> bool {
    let poses = doc.keyframes.iter().chain(doc.frame_sources.values()).any(|frame| frame.objects.iter().any(|o| o.spatial.is_some()));
    poses
        || doc.figures.iter().any(|f| {
            f.mesh.is_some() || f.polyfills.iter().any(|p| p.surface.is_some()) || f.movieclip.as_ref().is_some_and(|clip| clip.meshes.is_some() || document_has_3d(&clip.document))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mesh(z: &[f32]) -> MeshGeometry {
        MeshGeometry {
            triangles: (0..z.len() as u32 * 3).collect(),
            materials: (0..z.len() as u16).collect(),
            z: z.to_vec(),
            z_min: z.iter().copied().fold(f32::INFINITY, f32::min),
            z_max: z.iter().copied().fold(f32::NEG_INFINITY, f32::max),
            ..Default::default()
        }
    }

    #[test]
    fn a_mesh_alone_is_one_drawable_at_its_farthest_face() {
        let mut m = mesh(&[3.0, 1.0, 2.0]);
        assert_eq!(m.split(&[]), vec![MeshDrawable { index: 0, faces: (0, 3), z: 1.0 }]);
        assert_eq!(m.materials, vec![0, 1, 2]);
    }

    #[test]
    fn a_mesh_below_every_level_takes_the_lowest_level() {
        let mut m = mesh(&[3.0, 1.0, 2.0]);
        assert_eq!(m.split(&[9.0, 5.0, 5.0, f64::NAN]), vec![MeshDrawable { index: 0, faces: (0, 3), z: 5.0 }]);
    }

    #[test]
    fn levels_split_faces_keeping_their_order_and_ties_go_below() {
        let mut m = mesh(&[3.0, 1.0, 2.0, 2.0, 5.0]);
        let drawables = m.split(&[2.0, 4.0]);
        // Faces at or below 2 (1, 2, 3), then between the levels (0), then above 4 (4).
        assert_eq!(m.materials, vec![1, 2, 3, 0, 4]);
        assert_eq!(m.triangles[..3], [3, 4, 5]);
        assert_eq!(
            drawables,
            vec![MeshDrawable { index: 0, faces: (0, 3), z: 2.0 }, MeshDrawable { index: 1, faces: (3, 4), z: 4.0 }, MeshDrawable { index: 2, faces: (4, 5), z: 5.0 }]
        );
    }

    #[test]
    fn a_face_behind_the_near_plane_is_clipped_to_a_quad() {
        let camera = Camera { root: [0.0, 0.0], k: 0.01, scale: 1.0 };
        let near = camera.near();
        let raw = [0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, near + 50.0];
        let clipped = clip_near(&raw, [0, 1, 2], near);
        assert_eq!(clipped.len(), 4);
        assert!(clipped.iter().all(|p| p[2] <= near));
    }
}
