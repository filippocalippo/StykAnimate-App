//! The keyboard focus model (`docs/native/text-input.md` section 3).
//!
//! The interface registers its focusable targets each view pass, in tree order, and reports what the toolkit holds
//! focused after every event that can move it. This decides where Tab, Shift+Tab, F6 and the closing of a modal go, and
//! knows whether a text field has focus (which suppresses hotkeys). It never trusts a stored focus bit over a report.

/// A focusable target's identity, assigned by the interface and stable across view passes.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub struct FocusId(pub u64);

/// A scope's identity: the window root or one open modal (dialog, menu, popover).
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub struct ScopeId(pub u64);

impl ScopeId {
    /// The window itself.
    pub const ROOT: ScopeId = ScopeId(0);
}

/// The areas F6 cycles, in that order.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub enum FocusArea {
    TopBand,
    Tools,
    Panels,
    Stage,
    Timeline,
}

/// What a target is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    /// A button, toggle, slider, select, tab, scrub label.
    Control,
    /// A text field of any role: typing goes to it.
    TextEntry,
}

/// One focusable target, as registered in a view pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FocusTarget {
    pub id: FocusId,
    pub area: FocusArea,
    pub kind: TargetKind,
    pub enabled: bool,
    /// Whether Tab stops here. A roving group's inactive children are focusable by arrows and by `focus` but not stops.
    pub tab_stop: bool,
}

impl FocusTarget {
    /// An enabled Tab stop.
    pub fn new(id: u64, area: FocusArea, kind: TargetKind) -> FocusTarget {
        FocusTarget { id: FocusId(id), area, kind, enabled: true, tab_stop: true }
    }

    fn focusable(&self) -> bool {
        self.enabled
    }

    fn stops(&self) -> bool {
        self.enabled && self.tab_stop
    }
}

#[derive(Clone, Debug)]
struct Scope {
    id: ScopeId,
    targets: Vec<FocusTarget>,
    /// Where focus was when the scope opened, to restore on close.
    invoker: Option<Invoker>,
}

#[derive(Clone, Copy, Debug)]
struct Invoker {
    id: FocusId,
    /// Its position in the scope below, for the nearest-target fallback.
    index: Option<usize>,
    area: Option<FocusArea>,
}

/// The core's keyboard focus state.
#[derive(Clone, Debug)]
pub struct FocusState {
    /// `scopes[0]` is the root; the last is the top scope, the only one Tab moves in.
    scopes: Vec<Scope>,
    focused: Option<FocusId>,
    composing: bool,
    keyboard_modality: bool,
}

impl Default for FocusState {
    fn default() -> FocusState {
        FocusState::new()
    }
}

impl FocusState {
    /// No focus, the root scope open and empty.
    pub fn new() -> FocusState {
        FocusState {
            scopes: vec![Scope { id: ScopeId::ROOT, targets: Vec::new(), invoker: None }],
            focused: None,
            composing: false,
            keyboard_modality: false,
        }
    }

    fn top(&self) -> &Scope {
        self.scopes.last().expect("the root scope always exists")
    }

    fn find(&self, id: FocusId) -> Option<(usize, &FocusTarget)> {
        self.scopes.iter().enumerate().rev().find_map(|(s, scope)| scope.targets.iter().find(|t| t.id == id).map(|t| (s, t)))
    }

    /// The focused target, as last reported or chosen.
    pub fn focused(&self) -> Option<FocusId> {
        self.focused
    }

    /// The focused target when it is a text field.
    pub fn text_entry(&self) -> Option<FocusId> {
        let id = self.focused?;
        self.find(id).filter(|(_, t)| t.kind == TargetKind::TextEntry).map(|_| id)
    }

    /// Whether an input method has a composition open in the focused text field.
    pub fn composing(&self) -> bool {
        self.composing && self.text_entry().is_some()
    }

    /// Whether the focus ring shows: focus moved by the keyboard last (`:focus-visible`).
    pub fn focus_visible(&self) -> bool {
        self.keyboard_modality
    }

    /// The scope of the top of the stack.
    pub fn top_scope(&self) -> ScopeId {
        self.top().id
    }

    /// Number of open scopes, the root included.
    pub fn depth(&self) -> usize {
        self.scopes.len()
    }

