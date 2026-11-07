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
| `SingleLine` | commits the edit (a `Commit` message), field keeps focus | reverts to the value at the **latest focus** (leaving and re-entering refreshes it) and blurs | moves focus; focusing by Tab selects all | the field's | names, inspector text, rename |
| `DialogLine` | does **not** blur: sends `Submit`, which the dialog turns into its primary action (`ui-dialog.mjs`) | the dialog's Escape (cancel) | moves focus inside the dialog | the field's | one-line fields of a dialog |
| `Multiline` | inserts a line break; Ctrl+Enter sends `Submit` | blurs the field and keeps the text (the dialog's own Escape decides cancel) | moves focus out (a literal tab is never typed) | the field's | text tool, notes, support center |
| `Number` | commits the typed value and blurs | cancels the open gesture (rolls back to its baseline, below) and **keeps focus**, as `property-controls.mjs` does | moves focus; selects all | the field's, plus the gesture grouping of section 4 | every inspector number |
| `Search` | `Submit` (jumps to the first result) | clears a non-empty field; if empty, blurs | moves focus | the field's | font picker, library, command palette |

- **Rollback is not "the value at focus".** A number field's baseline is the value before the *current gesture*: commit an
  arrow step (the field keeps focus), type another value, press Escape, and only the latest gesture reverts
  (`property-controls.mjs` `_finish`/`_begin`). The model is `styk_core::number::NumberEdit`, a port of that file:
  focusing begins a gesture; typing previews valid text and marks invalid text; Enter commits; **leaving the field
  commits valid text and reverts invalid text** (`_focusOut`); a held arrow key is one gesture that ends at its release;
  a scrub accumulates every movement with *its own* modifiers (a Shift pressed mid-drag does not rescale what was already
  travelled). ArrowUp and ArrowDown step inside the input as well as on the label; Ctrl and Meta arrows pass through to the
  text. A one-line field selects its text when focus comes from the keyboard (Tab, F6, a dialog opening), not when it
  comes from a click.
- **Undo and redo in a focused field belong to the field**, unchanged fields and exhausted histories included
  (`app.mjs` 5806: a focused text field gets the native undo; the document is never undone from a field). Ctrl+Z,
  Ctrl+Shift+Z and Ctrl+Y route by focus alone: when `FocusState::text_entry` is set the document's undo is not
  reachable. When the field's history is exhausted Ctrl+Z does nothing.
- Limits (the contract, `limits.rs`) are enforced **before the editor mutates** (section 2), never by rejecting the value
  after `on_input`: iced edits, shapes and records history before it publishes. **No field refuses text that today's app
  accepts and handles.** A field's limits are the ones it has today: its `maxlength` (16,384 in the text tool and in a
  multiline field), the alphabet (BMP, and 255 distinct UTF-16 units counted over the text that stays plus what comes in, for
  the text tool) and, in a one-line field, no line breaks. There is no limit on the length of a paragraph, of a word, of the
  line breaks or of the marks on a base character: a long paragraph is made cheap to edit instead (section 2, patch 10). The one
  deviation is a field with no `maxlength`, which takes up to 65,536 characters (`CEILING_CHARS`), so that a paste is bounded work.
  Enter is an insertion like any other and is admitted the same way. A lone CR in a paste is a line break (a textarea
  normalises CR and CRLF to LF). The clipboard's own worker cuts text to 1 MiB before it reaches the interface thread, the
  editor cuts again what it is given, and the admission scan stops after 256 Ki characters: both only cap the work on an input
  larger than any field takes.

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
   Moving the caret, selecting, clicking and leaving the field end the group (type `a`, Left, Right, `b`: two steps). A group
   stops growing at 1,024 items. The history holds at most 200 changes **and at most 1 MiB of text** (the oldest drops), so a few
   large pastes cannot hold megabytes of undo. An external `overwrite` (the value changed under the field) clears it.
4. **Ctrl+Shift+Z redoes** (Ctrl+Y as well).
5. **Caret and selection geometry across mixed runs and ligatures** (section 7). Caret *motion* needed no patch: it already matches Chromium.
6. **A forced bidi base direction** for fields that follow the UI direction rather than their first strong character
   (section 7).
7. **Clipboard requests carry IDs** (section 5).
8. **Field identity and lifetime.** A text input's state belongs to its widget ID: another field built at the same place in
   the tree starts clean (no focus, composition, pending paste or history of the one it replaced), and a field that is
   disabled loses focus then and there, so enabling it again does not bring focus or a paste back.
9. **Keys the field owns are handled.** Ctrl+C and Ctrl+X with nothing selected, and a second Ctrl+V while a paste is
   pending, are captured: they never reach the document's copy and paste.
