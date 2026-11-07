//! The top band: what shows, in which place, and what folds as the window narrows.
//!
//! This is `src/styles/layout/topbar.css`, `features/band.css`, `components/project-tabs.css`, `src/shell/topbar.mjs`
//! (`measureBand`, `collectBandWidths`) and the band part of `layout-solver.mjs` (`foldBand`, `resolveTiers`) as one
//! pure function of the window's width, the open projects, the session and the width of the band's few words.
//!
//! The band is a grid of three clusters: where (the mark, Home and the project tabs), how (the workspace switch) and
//! what next (history, Save, Export or a session's buttons, and the window controls). The first takes the room the
//! others leave; none takes less than its content. As the window narrows the band applies the fewest fold steps whose
//! measured width fits ([`FOLDS`], in today's order): spacing, then the tabs' reserve, then words and buttons, and the
//! primary's word last. A step that frees nothing in the current session is skipped, as `collectBandWidths` skips it.
//!
//! [`solve`] gives every item its frame in logical pixels. The interface places the items exactly there, and the window
//! asks [`Layout::no_drag`] for the places that must keep the pointer (everything but the empty band).

use super::session::{Done, ExportLook, Session};
use super::workspace::Workspace;
use crate::documents::DocumentId;

/// The band's measured width must fit the window with this much to spare (`SHELL_METRICS.bandMargin`).
pub const FIT_MARGIN: f32 = 24.0;

/// A window shorter than this has the compact chrome and a 44 px band (`chromeFor`, `SHELL_METRICS.chrome.roomy`).
pub const COMPACT_BELOW: f32 = 801.0;

/// The window width up to which the dock folds the Properties panel into a sheet and the band shows its button
/// (`TIER_THRESHOLDS.width.compact`).
pub const SHEET_UP_TO: f32 = 800.0;

/// A project tab at its widest (`.project-tab` `flex: 0 4 184px`) and the one in front (`flex: 0 1 172px`).
const TAB_REST: f32 = 184.0;
const TAB_FRONT: f32 = 172.0;
/// How much faster resting tabs shrink than the one in front.
const TAB_REST_SHRINK: f32 = 4.0;
/// The tab list asks for this much per tab (`flex: 0 1 calc(var(--project-tabs) * 186px)`).
const TAB_SLOT: f32 = 186.0;
/// The tab strip's reserve (`min-inline-size`): normal, at the `name` step and at the `dot` step.
const STRIP_MIN: f32 = 148.0;
const STRIP_MIN_NAME: f32 = 120.0;
const STRIP_MIN_DOT: f32 = 36.0;
/// The least a resting tab and the one in front keep (`min-inline-size`; the front's drops to 36 at the `dot` step).
const TAB_REST_MIN: f32 = 36.0;
const TAB_FRONT_MIN: f32 = 84.0;
/// A tab's padding (`0 space-1 0 space-2`, inline-end first in the CSS).
const TAB_PAD_START: f32 = 8.0;
const TAB_PAD_END: f32 = 4.0;
/// A tab's content narrower than these drops Close and the name (`@container`).
const TAB_NO_CLOSE: f32 = 124.0;
const TAB_NO_NAME: f32 = 72.0;
/// The mark's picture and chevron, and a button's glyph (`band.css`: `--icon-size: 15px`), the workspace glyph.
const MARK_PICTURE: f32 = 22.0;
const MARK_CHEVRON: f32 = 12.0;
const BUTTON_GLYPH: f32 = 15.0;
const WORKSPACE_GLYPH: f32 = 17.0;
const WORKSPACE_DOT: f32 = 7.0;
/// The switch's track padding.
const TRACK_PAD: f32 = 3.0;
/// A button's border, each side (`.ui-button`), and its horizontal padding in the band (`--_px`).
const BUTTON_BORDER: f32 = 1.0;
const PRIMARY_PAD: f32 = 16.0;
const QUIET_PAD: f32 = 14.0;
/// A segment's horizontal padding: start and end by step.
const SEGMENT_START: f32 = 12.0;
const SEGMENT_END: f32 = 16.0;
/// Window controls: 44 wide, 36 at the `winctl` step.
const CONTROL: f32 = 44.0;
const CONTROL_FOLDED: f32 = 36.0;

/// A rectangle in logical pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Frame {
    /// Left edge.
    pub x: f32,
    /// Top edge.
    pub y: f32,
    /// Width.
    pub width: f32,
    /// Height.
    pub height: f32,
}

impl Frame {
    /// A frame from its edges' origin and size.
    pub const fn new(x: f32, y: f32, width: f32, height: f32) -> Frame {
        Frame { x, y, width, height }
    }

    /// The right edge.
    pub fn right(&self) -> f32 {
        self.x + self.width
    }

    /// Whether a point is inside.
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.y + self.height
    }
}

/// The band's fold steps, in the order it applies them (`BAND_FOLDS`). Three of today's steps are not here:
/// `state`, `name8` and `savelabel` free nothing now, and the measurement skips them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Fold {
    /// Spacing tightens.
    Tight,
    /// The tabs' reserve narrows from 148 to 120.
    Name,
    /// Build's Test rig shows only its glyph.
    TestRig,
    /// Save folds into File.
    Save,
    /// The window controls narrow from 44 to 36.
    WinCtl,
    /// A session's quiet Export shows only its glyph.
    Export2,
    /// The workspace switch drops its dots and some padding.
    SwitchTight,
    /// The workspace switch shows its three glyphs.
    Icons,
    /// Only the project in front keeps its tab, as its picture.
    Dot,
    /// Redo folds into Edit.
    Redo,
    /// A session's Export folds into File.
    Export2Out,
    /// The primary's word (Export at rest, a session's Done), last of all.
    Primary,
}

/// Every step in the order the band folds.
pub const FOLDS: [Fold; 12] = [Fold::Tight, Fold::Name, Fold::TestRig, Fold::Save, Fold::WinCtl, Fold::Export2, Fold::SwitchTight, Fold::Icons, Fold::Dot, Fold::Redo, Fold::Export2Out, Fold::Primary];

