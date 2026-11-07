# Text input, focus, input methods and right to left

The design for every text field, the keyboard focus model, input methods (IME), the clipboard and right-to-left layout in
the native app. It is the S2 design (`perf/native/spikes/S2-text.md`) as corrected by its review (every finding accepted),
and the contract the code in `styk-core` (`focus`, `text_entry`, `roving`, `number`, `limits`, `clipboard`),
`styk-design` (`focus`, `field`, `number_field`, `dir`) and the vendored toolkit patches implements. Typography (fonts,
weights, features) is the S2t chunk and the text tool's compiler S2b; neither is described here.

What today's app does is the reference: `src/property-controls.mjs`, `src/inspector-kit.mjs`, `src/ui/roving-focus.mjs`,
`src/ui/ui-dialog.mjs`, `src/ui/overlay-manager.mjs`, `src/hotkeys.mjs`, `docs/hotkeys.md`.

## 1. Field roles

A field has a **role**. The role fixes what Enter, Escape, Tab and undo do. One policy for all fields is wrong
(multiline text must keep Enter; a dialog's one-line field submits the dialog).

| Role | Enter | Escape | Tab | Field undo | Used for |
| --- | --- | --- | --- | --- | --- |
| `SingleLine` | commits the edit (a `Commit` message), field keeps focus | reverts to the value at focus and blurs | moves focus; focusing by Tab selects all | the field's | names, inspector text, rename |
| `DialogLine` | does **not** blur: sends `Submit`, which the dialog turns into its primary action (`ui-dialog.mjs`) | the dialog's Escape (cancel) | moves focus inside the dialog | the field's | one-line fields of a dialog |
| `Multiline` | inserts a line break; Ctrl+Enter sends `Submit` | blurs the field and keeps the text (the dialog's own Escape decides cancel) | moves focus out (a literal tab is never typed) | the field's | text tool, notes, support center |
| `Number` | commits the typed value and blurs | rolls back to the **gesture baseline** (below) and blurs | moves focus; selects all | the field's, plus the gesture grouping of section 4 | every inspector number |
| `Search` | `Submit` (jumps to the first result) | clears a non-empty field; if empty, blurs | moves focus | the field's | font picker, library, command palette |

- **Rollback is not "the value at focus".** A number field's baseline is the value before the *current gesture*: commit an
  arrow step (the field keeps focus), type another value, press Escape, and only the latest gesture reverts
  (`property-controls.mjs` `_finish`/`_begin`). `NumberField` keeps `baseline`, set at focus and reset by every commit
  that does not blur.
- **Undo and redo in a focused field belong to the field**, unchanged fields and exhausted histories included
  (`app.mjs` 5806: a focused text field gets the native undo; the document is never undone from a field). Ctrl+Z,
  Ctrl+Shift+Z and Ctrl+Y route by focus alone: when `FocusState::text_entry` is set the document's undo is not
  reachable. When the field's history is exhausted Ctrl+Z does nothing.
- Limits (the contract, `limits.rs`): a field has a `max_chars` and an `accept` filter (numeric, no control characters,
  text tool: BMP only and at most 255 distinct UTF-16 units). Both are enforced **before the editor mutates** (section
  2), never by rejecting the value after `on_input`: iced edits, shapes and records history before it publishes.

## 2. The editor patches the fields need

The vendored iced editor stack (`vendor/iced/core/src/text/{editor,input}.rs`, `graphics/src/text/editor.rs`,
`widget/src/{text_input,text_editor}.rs`) is the base; each patch below is in `vendor/*/VENDOR.md` with its reason.

1. **A key's whole text is inserted.** `Binding::Insert(char)` takes the first character of a key's text. A layout key
   that yields two scalars (the Arabic lam-alef key, dead-key results, Telex) lost the rest. `Binding::Insert` now carries
   the whole text (`Edit::Type`), every non-control character of it.
2. **Filtering before mutation.** `Input` takes an `Intake` policy (max characters, accepted-character filter,
   single-line joining). Typed text, a paste and an IME commit all pass through it first: the incoming text is cut to
   what the policy accepts and to the room left (`max_chars` minus the field's characters plus the selected ones), and
   an empty remainder performs **no edit at all** (no history entry, no shaping, no `on_input`). A 100 MB paste is cut
   before it reaches the shaper.
3. **Bounded, coalesced history.** One typing run is one undo step: consecutive typed insertions that continue the same
   run within one second merge into the previous change; a paste, a deletion, a motion or a pause starts a new one.
   History holds at most 200 changes (the oldest drops), and an external `overwrite` (the value changed under the
   field) clears it.
4. **Ctrl+Shift+Z redoes** (Ctrl+Y as well).
5. **Per-run caret motion and ligature selection** (section 7).
6. **A forced bidi base direction** for fields that follow the UI direction rather than their first strong character
   (section 7).
7. **Clipboard requests carry IDs** (section 5).

## 3. Focus model (`styk-core::focus`)

Plain Rust, no toolkit. The interface reports; the core decides.

- **Areas**: `FocusArea { TopBand, Tools, Panels, Stage, Timeline }` plus modal scopes. F6 and Ctrl+F6 cycle the areas
  that currently exist, in order and in reverse, from anywhere, **including from inside a text field** (the text is
  unchanged). While a modal scope is open F6 cycles only inside the modal's regions (or does nothing when it has one).
- **Scopes** form a stack. The root scope is the window; a dialog, menu or popover pushes a scope. Tab and Shift+Tab move
  among the focusable targets **of the top scope** and wrap at both edges (a modal never leaks focus to the page below).
  Opening a scope records the **invoker** (the focused target when it opened) and chooses an initial target (the
  requested one, else the first focusable). Closing a scope restores focus to its invoker; if the invoker is gone or
  disabled, to the nearest still-present target of the scope below, in registration order; else to the first target of the
  area that held it; else nothing. Nested modals restore one level at a time.
- **Targets** are registered by the interface each view pass in tree order: `FocusTarget { id, area, kind, enabled,
  tab_stop }`. A roving group is one target for Tab (its active child).
- **Reconciliation always reports `Option<Id>`.** After any event that can change focus (Tab, click, Escape, a removed or
  disabled field, a panel replaced, programmatic focus) the toolkit side reports what it holds focused:
  `FocusState::reconcile(Option<Id>)`. `None` clears the core's `text_entry` and `composing`. The core never trusts a
  stored focus bit over the report; removing a focused field therefore cannot leave hotkeys suppressed.
- **Keyboard modality**: `focus_visible` is true after a key (Tab, arrows) moved focus and false after a pointer press
  (`:focus-visible`). The ring draws only when it is true; text fields always show their focus halo.
- **Text entry and hotkeys** (`text_entry.rs`): `FocusState` knows whether a text-entry target is focused and whether it
  is composing. `hotkeys_allowed()` is false in both cases; the only chords that still work inside fields are the
  documented ones (F6, Ctrl+F6, Ctrl+Alt+M, Ctrl+Alt+L), and while composing, none. AltGraph chords never trigger
  commands (they type characters).

## 4. Control keyboard behaviour (`styk-design::focus`)

A focusable wrapper alone is not keyboard-operable: each control kind has its own keys, and **a hovered control never
consumes another control's keys** (iced's slider takes arrows by hover; the wrapper takes keys only when it holds focus).

| Control | Keys |
| --- | --- |
| Button, icon button, chip | Space (on release) or Enter activates |
| Checkbox, switch | Space toggles |
| Slider | Left/Down −step, Right/Up +step (mirrored in RTL for Left/Right), Shift ×0.1, Alt ×0.01, PageUp/Down ×10, Home/End min/max |
| Select | Space/Enter/Alt+Down opens; Up/Down moves; Enter chooses; Escape closes and returns focus |
| Tab (a tab list) | roving group: arrows move and select by orientation, Home/End, wrap, skipping disabled |
| Roving group (toolbar, rail) | one Tab stop; arrows per orientation via `roving::next_index` (a port of `nextRovingIndex`) |
| Scrub label | Enter focuses and selects the number field; arrows step like the field (`property_step`) |

**Scrubbing and pointer capture.** A scrub starts on a pointer press on the label and is owned by the label until it
ends. iced's `mouse_interaction` only chooses a cursor, so the label tracks capture itself: while captured it consumes
`CursorMoved`/`ButtonReleased` wherever the pointer is (also outside the widget and the window). A scrub ends, once, on:
release (commit), Escape (rollback), the window losing focus, a touch cancel, the widget being removed from the tree, or
a second press. One gesture is one history entry (the core groups it; the widget only sends `Begin`, `Delta`, `End`,
`Cancel`). A drag below `drag_slop` is a click.

## 5. Clipboard

- Field cut/copy/paste/select-all stay inside the focused field. A paste is **asynchronous** (iced reads on a worker
  thread, D7), so a reply can arrive after focus moved. The runtime stamps each request with a `RequestId`
  (`clipboard::RequestId`) and every reply carries it. An editor accepts a reply only if: it issued that ID, it is still
  focused, and the window is focused. Anything else is dropped (paste in A, focus B before completion: B receives
  nothing, A is no longer focused and drops it). Each editor has at most one request in flight; a second paste while one
  is pending is ignored. A reply applies at the cursor or selection **as it is when the reply arrives** (the user typed
  in between: the paste lands at the caret, like a browser paste). Pending requests die with focus.
- The app-level clipboard (figures, frames) goes through `styk-services::clipboard` and never through field widgets.
  `styk-core::clipboard::Requests` is the app's bounded table: IDs, a target, a kind, a deadline, `deliver(id, target)`
  validates both; at most 8 in flight.

## 6. Input methods

- IME is enabled only while a text-entry target is focused (iced requests `InputMethod::Enabled` on each redraw from the
  focused field). The rectangle is the caret's.
- `composing` is true from the first non-empty `Preedit` to `Commit` or `Closed`; the field reports it
  (`Update::InputMethod`) and `FocusState` holds it. While composing: no hotkey, Escape belongs to the IME, Enter belongs to
  the IME. A commit passes the same `Intake` as a paste.
- Windows uses IMM32 through winit (`ImmGetCompositionStringW`, `ImmSetCompositionWindow`, candidate window excluded around
  the caret). There is no TSF. Real behaviour was run and is recorded in the spike report; a TSF bridge is not a drop-in
  fallback: a text store needs surrounding text, selections, replacement ranges, geometry and lock callbacks, and iced's
  preedit has content, one selection and a size, so a TSF adapter owns a two-way field/text-store contract and is
  designed on its own.
- Verification uses an in-process automation handler on the window's UI thread (IMM contexts belong to the thread that
  created them). It sets and completes a composition on the window's `HIMC`, reads the candidate position, and runs only
  with `STYK_BACKGROUND_WINDOW=1`.

## 7. Right to left

- **`Dir { Ltr, Rtl }`** comes from the locale (`ar`, `he`, pseudo-locale `rtl`) and is passed down as part of the
  widgets' environment, never a global. Changing language rebuilds the view.
- **Mirrored containers.** iced rows are physical. `dir.row(children)` reverses children for `Rtl`; `dir.pad(start,
  end)` swaps left and right; `dir.align_start()` is `Left`/`Right`; `dir.icon(name)` flips directional icons (chevron,
  submenu arrow, tool tick, slider fill, disclosure). Menus open on the start side and swap Left/Right keys.
- **Stays LTR by contract**: numeric fields and units, shortcut badges, the timeline and filmstrips, graphs, canvases,
  world coordinates. A number field forces `Dir::Ltr` and left alignment.
- **Text**: cosmic shapes with the Unicode bidirectional algorithm per line; the base direction is the first strong
  character. A field that follows the UI direction (search, name fields; an empty field's caret side) passes a base
  level to the layout instead of a hidden mark character.
- **Caret and selection in mixed runs** (as Chromium does). Arrow keys are visual. The editor builds, for the layout
  line, the visual list of *grapheme boxes* (a ligature's glyph is divided among its graphemes in the glyph's own
  direction, so the first grapheme of a right-to-left ligature is its right part). Left moves the caret across the
  visually left neighbouring box and lands on that box's left edge; Right is the mirror; a boundary between runs of
  different direction has two logical positions and the landing one is the edge of the box just crossed. So Left inside
  Arabic digits never goes right, Home goes to the visual start of the line (right edge in an RTL paragraph), and a
  ligature is stepped through and selected per grapheme. The caret's x and the selection rectangles come from the same
  boxes. Pure left-to-right lines keep the toolkit's logical motion.
- **Verification** is against Chromium for the same strings: caret stop sequences from `Selection.modify` and
  `getClientRects` of collapsed ranges in an Electron page, selection rectangles from `Range.getClientRects`.

## 8. Test surface

- Pure logic (`styk-core`): unit tests, no window.
- The vendored editor and the widgets: headless tests with iced's `Simulator` and an explicit **effect driver**: the
  simulator discards the runtime's effects, so the driver takes the clipboard and focus requests the widget issued and
  answers them (a clipboard reply with the request ID, a `find_focused` operation result) on the test's schedule, in any
  order. This is what makes "reply after focus moved" testable.
- The component sheet (`stykanimate --screen component-sheet` in the developer build) has the field and focus pages:
  every field role in every state (empty, filled, focused, selected, composing, disabled, error, RTL), the focus ring,
  a roving group, a modal with its Tab boundaries.
- Real IME, RTL, latency: measured as described in section 6 and 7; the results are in the spike report.
