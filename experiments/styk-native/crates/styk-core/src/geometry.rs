//! World-space geometry of an evaluated frame (`buildGeometrySteps` in
//! src/pivot/geometry.mjs): joints, segment primitives and polygons in the
//! exact painter order the JavaScript editor uses.
//!
//! Objects are resolved level by level along their joins; every level builds in
//! parallel. Points live in one shared buffer per scene, so a frame with 100k
//! primitives performs a handful of allocations, not 100k.

use std::sync::Arc;

use rayon::prelude::*;

use crate::doc::*;
use crate::eval::Frame;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    Line,
    SquareLine,
    Circle,
    CircleFill,
    CircleClear,
    Image,
    Text,
    Poly,
}

impl ItemKind {
    pub fn name(self) -> &'static str {
        match self {
            ItemKind::Line | ItemKind::SquareLine => "line",
            ItemKind::Circle | ItemKind::CircleFill | ItemKind::CircleClear => "circle",
            ItemKind::Image => "image",
            ItemKind::Text => "text",
            ItemKind::Poly => "poly",
        }
    }
}

/// One drawable primitive.
#[derive(Clone, Debug)]
pub struct Item {
    pub slot: u32,
    pub kind: ItemKind,
    /// Segment index, or polygon index for `Poly`.
    pub index: u32,
    /// Index into [`Scene::figures`].
    pub figure: u32,
    pub start: [f64; 2],
    pub end: [f64; 2],
    pub angle: f64,
    pub bend: f64,
    pub length: f64,
    pub thickness: f64,
    pub rgb: [u8; 3],
    pub alpha: f64,
    pub opacity: f64,
    pub z: f64,
    /// Range in [`Scene::points`] (bent lines and polygons).
    pub points: (u32, u32),
    /// The object's colour override (for gradient end colours).
    pub color: u32,
    pub scale: f64,
    pub image_text_flags: bool,
    /// Movieclip nesting: index into [`Scene::chains`], or `NO_CHAIN`.
    pub chain: u32,
    /// `ITEM_*` drawing flags.
    pub flags: u8,
}

pub const NO_CHAIN: u32 = u32::MAX;
/// A polygon expanded from a shaped segment: paint it with the segment's brush.
pub const ITEM_SEG_BRUSH: u8 = 1;
/// A fixed colour: ignore the segment's paint and gradient.
pub const ITEM_SOLID: u8 = 2;
/// Stroke `points` as an open polyline (curved Stick Nodes segments).
pub const ITEM_POLYLINE: u8 = 4;

#[derive(Clone, Debug, Default)]
pub struct ObjectGeometry {
    pub slot: u32,
    pub uid: u32,
    pub figure: u32,
    pub root: [f64; 2],
    /// Handle position per segment index (NaN when unresolved).
    pub ends: Vec<[f64; 2]>,
    pub starts: Vec<[f64; 2]>,
    pub opacity: f64,
    pub resolved: bool,
}

