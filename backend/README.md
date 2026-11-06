# Python Pivot codec service (development test oracle)

**The app does not run this code.** Every build (desktop, development server, web) runs the
Rust codec, `engine/crates/styk-piv` compiled to WebAssembly, in a worker of the editor page
(`src/codec-web-worker.mjs`; see [Pivot files and the codec service](../docs/engine/formats-piv.md)).
This directory and `codecs/` are kept as the oracle that implementation is checked against:
`engine/tools/piv/parity.sh` records this service's answers and replays them against the Rust
codec, and the Python unit tests below still run. Nothing here is packaged or deployed.

Run `python backend/server.py --port 47831` from the app directory to compare against it by hand.
Python 3.10+ and its standard library are sufficient. Install the optional compiled encoder and
zstd codec with `python -m pip install -r backend/requirements-fast.txt` for faster large imports
and version-2 container sections. The service binds only to loopback, serves the application, and
keeps all file decoding outside the render process.

The existing verified parsers in `tools/` and the native app's
`StykAnimate/tools/codec_bridge.py` remain authoritative for this oracle. This service specializes
the modern reader in its own process to bulk-read contiguous pose arrays and
avoid allocating the obsolete scalar-editor JSON-pointer inventory. No existing
tool is modified. It does not approximate unsupported files.

## HTTP contract

The Rust codec answers these routes identically over the codec worker's ports, except
`/api/samples` and `/api/open`: in the app the desktop main process lists and reads samples
(`desktop/samples.cjs`, under the rules of `ProjectStore.samples`, `safe_child` and `open`), and a
sample opens as an ordinary `/api/import` of its bytes.

| Request | Response |
| --- | --- |
| `GET /api/health` | `{ok,name,schemaVersion,codec,versions,formats,maxImportBytes,jsonEncoder}` |
| `GET /api/samples` | `{ok,samples:[{path,name,kind,size}]}` |
| `POST /api/import?filename=name.piv` with raw bytes | `{ok,document,sourceId,filename,kind,version,timings}` |
| `POST /api/open` with `{path}` | Same import response; path is workspace-relative |
| `POST /api/export` with `{document,sourceId?,format,filename?,figureTypeId?}` | Binary `.piv`, `.stk`, `.styk`, or `.stkz`, with `Content-Disposition` |
| `GET /api/source?id=<sourceId>` | Original uploaded source bytes (`STYKSRC1` envelope) for worker-side container builds |
| `POST /api/source/retain` with `{sourceId,ownerId}` | `{ok:true,retained}`; retain an active PIV/STK original beyond ordinary cache eviction |
| `POST /api/source/release` with `{ownerId,jobId?}` | 204; cancel that pending job when supplied, then release the owner's original source |

Errors are non-2xx JSON `{ok:false,error,code}`. `source_expired` (410) explicitly
requires reopening the original source; it never silently drops unknown bytes.
The document is the existing codec schema: `figure_types`, `keyframes`,
`canvas_width`, `canvas_height`, `fps`, and the original decoded fields. Media
is embedded as data URLs/base64. `_codec` and `editable_paths` are omitted.
Duplicate `side_tables` aliases are omitted when they point to exactly the
same image/text objects, avoiding a second JSON copy of sprites and glyph paths.
The full writer accepts the canonical `image_assets` and `text_assets` arrays.
`.json` uploads are accepted as native projects. The early web save wrapper
`{format:"stykanimate",version:1,name,document}` also imports; current native
saves embed original Pivot source data directly in the document.

`timings` contains `decode_ms`, `total_ms`, `cache_hit`, `source_bytes`, and
`document_bytes`. Timings describe codec/transport preparation, not GPU frame
performance. HTTP imports directly wrap the cached encoded JSON, avoiding a
redundant parse and serialization. Semantic source hashing is deferred to export.
Imports reuse a bounded 24-entry / 384 MiB source-and-document LRU
cache. The source limit is 128 MiB and the decoded/native document limit is
256 MiB. No source file is written to. Legacy STKs use a private temporary copy
only for the established parser's path-based interface.
Native imports retain their encoded document once; the upload itself is not
retained a second time because the document already embeds its original source.
This allows large native saves to reopen within the same cache bound.

An active imported project owns a source lease separate from the decoded-document
LRU. Import/open requests can send `X-Styk-Source-Owner`, a random 32-character
lowercase hexadecimal identity unique to that pending import. The service leases
validated PIV/STK bytes before returning a successful response and includes that
identity as `sourceOwner`. Native projects need no additional lease because they
already embed their original bytes. Only immutable source bytes and small
provenance metadata are leased; decoded JSON and native frame buffers remain
evictable. Cache and lease references share the same source allocation. Leases
have an independent 384 MiB unique-source budget and a 16-owner limit, so the
combined retained cache/lease data is bounded by 768 MiB before decoder/response
working allocations. Shared owners count one original once.

