//! What the aura and energy-beam styles draw (docs/engine/vfx.md, Generated effects): the
//! anatomy each style is built from, stated on the review stage (a stick figure 180 pixels
//! tall, its hip at `HIP`, its head's top at y 202).

use styk_eval::vfx::generated::layers::{material, Placement, ARC, BEAM, BEAM_LINE, BEAM_TIP, DISC, POINT};
use styk_eval::vfx::generated::particle::{self, Evaluator};
use styk_eval::vfx::generated::stage::{Clip, Stage, HIP};

use super::generators::{batch_at, live};

/// The head's top on the review stage: hip 300, torso 62, head 36 across.
const HEAD_TOP: f64 = HIP[1] - 62.0 - 36.0;

fn luma(c: [f64; 3]) -> f64 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// A beam that charges plays its charge from nothing even when its clip starts with the
/// animation, and what happens once it fires (sparks along it, its impact) waits for that; a
/// beam set to start firing is already firing, sparks flying, on its first frame.
#[test]
fn a_beam_charges_from_nothing_and_its_impact_waits_for_it() {
    let charging = Stage::new(60.0).clip(Clip::new(Some(1), "beam").timed(0.0, Some(40.0))).prepare();
    for tick in [1.0, 6.0, 11.0] {
        let batch = batch_at(&charging, tick).expect("the beam charges");
        for (d, i, p) in live(&batch) {
            let s = &batch.specs[p.spec as usize];
            assert!(s.emit_shape != BEAM_LINE && s.emit_shape != BEAM_TIP, "tick {tick}: a particle of the beam before it fires");
            let born = Evaluator::new(&batch, &batch.draws[d]).birth(i).unwrap().born;
            assert!(born >= 0.0, "tick {tick}: a particle born at {born}, before the beam began");
        }
    }
    let firing = Stage::new(60.0).clip(Clip::new(Some(1), "beam").set("prefill", "2").timed(0.0, Some(40.0))).prepare();
    let batch = batch_at(&firing, 1.0).expect("the beam fires");
    assert!(live(&batch).iter().any(|(_, _, p)| batch.specs[p.spec as usize].emit_shape == BEAM_LINE), "sparks fly along a beam that starts firing");
}

/// The fire aura is a flame the figure stands in: wider than the body, rising to a point well
/// above the head, its tongues leaning in to it, nearly all of it behind the figure.
#[test]
fn a_fire_aura_is_a_flame_the_figure_stands_in() {
    let prepared = Stage::new(60.0).clip(Clip::new(Some(1), "aura")).prepare();
    let flame = Some(material("flame"));
    let (mut behind, mut front, mut lean_in, mut lean_out) = (0, 0, 0, 0);
    let (mut left, mut right, mut top) = (f64::MAX, f64::MIN, f64::MAX);
    for tick in [20.0, 30.0, 40.0] {
        let batch = batch_at(&prepared, tick).expect("the aura burns");
        for (d, _, p) in live(&batch) {
            if batch.specs[p.spec as usize].material != flame {
                continue;
            }
            match batch.draws[d].placement {
                Placement::Behind => behind += 1,
                Placement::Front => front += 1,
            }
            left = left.min(p.x);
            right = right.max(p.x);
            top = top.min(p.y);
            let dx = p.x - HIP[0];
            if dx.abs() > 20.0 {
                if dx * p.vx < 0.0 { lean_in += 1 } else { lean_out += 1 }
            }
        }
    }
    assert!(behind > 200 && front * 12 < behind, "{front} flames in front of the figure, {behind} behind");
    assert!(lean_in > 3 * lean_out, "{lean_in} tongues lean in to the point above the head, {lean_out} out");
    // The body is about 60 pixels across (arms and legs about 30 each side of the hip); the tongues'
    // centres alone spread wider, and each tongue reaches past its centre.
    assert!(right - left > 90.0, "the tongues' centres span {left}..{right}");
    assert!(top < HEAD_TOP - 45.0, "the flame rises to {top}, the head's top is at {HEAD_TOP}");
}

/// The energy beam keeps a value structure of its own on a white page: a white-hot core, the
/// colour, and a deeper, more saturated rim. Its orb swells as it charges.
#[test]
fn an_energy_beam_has_a_core_a_body_and_a_deep_rim_and_its_orb_swells() {
    let prepared = Stage::new(60.0).clip(Clip::new(Some(1), "beam").timed(0.0, Some(40.0))).prepare();
    let batch = batch_at(&prepared, 24.0).expect("the beam fires");
    let look = batch.draws.iter().find_map(|d| batch.spec(d).beam_look.filter(|_| batch.spec(d).shape == BEAM)).expect("a beam");
    let [core, body, rim] = [look.core, look.body, look.rim].map(|c| [c[0], c[1], c[2]]);
    assert!(luma(core) > 0.9 && luma(body) < luma(core) - 0.1, "a white-hot core {core:?} in a body of the colour {body:?}");
    assert!(luma(rim) < luma(body) - 0.3, "the rim {rim:?} is deeper than the body {body:?}");
    // The orb: the crisp discs at the hand.
    let orb = |tick: f64| {
        let batch = batch_at(&prepared, tick).unwrap();
        live(&batch).iter().filter(|(_, _, p)| {
            let s = &batch.specs[p.spec as usize];
            s.shape == DISC && s.emit_shape == POINT && s.softness < 0.5
        }).map(|(_, _, p)| p.size).fold(0.0, f64::max)
    };
    let (early, late) = (orb(3.0), orb(11.0));
    assert!(early > 0.0 && early < 0.75 * late, "the orb swells as it charges: {early} then {late}");
}

