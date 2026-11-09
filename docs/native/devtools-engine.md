# Developer tools engine

The headless `styk-devtools-engine` crate owns worker dispatch, capture and profiling.
`styk-devtools` remains the guarded interface crate; `styk-app/devtools` adds its existing
pen lab and re-exported worker entry points. `styk-cli/app-tools` depends directly on the headless
engine and never pulls in the interface crate or its toolkit. Build shipping and developer binaries
in separate Cargo invocations: feature unification must not enable tracing in a shipping app.
The `quick` profile is for iteration; only release profiles are comparable measurements.

## Instrumentation and byte admission

`styk-trace/enabled` records static sites into per-thread atomic rings. Disabled macros evaluate
neither names nor arguments and have no dependency on services. Hosts install an injected
`styk_services::clock::Clock` before starting workers; scenario workers scope their measurement
clock. Spans retain the clock on which they started. A missing clock produces a visible counter,
not an implicit wall-clock fallback. No `Instant` is used by the trace crate.

Admission reserves the whole ring before allocation, including its 64 open-span slots and
bounded thread name, under a process-wide 24 MiB budget. Registry contention refuses a cold
registration without blocking. Ring overwrite, admission refusal, archive eviction and truncated
snapshots increment the drop counter. The archive keeps 4096 records, with room reserved for one
4096-record transfer. A snapshot has a 24 MiB byte allowance including retained thread names.
`threads`, `open_spans`, `ring_snapshot`, `counters` and `gauges` expose bounded worker reads.

Captures reserve their entire capacity before recording: at most 256 MiB each and 512 MiB of capture storage across
live captures, plus 128 KiB of validation/read scratch per capture. `styktrace/1\n` is followed by little-endian u32 lengths and JSON chunks of at most
64 KiB. Header and chunk prefixes count against the cap. Full captures reject new events and
count them; they preserve earlier events. Unknown versions and oversized lengths fail. An
incomplete final chunk is recoverable; invalid complete JSON is an error. Perfetto output streams
these events in a `traceEvents` array, without copying a complete second capture.

`drain::Drain` starts through `Spawner`, wakes every 100 ms or immediately on stop/drop, and
never joins its worker from a caller. At most two drains reserve their snapshot, archive scratch,
encoding scratch and 1 MiB cursor allowance before starting. Thread/sequence cursors deduplicate
live-ring/archive overlap and repeated polls. A reserved footer records capture drops, ring drops
and missing clock reads. `capture::accounting`, `drain::accounting` and protocol `metrics.get`
report reservations/refusals. Taking the completed capture uses `try_lock`.

## Owner inspection

Inspection is opt-in through each owner's `inspect` feature. The generated
`devtools-read-apis.toml` inventories its public read functions; `xtask check-read-apis` checks
that tools import owners through those modules (the pre-existing pen lab is explicitly exempt).

- Edit sessions publish an O(1) immutable canonical-record ticket and revision. Tree/node traversal
  and retained-byte counting run on a tool worker. Pages hold at most 50 rows and 128-byte previews;
  blobs never expand into base64. History pages copy labels and revision IDs, not undo payloads.
- Core exposes its own document state, focus state and document/history ticket types; engine
  records stay behind a private adapter. Inspection does not
  alter session history or saved records. If K-doc has handed the session to its worker, new
  document/history/state reads return `DocumentsError::Busy` immediately; callers retain their last
  complete state. Existing revision-pinned tickets remain readable. A fixed 4096-byte service slot publishes small owner
  snapshots using `try_lock`; failed publication preserves the last complete snapshot.
- Engine snapshots queue depths, retirement, current revision and frame/picture counters using
  `try_lock`; contention returns unavailable immediately.
- Evaluation uses the normal evaluator on a worker; draw-list summaries are paged.
- Renderer reads its existing memory and pass counters without device polling or readback.

