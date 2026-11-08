# The docked window (K-dock views, part 1)

The main window below the band is laid out by `styk_core::layout`: the arrangement, the operations, the solver, the drop zones
and the layout's history are the core's (`docking-core.md`). This chunk puts them on screen. **The views draw what the core
solves and send its operations; they decide nothing it decides.**

Part 1 is the docked window. Floating OS windows, other monitors and monitor arrangements, presets and the workspace layout
UI (the Layout and Window menus) are part 2.

## Where things are

| Concern | Owner |
| --- | --- |
| The gesture in progress (a press that becomes a drag past 4 px, a held divider, a keyboard move), double clicks, the open flyout or sheet, saves, loading, the first-launch import (layout owns transactions/history and default sizes) | `styk_core::dock` (`Dock`, `Event`, `Effect`, `Stored`), held by `Core`, reached as `Command::Dock(Event)` through `Core::dispatch` |
| The islands, tab headers, strips, flyouts, splitters, the tool rail's place, the drop overlay | `styk_ui::dock` (`view.rs`; `probe.rs` is the one small widget) on `styk-design` parts: `Card`, `Tabs`, `splitter`, `IconButton`, `empty_state`, `Layer` |
| The pointer, Escape and Shift | `styk_ui::dock::{track, key}` through `TopBand`; layout shortcuts resolve through `Shortcuts` and `Core::dispatch` |
| Loading, the debounced write, the wake | `TopBand` (`load_layouts`, `save_layouts`, `dock_wake`) on the application's injected clock; the write is `LayoutStore::save`, a task on the storage worker, never a wait |
| Where each rectangle is | `styk_core::layout::solve`; the dock only offsets it by the band's height |

## What the person sees and does

- The default Animate layout is today's window: the stage with its 44 px header over the field, the Properties, VFX and Library
  tabs in a 320 px column, the timeline's island under both. At 1560 x 1000 and 1440 x 900 the islands' rectangles equal
  today's (`dock/tests.rs`, measured in today's window), at 720 x 800 the right dock is a sheet and the timeline folds to a strip (design 3.2).