10. **Long paragraphs are cheap to edit** (`cosmic-text`, `shape.rs`, `shape_run_cache.rs`). The editor reshapes the whole
    paragraph on every edit; the cost was in shaping every word again. The shaped-run cache (cosmic's own `shape-run-cache`
    feature, on, keyed also by direction, bounded by run size and entry count, trimmed by the editor) holds the words, so an
    edit shapes the words it touches. A run longer than 1,024 bytes (one very long word, or text without spaces) is cut into
    chunks of about 256 bytes at grapheme boundaries, which the cache holds in the same way (not for scripts that join letters),
    and a base with more than 32 combining marks is cut into segments of 32. The caret's x is found in one pass over the
    glyphs of its line (it was a pass per glyph in a line without wrapping). Reshaping only the touched words inside the
    editor needed no patch beyond this.

## 3. Focus model (`styk-core::focus`)

Plain Rust, no toolkit. The interface reports; the core decides.

- **Areas**: `FocusArea { TopBand, Tools, Panels, Stage, Timeline }` plus modal scopes. F6 is the next area and Ctrl+F6 the
  previous (`focus-next-region`, `focus-previous-region` in `src/hotkeys.mjs`); they cycle the areas that currently exist
  from anywhere, **including from inside a text field** (the text is unchanged), but not while an input method composes.
  **Shift+F6 is Remove keyframes** and is neither navigation nor a chord that works from a field: the only chords that work
  from a text field are F6, Ctrl+F6, Ctrl+Alt+M and Ctrl+Alt+L. While a modal scope is open F6 cycles only inside the modal's regions (or does nothing when it has one).
- **Scopes** form a stack. The root scope is the window; a dialog, menu or popover pushes a scope. Tab and Shift+Tab move
  among the focusable targets **of the top scope** and wrap at both edges (a modal never leaks focus to the page below).
  Opening a scope records the **invoker** (the focused target when it opened) and chooses an initial target (the
  requested one, else the first focusable). Closing a scope restores focus to its invoker; if the invoker is gone or
  disabled, to the nearest still-present target of the scope below, in registration order; else to the first target of the
  area that held it; else nothing. Nested modals restore one level at a time. **A scope contains the modal interaction, not
  only Tab**: while it is open only its targets can hold focus (`reconcile` and `focus` refuse the page's, and `reconcile`
  returns the stale one so the interface takes focus from it), and the `Scope` widget consumes every pointer event the dialog
  did not take, so a click on a field behind the dialog reaches nothing.
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
consumes another control's keys** (iced's slider takes arrows by hover). The wrapper is the one keyboard owner: it answers
the control's keys itself, only while it is enabled and holds focus, and captures them; the control inside is given no key
while the wrapper is not focused or has already answered, and no input at all while it is disabled.

| Control | Keys |
| --- | --- |
| Button, icon button, chip | Space (on release) or Enter activates |
| Checkbox, switch | Space toggles |
| Slider | Left/Down −step, Right/Up +step (mirrored in RTL for Left/Right), Shift ×0.1, Alt ×0.01, PageUp/Down ×10, Home/End min/max |
| Select | Space/Enter/Alt+Down opens; Up/Down moves; Enter chooses; Escape closes and returns focus |
| Tab (a tab list) | roving group: arrows move and select by orientation, Home/End, wrap, skipping disabled |
| Roving group (toolbar, rail) | one Tab stop; arrows per orientation via `roving::next_index` (a port of `nextRovingIndex`) |
| Scrub label | Enter focuses and selects the number field; Up/Right and Down/Left step like the field (`property_step`), Ctrl and Meta arrows pass through, a held key is one gesture ended by its release. No wheel stepping: today's fields do not step on the wheel |

**Scrubbing and pointer capture.** A scrub starts on a pointer press on the label and is owned by the label until it
ends. iced's `mouse_interaction` only chooses a cursor, so the label tracks capture itself: while captured it consumes
`CursorMoved`/`ButtonReleased` wherever the pointer is (also outside the widget and the window). A scrub ends, once, on:
release (commit), Escape (rollback), the window losing focus, a touch cancel, a second press, or **capture lost** (a
system menu or another window took the mouse: no event says so, so a scrub asks the system whether the primary button is
still down, `styk_platform::input::primary_button_down`, a read and never an injection) , each reported once as `End` or
`Cancel`. **The gesture's owner survives the widget**: a label removed from the tree or disabled mid-gesture cannot
publish, so the core reports it (`FocusState::take_removed`, returned by `focus::sync`) and the owner calls
`NumberEdit::scrub_cancel`, which is a no-op when a terminal result already happened. `Delta` carries the movement since the
previous one with the modifiers held at that movement. One gesture is one history entry (the core groups it; the widget
only sends `Begin`, `Delta`, `End`, `Cancel`). A drag below the drag slop is a click.

