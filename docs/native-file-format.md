# StykAnimate native files

Save and Save As write `.styk` projects. File → Save figure, or Export →
Project → StykAnimate figure, writes a `.stkz` of the selected figure at
the current tick. Opening a `.stkz` adds it to the current animation and keeps
the project's save destination. Pivot `.piv` and `.stk` import/export remains
available.

Both native formats are lossless compressed containers. Projects keep authored
animation, working poses, layers, camera, unknown metadata and embedded assets.
Imported Pivot source bytes and their fingerprints remain embedded in projects
to preserve exact source exports across restarts. Figure files contain one
definition, its assets and one evaluated pose, including precise style overlays;
they omit other figures, project animation, backgrounds and original project
source bytes. Import places the figure at the destination canvas center and
assigns fresh IDs. A figure joined to another figure is saved detached.

New saves write container version 2. A document of a dense imported scene is
stored as a JSON skeleton plus binary sections, so typical projects shrink to
roughly half their version-1 size and reopen in a fraction of the time. Version
1 containers and original JSON files remain readable indefinitely; the next
save upgrades them.

## Container version 2

The 56-byte header matches version 1, with version `2` in byte 4. All integers
are little endian. After the header:

| Bytes | Meaning |
| --- | --- |
| 4 | Section count `N` |
| variable | Compressed UTF-8 JSON skeleton |
| `N` × 64 | Section records (see below) |
| variable | Compressed section payloads, in record order |

Section record (64 bytes):

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 1 | Kind: `1` numeric arrays, `2` binary payloads |
| 1 | 1 | Codec: `0` stored, `1` zlib DEFLATE, `2` zstd |
| 2 | 2 | Reserved, `0` |
| 4 | 4 | Reserved, `0` |
| 8 | 8 | Uncompressed section length |
| 16 | 8 | Stored section length |
| 24 | 32 | SHA-256 of the uncompressed section |
| 56 | 8 | Padding, `0` |

Large values move out of the skeleton into sections, replaced by marker
strings:

- `S2B:<type>:<section>:<offset>:<count>` — a packed numeric array. `type` is
  `u8`, `u16`, `u32`, `i32`, `f32` or `f64`, always the smallest exact
  representation; `offset` is bytes and `count` is elements. The offset must
  align to the selected type's width.
- `S2S:<section>:<offset>:<count>` — a base64 string stored as raw bytes.
- `S2D:<section>:<offset>:<count>:<prefix>` — a data URL whose payload is
  stored raw; `prefix` is the literal text before the base64 part.
- `S2E:<rest>` — escapes a literal string that starts with a marker prefix.

Only arrays of 32 or more values where every element is a finite JSON number
are lifted; integers beyond ±2^53 and any mixed, boolean, or object arrays stay
inline so every encoding round-trips exactly. Base64 payloads are lifted only
in `source_base64` and `data_base64` fields, and in `data_url`/`styk_tiles`
data URLs of 64 KiB or more. `source_b64` remains an ordinary opaque field.
Arrays that intentionally share identity use one encoded range; equal but
independent mutable arrays remain independent. Identical binary payloads can
share a range. Packed pose-key sequences preserve their existing sharing
contract, and editable poses are materialized independently when needed.

The compressed file and each binary section cap at 256 MiB; the JSON skeleton
caps at 384 MiB. A 1 GiB admission budget covers reconstructed JSON per marker
occurrence and a separate conservative allocation estimate for restored
numeric arrays and payload strings. Repeated references cannot bypass these
limits. Readers validate marker kinds, ranges, alignment, finite values, reserved
fields, lengths and checksums before restoring values. DEFLATE output is bounded
while inflating; malformed, truncated or trailing compressed streams are rejected.
The Python zstd reader admits declared content sizes and windows before allocating
and checks exact single-frame boundaries, including frames without a content size.
Writers enforce the same admission limits rather than emitting an unreopenable file.
Ordinary writes bound each finite numeric value by 32 JSON bytes during the
existing traversal. If that conservative total exceeds the materialization
limit, the writer measures the document exactly before deciding whether it fits. This avoids decimal formatting for every pose number while
preserving acceptance of valid near-limit files and the separate allocation limit.

