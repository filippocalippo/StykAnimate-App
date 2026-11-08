//! Drop-zone labels and the places a keyboard move steps through; placement stays in layout.

use crate::layout::{Env, Layout, PanelId, Rect, Side, Workspace, Zone};

/// The words a drop zone is named by (the pill over the preview; the keyboard move's announcement).
pub fn zone_label(zone: &Zone) -> crate::i18n::Msg {
    let side = |side: &Side, words: [&'static str; 4]| match side {
        Side::Left => words[0],
        Side::Right => words[1],
        Side::Top => words[2],
        Side::Bottom => words[3],
    };
    crate::i18n::Msg::new(match zone {
        Zone::Tab { .. } => "dockTabs.addAsATab",
        Zone::Split { side: s, .. } => side(s, ["dock.splitLeft", "dock.splitRight", "dock.splitAbove", "dock.splitBelow"]),
        Zone::Between { .. } => "dock.insertHere",
        Zone::WindowEdge { side: s } => side(s, ["dockKeyboard.dockLeft", "dockKeyboard.dockRight", "dock.dockTop", "dock.dockBottom"]),
        Zone::Float { .. } => "dockKeyboard.floatHere",
        Zone::StageTools { side: s } => side(s, ["dockTabs.moveToolsLeft", "dockTabs.moveToolsRight", "dockTabs.moveToolsLeft", "dockTabs.moveToolsRight"]),
    })
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

