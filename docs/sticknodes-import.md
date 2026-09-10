# Stick Nodes import in StykAnimate

Implemented and verified on 10 September 2026. The importer converts supported
Stick Nodes assets into editable native StykAnimate documents and movie clips.
It does not promise identical output from every Stick Nodes version or reproduce
all of the original application's procedural behavior.

## Opening files

Use Open, drag a file onto the workspace, or use the desktop Open dialog.

| File | Result |
| --- | --- |
| `.nodes` | Inserts an editable figure into the current scene. |
| `.nodemc` | Inserts one native movie-clip container with a shared editable timeline. |
| `.stknds` | Opens a complete project, including its figure library, movie clips, stored poses, sprites, text, backgrounds and camera keys. |
| `.zip` | Lists supported assets in the archive; selecting an entry imports it using the same path. |

Select a clip and use **Edit movieclip** to edit its contents. **Done** returns to
the parent scene. Clip instances use the existing StykAnimate playback engine,
including independent source FPS, saved frame offsets, single-frame, hold and
loop playback. Editing a definition updates its instances; the importer does not
expand every instance into a separate copy of its animation.

Save projects as `.styk`, reusable figures as `.stkz`, and movie clips as
`.stykmov` (the existing `.stkz` container also retains clips). These formats
preserve import metadata and shape extensions. Importing never overwrites the
source Stick Nodes file. PIV/STK export rejects imported shape/sprite extensions
that those formats cannot represent, instead of silently changing their artwork.
The extensions render through the shared GPU, Canvas and SVG geometry path.

## Supported layouts and differences

The inspected full-project loader covers version/build **431/117**, and
additional real-corpus profiles for figures and movie clips extend through
**434/121**. These are evidence boundaries, not import cutoffs.

**Untested versions and profile combinations are attempted automatically**, using
the existing version-based field rules. Future files that retain the known
structure can therefore import, including raw/compressed figures, movie clips,
full projects, ZIP entries and independently versioned embedded figures. The
original version/build and source SHA-256 remain intact. Import notes identify
best-effort decoding, and `_styk.sticknodes.layoutGuesses` records each untested
profile and the assumption used. Inserted assets preserve these notes too.

An unfamiliar version number alone does not reject a file. The attempt can still
fail if its records no longer fit the reader: exact end-of-file consumption,
valid references, finite numbers, checksums and resource budgets are still
required. Even a structurally valid guess may have different visual or behavioral
semantics, so review the imported result. This is not universal compatibility.

Stored figure geometry, per-pose styles, ordering, sprites, delays, available
tween settings, source FPS and clip cursors are converted. Source IDs become
native editable handles. Basic movement, pose edits, duplication, deletion,
Set Origin, undo/redo and editing inside clips use native editor operations.
Custom shape metadata follows physical handles when topology changes.

Import notes explicitly identify remaining differences:

- Smart stretch, floaty motion, locks/connectors and other native solvers retain
  their stored poses; their procedural dynamics are not recreated.
- Blur, glow, motion blur, pixelation and other effects can differ. Source effect
  settings are recorded for future support.
- Sprite corner distortion is retained as metadata; rendering uses the affine
  sprite transform, including separate X/Y scale, flips and pivot.
- Text is editable using bundled Noto Sans outlines. Font metrics may differ;
  missing glyphs use `?`, with original text retained in metadata.
- Audio names are preserved as external references. Audio files are not supplied
  by the project container and must be added separately.
- Camera wobble/tracking and repeat-loop control flow are not simulated.
- Attachments with matching joint positions become native joins. Offset joins
  retain stored poses and source join metadata, with a note to reattach them for
  new authored attachment motion.
- Embedded legacy bitmap backgrounds are retained. Native background fitting
  can differ from the original fit settings, which remain in metadata.

The converted document carries source profile, filename, SHA-256, project
settings and warnings under `_styk.sticknodes`. Inserted standalone assets carry
the same provenance under `_styk.sticknodesImport`. Keep the original source
file when exact native behavior or future reconversion matters.

## Integration and resource behavior

`src/import-worker.mjs` routes the four extensions into
`src/sticknodes/adapter.mjs`. It uses the existing ImportClient request protocol,
progress reporting, cancellation and acknowledged document chunks. Decoding
runs in a worker; definitions, PNG assets and clip timelines are shared. Shape
metadata contains active fields only, and per-pose overrides are sparse.

