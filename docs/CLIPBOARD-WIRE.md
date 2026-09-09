# Clipboard worker transport

`ClipboardWorkerClient.run` keeps report, clipboard and pending-edit state isolated in a disposable worker. Each input stream and the result uses the versioned `STYKCBW1` binary format in `src/clipboard-wire.mjs`. Packets own transferable `ArrayBuffer` allocations of at most 256 KiB. The receiver acknowledges only after its packet has been decoded into unpublished staging; cancellation, stale editor revisions, timeout, malformed data and worker failure discard that staging.

Float64 runs preserve JavaScript numeric values without Pivot float32 rounding. Bounded Latin-1 or UTF16 runs preserve exact strings, including unpaired surrogate code units. A bounded dictionary shares repeated property names. Plain and null-prototype records, property order, explicit undefined, negative zero, sparse-array holes and enumerable custom array fields survive the wire. Own `__proto__` properties are defined as data properties. Cycles and unsupported object types are rejected. Optional runtime-cache omission applies only to object poses in keyframes or retained frame sources; unrelated custom fields with the same name remain data.

The encoder uses an explicit traversal stack and writes directly into the packet. Its default packing target is 2 ms; the decoder yields within a packet against a 4 ms target. ACK messages already provide task boundaries between packets. These targets are not hard latency limits: garbage collection, native property enumeration and operating-system scheduling may take longer. Maximum measured packing and decoding slices are reported separately from total elapsed time.

The existing admission limit is 512 MiB of actual encoded input across all three streams, and independently 512 MiB of encoded output. Expanded data also has a separate conservative resident estimate, capped at eight times the configured wire limit. The worker subtracts prior input streams' estimates before decoding the next stream. Arrays, strings, property slots and dictionary names are charged before corresponding allocations; declared lengths, nesting and dictionary capacity have additional limits. The estimate is not measured JavaScript heap or GPU residency. `inputBytes`/`outputBytes` report transferred bytes, while `inputLogicalBytes`/`outputLogicalBytes` report this expanded estimate for history accounting.

`tests/clipboard-wire.test.mjs` and `tests/clipboard-worker-transport.test.mjs` cover exact field and string fidelity, owned transfers, malformed and truncated tokens, dictionary saturation, resource bounds, stale work, ordering, cancellation and real worker termination. The transport does not change native copy/paste semantics or validate an editor command in place of the model.

The first recursive binary encoder reduced a one-frame existing-Akane paste to approximately 107 MB in each direction, but regressed elapsed time to 15.03 seconds: output packing alone consumed 5.19 seconds. The run stopped at a separate oracle mismatch for native paste's inactive secondary-background normalization (`null` to zero). Its report remains in `artifacts/clipboard-akane-wire-cpu.json`; it is failure evidence, not an accepted performance result.

The replacement flat encoder produced the exact same 4.76 MB byte-stream hash in alternating 10,000-pose synthetic trials while reducing packing CPU from 182–200 ms to 56–67 ms. This is a packing-only microbenchmark, not application copy/paste latency. `artifacts/clipboard-wire-encoder-microbenchmark.json` retains timings and hashes.

The isolated Node worker run in `artifacts/clipboard-akane-flat-sparse-cpu.json` uses the actual 17,179,483-byte Akane source (1,479 stored frames, 208,373 poses). Runtime source hashes are unchanged throughout the run. Native sparse paste is explicitly asserted: zero existing destination poses are sent, and the result contains inserted frames rather than the full target report. All inserted native values, original frame references after Undo, Redo values, and later-edit Undo immutability pass. The native inactive secondary-background sentinel is normalized from null to zero for comparison, matching the existing paste operation.

| Copied keys | Copy | Paste into existing Akane | Paste into empty | Existing paste input / output |
| --- | ---: | ---: | ---: | ---: |
| Dense final frame (643 figures) | 372 ms | 993 ms | 375 ms | 15.17 / 0.31 MB |
| Dense final 64 frames | 1.09 s | 2.37 s | 2.16 s | 28.59 / 9.68 MB |
| All 1,479 frames | 6.32 s | 14.18 s | 14.81 s | 120.29 / 92.82 MB |

The prior existing-target 64-frame paste failed the 512 MiB logical-transfer limit. It completes within the unchanged actual-wire limit in this first combined run. Before the subsequent owned-result improvement, main-thread staging takes 6.61 seconds into the existing project and 7.11 seconds into an empty project. The corresponding worker round trips take 7.56 and 7.67 seconds. Final publication takes 18.8 and 23.2 ms. Full paste also has 70–76 ms event-loop gaps. Compared with the earlier full empty-target paste (12.28 seconds), this intermediate full empty-target result is slower despite the smaller wire and faster worker planning.

