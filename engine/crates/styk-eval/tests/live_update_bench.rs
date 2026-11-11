//! What one undo of a stroke costs the live cels' update (`cargo test --release -p styk-eval --test live_update_bench -- --ignored --nocapture`):
//! the cel swaps between two states that differ in a stroke's tiles, as an undo and a redo do.

use styk_eval::live::{LiveCels, TILE_BYTES};

struct Rng(u64);
impl Rng {
    fn next(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % n
    }
}

/// A tile with ink in a blob, as a brush leaves it.
fn tile(rng: &mut Rng, seed: u8) -> Vec<u8> {
    let mut pixels = vec![0u8; TILE_BYTES];
    let (cx, cy, r) = (8 + rng.next(48) as i32, 8 + rng.next(48) as i32, 6 + rng.next(14) as i32);
    for y in 0..64i32 {
        for x in 0..64i32 {
            if (x - cx).pow(2) + (y - cy).pow(2) <= r * r {
                let at = ((y * 64 + x) * 4) as usize;
                pixels[at..at + 4].copy_from_slice(&[seed, seed.wrapping_mul(3), 40, 255]);
            }
        }
    }
    pixels
}

#[test]
#[ignore = "a measurement"]
fn the_update_of_one_undo_of_a_stroke() {
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let mut live = LiveCels::default();
    // A cel of 12 × 12 tiles drawn, and a stroke across it that changes 30 of them (and adds 10 new ones beyond the edge).
    let base: Vec<((i32, i32), Option<Vec<u8>>)> = (0..12).flat_map(|y| (0..12).map(move |x| (x, y))).map(|at| (at, Some(tile(&mut rng, 10)))).collect();
    let mut stroke: Vec<((i32, i32), Option<Vec<u8>>)> = Vec::new();
    for k in 0..30 {
        stroke.push(((k % 12, 2 + k / 12), Some(tile(&mut rng, 200))));
    }
    for k in 0..10 {
        stroke.push(((12 + k % 3, k / 3), Some(tile(&mut rng, 90))));
    }
    let before: Vec<((i32, i32), Option<Vec<u8>>)> = stroke.iter().map(|(at, _)| (*at, base.iter().find(|(b, _)| b == at).and_then(|(_, p)| p.clone()))).collect();
    live.update("cel", false, base).expect("room");
    live.show("cel", true, false);
    let _ = live.take_runs();
    let rounds = 300;
    let (mut update_ms, mut runs_ms, mut runs, mut slots) = (0.0, 0.0, 0usize, 0usize);
    for round in 0..rounds {
        let changes = if round % 2 == 0 { stroke.clone() } else { before.clone() };
        let started = std::time::Instant::now();
        live.update("cel", false, changes).expect("room");
        update_ms += started.elapsed().as_secs_f64() * 1000.0;
        let started = std::time::Instant::now();
        let taken = live.take_runs();
        runs_ms += started.elapsed().as_secs_f64() * 1000.0;
        runs += taken.len();
        slots += taken.iter().map(|run| run.cells as usize).sum::<usize>();
    }
    eprintln!("MEASURE update {:.3} ms, take_runs {:.3} ms, {} runs and {} slots per undo", update_ms / rounds as f64, runs_ms / rounds as f64, runs / rounds, slots / rounds);
}
