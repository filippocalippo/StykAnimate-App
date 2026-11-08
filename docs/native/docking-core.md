# Docking core

`styk_core::layout` owns arrangements. It has no toolkit, thread, clock or file access.
This is the core implementation for K-dock; UI integration remains separate. K-store supplies the Windows storage adapter.
The accepted review changes are part of the model: an overlay is a placement, a stage can float,
Layers can join the timeline without extra chrome, return placements have stable anchors,
and workspace state retains arrangements by monitor setup.

## API and ownership

- `Layout::apply` validates the incoming layout, applies an operation to a candidate, validates the
  result and publishes it atomically. Failure leaves the original unchanged. Closed panels remain
  recoverable; unavailable Structure is dormant outside Build. Unknown panel kinds remain data.
- `Node` supports n-ary splits with pixel or weighted allocations. `TabGroup` owns order, activation,
  collapsed state and flyout extent. `PanelId` is the identity, including secondary stages.
- `ReturnPlacement` captures the original tab index, group, sibling, side and allocation. Moving out
  of a floating host keeps the original return anchor. Group moves capture all anchors before removing
  any tab; docking back restores the saved order and the floating group's active tab. A missing anchor
  falls back to the panel home.
- `LayoutState` keeps at most 20 layout undo steps, independently of document history. Focus uses a
  separate snapshot. Preset changes leave Focus; ordinary changes during Focus do not destroy its
  snapshot. `switch_setup` preserves other arrangements and clears transient undo history.
- `solve` returns rectangles, headers, divider ranges, strips/sheets, visibility and stage viewports.
  Supply the previous `FitState` for 16-pixel unfolding hysteresis. Never persist a `Solution`.
  Release thresholds survive intermediate resizes on both axes. The main root may be empty when its
  groups have moved to floats. `Solution::hosts` identifies each node's coordinate space; groups, headers
  and dividers are host-local logical rectangles. `floats` remains physical, while `float_contents` and
  `float_scales` expose the conversion through the chosen monitor. Set `Env::hit_host` for float hit
  testing. Collapsed floats roll up to a 44-logical-pixel header without changing stored frames.
- `resize_divider` calculates neighbour allocations from solved geometry, preserving the combined
  weight of two flexible neighbours. `DragSession` holds an immutable origin and preview until release;
  cancellation does not change the live layout. `preview` uses the same transaction as release.
- `Env::with_monitors` adapts S6's monitor records and setup identity. Physical float frames are distinct
  from logical dock geometry. `place_float` records explicit movement and its relative monitor frame;
  fitting a float never changes its history. The latest eight explicit frames are retained.

## Persistence boundary

`layout::store` uses the existing `styk_doc` JSON codec without changing the dependency allow-list.
`to_value`/`from_value` handle an arrangement; `state_to_value`/`state_from_value` also retain its base
and monitor arrangements, including opaque workspace-level members. Undo and Focus snapshots are transient. `LayoutFile` carries stamped workspace
and named-layout entries, tombstones and unknown root fields. Unknown arrangement fields survive at
every record depth, including splits, tab groups, floats, allocations, panel descriptors, frame histories
and return placements. `UnknownRecords` retains only opaque members as existing `styk_doc::Value` values,
shared across snapshots; known fields remain owned by the typed model. Extensions follow stable record
identities through edits and reordering, with their nested values and member order intact. Deleting an
owning record deletes its extensions; ID allocation prevents a replacement inheriting those extensions.
Tools in the stage overlay and Layers joined to the timeline still own their panel extensions. The
optional `presentedPanels` descriptors carry these members through saving without duplicating placement.
A newer version is rejected before a write. Files are bounded to 256 KiB; named layouts to 32 and
names to 48 Unicode scalar values. Tombstones retain 30 days, with at most 16 after merging.

`SaveQueue` accepts caller-provided monotonic milliseconds, debounces 200 ms, allows one outstanding
write and coalesces newer edits. A failed write is retried unless a newer edit supersedes it.
Retry delays double from 200 ms to at most 10 seconds, resetting after success or an accepted newer edit.
An older failed completion never delays the newer edit. Deadlines saturate at the injected clock's maximum.
The caller reports completion and errors; this queue does not perform I/O.

