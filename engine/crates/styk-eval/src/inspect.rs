//! Worker-only evaluation and bounded draw-list projections, using the evaluator's normal path.
use crate::{
    drawlist::DrawList,
    eval::{Frame, Prepared},
};
pub fn evaluated_frame(document: &Prepared, tick: f64) -> Frame {
    document.evaluate(tick)
}
#[derive(Clone, Copy, Debug)]
pub struct Primitive {
    pub index: usize,
    pub kind: u32,
    pub group: u32,
}
pub struct DrawlistSummary {
    pub n_total: usize,
    pub more: Option<usize>,
    pub rows: Vec<Primitive>,
}
pub fn drawlist_summary(frame: &DrawList, offset: usize) -> DrawlistSummary {
    let end = frame.prims.len().min(offset.saturating_add(50));
    DrawlistSummary {
        n_total: frame.prims.len(),
        more: (end < frame.prims.len()).then_some(end),
        rows: frame
            .prims
            .iter()
            .enumerate()
            .skip(offset)
            .take(50)
            .map(|(index, p)| Primitive {
                index,
                kind: p.kind,
                group: p.group,
            })
            .collect(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drawlist_pages_have_explicit_continuations() {
        let mut list = DrawList::default();
        list.prims.resize(51, Default::default());
        let a = drawlist_summary(&list, 0);
        assert_eq!(a.rows.len(), 50);
        assert_eq!(a.more, Some(50));
        assert_eq!(drawlist_summary(&list, 50).rows[0].index, 50);
    }
}
