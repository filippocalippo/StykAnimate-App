use super::*;
#[derive(Clone, Debug, PartialEq)]
pub enum Zone {
    Tab { group: GroupId, index: usize },
    Split { group: NodeId, side: Side },
    Between { split: NodeId, index: usize },
    WindowEdge { side: Side },
    Float { rect: Rect },
    StageTools { side: Side },
}
#[derive(Clone, Debug)]
pub enum Operation {
    Move(PanelId, Zone),
    MoveGroup(GroupId, Zone),
    Activate(GroupId, usize),
    Reorder(GroupId, usize, usize),
    Close(PanelId),
    Reopen(PanelId),
    DockBack(FloatId),
    Collapse(GroupId, bool),
    Resize {
        split: NodeId,
        index: usize,
        first: Sz,
        second: Sz,
    },
    ResetDivider {
        split: NodeId,
        index: usize,
    },
    NewStage,
    JoinLayers,
    Reset,
}
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutEvent {
    pub announcement: &'static str,
}
impl Layout {
    pub fn apply(
        &mut self,
        op: Operation,
        workspace: Workspace,
    ) -> Result<Vec<LayoutEvent>, LayoutError> {
        self.validate(workspace)?;
        let mut next = self.clone();
        next.perform(op, workspace)?;
        next.validate(workspace)?;
        *self = next;
        Ok(vec![LayoutEvent {
            announcement: "Layout changed",
        }])
    }
    fn perform(&mut self, op: Operation, w: Workspace) -> Result<(), LayoutError> {
        match op {
            Operation::Move(p, z) => self.move_panel(p, z)?,
            Operation::MoveGroup(id, z) => {
                let g = self
                    .groups()
                    .into_iter()
                    .find(|g| g.id == id)
                    .ok_or(LayoutError::Missing)?
                    .clone();
                if matches!(z,Zone::Tab{group,..}|Zone::Split{group,..} if group==id) {
                    return Err(LayoutError::InvalidTarget);
                }
                let active = g.tabs[g.active].clone();
                let mut dest = None;
                for p in g.tabs {
                    let target = dest.map_or_else(
                        || z.clone(),
                        |group| Zone::Tab {
                            group,
                            index: usize::MAX,
                        },
                    );
                    self.move_panel(p.clone(), target)?;
                    dest = self
                        .groups()
                        .iter()
                        .find(|g| g.tabs.contains(&p))
                        .map(|g| g.id);
                }
                if let Some(g) = dest.and_then(|id| self.group_mut(id)) {
                    g.active = g.tabs.iter().position(|p| *p == active).unwrap_or(0);
                }
            }
            Operation::Activate(id, i) => {
                let g = self.group_mut(id).ok_or(LayoutError::Missing)?;
                if i >= g.tabs.len() {
                    return Err(LayoutError::InvalidTarget);
                }
                g.active = i;
            }
            Operation::Reorder(id, from, to) => {
                let g = self.group_mut(id).ok_or(LayoutError::Missing)?;
                if from >= g.tabs.len() || to >= g.tabs.len() {
                    return Err(LayoutError::InvalidTarget);
                }
                let active = g.tabs[g.active].clone();
                let p = g.tabs.remove(from);
                g.tabs.insert(to, p);
                g.active = g.tabs.iter().position(|p| *p == active).unwrap_or(0);
            }
            Operation::Close(p) => {
                self.take(&p)?;
                self.closed.push(p);
            }
            Operation::Reopen(p) => {
                if !self.closed.contains(&p) {
                    return Err(LayoutError::Missing);
                }
                self.restore(p)?;
            }
            Operation::DockBack(id) => {
                let f = self
                    .floats
                    .iter()
                    .find(|f| f.id == id)
                    .ok_or(LayoutError::Missing)?;
                let mut groups = vec![];
                f.root.groups(&mut groups);
                let panels: Vec<_> = groups.iter().flat_map(|g| g.tabs.clone()).collect();
                for p in panels {
                    self.restore(p)?;
                }
            }
            Operation::Collapse(id, on) => {
                let g = self.group_mut(id).ok_or(LayoutError::Missing)?;
                if on && g.tabs.iter().any(|p| p.kind == "stage") {
                    return Err(LayoutError::InvalidTarget);
                }
                g.collapsed = on;
            }
            Operation::Resize {
                split,
                index,
                first,
                second,
            } => {
                let kids = self.split_mut(split)?;
                if index + 1 >= kids.len() {
                    return Err(LayoutError::InvalidTarget);
                }
                kids[index].size = first;
                kids[index + 1].size = second;
            }
            Operation::ResetDivider { split, index } => {
                let kids = self.split_mut(split)?;
                if index + 1 >= kids.len() {
                    return Err(LayoutError::InvalidTarget);
                }
                for k in &mut kids[index..=index + 1] {
                    k.size = match k.size {
                        Sz::Flex(_) => Sz::Flex(1.),
                        Sz::Px(_) => Sz::Px(320.),
                    };
                }
            }
            Operation::NewStage => {
                let panels = self.panels();
                let n = (0..4)
                    .find(|n| {
                        !panels.contains(&PanelId {
                            kind: "stage".into(),
                            n: *n,
                        })
                    })
                    .ok_or(LayoutError::Limit)?;
                let p = PanelId {
                    kind: "stage".into(),
                    n,
                };
                self.closed.push(p.clone());
                let group = self
                    .groups()
                    .iter()
                    .find(|g| g.tabs.iter().any(|p| p.kind == "stage"))
                    .map(|g| g.id)
                    .ok_or(LayoutError::LastStage)?;
                self.move_panel(
                    p,
                    Zone::Split {
                        group,
                        side: Side::Right,
                    },
                )?;
            }
            Operation::JoinLayers => {
                self.take(&PanelId::new("layers"))?;
                self.joined_layers = true;
            }
            Operation::Reset => *self = essentials(w),
        }
        Ok(())
    }
    fn split_mut(&mut self, id: u32) -> Result<&mut Vec<Kid>, LayoutError> {
        fn find(n: &mut Node, id: u32) -> Option<&mut Vec<Kid>> {
            if let Node::Split { id: nid, kids, .. } = n {
                if *nid == id {
                    return Some(kids);
                }
                return kids.iter_mut().find_map(|k| find(&mut k.node, id));
            }
            None
        }
        if let Some(k) = self.main.as_mut().and_then(|n| find(n, id)) {
            return Ok(k);
        }
        self.floats
            .iter_mut()
            .find_map(|f| find(&mut f.root, id))
            .ok_or(LayoutError::Missing)
    }
    fn restore(&mut self, p: PanelId) -> Result<(), LayoutError> {
        let hint = self
            .returns
            .get(&p)
            .cloned()
            .unwrap_or_else(|| ReturnPlacement {
                side: spec(&p.kind).map_or(Side::Right, |s| s.home),
                ..Default::default()
            });
        if hint.group == 0 && p.kind == "tools" {
            return self.move_panel(p, Zone::StageTools { side: hint.side });
        }
        if hint.group == 0 && p.kind == "layers" {
            self.take(&p)?;
            self.joined_layers = true;
            return Ok(());
        }
        let z = if self.groups().iter().any(|g| g.id == hint.group) {
            Zone::Tab {
                group: hint.group,
                index: hint.index,
            }
        } else if let Some(id) = hint.sibling.filter(|id| self.has_node(*id)) {
            Zone::Split {
                group: id,
                side: hint.side,
            }
        } else {
            Zone::WindowEdge { side: hint.side }
        };
        let recreate = !self.has_node(hint.group) && hint.group != 0;
        self.move_panel(p.clone(), z)?;
        if recreate {
            let gid = self
                .groups()
                .iter()
                .find(|g| g.tabs.contains(&p))
                .map(|g| g.id)
                .ok_or(LayoutError::Missing)?;
            fn restore_size(n: &mut Node, gid: u32, size: Sz) {
                if let Node::Split { kids, .. } = n {
                    for k in kids {
                        if k.node.id() == gid {
                            k.size = size;
                        } else {
                            restore_size(&mut k.node, gid, size);
                        }
                    }
                }
            }
            for n in self
                .main
                .iter_mut()
                .chain(self.floats.iter_mut().map(|f| &mut f.root))
            {
                restore_size(n, gid, hint.size);
            }
            if let Some(g) = self.group_mut(gid) {
                g.id = hint.group;
            }
        }
        Ok(())
    }
    pub fn has_node(&self, id: u32) -> bool {
        fn has(n: &Node, id: u32) -> bool {
            n.id() == id || matches!(n,Node::Split{kids,..} if kids.iter().any(|k|has(&k.node,id)))
        }
        self.main
            .iter()
            .chain(self.floats.iter().map(|f| &f.root))
            .any(|n| has(n, id))
    }
    fn take(&mut self, p: &PanelId) -> Result<(), LayoutError> {
        if let Some(g) = self.groups().iter().find(|g| g.tabs.contains(p)) {
            let gid = g.id;
            let index = g.tabs.iter().position(|x| x == p).unwrap_or(0);
            // A float keeps the return anchor captured at tear-off, even after tab merging.
            if self.main.as_ref().is_some_and(|n| {
                let mut v = vec![];
                n.groups(&mut v);
                v.iter().any(|g| g.id == gid)
            }) {
                fn anchor(n: &Node, gid: u32) -> Option<(u32, Side, Sz)> {
                    if let Node::Split { axis, kids, .. } = n {
                        for (i, k) in kids.iter().enumerate() {
                            if k.node.id() == gid {
                                let j = if i == 0 { 1 } else { i - 1 };
                                let side = match (*axis, i == 0) {
                                    (Axis::Horizontal, true) => Side::Left,
                                    (Axis::Horizontal, false) => Side::Right,
                                    (Axis::Vertical, true) => Side::Top,
                                    _ => Side::Bottom,
                                };
                                return Some((kids[j].node.id(), side, k.size));
                            }
                            if let Some(a) = anchor(&k.node, gid) {
                                return Some(a);
                            }
                        }
                    }
                    None
                }
                let a = self.main.as_ref().and_then(|n| anchor(n, gid));
                self.returns.insert(
                    p.clone(),
                    ReturnPlacement {
                        group: gid,
                        index,
                        sibling: a.map(|a| a.0),
                        side: a.map_or(Side::Right, |a| a.1),
                        size: a.map_or(Sz::Px(320.), |a| a.2),
                    },
                );
            }
            if let Some(g) = self.group_mut(gid) {
                let active = g.tabs.get(g.active).cloned();
                g.tabs.retain(|x| x != p);
                g.active = active
                    .and_then(|a| g.tabs.iter().position(|p| *p == a))
                    .unwrap_or(0);
            }
            self.main = self.main.take().and_then(normalize);
            self.floats = std::mem::take(&mut self.floats)
                .into_iter()
                .filter_map(|mut f| {
                    f.root = normalize(f.root)?;
                    Some(f)
                })
                .collect();
            return Ok(());
        }
        if p.kind == "tools"
            && let Some(side) = self.stage_tools.take()
        {
            self.returns.insert(
                p.clone(),
                ReturnPlacement {
                    side,
                    ..Default::default()
                },
            );
            return Ok(());
        }
        if p.kind == "layers" && self.joined_layers {
            self.joined_layers = false;
            return Ok(());
        }
        if let Some(i) = self.closed.iter().position(|x| x == p) {
            self.closed.remove(i);
            return Ok(());
        }
        Err(LayoutError::Missing)
    }
    fn move_panel(&mut self, p: PanelId, z: Zone) -> Result<(), LayoutError> {
        if let Zone::Tab { group, index } = z
            && let Some(g) = self.group_mut(group)
            && let Some(from) = g.tabs.iter().position(|x| *x == p)
        {
            let p = g.tabs.remove(from);
            let i = if index > from { index - 1 } else { index }.min(g.tabs.len());
            g.tabs.insert(i, p);
            g.active = i;
            return Ok(());
        }
        if matches!(z,Zone::Split{group,..} if self.groups().iter().any(|g|g.id==group&&g.tabs.len()==1&&g.tabs.contains(&p)))
        {
            return Err(LayoutError::InvalidTarget);
        }
        self.take(&p)?;
        if let Zone::Tab { group, index } = z {
            let g = self.group_mut(group).ok_or(LayoutError::InvalidTarget)?;
            let i = index.min(g.tabs.len());
            g.tabs.insert(i, p);
            g.active = i;
            return Ok(());
        }
        if let Zone::StageTools { side } = z {
            if p.kind != "tools" || !matches!(side, Side::Left | Side::Right) {
                return Err(LayoutError::InvalidTarget);
            }
            self.stage_tools = Some(side);
            return Ok(());
        }
        let id = self.next_id();
        if id >= u32::MAX - 1 {
            return Err(LayoutError::Limit);
        }
        let node = Node::Tabs(TabGroup {
            id,
            tabs: vec![p.clone()],
            active: 0,
            collapsed: false,
            flyout_px: 320.,
        });
        let side = match z {
            Zone::WindowEdge { side } | Zone::Split { side, .. } => side,
            _ => Side::Right,
        };
        let pref = spec(&p.kind).map_or(Size { w: 320., h: 240. }, |s| s.pref);
        let size = Sz::Px(if side.axis() == Axis::Horizontal {
            pref.w
        } else {
            pref.h
        });
        match z {
            Zone::Float { rect } => {
                if !rect.valid() {
                    return Err(LayoutError::InvalidGeometry);
                }
                self.floats.push(Float {
                    id: id + 1,
                    root: node,
                    frames: Frames {
                        monitor: 0,
                        relative: Rect {
                            x: 0.1,
                            y: 0.1,
                            w: 0.3,
                            h: 0.5,
                        },
                        by_setup: std::collections::VecDeque::from([(0, rect)]),
                    },
                });
            }
            Zone::WindowEdge { side } => {
                self.main = Some(if let Some(old) = self.main.take() {
                    wrap(old, node, id + 1, side, size)
                } else {
                    node
                });
            }
            Zone::Split { group, side } => {
                fn insert(
                    n: &mut Node,
                    target: u32,
                    new: &Node,
                    id: u32,
                    side: Side,
                    size: Sz,
                ) -> bool {
                    if n.id() == target {
                        *n = wrap(n.clone(), new.clone(), id, side, size);
                        true
                    } else if let Node::Split { kids, .. } = n {
                        kids.iter_mut()
                            .any(|k| insert(&mut k.node, target, new, id, side, size))
                    } else {
                        false
                    }
                }
                if !self
                    .main
                    .iter_mut()
                    .chain(self.floats.iter_mut().map(|f| &mut f.root))
                    .any(|n| insert(n, group, &node, id + 1, side, size))
                {
                    return Err(LayoutError::InvalidTarget);
                }
            }
            Zone::Between { split, index } => {
                let kids = self.split_mut(split)?;
                if index > kids.len() {
                    return Err(LayoutError::InvalidTarget);
                }
                kids.insert(
                    index,
                    Kid {
                        node,
                        size: Sz::Flex(1.),
                    },
                );
            }
            _ => return Err(LayoutError::InvalidTarget),
        }
        Ok(())
    }
}
fn wrap(old: Node, new: Node, id: u32, side: Side, size: Sz) -> Node {
    let mut kids = vec![Kid {
        node: old,
        size: Sz::Flex(1.),
    }];
    kids.insert(if side.before() { 0 } else { 1 }, Kid { node: new, size });
    Node::Split {
        id,
        axis: side.axis(),
        kids,
    }
}
fn normalize(n: Node) -> Option<Node> {
    match n {
        Node::Tabs(g) => {
            if g.tabs.is_empty() {
                None
            } else {
                Some(Node::Tabs(g))
            }
        }
        Node::Split { id, axis, kids } => {
            let mut kids: Vec<_> = kids
                .into_iter()
                .filter_map(|k| {
                    Some(Kid {
                        node: normalize(k.node)?,
                        size: k.size,
                    })
                })
                .collect();
            match kids.len() {
                0 => None,
                1 => Some(kids.remove(0).node),
                _ => Some(Node::Split { id, axis, kids }),
            }
        }
    }
}

