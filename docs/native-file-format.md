# StykAnimate native files

Save and Save As write `.styk` projects. File → Save figure, or Export →
Editable file → StykAnimate figure, writes a `.stkz` of the selected figure at
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
preserved without lossy quantization. Encoding, compression and parsing stay
off the UI thread; snapshots and desktop file transfers use bounded chunks.
Both compressed and expanded data have a 256 MiB limit. The reader rejects
unknown versions, wrong file kinds, invalid flags, truncation, trailing streams,
length mismatches and checksum failures before accepting the document.
Normal scene validation still runs after decompression.

Original JSON `.styk`/`.json` files and the early version-1 wrapper remain
readable. Their next save writes the compressed container. Older releases that
only understand JSON cannot open the new containers.

Desktop writes retain the existing temporary-file, flush and atomic-rename
implementation: cancellation and incomplete writes preserve the last completed
file. Save targets and the saved revision are committed only after success.
Browsers continue to use downloads; autosave/recovery stores the same native
project bytes.

## Verification

- `python -m unittest discover -s backend -p test_native_format.py`
- `python -m unittest discover -s backend -p test_server.py`
- `python -m unittest discover -s backend -p test_legacy_upgrade_export.py`
- `node --test tests/native-figure.test.mjs scripts/file-streams.test.mjs scripts/project-files.test.mjs scripts/recent-files.test.mjs`
- `node tests/native-files.browser.mjs`
- `node tests/document-export-browser.mjs`
- `node scripts/smoke-app-save.mjs`

The package build tracks `native_format.py` alongside the codec's other runtime
sources, so an old sidecar must be rebuilt before packaging the new formats.