/// The design tokens the band's layout reads, in logical pixels. The interface builds it from `styk_design::tokens`
/// (`styk_ui::shell::metrics`), so a changed token moves the band; [`Metrics::TODAY`] is the same numbers for tests.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Metrics {
    /// `--space-0-5`.
    pub space_0_5: f32,
    /// `--space-1`.
    pub space_1: f32,
    /// `--space-1-5`.
    pub space_1_5: f32,
    /// `--space-2`.
    pub space_2: f32,
    /// `--space-2-5`.
    pub space_2_5: f32,
    /// `--space-3`.
    pub space_3: f32,
    /// `--control-sm`.
    pub control_sm: f32,
    /// `--control-md`.
    pub control_md: f32,
    /// `--control-lg`.
    pub control_lg: f32,
}

impl Metrics {
    /// The tokens as `tokens.css` has them.
    pub const TODAY: Metrics = Metrics { space_0_5: 2.0, space_1: 4.0, space_1_5: 6.0, space_2: 8.0, space_2_5: 10.0, space_3: 12.0, control_sm: 28.0, control_md: 32.0, control_lg: 36.0 };
}

/// How wide the band's words are set, in logical pixels (13 px Inter 600 for the workspace names, Inter Tight 650 for
/// the buttons). The interface measures them with the font system; they change with the language.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Labels {
    /// "Animate".
    pub animate: f32,
    /// "Draw".
    pub draw: f32,
    /// "Build".
    pub build: f32,
    /// "Export".
    pub export: f32,
    /// "Cancel".
    pub cancel: f32,
    /// "Test rig".
    pub test_rig: f32,
    /// "Done".
    pub done: f32,
}

impl Labels {
    fn workspace(&self, workspace: Workspace) -> f32 {
        match workspace {
            Workspace::Animate => self.animate,
            Workspace::Draw => self.draw,
            Workspace::Build => self.build,
        }
    }
}

/// What a tab strip needs to know of one open project.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TabFacts {
    /// The project.
    pub id: DocumentId,
    /// It is in front.
    pub front: bool,
    /// It has a state to show (unsaved changes, saving, a save just landed): its dot.
    pub marked: bool,
}

/// What the band is laid out from.
#[derive(Clone, Debug)]
pub struct Input<'a> {
    /// The window's width and height in logical pixels.
    pub width: f32,
    /// The window's height (under [`COMPACT_BELOW`] the chrome is compact).
    pub height: f32,
    /// The interface scale (`--ui-scale`).
    pub ui_scale: f32,
    /// The open projects in the strip's order.
    pub tabs: &'a [TabFacts],
    /// The session, if any.
    pub session: Session,
    /// The band shows its own window controls (not on macOS).
    pub window_controls: bool,
    /// The Properties sheet button shows (the dock folded Properties into a sheet).
    pub properties: bool,
    /// The tokens.
    pub metrics: Metrics,
    /// The words' widths.
    pub labels: Labels,
}

/// Which parts of a tab show, from its width (`@container` rules of `project-tabs.css`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TabLook {
    /// The name.
    pub name: bool,
    /// The Close button.
    pub close: bool,
    /// The state slot: full width (24), narrow (9) or none.
    pub end: TabEnd,
}

/// The state slot at a tab's end.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabEnd {
    /// 24 px: the dot, replaced by Close under the pointer.
    Full,
    /// 9 px: only the dot.
    Narrow,
    /// Nothing: a narrow tab with nothing to say.
    Gone,
}

/// Something the band places.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Item {
    /// The StykAnimate mark, which opens the main menu.
    Mark,
    /// Home.
    Home,
    /// An open project's tab.
    Tab(DocumentId, TabLook),
    /// New animation, after the last tab.
    AddTab,
    /// One of the workspace switch's three segments.
    Workspace(Workspace),
    /// Undo.
    Undo,
    /// Redo.
    Redo,
    /// Save.
    Save,
    /// The Properties sheet button.
    Properties,
    /// Export.
    Export(ExportLook, ButtonShape),
    /// A movieclip's Cancel.
    Cancel,
    /// Build's Test rig.
    TestRig(ButtonShape),
    /// A session's Done.
    Done(Done, ButtonShape),
    /// Minimize.
    Minimize,
    /// Maximize or restore.
    Maximize,
    /// Close.
    Close,
}

/// A button with a word that folds to its glyph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonShape {
    /// Glyph and word.
    Word,
    /// The glyph in a 36 px square.
    Glyph,
}

/// A placed item.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placed {
    /// What.
    pub item: Item,
    /// Where, in logical pixels from the window's top left.
    pub frame: Frame,
}

/// The band, solved.
#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    /// The band's height (`--topbar-h`).
    pub height: f32,
    /// The fold steps in force, in order.
    pub folds: Vec<Fold>,
    /// Every item in reading order, left to right.
    pub items: Vec<Placed>,
    /// The workspace switch's track (the pill the segments sit in).
    pub track: Frame,
    /// The tab strip: the tab list and New.
    pub strip: Frame,
    /// The narrowest the band can be with the steps in force, and with all of them (what the window cannot go under).
    pub min_width: f32,
    /// The segments' content: dots and words, or glyphs at the `icons` step.
    pub segments: SegmentContent,
    /// The cluster gaps and the padding, for the interface to draw from.
    pub pad_start: f32,
}

/// What a workspace segment shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SegmentContent {
    /// A dot and the name.
    DotAndName,
    /// The name only (`switchtight`).
    Name,
    /// The glyph only (`icons`).
    Glyph,
}

impl Layout {
    /// A placed item by a test on it.
    pub fn find(&self, matches: impl Fn(&Item) -> bool) -> Option<Frame> {
        self.items.iter().find(|placed| matches(&placed.item)).map(|placed| placed.frame)
    }

