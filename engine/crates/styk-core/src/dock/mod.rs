//! The docked main window: what the views draw and what they send (`docs/native/dockin-views.md`).
//!
//! `styk_core::layout` owns placement: the arrangement, the operations, the solver, the drop zones and the history. This
//! module holds what a window adds to it and no view may decide: which workspace's arrangement shows, the solution for the
//! window's size (with the fold hysteresis carried from one solve to the next), the pointer gesture in progress (a press
//! that becomes a drag past the 4 px slop, a divider held, a keyboard move), the open flyout or sheet, the layout's own
//! undo, and the save queue. The views send [`Event`]s and draw [`Dock::solution`] and [`Dock::drag`]; the runtime owns the
//! one wake (`Dock::deadline`) and the writes (`Dock::take_save`).
//!
//! Nothing here reads a clock: every event is stamped by the host's injected clock.

mod place;
#[cfg(test)]
mod tests;

pub use place::{default_layout, default_timeline_height, keyboard_places, set_timeline, zone_label};

use crate::layout::store::{Entry, ImportResult, LayoutFile, MigrationGeometry, SaveQueue, Stamp, import_v2, state_from_value, state_to_value};
use crate::layout::{DragSession, Env, GroupId, Layout, LayoutError, LayoutState, Node, NodeId, Operation, PanelId, Rect, Size, Solution, Sz, Workspace, Zone, solve, spec};
use styk_doc::Value;

/// The time within which a second press on the same header or divider is a double click (Windows' default).
pub const DOUBLE_CLICK_MS: u64 = 500;

/// How far the pointer travels from a press before it is a drag and not a click (design 3.4; today's 4 px).
pub const SLOP: f64 = 4.0;

/// The workspaces the dock holds an arrangement for, in the order the arrays use.
const WORKSPACES: [(Workspace, &str); 3] = [(Workspace::Animate, "animate"), (Workspace::Draw, "draw"), (Workspace::Rig, "rig")];

fn index_of(workspace: Workspace) -> usize {
    WORKSPACES.iter().position(|(w, _)| *w == workspace).unwrap_or(0)
}

/// What a view says.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// The window's logical size or scale factor changed.
    Resized { width: f64, height: f64, scale: f64 },
    /// A tab was pressed and released on its own (a click): activate it.
    TabSelected { group: GroupId, index: usize },
    /// The primary button went down on a group's header, at this window position: on tab `tab` of the group, or on the
    /// empty header (`None`, the active tab). It becomes a drag when the pointer moves past [`SLOP`].
    HeaderPressed { group: GroupId, tab: Option<usize>, x: f64, y: f64 },
    /// The pointer moved while a press, a drag or a divider is held.
    PointerMoved { x: f64, y: f64 },
    /// The primary button came up.
    PointerReleased,
    /// Shift went down or up (a drop with Shift held floats).
    Shift(bool),
    /// Escape: cancels the gesture in progress, else closes the open flyout or sheet.
    Escape,
    /// The window lost focus: a gesture in progress is cancelled.
    Blur,
    /// A tab was closed (its x, middle click).
    Close(PanelId),
    /// A closed panel was opened again (the Window menu).
    Reopen(PanelId),
    /// A divider was pressed at this window position: a resize begins.
    DividerPressed { split: NodeId, index: usize },
    /// The held divider is this far along its axis from where it was pressed.
    DividerMoved(f64),
    /// The held divider was let go.
    DividerReleased,
    /// An arrow key on a focused divider (`direction` -1 or +1, Shift for the bigger step).
    DividerStep { split: NodeId, index: usize, direction: i32, shift: bool },
    /// Home or Enter on a focused divider, or a double click on a divider: its default size.
    DividerReset { split: NodeId, index: usize },
    /// End on a focused divider: the largest size.
    DividerLargest { split: NodeId, index: usize },
    /// A strip icon (or the band's panel button): open this group's flyout or sheet on that tab.
    Open { group: GroupId, tab: usize },
    /// The flyout's pin: the group stays expanded.
    Pin(GroupId),
    /// Undo the last layout change (the layout's own history, separate from the document's).
    Undo,
    /// Ctrl+Alt+M on this panel: the keyboard move begins.
    MoveByKeyboard(PanelId),
    /// An arrow key in a keyboard move: the next (`1`) or previous (`-1`) place.
    MoveStep(i32),
    /// Enter in a keyboard move.
    MoveCommit,
    /// The workspace changed: its arrangement shows.
    Workspace(Workspace),
    /// The host's wake at [`Dock::deadline`].
    Tick,
}

