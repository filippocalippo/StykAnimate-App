/// Stable identity within one `Documents` owner. Pair this with a revision in caches and job replies:
/// two projects can have the same history revision, and undo deliberately restores an older revision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DocumentId(pub(crate) u64);

impl DocumentId {
    /// The identity as a number, for the interface's own keys (focus targets); it means nothing else.
    pub const fn get(self) -> u64 {
        self.0
    }

    /// An identity for a band shown without open projects (`Shell::preview`) and for tests of logic that only holds ids.
    pub const fn preview(serial: u64) -> DocumentId {
        DocumentId(serial)
    }
}

/// The place a dragged tab takes when dropped on the half of another tab (`drop` in `project-tabs-view.mjs`): the
/// target's index, one more after its midpoint, one less when the dragged tab came from before it.
pub fn drop_index(from: usize, target: usize, after: bool) -> usize {
    let to = target + usize::from(after);
    if from < to { to - 1 } else { to }
}

#[cfg(test)]
mod tests {
    use super::drop_index;

    #[test]
    fn a_tab_dropped_on_the_far_half_of_its_right_neighbour_moves_one_place() {
        assert_eq!(drop_index(0, 1, true), 1);
        assert_eq!(drop_index(0, 1, false), 0, "before its right neighbour is where it already is");
    }

    #[test]
    fn a_tab_dropped_before_an_earlier_tab_takes_that_tabs_place() {
        assert_eq!(drop_index(3, 1, false), 1);
        assert_eq!(drop_index(3, 1, true), 2);
    }

    #[test]
    fn dropping_on_the_last_tabs_far_half_goes_to_the_end() {
        assert_eq!(drop_index(0, 3, true), 3);
        assert_eq!(drop_index(2, 3, true), 3);
    }

    #[test]
    fn dropping_on_the_tab_itself_changes_nothing() {
        for index in 0..5 {
            assert_eq!(drop_index(index, index, false), index);
            assert_eq!(drop_index(index, index, true), index);
        }
    }
}