    /// The tab under a point, with whether the point is on its far half.
    pub fn tab_at(&self, x: f32) -> Option<(DocumentId, bool)> {
        self.items.iter().find_map(|placed| match placed.item {
            Item::Tab(id, _) if x >= placed.frame.x && x < placed.frame.right() => Some((id, x >= placed.frame.x + placed.frame.width / 2.0)),
            _ => None,
        })
    }

    /// The tabs in the strip's order with their frames.
    pub fn tabs(&self) -> impl Iterator<Item = (DocumentId, TabLook, Frame)> + '_ {
        self.items.iter().filter_map(|placed| match placed.item {
            Item::Tab(id, look) => Some((id, look, placed.frame)),
            _ => None,
        })
    }

    /// The places that keep the pointer, where the rest of the band drags the window (`-webkit-app-region: no-drag` on
    /// buttons, navs, toolbars and groups, and the tabs): everything interactive but the window controls.
    pub fn no_drag(&self) -> Vec<Frame> {
        let history = self.items.iter().filter(|p| matches!(p.item, Item::Undo | Item::Redo)).map(|p| p.frame);
        let history = history.fold(None::<Frame>, |sum, frame| Some(sum.map_or(frame, |sum| Frame::new(sum.x, sum.y, frame.right() - sum.x, sum.height))));
        let workspace = self.items.iter().any(|p| matches!(p.item, Item::Workspace(_))).then_some(self.track);
        self.items
            .iter()
            .filter(|p| !matches!(p.item, Item::Minimize | Item::Maximize | Item::Close | Item::Workspace(_) | Item::Undo | Item::Redo))
            .map(|p| p.frame)
            .chain(history)
            .chain(workspace)
            .collect()
    }
}

/// The band's height in logical pixels for the window (`--topbar-h` with the chrome's compactness).
pub fn height(window_height: f32, ui_scale: f32) -> f32 {
    styk_services::shell::chrome::band_height(ui_scale, window_height < COMPACT_BELOW)
}

/// The fold steps that fit the window: the fewest whose measured width, with the margin, fits (`foldBand`). Where
/// none does, every step that frees something.
pub fn folds_for(input: &Input<'_>) -> Vec<Fold> {
    let (none, rows) = fold_widths(input);
    if none + FIT_MARGIN <= input.width {
        return Vec::new();
    }
    let mut chosen = Vec::new();
    for (step, after) in rows {
        chosen.push(step);
        if after + FIT_MARGIN <= input.width {
            return chosen;
        }
    }
    chosen
}

/// The band's measured width unfolded, then after each step that makes it narrower (`collectBandWidths`).
fn fold_widths(input: &Input<'_>) -> (f32, Vec<(Fold, f32)>) {
    let mut applied: Vec<Fold> = Vec::new();
    let none = measured(input, &applied);
    let mut last = none;
    let mut widths = Vec::new();
    for step in FOLDS {
        applied.push(step);
        let after = measured(input, &applied);
        if after < last {
            widths.push((step, after));
            last = after;
        } else {
            applied.pop();
        }
    }
    (none, widths)
}

/// `Math.ceil` of the band's min-content width, as `measureBand` reads it.
fn measured(input: &Input<'_>, applied: &[Fold]) -> f32 {
    Parts::of(input, applied).min_width().ceil()
}

/// The widths the band's parts take under a set of steps.
struct Parts<'a> {
    input: &'a Input<'a>,
    has: Vec<Fold>,
    column_gap: f32,
    pad_start: f32,
    pad_end: f32,
    cluster_gap: f32,
    end_gap: f32,
}

