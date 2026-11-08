# K-timeline core part 1: implementation evidence

Base: `a4aa1e0c4f4d0dbe86d89d7cc652738f97bd8537`.
Plan: `7ea695aba3026d1c3f6840ddc8d9aed8ef49fac2`; approved amendment committed first as
`e63a73ac6a14ab2d4c7890931bfe9c5b4b373084`.

Contracts: [timeline](../timeline.md), [Settings](../settings.md), [plan](../plans/K-timeline-core.md).
Part 1 contains 38 ledger rows (26 direct, 12 adjacent), plus the shared minimum geometry
dependencies TL-033/TL-039. Timeline views and later editing/organization parts are not delivered here.

## Behavior and verification

- `timeline_core`: session-owned navigation, both modes, layer/cell/card selection, sparse Edit together
  targets, exact final scrub delivery, geometry/reveal/edge scrolling, Busy save retention, ranges,
  injected-time pacing and exit fencing. FPS has one history entry with exact undo/redo.
- `stage_surface`: real GPU picture submission, accepted session ticks, first-picture audio start,
  loaded fit preference, pause, and failed audio preparation stopping playback.
- App tests mount the existing stage and drive physical keys through the production adapter and
  worker Progress subscription. The real-storage tests live in `styk-app/tests/settings_storage.rs`:
  cross-owner integration must not add a core-to-platform dependency, including a dev-dependency.
- `settings_storage`: schema-1 values/view separation, unknown fields, future-schema refusal both
  at load and transaction time, separate read-only legacy root, late edits, real failed writes and
  layout backoff, coalescing, load retry, and pre-exit flush through `LocalStorage`.
- The explicit byte oracle runs today's owned editor/export worker twice first: 36 ordinary and
  16 navigation baseline comparisons, with no differing fields. Native initial/FPS/undo/redo saves
  on startup, channels, drawing and Pivot inputs then pass 32 exact comparisons and reopens.
  Reference source is pinned at `99c62189efe10d7471ce4220d8a07ba906453685`; the existing generated WASM
  has SHA-256 `4088518d3d07429c895115c5a1aae3d2f6c3d0ec24d4c01102c7ea6acfe3887e`.
  Its build metadata does not prove a source commit; no such binary provenance claim is made.

All build/test commands use the T1 machine queue. Full run evidence is retained in ignored artifacts:

| Check | Observed result / artifact |
| --- | --- |
| Six changed crates: core, services, edit, platform, UI, app | `1553 passed; 1 failed; 32 ignored` across 133 suites; `timeline-tests.log` |
| Core/app after exit fence and relocating real-storage tests | `648 passed; 1 failed; 10 ignored` across 35 suites; `timeline-core-app-final.log` |
| Unchanged core audio transport rerun | `27 passed; 0 failed; 0 ignored`; `timeline-core-audio-final.log` |
| Unchanged platform audio decode rerun | `9 passed; 0 failed; 1 ignored`; `timeline-platform-audio-final.log` |
| Timeline / settings / stage / mounted app suites | respectively `12 / 5 / 14 / 23 passed`, zero failures; the explicit byte oracle is run separately |
| Old-versus-old oracle | `tests 2; pass 2; fail 0; skipped 0`; `timeline-oracle.log` |
| Native save bytes | `32 exact comparisons and reopens passed`; `timeline-save-bytes.log` |
| Default styk-app build | `Finished dev profile` in `1m 36s`; `timeline-build.log` |
| Six-crate Clippy | `Finished dev profile` in `56.98s`; `timeline-clippy.log` |
| Final core/app Clippy including moved tests | `Finished dev profile` in `1m 51s`; `timeline-clippy-final.log` |
| Core without engine feature | `Finished dev profile` in `4.52s`; `timeline-engine-free.log` |
| Final `cargo xtask check` | Exit 0; dependency/source/interface guards pass, 42 reference screenshots within limits, 41 app/preview PNGs byte-identical; `timeline-guards-final.log` |

The largest reference differing-pixel fraction is `0.019534363`, below its unchanged `0.022` limit.
The two stage screens are app-only by the existing catalogue contract; the engine-free preview
does not draw engine frames. No new timeline-view screenshot claim is made.

Clippy exits successfully but emits existing and new style warnings; this is not a warning-free claim.
The two combined-run failures are retained, not hidden: the unchanged platform cancellation test
returned Cancelled but took 1.67s against its 1s bound, and the unchanged core cancellation test
observed its decoder flag before reservation cleanup. Both unchanged suites pass the targeted reruns
above; no test, threshold or frozen fixture was weakened.

## Self-check

Self-check: done. Compared the whole diff with native-common's Known findings. Fixed the saved
active-layer boundary, sparse range semantics/global dedup, folder ordering, no-document admission,
contended worker retry wake, overlay held-key release notification, audio preparation refusal,
post-exit fencing, and the test-only dependency direction. Expensive projection/evaluation and
resource retirement stay on workers. Terminal scrub intent survives Busy; stale identities are rejected.

Mutation evidence: removing timeline dispatch, settings dispatch, physical-key translation,
production Progress handling, or submission acknowledgement makes the corresponding production-path
test fail. Dense range expansion and no-document admission mutations fail the relevant core tests.
Worker contention and audio preparation refusal were observed failing before their fixes.
Removing the exit fence fails with `no edit may acquire the session after accepted exit`.
Sources were restored; temporary probe scripts were deleted.

## Decisions and remaining integration

- Keep session/history, frames, stage, audio clock, command routing and layout with their current owners.
  Native ready reads replace the browser read-view terminology; there is no document mirror.
- Use asynchronous transactional Storage and its lock/atomic replacement contract. Merge changed keys
  into the latest envelope rather than adding a competing writer/stamp protocol. Settings is the real
  future owner: six currently consumed preferences are typed; other groups/shortcuts remain preserved
  for later typed controls and normalization extensions. Corrupt native files stay read-only; backup
  recovery controls are later Settings work. Missing legacy version/time provenance is not fabricated.
- Keep the canonical timeline selection compact. Resolve Advanced Edit together targets on a worker
  from existing key times; the legacy executable getter, not every highlighted tick, defines them.
- Preserve today's observable quirks: both Simple layer arrows advance; FPS readout uses 250ms;
  folder/layer order and active-layer save boundaries follow executable behavior. A single transient
  saved-active-layer scalar is normalized on the save worker until the next document command.
- Preparation failure stops playback; output-device failure reports a notice and uses silent pacing.
  Readiness is distinct from the stage's post-submission observation.
- Minimum navigation geometry is core-owned now; broader zoom, navigation tools and widgets remain later.
- Existing document confirmation/file-picker UI and OS-session-end wiring are absent at the base.
  This part supplies the shared lifecycle and fenced pre-exit flush, without inventing another save policy.
  The outside-scope finding is recorded in `perf/native/findings/T1-close-adapter.md`.
- The engine inventory render updates the playback-window row but reports six pre-existing unrelated
  missing/stale rows, verified against the base tree. No unrelated inventory migration is included.
- Recursive cache cleanup was rejected by automatic review. A narrower, successful file-only cleanup
  inside five explicitly named obsolete incremental directories created by this task preserved the
  directories and compiled build outputs while restoring disk headroom.

No push, owner-document copy, dependency upgrade, threshold change or frozen-fixture edit.