`LayoutFile::save` calls `styk_services::storage::Storage::update`. Its callback reads and merges the
latest file while the storage worker holds an OS-backed interprocess lock through atomic replacement.
The trait contract is deliberate: separately calling read and replace would lose concurrent additions.
`save` and `Storage::update` take the service's `Cancel`. Staging and flushing precede `begin_commit`;
a refused boundary never replaces the file. Callback/staging failures, cancellation and dropping a
future before commit preserve existing bytes and clean up that transaction's staging. Cancellation
after commit cannot undo publication. The in-memory service tests these boundaries and wakeups.
`styk_platform::storage::LocalStorage` implements this contract on Windows. It uses
`%LOCALAPPDATA%\StykAnimate\settings`, separately from Electron's roaming profile (an import source).
An explicit directory constructor supports isolated hosts/tests; it does not consult the shell's
Electron-compatible `STYK_USER_DATA_DIR`. Construction and a missing `load` create no files.
Document names are bounded ASCII components, never paths, device names or alternate data streams.

One platform worker serializes requests, with one active and one queued request; overflow returns
an error for the caller to retry. Future polling and dropping never wait for the worker. Each update
uses its own `Cancel`; dropping its future cancels the operation, including an unpolled request.
The worker acquires an exclusive `LockFileEx` byte-range lock in `.storage.lock`, held through the
bounded read, merge callback, stage, flush and replacement. The OS releases it after a crash. The
lock file stays in place so every process locks the same identity; existence alone means nothing.
Contention retries every 25 ms on an event that cancellation wakes immediately. Acquisition uses
one event and cancellation registration, independent of its retry count. Merge callbacks run only
on the worker and should return promptly; file I/O uses K-doc's bounded chunks and pre-commit gate.

Reads share `styk-platform::files`' bounded reader, including the check after a file grows; writes
use `LocalFiles::replace` unchanged in ownership, staging names, flushing and atomic replacement.
Successful reads hold one handle and do not take the profile lock. A missing path open is rechecked
under the existing profile lock, after any in-flight replacement settles, before returning `None`.
The recheck never creates a directory or lock file; if no lock exists, no writer held it at that
observation. Waiting uses the same cancellable worker acquisition as updates, including when a
load future is dropped. This keeps transient absence from triggering first-launch defaults/imports.
The [replacement investigation](storage-replacement.md) records the Windows API and crash-test boundaries.
Only the transaction's own staging is removed. A committed replacement stays committed even if
the caller subsequently drops the future or cancels. Storage errors reach the caller unchanged.
Core tests retain the in-memory implementation and refusal over a newer file.

The app constructs the adapter beside `LocalFiles` and passes it as `Arc<dyn Storage>` to the core's
`LayoutStore`, retained by `TopBand`. This small handle delegates to the existing `LayoutFile` codec
and transactional save; it retains no layout copy. Docking views and startup/restoration orchestration
remain their host's work; construction alone neither imports nor rewrites a user's layouts.

Legacy import takes explicit main-client physical origin, logical stage geometry, scale and window
size. Compact Draw retains the old arrangement; Build hides the timeline, Build + timeline does not.
Shared sizes are copied into each arrangement: left/right widths apply only to horizontal column
allocations, bottom height to the timeline, and vertical stack weights survive. Floating geometry is
converted once, grouped records
become tabs/stacks, unknown records are retained, and saved layouts are returned to the caller.
The settings importer decides whether this is a first launch; no import path writes the old profile.

## Verification boundaries

The core suite includes 2,400 sequences of 48 operations plus a group-return/collapse prelude,
covering 20 operation/target cases, every direction, three workspaces and three host modes. Coverage
counters require at least 100 successes per case/direction/workspace/host. The suite also checks deterministic
solving, rollback, panel conservation, codec round trips, monitor restore, focus/history, migration,
preview equivalence and the source solver's exact default 1440 by 900 geometry. The ignored
`solver_measurement_40_groups` test is a release-only measurement with the design's unchanged
0.2 ms median and 0.5 ms p99 bounds; run it through the machine queue.

