# StykAnimate native engine (experiment)

A prototype of the architecture a native (and mobile) StykAnimate would use: the
animation engine in Rust, GPU vector rendering through wgpu, and a thin UI shell.
It opens `.piv` (Pivot 4 and 5) and `.styk` projects, plays them, zooms and pans
around the pointer, and poses figures with Pivot handles, with undo.

It is **not** a port of the app. It exists to measure how much faster the same
documents get with this architecture. The file formats are read with exact
editor semantics where it mattered for the comparison (see *Fidelity* below).

## Run

```sh
cd experiments/styk-native
cargo run --release -p styk-app -- "$HOME/Downloads/TDD2 URIEL NEMESIS 3.styk"
```

The left panel lists the `.piv`/`.styk` files in `~/Downloads`,
`~/Downloads/pivs` and `~/Downloads/WafflesPack`; you can also drop a file on the
window or press Ctrl+O.

| Input | Action |
| --- | --- |
| Space | Play / pause |
| Left / Right, Home / End | Step one tick, first / last tick |
| `,` / `.` | Previous / next key |
| Wheel, pinch | Zoom around the pointer |
| Middle or right drag, Shift+wheel | Pan |
| F, 0 | Fit, 100% |
| Drag a handle (at a key) | Rotate the segment; Ctrl-drag stretches; the orange origin moves the figure |
| Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z | Undo, redo |

Handles appear when paused. Poses are edited where the editor stores them: a
keyframe for native timelines, a pose source for layer sheets. So posing needs a
key tick (the transport says so).

Command-line tools (`cargo run --release -p styk-cli -- …`, binary `styk`):

```sh
styk info <file>                         # open time, contents, unported features
styk bench <file>                        # evaluation + geometry throughput
styk compare <file> <reference.json>     # primitive-by-primitive parity with the JS editor
styk render <file> <tick> <out.png>      # headless GPU render
styk gpubench <file> <tick>              # GPU time per frame across a fit→11× zoom
styk diff <a.png> <b.png> <out.png>      # pixel comparison
```

`styk-native <file> --bench --exit [--tick N]` runs the scripted measurements:
1. one full playback pass;
2. zoom fit→11×→fit over 4 s;
3. pan at 8× for 3 s;
4. zoom while playing;
5. continuous posing of one limb for 3 s.

Each prints a JSON `BENCH` line. `STYK_SLOWDOWN=N` repeats every frame's
preparation N times (a crude stand-in for an N× slower CPU).

`tools/` drives the current app for comparison:
- `reference.mjs` dumps the editor's geometry.
- `decode-piv.sh` decodes a `.piv` with the repo's Python codec, for `reference.mjs`.
- `reference-render.mjs` renders reference frames with the app's renderer through Playwright.
- `current-app-gestures.mjs` measures playback, zoom and pan in the Electron app; `STYK_RENDERER=canvas` and `STYK_CPU_THROTTLE=4` are optional.

## Architecture

```
styk-core    file formats → typed document → evaluation → geometry → GPU draw list   (no UI, no GPU)
styk-render  wgpu renderer for draw lists (Vulkan / Metal / DX12 / WebGPU)
styk-app     desktop shell (egui): playback scheduling, input, handles, posing
styk-cli     headless tools and measurements
```

**Document and editing.**
- The document is immutable `Arc`s. An edit replaces one object record through
  copy-on-write and publishes a new revision.
- Workers that are still evaluating the previous revision keep a valid snapshot,
  and their stale results are dropped by revision number.
- There is no full-document cloning or serialization on the interactive path.

**Evaluation.**
- Pivot's monotone-cubic tweening only needs the four keys around an interval, so
  each channel costs O(1) whatever the run length.
- Joined figures build level by level in parallel.
- Movieclip sources are prepared once and their scenes cached per local time.

**Draw lists are view independent.**
- Each primitive is one 64-byte record in world units: an exact signed-distance
  capsule, circular arc, polyline, disc or ring, or a triangle for fills and glyphs.
- Pan and zoom rewrite one 96-byte uniform: nothing is re-rasterized, re-encoded
  or re-uploaded, and edges stay exact at any zoom.
- This removes the whole class of problems the current renderer handles with
  stand-ins, crop caches, density buckets and settle repaints.

**Isolation without per-figure passes.**
- A translucent figure (or outline, or movieclip) is drawn into an atlas and
  composited once, like Pivot's layer.
- Every group of one nesting depth renders in one pass (ping-ponging two atlases),
  so a frame with 38 translucent figures still takes 3 passes.

**Playback.**
- A pool of background threads (at lower OS priority) prepares draw lists ahead of
  the playhead into a byte-bounded cache.
- The UI thread only uploads a ready list (tens to hundreds of KB) and draws.

**Portability.**
- `styk-core` has no platform dependencies, and wgpu runs on iOS and Android.
- A mobile app is a new shell over the same two crates, with native UI through
  SwiftUI/Compose, or egui/winit for a first build.

## Measurements

Machine: Ryzen 5 5500 (6 cores / 12 threads), RTX 4070 SUPER, Linux/Wayland at
144 Hz, 1440×900 window. **All runs, for both apps, happened while an unrelated
ffmpeg encode used about 800% CPU (load average ~15).** The occasional skipped
vsync on either side is that contention, and numbers vary by ±20% between runs.

