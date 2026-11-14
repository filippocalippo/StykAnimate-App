//! Generated effects: what they draw is a pure function of the document and the tick,
//! and the behaviours people rely on (docs/engine/vfx.md, Generated effects).
//!
//! Until 2026-11 these tests compared every particle with recordings of the old
//! JavaScript editor; its look is what was replaced, so they now state the behaviour
//! directly. The recorded scene documents in `tests/fixtures/generators/` stay as
//! inputs (every style of every type); the materials are pinned by their hashes below.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use styk_eval::eval::Prepared;
use styk_eval::vfx::generated::anchors::{sample_now, Anchor, Sample, Sampler};
use styk_eval::vfx::generated::batch::row;
use styk_eval::vfx::generated::particle::{self, Evaluator, Particle};
use styk_eval::vfx::generated::stage::{Clip, Figure, Motion, Stage, HIP};
use styk_eval::vfx::generated::{self, atlas, Batch, Evaluate};
use styk_eval::vfx::Target;

fn folder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/generators")
}

/// The recorded scene documents: every style of every type, tails, placement, a movieclip.
fn fixtures() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder())
        .expect("fixture folder")
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.strip_suffix(".json").map(str::to_string))
        .collect();
    names.sort();
    names
}

fn fixture(name: &str) -> Prepared {
    styk_eval::prepare(styk_eval::open(&folder().join(format!("{name}.json"))).unwrap_or_else(|e| panic!("{name}: {e}")))
}

fn batch_with(prepared: &Prepared, tick: f64, sampler: &dyn Sampler) -> Option<Batch> {
    let frame = prepared.evaluate(tick);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    generated::build(prepared, &frame, &scene, Some(tick), Some(sampler), 1.0)
}

fn batch_at(prepared: &Prepared, tick: f64) -> Option<Batch> {
    batch_with(prepared, tick, &Evaluate)
}

/// Every live particle: (draw, instance, particle).
fn live(batch: &Batch) -> Vec<(usize, u32, Particle)> {
    let mut out = Vec::new();
    for (d, draw) in batch.draws.iter().enumerate() {
        if batch.spec(draw).is_beam() {
            continue;
        }
        let ev = Evaluator::new(batch, draw);
        for i in 0..draw.count {
            if let Some(p) = ev.particle(i) {
                out.push((d, i, p));
            }
        }
    }
    out
}

/// A sampler that keeps what it evaluated, as the engine's cache does across frames.
#[derive(Default)]
struct Kept {
    entries: RefCell<HashMap<(usize, Target, bool, i64), Option<Arc<Anchor>>>>,
}

impl Sampler for Kept {
    fn sample(&self, prepared: &Prepared, target: Target, tick: f64, attached: bool) -> Sample {
        let key = (prepared as *const Prepared as usize, target, attached, tick.round() as i64);
        let found = self.entries.borrow().get(&key).cloned();
        Sample::Ready(found.unwrap_or_else(|| {
            let value = sample_now(prepared, target, tick, attached).map(Arc::new);
            self.entries.borrow_mut().insert(key, value.clone());
            value
        }))
    }
}

/// A walking figure with an aura that leaves a trail, smoke from it, and sparks.
fn busy_stage() -> Prepared {
    let mut stage = Stage::new(60.0)
        .clip(Clip::new(Some(1), "aura"))
        .clip(Clip::new(Some(1), "smoke").set("amount", "4"))
        .clip(Clip::new(Some(1), "particles").set("look", "1").set("rate", "12").set("ground", "on").set("gravity", "0.3"));
    stage.figures[0].motion = Motion::Walk;
    stage.prepare()
}

#[test]
fn a_frame_is_the_same_drawn_alone_twice_or_after_playing() {
    let prepared = busy_stage();
    let alone = batch_at(&prepared, 36.0).expect("effects at tick 36");
    assert_eq!(Some(&alone), batch_at(&prepared, 36.0).as_ref(), "the same frame twice");
    let kept = Kept::default();
    let mut played = None;
    for tick in 0..=36 {
        played = batch_with(&prepared, tick as f64, &kept);
    }
    let played = played.unwrap();
    assert_eq!(alone, played, "drawn alone or reached by playing");
    let (a, b) = (live(&alone), live(&played));
    assert!(a.len() > 200, "{} particles", a.len());
    assert_eq!(a, b);
}