Fitting builds subtree minimums, stage flags and expansion counts once. A fold updates only its
ancestors. Counted 64-bit radix maxima avoid rescanning wide sibling lists; fixed-byte priority
ordering avoids comparison sorting. Folding work is linear in nodes under the codec's existing
128-level depth bound, now enforced by operations too. The existing ordered result maps retain
their indexing cost. A work-counter regression rejects the former whole-tree-per-fold scan.
`solver_measurement_shortfall` measures 40 groups and the largest wide-tree fixture fitting the
existing 256 KiB file bound, at 801 by 600; it introduces no group-count cap or new timing threshold.

This core does not certify the later UI scenarios: native float windows, live playback while dragging,
keyboard routing, screenshot parity, flyout animation and application restart. The platform adapter
is implemented by K-store, whose Windows tests race four real processes adding distinct entries,
decode every observed file, and kill a holder before the next update acquires the lock. They also
exercise staging/flush failures, refused replacement, cancellation at commit and during acquisition,
dropped futures, byte limits, missing loads, queue ordering and overflow. UI integration remains a
later chunk. The orchestrator accepted the legacy numeric solver matrix as
outside this chunk because docking is a new system; several window and screen setups are covered,
and the default 1440 by 900 rectangles have an exact source golden. Nested unknown fields in the
typed layout codec are retained and tested through `LayoutFile` and edits of their owning records.
Inventory rows spanning the later UI and platform obligations remain open.

## Views (K-dock views, part 1)

`styk_core::dock` and `styk_ui::dock` put the model on screen: `docs/native/docking-views.md`. The tab insertion index follows the pointer inside its header, and `SaveQueue::deadline` tells the runtime when to wake.
The authoritative design 3.2 governs fitting: compact/minimal fold left, top and bottom groups to strips and right groups to sheets.

## Implementer verification (2026-11-08)

All compilation and test commands used the machine queue and the checkout's seeded target.

- `cargo build --manifest-path engine/Cargo.toml -p styk-core --locked`: exit 0.
- Core library suite: `290 passed; 0 failed; 1 ignored` (the ignored test is the separate release measurement).
- Services library suite: `167 passed; 0 failed; 0 ignored`.
- Release measurement, 1,000 solves of the 40-group layout: `p50=39200 ns p99=65000 ns max=203100 ns`;
  `1 passed; 0 failed`. Unchanged design assertions: p50 <= 200,000 ns, p99 <= 500,000 ns.
  This is a queued release microbenchmark, not an exclusive machine or playback measurement.
- `cargo xtask check`: exit 0; dependency/source/interface guards passed; four configured screen references passed.
  Differing-pixel fractions were 0.001089031 / 0.001923333 / 0.000917379 / 0.002129630,
  below the existing 0.007 / 0.008 / 0.006 / 0.010 limits. The component sheet has no assigned reference.
- Clippy's existing warnings in other modules and dependencies remain. No dependency or guard threshold was changed.

The pinned toolchain lacks rustfmt; formatting used the already installed stable formatter. No tool was installed.
The implementation uses the existing JSON codec because serde is not allowed for this crate. The storage trait is new
because this checkout had document file services but no preference transaction service. Its interprocess transaction
contract is required before platform integration; the core never substitutes an unlocked read followed by a write.
- Final source confirmation: `cargo check` exited 0; Clippy exited 0 with no diagnostics in `layout/`.
  The focused suite reported `20 passed; 0 failed; 1 ignored; 270 filtered out` (12.55 s).

### Nested-field preservation follow-up (2026-11-08)

The four new split/group/float/nested-node regressions first reported `0 passed; 4 failed`, each with
`unknown field was discarded`. After the fix, all seven new tests pass, including every nested helper
record, array reordering and replacement-owner isolation. Assertions compare the opaque values' JSON
bytes after `LayoutFile` encoding/decoding and typed edits, without changing known-field expectations.