impl<'a> Parts<'a> {
    fn of(input: &'a Input<'a>, applied: &[Fold]) -> Parts<'a> {
        let m = input.metrics;
        let has = applied.to_vec();
        let on = |step| has.contains(&step);
        Parts {
            input,
            column_gap: if on(Fold::Icons) { m.space_1 } else if on(Fold::Tight) { m.space_2 } else { m.space_3 },
            pad_start: if on(Fold::Icons) { m.space_1 } else { m.space_2 },
            pad_end: m.space_2,
            cluster_gap: if on(Fold::Tight) { m.space_0_5 } else { m.space_1 },
            end_gap: if on(Fold::Icons) { m.space_0_5 } else if on(Fold::Tight) { m.space_1 } else { m.space_2 },
            has,
        }
    }

    fn on(&self, step: Fold) -> bool {
        self.has.contains(&step)
    }

    fn mark(&self) -> f32 {
        let m = self.input.metrics;
        let (start, end) = if self.on(Fold::Icons) { (m.space_1, m.space_0_5) } else { (m.space_1_5, m.space_1) };
        start + MARK_PICTURE + m.space_0_5 + MARK_CHEVRON + end
    }

    fn home(&self) -> f32 {
        self.input.metrics.control_md
    }

    /// The strip's margin before it and the least it takes.
    fn strip_margin(&self) -> f32 {
        if self.on(Fold::Dot) { 0.0 } else { self.input.metrics.space_1 }
    }

    fn strip_min(&self) -> f32 {
        if self.on(Fold::Dot) {
            STRIP_MIN_DOT
        } else if self.on(Fold::Name) {
            STRIP_MIN_NAME
        } else {
            STRIP_MIN
        }
    }

    /// What the start cluster takes before the strip.
    fn start_before_strip(&self) -> f32 {
        self.mark() + self.cluster_gap + self.home() + self.cluster_gap + self.strip_margin()
    }

    fn segment(&self, workspace: Workspace) -> f32 {
        let m = self.input.metrics;
        let border = 2.0;
        if self.on(Fold::Icons) {
            border + 2.0 * m.space_1_5 + WORKSPACE_GLYPH
        } else if self.on(Fold::SwitchTight) {
            border + 2.0 * m.space_2_5 + self.input.labels.workspace(workspace)
        } else {
            border + SEGMENT_START + WORKSPACE_DOT + m.space_2 + self.input.labels.workspace(workspace) + SEGMENT_END
        }
    }

    fn track(&self) -> f32 {
        let gaps = 2.0 * self.input.metrics.space_0_5;
        2.0 * TRACK_PAD + gaps + Workspace::ALL.iter().map(|w| self.segment(*w)).sum::<f32>()
    }

    fn control(&self) -> f32 {
        if self.on(Fold::WinCtl) { CONTROL_FOLDED } else { CONTROL }
    }

    /// A button with a glyph and a word: `border + padding + glyph + gap + word`, or the glyph in a square.
    fn word_button(&self, pad: f32, word: f32, folded: bool) -> (f32, ButtonShape) {
        let m = self.input.metrics;
        if folded {
            (m.control_lg, ButtonShape::Glyph)
        } else {
            (2.0 * BUTTON_BORDER + 2.0 * pad + BUTTON_GLYPH + m.space_1_5 + word, ButtonShape::Word)
        }
    }

    /// The end cluster's groups, left to right: each group is items that touch, with the margin after it.
    fn end_groups(&self) -> Vec<Group> {
        let m = self.input.metrics;
        let input = self.input;
        let session = input.session;
        let mut groups = Vec::new();
        let mut history = vec![(Item::Undo, m.control_md)];
        if !self.on(Fold::Redo) {
            history.push((Item::Redo, m.control_md));
        }
        groups.push(Group { items: history, margin_end: 0.0 });
        if !self.on(Fold::Save) {
            groups.push(Group { items: vec![(Item::Save, m.control_md)], margin_end: m.space_0_5 });
        }
        if input.properties {
            groups.push(Group { items: vec![(Item::Properties, m.control_md)], margin_end: 0.0 });
        }
        let export_folded = if session == Session::None { self.on(Fold::Primary) } else { self.on(Fold::Export2) };
        let export_hidden = session != Session::None && self.on(Fold::Export2Out);
        if !export_hidden {
            let (width, shape) = self.word_button(PRIMARY_PAD, input.labels.export, export_folded);
            groups.push(Group { items: vec![(Item::Export(session.export(), shape), width)], margin_end: 0.0 });
        }
        if session.cancel() {
            let width = (2.0 * BUTTON_BORDER + 2.0 * QUIET_PAD + input.labels.cancel).max(m.control_lg);
            groups.push(Group { items: vec![(Item::Cancel, width)], margin_end: 0.0 });
        }
        if session.test_rig() {
            let (width, shape) = self.word_button(QUIET_PAD, input.labels.test_rig, self.on(Fold::TestRig));
            groups.push(Group { items: vec![(Item::TestRig(shape), width)], margin_end: 0.0 });
        }
        if let Some(done) = session.done() {
            let (width, shape) = self.word_button(PRIMARY_PAD, input.labels.done, self.on(Fold::Primary));
            groups.push(Group { items: vec![(Item::Done(done, shape), width)], margin_end: 0.0 });
        }
        if input.window_controls {
            let control = self.control();
            groups.push(Group { items: vec![(Item::Minimize, control), (Item::Maximize, control), (Item::Close, control)], margin_end: -self.pad_end });
        }
        groups
    }

    fn end(&self) -> f32 {
        let groups = self.end_groups();
        let last = groups.len().saturating_sub(1);
        let mut total = 0.0;
        for (index, group) in groups.iter().enumerate() {
            total += group.width();
            total += if index < last { group.margin_end + self.end_gap } else { group.margin_end };
        }
        total
    }

    /// The band's min-content width: the three clusters side by side (`inline-size: min-content`).
    fn min_width(&self) -> f32 {
        let start = self.start_before_strip() + self.strip_min();
        self.pad_start + start + self.column_gap + self.track() + self.column_gap + self.end() + self.pad_end
    }
}

/// Items that touch each other, as the history buttons do.
struct Group {
    items: Vec<(Item, f32)>,
    margin_end: f32,
}

impl Group {
    fn width(&self) -> f32 {
        self.items.iter().map(|(_, width)| *width).sum()
    }
}

/// Lays the band out for the window.
pub fn solve(input: &Input<'_>) -> Layout {
    let folds = folds_for(input);
    let parts = Parts::of(input, &folds);
    let m = input.metrics;
    let band = height(input.height, input.ui_scale);
    // Every cluster is as tall as the tallest control (the large ones, 36 px) and is centred in the band.
    let top = ((band - m.control_lg) / 2.0).max(0.0);
    let centred = |extent: f32| top + (m.control_lg - extent) / 2.0;
    let min_width = parts.min_width();

    let track = parts.track();
    let end = parts.end();
    let start = (input.width - parts.pad_start - parts.pad_end - 2.0 * parts.column_gap - track - end).max(parts.start_before_strip() + parts.strip_min());

    let mut items = Vec::new();
    let mut x = parts.pad_start;
    let mark = parts.mark();
    items.push(Placed { item: Item::Mark, frame: Frame::new(x, top, mark, m.control_lg) });
    x += mark + parts.cluster_gap;
    items.push(Placed { item: Item::Home, frame: Frame::new(x, centred(parts.home()), parts.home(), parts.home()) });
    x += parts.home() + parts.cluster_gap + parts.strip_margin();
    let strip_width = (parts.pad_start + start - x).max(0.0);
    let strip = Frame::new(x, top, strip_width, m.control_lg);
    let add = m.control_sm;
    let (tabs, add_x) = layout_tabs(input, &parts, strip_width, add);
    for (id, look, offset, width) in tabs {
        items.push(Placed { item: Item::Tab(id, look), frame: Frame::new(x + offset, top, width, m.control_lg) });
    }
    if let Some(offset) = add_x {
        items.push(Placed { item: Item::AddTab, frame: Frame::new(x + offset, centred(add), add, add) });
    }

    let track_x = parts.pad_start + start + parts.column_gap;
    let mut segment_x = track_x + TRACK_PAD;
    for workspace in Workspace::ALL {
        let width = parts.segment(workspace);
        items.push(Placed { item: Item::Workspace(workspace), frame: Frame::new(segment_x, top + TRACK_PAD, width, m.control_lg - 2.0 * TRACK_PAD) });
        segment_x += width + m.space_0_5;
    }
    let track_frame = Frame::new(track_x, top, track, m.control_lg);

    let groups = parts.end_groups();
    let mut end_x = track_x + track + parts.column_gap;
    let count = groups.len();
    for (index, group) in groups.iter().enumerate() {
        for (item, width) in &group.items {
            let (y, height) = match item {
                Item::Minimize | Item::Maximize | Item::Close | Item::Export(..) | Item::Cancel | Item::TestRig(_) | Item::Done(..) => (top, m.control_lg),
                _ => (centred(m.control_md), m.control_md),
            };
            items.push(Placed { item: *item, frame: Frame::new(end_x, y, *width, height) });
            end_x += width;
        }
        end_x += if index + 1 < count { group.margin_end + parts.end_gap } else { group.margin_end };
    }

    let segments = if parts.on(Fold::Icons) {
        SegmentContent::Glyph
    } else if parts.on(Fold::SwitchTight) {
        SegmentContent::Name
    } else {
        SegmentContent::DotAndName
    };
    Layout { height: band, folds, items, track: track_frame, strip, min_width, segments, pad_start: parts.pad_start }
}

