# First developer panels: core handoff

This is the implemented core for K-dev panels step 2. The visible panels, badge,
menus and overlay drawing belong to step 3. The only mounted element added here
is the existing deadline wake adapter; it paints nothing and takes no input.

## Ownership and the view API

`styk-devtools::panels::Host` owns `OverlayModel`, `ProfilerModel`, `LogsModel`,
`ParametersModel`, `error`, argument request `input`, and `availability()`.
`DESCRIPTORS` supplies each panel's title key, icon and developer mark. Core's
gated catalogue resolves these keys. Views borrow these values and send
`styk_ui::Message::Command(Command::Developer(event))`; they never call Host or
Runtime. Registered command identities also reach this route through `Run`.

`Event` includes panel open/close, overlay toggle, capture Start/Stop/Export,
typed Set/Reset, SaveProfile/LoadProfile, ParametersPage and log Filter. Commands
needing arguments expose `Host.input`; a subsequent typed event supplies the
value, profile name or opaque export target. `Input(None)` cancels the argument
request through Core. Accepted submissions clear it in Host; admission refusals retain it
for correction, and an unrelated channel setter does not dismiss it.
Argument fields/file chooser views
come in step 3; output I/O already belongs to the worker's `StreamFiles` service.
`Poll` and injected-millisecond `Tick` are adapter events, not view timers.

The path is **app handler → Core::dispatch → Effect::Developer → app handler →
Host**. The handler also reconciles accepted dock membership after workspace
switches, undo and close. Dock owns all three panels' placement and persistence;
the gated fixed descriptor slice extends its existing spec lookup. There is no
second layout registry or panel placement state.

The performance overlay is **outside the dock and input-transparent**. Host owns
requested visibility. `TopBand::reconcile_developer` supplies the dock's solved
stage rectangle, translated by the top-band height into window coordinates.
`OverlayModel.visible` and `.bounds` are the complete placement decision; no
stage means hidden. A view must use those bounds and must not register an overlay
panel, hit region or independent timer. F11 uses the normal shortcut adapter.

## Worker, bounds and teardown

One process Runtime owns the registry, log ring and shared capture controller.
Each window Host has a capture lease. The explicit control channel uses the same
Runtime, so another client cannot start over, stop, export or discard its capture,
including through the protocol. The lease survives Stop and failed Export until
its owner explicitly replaces or releases the capture. Closing
the profiler drops only its own capture action; unrelated parameter actions stay
intact. Closing all panels stops sampling, without reverting setters. Dropping a
window detaches its command bridge and wakes capture reclamation. Runtime ends
on process teardown; no UI path joins the worker or frees a capture buffer.

- Eight ordinary admitted requests, each at most 8 KiB including payload allocations;
  a separate permit and queue slot reserve Stop, and a tenth slot coalesces lifecycle
  wakes. Admission remains held by pending
  callbacks and unread replies. Full queues report a retryable error.
- A Host holds one ordinary action reply, one Stop reply, one sample reply and one MP reply; each update
  adopts at most one of each. Response payloads fit 64 KiB: log rows use 48 KiB,
  parameter pages 7 KiB, MP keeps at most 16 adapter/segment rows. Strings use the
  existing 2 KiB truncation helper. Control replies retain their existing budget.
- Sampling deadlines are injected: at most 4 Hz, MP at most 2 Hz. Missed periods
  coalesce. An open Logs panel requests only log pages when the overlay is closed.
  Each timing sample reserves the trace snapshot ceiling plus 512 KiB scratch
  before copying; at most two reductions are admitted process-wide. Each of four
  timing streams retains at most 4,096 records over 10 seconds; sparkline 240.
  Present timestamps retain the newest records even when thread snapshots arrive
  unordered or the stream saturates.
- `stage.present` intervals describe stage submission cadence, not scanout or GPU
  time. `ui.dispatch`, `frame.prepare`, `stage.paint` measure their named owners.
  A UI span of at least 50 ms is counted as a stall (display convention, not a
  benchmark threshold). Missing producers remain `None`. Truncation is explicit.