- Queued `cargo check --all-targets` and Clippy: exit 0, no diagnostics in `layout/`.
- Queued core build: exit 0. Full core tests: `405 passed; 0 failed; 7 ignored` across 22 targets;
  the library result is `297 passed; 0 failed; 1 ignored`. Existing measurement and external-oracle tests stay ignored.
- Queued `cargo xtask check`: exit 0; all guards pass. The four screenshot fractions and limits are
  unchanged from the run above. The component sheet still has no reference.
- Logs: `artifacts/docking-unknown-fields/`. No new dependency, frozen fixture or threshold change.


### Review fixes and verification (2026-11-08)

The review regressions drive real operations, solve and typed/LayoutFile persistence. The first run
reported `0 passed; 7 failed` for return order/activation, workspace and presented-panel extensions,
float collapse, host-local DPI geometry, migration widths and persistent hysteresis. A second
fail-first run reproduced ignored cancellation and `2,114,595` subtree visits for 1,030 nodes.
The final suite passes all ten focused regressions. Services tests independently exercise callback,
staging, cancellation and dropped-future failures, cleanup, wakeups and the irrevocable commit boundary.

- Queued check and Clippy: exit 0, no diagnostics in the changed layout/storage files. Existing
  unrelated warnings remain. Queued build of both crates: exit 0.
- Full core suite: `415 passed; 0 failed; 8 ignored` across 22 targets. Library: `307 passed; 0 failed; 2 ignored`
  in 5.30 s. Full services suite: `170 passed; 0 failed; 0 ignored` (169 library tests plus one integration test).
- Generator success counts, in its documented match-arm order:
  `[4603, 4780, 5302, 5081, 5299, 4307, 5244, 5760, 5760, 5640, 4496, 5691, 5693, 5760, 5760, 5760, 5760, 5760, 5760, 3862]`.
  Directions: `[2655, 2557, 2564, 2604]`; workspaces: `[34659, 34682, 36737]`; hosts: `[35412, 35410, 35256]`.
- `cargo xtask check`: exit 0, including all four configured screenshot references at unchanged limits.
  The component sheet still has no reference.
- Queued release measurements, 1,000 solves each, same unchanged 40-group budget:

| Layout | Window | Saved file | Folded groups | Median | p99 | Maximum |
| --- | --- | --- | --- | --- | --- | --- |
| 40 groups, expanded | 4000 x 2160 | n/a | 0 | 36,800 ns | 69,500 ns | 183,800 ns |
| 40 groups, shortfall | 801 x 600 | 5,117 bytes | 39 | 68,300 ns | 89,300 ns | 118,900 ns |
| 2,215 groups, shortfall | 801 x 600 | 262,054 bytes | 2,214 | 4,277,100 ns | 4,887,500 ns | 5,645,000 ns |

There is no fixed group-count cap. The large measurement binary-searches the largest wide-tree fixture
in its family that fits the existing file bound, including the LayoutFile wrapper; no timing budget
was invented for it. The initial measurement omitted wrapper bytes and correctly hit `Limit` at the
large fixture. Only that ignored measurement was rerun after correcting its sizing helper; the
production source, passing full suites and guards were unchanged. The corrected measurement reported
`1 passed; 0 failed`. These are queued microbenchmarks, not exclusive-machine or playback measurements.
Logs are in `artifacts/docking-review/`.

## Core review handoff for the views step (2026-11-08)

- `layout::DividerDrag` owns a live divider candidate; dropping cancels it, `release` delegates to
  `LayoutState::commit` for the one bounded history and dirty policy. A later operation cancels an old
  gesture first. `Operation::ResetDivider` is the single reset policy: each pixel allocation uses its
  subtree's panel preferences along that axis, flexible allocations return to weight one. The timeline
  reset is 264 px (its preference); a newly created tall-window layout still starts at 280 px.
- `layout::{default_layout, default_timeline_height, set_timeline}` owns initial/legacy sizes; `dock`
  re-exports these for existing callers. No view or dock gesture rewrites allocations after an operation.
