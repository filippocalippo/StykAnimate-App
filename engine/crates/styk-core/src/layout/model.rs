use super::{Operation, Zone};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub type GroupId = u32;
pub type NodeId = u32;
pub type FloatId = u32;
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct PanelId {
    pub kind: String,
    pub n: u8,
}
impl PanelId {
    pub fn new(kind: &str) -> Self {
        Self {
            kind: kind.into(),
            n: 0,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Workspace {
    Animate,
    Draw,
    Rig,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
    Top,
    Bottom,
}
impl Side {
    pub fn axis(self) -> Axis {
        match self {
            Self::Left | Self::Right => Axis::Horizontal,
            _ => Axis::Vertical,
        }
    }
    pub fn before(self) -> bool {
        matches!(self, Self::Left | Self::Top)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Sz {
    Px(f64),
    Flex(f64),
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Size {
    pub w: f64,
    pub h: f64,
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
impl Rect {
    pub fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
    pub fn valid(self) -> bool {
        [self.x, self.y, self.w, self.h]
            .iter()
            .all(|n| n.is_finite())
            && self.w > 0.
            && self.h > 0.
    }
}
#[derive(Clone, Copy, Debug)]
pub struct PanelSpec {
    pub kind: &'static str,
    pub min: Size,
    pub pref: Size,
    pub max: Option<Size>,
    pub keep: u8,
    pub home: Side,
    pub multi: u8,
}
pub const SPECS: &[PanelSpec] = &[
    PanelSpec {
        kind: "stage",
        min: Size { w: 360., h: 244. },
        pref: Size { w: 640., h: 480. },
        max: None,
        keep: 255,
        home: Side::Left,
        multi: 4,
    },
    PanelSpec {
        kind: "properties",
        min: Size { w: 256., h: 160. },
        pref: Size { w: 320., h: 360. },
        max: Some(Size { w: 420., h: 10000. }),
        keep: 3,
        home: Side::Right,
        multi: 1,
    },
    PanelSpec {
        kind: "vfx",
        min: Size { w: 256., h: 160. },
        pref: Size { w: 320., h: 360. },
        max: Some(Size { w: 420., h: 10000. }),
        keep: 2,
        home: Side::Right,
        multi: 1,
    },
    PanelSpec {
        kind: "library",
        min: Size { w: 256., h: 160. },
        pref: Size { w: 320., h: 360. },
        max: Some(Size { w: 460., h: 10000. }),
        keep: 1,
        home: Side::Right,
        multi: 1,
    },
    PanelSpec {
        kind: "structure",
        min: Size { w: 200., h: 160. },
        pref: Size { w: 232., h: 360. },
        max: Some(Size { w: 360., h: 10000. }),
        keep: 0,
        home: Side::Left,
        multi: 1,
    },
    PanelSpec {
        kind: "timeline",
        min: Size { w: 360., h: 168. },
        pref: Size { w: 640., h: 264. },
        max: None,
        keep: 4,
        home: Side::Bottom,
        multi: 1,
    },
    PanelSpec {
        kind: "layers",
        min: Size { w: 120., h: 168. },
        pref: Size { w: 200., h: 264. },
        max: None,
        keep: 4,
        home: Side::Bottom,
        multi: 1,
    },
    PanelSpec {
        kind: "tools",
        min: Size { w: 52., h: 52. },
        pref: Size { w: 52., h: 360. },
        max: None,
        keep: 5,
        home: Side::Left,
        multi: 1,
    },
];
pub fn spec(kind: &str) -> Option<&'static PanelSpec> {
    SPECS.iter().find(|s| s.kind == kind)
}
#[derive(Clone, Debug, PartialEq)]
pub struct TabGroup {
    pub id: GroupId,
    pub tabs: Vec<PanelId>,
    pub active: usize,
    pub collapsed: bool,
    pub flyout_px: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Kid {
    pub node: Node,
    pub size: Sz,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Tabs(TabGroup),
    Split {
        id: NodeId,
        axis: Axis,
        kids: Vec<Kid>,
    },
}
impl Node {
    pub fn id(&self) -> u32 {
        match self {
            Self::Tabs(g) => g.id,
            Self::Split { id, .. } => *id,
        }
    }
    pub fn groups<'a>(&'a self, out: &mut Vec<&'a TabGroup>) {
        match self {
            Self::Tabs(g) => out.push(g),
            Self::Split { kids, .. } => {
                for k in kids {
                    k.node.groups(out);
                }
            }
        }
    }
    pub fn group_mut(&mut self, id: GroupId) -> Option<&mut TabGroup> {
        match self {
            Self::Tabs(g) => (g.id == id).then_some(g),
            Self::Split { kids, .. } => kids.iter_mut().find_map(|k| k.node.group_mut(id)),
        }
    }
}
/// Stable anchors survive unrelated rearrangements; the sibling recreates an emptied group.
#[derive(Clone, Debug, PartialEq)]
pub struct ReturnPlacement {
    pub group: GroupId,
    pub index: usize,
    pub sibling: Option<NodeId>,
    pub side: Side,
    pub size: Sz,
}
impl Default for ReturnPlacement {
    fn default() -> Self {
        Self {
            group: 0,
            index: 0,
            sibling: None,
            side: Side::Right,
            size: Sz::Px(320.),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Frames {
    pub monitor: u64,
    pub relative: Rect,
    pub by_setup: VecDeque<(u64, Rect)>,
}
impl Frames {
    pub fn remember(&mut self, setup: u64, rect: Rect) -> Result<(), LayoutError> {
        if !rect.valid() {
            return Err(LayoutError::InvalidGeometry);
        }
        self.by_setup.retain(|(k, _)| *k != setup);
        self.by_setup.push_back((setup, rect));
        while self.by_setup.len() > 8 {
            self.by_setup.pop_front();
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Float {
    pub id: FloatId,
    pub root: Node,
    pub frames: Frames,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    /// Empty when all open groups are in floating windows.
    pub main: Option<Node>,
    pub floats: Vec<Float>,
    pub closed: Vec<PanelId>,
    pub dormant: Vec<PanelId>,
    pub stage_tools: Option<Side>,
    pub returns: BTreeMap<PanelId, ReturnPlacement>,
    /// Joined Layers/Timeline share row geometry without another header or gutter.
    pub joined_layers: bool,
    pub layers_width: f64,
    /// Opaque fields retained by the codec (including future panel records).
    pub unknown: BTreeMap<String, styk_doc::Value>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LayoutError {
    Missing,
    InvalidTree,
    Duplicate,
    LastStage,
    Limit,
    InvalidGeometry,
    InvalidTarget,
    FutureVersion,
    InvalidFile,
    Storage(String),
}
impl Layout {
    pub fn groups(&self) -> Vec<&TabGroup> {
        let mut v = Vec::new();
        if let Some(n) = &self.main {
            n.groups(&mut v);
        }
        for f in &self.floats {
            f.root.groups(&mut v);
        }
        v
    }
    pub fn group_mut(&mut self, id: GroupId) -> Option<&mut TabGroup> {
        if let Some(g) = self.main.as_mut().and_then(|n| n.group_mut(id)) {
            return Some(g);
        }
        self.floats.iter_mut().find_map(|f| f.root.group_mut(id))
    }
    pub fn panels(&self) -> Vec<PanelId> {
        let mut p: Vec<_> = self.groups().iter().flat_map(|g| g.tabs.clone()).collect();
        p.extend(self.closed.clone());
        p.extend(self.dormant.clone());
        if self.stage_tools.is_some() {
            p.push(PanelId::new("tools"));
        }
        if self.joined_layers {
            p.push(PanelId::new("layers"));
        }
        p
    }
    pub fn next_id(&self) -> u32 {
        fn max(n: &Node) -> u32 {
            match n {
                Node::Tabs(g) => g.id,
                Node::Split { id, kids, .. } => {
                    kids.iter().map(|k| max(&k.node)).fold(*id, u32::max)
                }
            }
        }
        self.main
            .iter()
            .map(max)
            .chain(self.floats.iter().flat_map(|f| [f.id, max(&f.root)]))
            .chain(
                self.returns
                    .values()
                    .flat_map(|h| [h.group, h.sibling.unwrap_or(0)]),
            )
            .max()
            .unwrap_or(0)
            .saturating_add(1)
    }
    pub fn validate(&self, workspace: Workspace) -> Result<(), LayoutError> {
        fn node(n: &Node, ids: &mut BTreeSet<u32>) -> Result<(), LayoutError> {
            if !ids.insert(n.id()) {
                return Err(LayoutError::Duplicate);
            }
            match n {
                Node::Tabs(g) => {
                    if g.tabs.is_empty()
                        || g.active >= g.tabs.len()
                        || !g.flyout_px.is_finite()
                        || g.flyout_px <= 0.
                    {
                        return Err(LayoutError::InvalidTree);
                    }
                }
                Node::Split { kids, .. } => {
                    if kids.len() < 2 {
                        return Err(LayoutError::InvalidTree);
                    }
                    for k in kids {
                        let (Sz::Px(v) | Sz::Flex(v)) = k.size;
                        if !v.is_finite() || v <= 0. {
                            return Err(LayoutError::InvalidGeometry);
                        }
                        node(&k.node, ids)?;
                    }
                }
            }
            Ok(())
        }
        let mut ids = BTreeSet::new();
        for n in self.main.iter().chain(self.floats.iter().map(|f| &f.root)) {
            node(n, &mut ids)?;
        }
        let mut floats = BTreeSet::new();
        if self.floats.len() > 8 {
            return Err(LayoutError::Limit);
        }
        for f in &self.floats {
            if !floats.insert(f.id) {
                return Err(LayoutError::Duplicate);
            }
            if !f.frames.relative.valid()
                || f.frames.by_setup.len() > 8
                || f.frames.by_setup.iter().any(|(_, r)| !r.valid())
            {
                return Err(LayoutError::InvalidGeometry);
            }
        }
        if self
            .stage_tools
            .is_some_and(|s| !matches!(s, Side::Left | Side::Right))
        {
            return Err(LayoutError::InvalidTarget);
        }
        for f in &self.floats {
            let keys: BTreeSet<_> = f.frames.by_setup.iter().map(|(k, _)| k).collect();
            if keys.len() != f.frames.by_setup.len() {
                return Err(LayoutError::Duplicate);
            }
        }
        let panels = self.panels();
        let unique: BTreeSet<_> = panels.iter().collect();
        if unique.len() != panels.len() {
            return Err(LayoutError::Duplicate);
        }
        for p in &panels {
            if let Some(s) = spec(&p.kind)
                && p.n >= s.multi
            {
                return Err(LayoutError::Limit);
            }
        }
        if !self
            .groups()
            .iter()
            .any(|g| g.tabs.iter().any(|p| p.kind == "stage"))
        {
            return Err(LayoutError::LastStage);
        }
        for s in SPECS {
            if !panels.iter().any(|p| p.kind == s.kind) {
                return Err(LayoutError::Missing);
            }
        }
        if workspace != Workspace::Rig && !self.dormant.contains(&PanelId::new("structure")) {
            return Err(LayoutError::InvalidTarget);
        }
        if self.joined_layers && !panels.contains(&PanelId::new("timeline")) {
            return Err(LayoutError::Missing);
        }
        if !self.layers_width.is_finite() || self.layers_width < 120. {
            return Err(LayoutError::InvalidGeometry);
        }
        Ok(())
    }
}
pub fn tabs(id: u32, kinds: &[&str]) -> Node {
    Node::Tabs(TabGroup {
        id,
        tabs: kinds.iter().map(|k| PanelId::new(k)).collect(),
        active: 0,
        collapsed: false,
        flyout_px: 320.,
    })
}
pub fn essentials(workspace: Workspace) -> Layout {
    let top = Node::Split {
        id: 4,
        axis: Axis::Horizontal,
        kids: vec![
            Kid {
                node: tabs(1, &["stage"]),
                size: Sz::Flex(1.),
            },
            Kid {
                node: tabs(2, &["properties", "vfx", "library"]),
                size: Sz::Px(320.),
            },
        ],
    };
    let mut l = Layout {
        main: Some(Node::Split {
            id: 5,
            axis: Axis::Vertical,
            kids: vec![
                Kid {
                    node: top,
                    size: Sz::Flex(1.),
                },
                Kid {
                    node: tabs(3, &["timeline"]),
                    size: Sz::Px(264.),
                },
            ],
        }),
        floats: vec![],
        closed: vec![],
        dormant: vec![PanelId::new("structure")],
        stage_tools: Some(Side::Left),
        returns: BTreeMap::new(),
        joined_layers: true,
        layers_width: 200.,
        unknown: BTreeMap::new(),
    };
    if workspace == Workspace::Rig {
        l.dormant.clear();
        l.closed.push(PanelId::new("structure"));
    }
    l
}
/// Layout history and monitor arrangements never enter document undo.
#[derive(Clone, Debug)]
pub struct LayoutState {
    pub current: Layout,
    pub base: Layout,
    pub dirty: bool,
    pub history: VecDeque<Layout>,
    pub setups: BTreeMap<u64, Layout>,
    pub focus_snapshot: Option<Layout>,
}
impl LayoutState {
    pub fn new(layout: Layout) -> Self {
        Self {
            base: layout.clone(),
            current: layout,
            dirty: false,
            history: VecDeque::new(),
            setups: BTreeMap::new(),
            focus_snapshot: None,
        }
    }
    pub fn commit(&mut self, layout: Layout, workspace: Workspace) -> Result<(), LayoutError> {
        layout.validate(workspace)?;
        if self.current != layout {
            self.history.push_back(self.current.clone());
            if self.history.len() > 20 {
                self.history.pop_front();
            }
            self.current = layout;
            self.dirty = self.current != self.base;
        }
        Ok(())
    }
    pub fn undo(&mut self) -> bool {
        if let Some(l) = self.history.pop_back() {
            self.current = l;
            self.dirty = self.current != self.base;
            true
        } else {
            false
        }
    }
    pub fn switch_setup(&mut self, from: u64, to: u64) {
        self.setups.insert(from, self.current.clone());
        if let Some(l) = self.setups.get(&to) {
            self.current = l.clone();
        }
        self.history.clear();
        self.focus_snapshot = None;
        self.dirty = self.current != self.base;
    }
    pub fn focus(&mut self) {
        if let Some(l) = self.focus_snapshot.take() {
            self.current = l;
        } else {
            self.focus_snapshot = Some(self.current.clone());
            let ids: Vec<_> = self
                .current
                .groups()
                .iter()
                .filter(|g| !g.tabs.iter().any(|p| p.kind == "stage"))
                .map(|g| g.id)
                .collect();
            for id in ids {
                if let Some(g) = self.current.group_mut(id) {
                    g.collapsed = true;
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    Essentials,
    Animator,
    Drawing,
    LargeTimeline,
    Review,
}
pub fn preset(
    workspace: Workspace,
    preset: Preset,
    window_height: f64,
) -> Result<Layout, LayoutError> {
    if !window_height.is_finite() || window_height <= 0. {
        return Err(LayoutError::InvalidGeometry);
    }
    if matches!(preset, Preset::Animator | Preset::Review) && workspace != Workspace::Animate
        || preset == Preset::Drawing && workspace != Workspace::Draw
        || preset == Preset::LargeTimeline && workspace == Workspace::Draw
    {
        return Err(LayoutError::InvalidTarget);
    }
    let mut l = essentials(workspace);
    if workspace == Workspace::Rig {
        l.apply(Operation::Reopen(PanelId::new("structure")), workspace)?;
        let id = l
            .groups()
            .iter()
            .find(|g| g.tabs.contains(&PanelId::new("structure")))
            .map(|g| g.id)
            .ok_or(LayoutError::Missing)?;
        l.apply(Operation::Collapse(id, true), workspace)?;
    }
    match preset {
        Preset::Essentials => {
            if workspace == Workspace::Rig {
                l.apply(Operation::Close(PanelId::new("timeline")), workspace)?;
            }
        }
        Preset::Animator => {
            l.apply(
                Operation::Move(
                    PanelId::new("vfx"),
                    Zone::Split {
                        group: 2,
                        side: Side::Right,
                    },
                ),
                workspace,
            )?;
            let id = l
                .groups()
                .iter()
                .find(|g| g.tabs.contains(&PanelId::new("vfx")))
                .map(|g| g.id)
                .ok_or(LayoutError::Missing)?;
            l.apply(
                Operation::Move(
                    PanelId::new("library"),
                    Zone::Tab {
                        group: id,
                        index: 1,
                    },
                ),
                workspace,
            )?;
            l.apply(Operation::Collapse(id, true), workspace)?;
            // Keep the inspector preference plus one shared strip within the top row.
            if let Some(Node::Split { kids, .. }) = &mut l.main
                && let Some(Node::Split { kids: top, .. }) = kids.first_mut().map(|k| &mut k.node)
                && let Some(right) = top.get_mut(1)
            {
                right.size = Sz::Px(320. + 40. + 8.);
            }
            set_timeline_height(&mut l, window_height * 0.4);
        }
        Preset::Drawing => {
            l.apply(Operation::Close(PanelId::new("vfx")), workspace)?;
            set_timeline_height(&mut l, 168.);
        }
        Preset::LargeTimeline => {
            l.apply(Operation::Collapse(2, true), workspace)?;
            set_timeline_height(&mut l, window_height * 0.55);
        }
        Preset::Review => {
            for kind in ["properties", "vfx", "library"] {
                l.apply(Operation::Close(PanelId::new(kind)), workspace)?;
            }
            l.apply(Operation::Collapse(3, true), workspace)?;
        }
    }
    l.validate(workspace)?;
    Ok(l)
}
fn set_timeline_height(l: &mut Layout, height: f64) {
    fn visit(n: &mut Node, h: f64) {
        if let Node::Split { axis, kids, .. } = n {
            for k in kids {
                if *axis == Axis::Vertical
                    && matches!(&k.node,Node::Tabs(g) if g.tabs.iter().any(|p|p.kind=="timeline"))
                {
                    k.size = Sz::Px(h.max(168.));
                } else {
                    visit(&mut k.node, h);
                }
            }
        }
    }
    if let Some(n) = &mut l.main {
        visit(n, height);
    }
}
impl LayoutState {
    pub fn apply_preset(
        &mut self,
        preset: Layout,
        workspace: Workspace,
    ) -> Result<(), LayoutError> {
        self.focus_snapshot = None;
        self.commit(preset.clone(), workspace)?;
        self.base = preset;
        self.dirty = false;
        Ok(())
    }
    pub fn reset(&mut self, workspace: Workspace) -> Result<(), LayoutError> {
        self.focus_snapshot = None;
        self.commit(self.base.clone(), workspace)
    }
}
