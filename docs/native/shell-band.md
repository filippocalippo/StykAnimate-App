# The window and the top band (chunk K-shell)

The app window in today's look: the boot prepaint, S6's frameless window with the band at its real layout, the project
tab strip, the workspace switch, Undo and Redo, Export and the session buttons. [shell.md](shell.md) is the window itself
(frame, chrome, window state, single instance, updater); this page is what is drawn in it and what it does. Today's
behaviour is `src/shell/topbar.mjs`, `project-tabs-view.mjs`, `project-switcher.mjs`, `src/project-tabs.mjs`,
`src/studio-shell.mjs` (`changeMode`) and `src/styles/layout/topbar.css`, `features/band.css`,
`components/project-tabs.css`; `docs/PROJECT-TABS.md` is its contract.

## Owners

| Concern | Logic (no window, tested) | View |
| --- | --- | --- |
| Tab order, recency, the switcher's order, move | `styk_core::documents` (`documents/tabs.rs`: `recency`, `successor`, `neighbour`, `move_tab`, `drop_index`) | |
| Workspace switch rules (SH-076/077) | `styk_core::shell::workspace` | `styk_ui::shell` (`controls::segment`) |
| What the band shows, where, what folds (SH-054/055) | `styk_core::shell::band` | `styk_ui::shell::bar` |
| Session buttons, Export's two looks (SH-079/080) | `styk_core::shell::session` | `bar` |
| Tab dots, keys, drag to reorder (SH-067 to SH-070) | `styk_core::shell::strip` | `styk_ui::shell::strip` |
| Ctrl+Tab board (SH-072) | `styk_core::shell::switcher` | `styk_ui::shell::board` |
| Putting them together, history buttons (SH-078) | `styk_core::shell::Shell` (`handle`, `sync`) | `styk_ui::shell::window` |
| Scripts for `--automation` | `styk_core::automation` | |
| Wiring: keys, pointer, focus, the open of files, the script runner | | `styk-app/src/top_band.rs` |

The views draw what `Shell::layout()` and `Shell::tabs()` hold and send `shell::Event`s. `Shell::handle` answers with
`Effect`s for what the shell does not own. The window controls and the drag region are S6's (`styk_services::shell::chrome`);
the band publishes the places that keep the pointer (`Layout::no_drag`) and the rest of the band moves the window.

## The band's layout

`band::solve` is `topbar.css`, `band.css` and `project-tabs.css` as one function of the window width, the open projects, the
session and the width of the band's words (`Labels`, measured with the font system by `styk_ui::shell::measure_labels`;
the tokens it reads come from `styk_design` through `styk_ui::shell::metrics`). Three clusters in a grid: the start takes
what the others leave, the others never take less than their content. The fold steps are `BAND_FOLDS` minus the three that
free nothing (`state`, `name8`, `savelabel`); the fewest steps whose measured width plus 24 px fits are applied, and where
none fits, all of them (the minimal tier folds the same way, since the menubar never shows).

The tab strip is the flexbox of `.project-tabs-list`: a resting tab is 184 px and shrinks four times as fast as the one in
front (172 px), each with its minimum; `band::shrink` resolves it as CSS does. A tab loses Close below 124 px of content and
its name below 72.

Checked against Chromium (the real `measureBand` and `resolveTiers` over the real stylesheets, one page per scenario): the
band's width at rest and after each step (880, 856, 828, 790, 766, 697, 587, 499, 467, 409), the same in Build and
movieclip sessions, the position of every item at 1560 px, the tabs' shares of the strip, and the fold steps picked at
twelve widths and three sessions are tests in `band.rs`.

## Rules

- **Workspace switch.** The current workspace is what the sessions report (`mode()`), never what was asked. Only the latest
  request wins; leaving Draw waits for the drawing to commit and stays if that fails; entering Draw from Build asks Build
  to exit and begins Draw when it reports that it left; Build's Done asks for Animate. The machine emits `Effect`s
  (`ExitDrawing`, `RequestBuildExit`, `EnterDrawing`, `EnterBuild`) and takes `Report`s back.
