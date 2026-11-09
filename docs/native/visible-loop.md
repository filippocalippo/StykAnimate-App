# Native visible editing loop (V0)

`Core::start_runtime` starts the document facts, timeline and Select lanes. The window's
document pump consumes host completions and attaches the published front project to
its existing Surface. Command-line opens wake that pump; recovery uses the same host
completion path. The existing dock mounts the stage and Properties.

## Selection and Properties

Surface forwards unconsumed pointers and terminal cancellations in queue order.
Interruption identifies its pointer; overflow cancels the current press. Core drains
that input before adopting any selection reply. A left press uses the existing handle,
segment and alpha-aware artwork queries on the Select worker. Selection stays in the
session and adds no history entry. Saved layer locks require `true`; a document's
Focus and lock view also excludes layers outside its focus.
`ViewState::set_layer_focus_lock(document, lineage, focused)` is the owner seam for
A1's focus UI; V0 consumes that state but does not add the later layer controls.

There is one submitted job and one latest lightweight waiting press. Every job owns a
cancellation token. Superseding input, document replacement/close, view changes and
teardown cancel it. Evaluation, geometry, picture decode and raster work observe the
token at their work units. Partial results are discarded, never adopted as a frame or
cached as a failed image. The worker disposes query payloads and decoded artwork;
closing the interface never joins that worker. Replies must still match input identity,
document lineage, revision, playhead, focus version and stage view.

The Inspector context returns to Auto after selection. Its facts lane returns resolved
instance figures, including instance styles. Facts keys include document lineage;
pending context changes rebuild the model. The interface never resolves styles or
builds geometry. Numbers keep the existing field gesture and one undo entry per edit.
B1 owns colour-row commits and B3 owns the picker popover; V0 supplies no colour dialog
or swatch service continuation.

`Effect::RequestFrame` becomes `Message::PollDocuments` in the UI adapter, starting
publication after editing, undo and redo. Worker receipts update Properties, the active
Surface and the band's history state. The always-mounted raw subscription also delivers
a tab release batched with its press; activation schedules the new front publication.

## Files and lifetime

The registry routes New, Open, Save, Save As, Save All and Close through Documents after
panel settlement. Every immediate or asynchronous host effect reaches
`Core::document_effect`, including recovery's Close/Quit Save response. Untitled Save
opens the shared file picker. Cancelling restores the same prompt and document; an
accepted Save fences edits until close/quit finishes. Save answers retain prompt identity,
and Busy continuations retry only on host progress.

Open offers the same six localized filter choices as `desktop/main.cjs`, including
movieclips, figures, Pivot files, Stick Nodes files and archives. Unattended runs refuse
OS pickers; automation supplies file choices at the service boundary.

The Windows picker registers its lifetime on the owner window's thread. No application
HWND enters the detached modal worker. Destruction invalidates the registration; quit
and session end cancel its current run. A hook checks cancellation in the dialog's own
message loop and closes it there. Neither window destruction nor session-end completion
waits for the picker thread, and late results become cancellation.
After the session-end bound expires, Core retires all its deadlines; an abandoned
checkpoint or overlay cannot repeatedly wake a window that is finishing its exit.

Application, engine, document and session clocks are captured per instance. There is
no process-global engine timestamp; parallel test hosts can advance independent clocks.

## Development feature and verification

The reusable feature is `devtools`: `styk-app/devtools` propagates to
`styk-core/devtools`, `styk-platform/devtools`, the existing developer UI and tracing.
Core and platform propagate to `styk-services/devtools`. A crate opts in with its existing
`devtools` feature and forwards `dependency-name/devtools` for each participating dependency;
package builds use `--features devtools`. There is no automation-specific feature.
The platform automation-input module and all app callers require this feature. Both
mouse and numeric-key entry also require the unattended hidden-window strategy.

- `cargo test -p styk-core --test visible_loop`: real document/runtime routing, pen
  interruption/overflow, selection and lock rules, number/history, save/reopen and
  untitled Close/Quit picker continuations.
- `cargo test -p styk-app --features devtools`: mounted controls, publication adapters,
  capture readiness and independent app clocks. Tests use default parallel execution.
- `cargo xtask check-shipping-features`: the default shipping feature graph.
- Build the real app separately with `cargo build -p styk-app --features devtools`.
  From `engine/`, run `stykanimate tests/edit/startup.document.json --automation
  crates/styk-app/automation/visible-loop.styk-auto --size 1560x1000` with
  `STYK_BACKGROUND_WINDOW=1`. The script drives window-addressed input, edits a number,
  undoes/redoes, saves/reopens, switches and closes. PrintWindow captures go to
  `artifacts/native-v0-review/`. Complete glyph frames gate capture; no desktop input
  is injected. The unattended cursor hook removes itself when the window is destroyed.

An unpublished facts reply keeps its request identity until the document host supplies a new
publication receipt. Refreshing pending Properties cannot requeue that same miss and spin
while recovery is holding publication. A receipt delivered before the old reply is consumed
also admits exactly one retry.

Every build, test and app run goes through the machine queue.