`/api/source` and source-based exports resolve a leased original after its decoded
entry is evicted. Fingerprints remain deferred until export and are computed once
from the validated original, including STK definition names and opaque Pivot data.
Retaining a new source for an existing owner replaces its old lease only when the
new lease fits; a failed or cancelled retain leaves the old lease intact. A native
source retain returns `retained:false`. The editor adopts successful project
leases and releases rejected imports, imported figures, replaced documents and
disposed sessions. For cancelled requests, release includes the import's `jobId`
so the service cancels pending work before removing its lease in the same
acknowledged control request. This prevents a late lease even when a separate
`/api/cancel` request times out or fails. A 204 confirms cleanup; a network error
or non-success response does not. Every lease disappears when the codec service
closes, including the
parent-process shutdown path. No additional original source files are written.
These endpoints use the same loopback/origin/token checks as imports and exports.
Retain uses the bounded codec queue; release is small control work that remains
available even when that queue is full.

No-op PIV/STK exports return identical imported bytes. Changed modern PIVs use
the full document writer; changed legacy PIVs migrate through the existing
verified V5 writer. `.styk` saves embed the original source so a later session
can still preserve unknown original data. STK export includes selected definition
geometry, polylines/polygons, sprites, text outlines, and its decoded media.
Source fingerprints canonicalize numerically integral floats (including negative
zero) as integers, matching browser JSON number normalization. Nonintegral
floats, exact integer values, booleans, strings, and unknown fields stay distinct.
Normalization does not mutate the editable document. Source and submitted-document
fingerprints process one frame at a time, avoiding a second complete normalized
document and JSON buffer during export comparison. Successful exports expose fixed
`Server-Timing` stages and `X-Styk-Request-Bytes` for local performance diagnosis.
Native metadata records
`document_digest_version: 3`; known legacy object `runtime_segments` caches are
excluded because the authoritative angles/lengths remain. Other unknown fields,
including identically named fields at other locations, stay distinct. Older
native fingerprints remain readable; legacy originals can be re-decoded to
compare their authoritative data when older saves already dropped pose caches.
Native projects retain their authored name and additional `_styk` metadata.
Unchanged embedded STK sources also export byte-for-byte after a service restart.

## Running it as a service

`--workspace` selects the sample discovery root (the folder that holds the app by default);
`--static-root` overrides web assets. An optional `STYK_API_TOKEN` or `--token` requires
`Authorization: Bearer <token>` for codec APIs; with a token, health also returns `session`, a
SHA-256 proof of the token. Health and static resources remain available without it. Host and
Origin must be local even without a token; remote origins and filesystem traversal are rejected.
`--exit-on-stdin-close` makes the server stop when its standard input reaches EOF. The desktop
app used these to run this service as a sidecar until the Rust codec replaced it.

The service admits at most 16 heavy requests, with one active request; queued
uploads wait before body parsing. Health, cancellation and source-release stay outside this
queue. Cancellation checks occur at existing codec loop/stage boundaries and
before source-cache publication. Stalled uploads are also cancellable. Native
calls, JSON parsing/encoding, compression and individual deep copies finish
before their next checkpoint; this is cooperative cancellation, not thread
termination. Import/export requests carry a random 32-character lowercase hexadecimal
`X-Styk-Job-Id`; `POST /api/cancel?id=<identity>` with an empty body cancels that job.
Cancelled identities are retained for up to 120 seconds in a bounded 256-entry
race-protection cache.

Regression checks: `python -m unittest discover -s backend -p test_jobs.py` and
`node backend/test_browser_roundtrip.mjs` (a real browser against this service).

Run verification with `python -m unittest discover -s backend -p test_server.py`.
Run `python -m unittest discover -s backend -p test_source_lifetime.py` for active
source eviction, shared-owner and quota behavior, cancellation, native restart,
exact original-byte preservation and HTTP authentication/shutdown checks.
Tests cover the real 37-file PIV corpus, shipped and workspace STKs, edited
exports, native-save reopening, parser equivalence, bounded invalid input,
cache isolation, and actual HTTP binary uploads/downloads.
Run `node backend/test_browser_roundtrip.mjs` for real Chromium JSON
parse/stringify roundtrips on both large fixtures, native saves, an actual
backend restart, byte/SHA256 identity checks, and preservation of fractional edits.

