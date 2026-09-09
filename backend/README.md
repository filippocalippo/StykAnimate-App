# Local Pivot codec service

Run `python backend/server.py --port 47831` from the app directory. Python 3.10+
and its standard library are sufficient. Install the optional compiled encoder
with `python -m pip install -r backend/requirements-fast.txt` for faster large
imports; desktop builds bundle it. The service binds only to loopback,
serves the application, and keeps all file decoding outside the render process.

The existing verified parsers in `tools/` and the native app's
`StykAnimate/tools/codec_bridge.py` remain authoritative. This service specializes
the modern reader in its own process to bulk-read contiguous pose arrays and
avoid allocating the obsolete scalar-editor JSON-pointer inventory. No existing
tool is modified. It does not approximate unsupported files.

## HTTP contract

| Request | Response |
| --- | --- |
| `GET /api/health` | `{ok,name,schemaVersion,codec,versions,formats,maxImportBytes,jsonEncoder}` |
| `GET /api/samples` | `{ok,samples:[{path,name,kind,size}]}` |
| `POST /api/import?filename=name.piv` with raw bytes | `{ok,document,sourceId,filename,kind,version,timings}` |
| `POST /api/open` with `{path}` | Same import response; path is workspace-relative |
| `POST /api/export` with `{document,sourceId?,format,filename?,figureTypeId?}` | Binary `.piv`, `.stk`, or `.styk`, with `Content-Disposition` |

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

No-op PIV/STK exports return identical imported bytes. Changed modern PIVs use
the full document writer; changed legacy PIVs migrate through the existing
verified V5 writer. `.styk` saves embed the original source so a later session
can still preserve unknown original data. STK export includes selected definition
geometry, polylines/polygons, sprites, text outlines, and its decoded media.
Source fingerprints canonicalize numerically integral floats (including negative
zero) as integers, matching browser JSON number normalization. Nonintegral
floats, exact integer values, booleans, strings, and unknown fields stay distinct.
Normalization does not mutate the editable document. New native metadata records
`document_digest_version: 3`; known legacy object `runtime_segments` caches are
excluded because the authoritative angles/lengths remain. Other unknown fields,
including identically named fields at other locations, stay distinct. Older
native fingerprints remain readable; legacy originals can be re-decoded to
compare their authoritative data when older saves already dropped pose caches.
Native projects retain their authored name and additional `_styk` metadata.
Unchanged embedded STK sources also export byte-for-byte after a service restart.

## Desktop packaging

The Electron launcher may set `STYK_TOOLS_ROOT`, `STYK_BRIDGE_PATH`, and
`STYK_WEB_ROOT` to staged resources. `--workspace` selects sample discovery root;
`--static-root` overrides web assets. An optional `STYK_API_TOKEN` or `--token`
requires `Authorization: Bearer <token>` for codec APIs. Health and static
resources remain available to the launcher. Host and Origin must be local even
without a token; remote origins and filesystem traversal are rejected.

Run verification with `python -m unittest discover -s backend -p test_server.py`.
Tests cover the real 37-file PIV corpus, shipped and workspace STKs, edited
exports, native-save reopening, parser equivalence, bounded invalid input,
cache isolation, and actual HTTP binary uploads/downloads.
Run `node backend/test_browser_roundtrip.mjs` for real Chromium JSON
parse/stringify roundtrips on both large fixtures, native saves, an actual
backend restart, byte/SHA256 identity checks, and preservation of fractional edits.

The frontend `ImportClient` in `src/import-client.mjs` sends transferable upload
buffers to `src/import-worker.mjs`; network reads and JSON parsing run there.
Use `importFile(file)`, `openSample(path)`, `importNative(file)`, and `dispose()`.
All import methods resolve the API response above. The worker appends
`worker_fetch_ms`, `worker_parse_ms`, and `worker_ms` timings. Editable documents
return through byte-bounded acknowledged chunks, including fragments for large
embedded strings, so the UI never receives one giant structured-clone task.
Those timings do not claim to measure total load-to-first-frame latency.

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

The desktop now negotiates the internal native v5 frame transport. The existing
parser reads definitions, assets and the trailer; `fast_decode.py` validates all
frame bytes without allocating the 208,373 editable object dictionaries and pose
lists in the Akane example. It checks every numeric field, background/type
reference, signed identity order, joined target/cycle, drawing permutation and
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
identity/order errors, interpolation type changes and concurrent request isolation.

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
`native/bin/<architecture>/frame-scan-build-info.json`.

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
selected implementation. Release packaging adds the matching library under the
sidecar's `native` directory. Windows x64 is verified locally; other platform
binaries must be built and tested on their target OS.

Run `python -m unittest discover -s backend -p test_native_scan.py -v` after
building. Set `STYK_REQUIRE_NATIVE_SCAN=1` in release checks to fail if the library
is absent. The tests compare both implementations across 1,500 deterministic
byte mutations, all truncations of a mixed fixture, signed UID boundaries,
hidden-frame interpolation, a 5,000-object join chain/cycle and exact resource
limits, alongside the existing complete corpus/header differential suite.

`artifacts/backend-akane-cpp-scan.json` records one C++-enabled Akane decode at
668.8 ms, with 11.9 ms inside the native frame wrapper, versus 1,263.5 ms using
the Python scanner. Both produced identical definition/header and duration
digests. These sequential CPU measurements exclude HTTP, frontend work and
rendering; the matched desktop benchmark determines user-visible import latency.