/// What the dock asks of the host.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// Say this to the person (a refused drop, a layout that did not load).
    Message(String),
    /// Move keyboard focus to this panel (a tab was activated, a flyout closed).
    Focus(PanelId),
}

/// What is being dragged, for the views: the drop overlay and the ghost.
#[derive(Clone, Debug, PartialEq)]
pub struct DragView {
    pub source: PanelId,
    /// The place the pointer is over (`None`: nowhere the panel can go).
    pub zone: Option<Zone>,
    /// The name of the place.
    pub label: &'static str,
    /// The rectangle the panel would take, in window coordinates; `None` for a place that has no rectangle (a float).
    pub preview: Option<Rect>,
    pub pointer: (f64, f64),
}

#[derive(Clone, Debug)]
struct Press {
    panel: PanelId,
    origin: (f64, f64),
}

#[derive(Clone, Debug)]
struct Resize {
    origin: Layout,
    solution: Solution,
    split: NodeId,
    index: usize,
}

#[derive(Clone, Debug)]
struct Move {
    panel: PanelId,
    places: Vec<(Zone, Rect)>,
    at: usize,
}

/// What a press landed on, for the double click.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Target {
    Header(GroupId),
    Divider(NodeId, usize),
}

enum Gesture {
    Idle,
    Pressed(Press),
    Dragging { session: Box<DragSession>, source: PanelId, pointer: (f64, f64) },
    Resizing(Box<Resize>),
    Moving(Move),
}

/// The three arrangements, the solution for the window, the gesture in progress and the save queue.
pub struct Dock {
    states: [LayoutState; 3],
    active: usize,
    window: Size,
    scale: f64,
    solution: Solution,
    open: Option<GroupId>,
    gesture: Gesture,
    /// The last press that may start a double click: what it landed on, when and where.
    last_press: Option<(Target, u64, (f64, f64))>,
    /// A drag began since the last press: the click that follows it activates nothing.
    swallow_click: bool,
    /// The button came up since: the next event that is not that click ends the swallowing.
    swallow_ends: bool,
    shift: bool,
    clock: u64,
    saves: SaveQueue,
    file: LayoutFile,
    writer: String,
    /// The stored file is newer than this program reads: nothing is written over it.
    read_only: bool,
    /// Workspaces the person changed before the stored arrangements arrived: those are theirs, not the file's.
    touched: [bool; 3],
}

impl Dock {
    /// The default arrangements in a window of this size. `writer` names this process in the file's stamps.
    pub fn new(window: Size, scale: f64, writer: impl Into<String>) -> Dock {
        let state = |workspace: Workspace| LayoutState::new(default_layout(workspace, window.h).unwrap_or_else(|_| crate::layout::essentials(workspace)));
        let states = [state(Workspace::Animate), state(Workspace::Draw), state(Workspace::Rig)];
        let mut dock = Dock {
            states,
            active: 0,
            window,
            scale,
            solution: Solution::default(),
            open: None,
            gesture: Gesture::Idle,
            last_press: None,
            swallow_click: false,
            swallow_ends: false,
            shift: false,
            clock: 0,
            saves: SaveQueue::default(),
            file: LayoutFile::default(),
            writer: writer.into(),
            read_only: false,
            touched: [false; 3],
        };
        dock.refit();
        dock
    }

    // ---- What the views read -------------------------------------------------------------------------------------------

    /// The workspace whose arrangement shows.
    pub fn workspace(&self) -> Workspace {
        WORKSPACES[self.active].0
    }

    pub fn layout(&self) -> &Layout {
        &self.states[self.active].current
    }

    /// The solved window: group, header, divider, strip and sheet rectangles in window coordinates.
    pub fn solution(&self) -> &Solution {
        &self.solution
    }

    /// The window's logical size.
    pub fn window(&self) -> Size {
        self.window
    }

    /// The group whose flyout or sheet is open.
    pub fn open(&self) -> Option<GroupId> {
        self.open
    }