The frontend `ImportClient` in `src/import-client.mjs` sends transferable upload
buffers to `src/import-worker.mjs`, which sends them to the codec worker over a
MessagePort (`src/codec-request.mjs`); response reads and JSON parsing run there.
Native containers (`.styk`/`.stkz`/`.stykmov`) open locally in that worker —
the Rust container reader (`src/native-file-codec.mjs`) reads version-1 and version-2 containers and legacy
JSON, checks all digests, admits the binary sections, and verifies the embedded
source fingerprint. Use `importFile(file)`, `openSample(path)` (desktop: the main process reads the sample),
`importNative(file)`, and `dispose()`. All import methods resolve the API
response above. The worker appends `worker_fetch_ms`, `worker_parse_ms`, and
`worker_ms` timings. Editable documents return through byte-bounded
acknowledged chunks, including fragments for large embedded strings, so the UI
never receives one giant structured-clone task. Those timings do not claim to
measure total load-to-first-frame latency.

Run `node tests/import-worker-browser.mjs` for real browser verification of
transfer ownership, concurrent requests, native compatibility, and error handling.

## Measured large-project import

`profile_import.py` measures one actual import with stage timers and process
memory counters. The exact 17,179,483-byte Akane fixture expands to 185.7 MB of
JSON, with 1,479 keys, 208,373 objects, and 3,707,681 pose values.

| Stage | Baseline | Optimized |
| --- | ---: | ---: |
| Verified binary decode | 4.20 s | 4.21 s |
| Repeated bridge validation | 3.08 s | Already checked by the binary grammar |
| Document JSON encoding | 3.30 s | 0.284 s |
| Total import / encoded response | 10.92 s | 4.84 s |
| Peak process working set | 1.055 GB | 0.869 GB |

These are single-run Windows measurements on the same exact file, excluding
file read, HTTP transmission, frontend transfer and rendering. Reports live in
`artifacts/backend-akane-profile.json` and `backend-akane-profile-after.json`.
The modern binary grammar already checks finite scalar/array values, canvas
dimensions, FPS, segment counts/parents/primitives, pose sizes, object identities,
join targets/cycles, and drawing-order permutations. The service retains the
additional nonempty-keyframe rule and avoids rescanning the verified modern PIV
document. Native JSON, STK imports and all exports still use full independent
bridge validation, including nonfinite values hidden in unknown fields.

