//! The Ctrl+Tab project switcher (`src/shell/project-switcher.mjs`).
//!
//! Pressed and released, Ctrl+Tab goes to the project used before this one. Held, it shows a board of the open projects,
//! most recently used first, as Alt+Tab shows windows: Tab (Shift+Tab) or an arrow moves along it, releasing the
//! modifier switches, Escape stays. A card can be clicked. Run with no held modifier (the command palette, a menu, a
//! rebound key) there is nothing to release, so it switches at once. It needs two or more projects.

use crate::documents::DocumentId;

/// What a key does on the open board.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    /// Tab, Shift+Tab and the arrows: one card along.
    Step(isize),
    /// Enter or Space.
    Commit,
    /// Escape.
    Escape,
}

/// What the owner does after an input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing.
    None,
    /// The board opened or its selection moved: draw it.
    Changed,
    /// The board closed and this project comes to the front, if it is still open.
    Activate(DocumentId),
    /// The board closed and the project in front stays.
    Closed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Board {
    order: Vec<DocumentId>,
    index: usize,
}

/// The switcher: closed, or a board over the open projects.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Switcher {
    board: Option<Board>,
}

impl Switcher {
    /// Closed.
    pub fn new() -> Switcher {
        Switcher::default()
    }

    /// Whether the board shows, which also means every key belongs to it.
    pub fn is_open(&self) -> bool {
        self.board.is_some()
    }

    /// The board's cards in order and the selected one.
    pub fn board(&self) -> Option<(&[DocumentId], usize)> {
        self.board.as_ref().map(|board| (board.order.as_slice(), board.index))
    }

    /// Ctrl+Tab was pressed. `order` is the open projects, the one in front first, then the others most recently used
    /// first (`Documents::recency`); `held` says the modifier is still down.
    pub fn open(&mut self, order: Vec<DocumentId>, backwards: bool, held: bool) -> Outcome {
        if let Some(board) = &mut self.board {
            board.index = step(board.index, if backwards { -1 } else { 1 }, board.order.len());
            return Outcome::Changed;
        }
        if order.len() < 2 {
            return Outcome::None;
        }
        let start = if backwards { order.len() - 1 } else { 1 };
        if !held {
            return Outcome::Activate(order[start]);
        }
        self.board = Some(Board { order, index: start });
        Outcome::Changed
    }

    /// A key while the board shows.
    pub fn key(&mut self, key: Key) -> Outcome {
        let Some(board) = &mut self.board else { return Outcome::None };
        match key {
            Key::Step(by) => {
                board.index = step(board.index, by, board.order.len());
                Outcome::Changed
            }
            Key::Commit => self.commit(),
            Key::Escape => {
                self.board = None;
                Outcome::Closed
            }
        }
    }

    /// The modifier was released: the selected project comes to the front.
    pub fn released(&mut self) -> Outcome {
        self.commit()
    }

    /// A card was clicked.
    pub fn pick(&mut self, index: usize) -> Outcome {
        match &mut self.board {
            Some(board) if index < board.order.len() => {
                board.index = index;
                self.commit()
            }
            _ => Outcome::None,
        }
    }

    /// The window lost focus: the board goes and the project in front stays.
    pub fn blur(&mut self) -> Outcome {
        if self.board.take().is_some() { Outcome::Closed } else { Outcome::None }
    }

    fn commit(&mut self) -> Outcome {
        match self.board.take() {
            Some(board) => Outcome::Activate(board.order[board.index]),
            None => Outcome::None,
        }
    }
}

/// The board's grid is `repeat(auto-fill, minmax(156px, 1fr))` with a 4 px gap: how many 156 px cards fit across
/// `inner` pixels, at least one.
pub fn board_columns(inner: f32) -> usize {
    const CARD_LEAST: f32 = 156.0;
    const GAP: f32 = 4.0;
    (((inner + GAP) / (CARD_LEAST + GAP)).floor() as usize).max(1)
}