    /// Whether the layout differs from the one it began from (the Layout button's dot).
    pub fn modified(&self) -> bool {
        self.states[self.active].dirty
    }

    /// Whether a layout change can be undone.
    pub fn can_undo(&self) -> bool {
        !self.states[self.active].history.is_empty()
    }

    /// Whether the pointer must be followed beyond the widgets that started the gesture (the host subscribes to the cursor
    /// and the button while it is).
    pub fn tracking(&self) -> bool {
        matches!(self.gesture, Gesture::Pressed(_) | Gesture::Dragging { .. })
    }

    /// Whether Escape belongs to the dock: a gesture is in progress, or a flyout or sheet is open.
    pub fn wants_escape(&self) -> bool {
        !matches!(self.gesture, Gesture::Idle) || self.open.is_some()
    }

    /// Whether a keyboard move is in progress (the arrow keys, Enter and Escape are its).
    pub fn moving(&self) -> bool {
        matches!(self.gesture, Gesture::Moving(_))
    }

    /// The panel a focus target stands for: a tab, or a group's body.
    pub fn panel_of(&self, id: crate::focus::FocusId) -> Option<PanelId> {
        let (group, tab) = match ids::group_of(id) {
            Some((group, index)) => (group, Some(index)),
            None => (ids::body_of(id)?, None),
        };
        self.panel_at(group, tab)
    }

    /// Whether a tab or a divider is being moved (the stage is not asked for frames meanwhile).
    pub fn dragging(&self) -> bool {
        matches!(self.gesture, Gesture::Dragging { .. } | Gesture::Resizing(_) | Gesture::Moving(_))
    }

    /// The divider held: its split and index.
    pub fn resizing(&self) -> Option<(NodeId, usize)> {
        match &self.gesture {
            Gesture::Resizing(resize) => Some((resize.split, resize.index)),
            _ => None,
        }
    }

    /// The drag or keyboard move in progress, for the drop overlay.
    pub fn drag(&self) -> Option<DragView> {
        match &self.gesture {
            Gesture::Dragging { session, source, pointer } => {
                let forced = self.shift;
                let zone = if forced { Some(Zone::Float { rect: Rect { x: pointer.0, y: pointer.1, w: 320.0, h: 400.0 } }) } else { session.zone.clone() };
                let label = zone.as_ref().map_or("", zone_label);
                Some(DragView { source: source.clone(), zone, label, preview: if forced { None } else { session.preview }, pointer: *pointer })
            }
            Gesture::Moving(m) => {
                let (zone, rect) = m.places.get(m.at)?;
                Some(DragView { source: m.panel.clone(), zone: Some(zone.clone()), label: zone_label(zone), preview: Some(*rect), pointer: (rect.x + rect.w / 2.0, rect.y + rect.h / 2.0) })
            }
            _ => None,
        }
    }

    /// When the host must wake: the layout save's debounce or retry.
    pub fn deadline(&self) -> Option<u64> {
        if self.read_only { None } else { self.saves.deadline() }
    }

    /// The dividers a person can use: a divider next to a group that is not shown (folded to a strip or a sheet) has nothing
    /// to resize.
    pub fn dividers(&self) -> Vec<&crate::layout::Divider> {
        fn kids_of(node: &Node, split: NodeId) -> Option<&Vec<crate::layout::Kid>> {
            match node {
                Node::Split { id, kids, .. } if *id == split => Some(kids),
                Node::Split { kids, .. } => kids.iter().find_map(|k| kids_of(&k.node, split)),
                Node::Tabs(_) => None,
            }
        }
        let shown = |node: &Node| {
            let mut groups = Vec::new();
            node.groups(&mut groups);
            groups.iter().any(|g| self.solution.groups.contains_key(&g.id))
        };
        self.solution
            .dividers
            .iter()
            .filter(|d| {
                self.layout().main.as_ref().and_then(|root| kids_of(root, d.split)).is_none_or(|kids| kids.get(d.index).is_some_and(|a| shown(&a.node)) && kids.get(d.index + 1).is_some_and(|b| shown(&b.node)))
            })
            .collect()
    }

