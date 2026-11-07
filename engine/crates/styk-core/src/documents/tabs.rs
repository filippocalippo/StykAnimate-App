//! What the tab strip needs of the open projects: their order, the order they were last used in, the neighbour of the one
//! in front and where a dragged tab lands. A port of `src/project-tabs.mjs` (`recency`, `successor`, `neighbour`,
//! `move`) onto `Documents`, which holds the tabs themselves: there is no second list.

use super::{Document, DocumentId, Documents};

impl Documents {
    /// The tab's place in the strip.
    pub fn index_of(&self, id: DocumentId) -> Option<usize> {
        self.tabs.iter().position(|tab| tab.id == id)
    }

    /// The open projects, the one in front first, then the others most recently used first (`recency`): the order of
    /// the Ctrl+Tab board. An id the owner no longer holds is skipped, so a closed project cannot be offered.
    pub fn recency(&self) -> Vec<DocumentId> {
        self.recent.iter().copied().filter(|id| self.get(*id).is_some()).collect()
    }

    /// The project that comes to the front when `id` closes: the one used before it (`successor`).
    pub fn successor(&self, id: DocumentId) -> Option<DocumentId> {
        self.recency().into_iter().find(|other| *other != id)
    }

    /// The tab `step` places from the one in front, around the strip's ends (`neighbour`); none with fewer than two.
    pub fn neighbour(&self, step: isize) -> Option<DocumentId> {
        let count = self.tabs.len();
        let at = self.active.and_then(|active| self.index_of(active))?;
        if count < 2 {
            return None;
        }
        let to = (at as isize + step).rem_euclid(count as isize) as usize;
        Some(self.tabs[to].id)
    }

    /// Moves a tab to `index` in the strip (clamped), `true` when its place changed (`move`).
    pub fn move_tab(&mut self, id: DocumentId, index: usize) -> bool {
        let Some(from) = self.index_of(id) else { return false };
        let to = index.min(self.tabs.len() - 1);
        if to == from {
            return false;
        }
        let tab: Document = self.tabs.remove(from);
        self.tabs.insert(to, tab);
        true
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
