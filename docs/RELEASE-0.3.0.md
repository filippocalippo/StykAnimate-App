# StykAnimate 0.3.0

Windows x64 release, September 9, 2026. The project remains StykAnimate-webapp;
the desktop executable is named StykAnimate.

## Workspace and animation

- Figma-inspired light workspace with compact icons, distinct panel hierarchy,
  contextual properties, and movable, resizable, floating and docked panels.
- Custom WebGPU canvas with retained GPU resources, pooled geometry, texture
  atlases, worker preparation and incremental playback updates.
- Pivot-style node colors and joined-handle routing, pose-local Handle Edit,
  whole-figure modifier transforms, neighbor locating, nudging and alignment.
- Advanced timeline with user layers, fixed Scene and Camera tracks, pose and
  scalar keys, curves, key navigation and numeric property scrubbing.
- Simple Pivot filmstrip with thumbnails, green inbetween controls and distinct
  stored frames versus Add/Update working poses. Switching timeline modes
  preserves saved and working poses.
- Persistent settings, timeline choice, shortcuts, localization and panel layout.

## Authoring and interchange

- Real PIV v2–v5 and STK import through the supplied codec tools; native save and
  editable STYK persistence, with a frozen Python/orjson codec and C++ scanner.
- Rig origin changes, branch duplication and mirroring, static/style controls,
  segment splitting and polygon ordering preserve native identities and poses.
- Sprite placement on a chosen figure handle; polygon construction with path
  selection, curved previews and local draft undo; portable text outlines/fonts.
- Background library and gradients, joint values and range operations.
- Asynchronous cross-document frame clipboard with cancellation, serialized
  Copy/Paste actions, transferable packets, sparse history and legacy conversion.
- Worker exports for image/animation formats and native video, including VP9
  alpha and installed Windows VFW codec helpers for both architectures.
- Native Save/Save As, recovery, recent files and save/cancel-on-close handling.

## Verification and measured limits

The source regression suite passed 930 tests and the syntax check passed 438
JavaScript files. Focused actual-app checks cover authoring, clipboard, exports,
attachments and native interchange. Release verification records live packaged
WebGPU startup, native imports/save, close behavior, restart-persistent settings,
and a 32-check workspace/timeline walkthrough. See the corresponding reports in
`artifacts/`; `release/0.3.0/verified-release.json` identifies the final binaries.

The final workspace walkthrough exposed and fixed a two-pixel compact title-bar
overflow. Docked controls are checked at the supported 1000px desktop minimum;
floating panel reachability is additionally stressed at 900px.

On the tested Ryzen 5500 / RTX 4070 SUPER machine, Akane diagnostics recorded
about 2.22s cold / 1.64s cached to the first fully prepared GPU callback. These
are diagnostic callbacks, not a final matched native presentation benchmark.
Actual UI clipboard checks measured approximately 86ms Copy / 89ms Paste for
the small default scene and 1.31s for a 64-frame Akane paste. Full 1479-frame
Akane paste still takes roughly 9 seconds, with substantial memory use and
measured scheduling gaps. Universal zero lag and native performance superiority
are not claimed; the final complete matched playback benchmark remains open.

Windows execution is verified. macOS/Linux build targets are configured but
have not been built and executed here. Complete corpus-wide Pivot equivalence
also remains unsigned; consult [the acceptance ledger](GOAL-ACCEPTANCE.md) and
[compatibility contract](PIVOT_PARITY.md) for the precise remaining coverage.