/// The electric aura crackles: forked bolts strike out from all over the body, each held for two
/// frames and struck again elsewhere, white-hot inside a line of the colour.
#[test]
fn an_electric_aura_crackles_about_the_body() {
    let prepared = Stage::new(60.0).clip(Clip::new(Some(1), "aura").set("style", "1").set("color", "0x6fd8ff")).prepare();
    let bolts = |tick: f64| {
        let batch = batch_at(&prepared, tick).expect("the aura crackles");
        let mut pieces = Vec::new();
        for draw in batch.draws.iter().filter(|d| batch.spec(d).shape == ARC) {
            let s = batch.spec(draw);
            let ink = s.outline.expect("an ink line round its bolts");
            let core = particle::color_at(s, 0.0).0;
            assert!(luma(ink.color) < luma(core) - 0.3, "the line {:?} is deeper than the core {core:?}", ink.color);
            pieces.extend(particle::arcs(&batch, draw));
        }
        pieces
    };
    let (a, b, c) = (bolts(20.0), bolts(21.0), bolts(22.0));
    assert!(a.len() > 30, "{} pieces of lightning", a.len());
    assert_eq!(a, b, "a strike holds for two frames");
    assert_ne!(a, c, "and is struck again elsewhere");
    // Every bolt is about the body: within reach of the figure (its hip at 300, 180 tall).
    for p in a.iter().chain(&c) {
        for [x, y] in [p.p0, p.p1] {
            assert!((x - HIP[0]).abs() < 180.0 && y > HEAD_TOP - 160.0 && y < HIP[1] + 180.0, "a bolt at ({x}, {y})");
        }
    }
}

/// A lightning strike is one bright main channel with thinner bolts about it, each white-hot
/// inside a line of the colour, struck again every other frame.
#[test]
fn lightning_is_one_main_channel_with_thinner_bolts_struck_again_every_other_frame() {
    let prepared = Stage::new(60.0).clip(Clip::new(Some(1), "beam").set("style", "4").set("charge", "0").set("arcs", "6").timed(0.0, Some(40.0))).prepare();
    let batch = batch_at(&prepared, 10.0).expect("the strike");
    let mut layers: Vec<_> = batch.draws.iter().filter(|d| batch.spec(d).shape == ARC).map(|d| batch.spec(d)).collect();
    layers.sort_by(|a, b| b.size0.total_cmp(&a.size0));
    assert_eq!(layers.len(), 2, "a main channel and thinner bolts");
    assert!(layers[0].size0 > 2.5 * layers[1].size0 && layers[0].count < layers[1].count, "the main channel is one thick bolt");
    for s in &layers {
        let ink = s.outline.expect("an ink line");
        assert!(luma(ink.color) < luma(particle::color_at(s, 0.0).0) - 0.3);
    }
    let pieces = |tick: f64| {
        let batch = batch_at(&prepared, tick).unwrap();
        batch.draws.iter().filter(|d| batch.spec(d).shape == ARC).flat_map(|d| particle::arcs(&batch, d)).collect::<Vec<_>>()
    };
    assert_eq!(pieces(10.0), pieces(11.0));
    assert_ne!(pieces(10.0), pieces(12.0));
}

/// Every aura and beam style, retired ones included, draws something within the limits at its
/// defaults and at the minimum and the maximum of its main controls: no limit thins it, and it
/// stays a few thousand records at most (fewer, better particles).
#[test]
fn every_aura_and_beam_style_draws_within_the_limits_at_every_setting() {
    let aura_min = [("height", "0.2"), ("width", "0.2"), ("density", "0.1"), ("intensity", "0"), ("turbulence", "0")];
    let aura_max = [("height", "3"), ("width", "3"), ("density", "4"), ("intensity", "3"), ("turbulence", "3"), ("dust", "on")];
    let beam_min = [("width", "1"), ("intensity", "0"), ("sparks", "0"), ("arcs", "0"), ("wobble", "0")];
    let beam_max = [("width", "200"), ("intensity", "3"), ("sparks", "4"), ("arcs", "8"), ("wobble", "3"), ("strands", "on")];
    let cases: [(&str, u32, &[(&str, &str)], &[(&str, &str)]); 2] = [("aura", 8, &aura_min, &aura_max), ("beam", 6, &beam_min, &beam_max)];
    for (kind, styles, min, max) in cases {
        for style in 0..styles {
            for (setting, sets, limit) in [("default", &[][..], 2500), ("minimum", min, 2500), ("maximum", max, 9000)] {
                let mut clip = Clip::new(Some(1), kind).set("style", &style.to_string());
                for (name, value) in sets {
                    clip = clip.set(name, value);
                }
                if kind == "beam" {
                    clip = clip.timed(0.0, Some(40.0));
                }
                let prepared = Stage::new(60.0).clip(clip).prepare();
                let mut most = 0;
                // A beam fires once its charge (12 frames by default) is over.
                let ticks = if kind == "beam" { [14.0, 24.0, 36.0] } else { [10.0, 24.0, 36.0] };
                for tick in ticks {
                    let batch = batch_at(&prepared, tick).unwrap_or_else(|| panic!("{kind} style {style} {setting}: nothing at tick {tick}"));
                    assert!(!batch.reduced, "{kind} style {style} {setting}: a limit thinned it at tick {tick}");
                    let pieces: usize = batch.draws.iter().filter(|d| batch.spec(d).shape == ARC).map(|d| particle::arcs(&batch, d).len()).sum();
                    let beams = batch.draws.iter().filter(|d| batch.spec(d).shape == BEAM && particle::beam(&batch, d).is_some()).count();
                    most = most.max(live(&batch).len() + pieces + beams);
                }
                assert!(most > 0 && most < limit, "{kind} style {style} {setting}: {most} records");
            }
        }
    }
}