#[test]
fn every_recorded_scene_draws_alike_twice_and_only_while_its_effects_last() {
    let mut drawn = 0;
    for name in fixtures() {
        let prepared = fixture(&name);
        for tick in [0.0, 3.0, 7.0, 12.0, 19.0] {
            let a = batch_at(&prepared, tick);
            assert_eq!(a, batch_at(&prepared, tick), "{name} tick {tick}");
            if let Some(batch) = &a {
                drawn += live(batch).len();
                // Every particle is a finite place with a size.
                for (_, _, p) in live(batch) {
                    assert!(p.x.is_finite() && p.y.is_finite() && p.size > 0.0 && p.rgba[3] > 0.0, "{name} tick {tick}: {p:?}");
                }
            }
        }
    }
    assert!(drawn > 2000, "{drawn} particles drawn over the recorded scenes");
}

#[test]
fn particles_live_on_after_their_layer_stops_emitting() {
    // Smoke emitted for 10 frames lives 60: at tick 40 every puff is still there.
    let clip = Clip::new(None, "smoke").set("life", "60").set("amount", "2").set("prefill", "1").timed(0.0, Some(10.0));
    let prepared = Stage::new(80.0).clip(clip).prepare();
    let at = |tick: f64| batch_at(&prepared, tick).map_or(0, |b| live(&b).len());
    let (during, after) = (at(9.0), at(40.0));
    assert!(during > 10 && after >= during, "{during} puffs while emitting, {after} after");
}

#[test]
fn an_effect_outlives_its_target() {
    // The figure leaves the stage at tick 13 (a third of 40); its explosion started at 0.
    let mut stage = Stage::new(40.0).clip(Clip::new(Some(1), "explosion").timed(0.0, Some(20.0)));
    stage.figures[0].motion = Motion::Vanish;
    let prepared = stage.prepare();
    let gone = prepared.evaluate(16.0);
    assert!(gone.objects.is_empty(), "the figure is gone at tick 16");
    let batch = batch_at(&prepared, 16.0).expect("the explosion still draws after its figure left");
    let alive = live(&batch);
    assert!(alive.len() > 20, "{} particles", alive.len());
    // It bursts from where the figure was.
    let (mx, my) = alive.iter().fold((0.0, 0.0), |(x, y), (_, _, p)| (x + p.x / alive.len() as f64, y + p.y / alive.len() as f64));
    assert!((mx - HIP[0]).abs() < 120.0 && (my - (HIP[1] - 60.0)).abs() < 160.0, "centred near the figure: {mx}, {my}");
    assert!(batch_at(&prepared, 140.0).is_none_or(|b| live(&b).is_empty()), "and ends");

    // An aura's particles left behind keep living when the figure goes, but none are born after.
    let mut stage = Stage::new(40.0).clip(Clip::new(Some(1), "aura").set("prefill", "2"));
    stage.figures[0].motion = Motion::Vanish;
    let prepared = stage.prepare();
    let before = live(&batch_at(&prepared, 12.0).unwrap()).len();
    let after = batch_at(&prepared, 15.0).map_or(0, |b| live(&b).len());
    assert!(before > 50 && after > 0 && after < before, "{before} particles with the figure, {after} just after it left");
    let batch = batch_at(&prepared, 15.0).unwrap();
    for (d, i, _) in live(&batch) {
        let ev = Evaluator::new(&batch, &batch.draws[d]);
        let born = ev.birth(i).unwrap().born;
        assert!(born < 13.5, "born at {born}, after the figure left");
    }
    assert!(batch_at(&prepared, 120.0).is_none_or(|b| live(&b).is_empty()));
}

