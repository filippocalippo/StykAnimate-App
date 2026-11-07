# How to build a panel (the reference slice)

Every interface chunk follows this page. The worked example is the Properties panel (the Inspector):
`engine/crates/styk-core/src/inspector/` and `engine/crates/styk-ui/src/inspector.rs`. Copy its shapes; where your panel
needs something this page does not cover, say so in your report instead of inventing a second pattern.

## Where state lives

| State | Owner | Read through | Example |
| --- | --- | --- | --- |
| The document, its history, selection, selected joint, playhead, active layer | the tab's `styk-edit` session | `Document::{with_document, frame_records, records, selection, view, selection_bounds, read}` (`docs/native/documents.md`) | a figure's `root_x`, `history.undo` |
| View state features depend on | `styk_core::view_state::ViewState` (one per window) | its getters; changes through its setters, which bump `version()` | the Inspector's tab and context, Edit together and its frames, the Draw tool |
| A panel's own state | the panel's core struct (`inspector::Panel`, `PanelState`) | the panel's view model and small read methods | the field being edited and its gesture, a pager's page, the camera's Transform/Motion tab, the section memory |
| Widget-only state | iced | never read by the core | hover, a text cursor, a scroll offset, focus rings |

One owner per fact: nothing above is copied into another layer and kept in sync. The core never writes a document in
place; Rust's borrows make that structural (a panel only ever holds `&Document`), and every change is a session call.

## The files of a panel

- `styk-core/src/<panel>/model.rs`: the view model, plain data (`Clone + PartialEq`), no engine types, no borrowed
  document. Text is `i18n::Label` (a message key and parameters, or a name from the document), never a finished
  English string.
- `styk-core/src/<panel>/contexts.rs` (or `build.rs`-like name of your choice): builds the model from the session's
  typed reads and the view state. This is where today's descriptor functions are ported, line by line.
- `styk-core/src/<panel>/mod.rs`: the panel's state, its `Event` enum (what the view can say), `update(event)` and
  `refresh()`.
- `styk-core/src/<panel>/...`: the panel's logic modules (the Inspector's `property.rs`: keys, ranges, the gesture).
- `styk-ui/src/<panel>.rs`: the view. It reads the model, draws it with `styk-design`'s tokens and widgets and sends
  `Message`s. No `if` decides behaviour there: enabled states, ranges, labels, which sections show all come from the
  model.
- Tests: `styk-core/tests/<panel>.rs` (logic, no window) and `styk-ui/tests/<panel>.rs` (headless).

## The flow

```
widget event ──► styk_ui::Message ──► styk_ui::message::update(core, message)
                                         │
                                         ├─ Message::Command(c) ─► Core::dispatch(c) ─► session calls ─► Vec<Effect>
                                         │                          Core::refresh()  ─► view models rebuilt if their key changed
                                         │                          effects ─► iced Tasks (blur, focus; later dialogs, jobs, frames)
                                         └─ widget-only (focus a field after a label click) ─► an iced Task, no core call
view(&Core) reads core.inspector().model(), .field(), .rename() only
```

- `styk_core::commands::Command` is the one command type: `Run(CommandId)` for registry commands (buttons, menus,
  shortcuts, quick actions, automation) and one variant per panel for its controls (`Inspector(inspector::Event)`).
  K-cmd fills `CommandId` and the registry; a command without a handler answers `Effect::NotAvailable(id)`.
- `Core::dispatch` never blocks (D7): it runs session commands on the interface thread exactly as today's editor ran
  them, and it never waits on a worker.
