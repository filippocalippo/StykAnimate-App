//! What the docked window starts from and how a place is named: today's default timeline height, the words of a drop
//! zone, the places the keyboard steps through.

use crate::layout::{Axis, Env, Layout, LayoutError, Node, PanelId, Preset, Rect, Side, Sz, Workspace, Zone, preset};

/// The island chrome the timeline carries above today's stored body height (`timelineDefaultHeight` is the body: the
/// panel's island is 16 px taller, as the window shows it).
const TIMELINE_CHROME: f64 = 16.0;

/// Today's default timeline height for a window `height` tall (`timelineDefaultHeight` in `src/shell/layout-solver.mjs`,
/// plus the island's chrome): 280 above 800 px, 264 from 641, 240 from 600, 212 below that, and the 40 px header at the low
/// tier (568 px and under). It is a function of the window height only; the layout stores it once.
pub fn default_timeline_height(height: f64) -> f64 {
    const HEADER: f64 = 40.0;
    const PINNED: f64 = 2.0 * 24.0;
    let low = height <= 568.0;
    let short = height <= 640.0;
    let (ruler, row) = if short { (24.0, 28.0) } else { (32.0, 32.0) };
    let slots = if height >= 801.0 {
        4.5
    } else if height >= 600.0 {
        4.0
    } else {
        3.0
    };
    if low {
        return HEADER + TIMELINE_CHROME;
    }
    (HEADER + ruler + PINNED + slots * row).round() + TIMELINE_CHROME
}

/// The arrangement a workspace starts with in a window `height` tall: its Essentials with today's timeline height.
pub fn default_layout(workspace: Workspace, height: f64) -> Result<Layout, LayoutError> {
    let mut layout = preset(workspace, Preset::Essentials, height)?;
    set_timeline(&mut layout, default_timeline_height(height));
    Ok(layout)
}

/// Gives the timeline's allocation under the stage (and any other vertical split of it) `height`.
pub fn set_timeline(layout: &mut Layout, height: f64) {
    fn visit(node: &mut Node, height: f64) {
        if let Node::Split { axis, kids, .. } = node {
            for kid in kids {
                if *axis == Axis::Vertical && matches!(&kid.node, Node::Tabs(g) if g.tabs.iter().any(|p| p.kind == "timeline")) {
                    kid.size = Sz::Px(height);
                } else {
                    visit(&mut kid.node, height);
                }
            }
        }
    }
    if let Some(node) = &mut layout.main {
        visit(node, height);
    }
}

/// The words a drop zone is named by (the pill over the preview; the keyboard move's announcement).
pub fn zone_label(zone: &Zone) -> &'static str {
    let side = |side: &Side, words: [&'static str; 4]| match side {
        Side::Left => words[0],
        Side::Right => words[1],
        Side::Top => words[2],
        Side::Bottom => words[3],
    };
    match zone {
        Zone::Tab { .. } => "Add as tab",
        Zone::Split { side: s, .. } => side(s, ["Split left", "Split right", "Split above", "Split below"]),
        Zone::Between { .. } => "Insert here",
        Zone::WindowEdge { side: s } => side(s, ["Dock left", "Dock right", "Dock top", "Dock bottom"]),
        Zone::Float { .. } => "Float here",
        Zone::StageTools { side: s } => side(s, ["Tools left", "Tools right", "Tools left", "Tools right"]),
    }
}

/// Every place `panel` could go by keyboard, in the order the solver lists the groups (tree reading order), each group's
/// tab then its four sides, then the four window edges. Only the places the core accepts remain: the same transaction as a
/// release decides, so a place named here is a place the move can reach.
pub fn keyboard_places(layout: &Layout, panel: &PanelId, env: &Env, workspace: Workspace) -> Vec<(Zone, Rect)> {
    let mut zones = Vec::new();
    for group in layout.groups() {
        zones.push(Zone::Tab { group: group.id, index: usize::MAX });
        for side in [Side::Left, Side::Right, Side::Top, Side::Bottom] {
            zones.push(Zone::Split { group: group.id, side });
        }
    }
    for side in [Side::Left, Side::Right, Side::Top, Side::Bottom] {
        zones.push(Zone::WindowEdge { side });
    }
    if panel.kind == "tools" {
        zones.push(Zone::StageTools { side: Side::Left });
        zones.push(Zone::StageTools { side: Side::Right });
    }
    zones
        .into_iter()
        .filter_map(|zone| {
            let (next, rect) = crate::layout::preview(layout, panel, zone.clone(), env, workspace).ok()?;
            // A place that leaves the arrangement as it is is not a move.
            (next != *layout).then_some((zone, rect))
        })
        .collect()
}