impl Layout {
    /// Neighbour-only resize in solved pixels; Flex weights keep their combined weight.
    pub fn resize_divider(
        &mut self,
        solution: &Solution,
        split: u32,
        index: usize,
        delta: f64,
        workspace: Workspace,
    ) -> Result<Vec<LayoutEvent>, LayoutError> {
        if !delta.is_finite() {
            return Err(LayoutError::InvalidGeometry);
        }
        let d = solution
            .dividers
            .iter()
            .find(|d| d.split == split && d.index == index)
            .ok_or(LayoutError::Missing)?;
        if !d.min.is_finite() || !d.max.is_finite() || d.min > d.max {
            return Err(LayoutError::InvalidGeometry);
        }
        let kids = self.split_mut(split)?;
        if index + 1 >= kids.len() {
            return Err(LayoutError::InvalidTarget);
        }
        let a = kids[index].size;
        let b = kids[index + 1].size;
        let length = |n: &Node| -> Option<f64> {
            let mut gs = vec![];
            n.groups(&mut gs);
            let rects: Vec<_> = gs
                .iter()
                .filter_map(|g| solution.groups.get(&g.id).or(solution.strips.get(&g.id)))
                .collect();
            let lo = rects
                .iter()
                .map(|r| if d.axis == Axis::Horizontal { r.x } else { r.y })
                .reduce(f64::min)?;
            let hi = rects
                .iter()
                .map(|r| {
                    if d.axis == Axis::Horizontal {
                        r.x + r.w
                    } else {
                        r.y + r.h
                    }
                })
                .reduce(f64::max)?;
            Some(hi - lo)
        };
        let b_now = length(&kids[index + 1].node).ok_or(LayoutError::InvalidTarget)?;
        let next = (d.now + delta).clamp(d.min, d.max);
        let total = d.now + b_now;
        let rest = (total - next).max(f64::EPSILON);
        let (first, second) = match (a, b) {
            (Sz::Px(_), Sz::Px(_)) => (Sz::Px(next), Sz::Px(rest)),
            (Sz::Px(_), Sz::Flex(v)) => (Sz::Px(next), Sz::Flex(v)),
            (Sz::Flex(v), Sz::Px(_)) => (Sz::Flex(v), Sz::Px(rest)),
            (Sz::Flex(x), Sz::Flex(y)) => {
                let sum = x + y;
                (
                    Sz::Flex((sum * next / total).max(f64::EPSILON)),
                    Sz::Flex((sum * rest / total).max(f64::EPSILON)),
                )
            }
        };
        self.apply(
            Operation::Resize {
                split,
                index,
                first,
                second,
            },
            workspace,
        )
    }
}
