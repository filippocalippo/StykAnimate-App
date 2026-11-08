# Native overlay core (K-overlay)

`styk_core::overlay` owns toolkit-independent overlay decisions. K-widgets supplies the views; no view calls an engine or service. All times are injected monotonic milliseconds, and `deadline()` lets the runtime schedule a wakeup without polling.

Menu rows (`menu::Item`, constructed with `Item::new`) and message actions (`messages::Action`) carry the shared `commands::CommandId`. A menu activation returns that same identity for `commands::Command::Run`; `Core::dispatch` owns execution, including `Effect::NotAvailable` for unported handlers. There is no overlay command table or stored copy of a shortcut. `Item::shortcuts(platform, desktop, active_scopes)` reads `CommandId::info()` for the visible text and accessible key shortcuts, including display aliases, workspace conflicts and desktop-only bindings. Submenu rows have no shortcut hint. Labels remain resolved/localized data supplied by their owner.

The focus owner preserves each target's `input_role` and `history_owner` when shared menu scopes replace or remove rows. Register full `FocusTarget` values through the stack, including the role of selects and other input controls and the VFX history override; do not reconstruct targets from their IDs.

- `Stack` registers the seven overlay kinds, emits hotkey-gate transitions (including release of held keys), requests close guards as effects, accepts their asynchronous replies, and owns Escape/outside-press/environment dismissal. Pointer releases do nothing, preserving context menus opened between press and release. Overlay IDs strictly increase per window; stale guard replies cannot close replacements. `finish` is unconditional abort/removal teardown. `close_all` stops at a guard; resume only after an allowed reply.
- Pass the window's existing `FocusState` to stack operations. A menu tree shares one S2a scope: submenus add their row IDs to that scope rather than trapping focus away from their ancestors. `open_with_focus` takes `OpenFocus::Keep` for hover submenus and `First`/`Target` for keyboard opening; `focus_menu` enters an already visible child. `active_menu` follows the focused row (falling back to the deepest menu), and `menu_key`/`menu_hover` synchronize row navigation with the focus owner. Register each menu's current rows through `Stack::register_targets`; the focus owner retains the only target metadata. Closing a hover child preserves an ancestor's focus; a focused child returns to its parent row. Non-menu overlays keep independent scopes; passive messages/tooltips never take focus. `modal_host()` identifies the message host; `parent` identifies ancestry.
- `placement::compute` remains the generic anchor arithmetic. Views use `Menu::place` with `Anchor::Root`, `Point` or `Submenu` for menu geometry: root gap 6, context/submenu gap 2, margin 8, top inset, flipping and overlap. A submenu's first row aligns using the reference's 4 px padding adjustment; when both sides are cramped its synthetic anchor preserves the available natural width. RTL selects the reference's left-start submenu policy; root placement remains bottom-start. Tooltip placement selects the stage-facing side of a vertical rail and never fits or overlaps the invoker.
- `menu` accepts resolved/localized registry data, normalizes hidden entries and empty submenus, preserves disabled rows for focus and rejects their activation. Navigation, typeahead (700 ms), checks/radio groups, keep-open activation, horizontal RTL keys and submenu hover intent (150 ms to open, 250 ms to close a child) produce typed actions. Keyboard opening emits `OpenSubmenu`, hover opening emits `OpenSubmenuHover`; `Action::submenu_focus` supplies the opening policy. `Menu::deadline()` exposes the next wakeup, including 150 ms opens and 250 ms closes; cancellation, a fired timer and child teardown return None. Schedule only that deadline and replace/cancel it after each event; no polling. Views render entries and forward events.
- `Messages` holds one visible record and at most three waiting records, ordered by priority then arrival. Every overflow/displacement reports a dropped ID for dismissal effects. Persistent displaced messages wait; transient ones are discarded. Duplicate visible messages re-arm their original timeout; duplicate waiters retain their place. Hover/focus pause and resume remaining time. IDs and duplicate keys are supplied by the owner, uniquely identifying message instances and content respectively. Actions are command data. `messages::position` prefers the supplied header slot outside modals, places messages above/below the top modal, and avoids stage controls in reference order.
- `Tooltip` is the single-window pending/visible tooltip, with 500 ms delay and an immediate switch within 300 ms of hiding. Touch hover is ignored; keyboard focus can show it. Hide on press, Escape, scroll, focus loss, target removal and shutdown. Views link accessibility descriptions only while `visible()` contains the target.

## Reference decisions