- `Dock::open_rect()` returns the final host-local flyout/sheet rectangle from `solve`; use its x/y/w/h
  verbatim (subtract only the view's origin). Left/right/top/bottom anchor at the corresponding strip's
  inside edge with an 8 px gap, or at the content edge for a sheet, and clamp to available content.
  `Solution::sheets` also contains unopened sheet placeholders; only `Dock::open_rect()` means open.
- `Dock::regions()` supplies `FocusRegion { area, target }` in main-tree reading order: band, tools,
  docked groups, stage headers/bodies, strips. `FocusState::set_regions` changes F6 order and landing
  targets only; modal scopes and field input roles remain intact. `Dock::focus_area` maps measured
  root-scope targets to these regions; the message snapshot adapter applies it only when a dock is mounted. Stage's body is
  `ids::body(group)` even with other tabs; mount it there, and mount `ids::stage_header(group)`.
  Floating window focus remains part 2.
- Tab x/middle-click send `Command::Dock(Event::Close(panel))`; `Operation::Close` already atomically
  refuses the last stage. `Event::Reopen` reveals/activates the restored panel, opening its folded group.
- `CommandId::LayoutUndo` (`layout-undo`, Ctrl+Alt+Z; Cmd+Alt+Z in the Command key map) and
  `LayoutArrange` (Ctrl+Alt+M) route through `Core::dispatch` to the dock. Exact modifier matching,
  IME/field gates and all binding metadata use `Shortcuts`; tests check every existing scope for
  collisions. Registered panel toggles/hides and `TimelineSheet` route to the same owner, including
  commands emitted by the band's Properties button. F6/Ctrl+F6 route to the focus owner.
- `dock::Effect::Message` and `DragView::label` carry `Msg`/`Option<Msg>`. Format with `Presentation`;
  existing catalogue keys name Stage/Layers/Tools and existing drop actions. Native-only English
  additions live in `styk-core/messages/en.json`, merged by build.rs with normal English fallback;
  generated source-app catalogue mirrors and their exact comparison remain unchanged.
- The host injects `WallClock::unix_millis()` through `Dock::set_wall_time` and its process-session
  identity through `set_writer` before loading/editing. The minimal service/platform extension was
  necessary because the previous clock exposed only elapsed time. `SystemWallClock` combines PID
  and session-start nanoseconds for the writer. A local high-water stamp handles equal milliseconds
  and rollback and observes loaded stamps. SaveQueue/gestures keep monotonic milliseconds; the
  store receives Unix time for tombstone retention. Late loads reconcile all touched workspace
  entries into the loaded backing file before any later save coalesces them.

Views still must remove their popup position/size arithmetic and consume `open_rect`, mount Stage's
body/header targets when tabbed, wire tab x/middle-click, and validate F6 with several rearranged
groups on mounted widgets. The only drawing-file adaptation in this core step formats the new `Msg`
drop label. Existing screenshot references/thresholds and frozen fixtures were not changed.

Verification for this core step (all Cargo commands through the machine queue):
- Before fixes, the new core regressions produced `30 passed; 10 failed` (the filter also ran existing
  review tests). Closing the last stage already passed; that existing operation was kept.
- Full core/UI/app tests: 735 passed, zero failures; app build and `cargo xtask check`: exit 0. The guard
  compared 48 unchanged screenshot references and app/preview parity; normal and folded dock captures
  were inspected. These do not certify the pending popup/close/focus view work.
- Self-check found standalone inspectors being assigned dock regions; a mounted snapshot regression
  failed before restricting the adapter to mounted docks. Final app/UI tests: 84 passed, zero failures
  (including 13 mounted dock tests); final app build: exit 0.
- The Properties test now clicks its mounted button. Removing its TopBand command dispatch made it fail;
  removing `dock_shortcut_at` routing made the mounted keyboard-move test fail. Both passed after restore.
- Unrestricted Clippy stopped at ten existing `clippy::eq_op` errors in unchanged `styk-math` (exit 101).
  Clippy on all five changed crates with `--no-deps --all-targets`: exit 0, warnings retained.
  Logs: `artifacts/a3-*.log`. No frozen fixtures, screenshot masks, limits or source-app catalogues changed.