/// The tabs inside a strip `strip_width` wide: each tab's offset and width, and New's offset.
/// A tab's place in the strip: which, how it looks, its offset and its width.
type PlacedTab = (DocumentId, TabLook, f32, f32);

fn layout_tabs(input: &Input<'_>, parts: &Parts<'_>, strip_width: f32, add: f32) -> (Vec<PlacedTab>, Option<f32>) {
    let gap = input.metrics.space_0_5;
    let dot = parts.on(Fold::Dot);
    // At the `dot` step only the tab in front shows, and New is gone.
    let shown: Vec<&TabFacts> = input.tabs.iter().filter(|tab| !dot || tab.front).collect();
    let wanted = input.tabs.len().max(1) as f32 * TAB_SLOT;
    let list_width = if dot { wanted.min(strip_width) } else { wanted.min((strip_width - gap - add).max(0.0)) };
    let inner = list_width - gap * shown.len().saturating_sub(1) as f32;
    let bases: Vec<f32> = shown.iter().map(|tab| if tab.front { TAB_FRONT } else { TAB_REST }).collect();
    let factors: Vec<f32> = shown.iter().map(|tab| if tab.front { 1.0 } else { TAB_REST_SHRINK }).collect();
    let front_min = if dot { TAB_REST_MIN } else { TAB_FRONT_MIN };
    let mins: Vec<f32> = shown.iter().map(|tab| if tab.front { front_min } else { TAB_REST_MIN }).collect();
    let widths = shrink(&bases, &factors, &mins, inner);
    let mut offset = 0.0;
    let mut tabs = Vec::new();
    for (tab, width) in shown.iter().zip(widths) {
        tabs.push((tab.id, tab_look(width, tab.marked), offset, width));
        offset += width + gap;
    }
    let add_x = (!dot).then_some(list_width + gap);
    (tabs, add_x)
}

/// A tab's parts from its width (the container is its content box).
pub fn tab_look(width: f32, marked: bool) -> TabLook {
    let content = width - TAB_PAD_START - TAB_PAD_END;
    let narrow = content <= TAB_NO_CLOSE;
    TabLook {
        name: content > TAB_NO_NAME,
        close: !narrow,
        end: match (narrow, marked) {
            (false, _) => TabEnd::Full,
            (true, true) => TabEnd::Narrow,
            (true, false) => TabEnd::Gone,
        },
    }
}

