# Docking core

`styk_core::layout` owns arrangements. It has no toolkit, thread, clock or file access.
This is the core implementation for K-dock; UI integration and platform storage remain separate.
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
The caller reports completion and errors; this queue does not perform I/O.

`LayoutFile::save` calls `styk_services::storage::Storage::update`. Its callback reads and merges the
latest file while the storage worker holds an OS-backed interprocess lock through atomic replacement.
The trait contract is deliberate: separately calling read and replace would lose concurrent additions.
`save` and `Storage::update` take the service's `Cancel`. Staging and flushing precede `begin_commit`;
a refused boundary never replaces the file. Callback/staging failures, cancellation and dropping a
future before commit preserve existing bytes and clean up that transaction's staging. Cancellation
after commit cannot undo publication. The in-memory service tests these boundaries and wakeups.
The platform must implement this contract before production persistence is connected. Core tests use
an in-memory transactional implementation and check refusal over a newer file.

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
and a real cross-process storage race test belong to a later platform chunk; its implementation must
fulfil the transaction and cancellation contract above. The orchestrator accepted the legacy numeric solver matrix as
outside this chunk because docking is a new system; several window and screen setups are covered,
and the default 1440 by 900 rectangles have an exact source golden. Nested unknown fields in the
typed layout codec are retained and tested through `LayoutFile` and edits of their owning records.
Inventory rows spanning the later UI and platform obligations remain open.

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