    /// The panel a pointer press on group `group` at tab `tab` stands for.
    pub fn panel_at(&self, group: GroupId, tab: Option<usize>) -> Option<PanelId> {
        let g = self.layout().groups().into_iter().find(|g| g.id == group)?;
        g.tabs.get(tab.unwrap_or(g.active)).cloned()
    }

    // ---- The host ------------------------------------------------------------------------------------------------------

    /// The stored arrangements arrived (or the first-launch import, or nothing stored).
    pub fn loaded(&mut self, stored: Stored, now: u64) -> Vec<Effect> {
        self.clock = now;
        let mut effects = Vec::new();
        match stored {
            Stored::File(file) => {
                for (i, (workspace, key)) in WORKSPACES.iter().enumerate() {
                    if self.touched[i] {
                        continue;
                    }
                    let Some(entry) = file.workspaces.get(*key) else { continue };
                    match state_from_value(&entry.value, *workspace) {
                        Ok(state) => self.states[i] = state,
                        Err(error) => effects.push(Effect::Message(format!("The saved {key} layout could not be read ({error:?}); the default is shown."))),
                    }
                }
                self.file = file;
            }
            Stored::Legacy(profile) => {
                let geometry = MigrationGeometry { window: self.window, stage: Rect { x: 8.0, y: 60.0, w: self.window.w, h: self.window.h }, client_x: 0.0, client_y: 0.0, scale: 1.0, setup: 0 };
                let ImportResult { user, layouts, warnings } = import_v2(&profile, &geometry);
                let own_timeline = profile.get("shared").and_then(|s| s.get("sizes")).and_then(|s| s.get("bottom")).is_some();
                for (i, (workspace, key)) in WORKSPACES.iter().enumerate() {
                    if self.touched[i] {
                        continue;
                    }
                    if let Some(mut layout) = layouts.get(*key).cloned() {
                        if !own_timeline {
                            set_timeline(&mut layout, default_timeline_height(self.window.h));
                        }
                        if layout.validate(*workspace).is_ok() {
                            self.states[i] = LayoutState::new(layout);
                        }
                    }
                }
                for (n, (name, mode, layout)) in user.into_iter().enumerate() {
                    let workspace = WORKSPACES.iter().find(|(_, key)| *key == mode).map_or(Workspace::Animate, |(w, _)| *w);
                    // A saved layout that cannot be kept is skipped, never the others.
                    let stamp = Stamp { millis: now, writer: self.writer.clone() };
                    if let Err(error) = self.file.save_user(&format!("imported-{n}"), &name, &[workspace], &layout, stamp) {
                        effects.push(Effect::Message(format!("The saved layout \"{name}\" was not imported ({error:?}).")));
                    }
                }
                if !warnings.is_empty() {
                    effects.push(Effect::Message(format!("Some panels of your earlier layout were put back at their usual places ({}).", warnings.len())));
                }
                for i in 0..3 {
                    self.changed(i);
                }
            }
            Stored::Nothing => {}
            Stored::Newer => {
                self.read_only = true;
                effects.push(Effect::Message("Your saved layouts are from a newer version; they are left as they are.".into()));
            }
            Stored::Unreadable(why) => effects.push(Effect::Message(format!("Your saved layouts could not be read ({why}); the defaults are shown."))),
        }
        self.refit();
        effects
    }

    /// The next write due at `now`: the file to merge into the stored one (never the interface thread's to write).
    pub fn take_save(&mut self, now: u64) -> Option<LayoutFile> {
        if self.read_only {
            return None;
        }
        let bytes = self.saves.take_due(now)?;
        match LayoutFile::decode(&bytes) {
            Ok(file) => Some(file),
            Err(_) => {
                // Bytes this queue made itself always decode; release the slot rather than wedge the queue.
                self.saves.complete(true, now);
                None
            }
        }
    }

    /// The write handed out by [`Dock::take_save`] ended.
    pub fn save_done(&mut self, success: bool, now: u64) {
        self.clock = now;
        self.saves.complete(success, now);
    }

    // ---- Events --------------------------------------------------------------------------------------------------------