Executable reference code takes precedence over the inventory's compressed prose: errors and tasks never expire; 8 seconds applies to messages with actions, not to messages waiting behind an error (`ui-toast.mjs:show`). Disabled menu rows remain keyboard-focusable. A plain command closes even if `keepOpen` is set; only check/radio rows stay open. The native scope fallback is S2a's nearest enabled target, as explicitly required by the brief, rather than a separate DOM-style focus registry.

`docs/native/patterns.md`, `architecture.md` and `text-input.md` establish the boundary. No screens, startup prompt scheduler, task execution, localization registry or command execution are added here. Existing owners provide those; K-widgets consumes the public data/actions. No dependencies, document changes, frozen fixtures or public release notes change.

## Verification

Tests in `overlay/tests.rs` cover gates, guards, focus restoration/removal, pointer-release protection, menu navigation/typeahead/hover, message priority/overflow/timers and tooltip timing. `placement_reference_tests.rs` contains 120 independently computed expected rectangles from the unchanged JavaScript `computePosition`: three window sizes, five anchor locations, four sides, with fitting and non-fitting placement. It is new evidence, not a modification of frozen engine fixtures.

Attachment tests also cover input/history metadata surviving menu-tree refresh and teardown, typed activation/message actions, derived shortcut hints and submenu suppression. `tests/commands.rs` compares menu hints to today's executable `CommandRegistry`, alongside the existing 276-command and 286-shortcut parity checks.

## Review regressions

The review tests first reproduced lost parent focus, blocked ancestor navigation, missing hover deadlines and incorrect submenu placement. Placement edge/corner expectations were obtained by executing the unchanged JavaScript `#place` body with its `computePosition` adapter. The cramped 400 px case gives LTR x=152, width=240. Today's RTL branch is asymmetric (x=8, width=140); that behavior is preserved rather than silently redesigned. Tests also cover entering an existing hover submenu from the keyboard, parent-row key routing, target refreshes and hover-close focus restoration.

## The views (K-widgets-b)

`styk_core::overlay::host` is the controller the views consume, and `Core` owns it (`Core::overlays()`, `Command::Overlay { event, now }`);
`styk_ui::overlays::layer` draws it over the window; `styk_design::widgets` are the boxes. The views decide nothing the core decides.

- **`overlay::host::Host`** owns the `Stack`, the open menu trees, the `Messages` and the `Tooltip`. `open` registers a root
  menu (one focus target per row, `row_id(menu, index)`, a disabled row included); `key`, `hover`, `press`, `pointer` and
  `tick` apply each `menu::Action` (a submenu opens with the intent `Action::submenu_focus` names, a child closed by the
  stack is acknowledged to its parent, an activation closes the tree with `Reason::Selected` unless a check or radio row keeps
  it open). Every call returns an `Update`: the stack's effects (focus, the hotkey gate, held-key release, guard checks), the
  command to run, or a select's chosen index. `next_deadline()` is the earliest hover intent, message timeout or tooltip
  delay; the runtime schedules one wake there and calls `tick(now)`. Nothing reads a clock. The row under the pointer
  (`OpenMenu::hovered`) is tracked apart from focus: a pointer-opened menu focuses its first row without the fill or the ring,
  as `ui-menu.mjs` does, and only the keyboard brings the ring (`FocusState::focus_visible`).