The native shell's optional `--control` reader currently publishes shell state only. Document
contents require an explicitly supplied owner ticket; they are never discovered by the transport.
The shell has no editor host adapter yet. Missing command/job/history adapters return structured
errors, not fabricated empty results. Docking/widget trees, live theme/icon reload, renderer debug
views/shader reload, and command/parameter/experiment registries belong to their forthcoming owners.
GPU timestamp collection and Tracy forwarding are explicitly left for **K-stage**. No listener or
GPU wait is introduced here.

## Local control channel

The Windows implementation is entirely in `styk-platform`. `stykanimate --control` (developer
build only) serves `\\.\pipe\stykanimate-dev-<pid>`. `styk attach <pid> '<JSON request>'` addresses
that explicit process; there is no automatic file/instance discovery. The protected DACL contains
only the current user, rejects remote clients, and uses first-instance pipe creation. Client opens
use `SECURITY_IDENTIFICATION`, then verify the server PID belongs to the current user, using the
same identity and overlapped-I/O helpers as S6's single-instance transport.

Requests are one JSON line, at most 16 KiB; answers are at most 24 KiB plus a newline. A connection
handles one request/response and a receipt acknowledgement before disconnect. Pipelining is
rejected. The inbox admits bytes (64 KiB including the reserved answer); connections reserve
128 KiB each under a 4 MiB process budget. Completed unread replies retain their reservation until the caller releases the operation. Busy/timeout errors are explicit. Cancellation signals
wake accept, partial read, answer wait, write and acknowledgement waits. Caller drop never joins.
Connection errors carry a null ID because no request has been decoded at that layer.

`hello` negotiates version 1. The operation registry and schemas are generated together. Short
answers are at most 4 KiB, full answers at most 24 KiB, strings at most 2 KiB, and pages at most
50 rows. Truncation carries a marker and a continuation offset; document paging can pin revision.
Errors carry `what`, `where`, `input`, `cause`, `hint`. Host adapters must construct bounded
results before calling the envelope writer; the writer is not an allocator for arbitrary owner data.
`devtools-protocol.json` and `devtools-profile.json` are checked by `xtask check-schema`.

## Scenarios, budgets and profiles

The one application language and parser belong to `styk_core::automation`. Its steps include
`open <file>`, `frame <tick>`, `export`, `advance <nanoseconds>` and budget declarations. The
developer engine consumes that AST; measurement and budget judging remain in the runner. There
is no separate tooling parser. The headless runner refuses unsupported UI steps with their source
line before starting work.

Repository scripts use the `styk-auto/1` header. Core bounds scripts at 64 KiB; the headless runner
also admits at most 1024 actions and 64 budgets, checking actual AST and string capacities before
cloning or spawning. Only `advance` changes logical time. Measurement uses a separate real `Clock`.
One scenario task starts through `Spawner`; interface callers poll the single completion slot.
Only the offline CLI waits. Repository scenarios cover open, a headless frame and CPU export.

`styk profile <input> open|frame|export|<script.styk-auto> --out <new-dir> [--runs 3..32]`
uses the core Documents seam and the normal evaluator/exporter. Export runs through `styk-export`,
pins the document revision, alternates bounded picture uploads with engine progress until decoding
finishes, and writes the first run's PNG; subsequent runs must have identical
pixel hashes. The CLI writes a profile, a bounded capture, Perfetto JSON and a short summary.
It hashes the input rather than exposing its path or contents. Existing output directories fail.
`styk profile --scenario <script.styk-auto>` derives the input from its first `open`; `xtask scenario`
uses this entry point. Relative paths resolve against the script's directory. Every `open` in a
profile must identify that same hashed input, including when an explicit input was supplied.
The export regression first exports twice through the existing CLI path to establish a byte-stable
baseline, then compares the scenario PNG bytes with that baseline.

Budget syntax: `budget <metric> <operator> <value><unit> [floor:<reason>]`, for example
`budget export.ms <= 50ms`. Operators are `< <= == >= >`; time units convert to milliseconds,
size units to bytes, and `%` to percentage points. Built-in metrics are `scenario.ms`, `open.ms`,
`frame.ms`, `export.ms`. Missing/nonfinite metrics are errors. Budgets judge the median of runs,
retain their source line, and fail the command on a miss. No production threshold is invented by
the toolkit. Logical determinism does not make wall-clock timing deterministic.