    pub fn handle(&mut self, event: Event, now: u64) -> Vec<Effect> {
        self.clock = now;
        if self.swallow_ends && !matches!(event, Event::TabSelected { .. } | Event::PointerReleased) {
            self.swallow_click = false;
            self.swallow_ends = false;
        }
        let mut effects = Vec::new();
        match event {
            Event::Resized { width, height, scale } => {
                if width.is_finite() && height.is_finite() && scale.is_finite() && scale > 0.0 {
                    self.window = Size { w: width, h: height };
                    self.scale = scale;
                    self.refit();
                }
            }
            Event::Workspace(workspace) => {
                self.cancel_gesture();
                self.open = None;
                self.active = index_of(workspace);
                self.refit();
            }
            Event::TabSelected { group, index } => {
                if !std::mem::take(&mut self.swallow_click) {
                    self.edit(Operation::Activate(group, index), &mut effects);
                    if let Some(panel) = self.panel_at(group, Some(index)) {
                        effects.push(Effect::Focus(panel));
                    }
                }
            }
            Event::HeaderPressed { group, tab, x, y } => {
                self.swallow_click = false;
                self.cancel_gesture();
                if self.double_click(Target::Header(group), (x, y), now) {
                    // A second press on the same header within the double-click time: collapse or expand the group, and the
                    // click that follows it activates nothing.
                    self.swallow_click = true;
                    let collapsed = self.layout().groups().into_iter().find(|g| g.id == group).is_some_and(|g| g.collapsed);
                    self.edit(Operation::Collapse(group, !collapsed), &mut effects);
                } else if let Some(panel) = self.panel_at(group, tab) {
                    self.gesture = Gesture::Pressed(Press { panel, origin: (x, y) });
                }
            }
            Event::PointerMoved { x, y } => self.pointer_moved(x, y),
            Event::PointerReleased => self.pointer_released(&mut effects),
            Event::Shift(on) => self.shift = on,
            Event::Escape => {
                if matches!(self.gesture, Gesture::Idle) {
                    if let Some(group) = self.open.take() {
                        self.refit();
                        if let Some(panel) = self.panel_at(group, None) {
                            effects.push(Effect::Focus(panel));
                        }
                    }
                } else {
                    self.cancel_gesture();
                }
            }
            Event::Blur => {
                self.cancel_gesture();
                self.shift = false;
            }
            Event::Close(panel) => self.edit(Operation::Close(panel), &mut effects),
            Event::Reopen(panel) => self.edit(Operation::Reopen(panel), &mut effects),
            Event::DividerPressed { split, index } => {
                self.cancel_gesture();
                if self.double_click(Target::Divider(split, index), (0.0, 0.0), now) {
                    self.reset_divider(split, index, &mut effects);
                } else {
                    self.gesture = Gesture::Resizing(Box::new(Resize { origin: self.layout().clone(), solution: self.solution.clone(), split, index }));
                }
            }
            Event::DividerMoved(delta) => self.divider_moved(delta),
            Event::DividerReleased => {
                if let Gesture::Resizing(resize) = std::mem::replace(&mut self.gesture, Gesture::Idle) {
                    self.finish(resize.origin);
                }
            }
            Event::DividerStep { split, index, direction, shift } => {
                let step = if shift { 40.0 } else { 12.0 } * f64::from(direction.signum());
                self.step_divider(split, index, step, &mut effects);
            }
            Event::DividerLargest { split, index } => self.step_divider(split, index, f64::INFINITY, &mut effects),
            Event::DividerReset { split, index } => self.reset_divider(split, index, &mut effects),
            Event::Open { group, tab } => {
                self.open = Some(group);
                self.edit(Operation::Activate(group, tab), &mut effects);
                self.refit();
                if let Some(panel) = self.panel_at(group, Some(tab)) {
                    effects.push(Effect::Focus(panel));
                }
            }
            Event::Pin(group) => {
                self.open = None;
                self.edit(Operation::Collapse(group, false), &mut effects);
            }
            Event::Undo => {
                self.cancel_gesture();
                if self.states[self.active].undo() {
                    self.changed(self.active);
                    self.refit();
                } else {
                    effects.push(Effect::Message("There is no layout change to undo.".into()));
                }
            }
            Event::MoveByKeyboard(panel) => {
                self.cancel_gesture();
                let places = keyboard_places(self.layout(), &panel, &self.env(), self.workspace());
                if places.is_empty() {
                    effects.push(Effect::Message("This panel stays where it is.".into()));
                } else {
                    self.gesture = Gesture::Moving(Move { panel, places, at: 0 });
                }
            }
            Event::MoveStep(by) => {
                if let Gesture::Moving(m) = &mut self.gesture {
                    let n = m.places.len() as i64;
                    m.at = (m.at as i64 + i64::from(by.signum())).rem_euclid(n.max(1)) as usize;
                }
            }
            Event::MoveCommit => {
                if let Gesture::Moving(m) = std::mem::replace(&mut self.gesture, Gesture::Idle)
                    && let Some((zone, _)) = m.places.get(m.at)
                {
                    self.edit(Operation::Move(m.panel, zone.clone()), &mut effects);
                }
            }
            Event::Tick => {}
        }
        effects
    }

