//! Generated effects against the JavaScript editor.
//!
//! Every fixture in `tests/fixtures/generators/` is a small project the editor
//! built and, per tick, what it computed for its generated effects
//! (frozen recordings): the batch
//! (layer records, birth table, draws) and every live particle, beam and arc.
//! The engine must pack the same batch, bit for bit in single precision, and
//! evaluate the same particles: the same instances alive, every value equal,
//! bit for bit (sizes go through `Math.pow`, V8's own in both: D16). `atlas.json`
//! holds a hash of every material row and level, which the engine must generate
//! byte for byte.

use std::path::{Path, PathBuf};

use styk_doc::Value;
use styk_eval::eval::Prepared;
use styk_eval::vfx::generated::{self, atlas, particle, Batch, Evaluate, Sampler};

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/generators")
}

fn json(path: &Path) -> Value {
    styk_doc::json::parse(&std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn fixtures() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder())
        .expect("fixture folder")
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.strip_suffix(".batches.json").map(str::to_string))
        .collect();
    names.sort();
    names
}

fn prepared(name: &str) -> Prepared {
    let document = styk_eval::open(&folder().join(format!("{name}.json"))).unwrap_or_else(|e| panic!("{name}: {e}"));
    styk_eval::prepare(document)
}

fn batch_at(prepared: &Prepared, tick: f64, sampler: Option<&dyn Sampler>) -> Option<Batch> {
    let frame = prepared.evaluate(tick);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    generated::build(prepared, &frame, &scene, Some(tick), sampler, 1.0)
}

fn nums(value: &Value, key: &str) -> Vec<f64> {
    value.get(key).and_then(Value::numbers).unwrap_or_else(|| panic!("{key} is not a list of numbers"))
}

fn rows(value: &Value, key: &str) -> Vec<Vec<f64>> {
    value.get(key).and_then(Value::elements).map(|e| e.into_iter().map(|row| row.numbers().unwrap_or_default()).collect()).unwrap_or_default()
}

/// Differences between the engine's batch and the editor's, as readable lines.
fn compare(expected: &Value, batch: &Batch) -> Vec<String> {
    let mut problems = Vec::new();
    let tick = expected.get("tick").and_then(Value::as_f64).unwrap();
    if tick != batch.tick {
        problems.push(format!("batch tick {} (editor {tick})", batch.tick));
    }
    let draws: Vec<Value> = expected.get("draws").and_then(Value::elements).map(|e| e.into_iter().collect()).unwrap_or_default();
    if draws.len() != batch.draws.len() {
        problems.push(format!("{} draws (editor {})", batch.draws.len(), draws.len()));
        return problems;
    }
    for (i, (d, ours)) in draws.iter().zip(&batch.draws).enumerate() {
        let n = |k: usize| d.item(k).and_then(|v| v.as_f64());
        let uid = d.item(4).and_then(|v| v.as_f64()).map(|v| v as u32);
        let theirs = (n(0).unwrap() as u32, n(1).unwrap() as u32, n(2).unwrap() as u8, n(3).unwrap() as u8, uid, n(5).unwrap() != 0.0, n(6).unwrap() != 0.0, n(7).unwrap() as i32);
        let mine = (ours.record, ours.count, ours.shape, ours.blend, ours.uid, ours.placement == generated::layers::Placement::Behind, ours.scene, ours.material);
        if theirs != mine {
            problems.push(format!("draw {i}: {mine:?} (editor {theirs:?})"));
        }
    }
    let records = nums(expected, "records");
    if records.len() != batch.records.len() {
        problems.push(format!("{} record numbers (editor {})", batch.records.len(), records.len()));
    } else {
        for (i, (&theirs, &ours)) in records.iter().zip(&batch.records).enumerate() {
            if (theirs as f32).to_bits() != ours.to_bits() && problems.len() < 40 {
                problems.push(format!("record {} [{}]: {ours} (editor {theirs})", i / 128, i % 128));
            }
        }
    }
    let table = nums(expected, "table");
    if table.len() != batch.table.len() {
        problems.push(format!("{} table numbers (editor {})", batch.table.len(), table.len()));
    } else {
        for (i, (&theirs, &ours)) in table.iter().zip(&batch.table).enumerate() {
            if (theirs as f32).to_bits() != ours.to_bits() && problems.len() < 40 {
                problems.push(format!("table [{i}]: {ours} (editor {theirs})"));
            }
        }
    }
    let particles = expected.get("particles").and_then(Value::as_f64).unwrap() as u32;
    if particles != batch.particles {
        problems.push(format!("{} instances (editor {particles})", batch.particles));
    }
    problems
}

