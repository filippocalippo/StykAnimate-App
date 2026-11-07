//! The project tab strip's state beside the tabs themselves: each tab's save state (the dot), the keys of a tab, and
//! drag to reorder (`src/shell/project-tabs-view.mjs`, `docs/PROJECT-TABS.md`).
//!
//! What a tab shows is the dot: neutral for unsaved changes, never red; the success tone for a moment after a save
//! lands (`SAVED_FOR_MS`). While a save runs the dot stays. A save that fails shows the ordinary dot for unsaved changes and
//! is reported through the error policy, not on the tab. Under the
//! pointer, and on the tab in front while it has nothing unsaved, Close takes the dot's place. The arrow keys move focus
//! along the tabs without switching, as switching is not free.

use super::band::Layout;
use crate::documents::{DocumentId, drop_index};
use crate::roving::{NavKey, Orientation, next_index};

/// How long "Saved" shows after a save lands (`SAVED_MS`).
pub const SAVED_FOR_MS: u64 = 2200;

/// How far the pointer moves with a tab pressed before it is a drag and not a click, in logical pixels.
pub const DRAG_THRESHOLD: f32 = 4.0;

/// A tab's dot (`data-state`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabState {
    /// Unsaved changes.
    Edited,
    /// A save is running.
    Saving,
    /// A save landed a moment ago.
    Saved,
}

/// What the strip remembers of each project's saving.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Saves {
    saving: Vec<DocumentId>,
    saved: Vec<(DocumentId, u64)>,
}

impl Saves {
    /// A save of the project began.
    pub fn started(&mut self, id: DocumentId) {
        if !self.saving.contains(&id) {
            self.saving.push(id);
        }
    }

    /// A save landed at `now` (milliseconds on the application's clock).
    pub fn landed(&mut self, id: DocumentId, now: u64) {
        self.saving.retain(|other| *other != id);
        self.saved.retain(|(other, _)| *other != id);
        self.saved.push((id, now));
    }

    /// A save ended without landing (it failed or was cancelled): the project is as unsaved as before, and the error
    /// policy says why.
    pub fn ended(&mut self, id: DocumentId) {
        self.saving.retain(|other| *other != id);
    }

    /// The project closed.
    pub fn forget(&mut self, id: DocumentId) {
        self.saving.retain(|other| *other != id);
        self.saved.retain(|(other, _)| *other != id);
    }

    /// Time passed: a "Saved" older than [`SAVED_FOR_MS`] goes.
    pub fn tick(&mut self, now: u64) {
        self.saved.retain(|(_, at)| now.saturating_sub(*at) < SAVED_FOR_MS);
    }

    /// When the next "Saved" ends, on the application's clock: the owner wakes the strip then.
    pub fn next_deadline(&self) -> Option<u64> {
        self.saved.iter().map(|(_, at)| at + SAVED_FOR_MS).min()
    }

    /// A tab's dot: saving, else unsaved changes, else a save just landed (`describe`).
    pub fn state(&self, id: DocumentId, dirty: bool) -> Option<TabState> {
        if self.saving.contains(&id) {
            Some(TabState::Saving)
        } else if dirty {
            Some(TabState::Edited)
        } else if self.saved.iter().any(|(other, _)| *other == id) {
            Some(TabState::Saved)
        } else {
            None
        }
    }

}

/// The keys a focused tab answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabKey {
    /// ArrowLeft.
    Left,
    /// ArrowRight.
    Right,
    /// Home.
    Home,
    /// End.
    End,
    /// Enter or Space: bring the project to the front.
    Activate,
    /// Delete: close it.
    Delete,
    /// F2: rename it.
    Rename,
    /// The Menu key: open its menu.
    Menu,
}

/// What a tab key asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyOutcome {
    /// Move keyboard focus to this tab, without switching.
    Focus(DocumentId),
    /// Bring this project to the front.
    Activate(DocumentId),
    /// Close this project.
    Close(DocumentId),
    /// Rename this project.
    Rename(DocumentId),
    /// Open this project's menu.
    Menu(DocumentId),
    /// Nothing.
    None,
}

