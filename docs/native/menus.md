# The application menus (chunk M1)

The mark's StykAnimate menu and the six application menus it leads with (File, Edit, View, Joint, Animation, Help), in today's
rows: `src/application-menu.mjs` (`applicationMenuItems`), `showMenu`, `foldedMenubarItems`, `openProjectsMenu`, `panelsMenu` and
`menuItems` in `src/app.mjs` (`SH-057` to `SH-064`). The classic menubar never shows (`SH-065`), so the menus are reached
only through the mark, as today.

## Owners

| Concern | Owner |
| --- | --- |
| What each menu holds, in which order, with which command, glyph and label key; the state a row depends on (`Facts`) | `styk_core::menus` (`application`, `mark`, `Facts`) |
| Reading `Facts` from the project in front, the settings, the dock and the open projects | `Core::menu_facts` (`menus.rs`; only reads that never evaluate) |
| Opening the mark's menu and closing it on a second press | `Core::run(CommandId::Menu)` (`Owner::Menu`), through `overlay::host::Host::open` |
| Which row is focused, hovered, open; keys, typeahead (700 ms), hover intent (150/250 ms), placement | `styk_core::overlay` (K-overlay, unchanged) |
| A row's shortcut hint (the first binding of the registry, in the scopes of the workspace) | `overlay::menu::Item::shortcuts`, from `CommandId::info()` |
| A row's activation | `Host` reports a `CommandId` (or, for an open project, a `DocumentId`); `Core::overlay_event` dispatches `Command::Run` or `Command::Activate` |
| Drawing | `styk_design::widgets::menu` through `styk_ui::overlays::layer` (K-widgets-b); the band's mark shows pressed while `Host::menu_of(ids::MARK)` is open |

Nothing in `styk-ui` decides what a menu holds. The shell no longer keeps a mark menu: `shell::Event::Mark` is the registry's
`Menu` command (`Effect::Command(Run(Menu))`); only a project tab's menu is still the shell's placeholder (`SH-071`).

## The rows

- A row is `Item::new(CommandId, label)` with today's glyph; its label is the catalogue key today's menu uses
  (`applicationMenu.*`, `app.*`, `common.*`, `commands.*`), formatted by the window's `Presentation`. The registry's own label key
  is not used where today's menu words it differently ("Search commands…" does use it).
- Disabled as today (`noFigure`, `noJoint`, desktop capabilities); a disabled delete row stays red. Unported features are **not**
  disabled: choosing the row dispatches the command, which answers `Effect::NotAvailable(id)` until its feature lands.
- View toggles carry a check from `Facts::on` (Loop from the settings); a submenu row names no command and is never reported.
- The open projects (two or more) are a submenu of rows whose action is `RowAction::Document(id)`; choosing one brings that project
  to the front (`Command::Activate`). The row of the project in front is checked.
- View > Panels checks the panels the dock shows (`Dock::solution().visible`) and runs the panel toggle commands.

## Not built, and why

- The stage's overlay flags (Joints, Motion paths, Onion skin, Grid) have no owner in the core yet: the rows show their starting
  state (Joints and Onion skin on) until the stage owns them (`menus::Facts::default`).
- At the minimal tier today's Animation menu also lists Audio and Edit together (folded from the timeline header); the dock
  has no such tier yet.
- A project tab's menu (`SH-071`) and the context menus of the stage and the panels are other chunks'.
- Desktop capabilities (`Desktop::FULL`): New window, Open recent, feedback, updates and diagnostics are shown as the packaged
  desktop shows them; their services belong to their chunks, and the rows answer `NotAvailable` until then.

## Widget fixes this chunk made (they were visible differences)

`styk_design::widgets::menu` followed today's `menu.css` only for menus up to 240 px wide:

- A menu is as wide as its widest row (`width: max-content`, between 240 and 340 px): label and key on one line, never wrapped.
  The width is measured with the font system (`share`), since an iced row cannot take its natural width from Fill children.
- A check is the icon's grey (`text-2`), not the accent; only the radio dot is blue.
- A disabled danger row stays red (`[data-tone="danger"]` follows `[aria-disabled]`).

## Screens and checks

`app-menu` (the mark's menu) and `app-menu-file`, `-edit`, `-view`, `-joint`, `-animation`, `-help` (each open beside its row), in both
themes: a window with nothing selected on the packaged desktop. References: today's `applicationMenuItems`, `showMenu` text and `openMenu`
in Chromium (`engine/crates/styk-app/automation/menus-reference/screens.mjs`, `docs/native/screens/menus/`; `--scale 2` for the 200 %
comparison). What remains between the two at 100 % and 200 % is glyph rasterisation (Chromium's LCD text against the native
renderer's); the limits are in `screens/limits.toml`.

- `crates/styk-core/tests/menus.rs`: every row of the seven menus in three states (nothing selected, a figure and a joint
  selected, the browser) against today's modules run in Node (`tests/support/menus-reference.mjs`: the module `applicationMenuItems`
  and the text of `showMenu` itself), the real core's Undo and Redo through a row, the selection and open projects.
- `crates/styk-app` (`top_band.rs`): the mounted band and overlay layer driven by clicks and keys through the production
  update; `automation/menu-interaction.script` (`menu hover|press <row>`, `expect menus <n>`, `expect history <n>`).
