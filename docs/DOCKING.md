# Docking

How the editor's panels are arranged (`src/shell/dock-*.mjs`). It replaces the
three-side dock of earlier versions (left and right columns of at most two
islands, the timeline at the bottom, two floating panels) with a tree any
panel can go anywhere in. The design follows "Panels and docking: a new
system" in the native-app brief and its notes (`docs/native/docking-core.md`
on `native-app`), adapted to the web interface that the desktop app (Tauri)
and the browser build share. Panel contents are unchanged; only where they
sit changed. The default arrangement of every workspace draws exactly today's
window.

## Modules

| Module | Owns |
| --- | --- |
| `dock-model.mjs` | The arrangement and every operation on it. Pure data and functions. |
| `dock-workspaces.mjs` | The three workspaces' arrangements, the built-in and saved layouts, Focus, export and import. Pure. |
| `dock-solve.mjs` | Fitting an arrangement into the window: rectangles, dividers, strips, folds, the stage and the tool bar. Pure. |
| `dock-store.mjs` | Loading and saving (debounced, ordered, merge-on-write). |
| `dock-migrate.mjs` | Importing today's stored layouts (schema v2, read through `layout-schema.mjs`) once. |
| `dock-host.mjs` | The DOM: islands, strips, flyouts, the sheet, floats and dividers; panel visibility; the workspace API (`window.styk.workspace`). |
| `dock-tabs.mjs` | Dragging tabs, strip icons and headers with drop previews; floats' moves and resizes; the panel menu. |
| `dock-keyboard.mjs` | F6 and Ctrl+F6 region cycling; the keyboard move (Ctrl+Alt+M). |
| `layout-popover.mjs` | View › Layout… (Ctrl+Alt+L). |
| `layout-solver.mjs` | The chrome's numbers: tiers, band folds, metrics, the timeline's default height, the stage insets. Its own `solveLayout` stays as the reference the default layouts are tested against. |

## The arrangement

```
layout = {root: Node, floats: [{id, rect: {x, y, w, h}, group, ret?}], closed: [{id, group?, index?}], tools: 'left' | 'right'}
Node   = {type: 'stage', flex: 1}
       | {type: 'group', id, tabs: [panel ids], active, collapsed?, size?, flex?}
       | {type: 'split', axis: 'row' | 'column', children: [Node, …], size?, flex?}
```

- `size` is a node's extent in CSS px along its parent's axis, stored only once
  a person sets it. Without it a node takes its default, derived from the
  window as today (the inspector's 320, 296 or 256 px by width tier, Structure's
  232, the timeline's height by window height). A window resize therefore keeps
  a panel's width and gives the change to the stage.
- `flex` shares the rest of a split by weight: the stage, and groups that
  split a group's place.
- The stage is the anchor: panels dock beside it on any side, but it is not a
  tab and does not float (one stage view; see Decisions).
- Every operation applies to a copy and ends in `repairLayout`, which restores
  the invariants: the stage once; every panel of the workspace exactly once in
  a group, a float or `closed`; no empty group; no split of one child or of its
  parent's axis; a flexible child in every split. A panel this version does not
  know stays in its group as data and is never drawn; unknown keys survive.
- A closed panel remembers its group and index; a float remembers the group it
  came from, and when that group is gone, the neighbour it stood beside and on
  which side, so docking back returns it there (collapsed again if it was).

## Solving

`solveDock(layout, env)` lays the tree into the workspace's inner box with
today's padding and gaps. Along a split, fixed children take their size,
flexible ones share the rest by weight, never under their minimum; a shortage
shrinks fixed children toward their minimum first. Then, without touching the
stored arrangement:

- the compact and minimal width tiers (and the touch profiles) fold groups
  beside the stage: left ones to strips, right ones and floats to the sheet the
  band's Properties button opens;
- the low height tier folds groups above or below the stage to their header
  (the timeline's body then opens as a sheet, as today);
- while the stage is under 360×200 below its header, groups fold in today's
  order: left to strips, right to strips, right to the sheet, left to the sheet
  (a tablet skips right strips), then above and below to headers.

The default layouts land on today's rectangles: `tests/dock-model.test.mjs`
compares the stage, the inspector, the timeline, the tool bar, the timeline's
rows and the stage insets with today's solver in about 4,000 windows across the
desktop and the four touch profiles, for each workspace. Screenshots at
1560×1000, 1440×900, 1280×720, 1024×700, 720×800 and 1440×560 are identical to
today's to the pixel.

## Arranging

- **Drag** a tab, a strip icon or a group's header (the empty part of its tab
  row, or of the timeline's own header) past 4 px. The place a release gives
  the panel shows as a soft area of the exact size it will take: the move is
  applied to a copy and solved, once per place. Zones: a group's tab row (add
  as a tab, at the insertion bar), the outer quarter of a group (split it), the
  stage's edges (a fifth, at most 96 px: dock beside it), the window's outer
  16 px (dock along the edge, across the window); anywhere else floats. Shift
  floats. Escape, a lost pointer or leaving the window cancels; the arrangement
  is byte-equal. Nothing is solved or moved but the preview while dragging.
- **Floats** are islands over the workspace. Their tab row moves them (a
  transform until the release), the corner grip resizes them, a double press on
  their header docks them back. A float stored off screen comes back on screen.
- **Collapse**: a double press on a group's header collapses it to a 40 px strip
  of icons (beside the stage) or to its header (above or below it). An icon or
  a tab opens the panel as a flyout beside it; Escape, a press outside or focus
  leaving closes it, and the flyout's tab drags the panel out.
- **Dividers** sit over the gaps, with today's names, keys (arrows 12 px, Shift
  40, End the largest, Home or Enter or a double click the default, Escape
  cancels a drag) and one solve per frame while dragging. Resizing never pauses
  playback.
