//! What the aura and energy-beam styles draw (docs/engine/vfx.md, Generated effects): the
//! anatomy each style is built from, stated on the review stage (a stick figure 180 pixels
//! tall, its hip at `HIP`, its head's top at y 202).

use styk_eval::vfx::generated::layers::{BEAM_LINE, BEAM_TIP};
use styk_eval::vfx::generated::particle::Evaluator;
use styk_eval::vfx::generated::stage::{Clip, Stage};

use super::generators::{batch_at, live};

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
