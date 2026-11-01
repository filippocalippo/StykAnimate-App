//! What each tick of the open document draws, for a document whose pictures the stage keeps a few pages at a time
//! ([`crate::Residency`]): the table lets the stage load the pictures of the ticks playback is about to reach, and of the
//! neighbours of a tick the person jumped to, by time and not only for the frames the workers happened to prepare.
//!
//! It is made on the workers when nothing else is waiting (`Engine::spawn_idle`): each tick is evaluated and encoded
//! as a frame is and only the pictures its draw list names are kept, a few `u32` a tick. A table belongs to one
//! generation; the next revision of the document makes a new one when it is asked for.

use std::sync::{Arc, Mutex, MutexGuard};

use crate::images::{pictures_of, PlaceIndex};
use crate::{Engine, Generation};

/// Ticks a background task fills.
const CHUNK: u32 = 4;

#[derive(Default)]
pub(crate) struct PictureTable {
    generation: u64,
    rows: Vec<Option<Arc<[u32]>>>,
    done: u32,
}

fn lock(table: &Mutex<PictureTable>) -> MutexGuard<'_, PictureTable> {
    table.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Engine {
    /// Begins the table of `generation`'s ticks, once: a call while it is being made or done does nothing. The work is
    /// spread over the workers and yields to frames and pictures.
    pub fn request_picture_table(&self, generation: &Arc<Generation>) {
        let ticks = generation.playable_ticks();
        if ticks == 0 {
            return;
        }
        {
            let mut table = lock(&self.inner.picture_table);
            if table.generation == generation.id {
                return;
            }
            *table = PictureTable { generation: generation.id, rows: vec![None; ticks as usize], done: 0 };
        }
        // The chunks are made on a worker: a request comes from the interface thread.
        let generation = generation.clone();
        self.spawn_idle(move |engine| {
            let index = Arc::new(PlaceIndex::new(&generation.assets));
            for start in (0..ticks).step_by(CHUNK as usize) {
                let (generation, index) = (generation.clone(), index.clone());
                engine.spawn_idle(move |engine| engine.fill_picture_rows(&generation, &index, start, (start + CHUNK).min(ticks)));
            }
        });
    }

    fn fill_picture_rows(&self, generation: &Generation, index: &PlaceIndex, start: u32, end: u32) {
        for tick in start..end {
            if self.inner.stopping.load(std::sync::atomic::Ordering::SeqCst) || lock(&self.inner.picture_table).generation != generation.id {
                return;
            }
            // The frames the stage draws are culled to the artboard: a picture off it is not one a layer is wanted for.
            let frame = crate::frames::produce(generation, tick as f64, &[], false, true, self.inner.clock);
            let row: Arc<[u32]> = pictures_of(&frame.list, index).into();
            let mut table = lock(&self.inner.picture_table);
            if table.generation == generation.id {
                table.rows[tick as usize] = Some(row);
                table.done += 1;
            }
        }
    }

    /// The pictures (indices into the document's images) tick `tick` of generation `generation` draws, once the table has
    /// that row. `None` while it has not, or when another generation's table is the one held; never waits.
    pub fn picture_row(&self, generation: u64, tick: u32) -> Option<Arc<[u32]>> {
        let table = self.inner.picture_table.try_lock().ok()?;
        if table.generation != generation {
            return None;
        }
        table.rows.get(tick as usize)?.clone()
    }

    /// Ticks of `generation`'s table that are made, and its size.
    pub fn picture_table_progress(&self, generation: u64) -> (u32, u32) {
        let table = lock(&self.inner.picture_table);
        if table.generation == generation { (table.done, table.rows.len() as u32) } else { (0, 0) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_of_another_generation_are_not_read() {
        let engine = Engine::new(|| 0.0, crate::Budgets::for_device(None));
        assert!(engine.picture_row(1, 0).is_none());
        assert_eq!(engine.picture_table_progress(1), (0, 0));
    }

    #[test]
    fn the_table_names_the_pictures_the_stage_draws_and_not_the_ones_the_artboard_clips_away() {
        // The sprites fixture on an artboard of 20 by 20: nearly everything its figures draw lies outside it.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../styk-eval/tests/fixtures/eval/sticknodes-sprites.json");
        let text = std::fs::read_to_string(path).unwrap().replacen("\"canvas_width\":960", "\"canvas_width\":20", 1).replacen("\"canvas_height\":540", "\"canvas_height\":20", 1);
        let engine = Engine::new(|| 0.0, crate::Budgets::for_device(None));
        engine.open(text.as_bytes(), "json", "small artboard").unwrap();
        let generation = engine.generation().unwrap();
        let index = PlaceIndex::new(&generation.assets);
        engine.request_picture_table(&generation);
        while engine.step() {}
        let (mut table, mut whole) = (0, 0);
        for tick in 0..generation.playable_ticks() {
            let drawn = pictures_of(&crate::frames::produce(&generation, tick as f64, &[], false, true, || 0.0).list, &index);
            assert_eq!(engine.picture_row(generation.id, tick).unwrap().as_ref(), drawn.as_slice(), "tick {tick}: what the stage draws");
            table += drawn.len();
            whole += pictures_of(&crate::frames::produce(&generation, tick as f64, &[], false, false, || 0.0).list, &index).len();
        }
        assert!(whole > 0 && table < whole, "the artboard clips pictures away ({table} of {whole})");
    }
}
