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