    /// Whether this press is the second of a double click on `target`; remembers it otherwise.
    fn double_click(&mut self, target: Target, at: (f64, f64), now: u64) -> bool {
        let double = matches!(self.last_press, Some((t, then, from)) if t == target && now.saturating_sub(then) <= DOUBLE_CLICK_MS && (at.0 - from.0).hypot(at.1 - from.1) < SLOP);
        self.last_press = if double { None } else { Some((target, now, at)) };
        double
    }

    fn env(&self) -> Env {
        let mut env = Env::new(self.window.w, self.window.h);
        env.scale = self.scale;
        env.previous = self.solution.fit.clone();
        env.open = self.open;
        env
    }

    /// Solves the window again, carrying the folds so the hysteresis holds.
    fn refit(&mut self) {
        let env = self.env();
        self.solution = solve(self.layout(), &env);
        // A flyout belongs to a group that is still folded or collapsed.
        if let Some(open) = self.open
            && !self.solution.fit.folded.contains_key(&open)
        {
            self.open = None;
            self.solution = solve(self.layout(), &self.env());
        }
    }

    /// Applies an operation to a copy, keeps it in the layout's history and queues the save; a refusal changes nothing.
    fn edit(&mut self, operation: Operation, effects: &mut Vec<Effect>) {
        let workspace = self.workspace();
        let mut next = self.layout().clone();
        match next.apply(operation, workspace) {
            Ok(_) => self.commit(next, effects),
            Err(error) => effects.push(Effect::Message(refusal(&error))),
        }
    }

    fn commit(&mut self, next: Layout, effects: &mut Vec<Effect>) {
        let workspace = self.workspace();
        match self.states[self.active].commit(next, workspace) {
            Ok(()) => {
                self.changed(self.active);
                self.refit();
            }
            Err(error) => effects.push(Effect::Message(refusal(&error))),
        }
    }

    /// A workspace's arrangement changed: its entry in the file is newer, and the write is queued.
    fn changed(&mut self, index: usize) {
        self.touched[index] = true;
        if self.read_only {
            return;
        }
        let (_, key) = WORKSPACES[index];
        let value = state_to_value(&self.states[index]);
        let stamp = Stamp { millis: self.clock, writer: self.writer.clone() };
        self.file.workspaces.insert(key.to_string(), Entry { stamp, value });
        // A file over the size limit is not saved; the arrangement stays in memory.
        if let Ok(bytes) = self.file.encode() {
            let _ = self.saves.changed(self.clock, bytes);
        }
    }

    fn cancel_gesture(&mut self) {
        match std::mem::replace(&mut self.gesture, Gesture::Idle) {
            Gesture::Resizing(resize) => {
                // The live layout followed the pointer; the origin is what it was.
                self.states[self.active].current = resize.origin;
                self.states[self.active].dirty = self.states[self.active].current != self.states[self.active].base;
                self.refit();
            }
            Gesture::Dragging { session, .. } => session.cancel(),
            Gesture::Pressed(_) | Gesture::Moving(_) | Gesture::Idle => {}
        }
    }