The adapter returns the existing `{kind, document, warnings, timings}` contract:
`stkz` for figure insertion, `stykmov` for movie-clip insertion, `styk` for project loading, and
`sticknodes-archive` for archive selection. Native file dialogs, drag/drop,
desktop file opening, recent files and packaged extension associations are wired.
Packaged resources already include `src/**/*`, so no new runtime dependency or
network service is required for Stick Nodes decoding.

Decoder limits include 256 MiB project input, 512 MiB expanded project payload,
20,000 assets, 100,000 frames, one million instances, five million poses and
64 million pixels per image. ZIPs have a separate 64 MiB expanded budget.
The application file-open boundary additionally limits non-native files to
128 MiB. These are rejection ceilings, not a promise that documents near the limits fit
comfortably in memory. Native editor validation imposes additional constraints.
Very large imports and native save/reopen still take time and substantial memory.
`timings.document_bytes` is a transport-size estimate, not a measured JSON size.

## Verification evidence

The initial integration regression suite passed **1,256/1,256 tests**, including
11 new integration tests. The syntax check passed for all 576 JavaScript files.

The private corpus audit converted **626/626 real files**: 547 figures, 74 movie
clips and 5 full projects. Every result passed recursive native document
validation and geometry checks for all root and direct clip keys. An independent
source-layout comparison checked **259,624 joints**, with a maximum discrepancy
of **0.006736 pixels**. This is geometry evidence, not a native pixel-perfect
render comparison or a guarantee for unseen files.

Browser checks invoked the production file-import API with real File objects,
used the actual import/export workers and native backend codec, and verified
figure edits, undo/redo, clip editing, timeline playback, ZIP entry selection,
SVG export, `.styk` save/reopen and imported clip `.stykmov` export/reopen. The full-project screenshot and clip controls
were inspected. The operating-system file picker and a freshly packaged Electron
installer were not exercised in this run; their filters and dispatch paths were
checked in code and relevant existing tests.

The largest tested project opened with **1,503 native definitions, including 116
movie clips**, and saved/reopened as a **35,166,594-byte `.styk`** with all those
definitions and clips retained. Imports measured approximately 30–48 seconds
in earlier browser runs; one run overlapped the corpus audit. The sparse metadata
optimization reduced transport from 1,176 to 701 chunks. This is a reduction in
transferred document data, not a controlled claim about overall import speed.
The final optimized run without a concurrent test suite took **39.36 seconds**
(33.83 seconds decoding and 2.32 seconds chunk transfer; 705 chunks). A 50 ms
browser timer continued throughout, with a maximum observed delay of 427 ms.
This is a single-machine responsiveness observation, not a frame-rate guarantee.

Reproducible integration checks ship in `tests/sticknodes-import.test.mjs` and
`tests/sticknodes-synthetic.json`. They cover conversion, rejection/cancellation,
transport, native normalization, clips, sprites/text, shape rendering, SVG,
topology edits and legacy backgrounds. The synthetic fixtures exercise format
branches and do not replace real-file evidence.

The best-effort extension adds tests for unfamiliar version/build headers in raw
and compressed figures, full projects and movie clips, plus unknown embedded
figure versions inside known projects. Those tests check retained provenance and
unchanged geometry for compatible bodies, and rejection of genuinely malformed
counts, references, node types, truncated data and unexplained trailing bytes.
The future-version cases are synthetic relabelings, not native future exports.
After this change, all **1,262 application tests** passed, including the 15
integration tests, and the **626-file real corpus** passed the conversion and
geometry audit again with the same maximum joint discrepancy.

Run from this application directory:

```powershell
node --test tests/sticknodes-import.test.mjs tests/movieclips.test.mjs tests/editor-style-topology.test.mjs
node --test tests/*.test.mjs
node scripts/check.mjs
```

The private corpus audit and browser harnesses remain in the separate
`sticknodes-project-lab` workspace. Original application binaries, decompiled
sources and downloaded creative assets are not shipped in this integration.
The decoder's upstream MIT notices are in
`src/sticknodes/decoder/THIRD_PARTY_NOTICES.md`.
