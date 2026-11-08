# Native memory probe (MP)

An explicit CLI `--memory-report` sample now requests the `MemoryDiagnostics`
service. `styk-devtools-engine::memory::request_capture` uses that same service
and writes one allocation group per bounded capture chunk. Neither creates work
until requested. The platform admits one concurrent walk, on its diagnostic
worker; the offline CLI alone waits for completion. Rendering is unchanged.

The walk stops after 65,536 VirtualQuery calls or 4,096 allocation groups,
reports truncation, and never allocates per page or touches queried memory.
Heap handles are limited to 1,024; thread enumeration to 4,096 system threads;
DXGI enumeration to 16 adapters (node zero, local and non-local). Errors and
incomplete enumeration are visible. OS calls themselves have no latency guarantee.
Only image basenames are emitted; mapped file paths and contents are omitted.

## Interpretation and limits

`MEM_PRIVATE` commitment is partitioned into process heap roots, other heap
roots, thread stacks and unknown allocations. Image and mapped commitment are
separate totals, **not** extra private bytes. Writable image pages are not
necessarily private: VirtualQuery preserves MEM_IMAGE after copy-on-write.
Rust's Counting allocator delegates to System, sharing the process heap with
foreign libraries. Its live-byte counter overlaps heap commitment and cannot be
added to it. GetProcessHeaps identifies roots, not all segments or their callers.
The probe does not lock or walk foreign heaps, or infer a private allocation's
owner from proximity to a loaded DLL. A module name is evidence for an image
mapping only, never evidence that its anonymous allocations belong to a driver.

DXGI reports per-process adapter usage, budgets and reservations. These overlap
wgpu accounting and are not a private-memory decomposition. Resource residency
is unavailable through this interface without the resource handles; no device
or rendering path is introduced to obtain them. Queries are non-atomic: private
bytes before and after bound the observation interval, not a mathematical error
bound. Concurrent allocations and the probe itself affect the snapshot.

This diagnostic supplies evidence, but cannot by itself settle RM's ownership
question for anonymous allocations, heap secondary segments, copy-on-write pages
or driver/kernel commitments outside the user virtual address map. Those need
allocation provenance (for example an opt-in ETW allocation trace), rather than
labeling unexplained bytes as a driver floor.

CLI `styk memory-capture <new.styktrace>` invokes the developer capture API
for its own process, with a 2 MiB cap and create-new output. An existing file is
never replaced. It is a one-shot standalone diagnostic, not a control-channel
operation. The export's `--memory-report` contains the full per-frame JSON account.