#[test]
fn a_keyed_parameter_changes_new_particles_not_those_in_flight() {
    let sparks = |keyed: bool| {
        let mut clip = Clip::new(None, "particles").set("rate", "4").set("life", "60").set("variation", "0").set("speed", "2").set("x", "0.5").set("y", "0.3");
        clip = if keyed { clip.key("gravity", 0.0, "0").key("gravity", 19.0, "0").key("gravity", 20.0, "2").key("color", 0.0, "0x66ccff").key("color", 19.0, "0x66ccff").key("color", 20.0, "0xff3300") } else { clip.set("gravity", "0") };
        Stage::new(60.0).clip(clip).prepare()
    };
    let (plain, keyed) = (sparks(false), sparks(true));
    let (a, b) = (batch_at(&plain, 30.0).unwrap(), batch_at(&keyed, 30.0).unwrap());
    let born = |batch: &Batch, d: usize, i: u32| Evaluator::new(batch, &batch.draws[d]).birth(i).unwrap().born;
    let (pa, pb) = (live(&a), live(&b));
    assert_eq!(pa.len(), pb.len());
    let (mut same, mut moved) = (0, 0);
    for ((d, i, p), (_, _, q)) in pa.iter().zip(&pb) {
        let t = born(&a, *d, *i);
        if t < 18.5 {
            assert!((p.x - q.x).abs() < 1e-9 && (p.y - q.y).abs() < 1e-9, "born at {t}: moved by a key set after it");
            assert_eq!(b.specs[q.spec as usize].colors, a.specs[0].colors, "born at {t}: keeps the colour it was born with");
            same += 1;
        } else if t > 20.5 && t < 28.0 {
            assert!(q.y > p.y + 1.0, "born at {t}: falls with the new gravity");
            assert_ne!(b.specs[q.spec as usize].colors, a.specs[0].colors, "and has the new colour");
            moved += 1;
        }
    }
    assert!(same > 20 && moved > 10, "{same} old, {moved} new");
}

#[test]
fn a_moving_scene_emitter_leaves_a_trail() {
    let clip = Clip::new(None, "particles").set("rate", "2").set("life", "60").set("speed", "0").set("variation", "0").set("y", "0.5").key("x", 0.0, "0.2").key("x", 30.0, "0.8");
    let prepared = Stage::new(40.0).clip(clip).prepare();
    let batch = batch_at(&prepared, 30.0).unwrap();
    let xs: Vec<f64> = live(&batch).iter().map(|(_, _, p)| p.x).collect();
    let (lo, hi) = xs.iter().fold((f64::MAX, f64::MIN), |(a, b), &x| (a.min(x), b.max(x)));
    assert!(lo < 0.3 * 640.0 && hi > 0.75 * 640.0, "the first particles stay where they were born: {lo}..{hi}");
}

#[test]
fn an_aura_follows_the_body_not_its_pose() {
    let mut stage = Stage::new(40.0).clip(Clip::new(Some(1), "aura"));
    stage.figures[0].motion = Motion::Arms;
    let prepared = stage.prepare();
    let target = Target::Figure { uid: 1 };
    let (down, up) = (sample_now(&prepared, target, 0.0, true).unwrap(), sample_now(&prepared, target, 10.0, true).unwrap());
    assert!(up.height > down.height + 10.0, "raised arms are taller: {} and {}", down.height, up.height);
    assert!((down.measure - up.measure).abs() < 1e-6, "the size it is measured by does not change: {} and {}", down.measure, up.measure);
    // Torso and arm (62 + 34 + 32) and a leg (44 + 44).
    assert!((down.measure - 216.0).abs() < 1.0, "the two longest limbs, end to end: {}", down.measure);
    // Every birth of the aura is at the same scale.
    let batch = batch_at(&prepared, 24.0).unwrap();
    for draw in &batch.draws {
        let scales: Vec<f32> = (0..draw.ticks as usize).map(|k| batch.row(draw, k)[row::SCALE]).collect();
        assert!(scales.windows(2).all(|w| w[0] == w[1]), "{scales:?}");
    }
}