The current app is the Electron desktop build on its WebGPU renderer unless
marked Canvas 2D, which is the path browsers without WebGPU use (most phones
today).
- Playback was measured with `scripts/benchmark-project-playback.mjs` for the
  first URIEL 3 row and with `tools/current-app-gestures.mjs` otherwise.
- Zoom and pan are real Ctrl+wheel and wheel input. The app's zoom glide reached
  about 6× of the 11× the native run covers.
- Frame intervals are requestAnimationFrame gaps in the current app and frame
  cadence in the native app.

### TDD2 URIEL NEMESIS 3.styk (12 MB, 481 figures, layer sheet, 33 fps, 232 frames)

| | Current app | Native |
| --- | --- | --- |
| Open | 2.5–5.5 s | 0.85 s (1.7 s under the load above) |
| Per-frame preparation | p50 10.8 ms, p95 127 ms, max 266 ms (workers) | avg 0.6–1.4 ms, worst 8.8 ms |
| Playback, gaps (target 30.3 ms) | p95 54 ms, p99 89 ms, max 98 ms | p95 35–37 ms, max 36–49 ms, all frames on time |
| Zoom | WebGPU: 144 fps. Canvas 2D: p95 28 ms, max 56 ms | p50 7.0 ms (144 fps), p95 9–14 ms |
| Pan | WebGPU: max 14–56 ms. Canvas 2D: p95 28 ms, max 97 ms, 32 long tasks up to 105 ms | p50 7.0 ms, p95 14 ms |
| 4× slower CPU, playback | WebGPU: 12.6 s for the 7.0 s animation, a 2.8 s stall, 29 long tasks up to 196 ms. Canvas 2D: 13.6 s, a 3.8 s stall | 7.0 s, on time, max gap 45 ms |

### svr_uriel.piv (21 MB, 433 figures / 51.7k segments, 21 fps, 594 frames)

| | Current app | Native |
| --- | --- | --- |
| Open | 17–35 s | 0.18 s |
| Memory (resident, whole process tree) | 2.7–3.0 GB | 0.65 GB with every frame prepared and cached |
| Playback, gaps (target 47.6 ms) | WebGPU: p99 97 ms, max 174 ms. Canvas 2D: p99 306 ms, max 778 ms | p95 55 ms, p99 59 ms, max 72 ms |
| 4× slower CPU, playback | WebGPU: p99 153 ms, max 479 ms. Canvas 2D: p99 111 ms, max 195 ms | p99 61 ms, max 84 ms |
| Zoom | WebGPU: max 21 ms. Canvas 2D: p95 90 ms, max 188–257 ms, 300+ long tasks of ~80 ms | p50 7.2 ms, p95 14 ms, max 21 ms |
| Pan | WebGPU: max 35 ms. Canvas 2D: p95 83 ms, max 125–160 ms | p95 15 ms, max 22 ms |
| Posing a limb (edit → new frame) | — | p50 1.5 ms, p95 6.6 ms |

### Engine only (one core, Node vs Rust, same machine)

Evaluation and geometry per frame, from `tools/reference.mjs` against `styk bench`:

| File | JS editor | Rust (1 thread) | Rust (12 threads, throughput) |
| --- | --- | --- | --- |
| Jay on a new app (Stick Nodes, movieclip) | 29.8 ms | 1.6 ms | 0.68 ms |
| tdd2 uriel nemesis 2.piv | 6.2 ms | 0.71 ms | 0.13 ms |
| hitoshi vs suzu tomiee ssj.piv | 3.6 ms | 0.27 ms | 0.07 ms |
| TDD2 URIEL NEMESIS 3.styk | 3.0 ms | 0.3 ms | — |

The GPU side costs 0.3–0.4 ms per frame for these scenes at any zoom
(`styk gpubench`).

**What this means for phones.**
- A phone CPU core is roughly 3–5× slower than this desktop core.
- The current app's worst frame preparations (127–266 ms here) become
  0.5–1 s stalls there.
- The native engine's worst case (9 ms, 25 ms on svr_uriel) stays inside one
  frame, its typical cost is under 2 ms, and it uses about a quarter of the memory.
- Zoom and pan cost the same at every zoom level, because nothing is re-rasterized.

## Fidelity

`styk compare` checks every primitive (type, colour, opacity, z, endpoints, points)
against the JavaScript editor's own `buildGeometry`:
- every supplied `.piv`, Pivot 4 and 5, matches exactly: 770k primitives over 528 sampled frames;
- *Jay on a new app (repaired)* matches exactly on all 26 frames;
- *TDD2 URIEL NEMESIS 3* matches on 21 of 24 sampled frames.

Rendered frames differ from the app's renderer only at anti-aliased edges (for
example a mean 0.33/255 on *Valthim - Yuki*).

Not ported, so missing from renders. The files still open and play:
- visual effects (blur, glow, bloom, tint, RGB split, shadow, explosions);
- IK limbs (pinned IK falls back to the authored pose);
- 3D meshes and depth-tested surfaces (*Pistol-3D*);
- text outlines;
- follow-camera clips;
- animation channels.

Also: *Jay on a new app.styk* (unrepaired) has a pose that does not match its
figure. The current editor rejects it; the engine opens it leniently.

## Not done here

- No saving: posing edits live in memory only.
- No timeline editing, onion skins, audio, export, drawing tools or layer UI.
- Not measured on a phone. The numbers above are desktop measurements with CPU
  slowdowns as a proxy; GPU behaviour on mobile chips is not established.
