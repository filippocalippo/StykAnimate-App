# N4. One instrumentation layer, compiled out of the release build

**Date:** 2026-11-06. **Status:** accepted.

**Decision.** Normal code carries named spans and counters through `styk-trace`'s macros (`span!`, `counter!`,
`mark!`). The crate's `enabled` feature, turned on only by the app's `devtools` feature, makes them record into a small
lock-free ring buffer of recent spans per thread and, when a tool asks, forward to `tracing` subscribers (Chrome trace
for Perfetto, Tracy). With the feature off the macros expand to nothing and the crate has no dependencies.

**Why.** `tracing`'s own static levels key off `debug_assertions`, but the developer build is optimised like the release
build and must carry the spans, so the switch has to be the app's feature. A crate of macros keeps every call site the
same in both builds, lets engine crates instrument themselves without depending on the tools, and lets CI check the
release binary for the absence of the tools' symbols.
