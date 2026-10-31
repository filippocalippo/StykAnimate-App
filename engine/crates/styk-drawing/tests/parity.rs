//! The drawing engine against the recordings of the JavaScript drawing engine it replaced, case
//! by case: every fixture was produced by the editor's JavaScript modules in Node and is frozen
//! (the modules are gone); the same inputs run here and must produce the same bytes (SHA-256
//! prefixes of tiles, dab shapes and encoded data), the same undo records, the same order and
//! the same error keys.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use styk_doc::json::{base64_strict, parse, to_string};
use styk_doc::{Obj, Value};
use styk_drawing::brush::{dab_shape, jitter_at, Brush, BrushStroke, Dab, Point, PressureMap, Sample, StrokePath};
use styk_drawing::codec::{assemble_tile_blob, decode_tile_blob, EncodedTile, PublishTile, TileEncodeCache, TileEncoder};
use styk_drawing::fill::{flood_tiles, FillOptions};
use styk_drawing::filters::{filter_tiles, Filter};
use styk_drawing::lasso::{capture_mask_selection, capture_selection, Captured};
use styk_drawing::levels::Levels;
use styk_drawing::mask::{combine_masks, crop_mask, fill_mask_tiles, flood_dense, invert_mask, lasso_mask, mask_edges, Combine, DenseFlood, Flooded, Mask, MaskData};
use styk_drawing::stroke::{DrawingStroke, SeedTile, StrokeEngine, StrokeOptions};
use styk_drawing::tiles::{tile_changes, tiles_in_rect, Alpha, Before, Rect, Side, TileChange, TileStore};
use styk_drawing::transform::{indexed_tile_coverage, inverse_matrix, transform_selected_pixels, transform_support_bounds, transform_tile_coverage, transform_tiles, Filter as Sampling, RectF};
use styk_drawing::{clipboard, history, png, prepare, region, textures, zlib};

// ------------------------------------------------------------------ fixture plumbing