The optional [orjson encoder](https://github.com/ijl/orjson) emits UTF-8 bytes
directly for validated data. Unsupported integer widths and unusual Unicode
fall back to the original ASCII-escaping serializer; every corpus value is
compared against the standard encoder. Fingerprints keep their stable standard
JSON encoding. Set `STYK_DISABLE_FAST_JSON=1` to verify the dependency-free path.
The encoded response uses one concatenation allocation instead of several.

### Native frame transport and validation-only decoding

The editor negotiates the internal native v5 frame transport. The existing
parser reads definitions, assets and the trailer; `fast_decode.py` validates all
frame bytes without allocating the 208,373 editable object dictionaries and pose
lists in the Akane example. It checks every numeric field, background/type
reference, identity uniqueness, joined target/cycle, drawing permutation and
inter-frame figure-type change. The frontend reconstructs the same complete
document from the validated original frame bytes. Legacy versions use their
established complete decoder. This transport is not a new saved file format.

`decode_for_native_wire(..., with_payload=True)` returns the validated decompressed
payload with the report so the transport does not inflate the source twice. Scan
mode and the temporary payload reference are thread local and restored after
both successful and failed decoding. Normal JSON requests and export digests
use the full decoder; canonical JSON is materialized lazily for a source first
opened through native transport.

The full frame decoder also batches adjacent fields in compiled `struct` calls
and reuses validated figure handle sets. Differential tests compare the complete
decoded dictionaries and encoded bytes against the original reader across all
37 corpus files. Scanner tests compare every non-frame header field and all
legacy models, and exercise truncated records, nonfinite numbers, invalid joins,
duplicate identities, unsorted IDs, interpolation type changes and concurrent request isolation.

Modern PIV imports preserve source object slots even when IDs are not sorted.
Joins and drawing order reference those slots, not signed-ID order; only the
writer sorts records and remaps slots for export. Duplicate IDs use one shared
document-wide recovery policy in `piv_codec.py`: reserve all source IDs, retain
the first occurrence of each ID in each key, and give each extra occurrence a
fresh uint32 ID unused anywhere in the animation. Extra occurrences are isolated
per key rather than matched heuristically across frames. No figure, pose, join,
draw-order slot, duration or hidden key is removed. The editor shows import notes
identifying the affected keys because their interpolation identity is ambiguous.

The native scanner requests recovery only after the portable scan validates the
whole frame table and pose budget. JSON and native imports then share the same
canonical recovery. A sparse `piv_identity_recovery` audit patches only UID
fields in a private transport buffer, so joins, numeric bits and source offsets
stay exact. The frontend rejects any duplicate identity left in that buffer.
Old ABI-compatible scanners that reject ordering or type transitions fall back
to complete portable validation. Other structural errors still reject the file.
Original uploads and unchanged PIV exports remain byte-identical; edited PIV
exports contain the recovered unique IDs, and native saves retain the audit.

`backend/test_piv_identities.py` and `tests/piv-identities.test.mjs` cover global
ID allocation, signed extremes, hidden keys, slot joins, wire/JSON equality,
cache order, edit/undo, save/reopen, and late malformed data. Run
`node tests/piv-identities.browser.mjs` for file-input/worker/editor verification;
its optional source path runs the reported Suzuki fixture checks without storing
the user's animation in the test suite.

Figure-type changes for the same object ID are accepted across all keyframes,
including intervals with inbetweens and hidden endpoints. Each pose and join is
validated against its own frame's definitions. The player holds an incompatible
outgoing figure until the next keyframe, then switches types; all source keys,
durations and IDs are preserved. `test_piv_type_changes.py` covers both decoder
paths, different rig sizes, compressed inputs and a 1,129-keyframe save/reopen.

An isolated Akane scan took 1.431 seconds with Python cyclic GC enabled, compared
with 5.427 seconds for the earlier full frame decoder in a separate component
diagnostic. These are **CPU component measurements, not desktop import latency**;
HTTP, frontend reconstruction and first rendering require separate end-to-end
verification. Reports are `artifacts/backend-akane-native-scan.json` and
`artifacts/backend-fast-decode-akane.json`.

Run `python -m unittest discover -s backend -p test_fast_decode.py -v` for the
differential suite. `python backend/benchmark_fast_decode.py <file.piv>` compares
full decoder implementations and reports exact output digests. Its GC-disabled
row is diagnostic only; native transport avoids those allocations in production.

### Optional native validation accelerator

`python scripts/build-frame-scan.py` builds `native/piv-frame-scan.cpp` for the
current platform. Windows uses MSVC with its [static `/MT` runtime](https://learn.microsoft.com/en-us/cpp/build/reference/md-mt-ld-use-run-time-library),
while Linux and macOS produce a shared library with the host C++17 compiler.
The build records the source/library SHA-256, ABI, architecture and toolchain in
`frame-scan-build-info.json` beside the library. `native_scan.build_directory()`
owns the location: Windows keeps the historical, tracked `native/bin/<arch>`;
Linux and macOS build into `native/bin/<platform>-<arch>` (for example
`linux-x64`), which is untracked, so a build on one OS never rewrites another
OS's manifest. Both build scripts import that function.

`backend/native_scan.py` loads the optional library through a fixed
[`ctypes` C ABI](https://docs.python.org/3/library/ctypes.html). Immutable source
and definition bytes are borrowed only for the duration of the call. The caller
owns the bounded duration output array; native allocations never cross the ABI.
The validator checks IEEE exponent bits directly, so NaNs and infinities are
rejected while negative zero and finite subnormal values remain valid. It uses
the same 2560 MiB (2.5 GiB) estimated pose budget as the Python scanner and frontend: 512
bytes per frame/object, 24 per pose scalar and 64 per joined object. Frame and
object inventory charges occur before their allocations.

Set `STYK_DISABLE_NATIVE_SCAN=1` to exercise the Python fallback. A missing or
incompatible library also falls back; `native_scan.status()` reports the actual
selected implementation. No release ships it any more: the Rust codec validates frames itself
(`styk-piv` `piv/frames.rs`). Windows x64 is verified locally; other platform
binaries must be built and tested on their target OS.

Run `python -m unittest discover -s backend -p test_native_scan.py -v` after
building. Set `STYK_REQUIRE_NATIVE_SCAN=1` to fail if the library
is absent. The tests compare both implementations across 1,500 deterministic
byte mutations, all truncations of a mixed fixture, signed UID boundaries,
hidden-frame interpolation, a 5,000-object join chain/cycle and exact resource
limits, alongside the existing complete corpus/header differential suite.

`artifacts/backend-akane-cpp-scan.json` records one C++-enabled Akane decode at
668.8 ms, with 11.9 ms inside the native frame wrapper, versus 1,263.5 ms using
the Python scanner. Both produced identical definition/header and duration
digests. These sequential CPU measurements exclude HTTP, frontend work and
rendering; the matched desktop benchmark determines user-visible import latency.

Native `.styk` projects and `.stkz` figures now use lossless, versioned compressed
containers with bounded inflation and SHA-256 checksums. Version 2 stores a JSON
skeleton plus binary sections for large numeric arrays and decoded base64/media
payloads, compressed with zstd when the optional `zstandard` package is present
(zlib otherwise). Version 1 and older JSON projects remain readable; new saves
write version 2. See [Native file format](../docs/native-file-format.md).