- Logs use the existing `log` facade via an opt-in iced_winit adapter, 8,192
  entries/2 MiB including ring storage, oldest eviction, nonblocking producers,
  UTF-8-safe formatting capped at 2 KiB; the formatter returns an error at the cap
  to stop further writes while retaining the truncated prefix. Filtering is worker-only; pages contain
  at most 50 rows, total matching rows and cumulative drops. Offset plus returned
  row count is the next cursor; eviction counts warn that this is a live window.
- Capture uses existing Drain/Capture admission, 100 ms drain and Perfetto export.
  Initial parameters and acknowledged changes are bounded metadata notes; overflow
  appears in `capture.accounting.metadata_dropped`. Summary describes all captured
  duration spans, at most 100,000 values, with `truncated` if further values exist.
  It is not a per-site flame graph. Stop completion retries at injected 50 ms
  deadlines. Streaming replacement shares LocalFiles staging/flush/commit logic;
  failure preserves both the old destination and the stopped capture for retry.

Stop remains enabled during ordinary work. Its separate pending intent survives
admission refusal and retries at the injected deadline, while ordinary completion
still resumes through its worker wake. Closing the profiler cancels its Stop intent.
Parameters retains a generation-stamped desired page across busy/admission refusal;
ordinary completion or an admission retry admits it, and only the current reply is
adopted. Closing cancels that refresh; reopening requests a fresh first page.

## Parameters and persistence

`params::Registry` owns finite float/integer, bool and enum descriptors, defaults,
units, numeric ranges and acknowledged setters. Numeric values clamp; bad types,
unknown names/options and nonfinite values refuse. Setter failure retains the old
effective value. Restart-required changes have a separate pending value. Reset
uses the default. The first installed owner is `capture.cap_mb` (1–256 MiB).

Registry admission is 256 entries/64 KiB, descriptor at most 4 KiB, enum at most
64 choices of 128 bytes. `ParametersModel` contains rows, total, offset and next
cursor. No document mutation/history is involved. Runtime startup and later
mutations are serialized on one worker:

1. Registered defaults.
2. `--params <file>` profiles in their argument order.
3. `--param name=value` overrides in their argument order; last value wins.
4. Accepted panel and channel mutations, through the same acknowledged setter.

Profiles are JSON `{name,params,flags}`. Nonempty flags explicitly refuse until
their owner exists. All assignments in one profile validate before setters run;
a setter failure names the failed assignment and reports earlier acknowledgements.
Explicit saves use a scoped LocalStorage at `%LOCALAPPDATA%/StykAnimate/devtools/params`
and safe `<name>.json` filenames. Load runs in the same ordered worker as edits.
CLI files are read through Files, with a combined 64 KiB startup payload ceiling.

The optional channel's `param.set` queues one bounded mutation, wakes the existing
app subscription and passes Core::dispatch before reaching Runtime. Closed panels
do not disable it. With no attached window, it explicitly reports that no command
route is available; the process registry remains alive for a later window. Startup
validation errors are retained and returned by requests; they cannot silently
fall back to defaults.

An acknowledged channel change refreshes an open parameter page from the same
registry; the model never applies a second copy of the setter or validation rule.

## Release isolation and verification

Every production extension seam is gated by `devtools`, independently of `inspect`.
`check-shipping-features` rejects resolved developer features in production crates
as well as developer crates and enabled styk-trace. `check-release` first checks
PE/map identity and linked developer symbols, then scans bounded chunks of the
executable for all developer catalogue keys and the installed parameter name,
catching inlined data without a
developer symbol. The separate release examples deliberately retain an actual
Core dispatch route and the actual catalogue data; their ignored integration test
builds both optimized and requires rejection.

Tests cover real app handler/effect/worker wake routes, mounted deadline wake and
injected clock, F11 and dock undo, registry precedence and refusal, bounds,
callback admission lifetime, capture ownership and streamed atomic replacement.
Frozen fixtures and performance thresholds are unchanged.

F11 already names Camera Copy in the product catalogue. The developer-only
window supplies a gated Developer shortcut scope before Global, as required by
design 3.5.2. The product-only resolver and its frozen Camera Copy fixtures remain
unchanged, as does shipping F11.

The toolkit-free Host is exposed by `styk-devtools/panels`; `ui` forwards that
feature and `styk-ui/devtools` together. The default headless tools dependency
only enables `inspect` in Core. This prevents a combined default guard build
from enabling Core extension variants without their UI adapter.