#[test]
fn body_emission_is_even_along_the_figure() {
    let clip = Clip::new(Some(1), "particles").set("shape", "2").set("rate", "60").set("life", "3").set("speed", "0").set("variation", "0").set("spread", "0");
    let prepared = Stage::new(20.0).clip(clip).prepare();
    let (mut head, mut all) = (0usize, 0usize);
    // The head is the circle above the torso: hip 300, torso 62, head 36 across.
    let centre = [HIP[0], HIP[1] - 62.0 - 18.0];
    for tick in [6.0, 9.0, 12.0, 15.0] {
        for (_, _, p) in live(&batch_at(&prepared, tick).unwrap()) {
            all += 1;
            if ((p.x - centre[0]).powi(2) + (p.y - centre[1]).powi(2)).sqrt() < 21.0 {
                head += 1;
            }
        }
    }
    // The head is 8 chords of 13.8 (110) of an outline of 480: about 23 %; by piece it was 47 %.
    let share = head as f64 / all as f64;
    assert!(all > 400 && (0.15..0.32).contains(&share), "{head} of {all} from the head");
}

#[test]
fn continuous_effects_can_start_already_running() {
    let smoke = |prefill: &str| Stage::new(60.0).clip(Clip::new(Some(1), "smoke").set("prefill", prefill)).prepare();
    let oldest = |prepared: &Prepared| {
        let batch = batch_at(prepared, 0.0);
        batch.map_or(0.0, |b| live(&b).iter().map(|(d, i, _)| -Evaluator::new(&b, &b.draws[*d]).birth(*i).unwrap().born).fold(0.0, f64::max))
    };
    // Auto: a clip with no end starts running; Off starts empty.
    assert!(oldest(&smoke("0")) > 30.0, "the first frame shows smoke that has risen for a while");
    assert!(oldest(&smoke("2")) > 30.0);
    assert!(oldest(&smoke("1")) < 1.0);
    // Auto does not pre-fill a clip that starts later.
    let later = Stage::new(60.0).clip(Clip::new(Some(1), "smoke").timed(10.0, Some(40.0))).prepare();
    let batch = batch_at(&later, 10.0).unwrap();
    assert!(live(&batch).len() < 4);
}

/// Retired options (no longer offered) still open and draw as the option each merged into:
/// Explosion Plasma as Magic and Smoke bomb as Dust, Beam Spiral as Energy with its strands,
/// Particles Leaf as Petal; Smoke Thick and Steam as Soft, keeping their own thickness.
#[test]
fn retired_styles_draw_as_the_style_they_merged_into() {
    let drawn = |clip: Clip, tick: f64| {
        let batch = batch_at(&Stage::new(60.0).clip(clip).prepare(), tick).expect("the effect draws");
        live(&batch).iter().map(|(d, i, p)| (*d, *i, (p.x * 1000.0) as i64, (p.y * 1000.0) as i64, (p.size * 1000.0) as i64)).collect::<Vec<_>>()
    };
    let style = |kind: &str, name: &str, value: &str| Clip::new(Some(1), kind).set(name, value);
    for (retired, into) in [("2", "7"), ("3", "8")] {
        assert_eq!(drawn(style("explosion", "style", retired), 12.0), drawn(style("explosion", "style", into), 12.0), "explosion style {retired}");
    }
    assert_eq!(drawn(style("beam", "style", "3"), 30.0), drawn(style("beam", "style", "0").set("strands", "on"), 30.0));
    assert_eq!(drawn(style("particles", "look", "11"), 30.0), drawn(style("particles", "look", "12"), 30.0));
    let soft = drawn(style("smoke", "style", "0"), 40.0);
    for retired in ["1", "2"] {
        let smoke = drawn(style("smoke", "style", retired), 40.0);
        assert!(!smoke.is_empty() && smoke.iter().all(|p| p.0 == 0), "smoke style {retired} draws one soft layer");
        assert_ne!(smoke, soft, "smoke style {retired} keeps its own thickness");
    }
}