    /// Registers the targets of a scope for this view pass, replacing the previous registration. A focused target that
    /// is gone or disabled loses focus (and any composition): the result is the focus afterwards.
    pub fn register(&mut self, scope: ScopeId, targets: Vec<FocusTarget>) -> Option<FocusId> {
        if let Some(s) = self.scopes.iter_mut().find(|s| s.id == scope) {
            s.targets = targets;
        }
        if let Some(id) = self.focused
            && !self.find(id).is_some_and(|(_, t)| t.focusable())
        {
            self.focused = None;
            self.composing = false;
        }
        self.focused
    }

    /// The toolkit reports what it holds focused: `None` when nothing. Always an `Option`, so removal, disabling,
    /// Escape and replaced panels clear the text-entry state instead of leaving it stale.
    pub fn reconcile(&mut self, reported: Option<FocusId>) {
        let known = reported.filter(|id| self.find(*id).is_some_and(|(_, t)| t.focusable()));
        if known != self.focused {
            self.composing = false;
        }
        self.focused = known;
    }

    /// A pointer press: the ring hides.
    pub fn pointer_pressed(&mut self) {
        self.keyboard_modality = false;
    }

    /// A key that moves or uses focus: the ring shows.
    pub fn key_pressed(&mut self) {
        self.keyboard_modality = true;
    }

    /// An input method composition started (`true`) or ended (commit or close).
    pub fn set_composing(&mut self, composing: bool) {
        self.composing = composing && self.text_entry().is_some();
    }

    /// Tab (`forward`) or Shift+Tab: the next Tab stop of the top scope, wrapping at both edges. Returns the target the
    /// interface must focus, `None` when the scope has no stop.
    pub fn tab(&mut self, forward: bool) -> Option<FocusId> {
        self.keyboard_modality = true;
        let targets = &self.top().targets;
        let position = self.focused.and_then(|id| targets.iter().position(|t| t.id == id));
        let n = targets.len();
        let next = (1..=n)
            .map(|k| match (position, forward) {
                (Some(p), true) => (p + k) % n,
                (Some(p), false) => (p + n - k % n) % n,
                (None, true) => k - 1,
                (None, false) => n - k,
            })
            .find(|&i| targets[i].stops());
        self.move_to(next.map(|i| targets[i].id))
    }

    /// F6 (`forward`) or Ctrl+F6: the first focusable target of the next area present in the top scope, in the order of
    /// [`FocusArea`]. A scope with a single area (a dialog) does nothing.
    pub fn cycle_area(&mut self, forward: bool) -> Option<FocusId> {
        self.keyboard_modality = true;
        let targets = &self.top().targets;
        let mut areas: Vec<FocusArea> = targets.iter().filter(|t| t.focusable()).map(|t| t.area).collect();
        areas.sort_unstable();
        areas.dedup();
        if areas.len() < 2 {
            return None;
        }
        let current = self.focused.and_then(|id| targets.iter().find(|t| t.id == id)).map(|t| t.area);
        let next = match (current.and_then(|c| areas.iter().position(|&a| a == c)), forward) {
            (Some(p), true) => areas[(p + 1) % areas.len()],
            (Some(p), false) => areas[(p + areas.len() - 1) % areas.len()],
            (None, true) => areas[0],
            (None, false) => areas[areas.len() - 1],
        };
        let target = targets.iter().find(|t| t.area == next && t.stops()).or_else(|| targets.iter().find(|t| t.area == next && t.focusable())).map(|t| t.id);
        self.move_to(target)
    }

    /// Programmatic focus of a registered target.
    pub fn focus(&mut self, id: FocusId) -> Option<FocusId> {
        if self.find(id).is_some_and(|(_, t)| t.focusable()) { self.move_to(Some(id)) } else { None }
    }

    fn move_to(&mut self, target: Option<FocusId>) -> Option<FocusId> {
        if target.is_some() && target != self.focused {
            self.composing = false;
            self.focused = target;
        }
        target
    }

    /// Opens a modal scope: records the invoker, chooses the initial target (`initial` if it is focusable, else the
    /// first focusable) and returns it.
    pub fn open_scope(&mut self, scope: ScopeId, targets: Vec<FocusTarget>, initial: Option<FocusId>) -> Option<FocusId> {
        let invoker = self.focused.map(|id| {
            let below = self.top();
            Invoker {
                id,
                index: below.targets.iter().position(|t| t.id == id),
                area: below.targets.iter().find(|t| t.id == id).map(|t| t.area),
            }
        });
        let first = initial
            .filter(|id| targets.iter().any(|t| t.id == *id && t.focusable()))
            .or_else(|| targets.iter().find(|t| t.stops()).or_else(|| targets.iter().find(|t| t.focusable())).map(|t| t.id));
        self.scopes.push(Scope { id: scope, targets, invoker });
        self.composing = false;
        self.focused = first;
        first
    }