impl ObjectGeometry {
    pub fn joint(&self, fig: &Figure, handle: u32) -> Option<[f64; 2]> {
        if handle == 0 {
            return Some(self.root);
        }
        let i = *fig.plan.index_of.get(&handle)? as usize;
        let p = self.ends[i];
        (!p[0].is_nan()).then_some(p)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub objects: Vec<ObjectGeometry>,
    pub items: Vec<Item>,
    pub points: Vec<[f64; 2]>,
    pub figures: Vec<Arc<Figure>>,
    pub camera: Option<Camera>,
    pub background: (u32, u32, f64),
    pub warnings: Vec<String>,
    /// Scene colour key (ARGB) replacing the native background, if any.
    pub background_color: Option<u32>,
    /// Movieclip owner opacities.
    pub owners: Vec<f64>,
    /// Owner chains, outermost first: (owner, child slot inside that clip).
    pub chains: Vec<Vec<(u32, u32)>>,
}

impl Scene {
    pub fn points_of(&self, item: &Item) -> &[[f64; 2]] {
        &self.points[item.points.0 as usize..item.points.1 as usize]
    }
}

/// `arc()` in geometry.mjs: a bent segment sampled as a circular arc.
pub fn arc_points(start: [f64; 2], angle: f64, length: f64, bend: f64, out: &mut Vec<[f64; 2]>) {
    if !start[0].is_finite() || !start[1].is_finite() || !angle.is_finite() || !length.is_finite() || !bend.is_finite() {
        return;
    }
    if bend.abs() < 1e-7 {
        out.push(start);
        out.push([start[0] + length * angle.cos(), start[1] + length * angle.sin()]);
        return;
    }
    let steps = 8f64.max(160f64.min((bend.abs() * 16.0).ceil()).min((length.abs() / 4.0).ceil())) as usize;
    let r = length / bend;
    let (s0, c0) = angle.sin_cos();
    for i in 0..=steps {
        let a = angle + (bend * i as f64) / steps as f64;
        out.push([start[0] + r * (a.sin() - s0), start[1] + r * (c0 - a.cos())]);
    }
}

pub fn fround(v: f64) -> f64 {
    v as f32 as f64
}

pub fn mix_color(base: [u8; 3], raw: u32) -> [u8; 3] {
    let k = raw >> 24;
    if k == 0 {
        return base;
    }
    let c = [(raw & 255) as u8, (raw >> 8 & 255) as u8, (raw >> 16 & 255) as u8];
    if k == 255 {
        return c;
    }
    let mut out = [0u8; 3];
    for i in 0..3 {
        let v = base[i] as i64;
        out[i] = ((v * 256 + k as i64 * (c[i] as i64 - v)) as f64 / 256.0).floor() as u8;
    }
    out
}

/// Per-object build output before it is spliced into the scene buffers.
struct Built {
    geometry: ObjectGeometry,
    items: Vec<Item>,
    points: Vec<[f64; 2]>,
    /// Movieclip content: its own figure table, owners and chains (local ids).
    figures: Vec<Arc<Figure>>,
    owners: Vec<f64>,
    chains: Vec<Vec<(u32, u32)>>,
}

fn build_object(doc: &Document, version: u32, frame: &Frame, slot: usize, figure_slot: u32, fig: &Figure, root: [f64; 2]) -> Built {
    let obj = &frame.objects[slot];
    let n = fig.segments.len();
    let scale = obj.scale;
    let opacity = 1.0 - obj.transparency / 255.0;
    let nan = [f64::NAN, f64::NAN];
    let mut ends = vec![nan; n];
    let mut starts = vec![nan; n];
    let mut items: Vec<Item> = Vec::with_capacity(n + fig.polyfills.len());
    let mut points: Vec<[f64; 2]> = Vec::new();
    // Segment item index per segment (for polygon edges).
    let mut seg_item = vec![u32::MAX; n];
    let plan = &fig.plan;
    let black_override = version < 5 && !fig.segment_colors;
    let mut segment_items: Vec<Item> = Vec::with_capacity(n);
    // Rigged figures evaluate in dependency order with their rig context.
    let rig_plan = plan.rig.clone();
    let mut rig_states: Vec<Option<crate::rig::State>> = if rig_plan.is_some() { vec![None; n] } else { Vec::new() };
    let figure_angle = obj.angles.first().copied().unwrap_or(0.0) - fig.segments.first().map(|s| s.angle).unwrap_or(0.0);
    let order: &[u32] = match &rig_plan {
        Some(r) => &r.order,
        None => &plan.order,
    };
    for &i in order {
        let i = i as usize;
        let seg = &fig.segments[i];
        let parent = plan.parent[i];
        let start = if parent == u32::MAX { root } else { ends[parent as usize] };
        let mut start = if start[0].is_nan() { root } else { start };
        let mut angle = obj.angles.get(i).copied().unwrap_or(seg.angle);
        let mut bend = match &obj.bends {
            Some(b) => b.get(i).copied().unwrap_or(0.0),
            None => seg.bend,
        };
        let mut length = match &obj.lengths {
            Some(l) => l.get(i).copied().unwrap_or(seg.length),
            None => seg.length,
        } * scale;
        let mut width = 1.0;
        let mut rig_handle: Option<([f64; 2], bool)> = None;
        if let Some(rp) = &rig_plan {
            let ctx = crate::rig::Context {
                segments: &fig.segments,
                index_of: &plan.index_of,
                plan: rp,
                root,
                scale,
                figure_angle,
                mirror: obj.image_text_flags,
                len_flag: obj.lengths.is_some(),
                lengths: obj.lengths.as_deref(),
            };
            let joint = |id: u32| -> Option<[f64; 2]> {
                if id == 0 {
                    return Some(root);
                }
                let k = *plan.index_of.get(&id)? as usize;
                (!ends[k][0].is_nan()).then_some(ends[k])
            };
            let st = crate::rig::evaluate(&ctx, &mut rig_states, i, crate::rig::Input { start, angle, length, bend }, &joint);
            start = st.start;
            angle = st.angle;
            length = st.length;
            bend = st.bend;
            width = st.width;
            let derived = seg.rig.as_ref().is_some_and(|r| r.spatial.is_some() || r.weighted.is_some());
            rig_handle = st.handle.map(|h| (h, derived));
        }
        let p0 = points.len() as u32;
        let end;
        if let Some((h, true)) = rig_handle {
            end = [fround(h[0]), fround(h[1])];
        } else if bend.abs() < 1e-7 && start[0].is_finite() && start[1].is_finite() && angle.is_finite() && length.is_finite() {
            end = [fround(start[0] + length * angle.cos()), fround(start[1] + length * angle.sin())];
        } else {
            arc_points(start, angle, length, bend, &mut points);
            let last = points.last().copied().unwrap_or(start);
            end = [fround(last[0]), fround(last[1])];
            if let Some(l) = points.last_mut() {
                *l = end;
            }
        }
        let p1 = points.len() as u32;
        // Children and joins attach at the rig handle (a connector's slider), drawing ends at `end`.
        ends[i] = match rig_handle {
            Some((h, false)) => [fround(h[0]), fround(h[1])],
            _ => end,
        };
        starts[i] = start;
        let rgb = if black_override {
            if (obj.color as i32) < 0 { [0, 0, 0] } else { [(obj.color & 255) as u8, (obj.color >> 8 & 255) as u8, (obj.color >> 16 & 255) as u8] }
        } else {
            mix_color(seg.rgb, obj.color)
        };
        let kind = match seg.prim {
            Prim::Line => ItemKind::Line,
            Prim::SquareLine => ItemKind::SquareLine,
            Prim::Circle => ItemKind::Circle,
            Prim::CircleFill => ItemKind::CircleFill,
            Prim::CircleClear => ItemKind::CircleClear,
            Prim::Image => ItemKind::Image,
            Prim::Text => ItemKind::Text,
        };
        seg_item[i] = segment_items.len() as u32;
        segment_items.push(Item {
            slot: slot as u32,
            kind,
            index: i as u32,
            figure: figure_slot,
            start,
            end,
            angle,
            bend,
            length,
            thickness: seg.thickness * scale.abs() * width,
            rgb,
            alpha: seg.alpha,
            opacity,
            z: seg.z,
            points: (p0, p1),
            color: obj.color,
            scale,
            image_text_flags: obj.image_text_flags,
            chain: NO_CHAIN,
            flags: 0,
        });
        // A curved Stick Nodes segment draws along its sagitta curve.
        if let Some(shape) = crate::sticknodes::shape_for(seg, obj)
            && shape.sagitta != 0.0
            && bend.abs() < 1e-7
        {
            let item = segment_items.last_mut().unwrap();
            let q0 = points.len() as u32;
            crate::sticknodes::curve(shape, shape.reversed, item.start, item.angle, item.length, scale, &mut points);
            item.points = (q0, points.len() as u32);
            item.bend = 1e-6;
            item.flags |= ITEM_POLYLINE;
        }
    }
    let joint = |handle: u32| -> Option<[f64; 2]> {
        if handle == 0 {
            return Some(root);
        }
        let i = *plan.index_of.get(&handle)? as usize;
        (!ends[i][0].is_nan()).then_some(ends[i])
    };
    for (pi, poly) in fig.polyfills.iter().enumerate() {
        let pp = &plan.polygons[pi];
        let p0 = points.len() as u32;
        if let Some(first) = pp.first
            && let Some(p) = joint(first)
        {
            points.push(p);
        }
        for edge in &pp.edges {
            let item = if edge.index == u32::MAX { None } else { segment_items.get(seg_item[edge.index as usize] as usize) };
            match item {
                Some(e) if e.bend.abs() > 1e-7 => {
                    let (a, b) = (e.points.0 as usize, e.points.1 as usize);
                    if b > a {
                        if edge.reverse {
                            for k in (a..b - 1).rev() {
                                points.push(points[k]);
                            }
                        } else {
                            for k in a + 1..b {
                                points.push(points[k]);
                            }
                        }
                    }
                }
                _ => {
                    if let Some(p) = joint(edge.end) {
                        points.push(p);
                    }
                }
            }
        }
        let p1 = points.len() as u32;
        let mut range = (p0, p1);
        if p1 - p0 > 1 && points[p0 as usize] == points[p1 as usize - 1] {
            points.pop();
            range.1 -= 1;
        }
        items.push(Item {
            slot: slot as u32,
            kind: ItemKind::Poly,
            index: pi as u32,
            figure: figure_slot,
            start: root,
            end: root,
            angle: 0.0,
            bend: 0.0,
            length: 0.0,
            thickness: 0.0,
            rgb: mix_color(poly.rgb, obj.color),
            alpha: poly.alpha,
            opacity,
            z: poly.z,
            points: range,
            color: obj.color,
            scale,
            image_text_flags: obj.image_text_flags,
            chain: NO_CHAIN,
            flags: 0,
        });
    }
    // Drawables: polygons, then visible segments in record order, stably by z.
    segment_items.sort_by_key(|it| it.index);
    for it in segment_items {
        let seg = &fig.segments[it.index as usize];
        if !seg.visible {
            continue;
        }
        match crate::sticknodes::shape_for(seg, obj) {
            Some(shape) => {
                let own: Vec<[f64; 2]> = points[it.points.0 as usize..it.points.1 as usize].to_vec();
                crate::sticknodes::expand(&it, shape, &own, &mut points, &mut items);
            }
            None => items.push(it),
        }
    }
    items.sort_by(|a, b| a.z.total_cmp(&b.z));
    let _ = doc;
    Built {
        geometry: ObjectGeometry { slot: slot as u32, uid: obj.uid, figure: fig.id, root, ends, starts, opacity, resolved: true },
        items,
        points,
        figures: Vec::new(),
        owners: Vec::new(),
        chains: Vec::new(),
    }
}

/// The clip's own scene at a local time, shared by every instance.
fn clip_scene(clip: &Movieclip, local: f64) -> Arc<Scene> {
    let key = local.to_bits();
    if let Some(s) = clip.cache.lock().unwrap().get(&key) {
        return s.clone();
    }
    let frame = clip.prepared.evaluate_clip(clip.source_start + local);
    let scene = Arc::new(build(&clip.document, &frame));
    let mut cache = clip.cache.lock().unwrap();
    if cache.len() >= 64 {
        cache.clear();
    }
    cache.insert(key, scene.clone());
    scene
}

/// `buildMovieclipGeometrySteps`: the clip's scene placed at its pivot.
fn build_clip(frame: &Frame, slot: usize, fig: &Figure, clip: &Movieclip, root: [f64; 2]) -> Built {
    let obj = &frame.objects[slot];
    let angle = obj.angles.first().copied().unwrap_or(0.0);
    let scale = obj.scale;
    let flip = if obj.image_text_flags { -1.0 } else { 1.0 };
    let (a, b) = (angle.cos() * scale, angle.sin() * scale);
    let end = [root[0] + 40.0 * angle.cos() * scale, root[1] + 40.0 * angle.sin() * scale];
    let opacity = 1.0 - obj.transparency / 255.0;
    let mut built = Built {
        geometry: ObjectGeometry { slot: slot as u32, uid: obj.uid, figure: fig.id, root, ends: vec![end], starts: vec![root], opacity, resolved: true },
        items: Vec::new(),
        points: Vec::new(),
        figures: Vec::new(),
        owners: Vec::new(),
        chains: Vec::new(),
    };
    let Some(local) = obj.clip_time else { return built };
    let source = clip_scene(clip, local);
    let pivot = clip.pivot;
    let point = |p: [f64; 2]| {
        let (dx, dy) = (p[0] - pivot[0], (p[1] - pivot[1]) * flip);
        [root[0] + a * dx - b * dy, root[1] + b * dx + a * dy]
    };
    built.figures = source.figures.clone();
    built.owners.push(opacity);
    built.owners.extend_from_slice(&source.owners);
    // Chain 0..n of the source shift by one owner and gain this clip as outermost.
    let hidden = clip.document.layers.as_ref().map(|l| l.hidden.clone()).unwrap_or_default();
    let mut chain_ids: std::collections::HashMap<(u32, u32), u32> = std::collections::HashMap::new();
    for it in &source.items {
        let child = &source.objects[it.slot as usize];
        if !hidden.is_empty()
            && let Some(layers) = &clip.document.layers
            && hidden.iter().any(|h| h == layers.layer_of(child.uid))
        {
            continue;
        }
        let chain = *chain_ids.entry((it.slot, it.chain)).or_insert_with(|| {
            let mut c = vec![(0u32, it.slot)];
            if it.chain != NO_CHAIN {
                c.extend(source.chains[it.chain as usize].iter().map(|&(o, p)| (o + 1, p)));
            }
            built.chains.push(c);
            built.chains.len() as u32 - 1
        });
        let p0 = built.points.len() as u32;
        for p in source.points_of(it) {
            built.points.push(point(*p));
        }
        let p1 = built.points.len() as u32;
        built.items.push(Item {
            slot: slot as u32,
            points: (p0, p1),
            start: point(it.start),
            end: point(it.end),
            angle: it.angle * flip + angle,
            bend: it.bend * flip,
            length: it.length * scale,
            thickness: it.thickness * scale.abs(),
            scale: it.scale * scale,
            image_text_flags: it.image_text_flags != obj.image_text_flags,
            chain,
            ..it.clone()
        });
    }
    built
}

/// Builds the scene for an evaluated frame.
pub fn build(doc: &Document, frame: &Frame) -> Scene {
    let count = frame.objects.len();
    let mut scene = Scene {
        objects: vec![ObjectGeometry::default(); count],
        camera: frame.camera,
        background: (frame.background, frame.background_b, frame.background_mix),
        background_color: frame.background_color,
        ..Default::default()
    };
    // Join levels: roots first, then children of resolved parents.
    let mut level = vec![u32::MAX; count];
    let mut order: Vec<Vec<usize>> = Vec::new();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); count];
    let mut current: Vec<usize> = Vec::new();
    for (i, o) in frame.objects.iter().enumerate() {
        match o.join {
            Some(j) if (j.slot as usize) < count => children[j.slot as usize].push(i),
            _ => current.push(i),
        }
    }
    let mut depth = 0;
    while !current.is_empty() {
        let mut next = Vec::new();
        for &i in &current {
            level[i] = depth;
            next.extend(children[i].iter().copied());
        }
        order.push(std::mem::take(&mut current));
        current = next;
        depth += 1;
        if depth as usize > count {
            break;
        }
    }
    // Figure table for items (styled instances resolve to their own figure).
    let mut figure_slot = std::collections::HashMap::new();
    let mut fig_of = vec![u32::MAX; count];
    for (i, o) in frame.objects.iter().enumerate() {
        let fig = match &o.figure_override {
            Some(f) => Some(f),
            None => doc.figure(o.figure),
        };
        if let Some(fig) = fig {
            let len = scene.figures.len() as u32;
            let s = *figure_slot.entry(Arc::as_ptr(fig) as usize).or_insert_with(|| {
                scene.figures.push(fig.clone());
                len
            });
            fig_of[i] = s;
        }
    }
    let mut built: Vec<Option<Built>> = (0..count).map(|_| None).collect();
    for slots in &order {
        let resolve_root = |i: usize, built: &[Option<Built>]| -> Option<[f64; 2]> {
            let o = &frame.objects[i];
            let mut root = [o.root[0], o.root[1]];
            if let Some(j) = o.join {
                let parent = built.get(j.slot as usize)?.as_ref()?;
                let pfig = doc.figure(frame.objects[j.slot as usize].figure)?;
                if let Some(p) = parent.geometry.joint(pfig, j.handle) {
                    root = p;
                }
            }
            Some(root)
        };
        let make = |&i: &usize| -> Option<(usize, Built)> {
            let fig = &scene.figures[*fig_of.get(i)? as usize];
            let root = resolve_root(i, &built).unwrap_or(frame.objects[i].root);
            if let Some(clip) = &fig.movieclip {
                return Some((i, build_clip(frame, i, fig, clip, root)));
            }
            Some((i, build_object(doc, doc.version, frame, i, fig_of[i], fig, root)))
        };
        let results: Vec<(usize, Built)> = if slots.len() >= 32 {
            slots.par_iter().filter_map(make).collect()
        } else {
            slots.iter().filter_map(make).collect()
        };
        for (i, b) in results {
            built[i] = Some(b);
        }
    }
    for (i, l) in level.iter().enumerate() {
        if *l == u32::MAX {
            scene.warnings.push(format!("Cyclic join or unresolved target at object {i}"));
        }
    }
    // Splice in draw order.
    let total_items: usize = built.iter().flatten().map(|b| b.items.len()).sum();
    let total_points: usize = built.iter().flatten().map(|b| b.points.len()).sum();
    scene.items.reserve(total_items);
    scene.points.reserve(total_points);
    for &slot in &frame.draw_order {
        let Some(b) = built[slot as usize].take() else { continue };
        let base = scene.points.len() as u32;
        scene.points.extend_from_slice(&b.points);
        // Movieclip content brings its own figures, owners and chains.
        let figure_map: Vec<u32> = b
            .figures
            .iter()
            .map(|f| {
                let key = Arc::as_ptr(f) as usize;
                let len = scene.figures.len() as u32;
                *figure_slot.entry(key).or_insert_with(|| {
                    scene.figures.push(f.clone());
                    len
                })
            })
            .collect();
        let owner_base = scene.owners.len() as u32;
        scene.owners.extend_from_slice(&b.owners);
        let chain_base = scene.chains.len() as u32;
        for c in &b.chains {
            scene.chains.push(c.iter().map(|&(o, p)| (o + owner_base, p)).collect());
        }
        for mut it in b.items {
            it.points = (it.points.0 + base, it.points.1 + base);
            if !figure_map.is_empty() {
                it.figure = figure_map[it.figure as usize];
            }
            if it.chain != NO_CHAIN {
                it.chain += chain_base;
            }
            scene.items.push(it);
        }
        scene.objects[slot as usize] = b.geometry;
    }
    scene
}
