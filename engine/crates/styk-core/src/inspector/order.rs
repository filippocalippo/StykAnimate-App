//! A figure's draw order as the Inspector edits it: a port of `builderDrawables`, `reorderBuilderDrawables` and
//! `builderOrderValues` (`src/editor-builder-style.mjs`). The fills come first, then the segments, sorted by their
//! order value (a stable sort, as JavaScript's); a position is 1-based. Instance overrides (`_stykStyle`) take part,
//! as `orderFigure` resolves the instance's figure on a document with property channels.

#[cfg(feature = "engine")]
use styk_doc::Value;
#[cfg(feature = "engine")]
use styk_eval::doc::Figure;

use crate::i18n::Msg;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawKind {
    Polygon,
    Segment,
}

/// One drawable in draw order.
#[derive(Clone, Debug, PartialEq)]
pub struct Drawable {
    pub kind: DrawKind,
    /// Its index among the figure's fills or segments.
    pub index: usize,
    /// The segment's handle id, or the fill's identity (`polyfill_id`, else its index + 1).
    pub id: u32,
    pub z: f64,
}

#[cfg(feature = "engine")]
fn override_z(object: &Value, kind: DrawKind, id: u32) -> Option<f64> {
    let group = if kind == DrawKind::Segment { "segments" } else { "polygons" };
    object.path(&["_stykStyle", group, &id.to_string(), "zIndex"]).and_then(Value::as_f64).filter(|z| z.is_finite())
}

/// `builderDrawables(orderFigure(editor))`.
#[cfg(feature = "engine")]
pub fn drawables(figure: &Figure, object: &Value) -> Vec<Drawable> {
    let mut entries: Vec<Drawable> = figure
        .polyfills
        .iter()
        .enumerate()
        .map(|(index, polygon)| Drawable { kind: DrawKind::Polygon, index, id: polygon.id, z: override_z(object, DrawKind::Polygon, polygon.id).unwrap_or(polygon.z) })
        .chain(figure.segments.iter().enumerate().map(|(index, segment)| Drawable {
            kind: DrawKind::Segment,
            index,
            id: segment.id,
            z: override_z(object, DrawKind::Segment, segment.id).unwrap_or(segment.z),
        }))
        .collect();
    entries.sort_by(|a, b| a.z.total_cmp(&b.z));
    entries
}

/// The 1-based position of a drawable.
pub fn position(entries: &[Drawable], kind: DrawKind, index: usize) -> Option<usize> {
    entries.iter().position(|entry| entry.kind == kind && entry.index == index).map(|at| at + 1)
}

/// `reorderBuilderDrawables(entries, selected, delta)`: the selected members move by `delta` places without crossing each
/// other; the rest keep their relative order.
fn reorder(entries: &[Drawable], selected: &[(DrawKind, usize)], delta: i64) -> Vec<Drawable> {
    if delta == 0 {
        return entries.to_vec();
    }
    let is_selected = |entry: &Drawable| selected.contains(&(entry.kind, entry.index));
    let mut moving: Vec<(usize, &Drawable)> = entries.iter().enumerate().filter(|(_, entry)| is_selected(entry)).collect();
    let other: Vec<&Drawable> = entries.iter().filter(|entry| !is_selected(entry)).collect();
    if delta > 0 {
        moving.reverse();
    }
    let mut result: Vec<Option<Drawable>> = vec![None; entries.len()];
    let mut boundary: i64 = if delta > 0 { entries.len() as i64 - 1 } else { 0 };
    for (index, entry) in moving {
        let target = if delta > 0 { (index as i64 + delta).min(boundary) } else { (index as i64 + delta).max(boundary) };
        result[target as usize] = Some(entry.clone());
        boundary = target + if delta > 0 { -1 } else { 1 };
    }
    let mut rest = other.into_iter();
    result.into_iter().map(|slot| slot.or_else(|| rest.next().cloned())).map(|slot| slot.unwrap_or_else(|| entries[0].clone())).collect()
}

/// `builderOrderValues(binding, value)`: every drawable's new order value once the selected one moves to `value`. A move
/// that changes nothing keeps the drawables' own values.
pub fn values(entries: &[Drawable], selected: (DrawKind, usize), value: f64) -> Result<Vec<f64>, Msg> {
    let count = entries.len();
    if value.fract() != 0.0 || value < 1.0 || value > count as f64 {
        return Err(Msg::new("errors.editorBuilderStyle.drawOrderMustBeAWholePositionFrom").with("length", count));
    }
    let current = position(entries, selected.0, selected.1).unwrap_or(1) as i64;
    let next = reorder(entries, &[selected], value as i64 - current);
    let unchanged = entries.iter().zip(&next).all(|(a, b)| a.kind == b.kind && a.index == b.index);
    Ok(entries
        .iter()
        .map(|entry| if unchanged { entry.z } else { next.iter().position(|moved| moved.kind == entry.kind && moved.index == entry.index).map_or(entry.z, |at| (at + 1) as f64) })
        .collect())
}

#[cfg(feature = "engine")]
#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: DrawKind, index: usize, z: f64) -> Drawable {
        Drawable { kind, index, id: index as u32 + 1, z }
    }

    #[test]
    fn a_move_up_and_down_matches_today_s_reorder() {
        // Fills at 0, then segments at 1..=3: [P0, S0, S1, S2].
        let entries = vec![entry(DrawKind::Polygon, 0, 0.0), entry(DrawKind::Segment, 0, 1.0), entry(DrawKind::Segment, 1, 2.0), entry(DrawKind::Segment, 2, 3.0)];
        // S0 (position 2) to position 4: [P0, S1, S2, S0].
        assert_eq!(values(&entries, (DrawKind::Segment, 0), 4.0).unwrap(), [1.0, 4.0, 2.0, 3.0]);
        // S2 (position 4) to position 1: [S2, P0, S0, S1].
        assert_eq!(values(&entries, (DrawKind::Segment, 2), 1.0).unwrap(), [2.0, 3.0, 4.0, 1.0]);
        // No move keeps the stored values.
        assert_eq!(values(&entries, (DrawKind::Segment, 1), 3.0).unwrap(), [0.0, 1.0, 2.0, 3.0]);
        assert!(values(&entries, (DrawKind::Segment, 1), 5.0).is_err(), "past the end");
        assert!(values(&entries, (DrawKind::Segment, 1), 2.5).is_err(), "a whole position");
    }
}