    /// Closes the top modal scope (the root never closes) and restores focus: to the invoker when it is still there,
    /// else to the nearest focusable target of the scope below by its old position, else to the first target of the
    /// invoker's area, else nothing. Returns the focus afterwards.
    pub fn close_scope(&mut self) -> Option<FocusId> {
        if self.scopes.len() == 1 {
            return self.focused;
        }
        let closed = self.scopes.pop().expect("checked above");
        let below = self.top();
        let restored = closed.invoker.and_then(|inv| {
            if below.targets.iter().any(|t| t.id == inv.id && t.focusable()) {
                return Some(inv.id);
            }
            let nearest = inv.index.and_then(|old| {
                below
                    .targets
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| t.focusable())
                    .min_by_key(|(i, _)| (i.abs_diff(old), *i))
                    .map(|(_, t)| t.id)
            });
            nearest.or_else(|| inv.area.and_then(|a| below.targets.iter().find(|t| t.area == a && t.focusable()).map(|t| t.id)))
        });
        self.composing = false;
        self.focused = restored;
        restored
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use FocusArea::*;
    use TargetKind::*;

    fn t(id: u64, area: FocusArea, kind: TargetKind) -> FocusTarget {
        FocusTarget::new(id, area, kind)
    }

    fn page() -> FocusState {
        let mut f = FocusState::new();
        f.register(
            ScopeId::ROOT,
            vec![t(1, TopBand, Control), t(2, Tools, Control), t(3, Panels, TextEntry), t(4, Panels, Control), t(5, Timeline, Control)],
        );
        f
    }

    #[test]
    fn tab_walks_the_stops_in_registration_order_and_wraps() {
        let mut f = page();
        let order: Vec<u64> = (0..6).map(|_| f.tab(true).unwrap().0).collect();
        assert_eq!(order, [1, 2, 3, 4, 5, 1]);
        let back: Vec<u64> = (0..3).map(|_| f.tab(false).unwrap().0).collect();
        assert_eq!(back, [5, 4, 3]);
    }

    #[test]
    fn disabled_targets_and_roving_children_are_not_stops() {
        let mut f = FocusState::new();
        let mut disabled = t(2, Panels, Control);
        disabled.enabled = false;
        let mut roving_child = t(3, Panels, Control);
        roving_child.tab_stop = false;
        f.register(ScopeId::ROOT, vec![t(1, Panels, Control), disabled, roving_child, t(4, Panels, Control)]);
        assert_eq!(f.tab(true), Some(FocusId(1)));
        assert_eq!(f.tab(true), Some(FocusId(4)));
        assert_eq!(f.tab(true), Some(FocusId(1)));
        // A roving child can hold focus (arrows put it there); Tab leaves from its position.
        f.reconcile(Some(FocusId(3)));
        assert_eq!(f.tab(true), Some(FocusId(4)));
    }

    #[test]
    fn the_ring_follows_the_last_input_kind() {
        let mut f = page();
        assert!(!f.focus_visible());
        f.tab(true);
        assert!(f.focus_visible());
        f.pointer_pressed();
        assert!(!f.focus_visible());
    }

    #[test]
    fn a_modal_traps_tab_at_both_edges_and_restores_its_invoker() {
        let mut f = page();
        f.reconcile(Some(FocusId(4)));
        let first = f.open_scope(ScopeId(7), vec![t(10, Panels, Control), t(11, Panels, TextEntry), t(12, Panels, Control)], None);
        assert_eq!(first, Some(FocusId(10)));
        // Forward from the last stop wraps to the first, never to the page below; backward from the first goes to the last.
        assert_eq!(f.tab(false), Some(FocusId(12)));
        assert_eq!(f.tab(true), Some(FocusId(10)));
        assert_eq!(f.tab(true), Some(FocusId(11)));
        assert_eq!(f.text_entry(), Some(FocusId(11)));
        assert_eq!(f.close_scope(), Some(FocusId(4)));
        assert_eq!(f.text_entry(), None);
    }

    #[test]
    fn a_requested_initial_target_wins_and_nested_modals_restore_one_level_at_a_time() {
        let mut f = page();
        f.reconcile(Some(FocusId(2)));
        assert_eq!(f.open_scope(ScopeId(1), vec![t(10, Panels, Control), t(11, Panels, TextEntry)], Some(FocusId(11))), Some(FocusId(11)));
        assert_eq!(f.open_scope(ScopeId(2), vec![t(20, Panels, Control)], None), Some(FocusId(20)));
        assert_eq!(f.depth(), 3);
        assert_eq!(f.close_scope(), Some(FocusId(11)), "back to the field of the first modal");
        assert_eq!(f.close_scope(), Some(FocusId(2)), "then to the page");
        assert_eq!(f.close_scope(), Some(FocusId(2)), "the root never closes");
    }

