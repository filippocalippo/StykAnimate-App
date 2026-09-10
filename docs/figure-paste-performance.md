# Figure clipboard performance

Figure copy/paste now uses the same prepared insertion command for one frame and
selected frame ranges. It no longer enters a general authored-frame transaction
that clones the destination frame and the complete figure library twice, builds
a discarded import-history command, compares all library contents, and emits an
intermediate edit before the layer pose is committed.

The planner allocates IDs locally, indexes each copied definition's native
handles once, remaps poses/joins/IK followers, and validates the inserted objects
before publishing. Same-document definitions are reused; extracted branches and
cross-document definitions are appended. Single-frame paste retains its 24-pixel
successive offset; cut/paste retains its zero offset. Range paste retains its
explicit offset and consistent new identities across destination frames.

Native history contains sparse object/order patches. Layer-sheet history retains
the changed exposure tracks and their pose sources, with an asset splice holding
only newly added definitions. Authored-channel history likewise owns any added
definitions so asset insertion and pose insertion undo together. Live definitions
and their history snapshots remain independently owned. Paste updates selection
and publishes one edit only after validation succeeds.

Pose snapshots omit runtime segment caches and movieclip samples before cloning,
while preserving unknown saved fields. Geometry for unchanged objects remains
eligible for the existing retained cache, which verifies pose and attachment
compatibility before reuse. No new clipboard serialization format or worker
protocol is introduced.

## Measurements

Chrome headless, 1600 × 1000, this machine, September 10, 2026. Real PIV inputs
were read from Downloads without modification. Measurements include synchronous
app listeners and CPU profiling overhead. Each test copies the largest connected
figure on the busiest frame and pastes at a different time.

| Document | Native frames | Copied parts | Before paste | After paste | Before through presentation | After through presentation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| tdd2 uriel nemesis 2 | 132 | 263 | 184.7 ms | 50.8 ms | 243.7 ms | 120.1 ms |
| Akane, second round (3) | 1,479 | 105 | — | 42.6 ms | — | 99.2 ms |

The Uriel paste operation is approximately 3.6 times faster. An earlier run of
the sparse insertion path measured 41.1 ms. These are measured workloads rather
than fixed latency guarantees. Presentation includes frame scheduling and GPU
queue completion, not monitor scan-out. Dense scene rendering can still produce
a long task; the final Uriel workload recorded 106 ms, including other work in
the benchmark's task. The Akane workload recorded no long tasks.

Remaining work scales with copied content, destination object metadata, touched
layer poses, and exposure-key metadata. Extremely large individual assets or
layers can still be expensive; unrelated library asset contents are no longer
copied, validated, or serialized by paste/history.

## Verification

- 17 focused regression tests cover native/authored/layer-sheet destinations,
  cross-project assets, repeated paste, changed native handles, internal joins,
  locked-layer/invalid-pose/capacity failure atomicity, draft discard, exact
  undo/redo, save/reopen, and fresh-build geometry parity.
- Tests install throwing getters on unrelated library assets to catch any
  traversal during paste, undo, redo, or history accounting. Runtime-cache getters
  likewise prove that copy omits evaluated caches before cloning.
- The full unit suite passed: 1,362 tests, zero failures.
- Browser checks passed real Ctrl+C/Ctrl+V between frames in Simple and Advanced,
  exact renderer geometry, one undo/redo, and binary STYK save/reopen.

Reproduce with the local server running:

```powershell
node scripts/serve.mjs
node scripts/benchmark-figure-paste.mjs 'C:/Users/aleri/Downloads/tdd2 uriel nemesis 2.piv' local
node --test tests/figure-paste.test.mjs
node tests/figure-paste.browser.mjs
```

Profiles, timings, screenshots and test logs are in `artifacts/figure-paste/`.
The Uriel comparison uses `before/report.json` and `after-retained/report.json`;
the Akane measurement uses `akane3-after/report.json`.