#[test]
fn copies_of_an_effect_play_their_own_patterns() {
    let pair = |unique: &str| {
        let mut stage = Stage::new(30.0);
        stage.figures = vec![Figure { uid: 1, hip: [180.0, 300.0], motion: Motion::Still }, Figure { uid: 2, hip: [460.0, 300.0], motion: Motion::Still }];
        let clip = |uid| Clip::new(Some(uid), "particles").set("rate", "6").set("unique", unique);
        stage.clip(clip(1)).clip(clip(2)).prepare()
    };
    let relative = |prepared: &Prepared| {
        let batch = batch_at(prepared, 20.0).unwrap();
        let mut sets: Vec<Vec<(i64, i64)>> = vec![Vec::new(); batch.draws.len()];
        for (d, _, p) in live(&batch) {
            sets[d].push((((p.x - batch.draws[d].point[0]) * 100.0) as i64, ((p.y - batch.draws[d].point[1]) * 100.0) as i64));
        }
        sets
    };
    let same = relative(&pair("0"));
    assert_eq!(same[0], same[1], "with \"Vary each copy\" off, two copies are the same");
    let own = relative(&pair("1"));
    assert_ne!(own[0], own[1], "by default each plays its own pattern");
}

#[test]
fn limits_thin_evenly_and_say_so() {
    // A scene emitter asking for far more than a frame draws: 200 a frame for up to 300 frames, with a glow and a trail.
    let clip = Clip::new(None, "particles").set("rate", "200").set("life", "300").set("variation", "1").set("glow", "1").set("trail", "6").set("speed", "1").set("spread", "360");
    let prepared = Stage::new(400.0).clip(clip).prepare();
    let tick = 350.0;
    let frame = prepared.evaluate(tick);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    let full = generated::build(&prepared, &frame, &scene, Some(tick), Some(&Evaluate), 1.0).unwrap();
    assert!(full.reduced, "the frame says it was reduced");
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let drawn = |batch: &Batch| {
        let list = styk_eval::drawlist::encode_with(&prepared.doc, &assets, &scene, &styk_eval::drawlist::Overrides { generators: Some(batch), ..Default::default() });
        (list.prims.iter().filter(|p| p.kind & 255 == styk_draw::K_PARTICLE).count(), styk_draw::effects_reduced(&list))
    };
    let (n, reduced) = drawn(&full);
    assert!(n as f64 <= generated::MAX_DRAWN * 1.05 && reduced, "{n} records drawn");
    // An edit frame on the interface thread: far fewer, the same particles among them.
    let light = generated::build_within(&prepared, &frame, &scene, Some(tick), Some(&Evaluate), generated::EDIT_DRAWN).unwrap();
    let (m, _) = drawn(&light);
    assert!(m as f64 <= generated::EDIT_DRAWN * 1.1 && m as f64 > generated::EDIT_DRAWN * 0.6, "{m} records in an edit frame");
    let all: std::collections::HashSet<(i64, i64)> = live(&full).iter().map(|(_, _, p)| ((p.x * 64.0) as i64, (p.y * 64.0) as i64)).collect();
    let kept = live(&light);
    assert!(kept.iter().all(|(_, _, p)| all.contains(&((p.x * 64.0) as i64, (p.y * 64.0) as i64))), "thinning keeps particles where they are");
    // Evenly: old and young particles are kept alike.
    let ages: Vec<f64> = kept.iter().map(|(d, i, _)| tick - Evaluator::new(&light, &light.draws[*d]).birth(*i).unwrap().born).collect();
    let old = ages.iter().filter(|&&a| a > 100.0).count() as f64 / ages.len() as f64;
    assert!(old > 0.3, "old particles are thinned like young ones ({:.0} % older than 100 frames)", old * 100.0);
}

#[test]
fn huge_soft_particles_are_limited_by_the_area_they_cover() {
    let clip = Clip::new(Some(1), "smoke").set("size", "400").set("growth", "8").set("amount", "20").set("life", "200").set("prefill", "2");
    let prepared = Stage::new(100.0).clip(clip).prepare();
    let tick = 60.0;
    let frame = prepared.evaluate(tick);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    let batch = generated::build(&prepared, &frame, &scene, Some(tick), Some(&Evaluate), 1.0).unwrap();
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let list = styk_eval::drawlist::encode_with(&prepared.doc, &assets, &scene, &styk_eval::drawlist::Overrides { generators: Some(&batch), ..Default::default() });
    let drawn = list.prims.iter().filter(|p| p.kind & 255 == styk_draw::K_PARTICLE).count();
    assert!(styk_draw::effects_reduced(&list), "the list says the picture was reduced");
    assert!(drawn < live(&batch).len(), "{drawn} of {} drawn", live(&batch).len());
}