## 5. Clipboard

- Field cut/copy/paste/select-all stay inside the focused field. A paste is **asynchronous** (iced reads on a worker
  thread, D7), so a reply can arrive after focus moved. The runtime stamps each request with a `RequestId`
  (`clipboard::RequestId`) and every reply carries it. An editor accepts a reply only if: it issued that ID, it is still
  focused, and the window is focused. Anything else is dropped (paste in A, focus B before completion: B receives
  nothing, A is no longer focused and drops it). Each editor has at most one request in flight; a second paste while one
  is pending is ignored (and captured). **The clipboard work is bounded as a whole**: one worker thread serves every read and
  write in order through a queue of 8; a request that finds it full is answered at once with `ClipboardOccupied` (the
  requester sees a failure instead of a thread piling up behind a stuck clipboard); a field that loses focus cancels its
  pending read, which the worker skips if it has not started it, and the memory of cancelled requests is bounded. A reply applies at the cursor or selection **as it is when the reply arrives** (the user typed
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
- Verification uses an in-process automation handler on the window's UI thread (IMM contexts and keyboard layouts belong
  to the thread that created them): `styk_platform::input`, driven by the developer build's
  `stykanimate --screen component-sheet --input-check <report.json>`. It never injects system input and never shows a
  window: it switches its own thread to a layout, posts messages to its own window, sets the composition string on the
  window's `HIMC` and reads the candidate position the application asked for.
- **What this machine has.** Keyboard layouts ship with Windows, so the Arabic and Hebrew layouts load with no language
  pack. No input method is installed (the user's list is Italian and US; the Microsoft Japanese and Pinyin profiles are
  not registered), so no real IME composition can be run here: with none, nothing sends `WM_IME_COMPOSITION` by itself.
  The check sets the string and delivers the messages an IME would; winit's handler reads the composition back through
  `ImmGetCompositionStringW`, which stays empty without one, so no preedit reaches the field from this path. A pass with
  Microsoft Japanese IME, Pinyin and the Arabic and Hebrew IMEs is **a manual pass for the owner**; the field-side
  contract (preedit, commit through the limits, `composing`, silenced hotkeys) is proven headless with iced's input-method
  events.

### The owner's manual pass (decision N7: it gates the release, not the interface work)

Run on a machine with the input methods installed, in `stykanimate --screen component-sheet` (the single-line field, the
search field and the text area; each item in a 100 % and a 150 % display scale):

1. **Microsoft Japanese IME** (hiragana input of `nihon`, then convert). *Composition:* the preedit is shown at the caret,
   underlined, and the keys of the sheet (Delete, V, F6) do nothing while it is open. *Candidate selection:* Space opens
   the candidate list, arrows and digits choose, Enter commits 日本 once. *Cancel:* Escape ends the composition and leaves the
   field's text as it was (and does not blur the field). *Placement:* the candidate window opens at the caret, below it;
   move the window to the bottom edge and to the right edge of the screen and to a second monitor at a different scale: it
   stays on screen next to the caret each time.
2. **Microsoft Pinyin** (`zhongwen`): the same four points; a committed 中文 passes the field's limits (type into a field
   that is almost full: the commit is cut, not the field overrun).
3. **The Arabic and Hebrew keyboards** (layouts, and the IMEs where installed): the lam-alef key (`B` on Arabic) types both
   scalars; the caret and selection in "مرحبا بالعالم 123" and "שלום עולם 123" move one grapheme per arrow key, in the
   paragraph's direction; a paste of mixed text keeps its order; in the Arabic interface (`Direction` button) an empty
   field has its caret at the right edge.
4. **Alt+Tab away during a composition**, and a click outside the field during one: the composition is closed or committed
   as Windows does for a browser text box, and the field is left clean (not composing, no stuck preedit, hotkeys work).

Anything that differs is fixed in the field widgets or the vendored winit/iced input code (the one place every panel's
field comes from); it does not touch a panel.

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
- **Caret motion is logical, in the paragraph's direction, as Chromium's is on Windows.** The review of the first
  design assumed visual arrow keys. Measured in the Electron the app ships (an `<input dir=auto>` and a contenteditable
  give identical results, `engine/crates/styk-design/tests/fixtures/chromium-caret.txt`): in a right-to-left
  paragraph Left visits the UTF-16 offsets 0, 1, 2, ... N in order, through embedded Latin and digits too (it moves
  *right* inside "123"), and Right does nothing at offset 0; in a left-to-right paragraph holding Arabic, Right visits
  0..N and Left N..0; a lam-alef ligature is stepped per grapheme (three stops for two characters). cosmic-text's
  `Motion::Left/Right` already do exactly this, so motion is unchanged and a visual-order implementation would have been
  a deviation.