/// What a key does on tab `from` of `order` (the arrows wrap around the ends, as the strip does).
pub fn key(order: &[DocumentId], from: DocumentId, key: TabKey) -> KeyOutcome {
    let Some(index) = order.iter().position(|id| *id == from) else { return KeyOutcome::None };
    let nav = match key {
        TabKey::Left => Some(NavKey::ArrowLeft),
        TabKey::Right => Some(NavKey::ArrowRight),
        TabKey::Home => Some(NavKey::Home),
        TabKey::End => Some(NavKey::End),
        _ => None,
    };
    if let Some(nav) = nav {
        return match next_index(nav, Some(index), order.len(), Orientation::Horizontal, true, |_| false) {
            Some(next) => KeyOutcome::Focus(order[next]),
            None => KeyOutcome::None,
        };
    }
    match key {
        TabKey::Activate => KeyOutcome::Activate(from),
        TabKey::Delete => KeyOutcome::Close(from),
        TabKey::Rename => KeyOutcome::Rename(from),
        TabKey::Menu => KeyOutcome::Menu(from),
        _ => KeyOutcome::None,
    }
}

/// Which side of the target tab a dragged tab would land on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// Before the tab.
    Before,
    /// After it.
    After,
}

/// A press on a tab, until it is released.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Drag {
    /// The tab pressed.
    pub id: DocumentId,
    /// Where the pointer first was after the press (the window reports positions only as it moves).
    pub origin: Option<f32>,
    /// Where the pointer was last, in window coordinates.
    pub last: Option<(f32, f32)>,
    /// The pointer moved far enough: this is a drag, not a click.
    pub moving: bool,
    /// The tab under the pointer and the side of it, while dragging.
    pub over: Option<(DocumentId, Side)>,
}

/// What releasing the pointer did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dropped {
    /// A click: bring the project to the front.
    Click(DocumentId),
    /// Move the tab to this place in the strip.
    Move(DocumentId, usize),
    /// Nothing.
    None,
}

fn side(after: bool) -> Side {
    if after { Side::After } else { Side::Before }
}

/// The tab strip's state.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Strip {
    /// Saving and saved.
    pub saves: Saves,
    drag: Option<Drag>,
}

impl Strip {
    /// The press being tracked, if any.
    pub fn drag(&self) -> Option<&Drag> {
        self.drag.as_ref()
    }

    /// Whether a press is being tracked, which means the pointer is followed everywhere in the window.
    pub fn pressed(&self) -> bool {
        self.drag.is_some()
    }

    /// Whether a drag (not just a press) is on.
    pub fn dragging(&self) -> bool {
        self.drag.is_some_and(|drag| drag.moving)
    }

    /// The primary button went down on a tab.
    pub fn press(&mut self, id: DocumentId) {
        self.drag = Some(Drag { id, origin: None, last: None, moving: false, over: None });
    }

    /// The pointer moved to window position (`x`, `y`) with a tab pressed.
    pub fn moved(&mut self, x: f32, y: f32, layout: &Layout) {
        let Some(drag) = &mut self.drag else { return };
        let origin = *drag.origin.get_or_insert(x);
        drag.last = Some((x, y));
        if !drag.moving && (x - origin).abs() >= DRAG_THRESHOLD {
            drag.moving = true;
        }
        if drag.moving {
            // The tab being dragged shows no line on itself.
            drag.over = layout.tab_at(x, y).filter(|(id, _)| *id != drag.id).map(|(id, after)| (id, side(after)));
        }
    }

    /// The primary button came up where the pointer last was; `order` is the tabs now. A press the pointer never left
    /// is a click on its tab. A click or a drop counts only where the pointer is inside the tab's rectangle, as a click
    /// and a drop do in the page: released above, below or beside the strip nothing happens.
    pub fn released(&mut self, layout: &Layout, order: &[DocumentId]) -> Dropped {
        let Some(drag) = self.drag.take() else { return Dropped::None };
        if !drag.moving {
            // A click lands on the tab it started on.
            return match drag.last {
                None => Dropped::Click(drag.id),
                Some((x, y)) if layout.tab_at(x, y).is_some_and(|(id, _)| id == drag.id) => Dropped::Click(drag.id),
                Some(_) => Dropped::None,
            };
        }
        let Some((target, after)) = drag.last.and_then(|(x, y)| layout.tab_at(x, y)) else { return Dropped::None };
        let (Some(from), Some(at)) = (order.iter().position(|id| *id == drag.id), order.iter().position(|id| *id == target)) else { return Dropped::None };
        let to = drop_index(from, at, after);
        if to == from { Dropped::None } else { Dropped::Move(drag.id, to) }
    }

    /// The drag was given up (Escape, the window lost focus).
    pub fn cancel(&mut self) {
        self.drag = None;
    }