- **Menus**: a tab's or strip icon's menu (right-click, Shift+F10, Menu key):
  Dock left, Dock right, Dock below, Float or Dock back, Collapse or Expand,
  Close. View › Panels and the Layout popover list every panel of the
  workspace; a closed one comes back where it was.
- **Keyboard**: F6 and Ctrl+F6 visit the band, the tool bar, then the groups and
  the stage in the tree's reading order, then the floats; the DOM keeps the
  same order, so Tab agrees. Ctrl+Alt+M steps through every place the panel can
  go with the same previews. Ctrl+1–4, Ctrl+\ (Focus) and Ctrl+Alt+L work as
  today.

## Workspaces and layouts

Animate, Draw and Build keep their own arrangement. The built-in layouts keep
today's names: Animate, Timing, Focus (a toggle that collapses everything and
restores the arrangement exactly) and Review; Draw; Build and Build + timeline.
A person saves up to 16 named layouts per profile, renames, updates and deletes
them, and exports or imports a layout as a `.stylayout` file (JSON; a newer
version's file is refused). The card of the layout in use is checked and marked
when it was changed since. Reset returns the workspace to its default layout
and always works.

## Persistence and migration

- Desktop: the `dock` key of `workspace-preferences.json`, through the existing
  `getWorkspacePreferences` and `setWorkspacePreferences` calls, so the file keeps
  its atomic replacement and its 16 KiB limit. The tree is stored flat (each
  node names its parent), so the JSON stays shallow under the file's nesting
  limit however deep the panels nest. Every other key is written back as read:
  today's v2 layout stays for an older version. Over the limit, the v2 keys go
  first, then Focus snapshots, then the oldest saved layouts.
- Browser: `localStorage['stykanimate.dock-layout.v3']`; today's v2 key is read
  once and left as it is.
- Nothing is written on load or by fitting; a change is saved 200 ms later.
  A state from a newer version is used read-only with the defaults. A damaged
  state falls back to today's layout or the defaults without losing a panel. A
  change that would lose or double a panel is refused and reported.
- When no docking state is stored, today's layouts are imported once: each
  workspace's islands become groups (two stacked islands a column that keeps
  their shares), a side's strip a collapsed group at the outer edge, the
  timeline a group under everything or under the stage, floating panels floats,
  hidden panels closed ones, the rail the tool bar's side; the shared sizes go
  into every workspace and saved layout; saved layouts keep their names.

## Smooth while arranging

Measured on 2026-11-09 in Chrome (WebGPU) at 1440×900 with a 115-figure Pivot
scene playing, today's app (served from `wt/perf-now`) against this one, three
runs each, 2 s windows (`artifacts/docking/perf.mjs`):

| | Interface frames/s, today | this | Longest frame, today | this | Frames ≥ 50 ms, today | this |
| --- | --- | --- | --- | --- | --- | --- |
| Playing | 143–144 | 143–144 | 7–15 ms | 7–14 ms | 0 | 0 |
| Dragging the inspector's divider | 85–97 | 89–104 | 49–70 ms | 49–63 ms | 1–6 | 2–4 |
| Dragging a tab over the stage | 143 | 142–144 | 14–21 ms | 14–21 ms | 0 | 0 |

A tab drag never resizes the stage; a divider drag resizes it as today's
splitters do (the canvas follows each frame). Playback carries on in both.
Solving (Node, `artifacts/docking/solver-bench.txt`): the default layout 27 µs
median, a rearranged one 23 µs, a folded one 38 µs; a synthetic 40-group tree
0.8 ms median at 4000×2160 and 6.6 ms when 39 of its groups fold at 801×600.

## Decisions

- **The stage is not a panel.** It is the tree's anchor: panels dock beside it,
  it does not tab or float, and there is one stage view. Moving the canvas would
  re-create its rendering surface; more stage views need the stage design.
- **Floats stay inside the window** in the browser and in the desktop app. A
  float in its own OS window would need its panel's DOM in another document.
- **The timeline goes anywhere** (beside the stage, tabbed, floating); alone in
  its group it is its own island, as today.
- **Panel moves pause playback as before** (they commit pending edits first);
  resizing and moving floats do not.
- **Today's built-in layout names and Reset's meaning** (back to the workspace's
  default) are kept; there is no separate Window menu: View › Panels and the
  Layout popover list every panel.
- **Old files keep working**: the v2 keys stay in the preferences file until it
  runs out of room.

## Tests

- `tests/dock-model.test.mjs`: today's rectangles for the defaults; seeded
  sequences of 60 random operations across 120 seeds (moves to every zone, group
  moves, close, reopen, collapse, float and dock back, divider sizes, presets,
  Focus) never lose or double a panel, always solve inside the window and
  round-trip through storage; damaged and deep arrangements repair; previews;
  closed panels and floats return; Focus; saved layouts, export and import;
  migration of today's layouts; dividers; small windows.
- `tests/dock-store.test.mjs`: no write on load, the `dock` key beside the other
  preferences, read-only newer states, damaged states, refused changes, two
  windows, the file limit, the browser's keys.
- `tests/shell-layout.browser.mjs` and `tests/workspace-drag.browser.mjs`: the
  window at every tier, splitters, the timeline, floats, the compact sheet,
  Build, the low tier, F6 in reading order, the keyboard move, the Layout
  popover, menus, drag to every zone with the preview equal to the result,
  collapse, flyouts, docking back and persistence across a reload.
- `scripts/smoke-preferences.mjs` (desktop): a 1.1 file imported, a float, a saved
  layout and the timeline under the stage restored after a restart.