fn load(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    parse(&std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

fn get<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.as_obj().and_then(|o| o.get(key)).unwrap_or(&Value::Null)
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

fn items(v: &Value) -> Vec<Value> {
    v.elements().map(|e| e.into_iter().collect()).unwrap_or_default()
}

fn text(v: &Value) -> String {
    v.text().map(|t| t.into_owned()).unwrap_or_default()
}

fn bytes(v: &Value) -> Vec<u8> {
    base64_strict(&text(v)).expect("base64")
}

fn unpack(v: &Value) -> Vec<u8> {
    zlib::inflate(&bytes(v), None, 1 << 30).expect("deflated input")
}

fn hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

struct Fixture {
    root: Value,
    bases: HashMap<String, Vec<Value>>,
}

impl Fixture {
    fn open(name: &str) -> Fixture {
        let root = load(name);
        let mut bases = HashMap::new();
        if let Some(o) = get(&root, "bases").as_obj() {
            for (k, v) in o.iter() {
                bases.insert(k.to_string(), items(v));
            }
        }
        Fixture { root, bases }
    }
    fn tiles(&self, v: &Value) -> TileStore {
        let list = match v {
            Value::Str(name) => self.bases[&**name].clone(),
            Value::Null => Vec::new(),
            other => items(other),
        };
        let mut store = TileStore::new();
        for t in list {
            let t = items(&t);
            store.adopt(num(&t[0]) as i64, num(&t[1]) as i64, styk_drawing::tiles::pixels_from(&unpack(&t[2])), Alpha::Unknown).unwrap();
        }
        store
    }
    fn cases(&self) -> Vec<Value> {
        items(get(&self.root, "cases"))
    }
}

fn n(v: f64) -> Value {
    Value::Num(v)
}

fn s(v: &str) -> Value {
    Value::str(v)
}

fn arr(v: Vec<Value>) -> Value {
    Value::array(v)
}

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut o = Obj::new();
    for (k, v) in pairs {
        o.set(k, v);
    }
    Value::object(o)
}

fn rect_value(r: Option<Rect>) -> Value {
    match r {
        Some(r) => arr(vec![n(r.x as f64), n(r.y as f64), n(r.width as f64), n(r.height as f64)]),
        None => Value::Null,
    }
}

fn tile_hashes(store: &TileStore) -> Value {
    arr(store.iter().map(|t| arr(vec![n(t.tx as f64), n(t.ty as f64), s(&hash(&t.pixels[..]))])).collect())
}

fn side(v: &Side) -> Value {
    match v {
        Side::Absent => Value::Null,
        Side::Uniform(c) => s(&format!("u{:02x}{:02x}{:02x}{:02x}", c[0], c[1], c[2], c[3])),
        Side::Full(p) => s(&hash(&p[..])),
    }
}

fn changes_value(changes: &[TileChange]) -> Value {
    arr(changes.iter().map(|c| arr(vec![n(c.tx as f64), n(c.ty as f64), side(&c.before), side(&c.after)])).collect())
}

fn shape_hash(shapes: &[Dab]) -> String {
    let mut out = Vec::with_capacity(shapes.len() * 88);
    for d in shapes {
        for v in [d.x, d.y, d.radius, d.opacity, d.flow, d.cos, d.sin, d.left, d.top, d.right, d.bottom] {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    hash(&out)
}

fn mask_of(v: &Value) -> Option<Mask> {
    let o = v.as_obj()?;
    let at = |k: &str| num(o.get(k).unwrap_or(&Value::Null));
    let (x, y, w, h) = (at("x") as i64, at("y") as i64, at("width") as i64, at("height") as i64);
    if let Some(points) = o.get("points") {
        let points = items(points).iter().map(|p| (num(&p.item(0).unwrap()), num(&p.item(1).unwrap()))).collect();
        return Some(Mask { x, y, width: w, height: h, data: MaskData::Points(points) });
    }
    let max = o.get("max").and_then(Value::as_f64).unwrap_or(1.0);
    Some(Mask { x, y, width: w, height: h, data: MaskData::Dense { mask: unpack(o.get("data").unwrap()), max } })
}

fn mask_value_out(m: Option<&Mask>) -> Value {
    match m {
        None => Value::Null,
        Some(m) => match &m.data {
            MaskData::Points(p) => obj(vec![("x", n(m.x as f64)), ("y", n(m.y as f64)), ("width", n(m.width as f64)), ("height", n(m.height as f64)), ("points", n(p.len() as f64))]),
            MaskData::Dense { mask, .. } => obj(vec![("x", n(m.x as f64)), ("y", n(m.y as f64)), ("width", n(m.width as f64)), ("height", n(m.height as f64)), ("hash", s(&hash(mask)))]),
        },
    }
}

fn rect_of(v: &Value) -> Option<Rect> {
    let (x, y, w, h) = (num(get(v, "x")), num(get(v, "y")), num(get(v, "width")), num(get(v, "height")));
    [x, y, w, h].iter().all(|v| v.is_finite() && v.trunc() == *v).then(|| Rect::new(x as i64, y as i64, w as i64, h as i64))
}

fn sample_of(v: &Value) -> Sample {
    let at = |i: usize| v.item(i).and_then(|x| x.as_f64());
    Sample { x: at(0).unwrap(), y: at(1).unwrap(), pressure: at(2), time: at(3), ax: at(4), ay: at(5) }
}

fn error_value(key: &str) -> Value {
    obj(vec![("error", s(key))])
}

/// Mismatches of one fixture file.
#[derive(Default)]
struct Report {
    checked: usize,
    failed: Vec<String>,
}

impl Report {
    fn check(&mut self, what: &str, expected: &Value, actual: &Value) {
        self.checked += 1;
        let (e, a) = (to_string(expected), to_string(actual));
        if e != a {
            let cut = |t: &str| if t.len() > 600 { format!("{}…", &t[..600]) } else { t.to_string() };
            self.failed.push(format!("{what}\n  javascript: {}\n  rust:       {}", cut(&e), cut(&a)));
        }
    }
    fn finish(self, file: &str) {
        eprintln!("{file}: {} checks, {} mismatches", self.checked, self.failed.len());
        if !self.failed.is_empty() {
            panic!("{file}: {} of {} checks differ from the JavaScript:\n{}", self.failed.len(), self.checked, self.failed.join("\n"));
        }
    }
}

// ------------------------------------------------------------------ strokes

#[test]
fn strokes_match_the_javascript_stroke_worker() {
    let f = Fixture::open("strokes");
    let mut report = Report::default();
    for case in f.cases() {
        let name = text(get(&case, "name"));
        let settings = get(&case, "settings").clone();
        let brush = Brush::normalize(&settings).unwrap();
        let mask = mask_of(get(&case, "mask"));
        let base = f.tiles(get(&case, "base"));
        let batch = num(get(&case, "batch")) as usize;
        let mirror = get(&case, "mirror").as_bool() == Some(true);
        let samples: Vec<Sample> = items(get(&case, "samples")).iter().map(sample_of).collect();
        let expect = get(&case, "expect");

        let mut paths = vec![BrushStroke::new(brush.clone(), None)];
        if mirror {
            paths.push(BrushStroke::new(brush.clone(), Some(brush.seed.wrapping_add(7919))));
        }
        let mut engine = StrokeEngine::new();
        engine.begin(1, &settings, mask.clone()).unwrap();
        let mut pending: Vec<Dab> = Vec::new();
        let mut all: Vec<Dab> = Vec::new();
        let mut sent: HashSet<(i64, i64)> = HashSet::new();
        let mut batches: Vec<Value> = Vec::new();
        let mut seq = 0.0;
        let mut tail_version: Option<u64> = None;
        let mut flush = |paths: &mut Vec<BrushStroke>, pending: &mut Vec<Dab>| {
            let version: u64 = paths.iter().map(|p| p.tail_version).sum();
            let tail: Option<Vec<Dab>> = (brush.taper_out > 0.0).then(|| paths.iter_mut().flat_map(|p| p.tail_shapes().to_vec()).collect());
            let send_tail = if tail.is_some() && Some(version) != tail_version {
                tail_version = Some(version);
                tail
            } else {
                None
            };
            let dabs = std::mem::take(pending);
            all.extend_from_slice(&dabs);
            let mut seeds = Vec::new();
            let mut seeded = Vec::new();
            for d in dabs.iter().chain(send_tail.iter().flatten()) {
                let mut ty = (d.top / 64.0).floor() as i64;
                while ((ty * 64) as f64) < d.bottom {
                    let mut tx = (d.left / 64.0).floor() as i64;
                    while ((tx * 64) as f64) < d.right {
                        if sent.insert((tx, ty)) {
                            let pixels = base.get(tx, ty).map(|t| t.pixels.to_vec());
                            seeded.push(arr(vec![n(tx as f64), n(ty as f64), n(if pixels.is_some() { 1.0 } else { 0.0 })]));
                            seeds.push(SeedTile { tx, ty, pixels });
                        }
                        tx += 1;
                    }
                    ty += 1;
                }
            }
            seq += 1.0;
            let result = engine.dabs(1, seq, &dabs, seeds, send_tail.as_deref()).unwrap().unwrap();
            batches.push(obj(vec![
                ("shapes", n(dabs.len() as f64)),
                ("hash", s(&shape_hash(&dabs))),
                ("tail", send_tail.as_ref().map_or(Value::Null, |t| s(&shape_hash(t)))),
                ("tiles", arr(seeded)),
                ("dirty", arr(result.tiles.iter().map(|(tx, ty, p)| arr(vec![n(*tx as f64), n(*ty as f64), s(&hash(&p[..]))])).collect())),
                ("rect", rect_value(result.dirty)),
            ]));
        };
        let axis = 120.0;
        for (i, sample) in samples.iter().enumerate() {
            paths[0].sample(sample, &mut |d| pending.push(d)).unwrap();
            if mirror {
                let mirrored = Sample { x: 2.0 * axis - sample.x, ..*sample };
                paths[1].sample(&mirrored, &mut |d| pending.push(d)).unwrap();
            }
            if i % batch == batch - 1 {
                flush(&mut paths, &mut pending);
            }
        }
        for p in paths.iter_mut() {
            p.finish(&mut |d| pending.push(d));
        }
        flush(&mut paths, &mut pending);
        let changes = engine.end(1).unwrap().unwrap();
        report.check(&format!("{name}: dab shapes"), get(expect, "shapes"), &obj(vec![("count", n(all.len() as f64)), ("hash", s(&shape_hash(&all)))]));
        let expected_batches = items(get(expect, "batches"));
        for (i, (e, a)) in expected_batches.iter().zip(batches.iter()).enumerate() {
            report.check(&format!("{name}: batch {i}"), e, a);
        }
        report.check(&format!("{name}: batch count"), &n(expected_batches.len() as f64), &n(batches.len() as f64));
        report.check(&format!("{name}: undo records"), get(expect, "changes"), &changes_value(&changes));
        let live = get(expect, "live");
        if !live.is_null() {
            let working = settings.as_obj().and_then(|o| o.get("workingBytes")).and_then(Value::as_f64);
            let mut stroke = DrawingStroke::new(f.tiles(get(&case, "base")), brush.clone(), StrokeOptions { working_bytes: working, mask: mask.clone() }, None);
            for sample in &samples {
                stroke.sample(sample).unwrap();
            }
            let changes = stroke.finish().unwrap();
            report.check(&format!("{name}: live undo records"), get(live, "changes"), &changes_value(&changes));
            report.check(&format!("{name}: live tiles"), get(live, "tiles"), &tile_hashes(&stroke.store));
        }
    }
    report.finish("strokes");
}

// ------------------------------------------------------------------ brush model

#[test]
fn the_brush_model_matches_the_javascript() {
    let f = Fixture::open("brush");
    let mut report = Report::default();
    let brush_value = |b: &Brush| {
        let modes = |m: styk_drawing::brush::Stabilizer| if m == styk_drawing::brush::Stabilizer::String { "string" } else { "average" };
        obj(vec![
            ("size", n(b.size)), ("color", arr(b.color.iter().map(|&c| n(c)).collect())), ("opacity", n(b.opacity)), ("flow", n(b.flow)), ("hardness", n(b.hardness)), ("erase", Value::Bool(b.erase)),
            ("pressureSize", Value::Bool(b.pressure_size)), ("pressureOpacity", Value::Bool(b.pressure_opacity)), ("pressureFlow", Value::Bool(b.pressure_flow)), ("sizeCurve", n(b.size_curve)), ("opacityCurve", n(b.opacity_curve)),
            ("pressureCurve", arr(b.pressure_curve.iter().map(|&c| n(c)).collect())), ("stabilization", n(b.stabilization)), ("stabilizerMode", s(modes(b.stabilizer_mode))), ("spacingRatio", n(b.spacing_ratio)),
            ("tip", s(b.tip.name())), ("roundness", n(b.roundness)), ("angle", n(b.angle)),
            ("angleMode", s(match b.angle_mode { styk_drawing::brush::AngleMode::Fixed => "fixed", styk_drawing::brush::AngleMode::Direction => "direction", styk_drawing::brush::AngleMode::Tilt => "tilt" })),
            ("scatter", n(b.scatter)), ("sizeJitter", n(b.size_jitter)), ("opacityJitter", n(b.opacity_jitter)), ("angleJitter", n(b.angle_jitter)), ("taperIn", n(b.taper_in)), ("taperOut", n(b.taper_out)),
            ("texture", n(b.texture)), ("grain", s(b.grain.name())), ("grainScale", n(b.grain_scale)),
            ("blend", s(match b.blend { styk_drawing::brush::Blend::Normal => "normal", styk_drawing::brush::Blend::Behind => "behind", styk_drawing::brush::Blend::Multiply => "multiply", styk_drawing::brush::Blend::Screen => "screen", styk_drawing::brush::Blend::Overlay => "overlay", styk_drawing::brush::Blend::Color => "color", styk_drawing::brush::Blend::Smudge => "smudge" })),
            ("alphaLock", Value::Bool(b.alpha_lock)), ("smudgeLength", n(b.smudge_length)), ("colorRate", n(b.color_rate)), ("seed", n(b.seed as f64)), ("pixelsPerUnit", n(b.pixels_per_unit)),
        ])
    };
    for (i, case) in items(get(&f.root, "normalize")).iter().enumerate() {
        let b = Brush::normalize(get(case, "settings")).unwrap();
        report.check(&format!("normalize {i}"), get(case, "brush"), &brush_value(&b));
    }
    for (i, case) in items(get(&f.root, "refused")).iter().enumerate() {
        let error = Brush::normalize(get(case, "settings")).err().map(|e| e.key).unwrap_or("none");
        report.check(&format!("refused {i}"), get(case, "error"), &s(error));
    }
    for (i, case) in items(get(&f.root, "curves")).iter().enumerate() {
        let c = items(get(case, "curve")).iter().map(num).collect::<Vec<_>>();
        let map = PressureMap::new([c[0], c[1], c[2], c[3]]).unwrap();
        let values = (0..41).map(|k| n(map.map(k as f64 / 40.0 - 0.1))).collect();
        report.check(&format!("pressure curve {i}"), get(case, "values"), &arr(values));
    }
    for (i, j) in items(get(&f.root, "jitter")).iter().enumerate() {
        let v: Vec<f64> = items(j).iter().map(num).collect();
        report.check(&format!("jitter {i}"), &n(v[3]), &n(jitter_at(v[0] as u32, v[1], v[2] as u32)));
    }
    for (i, case) in items(get(&f.root, "shapes")).iter().enumerate() {
        let brush = Brush::normalize(get(case, "settings")).unwrap();
        let p = get(case, "point");
        let point = Point { x: num(get(p, "x")), y: num(get(p, "y")), pressure: num(get(p, "pressure")), index: num(get(p, "index")), dir: num(get(p, "dir")), ax: num(get(p, "ax")), ay: num(get(p, "ay")), taper: num(get(p, "taper")), ..Point::default() };
        let shape = dab_shape(&brush, &point, brush.seed).unwrap();
        let actual = obj(vec![("x", n(shape.x)), ("y", n(shape.y)), ("radius", n(shape.radius)), ("opacity", n(shape.opacity)), ("flow", n(shape.flow)), ("cos", n(shape.cos)), ("sin", n(shape.sin)), ("left", n(shape.left)), ("top", n(shape.top)), ("right", n(shape.right)), ("bottom", n(shape.bottom))]);
        report.check(&format!("dab shape {i}"), get(case, "shape"), &actual);
    }
    let atlas = textures::atlas();
    report.check("texture atlas", get(&f.root, "atlas"), &obj(vec![("bytes", n(atlas.len() as f64)), ("hash", s(&hash(atlas)))]));
    for (i, case) in items(get(&f.root, "path")).iter().enumerate() {
        let brush = Brush::normalize(get(case, "settings")).unwrap();
        let mut path = StrokePath::new(&brush);
        let mut dabs = Vec::new();
        for sample in items(get(case, "samples")) {
            path.sample(&sample_of(&sample), &mut |d| dabs.push(d)).unwrap();
        }
        path.finish(&mut |d| dabs.push(d));
        let mut raw = Vec::new();
        for d in &dabs {
            for v in [d.x, d.y, d.pressure, d.time, d.ax, d.ay, d.dir, d.dist] {
                raw.extend_from_slice(&v.to_le_bytes());
            }
        }
        report.check(&format!("stroke path {i}"), &obj(vec![("count", get(case, "count").clone()), ("hash", get(case, "hash").clone())]), &obj(vec![("count", n(dabs.len() as f64)), ("hash", s(&hash(&raw)))]));
    }
    report.finish("brush");
}

// ------------------------------------------------------------------ fills and masks

#[test]
fn fills_match_the_javascript() {
    let f = Fixture::open("fills");
    let mut report = Report::default();
    for case in f.cases() {
        let name = text(get(&case, "name"));
        let o = get(&case, "options");
        let mut store = f.tiles(get(&case, "base"));
        let clip = mask_of(get(&case, "clip"));
        let source = match get(&case, "source") {
            Value::Null => None,
            v => Some(unpack(v)),
        };
        let color: Vec<f64> = items(get(o, "color")).iter().map(num).collect();
        let actual = match rect_of(get(o, "bounds")) {
            None => error_value("errors.drawingFill.invalidFillBounds"),
            Some(bounds) => {
                let options = FillOptions {
                    x: num(get(o, "x")),
                    y: num(get(o, "y")),
                    color: if color.len() == 4 { [color[0], color[1], color[2], color[3]] } else { [0.0, 0.0, 0.0, 255.0] },
                    tolerance: get(o, "tolerance").as_f64().unwrap_or(16.0),
                    expansion: get(o, "expansion").as_f64().unwrap_or(0.0),
                    gap: get(o, "gap").as_f64().unwrap_or(0.0),
                    bounds,
                    source: source.as_deref(),
                    clip: clip.as_ref(),
                    max_bytes: get(o, "maxBytes").as_f64().unwrap_or(768.0 * 1024.0 * 1024.0),
                };
                match flood_tiles(&mut store, &options) {
                    Ok(changes) => obj(vec![("changes", changes_value(&changes)), ("tiles", tile_hashes(&store))]),
                    Err(e) => error_value(e.key),
                }
            }
        };
        report.check(&name, get(&case, "expect"), &actual);
    }
    report.finish("fills");
}

#[test]
fn masks_and_the_magic_wand_match_the_javascript() {
    let f = Fixture::open("masks");
    let mut report = Report::default();
    for case in items(get(&f.root, "wand")) {
        let o = get(&case, "options");
        let mut store = f.tiles(get(&case, "base"));
        let clip = mask_of(get(&case, "clip"));
        let flood = DenseFlood {
            x: num(get(o, "x")),
            y: num(get(o, "y")),
            color: [0.0, 0.0, 0.0, 255.0],
            tolerance: get(o, "tolerance").as_f64().unwrap_or(16.0),
            expansion: get(o, "expansion").as_f64().unwrap_or(0.0),
            gap: get(o, "gap").as_f64().unwrap_or(0.0),
            bounds: rect_of(get(o, "bounds")).unwrap(),
            source: None,
            clip: clip.as_ref(),
        };
        let actual = match flood_dense(&mut store, &flood, true).unwrap() {
            Flooded::Nothing => s("none"),
            Flooded::Selection(m) => mask_value_out(m.as_ref()),
            Flooded::Filled => unreachable!(),
        };
        report.check(&format!("{}: selection", text(get(&case, "name"))), get(get(&case, "expect"), "mask"), &actual);
    }
    for case in items(get(&f.root, "dense")) {
        let o = get(&case, "options");
        let mut store = f.tiles(get(&case, "base"));
        let color: Vec<f64> = items(get(o, "color")).iter().map(num).collect();
        let flood = DenseFlood {
            x: num(get(o, "x")),
            y: num(get(o, "y")),
            color: [color[0], color[1], color[2], color[3]],
            tolerance: get(o, "tolerance").as_f64().unwrap_or(16.0),
            expansion: get(o, "expansion").as_f64().unwrap_or(0.0),
            gap: get(o, "gap").as_f64().unwrap_or(0.0),
            bounds: rect_of(get(o, "bounds")).unwrap(),
            source: None,
            clip: None,
        };
        flood_dense(&mut store, &flood, false).unwrap();
        report.check(&text(get(&case, "name")), get(get(&case, "expect"), "tiles"), &tile_hashes(&store));
    }
    for (i, case) in items(get(&f.root, "lasso")).iter().enumerate() {
        let points: Vec<(f64, f64)> = items(get(case, "points")).iter().map(|p| (num(&p.item(0).unwrap()), num(&p.item(1).unwrap()))).collect();
        report.check(&format!("lasso mask {i}"), get(case, "expect"), &mask_value_out(Some(&lasso_mask(&points))));
    }
    let ops = get(&f.root, "ops");
    let (a, b) = (mask_of(get(ops, "a")).unwrap(), mask_of(get(ops, "b")).unwrap());
    for case in items(get(ops, "combine")) {
        let mode = match text(get(&case, "mode")).as_str() {
            "add" => Combine::Add,
            "subtract" => Combine::Subtract,
            "intersect" => Combine::Intersect,
            _ => Combine::Replace,
        };
        let m = combine_masks(Some(a.clone()), Some(b.clone()), mode).unwrap();
        report.check(&format!("combine {}", text(get(&case, "mode"))), get(&case, "expect"), &mask_value_out(m.as_ref()));
    }
    report.check("invert", get(ops, "invert"), &mask_value_out(invert_mask(Some(&a), Rect::new(-20, -10, 140, 100)).unwrap().as_ref()));
    report.check("invert nothing", get(ops, "invertNone"), &mask_value_out(invert_mask(None, Rect::new(0, 0, 5, 4)).unwrap().as_ref()));
    let crop_input: Vec<u8> = (0..200).map(|i| (i % 20 > 6 && i % 20 < 12 && i > 40 && i < 160) as u8).collect();
    report.check("crop", get(ops, "crop"), &mask_value_out(crop_mask(Mask::dense(5, 6, 20, 10, crop_input)).as_ref()));
    let edges = mask_edges(&a, 250000).unwrap();
    let mut raw = Vec::new();
    for e in &edges {
        raw.extend_from_slice(&(*e as f64).to_le_bytes());
    }
    report.check("edges", &arr(vec![get(ops, "edges").clone(), get(ops, "edgesCount").clone()]), &arr(vec![s(&hash(&raw)), n(edges.len() as f64)]));
    for case in items(get(&f.root, "fillMask")) {
        let mut store = f.tiles(get(&case, "base"));
        let mask = mask_of(get(&case, "mask")).unwrap();
        let c: Vec<f64> = items(get(&case, "color")).iter().map(num).collect();
        fill_mask_tiles(&mut store, &mask, [c[0], c[1], c[2], c[3]]).unwrap();
        report.check(&text(get(&case, "name")), get(get(&case, "expect"), "tiles"), &tile_hashes(&store));
    }
    report.finish("masks");
}

// ------------------------------------------------------------------ filters

#[test]
fn filters_match_the_javascript() {
    let f = Fixture::open("filters");
    let mut report = Report::default();
    for case in f.cases() {
        let o = get(&case, "options");
        let mut store = f.tiles(get(&case, "base"));
        let mask = mask_of(get(&case, "mask"));
        let kind = text(get(o, "kind"));
        let bounds = rect_of(get(o, "bounds")).unwrap();
        let x = |k: &str, d: f64| get(o, k).as_f64().unwrap_or(d);
        let filter = match kind.as_str() {
            "blur" => Some(Filter::Blur { radius: x("radius", 4.0) }),
            "hsl" => Some(Filter::Hsl { hue: x("hue", 0.0), saturation: x("saturation", 0.0), lightness: x("lightness", 0.0) }),
            "brightness" => Some(Filter::Brightness { brightness: x("brightness", 0.0), contrast: x("contrast", 0.0) }),
            "invert" => Some(Filter::Invert),
            _ => None,
        };
        let mut before = Before::new();
        let blur = kind == "blur";
        if blur {
            for (tx, ty) in tiles_in_rect(bounds.x, bounds.y, bounds.width, bounds.height) {
                before.set(tx as i32, ty as i32, store.get(tx, ty).map(|t| t.pixels.clone()));
            }
        }
        let result = match filter {
            // filterTiles validates its bounds before the kind.
            None => match styk_drawing::filters::point_filter_work(&store, bounds) {
                Err(e) => Err(e),
                Ok(_) => Err(styk_drawing::DrawingError::new("errors.drawingController.unknownDrawingFilter")),
            },
            Some(filter) => filter_tiles(&mut store, bounds, filter, mask.as_ref(), Some(&mut before)),
        };
        let actual = match result {
            Err(e) => error_value(e.key),
            Ok(()) => {
                if blur {
                    store.prune();
                }
                obj(vec![("changes", changes_value(&tile_changes(&store, before.entries()))), ("tiles", tile_hashes(&store))])
            }
        };
        report.check(&text(get(&case, "name")), get(&case, "expect"), &actual);
    }
    report.finish("filters");
}

// ------------------------------------------------------------------ selections and transforms

fn captured_value(bounds: Option<Rect>, tiles: &[Captured]) -> Value {
    obj(vec![
        ("bounds", rect_value(bounds)),
        (
            "tiles",
            arr(tiles
                .iter()
                .map(|t| arr(vec![n(t.tx as f64), n(t.ty as f64), s(&hash(&t.pixels[..])), rect_value(t.alpha), n(if t.full { 1.0 } else { 0.0 }), t.remaining.as_ref().map_or(Value::Null, |r| s(&hash(&r[..]))), rect_value(t.remaining_bounds)]))
                .collect()),
        ),
    ])
}

#[test]
fn selection_capture_matches_the_javascript() {
    let f = Fixture::open("selections");
    let mut report = Report::default();
    for case in f.cases() {
        let store = f.tiles(get(&case, "base"));
        let max_bytes = num(get(&case, "maxBytes"));
        let result = match mask_of(get(&case, "mask")) {
            Some(mask) => capture_mask_selection(&store, &mask, max_bytes),
            None => {
                let points: Vec<(f64, f64)> = items(get(&case, "points")).iter().map(|p| (num(&p.item(0).unwrap()), num(&p.item(1).unwrap()))).collect();
                capture_selection(&store, &points, max_bytes)
            }
        };
        let actual = match result {
            Ok((bounds, tiles)) => captured_value(bounds, &tiles),
            Err(e) => error_value(e.key),
        };
        report.check(&text(get(&case, "name")), get(&case, "expect"), &actual);
    }
    report.finish("selections");
}

fn matrix(v: &Value) -> [f64; 6] {
    let m: Vec<f64> = items(v).iter().map(num).collect();
    [m[0], m[1], m[2], m[3], m[4], m[5]]
}

#[test]
fn transforms_match_the_javascript() {
    let f = Fixture::open("transforms");
    let mut report = Report::default();
    for case in f.cases() {
        let name = text(get(&case, "name"));
        let kind = text(get(&case, "kind"));
        let filter = Sampling::named(&text(get(&case, "filter"))).unwrap();
        let actual = match kind.as_str() {
            "selection" => {
                let mut store = f.tiles(get(&case, "base"));
                let source = f.tiles(get(&case, "source"));
                let pose = get(&case, "pose");
                let p = |k: &str| get(pose, k).as_f64().unwrap_or(1.0);
                let m = styk_drawing::transform::selection_matrix(p("angle"), p("scale"), p("fx"), p("fy"), p("cx"), p("cy"), p("dx"), p("dy"));
                report.check(&format!("{name}: selection matrix"), get(&case, "matrix"), &arr(m.iter().map(|&v| n(v)).collect()));
                match transform_selected_pixels(&mut store, &source, &m, get(&case, "remove").as_bool() == Some(true), filter, num(get(&case, "maxBytes"))) {
                    Ok(changes) => obj(vec![("changes", changes_value(&changes)), ("tiles", tile_hashes(&store))]),
                    Err(e) => error_value(e.key),
                }
            }
            "resample" => {
                let source = f.tiles(get(&case, "base"));
                let r = num(get(&case, "ratio"));
                let mut out = TileStore::new();
                match transform_tiles(&source, &[r, 0.0, 0.0, r, 0.0, 0.0], &mut out, None, filter, num(get(&case, "maxBytes"))) {
                    Ok(()) => {
                        let bounds = out.bounds();
                        let alpha = out.iter().map(|t| match t.alpha_bounds() {
                            Some(b) => rect_value(Some(b)),
                            None => s("empty"),
                        });
                        obj(vec![("tiles", tile_hashes(&out)), ("bounds", rect_value(bounds)), ("alpha", arr(alpha.collect()))])
                    }
                    Err(e) => error_value(e.key),
                }
            }
            _ => {
                let source = f.tiles(get(&case, "base"));
                let mut target = f.tiles(get(&case, "target"));
                let mut before = Before::new();
                match transform_tiles(&source, &matrix(get(&case, "matrix")), &mut target, Some(&mut before), filter, styk_drawing::transform::TRANSFORM_BYTES) {
                    Ok(()) => obj(vec![("changes", changes_value(&tile_changes(&target, before.entries()))), ("tiles", tile_hashes(&target))]),
                    Err(e) => error_value(e.key),
                }
            }
        };
        report.check(&name, get(&case, "expect"), &actual);
    }
    let base = f.tiles(get(&f.root, "base"));
    for (i, c) in items(get(&f.root, "coverage")).iter().enumerate() {
        let m = matrix(get(c, "matrix"));
        let filter = Sampling::named(&text(get(c, "filter"))).unwrap();
        let keys = |list: Vec<(i64, i64)>| s(&list.iter().map(|(x, y)| format!("{x},{y}")).collect::<Vec<_>>().join(";"));
        let coverage = transform_tile_coverage(&base, &m, filter, styk_drawing::transform::TRANSFORM_BYTES).unwrap();
        report.check(&format!("coverage {i}"), &arr(vec![get(c, "tiles").clone(), get(c, "keys").clone()]), &arr(vec![n(coverage.len() as f64), keys(coverage)]));
        report.check(&format!("indexed coverage {i}"), get(c, "indexed"), &keys(indexed_tile_coverage(&[(0, 0), (-3, 2)], &m, filter, styk_drawing::transform::TRANSFORM_BYTES).unwrap()));
        let support = transform_support_bounds(RectF { x: -10.5, y: 3.0, width: 70.0, height: 33.0 }, &m, filter).unwrap();
        report.check(&format!("support bounds {i}"), get(c, "support"), &obj(vec![("x", n(support.x)), ("y", n(support.y)), ("width", n(support.width)), ("height", n(support.height))]));
        let _ = inverse_matrix(&m);
    }
    report.finish("transforms");
}

// ------------------------------------------------------------------ levels and codecs

#[test]
fn reduced_levels_match_the_javascript() {
    let f = Fixture::open("levels");
    let mut report = Report::default();
    for case in f.cases() {
        let store = f.tiles(get(&case, "base"));
        let mut levels = Levels::new();
        for (k, expected) in items(get(&case, "levels")).iter().enumerate() {
            report.check(&format!("{} level {}", text(get(&case, "name")), k + 1), expected, &tile_hashes(&levels.level(&store, k + 1, None)));
        }
    }
    report.finish("levels");
}

#[test]
fn codecs_match_the_javascript() {
    let f = Fixture::open("codecs");
    let root = &f.root;
    let mut report = Report::default();
    let mut encoder = TileEncoder::new();
    for (i, t) in items(get(root, "pngs")).iter().enumerate() {
        let pixels = unpack(get(t, "data"));
        report.check(&format!("tile PNG {i}"), get(t, "png"), &s(&hash(&png::encode_rgba_png(&pixels, 64, 64))));
        report.check(&format!("encodeTile {i}"), get(t, "tile"), &s(&hash(&encoder.encode(&pixels))));
    }
    for (i, t) in items(get(root, "streams")).iter().enumerate() {
        let data = bytes(get(t, "data"));
        let packed = zlib::deflate(&data);
        report.check(&format!("deflate {i}"), &arr(vec![get(t, "deflate").clone(), get(t, "length").clone()]), &arr(vec![s(&hash(&packed)), n(packed.len() as f64)]));
        assert_eq!(zlib::inflate(&packed, Some(data.len()), usize::MAX).unwrap(), data);
    }
    for t in items(get(root, "filtered")) {
        let image = png::decode_png(&bytes(get(&t, "png")), None).unwrap();
        report.check(&format!("PNG filter {} with {} channels", num(get(&t, "filter")), num(get(&t, "channels"))), get(&t, "expect"), &obj(vec![("width", n(image.width as f64)), ("height", n(image.height as f64)), ("pixels", s(&hash(&image.pixels)))]));
    }
    for t in items(get(root, "broken")) {
        let expected = get(&t, "expected");
        let dims = (!expected.is_null()).then(|| (num(get(expected, "width")) as usize, num(get(expected, "height")) as usize));
        let error = png::decode_png(&bytes(get(&t, "png")), dims).err().map(|e| e.key).unwrap_or("none");
        report.check(&format!("broken PNG {}", text(get(&t, "name"))), get(&t, "error"), &s(error));
    }
    let blob = get(root, "blob");
    let encoded: Vec<EncodedTile> = items(get(blob, "tiles")).iter().map(|t| EncodedTile { tx: num(&t.item(0).unwrap()) as i32, ty: num(&t.item(1).unwrap()) as i32, png: bytes(&t.item(2).unwrap()).into() }).collect();
    let assembled = assemble_tile_blob(&encoded).unwrap();
    report.check("tile blob", &arr(vec![get(blob, "blob").clone(), get(blob, "blobLength").clone()]), &arr(vec![s(&hash(&assembled)), n(assembled.len() as f64)]));
    let decoded = decode_tile_blob(&assembled, None, 512.0 * 1024.0 * 1024.0).unwrap();
    report.check("decoded blob", get(blob, "decoded"), &arr(decoded.iter().map(|t| arr(vec![n(t.tx as f64), n(t.ty as f64), s(&hash(&t.pixels[..])), s(&hash(&t.png))])).collect()));
    let shard = decode_tile_blob(&assembled, Some((1, 3)), 512.0 * 1024.0 * 1024.0).unwrap();
    report.check("blob shard", get(blob, "shard"), &arr(shard.iter().map(|t| arr(vec![n(t.tx as f64), n(t.ty as f64)])).collect()));
    let mut duplicate = encoded.clone();
    duplicate.push(encoded[0].clone());
    report.check("blob duplicate", get(blob, "duplicate"), &s(assemble_tile_blob(&duplicate).err().unwrap().key));
    let mut trailing = assembled.clone();
    trailing.push(0);
    report.check("blob trailing", get(blob, "trailing"), &s(decode_tile_blob(&trailing, None, 1e12).err().unwrap().key));
    report.check("blob budget", get(blob, "budget"), &s(decode_tile_blob(&assembled, None, 1000.0).err().unwrap().key));
    let mut cache = TileEncodeCache::new(60000);
    for (i, step) in items(get(root, "cache")).iter().enumerate() {
        let cel = text(get(step, "celId"));
        let parse_key = |k: &Value| {
            let t = text(k);
            let (x, y) = t.split_once(',').unwrap();
            (x.parse::<i32>().unwrap(), y.parse::<i32>().unwrap())
        };
        let keep: Option<Vec<(i32, i32)>> = match get(step, "keep") {
            Value::Null => None,
            v => Some(items(v).iter().map(parse_key).collect()),
        };
        if !get(step, "adopt").is_null() {
            cache.adopt(&cel, items(get(step, "adopt")).iter().map(|t| EncodedTile { tx: num(&t.item(0).unwrap()) as i32, ty: num(&t.item(1).unwrap()) as i32, png: bytes(&t.item(2).unwrap()).into() }).collect());
        }
        let tiles: Vec<PublishTile> = items(get(step, "tiles"))
            .iter()
            .map(|t| {
                let (tx, ty) = (num(&t.item(0).unwrap()) as i32, num(&t.item(1).unwrap()) as i32);
                match t.item(2).unwrap() {
                    Value::Null => PublishTile::Png { tx, ty, png: bytes(&t.item(3).unwrap()).into() },
                    data => PublishTile::Pixels { tx, ty, pixels: unpack(&data) },
                }
            })
            .collect();
        let result = cache.encode(&cel, keep.as_deref(), tiles, get(step, "partial").as_bool() == Some(true)).unwrap();
        let actual = obj(vec![
            ("encoded", n(result.encoded as f64)),
            ("tiles", arr(result.tiles.iter().map(|t| arr(vec![n(t.tx as f64), n(t.ty as f64), s(&hash(&t.png))])).collect())),
            ("missing", if result.missing.is_empty() { Value::Null } else { arr(result.missing.iter().map(|(x, y)| s(&format!("{x},{y}"))).collect()) }),
            ("blob", result.blob.as_ref().map_or(Value::Null, |b| s(&hash(b)))),
            ("reused", if result.blob.is_some() { n(result.reused as f64) } else { Value::Null }),
            ("bytes", n(cache.bytes as f64)),
        ]);
        report.check(&format!("encode cache step {i}"), get(step, "expect"), &actual);
    }
    let h = get(root, "history");
    let changes: Vec<TileChange> = items(get(h, "changes"))
        .iter()
        .map(|c| {
            let sidev = |v: Value| match v {
                Value::Null => Side::Absent,
                data => Side::from_slice(Some(&unpack(&data))),
            };
            TileChange { tx: num(&c.item(0).unwrap()) as i32, ty: num(&c.item(1).unwrap()) as i32, before: sidev(c.item(2).unwrap()), after: sidev(c.item(3).unwrap()) }
        })
        .collect();
    let chunk = history::encode_chunk(&changes).unwrap();
    report.check("history chunk", &arr(vec![get(h, "chunk").clone(), get(h, "length").clone()]), &arr(vec![s(&hash(&chunk)), n(chunk.len() as f64)]));
    report.check("history round trip", get(h, "round"), &changes_value(&history::decode_chunk(&chunk).unwrap()));
    report.check("history damaged", get(h, "damaged"), &s(history::decode_chunk(&chunk[..chunk.len() - 3]).err().unwrap().key));
    let mut trailing = chunk.clone();
    trailing.push(0);
    let length = trailing.len() as u32;
    trailing[8..12].copy_from_slice(&length.to_le_bytes());
    report.check("history trailing", get(h, "trailing"), &s(history::decode_chunk(&trailing).err().unwrap().key));
    report.check("history empty", get(h, "empty"), &s(history::encode_chunk(&[]).err().unwrap().key));
    let p = get(root, "prepare");
    let input = items(get(p, "input")).iter().map(|t| (num(&t.item(0).unwrap()) as i64, num(&t.item(1).unwrap()) as i64, match t.item(2).unwrap() { Value::Null => None, data => Some(unpack(&data)) })).collect();
    let prepared = prepare::materialize(input).unwrap();
    report.check("preparation", get(p, "prepared"), &arr(prepared.iter().map(|t| match &t.pixels {
        Some((px, b)) => arr(vec![n(t.tx as f64), n(t.ty as f64), s(&hash(&px[..])), rect_value(Some(*b))]),
        None => arr(vec![n(t.tx as f64), n(t.ty as f64), Value::Null, Value::Null]),
    }).collect()));
    let c = get(root, "clipboard");
    let clip_tiles: Vec<clipboard::ClipTile> = items(get(c, "copy"))
        .iter()
        .map(|t| {
            let (tx, ty) = (num(&t.item(0).unwrap()), num(&t.item(1).unwrap()));
            match t.item(2).unwrap() {
                Value::Null => clipboard::ClipTile::Png { tx, ty, png: bytes(&t.item(3).unwrap()) },
                data => clipboard::ClipTile::Pixels { tx, ty, pixels: unpack(&data) },
            }
        })
        .collect();
    let copied = clipboard::encode_tiles(&clip_tiles, 384.0 * 1024.0 * 1024.0).unwrap();
    report.check("clipboard copy", get(c, "copied"), &arr(copied.iter().map(|(x, y, url)| arr(vec![n(*x as f64), n(*y as f64), s(&hash(url.as_bytes()))])).collect()));
    let (pasted, encoded_bytes) = clipboard::decode(get(c, "packet"), 384.0 * 1024.0 * 1024.0).unwrap();
    report.check("clipboard paste", &arr(vec![get(c, "pasted").clone(), get(c, "encodedBytes").clone()]), &arr(vec![tile_hashes(&pasted), n(encoded_bytes)]));
    let (v1, _) = clipboard::decode(get(c, "v1"), 384.0 * 1024.0 * 1024.0).unwrap();
    report.check("clipboard version 1", get(c, "pastedV1"), &tile_hashes(&v1));
    let mut refused = get(c, "packet").clone();
    if let Value::Obj(o) = &mut refused {
        let o = Arc::make_mut(o);
        let mut tiles = items(o.get("tiles").unwrap());
        tiles.push(tiles[0].clone());
        o.set("tiles", Value::array(tiles));
    }
    report.check("clipboard duplicate", get(c, "refused"), &s(clipboard::decode(&refused, 384.0 * 1024.0 * 1024.0).err().unwrap().key));
    report.check("clipboard budget", get(c, "budget"), &s(clipboard::decode(get(c, "packet"), 1000.0).err().unwrap().key));
    let paste = get(root, "paste");
    let mut target = f.tiles(get(paste, "target"));
    let mut before = Before::new();
    transform_tiles(&pasted, &matrix(get(paste, "matrix")), &mut target, Some(&mut before), Sampling::Smooth, 384.0 * 1024.0 * 1024.0 - encoded_bytes).unwrap();
    report.check("paste", &arr(vec![get(paste, "changes").clone(), get(paste, "tiles").clone()]), &arr(vec![changes_value(&tile_changes(&target, before.entries())), tile_hashes(&target)]));
    let region = region::stroke_region(&[(0.0, 0.0), (130.0, 40.0), (70.0, 200.0), (-90.0, 120.0)], 12.0, 65536).unwrap();
    report.check("stroke region", get(root, "region"), &arr(region.iter().map(|(x, y)| arr(vec![n(*x as f64), n(*y as f64)])).collect()));
    report.finish("codecs");
}
