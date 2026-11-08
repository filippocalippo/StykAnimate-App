//! The frames an edit reaches while Edit together is on: today's `rangeFrames()` (`src/app.mjs`), carried to every
//! range route the same way.
//!
//! On a layer sheet it is the frame on show's index with `sheetTicks`: the chosen ticks and the playhead's own tick,
//! once each (`[...new Set([...ticks, editor.tick])]`). On a classic document it is the chosen keyframe indices and the
//! frame on show's. A session command takes it as its frame argument: a plain index array, or on a sheet
//! `{"@array": [index], "sheetTicks": [...]}`, the engine owner's encoding of an array that carries `sheetTicks`.

use styk_doc::{Obj, Value};

use crate::documents::Document;
use crate::view_state::ViewState;

#[derive(Clone, Debug, PartialEq)]
pub struct Range {
    pub indices: Vec<usize>,
    /// A layer sheet's ticks, in today's order (chosen ticks first, then the playhead's if new).
    pub sheet_ticks: Option<Vec<f64>>,
}

fn sheet(document: &Document) -> bool {
    crate::inspector::facts::records(document).path(&["_styk", "layerSheet"]).is_some_and(Value::is_object)
}

impl Range {
    /// `rangeFrames()`: `None` unless Edit together is on and two or more frames are chosen.
    pub fn of(view: &ViewState, document: &Document) -> Option<Range> {
        let chosen = view.range_frames()?;
        let (tick, frame_index) = (crate::inspector::facts::tick(document), crate::inspector::facts::frame_index(document));
        if sheet(document) {
            let mut ticks: Vec<f64> = Vec::with_capacity(chosen.len() + 1);
            for tick in chosen.iter().map(|tick| *tick as f64).chain(std::iter::once(tick)) {
                if !ticks.contains(&tick) {
                    ticks.push(tick);
                }
            }
            return Some(Range { indices: vec![frame_index], sheet_ticks: Some(ticks) });
        }
        let mut indices: Vec<usize> = Vec::with_capacity(chosen.len() + 1);
        for index in chosen.iter().copied().chain(std::iter::once(frame_index)) {
            if !indices.contains(&index) {
                indices.push(index);
            }
        }
        Some(Range { indices, sheet_ticks: None })
    }

    /// The frame argument of a range command.
    pub fn value(&self) -> Value {
        let indices = Value::array(self.indices.iter().map(|index| Value::Num(*index as f64)).collect());
        match &self.sheet_ticks {
            None => indices,
            Some(ticks) => {
                let mut object = Obj::new();
                object.set("@array", indices);
                object.set("sheetTicks", Value::array(ticks.iter().map(|tick| Value::Num(*tick)).collect()));
                Value::object(object)
            }
        }
    }

    /// The ticks a keyed edit writes at, in today's order: a sheet's `sheetTicks` as chosen (`token.ticks`), else each
    /// chosen keyframe's start in index order (`token.indices.map(index => editor.timeline[index].start)`).
    pub fn ticks(&self, document: &Document) -> Vec<f64> {
        match &self.sheet_ticks {
            Some(ticks) => ticks.clone(),
            None => {
                let rows = styk_edit::timeline_rows(crate::inspector::facts::records(document));
                let mut indices = self.indices.clone();
                indices.sort_unstable();
                indices.iter().filter_map(|index| rows.get(*index).map(|row| row.0)).collect()
            }
        }
    }

    /// How many frames it reaches.
    pub fn len(&self) -> usize {
        self.sheet_ticks.as_ref().map_or(self.indices.len(), Vec::len)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
