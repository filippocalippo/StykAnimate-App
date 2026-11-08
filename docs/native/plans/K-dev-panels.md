# K-dev panels: first-panel core plan

Step 1 only, based on `native-app` at `0ff3d0dc`. Step 2 follows the plan review;
Sonnet supplies views in step 3. Contracts: [patterns](../patterns.md),
[developer engine](../devtools-engine.md), [dock](../docking-views.md),
[memory probe](../memory-probe.md), and developer design sections 3.1–3.6.1.

## Owners and integration

- `styk-devtools::panels` owns the toolkit-free `Host`, panel lifecycle, filters,
  drafts, enabled states and immutable view models. Its `overlay`, `profiler`,
  `logs` and `parameters` modules own only their presentation state. The app holds
  one host per window, behind `devtools`; the later `ui` modules only draw and
  send typed events. No developer state goes in production `styk-core` modules.
- `styk-devtools-engine` owns sampling/aggregation, the bounded log sink and the
  typed parameter registry. A shared capture controller factors the existing
  `channel::ReadHost` capture state so panel and channel use the same start/stop
  owner, `drain::Drain`, `capture::Capture`, statistics and Perfetto exporter.
  Capture buffers never enter view models. Existing inspection APIs remain the
  only route to engine data; MP's `MemoryDiagnostics` remains the memory owner.
- `Core::dock`/`layout` retain placement, open panel membership, layout history,
  persistence and focus regions. Add an `inspect`-only descriptor registration
  seam to the existing static `SPECS` lookup, used by validation, restoration and
  solving alike; supply `Developer` descriptors before loading layouts. There is
  no parallel placement map. Reconcile host subscriptions from accepted dock
  state, including close, undo, restore and workspace changes. Release ignores
  unknown developer IDs. Floating windows remain K-dock part 2's responsibility.

## Commands, messages and lifecycle

Extend K-cmd's existing registry with feature-gated identities/metadata for panel
open/close, overlay toggle (F11), capture start/stop/export, and parameter
set/reset/profile save/load. `Shortcuts` resolves keys; `Core::dispatch` emits a
guarded extension effect which the real app handler routes to `Host::update`.
Typed payload events (filters, parameter values, dialog answers) enter that same
handler. Core carries only extension routing, never a developer-crate dependency
or a second registry. Models carry `i18n::Msg`/labels; developer catalogue entries
are gated too. Focus uses the existing owner and dock tree order.

`Host::update(event, now)` returns effects and the next injected-clock deadline.
The app executes service effects and connects their real wake/completion path;
generation and operation IDs reject old replies after close/reopen. Opening is
idempotent; closing cancels sampling and capture work, invalidates pending replies
and hands large buffers to worker reclamation. Stop/export completions remain
observable until consumed; a full mailbox cannot silently lose them. Admission
failure rolls back pending state and returns a visible, retryable error. Close,
owner drop, worker error and accepted app quit share teardown; no joins or file
writes on the interface thread, and no change to document save-before-close rules.
Closing discards unsaved diagnostic captures; failed exports retain the capture
for retry while the panel is open. Nothing samples for closed tools; only the
existing trace infrastructure and the design's bounded log sink stay enabled.

## Data flow and bounds

Read APIs/trace records → developer worker → immutable bounded models → host →
views. The interface only submits bounded work and takes ready replies with
nonblocking reads. Sampling runs at most 4 Hz, memory requests at most 2 Hz with
one MP request in flight; missed deadlines coalesce, never catch up in a burst.
MP's slow OS walk remains asynchronous and its private/DXGI figures retain their
timestamps, overlap caveats and truncation status. Missing timing producers show
unavailable, never zero or an estimate from timer wake lateness.

Retain 240 frame points for the sparkline and bounded 10-second statistics,
computed on workers from existing frame/interface/builder/painter trace sites.
Inventory the actual sites during step 2 and add only missing feature-gated
instrumentation at their owners. Keep the existing 24 MiB trace admission,
100 ms drain, 256 MiB per-capture and 512 MiB process capture limits, including
their drop accounting; preserve the implemented reject-new-on-full policy.
Reserve sampling scratch before work. Proposed panel transport caps: one
coalesced 64 KiB snapshot and one reserved 8 KiB terminal reply per host, 64 KiB
request mailbox, at most one snapshot and one terminal adoption per update.
Strings are capped at 2 KiB and pages at 50 rows with explicit truncation/cursors.
Bytes include backing allocations; oversized input is refused before cloning.
Stop/cancel has a separate wakeable control slot; replaced samples count as drops.

Logs retain at most 8,192 records **and** 2 MiB, evict oldest with visible counts;
oversized messages are bounded while formatting. Worker-side level/module/text
filtering returns pages, never scans the ring in `view`/`update`. Capture summary
uses existing statistics with bounded per-site samples and reports omissions;
Perfetto export streams on a worker through the existing exporter. File dialogs
and writes use service effects, preserving an existing destination on failure.

## Parameters, persistence and the view contract

`styk-devtools-engine::params` owns explicit owner registration (no new inventory
dependency), descriptors for finite f64/i64/bool/enum values, ranges, defaults,
units, restart requirements and acknowledged owner setters. Set/reset share
validation (numeric range clamping, invalid type/nonfinite/unknown enum refusal);
failed application preserves the old value. Restart values are pending separately
from effective values. Revert means the registered default. Start with the tools'
capture-cap parameter; do not expose unimplemented engine knobs as working controls.
Registry/profile admission is 256 entries/64 KiB; captures record acknowledged
changes and initial values. No document edits, history entries or implicit saves.

Dock layout is saved only by `LayoutStore`. Named `{name, params, flags}` profiles
live in `<profile>/devtools/params/`; explicit Save/Load and startup overrides use
the same registry. Unsupported nonempty flags fail visibly. Validate a whole load
before applying; report setter failures without claiming full success. Atomic
storage runs on workers, operation IDs protect late replies, and a late load may
not overwrite subsequent edits. Filters, samples and captures are transient;
closing a panel does not revert applied parameters. No new product settings file.

Views read `PanelDescriptor` (developer mark, title/icon), dock-solved bounds,
`OverlayModel`, `ProfilerModel`, `LogsModel`, `ParametersModel`, statuses and
command availability. They never read services, clocks, trace rings or registry
mutators. Step 2 wires every event/effect/wake in the production handler; actual
widgets, badges, menus and mounted-widget checks belong to step 3.

## Decisions and verification

- Current sources have no structured log stream/parameter registry or runtime
  panel registration. Add the minimal missing sink/registry/extension seams here;
  attach logging to the toolkit's existing logging facade in the developer host,
  without changing product error records or inventing trace events as log lines.
- The brief's first-panel subset wins over the larger design: no flame/timeline
  explorer, GPU queries, watchdog, settings page or hot reload in this chunk.
  Existing capture format/overflow rules win over the older design's alternative.
- Step 2 checks bounds, injected-time sampling, closed-tool inactivity, contention,
  parameter validation/revert/load ordering, capture/export failures and teardown
  through real handler/wake wiring; remove wiring to prove tests fail. Run scoped
  tests/clippy, relevant xtask guards and `cargo xtask check` through the queue.
  Build shipping and developer artifacts separately; run the shipping graph guard
  and `check-release` on each fresh shipping executable with its matching map.
  Frozen fixtures and thresholds stay unchanged. Step 1 needs only diff review.