    /// A project closed: nothing more is tracked for it.
    pub fn forget(&mut self, id: DocumentId) {
        self.saves.forget(id);
        if self.drag.is_some_and(|drag| drag.id == id) {
            self.drag = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::band::{Input, Labels, Metrics, TabFacts, solve};
    use super::super::session::Session;
    use super::*;

    fn id(n: u64) -> DocumentId {
        DocumentId::preview(n)
    }

    fn layout(count: u64) -> (Layout, Vec<DocumentId>) {
        let tabs: Vec<TabFacts> = (1..=count).map(|n| TabFacts { id: id(n), front: n == 1, marked: false }).collect();
        let labels = Labels { animate: 52.0, draw: 33.0, build: 31.0, export: 39.0, cancel: 41.0, test_rig: 43.0, done: 31.0 };
        let input = Input { width: 1560.0, height: 1000.0, ui_scale: 1.0, tabs: &tabs, session: Session::None, window_controls: true, properties: false, metrics: Metrics::TODAY, labels };
        (solve(&input), (1..=count).map(id).collect())
    }

    /// A height inside the band's tabs.
    const MID: f32 = 26.0;

    fn frames(layout: &Layout) -> Vec<super::super::band::Frame> {
        layout.tabs().map(|(_, _, frame)| frame).collect()
    }

    #[test]
    fn a_tab_shows_saving_then_unsaved_then_saved_for_a_moment() {
        let mut saves = Saves::default();
        assert_eq!(saves.state(id(1), false), None);
        assert_eq!(saves.state(id(1), true), Some(TabState::Edited));
        saves.started(id(1));
        assert_eq!(saves.state(id(1), true), Some(TabState::Saving), "saving wins over unsaved");
        saves.landed(id(1), 10_000);
        assert_eq!(saves.state(id(1), false), Some(TabState::Saved));
        assert_eq!(saves.next_deadline(), Some(12_200));
        saves.tick(12_199);
        assert_eq!(saves.state(id(1), false), Some(TabState::Saved));
        saves.tick(12_200);
        assert_eq!(saves.state(id(1), false), None, "2.2 s later the tab is quiet again");
        assert_eq!(saves.next_deadline(), None);
    }

    #[test]
    fn a_save_that_ends_without_landing_shows_the_ordinary_unsaved_dot() {
        let mut saves = Saves::default();
        saves.started(id(2));
        assert_eq!(saves.state(id(2), true), Some(TabState::Saving));
        saves.ended(id(2));
        assert_eq!(saves.state(id(2), true), Some(TabState::Edited), "today shows edited, not a failure state");
        assert_eq!(saves.state(id(2), false), None, "and nothing for a project with nothing unsaved");
        saves.started(id(2));
        saves.landed(id(2), 1);
        saves.forget(id(2));
        assert_eq!(saves.state(id(2), false), None);
    }

    #[test]
    fn a_click_or_a_drop_released_outside_the_tabs_rectangle_does_nothing() {
        let (layout, order) = layout(3);
        let frames = frames(&layout);
        let below = layout.height + 40.0;
        // A click: pressed on the first tab, released far below the band.
        let mut strip = Strip::default();
        strip.press(id(1));
        strip.moved(frames[0].x + 10.0, MID, &layout);
        strip.moved(frames[0].x + 10.0, below, &layout);
        assert_eq!(strip.released(&layout, &order), Dropped::None, "a click ends where it began, not under the stage");
        // A drop: dragged over the far half of the last tab's x range but released below it.
        strip.press(id(1));
        strip.moved(frames[0].x + 10.0, MID, &layout);
        strip.moved(frames[2].right() - 3.0, MID, &layout);
        strip.moved(frames[2].right() - 3.0, below, &layout);
        assert_eq!(strip.released(&layout, &order), Dropped::None, "the drop target is the tab under the pointer, not the column it is in");
        // The line shows only while the pointer is over the tab.
        strip.press(id(1));
        strip.moved(frames[0].x + 10.0, MID, &layout);
        strip.moved(frames[1].x + 10.0, MID, &layout);
        assert_eq!(strip.drag().and_then(|d| d.over), Some((id(2), Side::Before)));
        strip.moved(frames[1].x + 10.0, below, &layout);
        assert_eq!(strip.drag().and_then(|d| d.over), None);
    }

    #[test]
    fn the_arrows_move_focus_around_the_ends_without_switching() {
        let order = vec![id(1), id(2), id(3)];
        assert_eq!(key(&order, id(1), TabKey::Right), KeyOutcome::Focus(id(2)));
        assert_eq!(key(&order, id(3), TabKey::Right), KeyOutcome::Focus(id(1)));
        assert_eq!(key(&order, id(1), TabKey::Left), KeyOutcome::Focus(id(3)));
        assert_eq!(key(&order, id(2), TabKey::Home), KeyOutcome::Focus(id(1)));
        assert_eq!(key(&order, id(2), TabKey::End), KeyOutcome::Focus(id(3)));
    }

    #[test]
    fn enter_delete_f2_and_the_menu_key_ask_for_their_command_on_that_tab() {
        let order = vec![id(1), id(2)];
        assert_eq!(key(&order, id(2), TabKey::Activate), KeyOutcome::Activate(id(2)));
        assert_eq!(key(&order, id(2), TabKey::Delete), KeyOutcome::Close(id(2)));
        assert_eq!(key(&order, id(2), TabKey::Rename), KeyOutcome::Rename(id(2)));
        assert_eq!(key(&order, id(2), TabKey::Menu), KeyOutcome::Menu(id(2)));
        assert_eq!(key(&order, id(9), TabKey::Activate), KeyOutcome::None, "a tab that is not there");
    }

    #[test]
    fn a_press_released_where_it_began_is_a_click() {
        let (layout, order) = layout(3);
        let x = frames(&layout)[0].x + 20.0;
        let mut strip = Strip::default();
        strip.press(id(1));
        strip.moved(x, MID, &layout);
        strip.moved(x + 2.0, MID, &layout);
        assert!(!strip.dragging(), "under the threshold");
        assert_eq!(strip.released(&layout, &order), Dropped::Click(id(1)));
        assert!(strip.drag().is_none());
    }

    #[test]
    fn a_press_the_pointer_never_left_is_a_click_even_with_no_position_reported() {
        let (layout, order) = layout(2);
        let mut strip = Strip::default();
        strip.press(id(2));
        assert_eq!(strip.released(&layout, &order), Dropped::Click(id(2)));
        assert_eq!(strip.released(&layout, &order), Dropped::None, "a release with no press is nothing");
    }

    #[test]
    fn a_press_released_on_another_tab_without_dragging_is_not_a_click_on_it() {
        let (layout, order) = layout(3);
        let frames = frames(&layout);
        let mut strip = Strip::default();
        strip.press(id(1));
        strip.moved(frames[0].right() + 1.0, MID, &layout);
        assert!(!strip.dragging());
        assert_eq!(strip.released(&layout, &order), Dropped::None);
    }

    #[test]
    fn dragging_past_the_threshold_marks_the_tab_under_the_pointer_with_its_side() {
        let (layout, _) = layout(3);
        let frames = frames(&layout);
        let mut strip = Strip::default();
        strip.press(id(1));
        strip.moved(frames[0].x + 10.0, MID, &layout);
        strip.moved(frames[1].x + 5.0, MID, &layout);
        assert!(strip.dragging());
        assert_eq!(strip.drag().and_then(|d| d.over), Some((id(2), Side::Before)));
        strip.moved(frames[1].right() - 5.0, MID, &layout);
        assert_eq!(strip.drag().and_then(|d| d.over), Some((id(2), Side::After)));
        strip.moved(frames[0].x + 10.0, MID, &layout);
        assert_eq!(strip.drag().and_then(|d| d.over), None, "no line on the tab being dragged");
    }

    #[test]
    fn dropping_on_the_far_half_of_a_later_tab_moves_the_dragged_tab_there() {
        let (layout, order) = layout(3);
        let frames = frames(&layout);
        let mut strip = Strip::default();
        strip.press(id(1));
        strip.moved(frames[0].x + 10.0, MID, &layout);
        strip.moved(frames[2].right() - 3.0, MID, &layout);
        assert_eq!(strip.released(&layout, &order), Dropped::Move(id(1), 2));
    }

    #[test]
    fn dropping_back_where_it_was_or_off_the_tabs_moves_nothing() {
        let (layout, order) = layout(3);
        let frames = frames(&layout);
        let mut strip = Strip::default();
        strip.press(id(2));
        strip.moved(frames[1].x + 10.0, MID, &layout);
        strip.moved(frames[1].x + 40.0, MID, &layout);
        assert_eq!(strip.released(&layout, &order), Dropped::None, "onto itself");
        strip.press(id(2));
        strip.moved(frames[1].x + 10.0, MID, &layout);
        strip.moved(30.0, MID, &layout);
        assert_eq!(strip.released(&layout, &order), Dropped::None, "onto the mark");
        strip.press(id(2));
        strip.moved(frames[1].x + 10.0, MID, &layout);
        strip.moved(frames[1].x + 60.0, MID, &layout);
        strip.cancel();
        assert_eq!(strip.released(&layout, &order), Dropped::None, "a cancelled drag has no drop");
    }

    #[test]
    fn a_tab_that_closes_ends_its_press() {
        let (layout, _) = layout(2);
        let mut strip = Strip::default();
        strip.press(id(2));
        strip.moved(200.0, MID, &layout);
        strip.moved(250.0, MID, &layout);
        strip.forget(id(2));
        assert!(strip.drag().is_none());
    }
}
