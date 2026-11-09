# V0: close the visible editing loop

Base: `c7612738`. The session remains the owner of selection, playhead, edits and history;
Documents remains the owner of opening, publication, saving and closing. Core's existing
runtime attaches the published document to Surface and feeds the Inspector's facts lane.
No new panel, renderer, document mirror or history is introduced.

`styk_core::tools` owns Select's press routing and one bounded asynchronous pick request.
Surface retains navigation; its unconsumed presses reach tools through Core::dispatch.
Picking uses the existing handle/segment queries and click-only artwork picker on a worker.
Replies are stamped with document lineage, revision, tick and selection and are discarded
after a different interaction, document switch, close or view change. Selection commits
through answers::call and resets the Inspector context to Auto, without adding history.

The existing Inspector supplies figure/joint values and field intents. Its number gesture
continues to own one session edit. Publication, frame demand and worker Progress must
repaint both the stage and Properties after edits, undo/redo, recovery and tab changes.
Registered Open/Save/Save As/Close commands reach the documents host; native picker
effects have a platform service and automation substitutes results at that same boundary.
The existing menu and colour controls are reused wherever their current APIs allow it.

Automation extends the single styk-auto/1 runner and drives mounted widgets in the real
background window, with PrintWindow captures, save/reopen and explicit state assertions.
Regression tests exercise the production handlers with their wires removed first. Final
checks cover changed crates, core/UI/app tests, clippy, the native guard and the live loop.

Decisions: the direct instruction to implement autonomously overrides native-common's
plan-review pause. This plan is committed before implementation without waiting. Existing
widgets may receive routing glue; new views and broader stage tools stay out of V0.

## Review round

Merge 924708fd before fixes, retaining the developer panels and idle wake behavior.
Remove V0's colour service path; keep the facts worker, lineage and pending layout.
Terminal pen cancellation reaches the Select owner before it can adopt a reply.
Each Select identity owns a cooperative cancellation token; evaluation, geometry,
decode and raster work observe it, and the worker disposes its heavy operands.
Untitled Save follows the shared document-effect consumer, retains the close/quit
prompt on picker cancellation, and fences edits after an accepted Save.
Native picker runs use a window-lifetime registration; no app HWND crosses threads.
Reuse the development feature `devtools` across app, core, platform and services.
Inject the engine clock per app and restore default parallel test execution.
Final proof combines changed-crate suites, guards, clippy, removed-wire checks and
the number-only real window loop in one machine-queued batch.