/// Live particles, beams, arcs and ramp colours of the engine's batch against the editor's.
fn compare_particles(frame: &Value, batch: &Batch) -> (usize, Vec<String>) {
    let mut problems = Vec::new();
    let expected = rows(frame, "particles");
    let mut ours = Vec::new();
    for (d, draw) in batch.draws.iter().enumerate() {
        if draw.shape == generated::layers::BEAM || draw.shape == generated::layers::ARC {
            continue;
        }
        for i in 0..draw.count {
            if let Some(p) = particle::evaluate(batch, draw, i) {
                ours.push((d, i, p));
            }
        }
    }
    if ours.len() != expected.len() {
        problems.push(format!("{} live particles (editor {})", ours.len(), expected.len()));
    }
    for (row, (d, i, p)) in expected.iter().zip(&ours) {
        if row[0] as usize != *d || row[1] as u32 != *i {
            problems.push(format!("particle of draw {d} instance {i} (editor: draw {} instance {})", row[0], row[1]));
            break;
        }
        let exact = [(row[2], p.x, "x"), (row[3], p.y, "y"), (row[4], p.vx, "vx"), (row[5], p.vy, "vy"), (row[6], p.size, "size"), (row[7], p.alpha, "alpha"), (row[8], p.color, "colour"), (row[9], p.rotation, "rotation"), (row[10], p.variant as f64, "variant"), (row[11], p.n, "n")];
        for (theirs, mine, what) in exact {
            if theirs.to_bits() != mine.to_bits() && problems.len() < 40 {
                problems.push(format!("draw {d} particle {i}: {what} {mine} (editor {theirs})"));
            }
        }
    }
    for row in rows(frame, "beams") {
        let draw = &batch.draws[row[0] as usize];
        let r = batch.record(draw);
        let te = particle::stepped_time(r);
        let tip = particle::beam_tip(r, te);
        let width = particle::beam_width(r, te);
        if te != row[1] || tip[0] != row[2] || tip[1] != row[3] || width != row[4] {
            problems.push(format!("beam of draw {}: {te} {tip:?} {width} (editor {:?})", row[0], &row[1..]));
        }
    }
    for row in rows(frame, "arcs") {
        let draw = &batch.draws[row[0] as usize];
        let r = batch.record(draw);
        let te = particle::stepped_time(r);
        let segs = (r[62] as u32).max(1);
        let (arc, k) = (row[1] as u32 / segs, row[1] as u32 % segs);
        let key = particle::pcg((r[7] as u32).wrapping_add(arc.wrapping_mul(7919)).wrapping_add(((te / 2.0).floor() as u32).wrapping_mul(104729)));
        let hashes = (particle::hash(arc as f64, 99, key), particle::hash(k as f64, 3, key));
        if hashes != (row[2], row[3]) {
            problems.push(format!("arc {} of draw {}: {hashes:?} (editor {:?})", row[1], row[0], &row[2..]));
        }
    }
    for row in rows(frame, "ramps") {
        let ramp = particle::ramp(batch.record(&batch.draws[row[0] as usize]), row[1]);
        if ramp.iter().zip(&row[2..]).any(|(a, b)| a.to_bits() != b.to_bits()) {
            problems.push(format!("ramp of draw {} at {}: {ramp:?} (editor {:?})", row[0], row[1], &row[2..]));
        }
    }
    (ours.len(), problems)
}

