# How to build a panel (the reference slice)

Every interface chunk follows this page. The worked example is the Properties panel (the Inspector):
`engine/crates/styk-core/src/inspector/` and `engine/crates/styk-ui/src/inspector.rs`. Copy its shapes; where your panel
needs something this page does not cover, say so in your report instead of inventing a second pattern.

## Where state lives

| State | Owner | Read through | Example |
| --- | --- | --- | --- |
| The document, its history, selection, selected joint, playhead, active layer | the tab's `styk-edit` session | on the interface thread only the reads that cannot evaluate ([below](#facts-from-the-workers)); they fail while the session is busy | a figure's `root_x`, `history.undo` |
| Clipboards | the documents' shared clipboards (`Documents::call` carries them across tabs) | `Documents::has_clipboard(kind)` | the camera pose `camera-copy` copied |
| Facts that need evaluation or geometry | made on a background lane ([`styk_core::facts`](#facts-from-the-workers)) | the panel's last ready facts | several figures' bounds |
| View state features depend on | `styk_core::view_state::ViewState` (one per window) | its getters; changes through its setters, which bump `version()` | the tab and context, Edit together and its frames, the Draw tool |
| A panel's own state | the panel's core struct (`inspector::Panel`, `PanelState`) | the panel's view model and small read methods | the field being edited and its gesture, a pager's page, the camera's Transform/Motion tab, the section memory |
| Focus | `styk_core::focus::FocusState` in `Core` | `Core::focus` | which target holds focus, the scopes |
| Widget-only state | iced | never read by the core | hover, a text cursor, a scroll offset |

One owner per fact: nothing above is copied into another layer and kept in sync. The core never writes a document in
place; a panel only ever holds `&Document`, and every change is a session call.

Engine types (`Value`, `EditError`, `Selection`, the session's answer and view, the typed document, `Engine`) are named
only in `styk-core`, through `styk_core::engine` (`docs/native/architecture.md`). `styk-ui`, its tests included, never
names that module or an engine crate: views get plain view models and send messages, and a UI test drives documents
through `styk_core::testing` (JSON arguments, `select_all`, `undo_depth`, `settle_facts`).

## The files of a panel

- `styk-core/src/<panel>/model.rs`: the view model, plain data (`Clone + PartialEq`), no engine types, no borrowed
  document, no finished text: a label is an `i18n::Label` (a message key with parameters, or the document's own text).
- `styk-core/src/<panel>/contexts.rs`: builds the model from the session's ready reads (the frame on show handed in by
  the refresh), the view state and the panel's ready facts. Today's descriptor functions are ported here, line by line.
- `styk-core/src/<panel>/mod.rs`: the panel's state, its `Event` enum (what the view can say), `update`, `refresh`, and
  its `app::Lifecycle`.
- `styk-core/src/<panel>/...`: the panel's logic (the Inspector's `property.rs`, `order.rs`).
- Command handlers live with their feature (`history.rs`, `selection_actions.rs`, `camera_actions.rs`), never in `Core`.
- `styk-ui/src/<panel>.rs`: the view. It reads the model, draws it with `styk-design`'s tokens and widgets and sends
  `Message`s. Nothing there decides behaviour: enabled states, ranges, labels, the next option of a select, which
  sections show all come from the core. It fills the bounds it is given; `styk_ui::dock` decides them until docking
  lands.
- Tests: `styk-core/tests/<panel>.rs` (logic), `styk-ui/tests/<panel>.rs` and `<panel>.auto` (headless), screens in the
  catalogue.

## The flow

```
widget event ──► styk_ui::Message ──► styk_ui::message::update(core, message)
   Command(c) ─► Core::dispatch(c): a CommandId goes to its owner's handler, a panel Event to the panel
                 every session call ─► answers::call ─► result or Msg; events kept in the dispatch's record
                 Core::refresh(): view models rebuilt when their key changed; fact requests placed
                 Vec<Effect> ─► iced tasks (focus, blur; later dialogs, jobs, frames)
   Key / Snapshot ─► the core's focus state (Tab, F6) ─► a focus task
   widget-only (focus a field after a label click) ─► a task, no core call
view(&Core) reads core.inspector().model(), .field(), .rename(), core.presentation() only
```

- `styk_core::commands::Command` is the one command type: `Run(CommandId)` for registry commands, `Activate(DocumentId)`
  for a tab switch, one variant per panel for its controls. `CommandId::info()` is the registry: label, owner and (K-cmd)
  shortcut and enabled state in the same place. `Core` routes a command to its owner; a command whose feature has not
  landed answers `Effect::NotAvailable(id)`.
- **The answer adapter.** Every session call goes through `styk_core::answers::call`: the result becomes a value or a
  `Msg` (the error policy's key and parameters), and the answer's events, drawing forks, retirement and copied clipboard
  go to `answers::Session`, the dispatch's record (`Core::session_report`), whatever the result. A refusal never loses its
  events (`docs/native/documents.md`).
- **D7.** No blocking wait is not enough: nothing on `update`, `view` or `refresh` evaluates a frame at a new state for a
  derived fact, builds geometry or measures figures. Those are facts from the workers.

## Facts from the workers

**What the interface thread may read.** A refresh and a view model's builder read only what the session already holds:

| Safe on the interface thread | Never there (they may evaluate or convert) |
| --- | --- |
| `Document::records`, `selection`, `view` (playhead, frame index, history, `editing`), `revision`, `id` | `Document::frame_records`, `with_document`, `read` (`animationValue` and the other named reads) |
| `Document::frame_records_ready`, `with_document_ready`, `animation_value_ready`: `None` means "not ready" | anything that builds geometry, measures figures or evaluates a frame |

Commands and gestures run inside a dispatch, where the session's own calls evaluate anyway; they may use the full
reads (`property::Gesture` does). A refresh never does.

**What is not ready comes from a worker.** The frame on show, the document's typed views and every derived fact that
needs evaluation or geometry (the selection's bounds) are made by `styk_core::facts` on a `styk_services::worker::Worker`
lane from the document's published generation (the `FrameDocument` seam the frame scheduler reads), with the same
function the session uses (`styk_edit::editor_frame`), and stamped with a `FactsKey` (document, revision, playhead tick,
selection). The interface only `try_lock`s the lane's exchange. A landed evaluation is adopted by its document
(`Document::adopt_evaluation`, a handle move, only at the revision it was made for), so the next ready read answers.
Until the frame on show and the views are ready the panel is **pending** (`Panel::pending`): its last model with every
value read from the frame cleared and every control disabled (`contexts::pending`). A revision not published yet is
not an answer: the panel asks again at its next refresh.

**A fact is shown only under its complete current key.** Facts of another selection, revision or playhead are not shown
at all: the row is `pending` (empty, disabled), so a gesture can never take a stale fact as its origin or denominator.
A new fact gets its own field in `facts::Ready`, is computed in `facts::make` and holds its key; the model's key holds
the facts shown.

## The lifecycle

`app::Lifecycle` is the one lifecycle every panel implements: `finish` commits what the panel has open, as today's
`finishCurrentEdit`: the number field's gesture, then any name being typed (the header's rename, a text row). `Core`
calls it on every panel before a command runs and before another document becomes active (`Command::Activate`), so a
draft never outlives its document. A draft keeps the document and target it began on and settles there, exactly as
today's input does when it loses focus (a name commits when it changed and is not blank; Escape keeps the old one). A
panel's `refresh` checks document identity before it defers anything: a gesture whose document is no longer active is
cancelled on that document, a draft whose document went away is dropped, and a busy session keeps the previous model.

## View models

- Built by the core, cached by a key holding every input: the document id and revision, the frame on show (compared
  with `same_node`, which covers live previews), the selection, the playhead, the view-state, panel-state and memory
  versions, the facts shown, the clipboards a button depends on. A rebuilt model equal to the last keeps the old `Arc`.
- Not rebuilt while a gesture of the active document is open (today the Inspector defers its refresh during a property
  gesture and never reflows a field being typed in); the field being edited is drawn from the panel's live field state.
- A descriptor model: the core says what (sections of rows), the kit in `styk-ui` says how. A part another chunk builds
  is a `Row::Slot(Slot::...)`: its place is kept, nothing is drawn until that chunk fills it (camera monitor and motion,
  parallax, IK, drawing sets, movieclip, spatial and Draw sections, builder surfaces; the colour picker plugs in at
  `Effect::PickColor(target)`, the VFX stack as its own panel on this pattern).

## Edits and undo

- A gesture (a scrub, a held arrow key, a typed value until it commits, a draw-order move) is one history entry, as
  today. `inspector::property::Gesture` is the pattern: `begin` opens the session's gesture (`beginAnimationEdit` for a
  channel or a draw order, `beginDrag` for a pose, nothing for project fields), `preview` shows each value through the
  session, `commit` ends it as one entry (`addAnimationKeys`/`setPoseProperty` over Edit together's frames), `cancel`
  restores and leaves none. **Every end that does not commit, and every refusal, cancels the session's gesture
  explicitly** before the panel lets go of it: the session is never left editing.
- The session gesture begins from the value before the first change (a step or a keystroke), never after it.
- Edit together is `styk_core::range::Range`, today's `rangeFrames()` exactly: on a layer sheet the frame on show's index
  with `sheetTicks` (the chosen ticks, then the playhead's), on a classic document the chosen keyframes and the frame on
  show's. Every range route takes it (channels, poses, the selection's commands, alignment, camera paste).
- A discrete control (a switch, a select, a rename, a fill's delete or order step) is one session command, one entry.
- Undo and redo are `Command::Run(CommandId::Undo | Redo)`, owned by `history.rs`; open edits finish first.
- Invalid typed text never reaches the session: the field shows the field model's message.

## Text

`i18n::Msg { key, params }` names a message; `i18n::Presentation` formats it in the selected locale (`Core::set_locale`,
`Core::presentation`): the locale's catalogue, else English's (today's fallbacks), the locale's direction, CLDR plural
rules and `Intl.NumberFormat` numbers through ICU4X 1.4 (CLDR 44, the data of Electron 39's ICU 74; Latin digits, as
Electron writes every catalogue locale; a plural form chosen for the count rounded as `Intl` rounds it). The catalogue is a
language-neutral data set committed in `engine/crates/styk-core/locales/`, generated from `src/locales/*.mjs` by
`cargo xtask locales generate`; `build.rs` packs it into a table read in place; `cargo xtask check` fails while the
JavaScript exists and the two differ. Models keep text unresolved; only the view formats it, through the presentation.
A panel test asserts every key it shows exists; `tests/presentation.rs` compares numbers and plural forms with an
Electron 39 renderer's `Intl` for all 27 locales (`automation/inspector-reference/intl.cjs`), Kazakh's numbers aside:
Electron has none and writes the system locale's.

## Focus

Every control a person can reach is a `Focusable` registered with the core's focus state: buttons, number labels and
inputs, switches (Space toggles), selects (arrows step the value; the core picks the option), a renamable name (Enter or
F2 renames). A panel that moves focus answers `Effect::Focus(request)` (the rename field as it opens, the name as it
closes); the view maps a request to its focus target.

**Input methods.** Every text input of a panel (number values, names, text rows) passes the core's composition state
to its field and reports compositions back: `.composing(core.focus().composing())` and
`.on_compose(Message::Compose)`; `Message::Compose` sets the focus state (`docs/native/text-input.md`). While a
composition is open, Enter and Escape belong to the input method and commit or cancel nothing in the panel.
`inspector::View::of(core, theme)` hands the view the state it needs.

## Testing a panel

1. **Core tests, no window** (`styk-core/tests/inspector.rs`, `inspector_review.rs`): real fixtures through
   `styk_core::testing::core_with_document` (the same opening as the screens); each context's model; every mapping of a
   control to session calls; one history entry per gesture; undo and redo restoring the records exactly; refusals as
   messages; the lifecycle; the cache; facts against an independent measurement of today's app.
2. **The automated interaction is a script of the app's automation language** (`styk_core::automation`, header
   `styk-auto/1`; `docs/native/architecture.md`, "The automation mode and the benchmark"). A panel adds its own steps
   there (the Inspector's: `select`, `inspector scrub|type|step|context`, `expect property`, `expect history`), never a
   format of its own. Its headless test (`the_interaction_script_runs_through_the_widgets`) runs the script through the
   real widgets (`styk_design::widgets::testing::Driver`: a drag from the label's laid-out bounds, keys in the input) and
   checks each `expect`.
3. **Focus with keys**: walk the panel with Tab through the core's focus state and check every kind of control is a stop.
4. **Screens**: each context is a catalogue screen (`styk_ui::screens`, `inspector-<context>[-dark]`, built by
   `styk_core::screens`), rendered by `stykanimate --screen` and compared by `cargo xtask check` with today's panel
   captured by the harness beside the band's (`engine/crates/styk-app/automation/inspector-reference/`: bundled
   Chromium, LCD text on, opaque surfaces, device scale 1; a context is entered as a person enters it, never by
   setting state a selection resets). Judge a screen as N8 says: side by side at 100 % and 200 %, the same layout and
   sizes within about 1 px, the same tokens, icons, radii, states and text; fix what visibly differs, never edges. The
   guard counts pixels past a channel difference of 24; the limit in `docs/native/screens/limits.toml` sits a little
   above the measurement, with a reason above 0.02. A part another chunk owns keeps its place in the panel at today's
   size (`Row::Slot`, the header menu's and quick actions' places, the Library footer) and is **masked** in
   `limits.toml`: a rectangle naming its owner, which the owner removes when it lands.

## Checklist for a new panel

- [ ] Model types plain data; no engine type, no borrowed document, no finished text built in the core.
- [ ] Every control sends an `Event`; every button a `CommandId` or a panel action; nothing in the view decides behaviour.
- [ ] Each gesture one entry; any failed or abandoned end cancels the session's gesture; undo and redo tested per kind.
- [ ] The panel implements `Lifecycle`; its refresh checks document identity before deferring.
- [ ] The refresh reads only the ready reads; frames, views and facts that need evaluation come from a lane, shown
      only under their exact key; the panel is pending until they land.
- [ ] Every text input wires the composition gate.
- [ ] Every session call through `answers::call`.
- [ ] The model's key holds every input; no rebuild while a gesture is open.
- [ ] Core tests, an automation script, focus with keys, screens in both themes with measured limits.
- [ ] `cargo xtask check` passes.

## Catalogue screenshot loop

Use the developer-only `styk-screens` binary for catalogue iterations:

```sh
cargo build --locked --manifest-path engine/Cargo.toml -p styk-screens
STYK_BACKGROUND_WINDOW=1 engine/target/debug/styk-screens --screen band --size 1560x900 --scale 1 --screenshot artifacts/band.png
```

Run builds and captures through the machine queue. Build this package in its own Cargo
invocation: building it together with the app unifies the core's engine feature and loses
the cheaper graph. The preview always runs headless, even without an environment override.

The catalogue, fixture models, fonts, widgets and headless renderer are shared with
`stykanimate --screen`. The renderer lives in `styk-ui::headless`; hosts inject the platform's
font smoothing, redraw timestamp and asynchronous retry timer. The retry limit is unchanged.
The catalogue holds the component sheet, the controls page (light and dark: every design-system control in every
state, no models needed), four band states and eighteen Inspector screens (nine
contexts in both themes). The preview draws Inspector models generated by the real core; the app
continues to prepare its core independently, so exact PNG identity detects model drift. None is
app-only. `View::model` draws prepared data; `View::of` is the engine-gated live-core adapter.

To deliberately regenerate prepared models after a model contract change, run through the queue:

```sh
STYK_BACKGROUND_WINDOW=1 cargo run --locked --manifest-path engine/Cargo.toml -p styk-app --example prepare_inspector -- artifacts/inspector-models
node scripts/native-inspector-models.mjs artifacts/inspector-models
```

Commit `styk-ui/src/screens/models/*.rs` with the change. This generator never writes screenshot
references, and ordinary checks never regenerate models. It converts typed Debug data to Rust
expressions using the model declarations, preserving infinities without adding a codec dependency.
The generator refuses active field/rename/composition state until its prepared model is extended.

The core's default `engine` feature retains the application behaviour. Turning it off exposes
portable controls, focus, launch parsing, document identities, shell models, command identities,
localization and Inspector descriptors/events. The design
system does not enable the engine. The UI keeps its engine-backed pen lab behind its default
`engine` feature; catalogue-only hosts turn that off. Application hosts and document tests
keep the defaults.

Before reporting a chunk done, run `cargo xtask check`: it still checks references through the
real app, then renders every catalogue entry through both binaries and rejects any PNG byte
difference. Both use the same deterministic PNG encoder, so byte identity proves pixel identity.
Missing captures, render failures and timeouts fail; references and thresholds are never changed.
The same gate checks the separately resolved preview dependency graph. Shipping graph and symbol
guards reject `styk-screens`; no production package may depend on it.

The gate separately compiles `styk-ui --no-default-features --lib`, with the core engine off.
The engine-backed pen lab is excluded; live adapters are gated in their existing files.

The model-only graph also contains `styk-doc`, the leaf value store used by the ungated docking
layout's unknown fields and persistence. It still excludes evaluation, editing, scheduling and
rendering engine crates. Layout and overlay logic, registry metadata and plain stage navigation
remain available without the core engine feature; document/painter adapters require it.

The preview also installs the application's native GPU policy (Direct3D 12/FXC preference,
explicit environment overrides and ordered fallback). The engine renderer and preview host
compile the single `engine/shared/native_gpu_policy.rs` module against their existing wgpu
re-export; the preview does not link the engine renderer to obtain this configuration.
K-stage's application policy exposed a real app/preview byte mismatch when the preview still
used iced's defaults. The same catalogue byte-identity guard covers this host configuration.
