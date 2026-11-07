//! Where a dragged tab lands. Tab order, recency, the neighbour and the successor are K-doc's (`Documents::recency`,
//! `successor`, `neighbour`, `reorder`, `documents/host.rs`); the band adds only the drop rule it needs.

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