`compare-profile` preserves the old `compare` parity command. It checks input/scenario hashes,
machine, clock and release profile compatibility, then uses nearest-rank quantiles, the accepted
3%/0.05 ms/MAD noise floor, exact tied-rank permutations for 5..32 samples (range comparison for
3..4), and budget misses. Exit statuses are 0 success, 1 regression/budget miss, 2 tool error,
3 incomparable. Quick/debug profiles are refused. Shared-machine fixture runs are diagnostic
smokes, not performance acceptance evidence.

## Task runner and verification boundary

Developer tasks live in separate `xtask` modules so guards can evolve independently. Heavy
commands use `STYK_QUEUE_CMD` unless already inside the queue; otherwise a create-new advisory
lock prevents overlap. Subprocess stdout/stderr are drained concurrently into bounded 64 KiB
tails. `test --changed` selects changed crates and reverse dependencies from the merge base.
`build`, `test`, `scenario`, `profile`, `compare`, `screenshot`, `doctor`, `check-trace`,
`check-schema`, `read-apis`, `check-read-apis`, `flags`, `design-export`, `renderdoc` are routed.
Screenshots use the existing catalogue and exact PNG comparison, with no tuned threshold.

Branch/flag/parameter experiments need the corresponding registries and isolated measured builds;
`compare` currently accepts completed profile files. Window scenarios/theme overrides need their
catalogue/stage adapters. `flags` reports an empty registry until flags exist. `serve-web` refuses
under N8; `--tracy` reports K-stage. Doctor reports tools, disk and adapter timestamp support, but
does not enumerate or clean other agents' targets/processes. These are explicit capability errors,
not successful placeholder runs. Default diagnostics are bounded; all xtask commands accept --json for a bounded result envelope.
CLI profile/compare produce structured JSON directly. The measuring `xtask profile` and
`xtask scenario` tasks explicitly run the CLI with `--release`; non-measuring tools retain the dev build.

Shipping isolation has two required checks. `check-shipping-features` reads Cargo's resolved
normal/build feature graph for each separate shipping package, default features, and the actual
rustc host target. It rejects developer crates, production-crate `devtools` features and
`styk-trace/enabled`, including transitive activation; `inspect` remains permitted.
These selectors match the separate `cargo rustc --locked -p styk-app --bin stykanimate --release`
and `-p styk-cli --bin styk --release` builds; debug info remains off through the machine environment.

Pass `-- -C link-arg=/MAP:<absolute.map>` to each shipping link, then run
`cargo xtask check-release <shipping.exe> <matching.map>`. The guard parses linked public/static
symbols, including mangled Rust identifiers, and rejects trace/devtools code. It validates the map's
module, timestamp and image base against the PE, requires a nonempty symbol table and bounds lines
to 16 KiB. Missing/mismatched maps fail. A bounded executable scan additionally rejects the developer
catalogue keys, including inlined data without a surviving developer symbol; it supplements the
symbol check. Release negative controls link enabled trace code, the actual Core developer route,
and data from the actual developer catalogue, and require rejection for those leaks.
Disabled-macro tests separately cover argument non-evaluation.

## Process memory attribution

The explicit `MemoryDiagnostics` service and developer engine's one-shot
`memory::request_capture` collect bounded address-space and DXGI evidence on a
platform worker. `styk memory-capture <new.styktrace>` writes a standalone capture;
video `--memory-report` samples the same implementation. There is no automatic
collector or control-channel operation. See [memory-probe.md](memory-probe.md)
for bounds, overlapping counters and ownership limitations.

## First panel core

K-dev panels step 2 adds the process runtime, bounded log/parameter owners and
production command/wake wiring. See [the panel core handoff](devtools-panels.md)
for models, lifecycle, startup precedence, release proof and the step-3 view contract.
The default tools crate remains headless; visible panels still await step 3.