    fn pointer_moved(&mut self, x: f64, y: f64) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        let workspace = self.workspace();
        let env = self.env();
        match &mut self.gesture {
            Gesture::Pressed(press) => {
                let (dx, dy) = (x - press.origin.0, y - press.origin.1);
                if dx.hypot(dy) < SLOP {
                    return;
                }
                let source = press.panel.clone();
                self.swallow_click = true;
                // A press that became a drag was not a click: it starts no double click.
                self.last_press = None;
                match DragSession::new(&self.states[self.active].current, source.clone()) {
                    Ok(mut session) => {
                        // A place the pointer cannot take leaves the session without a zone: the drop does nothing.
                        let _ = session.moved(&env, x, y, workspace);
                        self.gesture = Gesture::Dragging { session: Box::new(session), source, pointer: (x, y) };
                    }
                    Err(_) => self.gesture = Gesture::Idle,
                }
            }
            Gesture::Dragging { session, pointer, .. } => {
                *pointer = (x, y);
                let _ = session.moved(&env, x, y, workspace);
            }
            _ => {}
        }
    }

    fn pointer_released(&mut self, effects: &mut Vec<Effect>) {
        let workspace = self.workspace();
        self.swallow_ends = self.swallow_click;
        match std::mem::replace(&mut self.gesture, Gesture::Idle) {
            Gesture::Dragging { session, pointer, .. } => {
                let zone = if self.shift { Some(Zone::Float { rect: Rect { x: pointer.0, y: pointer.1, w: 320.0, h: 400.0 } }) } else { session.zone.clone() };
                match zone {
                    None => session.cancel(),
                    Some(Zone::Float { .. }) => {
                        session.cancel();
                        effects.push(Effect::Message("Floating panels are not available yet: the panel stayed where it was.".into()));
                    }
                    Some(_) => {
                        let mut next = self.layout().clone();
                        match session.release(&mut next, workspace) {
                            Ok(_) => self.commit(next, effects),
                            Err(error) => effects.push(Effect::Message(refusal(&error))),
                        }
                    }
                }
            }
            Gesture::Resizing(resize) => self.finish(resize.origin),
            Gesture::Pressed(_) | Gesture::Moving(_) | Gesture::Idle => {}
        }
    }

    fn divider_moved(&mut self, delta: f64) {
        let workspace = self.workspace();
        let Gesture::Resizing(resize) = &self.gesture else { return };
        self.last_press = None;
        let mut next = resize.origin.clone();
        if next.resize_divider(&resize.solution, resize.split, resize.index, delta, workspace).is_ok() {
            let state = &mut self.states[self.active];
            state.current = next;
            state.dirty = state.current != state.base;
            self.refit();
        }
    }

    /// A held divider ended with the layout it made: one history entry for the whole drag.
    fn finish(&mut self, origin: Layout) {
        let state = &mut self.states[self.active];
        if state.current != origin {
            state.history.push_back(origin);
            while state.history.len() > 20 {
                state.history.pop_front();
            }
            state.dirty = state.current != state.base;
            self.changed(self.active);
        }
    }

    fn step_divider(&mut self, split: NodeId, index: usize, step: f64, effects: &mut Vec<Effect>) {
        let workspace = self.workspace();
        let mut next = self.layout().clone();
        let delta = if step.is_infinite() {
            let Some(d) = self.solution.dividers.iter().find(|d| d.split == split && d.index == index) else { return };
            d.max - d.now
        } else {
            step
        };
        match next.resize_divider(&self.solution, split, index, delta, workspace) {
            Ok(_) => self.commit(next, effects),
            Err(error) => effects.push(Effect::Message(refusal(&error))),
        }
    }

    /// A divider's default: each allocated side takes today's size for its panels (the timeline its default height, the
    /// others their preferred size along the axis), a flexible side an equal weight.
    fn reset_divider(&mut self, split: NodeId, index: usize, effects: &mut Vec<Effect>) {
        let workspace = self.workspace();
        let height = self.window.h;
        let mut next = self.layout().clone();
        if let Err(error) = next.apply(Operation::ResetDivider { split, index }, workspace) {
            effects.push(Effect::Message(refusal(&error)));
            return;
        }
        fn fix(node: &mut Node, split: NodeId, index: usize, height: f64) {
            if let Node::Split { id, axis, kids } = node {
                if *id == split {
                    for kid in kids.iter_mut().skip(index).take(2) {
                        if let Sz::Px(_) = kid.size {
                            let mut groups = Vec::new();
                            kid.node.groups(&mut groups);
                            let size = if groups.iter().any(|g| g.tabs.iter().any(|p| p.kind == "timeline")) && *axis == crate::layout::Axis::Vertical {
                                default_timeline_height(height)
                            } else {
                                groups.iter().flat_map(|g| g.tabs.iter()).filter_map(|p| spec(&p.kind)).map(|s| if *axis == crate::layout::Axis::Horizontal { s.pref.w } else { s.pref.h }).fold(0.0, f64::max)
                            };
                            if size > 0.0 {
                                kid.size = Sz::Px(size);
                            }
                        }
                    }
                } else {
                    for kid in kids {
                        fix(&mut kid.node, split, index, height);
                    }
                }
            }
        }
        if let Some(root) = &mut next.main {
            fix(root, split, index, height);
        }
        self.commit(next, effects);
    }
}