- **Tabs**: a click activates (roving arrows too); a press that moves 4 px is a drag of that tab (the empty part of a header, or
  the strip along the top of a panel that draws its own header, drags the group's active tab). The drop overlay shows the exact
  rectangle the panel would take (the same transaction as the release), named ("Add as tab", "Split below", "Dock left"), and the
  panel's name follows the pointer. Escape, losing focus or a place the panel cannot take cancels; the layout is byte-equal.
  Shift at the release asks for a float: part 1 refuses it with a message and changes nothing.
- **Dividers**: the splitter resizes live (neighbours only, to the panels' limits) as one history entry; arrows move 12 px (Shift
  40), Home or Enter or a double click reset to the panels' preferred size along the split axis, End the largest; Escape restores the start.
- **Collapse**: two presses on a header within 500 ms collapse the group to its strip; a strip icon opens a flyout over the stage
  (Escape or a press outside closes it, the pin expands the group). The same widget is the sheet a narrow window folds the right
  dock to. The solver's 16 px hysteresis holds the fold: folded at 800, unfolded at 816.
- **Layout undo** (Ctrl+Alt+Z) is the layout's own 20 steps, separate from the document's. **Ctrl+Alt+M** moves the focused panel
  by keyboard: arrows step through every place the core accepts, Enter moves, Escape cancels, other keys are swallowed.
  **F6** and Ctrl+F6 move between the panels' regions through the core's focus areas: every group's tab strip or body is a target
  with core-owned tree order (`Dock::regions`); the views handoff below lists the remaining targets to mount.
- **Persistence**: `LayoutStore::load` at start; no stored file means today's `workspace-preferences.json` is imported once
  (`import_v2`, the saved layouts included) with today's default timeline height where the profile has none; a newer file is
  read-only; a layout changed before the file arrived keeps the person's change. Each change queues one write 200 ms later
  (`SaveQueue`, retried with backoff); loading writes nothing and fitting never writes.

## Decisions

- **Today's timeline height.** `essentials` stores 264 for the timeline; today's window shows its island 16 px taller (264 body
  plus the island's chrome: 280 above 800 px, 264 from 641, 240 from 600, 212 below, the 40 px header at the low tier).
  `dock::default_timeline_height` is today's function of the window height, applied when a layout is created. Divider reset uses panel preferences (design 3.4). Today re-derives it on every solve until the person stores a height; here it is stored once (a later window height
  does not move it).
- **Compact widths follow design 3.2:** left, top and bottom fold to strips, right folds to a sheet. The earlier screenshot-based exception was removed in the core review.
- **A tab zone has no hold area** (`layout::solve::zone_bounds`): its insertion index follows the pointer along the header (it
  stuck at the first index inside the whole header before).
- **A double click is two presses within 500 ms in the core**, on the injected clock, not the toolkit's: a press that became a
  drag is not the first click.
- **The tab under a press** comes from the bounds the last walk of the tree measured (`Host::target_at`): the probe reports the
  window position, the core resolves the tab.
- **Floats are refused visibly** in part 1: a message over the stage, the panel stays. Messages and zone labels use `i18n::Msg`; see the native catalogue additions in the core handoff.
- **Not in part 1 and left open**: the drop overlay's rectangle jumps between zones (the design animates it over `--dur-fast`);
  a tab's insertion index follows thirds of the header, not the pills' real positions (the core's `drop_zone`); default column
  widths per width tier (296 and 256 px today, one stored width here); close and reopen exist in the core and the handler
  (`Event::Close`, `Event::Reopen`) but have no control until the Window menu (part 2); the Layout button's dot has no button.

## Screens

`dock`, `dock-1440`, `dock-folded` and their `-dark` twins (`styk_ui::screens::DockScreen`): the band over the docked default
layout at 1560 x 1000, 1440 x 900 and 720 x 800, compared with today's window captured by
`engine/crates/styk-app/automation/dock-reference/screens.mjs`. The band, the stage header, the artboard, the tool rail, the
timeline and the Properties panel's quick actions, menu button and footer are other chunks' and masked in `limits.toml`. The
preview (`styk-screens`) draws the same PNGs byte for byte. Measured on 2026-11-08 (debug, headless, channel difference past 24,
masks applied): 0.0035, 0.0028 (dark), 0.0041 (1440), 0.0033 (1440 dark), 0.0016 (folded), 0.0003 (folded dark).

## Tests

- `styk-core/src/dock/tests.rs`: the default window against today's rectangles, today's timeline height, each window edge, the
  split, join and reorder drops, the slop, Escape and blur, Shift's float refusal, collapse, flyouts and pin, the divider's drag,
  Escape, reset, steps, fold and unfold across the hysteresis, the sheet, the keyboard move, close and reopen, the workspace
  switch, save debounce and retry on the injected clock, reload, a newer file, a change before the load, the first-launch import,
  the dividers worth drawing, the script steps.
- `styk-ui/tests/dock.rs`: the same on mounted widgets through the production handler (`update_at`, the tree's walk handed back
  to the core, `dock::track` and `dock::key`): docking a tab to each edge and one undo, the split and join drops, reorder,
  click and double click, a splitter drag with Escape and its keys, the fold across the hysteresis, F6 and Ctrl+F6, the keyboard
  move, a change saved and loaded back. With the probe's publish removed, six of them fail.
- `styk-app` (`top_band.rs`): `automation/dock-interaction.script` runs through the dock's handler, and the band's workspace
  switch changes the arrangement.

The automated interaction is `automation/dock-interaction.script`; run it with a profile of its own so it writes nothing of the
person's (the header of the script gives the command).

## Pending views work after the core review

Use [the core API handoff](docking-core.md#core-review-handoff-for-the-views-step-2026-11-08):
consume `Dock::open_rect()` without repositioning/resizing; mount `ids::stage_header(group)` and
`ids::body(group)` for a visible stage even when tabbed; wire x/middle-click to `Event::Close`.
When a dock is mounted, root-scope snapshot routing assigns measured targets to its group regions,
preserving field roles. Standalone panel snapshots retain their original regions. Exercise multiple reordered groups through the production F6/shortcut adapter on mounted
widgets. `dock_shortcut_at` is the keyboard adapter for registered layout/panel/focus commands;
`dock::key` now handles gestures only. Recheck folded screens against the authoritative design;
the earlier screenshot measurements above certify the previous commit only.