## The views (K-dev panels, step 3)

`styk_devtools::ui` (feature `ui`, which the application's `devtools` feature enables) draws the models above and owns
no decision. `Context::of(&Host, Surroundings)` borrows the host's models, availability, error, argument request and draft;
`ui::panel(&Context, &PanelId)` is the view the dock places for `dev.profiler`, `dev.logs` and `dev.parameters`
(`styk_ui::dock::window_with` takes it as the dock's extra panel source; `icon_of` asks `Panel::icon`), and `ui::overlay`
is the layer the application stacks above the dock and below menus and messages.

- **Developer mark.** `Dev` on the well (`--surface-well`, micro type, `--radius-xs`) with the `dev.accent` dot
  (`--violet-500`), at the end of every developer panel's header. The tab icon's dot of design 3.4 and the floating window's
  top rule wait for `Tabs` to carry a mark and for floating windows (K-dock part 2).
- **Profiler.** Start, Stop and Export are `Command::Run` of the registered ids, enabled by `Host::availability()`. Export
  asks for its file through the host's argument request: a field showing `Host.draft`, typed through `Event::Draft`, Enter or
  Export sends `Event::Export(FileTarget)`, Cancel or Escape `Event::Input(None)`. Below: the status line, bytes and drops,
  and the summary statistics of `ProfilerModel.summary`.
- **Logs.** Level chips and the module and text fields send `Event::Filter` (every change starts at offset 0; the host
  clears the page and resamples); the page's rows, `LogsModel::next`/`previous` for the pager, the counts and the ring's drops.
- **Parameters.** One block per row: integers and floats a stepper (one press, one `Event::Set` of the value one step away;
  the registry clamps), bools a switch, enums a row of chips, a reset that is enabled only for a modified value, the default,
  a pending value and a restart note. Controls disable while the host is busy.
- **Overlay.** A passive `Layer` child at the host's `bounds` (inset 12 px) while `visible`: the frame sparkline with the
  16.7 ms line (late frames, over 1.5 budgets, in the danger colour), the quantiles of each timing stream (a stream with no
  records says "Unavailable", never zero), stalls, drops, truncation, private memory and each video segment. It takes no
  pointer and registers no panel.
- **Focus.** Controls take ids from `dev_extension::ids::slot(panel, n)`, `PER_PANEL` apart.
- **Text.** Every string is a `dev.*` catalogue key (gated, in `dev_extension_catalogue.rs`), formatted through the presentation;
  a test scans the views for keys the catalogue lacks.

The host gained what the views need and the plan assigned to it: `Event::Draft`, `Host.draft` (cleared when the request ends,
is cancelled or is accepted; bounded to 2 KiB) and the pager cursors `LogsModel::next`/`previous` and
`ParametersModel::previous`.

**Screens.** `dev-profiler-recording`, `dev-profiler`, `dev-logs`, `dev-parameters` and `dev-overlay`, each in both themes
(`styk_devtools::ui::screens`), drawn by a developer build of the application (`stykanimate --screen <id>`). The preview cannot
draw them: the developer crates link the engine through `inspect`, and the preview's graph is model-only. `limits.toml` records
them as new screens whose references are this build's own accepted captures (`docs/native/screens/devtools/`); `cargo xtask
check` compares them in its last step, which builds the developer application in its own cargo invocation. The overlay screens
show the card over the stage's field; the profiler screens show the export request open.

**Tests.** `styk-app` `developer_view_tests.rs` mounts the dock's panels and the overlay in the headless interface and goes
through `TopBand::update`, `Core::dispatch`, the extension effect, the worker and its real wake: Start, Stop and Export (button
and Enter) reach the capture controller and the output service, a parameter step and a reset are acknowledged by the setter,
the log filter applies in the worker, and the overlay is drawn at the stage's corner while a press goes through it.

**Not in the views, for the core to decide later.** The logs pager follows the oldest-first offset the worker pages by, with no
"follow the tail"; parameter profiles (Save and Load) have no view yet; the overlay's own draw cost (design 3.5.2) has no
producer; the monospace font of the design's data surfaces is not bundled, so the panels use Inter.