/// What the stored layout answered.
#[derive(Clone, Debug)]
pub enum Stored {
    /// The stored file.
    File(LayoutFile),
    /// No stored file, and today's `workspace-preferences.json` (parsed): the first launch imports it.
    Legacy(Value),
    /// No stored file and nothing to import: the defaults stand and nothing is written.
    Nothing,
    /// The stored file is from a newer version: it is read-only.
    Newer,
    /// The stored file could not be read.
    Unreadable(String),
}

fn refusal(error: &LayoutError) -> String {
    match error {
        LayoutError::LastStage => "The last stage stays open.".into(),
        LayoutError::InvalidTarget => "The panel cannot go there.".into(),
        LayoutError::Limit => "That layout is too large.".into(),
        other => format!("The layout was not changed ({other:?})."),
    }
}

/// The panels' focus identities: one group's tab strip, one group's body, one divider, one strip icon.
pub mod ids {
    use crate::focus::FocusId;
    use crate::layout::GroupId;

    const BASE: u64 = 1 << 42;

    /// Tab `index` of group `group` (`Tabs` takes consecutive ids from `first`).
    pub fn tab(group: GroupId, index: usize) -> FocusId {
        FocusId(BASE + u64::from(group) * 64 + index as u64)
    }

    /// The first tab's id of a group.
    pub fn tabs(group: GroupId) -> FocusId {
        tab(group, 0)
    }

    /// A group's body, the target F6 lands on in a group that has no tab strip.
    pub fn body(group: GroupId) -> FocusId {
        FocusId(BASE + 0x80_0000 + u64::from(group))
    }

    /// The group a body id belongs to.
    pub fn body_of(id: FocusId) -> Option<GroupId> {
        let raw = id.0.checked_sub(BASE + 0x80_0000)?;
        (raw < 0x80_0000).then_some(raw as GroupId)
    }

    /// A divider.
    pub fn divider(split: u32, index: usize) -> FocusId {
        FocusId(BASE + 0x100_0000 + u64::from(split) * 64 + index as u64)
    }

    /// A strip's icon for tab `index`.
    pub fn strip(group: GroupId, index: usize) -> FocusId {
        FocusId(BASE + 0x180_0000 + u64::from(group) * 64 + index as u64)
    }

    /// The group a tab id belongs to, with its index.
    pub fn group_of(id: FocusId) -> Option<(GroupId, usize)> {
        let raw = id.0.checked_sub(BASE)?;
        (raw < 0x80_0000).then(|| ((raw / 64) as GroupId, (raw % 64) as usize))
    }
}

impl Dock {
    /// The title words key of a panel (the catalogue's `shell.panel.*`), or its plain name.
    pub fn title_key(kind: &str) -> Option<&'static str> {
        match kind {
            "properties" => Some("shell.panel.properties"),
            "vfx" => Some("shell.panel.vfx"),
            "library" => Some("shell.panel.library"),
            "structure" => Some("shell.panel.structure"),
            "timeline" => Some("shell.panel.timeline"),
            _ => None,
        }
    }

    /// Which F6 area a panel's group belongs to.
    pub fn area_of(panel: &PanelId) -> crate::focus::FocusArea {
        use crate::focus::FocusArea;
        match panel.kind.as_str() {
            "stage" => FocusArea::Stage,
            "timeline" | "layers" => FocusArea::Timeline,
            "tools" => FocusArea::Tools,
            _ => FocusArea::Panels,
        }
    }
}