#[test]
fn every_fixture_packs_and_evaluates_like_the_editor() {
    let names = fixtures();
    assert!(names.len() >= 7, "fixtures are missing: the generator fixtures are frozen recordings (restore them from version control)");
    let (mut batches, mut live) = (0, 0);
    let mut failures = Vec::new();
    for name in &names {
        let prepared = prepared(name);
        let reference = json(&folder().join(format!("{name}.batches.json")));
        for frame in reference.get("frames").and_then(Value::elements).expect("frames").into_iter() {
            let tick = frame.get("tick").and_then(Value::as_f64).unwrap();
            let batch = batch_at(&prepared, tick, Some(&Evaluate));
            match (frame.get("batch").filter(|b| !b.is_null()), &batch) {
                (None, None) => continue,
                (None, Some(_)) => failures.push(format!("{name} tick {tick}: a batch where the editor has none")),
                (Some(_), None) => failures.push(format!("{name} tick {tick}: no batch")),
                (Some(expected), Some(batch)) => {
                    batches += 1;
                    let mut problems = compare(expected, batch);
                    if problems.is_empty() {
                        let (count, more) = compare_particles(&frame, batch);
                        live += count;
                        problems = more;
                    }
                    if !problems.is_empty() {
                        failures.push(format!("{name} tick {tick}:\n  {}", problems.join("\n  ")));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(batches >= 25 && live >= 5000, "only {batches} batches and {live} particles compared");
}

/// Without the document's generator clips the engine draws nothing where the
/// editor drew; without earlier-tick anchors, trails differ: each fixture
/// exercises what it is about.
#[test]
fn fixtures_fail_without_their_features() {
    for name in fixtures() {
        let prepared = prepared(&name);
        let reference = json(&folder().join(format!("{name}.batches.json")));
        let frames: Vec<Value> = reference.get("frames").and_then(Value::elements).unwrap().into_iter().collect();
        // A copy of the document without effect clips (movieclips keep theirs).
        let mut bare = (*prepared.doc).clone();
        bare.vfx_clips = None;
        let bare = Prepared::new(std::sync::Arc::new(bare));
        let nested = name == "movieclip";
        let mut drew = false;
        for frame in &frames {
            let tick = frame.get("tick").and_then(Value::as_f64).unwrap();
            if frame.get("batch").is_some_and(|b| !b.is_null()) {
                drew |= batch_at(&bare, tick, Some(&Evaluate)).is_none_or(|b| !compare(frame.get("batch").unwrap(), &b).is_empty());
            }
        }
        assert!(drew || nested, "{name}: still matches without its effect clips");
        if ["auras", "smoke", "particles"].contains(&name.as_str()) {
            let differs = frames.iter().any(|frame| {
                let tick = frame.get("tick").and_then(Value::as_f64).unwrap();
                let Some(expected) = frame.get("batch").filter(|b| !b.is_null()) else { return false };
                batch_at(&prepared, tick, None).is_none_or(|b| !compare(expected, &b).is_empty())
            });
            assert!(differs, "{name}: matches without earlier-tick anchors");
        }
    }
}

/// FNV-1a over bytes.
fn fnv(bytes: &[u8]) -> u32 {
    let mut h: u32 = 2166136261;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

#[test]
fn materials_are_the_editors_bytes() {
    let reference = json(&folder().join("atlas.json"));
    let rows: Vec<Value> = reference.get("rows").and_then(Value::elements).unwrap().into_iter().collect();
    assert_eq!(rows.len(), atlas::ROWS);
    let mut wrong = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let ours = atlas::generate(index);
        for (level, expected) in row.elements().unwrap().into_iter().enumerate() {
            let e = expected.numbers().unwrap();
            let l = &ours.levels[level];
            if (l.width as f64, l.height as f64, fnv(&l.data) as f64) != (e[0], e[1], e[2]) {
                wrong.push(format!("row {index} ({}) level {level}", generated::layers::ROWS[index]));
            }
        }
    }
    assert!(wrong.is_empty(), "differ from the editor: {wrong:?}");
}

/// `generatorBatchBounds`: every live particle's centre and every beam's ends, placed by
/// their draw's transform, lie inside the batch's bounds (each grown by its reach); a batch
/// with nothing alive has none.
#[test]
fn batch_bounds_hold_every_live_particle() {
    let (mut checked, mut empty) = (0, 0);
    for name in fixtures() {
        let prepared = prepared(&name);
        let reference = json(&folder().join(format!("{name}.batches.json")));
        for frame in reference.get("frames").and_then(Value::elements).expect("frames").into_iter() {
            let tick = frame.get("tick").and_then(Value::as_f64).unwrap();
            let Some(batch) = batch_at(&prepared, tick, Some(&Evaluate)) else { continue };
            let bounds = batch.bounds();
            let mut alive = false;
            for draw in &batch.draws {
                let [a, b, c, d, e, f] = batch.matrix(draw);
                let points: Vec<[f64; 2]> = if draw.shape == generated::layers::BEAM || draw.shape == generated::layers::ARC {
                    let r = batch.record(draw);
                    vec![[r[36] as f64, r[37] as f64], particle::beam_tip(r, particle::stepped_time(r))]
                } else {
                    (0..draw.count).filter_map(|i| particle::evaluate(&batch, draw, i)).map(|p| [p.x, p.y]).collect()
                };
                for [x, y] in points {
                    alive = true;
                    let (px, py) = (a * x + c * y + e, b * x + d * y + f);
                    let [x0, y0, w, h] = bounds.unwrap_or_else(|| panic!("{name} tick {tick}: live particles but no bounds"));
                    assert!(px >= x0 - 1e-6 && py >= y0 - 1e-6 && px <= x0 + w + 1e-6 && py <= y0 + h + 1e-6, "{name} tick {tick}: ({px}, {py}) outside {bounds:?}");
                    checked += 1;
                }
            }
            if !alive {
                assert!(bounds.is_none(), "{name} tick {tick}: bounds without anything alive");
                empty += 1;
            }
        }
    }
    assert!(checked > 1000, "only {checked} particles checked ({empty} empty batches)");
}