- **Caret x and selection geometry follow the runs.** The editor divides a glyph's cluster among its graphemes in the
  glyph's own direction (the first grapheme of a right-to-left ligature is its right part): `cosmic_text::grapheme_boxes`.
  The caret's x (`caret_x`: the trailing edge of the grapheme before it, or the leading edge of the one after, by
  affinity, so a run boundary has two carets), the selection rectangles and a click inside a ligature all come from the
  same division. Before, the caret x summed glyph widths left to right (wrong in right-to-left lines and at index 0,
  where it underflowed) and a right-to-left ligature's graphemes were laid out mirrored.
- **Verification** is against Chromium for the same strings: the offset sequences of repeated arrow presses
  (`Input.dispatchKeyEvent` through the DevTools protocol in an off-screen Electron window) against the native editor's.

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

## 9. Results (2026-11-07, after the review and the checker)

Measured on the Windows 11 development machine (Ryzen 5 5500, RTX 4070 SUPER, 144 Hz) while other agents were building:
the latency numbers are directional.

| Check | Result |
| --- | --- |
| Pure models (`styk-core`: focus and scopes, text entry, roving, number gestures, limits, field roles, clipboard table, slider and select keys) | 65 tests pass |
| Widgets on the headless driver with explicit clipboard and focus effects (`styk-design`, feature `testing`) | 82 tests pass. Each finding of the review and of the checker has a test that failed on the code it was found in (that run: 7 core, 19 widget and 1 sheet tests failed, among them a 100 MB paste that took 45.9 s on the interface thread) |
| Caret motion against Chromium | The native editor's offset sequences equal those Chromium (Electron on Windows 11) visits, for six strings, both directions, both ends (`tests/fixtures/chromium-caret.txt`; rerun 2026-11-07: identical). Chromium moves logically in the paragraph's direction |
| Caret geometry | Per-cluster extents (a base and its marks drawn by several glyphs are one cluster), run-boundary carets, right-to-left ligatures: 5 tests in `cosmic-text` |
| Clipboard | One bounded worker: a full queue answers at once with `ClipboardOccupied` (a test in `iced_winit`); cancelled requests are noted once and the memory is bounded (a test in `iced_core`); a field that loses focus cancels its pending read (a widget test) |
| Arabic and Hebrew keys in the real window | The Arabic layout's `B` key reaches the field as both scalars of lam-alef and the Hebrew `A` key as shin (posted to the window's own message queue on its UI thread). The one-line field had selected its text when it took focus, so the typed characters replaced it, as after a Tab into a field |
| Input method | Not run for real: no IME is installed here (section 6); the manual pass is listed there. The candidate window was asked for the caret's rectangle (1 x 18 px, inside the field) |
| Keystroke to presentation, release build, every key accepted (the 16,300-character and marks rows post 80 keys: the field has room for 84 more) | **200-character field:** to the start of the redraw p50 7.4 ms (a refresh is 6.9 ms), p95 9.2; to presentation p50 13.5, p95 14.9, max 15.6. **16,100 characters in 80-character lines:** presentation p50 13.3, p95 17.8, max 31.7. **15,600 characters in four paragraphs of 3,900:** presentation p50 13.5, p95 15.1, max 18.4. **16,300 characters on one line (one word):** presentation p50 13.4, p95 15.8, max 23.9. **One letter and 16,299 combining marks:** presentation p50 14.1, p95 16.5, max 17.3 |
| Chromium, same machine, key event to the second animation frame after `input` (rerun) | `<input>` with 200 characters: p50 5.3 ms, p95 8.8, p99 10.1. `<textarea>` with 16,300 characters: p50 5.7, p95 9.8, p99 11.8 |

Reading the latency rows: C1 (p95 at most one frame plus 4 ms, 20.7 ms at 60 Hz) and C2 (p95 at most 33 ms, no frame over
50 ms) pass in every case above. The native figure to presentation includes the surface's wait for the display (`present`
returns once the frame is queued behind the previous one); Chromium's stops at the second animation frame, before its
own presentation, so the two are not equal measures: the native number is about one refresh above where Chromium's would
be with the same wait. Before the limits were removed and the editor made cheap on long text (section 2, patch 10), one edit of a 16,300-character word took 34 ms in the widget (20 ms of it shaping), a base with 16,383 marks 45 ms, and the caret of a line without wrapping 72 ms; they take 3.5, 4.4 and 0.2 ms now (release, the widget bench `bench_widget_key` and `bench_edit_cost`, `--ignored`). The harness posts keys only into text the field has room for and
reports how many were accepted, so a run in which a key was refused says it is invalid instead of measuring rejections.