Skeletons and sections are written with zstd level 3 (the C library compiled into the app's
WebAssembly module, the optional `zstandard` package in Python, whose writer falls back to zlib
when it is missing). Readers require the codec the file declares.

## Container version 1

All integers are unsigned and little endian. Header size is 56 bytes.

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 4 | ASCII `STYK` (project) or `STKZ` (figure) |
| 4 | 1 | Container version, `1` |
| 5 | 1 | Compression method, `1` = zlib-wrapped DEFLATE |
| 6 | 2 | Reserved flags, `0` |
| 8 | 8 | Uncompressed payload length |
| 16 | 8 | Compressed payload length |
| 24 | 32 | SHA-256 of uncompressed payload |
| 56 | variable | Compressed UTF-8 JSON document |

The writer uses zlib level 3 to balance speed and size. Numeric values are
preserved without lossy quantization. Both compressed and expanded data have a
256 MiB limit. The reader rejects unknown versions, wrong file kinds, invalid
flags, truncation, trailing streams, length mismatches and checksum failures
before accepting the document.

## Both versions

Encoding, compression and parsing stay off the UI thread; snapshots and
desktop file transfers use bounded chunks. Save-side, the export worker builds
`.styk` containers itself from the streamed snapshot, fetching the original
source bytes through `GET /api/source`, and the Rust container writer in its own
instance of the codec module compresses and frames them. Open-side, the import worker
opens all three container kinds the same way; neither side asks the service. The service
retains the same encode/decode rules for external tools, which produce identical bytes.

The reader rejects unknown versions, wrong file kinds, invalid flags,
truncation, trailing data, length mismatches and checksum failures before
accepting the document. Normal scene validation still runs after decompression.

Original JSON `.styk`/`.json` files and the early version-1 wrapper remain
readable. Their next save writes the compressed container. Older releases that
only understand JSON cannot open the new containers, and releases predating
version 2 reject its containers with an unsupported-version error.

Desktop writes retain the existing temporary-file, flush and atomic-rename
implementation: cancellation and incomplete writes preserve the last completed
file. Save targets and the saved revision are committed only after success.
Browsers use an acknowledged File System Access write where available; a
download keeps the project unsaved because its completion cannot be verified.
Autosave/recovery stores the same self-contained native project bytes.

Portable `.stkz` and `.stykmov` exports remove original project archives only
at recognized document boundaries, including nested movieclip documents and
their editable source baselines. Unknown fields, assets, timing and topology
remain intact. The live project and its `.styk` save retain every original archive.

## Verification

- `python -m unittest discover -s backend -p test_native_format.py`
- `python -m unittest discover -s backend -p test_server.py`
- `python -m unittest discover -s backend -p test_legacy_upgrade_export.py`
- `node --test tests/native-figure.test.mjs scripts/file-streams.test.mjs scripts/project-files.test.mjs scripts/recent-files.test.mjs`
- `node tests/native-files.browser.mjs`
- `node tests/document-export-browser.mjs`
- `node scripts/smoke-app-save.mjs`

The app reads and writes containers with `styk-formats` (`styk_formats::files`) in the codec module,
through `src/native-file-codec.mjs` ([engine/formats.md](engine/formats.md)); `native_format.py` is
the reader of the Python codec, kept as the development test oracle.

## Project colors

Project colors are `_styk.palette`, `{version: 1, colors: ['#rrggbb', …]}`
with up to 64 unique colors in the order shown; readers skip malformed
entries, and a project without colors omits the field. Recent colors and
personal palettes are app settings and are never saved in a project.

## Raster drawing metadata

Native projects retain version-1 drawing layer markers and `_styk.drawing`
metadata on PNG image figures. The record distinguishes cel identity, pixel
size, resolution, origin/crop, revision and authored empty carriers. PNG pixels
are lossless; runtime surfaces and worker state are never serialized. PIV/STK
exports materialize compatible visual sprites; their external drawing-layer
editability is not promised. See [the drawing schema](DRAWING.md).