/// CSS flexbox's resolution of flexible lengths for items that never grow (§9.7): each item shrinks in proportion to
/// its shrink factor times its base size, no item under its minimum, and what a clamped item cannot give is shared by
/// the others.
pub fn shrink(bases: &[f32], factors: &[f32], mins: &[f32], space: f32) -> Vec<f32> {
    let count = bases.len();
    if bases.iter().sum::<f32>() <= space {
        return bases.to_vec();
    }
    let mut frozen = vec![false; count];
    let mut size = bases.to_vec();
    for _ in 0..=count {
        let open: Vec<usize> = (0..count).filter(|i| !frozen[*i]).collect();
        if open.is_empty() {
            break;
        }
        let used: f32 = (0..count).map(|i| if frozen[i] { size[i] } else { bases[i] }).sum();
        let free = space - used;
        let scaled: f32 = open.iter().map(|i| factors[*i] * bases[*i]).sum();
        if scaled <= 0.0 {
            break;
        }
        let mut violation = 0.0;
        let mut clamped = Vec::new();
        let mut target = size.clone();
        for &i in &open {
            let want = bases[i] + free * (factors[i] * bases[i] / scaled);
            if want < mins[i] {
                violation += mins[i] - want;
                clamped.push(i);
                target[i] = mins[i];
            } else {
                target[i] = want;
            }
        }
        if violation > 0.0 {
            // Freeze what hit its minimum and share what it could not give among the rest.
            for i in clamped {
                frozen[i] = true;
                size[i] = mins[i];
            }
        } else {
            for i in open {
                frozen[i] = true;
                size[i] = target[i];
            }
        }
    }
    size
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The words' widths in Chromium, Windows, Inter and Inter Tight (measured by `tmp/band-ref` against today's page).
    const LABELS: Labels = Labels { animate: 52.140625, draw: 32.8125, build: 31.453125, export: 38.875, cancel: 40.9375, test_rig: 43.375, done: 31.03125 };

    fn id(n: u64) -> DocumentId {
        DocumentId::preview(n)
    }

    fn tabs(count: usize, front: usize) -> Vec<TabFacts> {
        (0..count).map(|i| TabFacts { id: id(i as u64 + 1), front: i == front, marked: false }).collect()
    }

    fn input<'a>(width: f32, tabs: &'a [TabFacts], session: Session) -> Input<'a> {
        Input { width, height: 1000.0, ui_scale: 1.0, tabs, session, window_controls: true, properties: false, metrics: Metrics::TODAY, labels: LABELS }
    }

    fn frame(layout: &Layout, wanted: Item) -> Frame {
        layout.find(|item| std::mem::discriminant(item) == std::mem::discriminant(&wanted)).unwrap_or_else(|| panic!("{wanted:?} is not placed"))
    }

    fn near(actual: f32, expected: f32) {
        assert!((actual - expected).abs() < 0.06, "{actual} is not {expected}");
    }

    fn steps((none, rows): (f32, Vec<(Fold, f32)>)) -> (u32, Vec<(Fold, u32)>) {
        (none as u32, rows.into_iter().map(|(s, w)| (s, w as u32)).collect())
    }

    /// Chromium's measured band (`tmp/band-ref`, one tab, rest): 880 unfolded, then these after each step.
    #[test]
    fn the_unfolded_band_and_each_fold_measure_what_chromium_measures_at_rest() {
        let tabs = tabs(1, 0);
        let widths = fold_widths(&input(1560.0, &tabs, Session::None));
        assert_eq!(
            steps(widths),
            (
                880,
                vec![
                    (Fold::Tight, 856),
                    (Fold::Name, 828),
                    (Fold::Save, 790),
                    (Fold::WinCtl, 766),
                    (Fold::SwitchTight, 697),
                    (Fold::Icons, 587),
                    (Fold::Dot, 499),
                    (Fold::Redo, 467),
                    (Fold::Primary, 409),
                ]
            ),
            "the steps that free nothing at rest (testrig, export2 and export2out are a session's) are skipped"
        );
    }

    #[test]
    fn a_build_session_measures_what_chromium_measures() {
        let tabs = tabs(1, 0);
        let widths = fold_widths(&input(1560.0, &tabs, Session::Build));
        assert_eq!(
            steps(widths),
            (
                1076,
                vec![
                    (Fold::Tight, 1044),
                    (Fold::Name, 1016),
                    (Fold::TestRig, 958),
                    (Fold::Save, 920),
                    (Fold::WinCtl, 896),
                    (Fold::Export2, 838),
                    (Fold::SwitchTight, 769),
                    (Fold::Icons, 656),
                    (Fold::Dot, 568),
                    (Fold::Redo, 536),
                    (Fold::Export2Out, 498),
                    (Fold::Primary, 447),
                ]
            )
        );
    }

    #[test]
    fn a_movieclip_session_measures_what_chromium_measures() {
        let tabs = tabs(1, 0);
        let widths = fold_widths(&input(1560.0, &tabs, Session::Movieclip));
        assert_eq!(
            steps(widths),
            (
                1053,
                vec![
                    (Fold::Tight, 1021),
                    (Fold::Name, 993),
                    (Fold::Save, 955),
                    (Fold::WinCtl, 931),
                    (Fold::Export2, 873),
                    (Fold::SwitchTight, 804),
                    (Fold::Icons, 690),
                    (Fold::Dot, 602),
                    (Fold::Redo, 570),
                    (Fold::Export2Out, 532),
                    (Fold::Primary, 482),
                ]
            ),
            "a movieclip has no Test rig step, and its Cancel and Done come with it"
        );
        let layout = solve(&input(1560.0, &tabs, Session::Movieclip));
        let cancel = frame(&layout, Item::Cancel);
        near(cancel.x, 1255.031);
        near(cancel.width, 70.938);
        near(frame(&layout, Item::Done(Done::Movieclip, ButtonShape::Word)).x, 1333.969);
    }

    /// The fold steps Chromium applies (`resolveTiers` over `measureBand`, `tmp/band-ref`) at the widths of the
    /// screenshots, with three tabs.
    #[test]
    fn the_folds_at_each_width_are_the_ones_todays_solver_picks() {
        let tabs = tabs(3, 1);
        let all = [Fold::Tight, Fold::Name, Fold::Save, Fold::WinCtl, Fold::SwitchTight, Fold::Icons, Fold::Dot, Fold::Redo, Fold::Primary];
        for (width, count) in [(1560.0, 0), (904.0, 0), (903.0, 1), (879.0, 2), (851.0, 3), (813.0, 4), (789.0, 5), (720.0, 6), (610.0, 7), (522.0, 8), (490.0, 9), (400.0, 9)] {
            assert_eq!(solve(&input(width, &tabs, Session::None)).folds, all[..count].to_vec(), "{width}");
        }
        let build = |width| solve(&input(width, &tabs, Session::Build)).folds;
        assert_eq!(build(1000.0), vec![Fold::Tight, Fold::Name, Fold::TestRig]);
        assert_eq!(build(480.0).len(), 12, "every step a Build session has");
        let movieclip = |width| solve(&input(width, &tabs, Session::Movieclip)).folds;
        assert_eq!(movieclip(1000.0), vec![Fold::Tight, Fold::Name, Fold::Save]);
        assert_eq!(solve(&input(1000.0, &tabs, Session::Camera)).folds, Vec::<Fold>::new(), "the camera's one button fits");
    }

    #[test]
    fn a_wide_window_places_every_item_where_chromium_does() {
        let tabs = tabs(1, 0);
        let layout = solve(&input(1560.0, &tabs, Session::None));
        assert!(layout.folds.is_empty());
        let at = |item| frame(&layout, item);
        let mark = at(Item::Mark);
        assert_eq!((mark.x, mark.y, mark.width, mark.height), (8.0, 8.0, 46.0, 36.0));
        let home = at(Item::Home);
        assert_eq!((home.x, home.y, home.width, home.height), (58.0, 10.0, 32.0, 32.0));
        let tab = layout.tabs().next().expect("a tab").2;
        assert_eq!((tab.x, tab.y, tab.width, tab.height), (98.0, 8.0, 172.0, 36.0));
        let add = at(Item::AddTab);
        assert_eq!((add.x, add.y, add.width, add.height), (286.0, 12.0, 28.0, 28.0));
        near(layout.strip.width, 828.71875);
        near(layout.track.x, 938.71875);
        near(layout.track.width, 261.40625);
        let animate = at(Item::Workspace(Workspace::Animate));
        near(animate.x, 941.71875);
        near(animate.width, 97.140625);
        assert_eq!((animate.y, animate.height), (11.0, 30.0));
        near(layout.find(|item| *item == Item::Workspace(Workspace::Draw)).unwrap().x, 1040.859);
        near(layout.find(|item| *item == Item::Workspace(Workspace::Build)).unwrap().x, 1120.672);
        near(at(Item::Undo).x, 1212.125);
        near(at(Item::Redo).x, 1244.125);
        near(at(Item::Save).x, 1284.125);
        let export = at(Item::Export(ExportLook::Primary, ButtonShape::Word));
        near(export.x, 1326.125);
        near(export.width, 93.875);
        assert_eq!((export.y, export.height), (8.0, 36.0));
        assert_eq!(at(Item::Minimize).x, 1428.0);
        assert_eq!(at(Item::Maximize).x, 1472.0);
        let close = at(Item::Close);
        assert_eq!((close.x, close.right(), close.y, close.height), (1516.0, 1560.0, 8.0, 36.0));
    }

    #[test]
    fn three_tabs_share_the_strip_as_chromium_shares_it() {
        let tabs = tabs(3, 1);
        let layout = solve(&input(1200.0, &tabs, Session::None));
        let frames: Vec<Frame> = layout.tabs().map(|(_, _, f)| f).collect();
        near(frames[0].x, 98.0);
        near(frames[0].width, 136.844);
        near(frames[1].x, 236.844);
        near(frames[1].width, 161.031);
        near(frames[2].x, 399.875);
        near(frames[2].width, 136.844);
        near(frame(&layout, Item::AddTab).x, 538.719);
        near(layout.track.x, 578.719);
        near(frame(&layout, Item::Close).right(), 1200.0);
    }

    /// Chromium at 879 px with three tabs and the `tight` and `name` steps (`tmp/band-ref`).
    #[test]
    fn a_narrowed_band_places_its_items_where_chromium_does() {
        let tabs = tabs(3, 1);
        let layout = solve(&input(879.0, &tabs, Session::None));
        assert_eq!(layout.folds, vec![Fold::Tight, Fold::Name]);
        let frames: Vec<Frame> = layout.tabs().map(|(_, _, f)| f).collect();
        near(frames[0].x, 94.0);
        near(frames[0].width, 36.0);
        near(frames[1].x, 132.0);
        near(frames[1].width, 84.0);
        near(frames[2].x, 218.0);
        near(frames[2].width, 36.0);
        near(frame(&layout, Item::Home).x, 56.0);
        near(frame(&layout, Item::AddTab).x, 237.719);
        near(layout.track.x, 273.719);
        near(frame(&layout, Item::Undo).x, 543.125);
        near(frame(&layout, Item::Export(ExportLook::Primary, ButtonShape::Word)).x, 649.125);
        near(frame(&layout, Item::Minimize).x, 747.0);
        near(frame(&layout, Item::Close).right(), 879.0);
    }

    #[test]
    fn a_session_places_its_buttons_after_a_quiet_export() {
        let tabs = tabs(1, 0);
        let layout = solve(&input(1560.0, &tabs, Session::Build));
        let export = frame(&layout, Item::Export(ExportLook::Ghost, ButtonShape::Word));
        near(export.x, 1129.719);
        let rig = frame(&layout, Item::TestRig(ButtonShape::Word));
        near(rig.x, 1231.594);
        near(rig.width, 94.375);
        let done = frame(&layout, Item::Done(Done::Build, ButtonShape::Word));
        near(done.x, 1333.969);
        near(done.width, 86.031);
        assert_eq!(frame(&layout, Item::Minimize).x, 1428.0);
    }

    #[test]
    fn the_fewest_steps_that_fit_apply() {
        let tabs = tabs(1, 0);
        // 880 + 24 fits at 904; at 903 the first step applies.
        assert!(solve(&input(904.0, &tabs, Session::None)).folds.is_empty());
        assert_eq!(solve(&input(903.0, &tabs, Session::None)).folds, vec![Fold::Tight]);
        // 856 + 24 = 880: one step is enough there, two just under it.
        assert_eq!(solve(&input(880.0, &tabs, Session::None)).folds, vec![Fold::Tight]);
        assert_eq!(solve(&input(879.0, &tabs, Session::None)).folds, vec![Fold::Tight, Fold::Name]);
    }

    #[test]
    fn a_window_nothing_fits_gets_every_step_and_the_band_overflows_to_its_minimum() {
        let tabs = tabs(1, 0);
        let layout = solve(&input(300.0, &tabs, Session::None));
        assert_eq!(layout.folds, vec![Fold::Tight, Fold::Name, Fold::Save, Fold::WinCtl, Fold::SwitchTight, Fold::Icons, Fold::Dot, Fold::Redo, Fold::Primary]);
        assert!(layout.min_width <= 409.0 && layout.min_width > 408.0, "{}", layout.min_width);
        let close = frame(&layout, Item::Close);
        assert!(close.right() > 300.0, "the controls are where the band's minimum puts them, not squeezed");
    }

    #[test]
    fn a_session_folds_its_own_buttons_before_the_switch() {
        let tabs = tabs(1, 0);
        let layout = solve(&input(880.0, &tabs, Session::Build));
        assert!(layout.folds.contains(&Fold::TestRig) && layout.folds.contains(&Fold::Export2));
        assert!(!layout.folds.contains(&Fold::Icons));
        assert!(layout.items.iter().any(|p| p.item == Item::TestRig(ButtonShape::Glyph)));
        assert!(layout.items.iter().any(|p| p.item == Item::Export(ExportLook::Ghost, ButtonShape::Glyph)));
    }

    #[test]
    fn the_fold_steps_change_what_shows() {
        let tabs = tabs(3, 0);
        let layout = solve(&input(560.0, &tabs, Session::None));
        assert_eq!(layout.segments, SegmentContent::Glyph);
        assert_eq!(layout.tabs().count(), 1, "at the dot step only the tab in front keeps its tab");
        assert!(layout.find(|item| *item == Item::AddTab).is_none(), "and New is in the mark's menu");
        assert_eq!(layout.folds.last(), Some(&Fold::Dot));
        let narrow = solve(&input(1560.0, &tabs, Session::None));
        assert_eq!(narrow.tabs().count(), 3);
    }

    #[test]
    fn the_compact_chrome_has_a_44_px_band_and_centres_the_controls_in_it() {
        let tabs = tabs(1, 0);
        let mut compact = input(1200.0, &tabs, Session::None);
        compact.height = 700.0;
        let layout = solve(&compact);
        assert_eq!(layout.height, 44.0);
        assert_eq!(frame(&layout, Item::Mark).y, 4.0);
        assert_eq!(frame(&layout, Item::Undo).y, 6.0);
    }

    #[test]
    fn properties_shows_beside_save_when_the_dock_folds_it_into_a_sheet() {
        let tabs = tabs(1, 0);
        let mut with = input(1200.0, &tabs, Session::None);
        with.properties = true;
        let layout = solve(&with);
        let props = frame(&layout, Item::Properties);
        assert_eq!(props.width, 32.0);
        assert!(props.x > frame(&layout, Item::Save).right() && props.right() <= frame(&layout, Item::Export(ExportLook::Primary, ButtonShape::Word)).x);
    }

    #[test]
    fn a_tab_loses_close_then_its_name_as_it_narrows() {
        assert_eq!(tab_look(172.0, false), TabLook { name: true, close: true, end: TabEnd::Full });
        // content = width - 12: narrower than 124 drops Close; the dot's slot stays only while there is a state.
        assert_eq!(tab_look(136.0, true), TabLook { name: true, close: false, end: TabEnd::Narrow });
        assert_eq!(tab_look(136.0, false), TabLook { name: true, close: false, end: TabEnd::Gone });
        assert_eq!(tab_look(137.0, false), TabLook { name: true, close: true, end: TabEnd::Full });
        // content = 72 drops the name.
        assert!(!tab_look(84.0, true).name);
        assert!(tab_look(85.0, true).name);
    }

    #[test]
    fn twelve_tabs_fit_without_scrolling_and_the_one_in_front_keeps_more() {
        let tabs = tabs(12, 5);
        let layout = solve(&input(1560.0, &tabs, Session::None));
        let frames: Vec<(DocumentId, TabLook, Frame)> = layout.tabs().collect();
        assert_eq!(frames.len(), 12);
        let front = frames[5].2.width;
        let rest = frames[0].2.width;
        assert!(front > rest * 2.0, "{front} against {rest}");
        let last = frames[11].2;
        assert!(last.right() <= layout.strip.right() - 28.0 - 2.0 + 0.01, "New fits beside the last tab");
        for (a, b) in frames.iter().zip(frames.iter().skip(1)) {
            near(b.2.x - a.2.right(), 2.0);
        }
    }

    #[test]
    fn shrinking_keeps_the_minimum_and_shares_what_a_clamped_tab_cannot_give() {
        // Two items, the first stiff, both against a minimum: the sum is the space and no item is under its minimum.
        let sizes = shrink(&[184.0, 172.0], &[4.0, 1.0], &[36.0, 84.0], 150.0);
        assert!((sizes.iter().sum::<f32>() - 150.0).abs() < 0.01, "{sizes:?}");
        assert!(sizes[0] >= 36.0 && sizes[1] >= 84.0, "{sizes:?}");
        assert_eq!(shrink(&[184.0, 172.0], &[4.0, 1.0], &[36.0, 84.0], 400.0), vec![184.0, 172.0], "room for both: nothing shrinks");
        let all_minimum = shrink(&[184.0, 172.0], &[4.0, 1.0], &[36.0, 84.0], 10.0);
        assert_eq!(all_minimum, vec![36.0, 84.0]);
    }

    #[test]
    fn the_places_that_keep_the_pointer_leave_the_empty_band_and_the_window_controls_alone() {
        let tabs = tabs(2, 0);
        let layout = solve(&input(1560.0, &tabs, Session::None));
        let no_drag = layout.no_drag();
        let covers = |x: f32, y: f32| no_drag.iter().any(|f| f.contains(x, y));
        assert!(covers(30.0, 26.0), "the mark");
        assert!(covers(120.0, 26.0), "a tab");
        assert!(covers(layout.track.x + 40.0, 26.0), "the workspace switch, gaps included");
        assert!(covers(1220.0, 26.0) && covers(1250.0, 26.0), "history");
        assert!(!covers(700.0, 26.0), "the strip's empty part drags the window");
        assert!(!covers(1540.0, 26.0), "the window controls are the window's, not no-drag regions");
        assert!(!covers(500.0, 2.0));
    }

    #[test]
    fn hit_testing_finds_the_tab_and_which_half() {
        let tabs = tabs(3, 0);
        let layout = solve(&input(1560.0, &tabs, Session::None));
        let frames: Vec<Frame> = layout.tabs().map(|(_, _, f)| f).collect();
        let (first, second) = (frames[0], frames[1]);
        assert_eq!(layout.tab_at(first.x + 1.0), Some((id(1), false)));
        assert_eq!(layout.tab_at(first.right() - 1.0), Some((id(1), true)));
        assert_eq!(layout.tab_at(second.x + second.width * 0.75), Some((id(2), true)));
        assert_eq!(layout.tab_at(2.0), None);
    }
}
