# Developer tools engine: implemented foundation

This document describes the implemented API, not the complete reviewed developer-tools design.
There are no new views.

`styk-devtools` has an empty default feature set. Its existing pen lab requires `ui`; the app's
`devtools` feature enables it. The optional CLI `app-tools` feature uses the toolkit-free modules.

## Captures

`capture::Capture` stores a `styktrace/1\n` header followed by chunks: a little-endian u32 byte
length and a JSON event. A chunk is at most 64 KiB; the caller chooses a capture wire-byte cap
up to 256 MiB. One contiguous allocation reserves that cap before recording; chunk headers count toward it. Unknown versions and oversized lengths fail before allocating the payload.
A truncated final chunk is discarded with `recovered = true`; malformed complete JSON is an error.
Perfetto export streams those events in a Chrome trace `traceEvents` array.
This initial format is uncompressed and does not yet persist overflow metadata or drain continuously.

## Protocol seam

`protocol::Decoder` accepts bytes incrementally and holds at most a 16 KiB line. Overflow
permanently closes that decoder. `respond` serializes at most 24 KiB and returns a structured
error on overflow. IDs are unsigned integers; hello negotiates version 1. Supported host seams
are `state.get`, `metrics.get`, `trace.start`, `trace.stop`. The host supplies snapshots/effects;
this layer does not inspect documents or expose paths. Unknown operations fail.
This is not yet a network endpoint: named-pipe transport, current-user ACL, discovery,
request cancellation/timeouts, paging, and schema generation remain to be implemented.

## Scenarios and profiles

`scenario::start` schedules exactly one task through `Spawner`, with one completion slot. An
interface caller must poll using `try_lock`; only the offline CLI waits. The versioned prefix
`styk-auto/1` accepts `open`, `frame <tick>`, `export`, and `advance <nanoseconds>`, with at most
1024 steps/64 KiB. Only `advance` changes logical time; measurement uses a separately injected
`Clock`. Owners implement `Host` through their normal operations. The CLI currently adapts the
newly merged core Documents seam for normalized open, session installation, seek and frame
records. It does not claim GPU rendering, presentation, or save-byte parity. Export fails explicitly.

The CLI writes to a new directory, never alongside input automatically, and emits an input hash
rather than the owner's path or file contents. `compare-profile` preserves the existing `compare`
command's reference-parity semantics. It reports nearest-rank quantiles, a 3%/0.05 ms/MAD noise floor, an exact tied-rank permutation
test for 5..32 runs per side (a within-side range test for 3..4), and refuses incompatible
inputs, fewer than three samples, nonfinite values, and non-release measurements. Budgets, interleaved comparisons, machine metadata, and attribution remain pending.
Regressions return exit code 1.

## Verification boundaries

`xtask check-release` is a bounded artifact marker scan, with a deliberate leak regression.
It does not yet provide same-source binary/assembly comparisons, symbol listing, or feature graph
proof for a shipping artifact. The existing trace ring still requires total-budget admission,
nonblocking cold registration, injected time, open-span snapshots and a capture drain. Disabled
macro arguments are now type-checked without evaluation, including their name expressions. GPU timing,
Tracy conversion, owner read APIs and remaining task runner commands are pending.