Sources: [VirtualQuery](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtualquery),
[GetProcessHeaps](https://learn.microsoft.com/en-us/windows/win32/memory/getting-process-heaps),
[DXGI video memory](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_4/ns-dxgi1_4-dxgi_query_video_memory_info).

## A/B evidence, 2026-11-08

One release run per document, input read in place, Vulkan, 120 frames (100-219),
3840x2160 H.264 Great and edges smoothing, through the heavy queue. Both exports
returned exit 0, 120 frames and zero staging leftovers. No timing claim is made.
Binary SHA-256: `393977e7b971c48fcef7c7517f80cf6e36b63b9bcc045f8f171038322956b201`.
Sources and binary hashes are retained in `artifacts/mp/identity.json`; raw samples,
run identities and the derived account are in `artifacts/mp/`.

These are the highest **logged frame checkpoints**, not an atomic peak snapshot.
The independent export monitor observed higher own-process peaks: A 1332.21 MiB,
B 1090.45 MiB. The probe's rows overlap; do not sum them into process private.

| Measurement (MiB) | A, tick 194 | B, tick 206 |
| --- | ---: | ---: |
| Process private before requesting probe | 1300.55 | 1088.40 |
| Process private at walk start / finish | 1300.60 / 1172.35 | 1088.45 / 1088.45 |
| Rust live allocations (overlapping) | 184.91 | 202.06 |
| wgpu allocated / reserved (overlapping) | 360.43 / 768.00 | 334.68 / 768.00 |
| Process heap root commitment | 1.00 | 1.00 |
| Other heap root commitment | 0.07 | 0.07 |
| Thread stack commitment | 1.30 | 1.62 |
| Unknown private allocation commitment | 1253.94 | 1073.92 |
| Images, all commitment (not private total) | 283.99 | 283.99 |
| Mapped commitment (not private total) | 10.74 | 10.74 |
| Private counter minus queried MEM_PRIVATE (non-atomic residual) | 44.25 | 11.79 |
| NVIDIA image commitment / writable subset (not private proof) | 197.97 / 6.79 | 197.97 / 6.79 |
| DXGI local / non-local process usage (overlapping) | 709.23 / 92.89 | 709.23 / 92.89 |
| DXGI local / non-local budget | 11231.00 / 48253.17 | 11231.00 / 48253.17 |
| Driver-owned anonymous private commitment | unknown | unknown |

Both walks report `truncated: false`: 1964 regions for A, 1600 for B. DXGI
returns two identically named NVIDIA entries with identical usage; the table
reports their individual values, **never their sum**. The raw rows are retained;
the report has no LUID identity and must not assume those entries are independent.
The Basic Render Driver reports zero usage. Reservations are zero; per-resource
residency is unavailable. A's 128.25 MiB in-walk decrease rules out treating its
residual or region sums as a simultaneous decomposition.

**RM remains open.** Rust's 184.91/202.06 MiB live allocations and wgpu's named
allocations are application-owned, but overlap process/adapter accounting.
GPU sprites account for 128/192 MiB; A's glyph masks for 32 MiB, in the retained
renderer ownership report. These are owners a renderer investigation can inspect,
not proof of the CPU-private gap. The driver's image mappings are identifiable,
but their writable bytes do not establish private commitment, and anonymous driver
allocation ownership is not exposed by VirtualQuery. The 520.55/308.40 MiB above
780 MiB at these checkpoints cannot safely be assigned to either side. The next
investigation needs allocation provenance (e.g. an explicitly scoped ETW heap and
VirtualAlloc trace with call stacks) plus stable adapter identity, not a threshold
change or a claim that the unknown memory is a floor.

## Verification and decisions

- Initial four-crate suites: `384 passed; 0 failed; 26 ignored` (existing ignores).
- Final memory-focused tests after review fixes: `7 passed; 0 failed; 0 ignored`.
- Final cargo check, scoped all-target clippy (`--no-deps`), and release CLI build:
  exit 0; existing unrelated warnings remain. `cargo xtask check`: exit 0;
  `screenshots: active, 42 references (43 catalogue screens)` and preview parity.
- Capture CLI smoke: `65 valid chunks; complete walk; existing output preserved; PASS`.
- Sol high reviewed once. Unexpected enumeration failures now mark incomplete
  evidence; the capture API gained a production CLI entry point. Final inspection
  also checks thread-process identity against thread-ID reuse. No second review.
- Use the existing opt-in memory-report flag; disabled reporting remains lazy.
- Preserve shared-system-heap and anonymous ownership as unknown. Do not lock
  foreign heaps, add allocator hot-path instrumentation or infer ownership from DLL
  names. This is a deliberate departure from the brief's full arena/driver attribution;
  the diagnostic is useful but does **not** satisfy MP's goal of settling RM.
- Keep each enumeration row rather than deduplicating by display name, which is not
  a device identity. Do not repeat A/B to choose a more stable or favorable sample.
- Use a standalone capture CLI rather than expand the control protocol/schema.
- Follow native-common over the older Electron instructions; use MP's actual model
  assignment rather than the older common brief's unrelated Claude commit footer.
- The configured toolchain lacks rustfmt; use the already-installed stable formatter
  directly. No toolchain installation, frozen-fixture change, threshold change or push.