Packing slices peak at 5.21 ms and decoding at 6.57 ms in this run. Sampled process RSS peaks at 2.25 GB for all-frames existing paste and 3.08 GB for the later empty paste; these are sequential, unforced-GC samples of the entire Node process including workers, not isolated allocation peaks. Main-thread heap samples exclude worker heaps. The harness releases its temporary import JSON string and disables history-byte eviction only to perform later-edit history checks outside the measurement. Timings exclude import, Editor load, rendering and post-operation equality checks. Browser presentation latency and tiny default-scene clipboard latency need separate verification.

The next isolated run, `artifacts/clipboard-akane-owned-staging-cpu.json`, measures only the model's owned-result adoption, direct property copies and elapsed-time staging budget changes; wire format and native asset transport remain unchanged. All source hashes stay stable, and the same full-field/history checks pass. The private decoded result supplies the immutable history snapshot; only its separate editable copy is cloned. Public unowned preparation still isolates caller data.

| Workload | Prior total paste | Owned staging total paste | Prior main staging | Owned main staging |
| --- | ---: | ---: | ---: | ---: |
| 64 frames into existing Akane | 2.37 s | 1.99 s | 673 ms | 156 ms |
| 64 frames into empty project | 2.16 s | 1.54 s | 797 ms | 121 ms |
| All frames into existing Akane | 14.18 s | 8.77 s | 6.61 s | 1.39 s |
| All frames into empty project | 14.81 s | 9.26 s | 7.11 s | 1.22 s |

Full copy remains 6.25 seconds in that staging-only run. Full paste still spends 7.36–8.01 seconds in the worker round trip, and existing-target one-frame paste still sends 15.17 MB of mainly destination definitions. The live-copy phase takes 991/971 ms elapsed and 834/815 ms CPU for existing/empty targets. Its longest measured task is 41.4/52.0 ms; no CPU/GC trace was captured, so its cause is not attributed to garbage collection. Corresponding event-loop gaps peak at 41.6/52.1 ms, and sampled RSS peaks at 2.12/2.76 GB.

The final combined source diagnostic, `artifacts/clipboard-akane-final-cpu.json`, adds exact asset-match preflight and bounded numeric-array copying. The preflight checks current asset content in target order; it does not assume unchanged object identity or trust a hash match. Reserved IDs/counts preserve allocation and capacity checks, while only matched definitions cross with the sparse target. All runtime hashes remain stable and all six full-field/history check groups pass.

| Copied keys | Copy | Existing-target paste | Empty-target paste | Existing input | Exact asset preflight |
| --- | ---: | ---: | ---: | ---: | ---: |
| Final dense frame | 391 ms | 379 ms | 308 ms | 2.24 MB | 24 ms; 119/881 definitions |
| Final 64 frames | 1.09 s | 1.41 s | 1.47 s | 19.69 MB | 80 ms; 186/881 definitions |
| All 1,479 frames | 6.13 s | 8.70 s | 9.78 s | 119.37 MB | 398 ms; 850/881 definitions |

Existing-target one-frame input falls from 15.17 to 2.24 MB, and its paste time from 994 to 379 ms. All-frames paste gains little because nearly every definition is referenced. Its longest event-loop gaps remain 61/64 ms, inside live-copy preparation; sampled process RSS peaks at 2.12/2.69 GB. The final numeric-copy change does not demonstrate a further full-project tail-latency improvement. These results establish correctness and smaller ordinary transfers, not frictionless bulk operations or superiority to native Pivot.

A separate native Pivot one-frame pilot completed with isolated clipboard storage and an owned-process watchdog. The source, 643-figure final frame and insertion index zero match the Node workload. Native Copy's method takes 147.74 ms and Paste's method 195.93 ms, creating 1,480 stored frames. Operation entry to the first subsequent successful main-window Present takes 205.22/197.10 ms. This is not physical scanout, and the Node app diagnostic has no presentation endpoint. Native Copy also writes a 235,932-byte internal clipboard file, while the app keeps its clipboard in memory. The original pilot report had an incorrect scene-size/window-swapchain filter; `artifacts/native-clipboard-akane-pilot-v1/presentation-association.json` derives the association from already recorded events without changing raw timings.

The attempted native full batch completed its one-frame case, then failed closed on the owned project's unsaved-change prompt during the next reload. `artifacts/native-clipboard-akane-full-v1/report.json` preserves that failure. Native 64-frame and all-frame clipboard timings remain unmeasured; future runs must use a fresh owned process per case. No bulk native comparison is claimed.