fn step(index: usize, by: isize, count: usize) -> usize {
    (index as isize + by).rem_euclid(count as isize) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: u64) -> Vec<DocumentId> {
        (1..=n).map(DocumentId::preview).collect()
    }

    #[test]
    fn with_fewer_than_two_projects_it_does_nothing() {
        let mut switcher = Switcher::new();
        assert_eq!(switcher.open(ids(1), false, true), Outcome::None);
        assert_eq!(switcher.open(Vec::new(), false, false), Outcome::None);
        assert!(!switcher.is_open());
    }

    #[test]
    fn pressed_and_released_goes_to_the_project_used_before() {
        // The modifier is already up when the command runs: there is nothing to release, so it switches at once.
        let mut switcher = Switcher::new();
        assert_eq!(switcher.open(ids(3), false, false), Outcome::Activate(DocumentId::preview(2)));
        assert!(!switcher.is_open());
        assert_eq!(switcher.open(ids(3), true, false), Outcome::Activate(DocumentId::preview(3)), "backwards goes to the least recent");
    }

    #[test]
    fn held_it_shows_the_board_on_the_project_used_before_and_releasing_switches() {
        let mut switcher = Switcher::new();
        assert_eq!(switcher.open(ids(3), false, true), Outcome::Changed);
        assert_eq!(switcher.board().map(|(_, index)| index), Some(1));
        assert_eq!(switcher.released(), Outcome::Activate(DocumentId::preview(2)));
        assert!(!switcher.is_open());
    }

    #[test]
    fn tab_and_shift_tab_move_along_the_board_around_its_ends() {
        let mut switcher = Switcher::new();
        switcher.open(ids(3), false, true);
        assert_eq!(switcher.open(ids(3), false, true), Outcome::Changed, "another Ctrl+Tab steps");
        assert_eq!(switcher.board().map(|(_, i)| i), Some(2));
        switcher.open(ids(3), false, true);
        assert_eq!(switcher.board().map(|(_, i)| i), Some(0), "around the end");
        switcher.open(ids(3), true, true);
        assert_eq!(switcher.board().map(|(_, i)| i), Some(2), "Shift+Tab back around");
        assert_eq!(switcher.key(Key::Step(-1)), Outcome::Changed);
        assert_eq!(switcher.board().map(|(_, i)| i), Some(1));
    }

    #[test]
    fn backwards_starts_on_the_last_card() {
        let mut switcher = Switcher::new();
        switcher.open(ids(4), true, true);
        assert_eq!(switcher.board().map(|(_, i)| i), Some(3));
    }

    #[test]
    fn escape_stays_and_enter_switches() {
        let mut switcher = Switcher::new();
        switcher.open(ids(3), false, true);
        assert_eq!(switcher.key(Key::Escape), Outcome::Closed);
        assert!(!switcher.is_open());
        switcher.open(ids(3), false, true);
        assert_eq!(switcher.key(Key::Commit), Outcome::Activate(DocumentId::preview(2)));
    }

    #[test]
    fn a_click_switches_to_that_card_and_blur_closes() {
        let mut switcher = Switcher::new();
        switcher.open(ids(3), false, true);
        assert_eq!(switcher.pick(2), Outcome::Activate(DocumentId::preview(3)));
        switcher.open(ids(3), false, true);
        assert_eq!(switcher.pick(9), Outcome::None, "a card that is not there");
        assert_eq!(switcher.blur(), Outcome::Closed);
        assert_eq!(switcher.blur(), Outcome::None);
    }

    #[test]
    fn the_board_has_as_many_columns_as_156_px_cards_fit() {
        // The popover is at most 716 px wide with 16 px padding: 684 px across, four cards.
        assert_eq!(board_columns(684.0), 4);
        assert_eq!(board_columns(635.0), 3);
        assert_eq!(board_columns(636.0), 4);
        assert_eq!(board_columns(100.0), 1, "never fewer than one");
    }

    #[test]
    fn keys_and_releases_with_no_board_do_nothing() {
        let mut switcher = Switcher::new();
        assert_eq!(switcher.key(Key::Commit), Outcome::None);
        assert_eq!(switcher.released(), Outcome::None);
    }
}