- **A select is the host's anchored menu** (`Purpose::Select`): its rows come from `host::option_rows`, a disabled option is a
  disabled row, and choosing reports the option's index, never a command (the rows carry the registry's `Menu` identity as a
  placeholder the host never reports). The `Select` widget opens it from a press, Space, Enter and Alt+Down (`Open` carries the
  field's rectangle and whether a key asked) and still steps the value with plain Up and Down; its `InputRole::Select` is
  unchanged, and the rows keep it. The pick list is gone.
- **The window.** `styk-app`'s band mounts `overlays::layer(core, ...)` over its content (`TopBand::overlay_layer`). Every message
  its widgets send is `Message::Overlay | OpenSelect | Toast | Tooltip`; `message::update_at(core, message, now)` injects the application's
  clock and routes it to `Core::dispatch(Command::Overlay { .. })`, and the effects come back as tasks (focus operations,
  `OverlayChoice`, `MessageDismissed`, `ShortcutReleased`, `NotAvailable`). The runtime owns three things and nothing else:
  the one wake (`overlay_wake`: at `Core::overlay_deadline()` it sends `Event::Tick`; `None` cancels it, so nothing redraws while no
  animation or timer runs), the focus walk (after every message the tree is read and the snapshot is forwarded to the core as
  well as to the band, which is how the host derives "focus is on the message" and measures an anchor), and the raw inputs
  `message::raw_at` takes (a key no widget took while a dialog is open, a button release that numbers the presses). The tasks run
  on the tree rebuilt from the new state, as the runtime does. Until a panel or button sends `Event::OpenMenu`, the dock mounts
  the Inspector, or something shows a message, the layer is mounted and answering but has nothing to draw: the opener of each
  menu belongs to the feature that has one (K-cmd, the band, the panels). The hotkey gate (`Effect::Blocking`) has no consumer
  until the application's hotkeys are routed through `Core::shortcuts`.
- **Animation is the core's.** `Host::phase(id)` is 0 to 1 through a menu's, a popover's (160 ms), a dialog's, sheet's or message's
  (240 ms) entry, and through a loop (a task message's bar 1.3 s, a spinner 0.8 s; `Event::Animate`). `widgets::enter::Enter` draws
  the entry (4 px or 8 px rise, the page's colour laid over it at the remaining opacity), `progress::Bar`/`Spinner` the loops. No
  widget keeps an `Instant` or asks for a redraw; `Host::next_deadline` is the next frame while one runs, and `None` after.
- **Tooltips** are `Focusable::tooltip` (also `IconButton` and `Button`): the pointer arriving, keyboard focus showing the ring, and a
  press, Escape or leaving report `TipEvent`s; the core owns the 500 ms and 300 ms rules, and `overlays::layer` draws
  `Host::tooltip_anchor()` at the bounds the last walk measured for the target, for hoverless input too (keyboard focus shows it).
- **A tall menu scrolls** (`widgets::viewport::Viewport`): a bounded viewport with the wheel, a 6 px thumb and the 12 px fade, and the
  keyboard's row brought into view when it changes.
- **`widgets::layer::Layer`** places each box over the page at the rectangle `Menu::place`, `Tooltip::place` or
  `messages::position` gives it from its natural size, each in its own layer (a submenu's fill covers its parent's words), swallows
  the pointer over a box that takes it, and reports each press and release with whether it landed on a box, so `Host::pointer`
  decides what dismisses. A menu tree is one passive focus scope (`Scope::passive`): a press outside it closes it and goes on to
  the page. A dialog is the modal `Scope`, and its veil takes the pointer.
- **Drawn parts**: `menu` (rows with the glyph, check or radio dot, label, registry hint, chevron and disabled reason; the fill
  and ring from the core's state), `tooltip`, `toast` (a message with actions wraps as today's `flex-wrap` does), `dialog`
  (dialog, popover, sheet), `parts` (stepper, kbd, dot, crumb, divider, island, list row, section head, tabs, scroll area, empty
  state, split button), `progress` (bar, spinner), `splitter`, `card` (the raised box).

**Screens.** `menu-root`, `menu-submenu`, `menu-context`, `select-open`, `tooltip`, `toasts`, `dialog` and `parts`, each in both
themes (`styk_ui::overlay_sheet`; the state comes from the host: a menu is opened, hovered and ticked as the application
would). The references are today's menus, tooltip, messages, dialog and parts drawn by today's stylesheets and today's own modules
(`openMenu`, `createDialog`) in Chromium (`engine/crates/styk-app/automation/overlays-reference/screens.mjs`; `--scale 2` writes the
200 % references). Today's native `<select>` list is an operating-system popup the page cannot capture: the select's reference is
today's menu stylesheet anchored under today's select field. Looked at side by side at 100 % and 200 %, what remains is glyph
rasterisation; the limits are in `screens/limits.toml`.

**Owner's dialogs and the offer.** `overlays::layer_of` places the owner's boxes (a dialog) under the menus, so a select inside a dialog opens its list over it (`menu::layer_over`). A message action is `messages::Do`: a registry command, or an owner's own event (`Update::act`, the recovery offer), and may be drawn with a hairline ring (`outline`); a message may carry its own glyph (`icon`). `Event::CloseOverlay(id)` lets an owner close its dialog; a dialog whose title stands alone centres it against the close button (`dialog.rs`). See [recovery.md](recovery.md#the-views).

**Not drawn, on purpose.** The stage header's `head` and `drop` message slots, the stepper's typeable value (it shows the value), and
the split button's hover shared across its halves while a pointer moves over it (the screen holds it with a flag; the live halves
each take their own). The entry fade is the page's colour over the box (iced has no group opacity), so the shadow is not faded.