- **Tabs.** A project opened sits beside the one in front (K-doc). A click is a press and a release on the same tab; a
  press that moves 4 px is a drag, a line shows on the near or far half of the tab under the pointer, and the drop moves the
  tab (`drop_index`). A press the pointer never left is a click even though the window reported no position. Arrows,
  Home and End move focus around the strip without switching, Enter and Space switch, Delete closes, F2 renames, the Menu
  key opens the tab's menu. Ctrl+Page Up and Down step through the tabs.
- **The dot.** Saving, then unsaved changes, then "saved" for 2.2 s after a save lands; the neutral dot, the success dot,
  and the danger dot when the last save failed. `Shell::next_deadline` says when the strip next changes by itself.
- **Ctrl+Tab.** Pressed and released: the project used before. Held: the board of cards, most recently used first, Tab and
  the arrows move, releasing the modifier switches, Escape stays, a click switches, losing focus closes it.
- **Home.** Pressed while it shows; no workspace is. A workspace, a tab, Undo, Redo and New send it away.

## Stand-ins until their owners land

Each is marked in the code and goes when its chunk does.

- **Opening files** (`top_band::open_file`): reads the file and opens it with a fresh engine on a worker. K-doc's files
  service and engine host replace it.
- **The drawing and Build sessions** (`top_band::sessions`): answer the workspace machine at once, and Build brings its
  session's buttons. The Draw and Build chunks replace it.
- **The band's commands** (Save, Export, Close, Rename, New, Test rig, Cancel, Done, Properties) arrive as
  `Effect::Command`; the app drops them until K-cmd's registry and K-doc's close and save flows exist. Undo and Redo run on
  the project in front through `Documents`.
- **The menus** open as placeholders (a popover with the rows set as text): the mark's menu and a tab's menu. Their
  contents come with the menu widget (K-widgets) and the registry.
- **Tab pictures** are the scene glyph until the stage draws them.
- **Text** is English literals in the views until the localisation chunk.

## Where it differs from today's app

- The window controls are 44 x 36 and centred in the band, as in the page (the S6 design said "the band's height"); the
  hit regions keep the whole band height so the snap-layouts flyout works at the top edge.
- A failed save shows the danger dot on the tab (today's app has no tab state for it).
- The press feedback (`transform: scale(.97)`), the hover transitions and the tab-dragging cursor are not drawn.
- Keyboard focus reaches the mark, Home, the tab strip (one stop), New, the workspaces, history, Save, Export and the
  session buttons; the minimize and close buttons are not focus targets yet.
- The right-to-left arrow mirroring and the touch interface are not built.

## The automation mode (shell steps)

`stykanimate --automation script` runs one step per line against the real window, on its frames. The language is
`styk_core::automation`, the app's one parser: an optional `styk-auto/1` header on the first line (another version is
refused), line-numbered errors, scripts of at most 64 KiB, step types that are `#[non_exhaustive]` so each feature adds
its own. The shell's steps are `open`, `click`, `key`, `drag-tab`, `edit`, `session`, `theme`, `resize`,
`wait`, `expect` and `screenshot`. It exits 0 when every `expect` held, 1 with the failures listed otherwise. The steps send
the same `shell::Event`s the views send; the stage's pointer and pen steps join the language with the stage.

## Screenshots against today's app

A page per scenario in Chromium (the real stylesheets, `measureBand`, `resolveTiers` and `installProjectTabs` over the real
`index.html` header) and the native window at the same width and theme, the band's rows compared pixel by pixel: the
widths are the wide window, each fold step of three tabs (903, 879, 851, 813, 789, 720, 610, 522, 490) and the narrowest
(400), light and dark, plus Build, movieclip and camera sessions, one tab and twelve tabs. The scores (PSNR over the band's rows, 22 scenarios, 2026-11-07, debug build): 18.7 to 29.1 dB, never more than 5.9 % of
pixels differing by more than 24 levels. What remains is text: Chromium draws grayscale where the native window draws
ClearType-style text (S2c), and the dots, glyph edges and shadows differ by a pixel. Each scenario also asserts the
window width and the fold steps Chromium applied (`expect width`, `expect folds`), all of which hold.

The interaction script is `engine/crates/styk-app/automation/shell-interaction.script`: three projects opened, Ctrl+Tab
held and released, a reorder by drag, Undo and Redo on the dot, the three workspaces, Home, and a narrow window's folds.
The Chromium side of the comparison is a harness over the real page that is not kept in the repository.
