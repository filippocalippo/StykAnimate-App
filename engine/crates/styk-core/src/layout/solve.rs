use super::*;
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Wide,
    Regular,
    Narrow,
    Compact,
    Minimal,
}
pub fn tier(width: f64) -> Tier {
    if width <= 660. {
        Tier::Minimal
    } else if width <= 800. {
        Tier::Compact
    } else if width <= 1180. {
        Tier::Narrow
    } else if width <= 1366. {
        Tier::Regular
    } else {
        Tier::Wide
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fold {
    Strip,
    Sheet,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FitState {
    pub folded: BTreeMap<GroupId, Fold>,
    pub sides: BTreeMap<GroupId, Side>,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FloatHost {
    Os,
    InWindow,
    Sheet,
}
#[derive(Clone, Debug)]
pub struct Screen {
    pub key: u64,
    pub work: Rect,
    pub scale: f64,
    pub primary: bool,
}
#[derive(Clone, Debug)]
pub struct Env {
    pub window: Size,
    pub screens: Vec<Screen>,
    pub setup: u64,
    pub float_host: FloatHost,
    pub previous: FitState,
    pub open: Option<GroupId>,
}
impl Env {
    pub fn new(w: f64, h: f64) -> Self {
        Self {
            window: Size { w, h },
            screens: vec![],
            setup: 0,
            float_host: FloatHost::Os,
            previous: FitState::default(),
            open: None,
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Divider {
    pub split: NodeId,
    pub index: usize,
    pub rect: Rect,
    pub axis: Axis,
    pub min: f64,
    pub max: f64,
    pub now: f64,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Solution {
    pub groups: BTreeMap<GroupId, Rect>,
    pub headers: BTreeMap<GroupId, Rect>,
    pub dividers: Vec<Divider>,
    pub floats: BTreeMap<FloatId, Rect>,
    pub visible: BTreeSet<PanelId>,
    pub stages: BTreeMap<PanelId, Rect>,
    pub strips: BTreeMap<GroupId, Rect>,
    pub sheets: BTreeMap<GroupId, Rect>,
    pub fit: FitState,
}
fn group_min(g: &TabGroup) -> Size {
    g.tabs
        .iter()
        .filter_map(|p| spec(&p.kind))
        .fold(Size::default(), |a, s| Size {
            w: a.w.max(s.min.w),
            h: a.h.max(s.min.h),
        })
}
fn axis(s: Size, a: Axis) -> f64 {
    if a == Axis::Horizontal { s.w } else { s.h }
}
fn minimum(n: &Node, fold: &BTreeMap<u32, Fold>, sides: &BTreeMap<u32, Side>, gap: f64) -> Size {
    match n {
        Node::Tabs(g) => match fold.get(&g.id) {
            Some(Fold::Sheet) => Size::default(),
            Some(Fold::Strip) => {
                let s = sides.get(&g.id).copied().unwrap_or(Side::Right);
                if s.axis() == Axis::Horizontal {
                    Size { w: 40., h: 0. }
                } else {
                    Size { w: 0., h: 40. }
                }
            }
            None => group_min(g),
        },
        Node::Split { axis: a, kids, .. } => {
            let mut out = Size::default();
            for k in kids {
                let m = minimum(&k.node, fold, sides, gap);
                if *a == Axis::Horizontal {
                    out.w += m.w;
                    out.h = out.h.max(m.h)
                } else {
                    out.h += m.h;
                    out.w = out.w.max(m.w)
                }
            }
            let gaps = gap * kids.len().saturating_sub(1) as f64;
            if *a == Axis::Horizontal {
                out.w += gaps
            } else {
                out.h += gaps
            }
            out
        }
    }
}
/// Pure fitting. Previous transient folds supply directional hysteresis; never save the returned rectangles.
pub fn solve(l: &Layout, e: &Env) -> Solution {
    let w = if e.window.w.is_finite() {
        e.window.w.max(0.)
    } else {
        0.
    };
    let h = if e.window.h.is_finite() {
        e.window.h.max(0.)
    } else {
        0.
    };
    let t = tier(w);
    let gap = match t {
        Tier::Compact | Tier::Minimal => 0.,
        Tier::Narrow => 4.,
        _ => 6.,
    };
    let band: f64 = if h >= 801. { 52. } else { 44. };
    let rect = Rect {
        x: if w <= 660. {
            4f64.min(w / 2.)
        } else {
            8f64.min(w / 2.)
        },
        y: (band + if h >= 801. { 8. } else { 6. }).min(h),
        w: (w - if w <= 660. { 8. } else { 16. }).max(0.),
        h: (h - band - if h >= 801. { 8. } else { 6. } - if h <= 568. { 4. } else { 8. }).max(0.),
    };
    let mut out = Solution {
        fit: FitState {
            width: w,
            height: h,
            ..Default::default()
        },
        ..Default::default()
    };
    fn positions(n: &Node, side: Side, out: &mut BTreeMap<u32, Side>) {
        match n {
            Node::Tabs(g) => {
                out.insert(g.id, side);
            }
            Node::Split { axis, kids, .. } => {
                let stage = kids.iter().position(|k| {
                    let mut g = vec![];
                    k.node.groups(&mut g);
                    g.iter().any(|g| g.tabs.iter().any(|p| p.kind == "stage"))
                });
                for (i, k) in kids.iter().enumerate() {
                    let next = if let Some(at) = stage {
                        if i == at {
                            side
                        } else {
                            match (*axis, i < at) {
                                (Axis::Horizontal, true) => Side::Left,
                                (Axis::Horizontal, false) => Side::Right,
                                (Axis::Vertical, true) => Side::Top,
                                _ => Side::Bottom,
                            }
                        }
                    } else {
                        side
                    };
                    positions(&k.node, next, out);
                }
            }
        }
    }
    if let Some(n) = &l.main {
        positions(n, Side::Right, &mut out.fit.sides);
    }
    let mut groups = vec![];
    if let Some(n) = &l.main {
        n.groups(&mut groups)
    }
    let mut candidates: Vec<_> = groups
        .iter()
        .filter(|g| !g.tabs.iter().any(|p| p.kind == "stage"))
        .copied()
        .collect();
    candidates.sort_by_key(|g| {
        (
            g.tabs
                .iter()
                .filter_map(|p| spec(&p.kind))
                .map(|s| s.keep)
                .max()
                .unwrap_or(0),
            g.id,
        )
    });
    for g in &candidates {
        let side = out.fit.sides.get(&g.id).copied().unwrap_or(Side::Right);
        if g.collapsed
            || matches!(t, Tier::Compact | Tier::Minimal)
            || (h <= 568. && side == Side::Bottom)
        {
            out.fit.folded.insert(
                g.id,
                if matches!(t, Tier::Compact | Tier::Minimal) && side == Side::Right {
                    Fold::Sheet
                } else {
                    Fold::Strip
                },
            );
        }
    }
    if let Some(n) = &l.main {
        for phase in [Fold::Strip, Fold::Sheet] {
            for g in &candidates {
                let m = minimum(n, &out.fit.folded, &out.fit.sides, gap);
                if m.w <= rect.w && m.h <= rect.h {
                    break;
                }
                out.fit.folded.insert(g.id, phase);
            }
        }
        if w >= e.previous.width && h >= e.previous.height {
            for (id, fold) in &e.previous.folded {
                if out.fit.folded.contains_key(id) {
                    continue;
                }
                let m = minimum(n, &out.fit.folded, &out.fit.sides, gap);
                if m.w + 16. > rect.w
                    || m.h + 16. > rect.h
                    || (e.previous.width <= 800. && w < 816.)
                    || (e.previous.height <= 568. && h < 584.)
                {
                    out.fit.folded.insert(*id, *fold);
                }
            }
        }
        place(n, rect, gap, &mut out);
    }
    for f in &l.floats {
        let r = fit_float(&f.frames, e);
        out.floats.insert(f.id, r);
        let saved = std::mem::take(&mut out.fit.folded);
        place(&f.root, r, gap, &mut out);
        out.fit.folded = saved;
    }
    if let Some(id) = e.open
        && out.fit.folded.contains_key(&id)
        && let Some(g) = l.groups().iter().find(|g| g.id == id)
    {
        let r = Rect {
            x: rect.x,
            y: rect.y,
            w: g.flyout_px.min(rect.w),
            h: rect.h,
        };
        out.sheets.insert(id, r);
        if let Some(p) = g.tabs.get(g.active) {
            out.visible.insert(p.clone());
        }
    }
    if l.stage_tools.is_some() && out.visible.iter().any(|p| p.kind == "stage") {
        out.visible.insert(PanelId::new("tools"));
    }
    if l.joined_layers && out.visible.contains(&PanelId::new("timeline")) {
        out.visible.insert(PanelId::new("layers"));
    }
    out
}
fn node_max(n: &Node, a: Axis, total: f64) -> f64 {
    let Node::Tabs(g) = n else {
        return f64::INFINITY;
    };
    let max = g
        .tabs
        .iter()
        .map(|p| {
            spec(&p.kind)
                .and_then(|s| s.max)
                .map_or(f64::INFINITY, |s| axis(s, a))
        })
        .fold(0., f64::max);
    if a == Axis::Vertical && g.tabs.iter().any(|p| p.kind == "timeline") {
        max.min(total * 0.6)
    } else {
        max
    }
}
fn clamp_px(n: &Node, a: Axis, value: f64, total: f64) -> f64 {
    value.min(node_max(n, a, total))
}
fn expanded(n: &Node, fold: &BTreeMap<u32, Fold>) -> bool {
    match n {
        Node::Tabs(g) => !fold.contains_key(&g.id),
        Node::Split { kids, .. } => kids.iter().any(|k| expanded(&k.node, fold)),
    }
}
fn place(n: &Node, r: Rect, gap: f64, out: &mut Solution) {
    match n {
        Node::Tabs(g) => {
            if let Some(f) = out.fit.folded.get(&g.id) {
                match f {
                    Fold::Strip => {
                        out.strips.insert(g.id, r);
                    }
                    Fold::Sheet => {
                        out.sheets.insert(g.id, r);
                    }
                }
                return;
            }
            out.groups.insert(g.id, r);
            out.headers.insert(
                g.id,
                Rect {
                    h: 40f64.min(r.h),
                    ..r
                },
            );
            if let Some(p) = g.tabs.get(g.active) {
                out.visible.insert(p.clone());
                if p.kind == "stage" {
                    out.stages.insert(
                        p.clone(),
                        Rect {
                            x: r.x,
                            y: r.y + 44f64.min(r.h),
                            w: r.w,
                            h: (r.h - 44.).max(0.),
                        },
                    );
                }
            }
        }
        Node::Split { id, axis: a, kids } => {
            let total = if *a == Axis::Horizontal { r.w } else { r.h };
            let gap = (if *a == Axis::Horizontal && gap > 0. {
                8.
            } else {
                gap
            })
            .min(total / (kids.len().max(1) as f64));
            let available = (total - gap * kids.len().saturating_sub(1) as f64).max(0.);
            let mins: Vec<_> = kids
                .iter()
                .map(|k| axis(minimum(&k.node, &out.fit.folded, &out.fit.sides, gap), *a))
                .collect();
            let minsum: f64 = mins.iter().sum();
            let mut sizes = mins.clone();
            let extra = (available - minsum).max(0.);
            let demands: Vec<_> = kids
                .iter()
                .zip(&mins)
                .map(|(k, m)| {
                    if !expanded(&k.node, &out.fit.folded) {
                        0.
                    } else {
                        match k.size {
                            Sz::Px(v) => (clamp_px(&k.node, *a, v, available) - m).max(0.),
                            _ => 0.,
                        }
                    }
                })
                .collect();
            let demand: f64 = demands.iter().sum();
            let px_extra = extra.min(demand);
            for (s, d) in sizes.iter_mut().zip(&demands) {
                if demand > 0. {
                    *s += px_extra * d / demand
                }
            }
            let flex: f64 = kids
                .iter()
                .map(|k| {
                    if expanded(&k.node, &out.fit.folded) {
                        match k.size {
                            Sz::Flex(v) => v,
                            _ => 0.,
                        }
                    } else {
                        0.
                    }
                })
                .sum();
            let remaining = extra - px_extra;
            let eligible: f64 = kids
                .iter()
                .zip(&sizes)
                .filter(|(k, _)| expanded(&k.node, &out.fit.folded))
                .map(|(_, v)| *v)
                .sum();
            let eligible_count = kids
                .iter()
                .filter(|k| expanded(&k.node, &out.fit.folded))
                .count()
                .max(1);
            for (i, k) in kids.iter().enumerate() {
                if !expanded(&k.node, &out.fit.folded) {
                    continue;
                }
                if flex > 0. {
                    if let Sz::Flex(v) = k.size {
                        sizes[i] += remaining * v / flex
                    }
                } else {
                    sizes[i] += remaining
                        * if eligible > 0. {
                            sizes[i] / eligible
                        } else {
                            1. / eligible_count as f64
                        };
                }
            }
            if minsum > available && minsum > 0. {
                for s in &mut sizes {
                    *s *= available / minsum
                }
            }
            let mut at = if *a == Axis::Horizontal { r.x } else { r.y };
            for (i, k) in kids.iter().enumerate() {
                let child = if *a == Axis::Horizontal {
                    Rect {
                        x: at,
                        w: sizes[i],
                        ..r
                    }
                } else {
                    Rect {
                        y: at,
                        h: sizes[i],
                        ..r
                    }
                };
                place(&k.node, child, gap, out);
                at += sizes[i];
                if i + 1 < kids.len() {
                    let dr = if *a == Axis::Horizontal {
                        Rect { x: at, w: gap, ..r }
                    } else {
                        Rect { y: at, h: gap, ..r }
                    };
                    out.dividers.push(Divider {
                        split: *id,
                        index: i,
                        rect: dr,
                        axis: *a,
                        min: mins[i].max(
                            sizes[i] + sizes[i + 1] - node_max(&kids[i + 1].node, *a, available),
                        ),
                        max: (sizes[i] + sizes[i + 1] - mins[i + 1])
                            .min(node_max(&kids[i].node, *a, available))
                            .max(mins[i]),
                        now: sizes[i],
                    });
                    at += gap;
                }
            }
        }
    }
}
pub fn fit_float(f: &Frames, e: &Env) -> Rect {
    let remembered = f
        .by_setup
        .iter()
        .find(|(k, _)| *k == e.setup)
        .or_else(|| f.by_setup.iter().find(|(k, _)| *k == 0))
        .map(|(_, r)| *r);
    let screen = remembered
        .and_then(|r| {
            e.screens
                .iter()
                .find(|s| s.work.contains(r.x + r.w / 2., r.y + 20.))
        })
        .or_else(|| e.screens.iter().find(|s| s.key == f.monitor))
        .or_else(|| e.screens.iter().find(|s| s.primary))
        .or(e.screens.first());
    let fallback = Rect {
        x: 0.,
        y: 0.,
        w: e.window.w.max(1.),
        h: e.window.h.max(1.),
    };
    let work = if e.float_host == FloatHost::Os {
        screen.map_or(fallback, |s| s.work)
    } else {
        fallback
    };
    let r = remembered.unwrap_or(Rect {
        x: work.x + f.relative.x * work.w,
        y: work.y + f.relative.y * work.h,
        w: f.relative.w * work.w,
        h: f.relative.h * work.h,
    });
    let w = r.w.min(work.w).max(1.);
    let h = r.h.min(work.h).max(1.);
    Rect {
        x: r.x.clamp(work.x, work.x + (work.w - w).max(0.)),
        y: r.y.clamp(work.y, work.y + (work.h - h).max(0.)),
        w,
        h,
    }
}
/// Snap only when the caller's platform supports global window coordinates.
pub fn snap(mut r: Rect, targets: &[Rect], threshold: f64) -> Rect {
    let original = r;
    let mut dx = threshold.max(0.);
    let mut dy = dx;
    for t in targets {
        for x in [t.x, t.x + t.w, t.x - original.w, t.x + t.w - original.w] {
            let d = (x - original.x).abs();
            if d < dx {
                dx = d;
                r.x = x;
            }
        }
        for y in [t.y, t.y + t.h, t.y - original.h, t.y + t.h - original.h] {
            let d = (y - original.y).abs();
            if d < dy {
                dy = d;
                r.y = y;
            }
        }
    }
    r
}
/// Targets and their preview are derived from the same transaction used on release.
pub fn preview(
    l: &Layout,
    p: &PanelId,
    z: Zone,
    e: &Env,
    w: Workspace,
) -> Result<(Layout, Rect), LayoutError> {
    let mut next = l.clone();
    next.apply(Operation::Move(p.clone(), z), w)?;
    let solution = solve(&next, e);
    let gid = next
        .groups()
        .iter()
        .find(|g| g.tabs.contains(p))
        .map(|g| g.id);
    let r = gid
        .and_then(|id| {
            solution
                .groups
                .get(&id)
                .or(solution.strips.get(&id))
                .or(solution.sheets.get(&id))
        })
        .copied()
        .or_else(|| solution.stages.values().next().copied())
        .ok_or(LayoutError::InvalidTarget)?;
    Ok((next, r))
}
pub fn drop_zone(l: &Layout, p: &PanelId, s: &Solution, e: &Env, x: f64, y: f64) -> Zone {
    for (id, r) in &s.headers {
        if r.contains(x, y) {
            let count = l
                .groups()
                .iter()
                .find(|g| g.id == *id)
                .map_or(1, |g| g.tabs.len());
            return Zone::Tab {
                group: *id,
                index: (((x - r.x) / r.w.max(1.)) * count as f64).round() as usize,
            };
        }
    }
    for d in &s.dividers {
        let r = Rect {
            x: d.rect.x - 5.,
            y: d.rect.y - 5.,
            w: d.rect.w + 10.,
            h: d.rect.h + 10.,
        };
        if r.contains(x, y) {
            return Zone::Between {
                split: d.split,
                index: d.index + 1,
            };
        }
    }
    if x >= 0. && y >= 0. && x < e.window.w && y < e.window.h {
        for (hit, side) in [
            (x < 16., Side::Left),
            (x > e.window.w - 16., Side::Right),
            (y < 16., Side::Top),
            (y > e.window.h - 16., Side::Bottom),
        ] {
            if hit {
                return Zone::WindowEdge { side };
            }
        }
    }
    for (id, r) in &s.groups {
        if r.contains(x, y) {
            if p.kind == "tools"
                && l.groups()
                    .iter()
                    .any(|g| g.id == *id && g.tabs.iter().any(|p| p.kind == "stage"))
            {
                if x - r.x < 48. {
                    return Zone::StageTools { side: Side::Left };
                }
                if r.x + r.w - x < 48. {
                    return Zone::StageTools { side: Side::Right };
                }
            }
            let rx = (x - r.x) / r.w.max(1.);
            let ry = (y - r.y) / r.h.max(1.);
            for (hit, side) in [
                (rx < 0.25, Side::Left),
                (rx > 0.75, Side::Right),
                (ry < 0.25, Side::Top),
                (ry > 0.75, Side::Bottom),
            ] {
                if hit {
                    return Zone::Split { group: *id, side };
                }
            }
            return Zone::Tab {
                group: *id,
                index: usize::MAX,
            };
        }
    }
    Zone::Float {
        rect: Rect {
            x,
            y,
            w: 320.,
            h: 400.,
        },
    }
}

/// A drag owns a snapshot; no operation reaches the live layout until release.
#[derive(Clone, Debug)]
pub struct DragSession {
    pub source: PanelId,
    origin: Layout,
    pub zone: Option<Zone>,
    pub preview: Option<Rect>,
    bounds: Option<Rect>,
}
impl DragSession {
    pub fn new(layout: &Layout, source: PanelId) -> Result<Self, LayoutError> {
        if !layout.panels().contains(&source) {
            return Err(LayoutError::Missing);
        }
        Ok(Self {
            source,
            origin: layout.clone(),
            zone: None,
            preview: None,
            bounds: None,
        })
    }
    pub fn moved(&mut self, e: &Env, x: f64, y: f64, w: Workspace) -> Result<(), LayoutError> {
        if !x.is_finite() || !y.is_finite() {
            return Err(LayoutError::InvalidGeometry);
        }
        if self.bounds.is_some_and(|r| {
            Rect {
                x: r.x - 4.,
                y: r.y - 4.,
                w: r.w + 8.,
                h: r.h + 8.,
            }
            .contains(x, y)
        }) {
            return Ok(());
        }
        let solved = solve(&self.origin, e);
        let zone = drop_zone(&self.origin, &self.source, &solved, e, x, y);
        match preview(&self.origin, &self.source, zone.clone(), e, w) {
            Ok((_, r)) => {
                self.preview = Some(r);
                self.bounds = Some(zone_bounds(&zone, &solved, e));
                self.zone = Some(zone);
                Ok(())
            }
            Err(err) => {
                self.zone = None;
                self.preview = None;
                self.bounds = None;
                Err(err)
            }
        }
    }
    pub fn release(
        self,
        layout: &mut Layout,
        w: Workspace,
    ) -> Result<Vec<LayoutEvent>, LayoutError> {
        if *layout != self.origin {
            return Err(LayoutError::InvalidTarget);
        }
        let zone = self.zone.ok_or(LayoutError::InvalidTarget)?;
        layout.apply(Operation::Move(self.source, zone), w)
    }
    /// Cancellation drops only the snapshot and preview; the live owner was never changed.
    pub fn cancel(self) {}
}
fn zone_bounds(zone: &Zone, s: &Solution, e: &Env) -> Rect {
    match zone {
        Zone::Tab { group, .. } => s
            .headers
            .get(group)
            .or(s.groups.get(group))
            .copied()
            .unwrap_or_default(),
        Zone::Split { group, side } => {
            let r = s.groups.get(group).copied().unwrap_or_default();
            match side {
                Side::Left => Rect { w: r.w * 0.25, ..r },
                Side::Right => Rect {
                    x: r.x + r.w * 0.75,
                    w: r.w * 0.25,
                    ..r
                },
                Side::Top => Rect { h: r.h * 0.25, ..r },
                Side::Bottom => Rect {
                    y: r.y + r.h * 0.75,
                    h: r.h * 0.25,
                    ..r
                },
            }
        }
        Zone::WindowEdge { side } => match side {
            Side::Left => Rect {
                x: 0.,
                y: 0.,
                w: 16.,
                h: e.window.h,
            },
            Side::Right => Rect {
                x: e.window.w - 16.,
                y: 0.,
                w: 16.,
                h: e.window.h,
            },
            Side::Top => Rect {
                x: 0.,
                y: 0.,
                w: e.window.w,
                h: 16.,
            },
            Side::Bottom => Rect {
                x: 0.,
                y: e.window.h - 16.,
                w: e.window.w,
                h: 16.,
            },
        },
        Zone::Between { split, index } => s
            .dividers
            .iter()
            .find(|d| d.split == *split && d.index + 1 == *index)
            .map(|d| d.rect)
            .unwrap_or_default(),
        // Float movement and tools targets recompute every sample.
        _ => Rect::default(),
    }
}

impl Env {
    /// Adapt S6's physical monitor records; no platform handles cross into docking.
    pub fn with_monitors(
        mut self,
        monitors: &[styk_services::shell::window_state::MonitorInfo],
    ) -> Self {
        use styk_services::shell::window_state::SetupKey;
        self.setup = SetupKey::of(monitors).0;
        self.screens = monitors
            .iter()
            .map(|m| Screen {
                key: SetupKey::of(&[*m]).0,
                work: Rect {
                    x: m.work.x as f64,
                    y: m.work.y as f64,
                    w: m.work.w as f64,
                    h: m.work.h as f64,
                },
                scale: m.scale_milli as f64 / 1000.,
                primary: m.primary,
            })
            .collect();
        self
    }
}
impl Layout {
    /// Only explicit placement updates saved physical frames; fitting and hotplug do not call this.
    pub fn place_float(
        &mut self,
        id: FloatId,
        frame: Rect,
        e: &Env,
        w: Workspace,
    ) -> Result<(), LayoutError> {
        if !frame.valid() {
            return Err(LayoutError::InvalidGeometry);
        }
        let screen = e
            .screens
            .iter()
            .find(|s| s.work.contains(frame.x + frame.w / 2., frame.y + 20.))
            .or_else(|| e.screens.iter().find(|s| s.primary))
            .or(e.screens.first())
            .ok_or(LayoutError::Missing)?;
        if !screen.work.valid() {
            return Err(LayoutError::InvalidGeometry);
        }
        let mut next = self.clone();
        let f = next
            .floats
            .iter_mut()
            .find(|f| f.id == id)
            .ok_or(LayoutError::Missing)?;
        f.frames.remember(e.setup, frame)?;
        f.frames.monitor = screen.key;
        f.frames.relative = Rect {
            x: (frame.x - screen.work.x) / screen.work.w,
            y: (frame.y - screen.work.y) / screen.work.h,
            w: frame.w / screen.work.w,
            h: frame.h / screen.work.h,
        };
        UnknownRecords::prune(&mut next);
        next.validate(w)?;
        *self = next;
        Ok(())
    }
}