#[test]
fn trails_keep_the_drawing_step() {
    // A trail's copies land on held frames of the drawing, never on the particle's own frame.
    for step in [1.0, 2.0, 3.0] {
        let clip = Clip::new(None, "particles").set("rate", "6").set("trail", "3").set("step", &(step - 1.0).to_string());
        let prepared = Stage::new(40.0).clip(clip).prepare();
        let batch = batch_at(&prepared, 25.0).unwrap();
        let draw = &batch.draws[0];
        let now = Evaluator::new(&batch, draw).tick();
        let lag = particle::trail_lag(2.0, draw.step);
        let mut ticks = vec![now];
        for k in 1..=3 {
            ticks.push(Evaluator::at(&batch, draw, draw.tick - k as f64 * lag).tick());
        }
        let mut distinct = ticks.clone();
        distinct.dedup();
        assert_eq!(distinct.len(), ticks.len(), "on {step}s: {ticks:?}");
    }
}

#[test]
fn debris_lands_bounces_and_stops_on_the_ground() {
    let clip = Clip::new(None, "particles").set("emission", "1").set("count", "40").set("speed", "8").set("gravity", "0.6").set("ground", "on").set("bounce", "0.5").set("life", "200").set("y", "0.5");
    let prepared = Stage::new(220.0).clip(clip).prepare();
    let ground = prepared.doc.canvas[1] as f64 - 1.5;
    let at = |tick: f64| {
        let batch = batch_at(&prepared, tick).unwrap();
        live(&batch).into_iter().map(|(_, i, p)| (i, p)).collect::<HashMap<u32, Particle>>()
    };
    let (mid, late, later) = (at(40.0), at(150.0), at(180.0));
    for p in mid.values().chain(late.values()) {
        assert!(p.y <= ground + 1e-6, "below the ground: {}", p.y);
    }
    let mut still = 0;
    for (i, p) in &late {
        if let Some(q) = later.get(i) {
            assert!((q.y - ground).abs() < 1e-6, "landed");
            if (q.x - p.x).abs() < 0.5 {
                still += 1;
            }
        }
    }
    assert!(still > late.len() / 2, "slides to a stop: {still} of {}", late.len());
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

/// The noise materials: within every device's texture limit, their cells clear at the sides (so filtering never
/// reads a neighbour), the same bytes on every platform (the hashes are this machine's; CI checks them on Linux and
/// Windows: a material whose look is changed on purpose gets its new hash here).
#[test]
fn materials_fit_every_device_and_are_the_same_everywhere() {
    assert!(atlas::CELL * atlas::COLUMNS <= 2048 && atlas::CELL * atlas::ROWS <= 2048);
    let mut hashes = Vec::new();
    for row in 0..atlas::ROWS {
        let material = atlas::generate(row);
        assert_eq!(material.levels.len(), atlas::LEVELS);
        let base = &material.levels[0];
        assert_eq!((base.width, base.height), (atlas::CELL * atlas::COLUMNS, atlas::CELL));
        for level in &material.levels {
            let cell = level.height;
            // The outer ring of every cell holds no density.
            for c in 0..atlas::COLUMNS {
                for k in 0..cell {
                    for (x, y) in [(c * cell + k, 0), (c * cell + k, cell - 1), (c * cell, k), (c * cell + cell - 1, k)] {
                        assert_eq!(level.data[(y * level.width + x) * 2], 0, "{} level {cell}: density at ({x}, {y})", atlas::NAMES[row]);
                    }
                }
            }
        }
        // Something of the material is dense.
        assert!(base.data.chunks_exact(2).any(|t| t[0] > 200), "{} has a dense middle", atlas::NAMES[row]);
        hashes.push(fnv(&base.data));
    }
    assert_eq!(hashes, EXPECTED_MATERIALS, "material bytes");
}

const EXPECTED_MATERIALS: [u32; 4] = [1169140756, 2569879017, 2432394701, 1555941733];

/// Every live particle's centre and every beam's ends, placed by their draw's transform,
/// lie inside the batch's bounds; a batch with nothing alive has none.
#[test]
fn batch_bounds_hold_every_live_particle() {
    let (mut checked, mut empty) = (0, 0);
    for name in fixtures() {
        let prepared = fixture(&name);
        for tick in [1.0, 4.0, 9.0, 14.0, 18.0] {
            let Some(batch) = batch_at(&prepared, tick) else { continue };
            let bounds = batch.bounds();
            let mut alive = false;
            for draw in &batch.draws {
                let [a, b, c, d, e, f] = batch.matrix(draw);
                let s = batch.spec(draw);
                let points: Vec<[f64; 2]> = if s.is_beam() {
                    vec![draw.point, particle::beam_tip(draw, s, Evaluator::new(&batch, draw).local())]
                } else {
                    let ev = Evaluator::new(&batch, draw);
                    (0..draw.count).filter_map(|i| ev.particle(i)).map(|p| [p.x, p.y]).collect()
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

/// The records a batch draws (particles, their trails and halos, arc pieces) and whether the list says it was reduced.
fn drawn_records(prepared: &Prepared, tick: f64, batch: &Batch) -> (usize, bool) {
    let frame = prepared.evaluate(tick);
    let scene = styk_eval::geometry::build(&prepared.doc, &frame);
    let assets = styk_eval::assets::Assets::build(&prepared.doc);
    let list = styk_eval::drawlist::encode_with(&prepared.doc, &assets, &scene, &styk_eval::drawlist::Overrides { generators: Some(batch), ..Default::default() });
    (list.prims.iter().filter(|p| p.kind & 255 == styk_draw::K_PARTICLE).count(), styk_draw::effects_reduced(&list))
}

/// Every style of a type, retired ones included, compiles and draws, within the limits, at its defaults and at the
/// least and the most of its main controls. `settings`: (name, least, most); something must be drawn at the first of
/// `ticks`, and nothing beyond the limits at any.
fn every_style_draws_within_limits(kind: &str, styles: usize, settings: &[(&str, &str, &str)], ticks: &[f64]) {
    for style in 0..styles {
        for (label, which) in [("defaults", None), ("least", Some(false)), ("most", Some(true))] {
            let mut clip = Clip::new(Some(1), kind).set("style", &style.to_string()).timed(0.0, Some(40.0));
            if let Some(most) = which {
                for (name, least, max) in settings {
                    clip = clip.set(name, if most { max } else { least });
                }
            }
            let prepared = Stage::new(80.0).clip(clip).prepare();
            for &tick in ticks {
                let Some(batch) = batch_at(&prepared, tick) else {
                    assert!(tick > ticks[0], "{kind} style {style} ({label}) draws at tick {tick}");
                    continue;
                };
                let alive = live(&batch);
                let arcs: usize = batch.draws.iter().filter(|d| batch.spec(d).shape == styk_eval::vfx::generated::layers::ARC).map(|d| particle::arcs(&batch, d).len()).sum();
                assert!(tick > ticks[0] || !alive.is_empty() || arcs > 0, "{kind} style {style} ({label}): nothing alive at tick {tick}");
                for (_, _, p) in &alive {
                    assert!(p.x.is_finite() && p.y.is_finite() && p.size >= 0.0 && p.rgba[3] > 0.0, "{kind} style {style} ({label}) tick {tick}: {p:?}");
                }
                let (records, _) = drawn_records(&prepared, tick, &batch);
                assert!(records as f64 <= generated::MAX_DRAWN * 1.05, "{kind} style {style} ({label}) tick {tick}: {records} records");
                if which.is_none() {
                    // At its defaults an effect is far inside the limits: a few thousand records at most.
                    assert!(records < 4_000 && !batch.reduced, "{kind} style {style} at its defaults: {records} records at tick {tick}");
                }
            }
        }
    }
}

#[test]
fn every_smoke_style_draws_within_limits() {
    // The amount and the opacity stay at their defaults at the least: none of either draws nothing, as it should.
    let settings = [("size", "2", "400"), ("life", "4", "400"), ("growth", "0.2", "8"), ("rise", "-6", "12"), ("turbulence", "0", "4"), ("spread", "0", "2000")];
    every_style_draws_within_limits("smoke", 5, &settings, &[3.0, 30.0]);
}