- `Effect` carries plain data. The interface turns each into a task (`styk_ui::message::effect`); an effect whose
  owner has not landed yet (the shell's message slot, the stage, the colour picker) maps to `Task::none()` there and
  nowhere else.

## View models

- Built by the core, cached by a key holding every input: the document id, its revision, the frame on show (the
  session's COW handle, compared with `same_node`, which covers live previews), the selection, the playhead, the
  view-state version, the panel's own state version and memory version. `refresh()` compares the key and rebuilds only
  when it changed; a rebuilt model equal to the last keeps the old `Arc`.
- Not rebuilt while a gesture of the panel is open (today the Inspector defers its refresh during a property gesture
  and never reflows a field being typed in); the field being edited is drawn from the panel's live field state.
- A descriptor model: the core says *what* (sections of rows: number, stepper, select, switch, colour, actions, ...),
  the generic kit in `styk-ui` says *how*. A part another chunk builds is a `Row::Slot(Slot::...)`: its place is kept,
  the view draws nothing until that chunk fills it (the camera monitor, camera motion, parallax, IK, drawing sets, the
  movieclip, spatial and Draw sections, builder surfaces; the colour picker plugs in at `Effect::PickColor(target)`,
  the VFX stack as its own panel on the same pattern).

## Edits and undo

- A gesture (a scrub, a held arrow key, a slider or colour drag, typing in a field until it commits) is one history
  entry, as today. `inspector::property::Gesture` is the pattern: `begin` opens the session's gesture
  (`beginAnimationEdit` for a property channel, `beginDrag` for a pose, nothing for project fields), `preview` shows
  each value live through the session, `commit` ends it (one entry, `addAnimationKeys`/`setPoseProperty` over the
  frames Edit together reaches), `cancel` restores and leaves none. Exactly one of commit and cancel ends a gesture.
- The field model (`styk_core::number::NumberEdit`) owns typing, Enter, Escape, blur, scrub accumulation and steps;
  the panel maps each of its outcomes (`Settled::{Committed, Cancelled, Unchanged}`) onto the session gesture. The
  session gesture begins from the value before the first change (a step or a keystroke), never after it.
- A discrete control (a switch, a select, a rename) is one session command, one entry.
- Undo and redo are `Command::Run(CommandId::Undo | Redo)`: an open gesture is committed first (today's
  `finishCurrentEdit`), the session undoes, and the model follows on the next `refresh` because the revision changed.
- A refusal never changes the document: the session's `EditError` becomes a `Msg` (`commands::refusal`: the message
  key and its parameters) in `Effect::Notice`, the error policy's warning. Invalid typed text never reaches the session:
  the field shows its error message from the field model.

## Text

`styk_core::i18n::Msg { key, params }` names a message of today's catalogue; `english(&msg)` formats it as
`interfaceText` does (placeholders, plural forms, nested messages, `Intl.NumberFormat('en')` numbers). The catalogue is
built into `styk-core` from `src/locales/en.mjs` at compile time (`build.rs`), so it cannot drift. A view model holds
`Label`s; the view formats them. A test of each panel asserts every key it shows exists in the catalogue.

## Testing a panel

1. **Core tests, no window** (`styk-core/tests/inspector.rs`): open real fixtures with `PreparedDocument::open_bytes`,
   assert each context's model (kind, target, sections in order, values), every mapping of a control to session
   calls, one history entry per gesture, undo and redo of each kind of edit restoring the records exactly, refusals as
   messages, and the cache (no rebuild without a change, none during a gesture).
2. **One headless UI test per panel** (`styk-ui/tests/inspector.rs`): the panel drawn by the software renderer in every
   context and both themes, and one interaction of each kind through the real widgets (`styk_design::widgets::testing::
   Driver`: a drag of a scrub label from its laid-out bounds, typing and Enter, an arrow step, undo), delivering the
   messages the widgets publish to `styk_ui::message::update`. UI tests open documents with
   `styk_core::testing::core_with_document` (feature `testing`), so the interface's tests name no engine crate.
3. **Screenshots against today's**: the UI test writes each context's picture when `STYK_INSPECTOR_PNG_DIR` is set; the
   reference is today's panel in the same context captured headless; the score and its limit go into the screen
   catalogue's limits (K-guards' `docs/native/screens/limits.toml`).

## Checklist for a new panel

- [ ] Model types plain data; no engine type, no borrowed document, no English string built in the core.
- [ ] Every control sends an `Event`; every button a `CommandId`; nothing in the view decides behaviour.
- [ ] Each gesture one entry; cancel leaves none; undo and redo tested per kind of edit.
- [ ] The model's key holds every input; no rebuild while a gesture is open.
- [ ] Core tests per context and mapping; one headless UI test; screenshots in both themes.
- [ ] `cargo xtask check` passes.
