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
  of a floating host keeps the original return anchor. A missing anchor falls back to the panel home.
- `LayoutState` keeps at most 20 layout undo steps, independently of document history. Focus uses a
  separate snapshot. Preset changes leave Focus; ordinary changes during Focus do not destroy its
  snapshot. `switch_setup` preserves other arrangements and clears transient undo history.
- `solve` returns rectangles, headers, divider ranges, strips/sheets, visibility and stage viewports.
  Supply the previous `FitState` for 16-pixel unfolding hysteresis. Never persist a `Solution`.
  The main root may be empty when its groups have moved to floats.
- `resize_divider` calculates neighbour allocations from solved geometry, preserving the combined
  weight of two flexible neighbours. `DragSession` holds an immutable origin and preview until release;
  cancellation does not change the live layout. `preview` uses the same transaction as release.
- `Env::with_monitors` adapts S6's monitor records and setup identity. Physical float frames are distinct
  from logical dock geometry. `place_float` records explicit movement and its relative monitor frame;
  fitting a float never changes its history. The latest eight explicit frames are retained.

## Persistence boundary

`layout::store` uses the existing `styk_doc` JSON codec without changing the dependency allow-list.
`to_value`/`from_value` handle an arrangement; `state_to_value`/`state_from_value` also retain its base
and monitor arrangements. Undo and Focus snapshots are transient. `LayoutFile` carries stamped workspace
and named-layout entries, tombstones and unknown root fields. Unknown arrangement fields survive at
every record depth, including splits, tab groups, floats, allocations, panel descriptors, frame histories
and return placements. `UnknownRecords` retains only opaque members as existing `styk_doc::Value` values,
shared across snapshots; known fields remain owned by the typed model. Extensions follow stable record
identities through edits and reordering, with their nested values and member order intact. Deleting an
owning record deletes its extensions; ID allocation prevents a replacement inheriting those extensions.
A newer version is rejected before a write. Files are bounded to 256 KiB; named layouts to 32 and
names to 48 Unicode scalar values. Tombstones retain 30 days, with at most 16 after merging.

`SaveQueue` accepts caller-provided monotonic milliseconds, debounces 200 ms, allows one outstanding
write and coalesces newer edits. A failed write is retried unless a newer edit supersedes it.
The caller reports completion and errors; this queue does not perform I/O.

`LayoutFile::save` calls `styk_services::storage::Storage::update`. Its callback reads and merges the
latest file while the storage worker holds an OS-backed interprocess lock through atomic replacement.
The trait contract is deliberate: separately calling read and replace would lose concurrent additions.
The platform must implement this contract before production persistence is connected. Core tests use
an in-memory transactional implementation and check refusal over a newer file.

Legacy import takes explicit main-client physical origin, logical stage geometry, scale and window
size. Compact Draw retains the old arrangement; Build hides the timeline, Build + timeline does not.
Shared sizes are copied into each arrangement, floating geometry is converted once, grouped records
become tabs/stacks, unknown records are retained, and saved layouts are returned to the caller.
The settings importer decides whether this is a first launch; no import path writes the old profile.

## Verification boundaries

The core suite includes operation sequences (10,000 seeds/sequences of 50 operations), deterministic
solving, rollback, panel conservation, codec round trips, monitor restore, focus/history, migration,
preview equivalence and the source solver's exact default 1440 by 900 geometry. The ignored
`solver_measurement_40_groups` test is a release-only measurement with the design's unchanged
0.2 ms median and 0.5 ms p99 bounds; run it through the machine queue.

This core does not certify the later UI scenarios: native float windows, live playback while dragging,
keyboard routing, screenshot parity, flyout animation and application restart. The platform adapter
and a real cross-process storage race test belong to a later platform chunk; the storage trait's
transaction contract is unchanged. The orchestrator accepted the legacy numeric solver matrix as
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