    #[test]
    fn closing_after_the_invoker_is_gone_falls_back_to_the_nearest_target() {
        let mut f = page();
        f.reconcile(Some(FocusId(4)));
        f.open_scope(ScopeId(1), vec![t(10, Panels, Control)], None);
        // While the dialog is open the page below rebuilds without target 4.
        f.register(ScopeId::ROOT, vec![t(1, TopBand, Control), t(2, Tools, Control), t(3, Panels, TextEntry), t(5, Timeline, Control)]);
        assert_eq!(f.close_scope(), Some(FocusId(5)), "index 3 was target 4: now target 5 is at 3, the nearest");
        // And with nothing left in the scope below, focus is simply nowhere.
        let mut g = FocusState::new();
        g.register(ScopeId::ROOT, vec![t(1, Panels, Control)]);
        g.reconcile(Some(FocusId(1)));
        g.open_scope(ScopeId(1), vec![t(10, Panels, Control)], None);
        g.register(ScopeId::ROOT, vec![]);
        assert_eq!(g.close_scope(), None);
        assert_eq!(g.focused(), None);
    }

    #[test]
    fn f6_cycles_the_areas_and_does_nothing_in_a_one_area_modal() {
        let mut f = page();
        let seq: Vec<u64> = (0..6).map(|_| f.cycle_area(true).unwrap().0).collect();
        assert_eq!(seq, [1, 2, 3, 5, 1, 2], "TopBand, Tools, Panels (first stop), Timeline, wrapping");
        assert_eq!(f.cycle_area(false), Some(FocusId(1)));
        assert_eq!(f.cycle_area(false), Some(FocusId(5)));
        f.open_scope(ScopeId(1), vec![t(10, Panels, Control), t(11, Panels, Control)], None);
        assert_eq!(f.cycle_area(true), None);
        assert_eq!(f.focused(), Some(FocusId(10)));
    }

    #[test]
    fn f6_leaves_a_text_field_without_touching_the_text_state_it_reports() {
        let mut f = page();
        f.reconcile(Some(FocusId(3)));
        f.set_composing(false);
        assert_eq!(f.text_entry(), Some(FocusId(3)));
        assert_eq!(f.cycle_area(true), Some(FocusId(5)));
        assert_eq!(f.text_entry(), None);
    }

    #[test]
    fn reconciling_with_nothing_clears_the_text_entry_and_the_composition() {
        let mut f = page();
        f.reconcile(Some(FocusId(3)));
        f.set_composing(true);
        assert!(f.composing());
        f.reconcile(None);
        assert_eq!(f.text_entry(), None);
        assert!(!f.composing());
    }

    #[test]
    fn removing_or_disabling_the_focused_field_clears_it_on_the_next_registration() {
        let mut f = page();
        f.reconcile(Some(FocusId(3)));
        f.set_composing(true);
        // Removed.
        f.register(ScopeId::ROOT, vec![t(1, TopBand, Control), t(4, Panels, Control)]);
        assert_eq!(f.text_entry(), None);
        assert!(!f.composing());
        // Disabled.
        let mut g = page();
        g.reconcile(Some(FocusId(3)));
        let mut off = t(3, Panels, TextEntry);
        off.enabled = false;
        g.register(ScopeId::ROOT, vec![t(1, TopBand, Control), off]);
        assert_eq!(g.focused(), None);
    }

    #[test]
    fn a_report_of_an_unknown_target_is_no_focus() {
        let mut f = page();
        f.reconcile(Some(FocusId(99)));
        assert_eq!(f.focused(), None);
    }

    #[test]
    fn composition_only_exists_in_a_text_field() {
        let mut f = page();
        f.reconcile(Some(FocusId(4)));
        f.set_composing(true);
        assert!(!f.composing(), "a button has no composition");
    }

    #[test]
    fn focusing_a_missing_or_disabled_target_is_refused() {
        let mut f = page();
        assert_eq!(f.focus(FocusId(99)), None);
        assert_eq!(f.focus(FocusId(2)), Some(FocusId(2)));
        assert_eq!(f.focused(), Some(FocusId(2)));
    }
}
