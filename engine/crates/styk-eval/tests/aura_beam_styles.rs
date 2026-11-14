//! What the aura and energy-beam styles draw (docs/engine/vfx.md, Generated effects): the
//! anatomy each style is built from, stated on the review stage (a stick figure 180 pixels
//! tall, its hip at `HIP`, its head's top at y 202).

use styk_eval::vfx::generated::layers::{material, Placement, BEAM_LINE, BEAM_TIP};
use styk_eval::vfx::generated::particle::Evaluator;
use styk_eval::vfx::generated::stage::{Clip, Stage, HIP};

use super::generators::{batch_at, live};

/// The head's top on the review stage: hip 300, torso 62, head 36 across.
const HEAD_TOP: f64 = HIP[1] - 62.0 - 36.0;

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
