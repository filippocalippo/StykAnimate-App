# The native app on the web

The design of the web build of the native app (spike S5, 2026-11-07): the investigation's design
(`perf/native/spikes/S5-web-build.md`) revised with every finding of its review, what the spike found before it was stopped,
and the constraints that follow for the code written now.

**Status.** The owner stopped the web build for this phase (decision [N8](decisions/0008-windows-only-review-by-risk.md): Windows
only; the web build is not built, run, measured or packaged). No decision record is written and no web code is kept in the
repository. The design below stays as the starting point of a later port; the constraints section is binding now, because the port
is only cheap if nothing written meanwhile forecloses it. The spike's code (the wasm entry of `styk-app`, the worker pool, the
stage widget, `xtask web-build`, the page and the Playwright checks) is on the local branch `spike/s5-web-code` (head
`8dbd68bf`), unmerged, for whoever resumes it.

Toolkit sources named below are the vendored ones (`vendor/iced`, `vendor/winit`, `vendor/cosmic-text`) and the registry's
`wgpu` 30.0.1. "Unverified" means not checkable from source.

## What the spike established

Built and run once, in a `wasm-dev` build (the iteration profile: nothing below is a measured result, and the machine was loaded by
other jobs), in Chromium (Google Chrome headless, off-screen), served under `web/_headers`:

- `styk-app` (iced with `webgl`, `styk-ui`, `styk-design`, the engine, `styk-render`) **links for `wasm32-unknown-unknown`** with
  the engine module's recipe (`nightly-2026-09-15`, `-Z build-std=std,panic_abort`, atomics, shared memory, 2 GiB maximum) in one
  module, and wasm-bindgen 0.2.129 processes it. iced, winit, wgpu 30, cosmic-text and the engine compile under atomics without a
  patch. The module is 18.3 MB raw in the dev profile (not a size result).
- The page is cross-origin isolated; the window is a canvas; `getContext('webgpu')` was the context created (the WebGPU backend).
  Two engine workers entered the engine loop at start and eight after `grow`; none was lost.
- The font system was built on an engine worker and the interface showed text (Inter) from 368 ms. The sample document
  (`engine/crates/styk-eval/tests/fixtures/document/deep-twenty-four.json`) opened, decoded and prepared two frames on workers
  (open 19-25 ms, decode under 1 ms, frames 5-6 ms), and the stage drew the frame through `styk_render::Renderer` on iced's
  device: the first stage frame came at about 1.1 s from navigation, 0.6 s after the page requested the document.
- A worker-to-main wake (`Atomics.notify` from a worker, an `Atomics.waitAsync` task on the main thread, 200 samples): minimum
  0.16 ms, median 0.27-0.31 ms, p95 0.54-0.61 ms, maximum 1.4-1.7 ms. The interface thread's allocator spin count stayed 0
  across 224 updates, and the page raised no error.

Not run, so nothing is claimed: WebGL2, the pixel comparison with the desktop's frame, text input, composition and clipboard,
playback stress with frame gaps and long tasks, the release size (and the 25 MiB verdict), today's web build as the baseline, the
module without cross-origin isolation, the software stage path, and any browser but Chromium.

## Constraints on the code written now

Each row is a fact the spike found (from source or from the run) and the boundary it puts on the core, the engine,
`styk-services`/`styk-platform` or the GPU setup. N8 already requires the portable shape (every OS call behind `styk-platform`,
nothing in the core or the engine a wasm32 target could not build); these are the specific ways it is tested.

| # | Constraint (fact) | Boundary it puts on today's code |
| --- | --- | --- |
| 1 | The interface thread of a browser cannot block: a contended `Mutex::lock`, `RwLock`, `Condvar::wait`, `thread::sleep`, `JoinHandle::join`, a channel `recv` or `device.poll(wait)` there throws, and with `panic = "abort"` traps the module (`memory.atomic.wait32` is not allowed on a main thread). | Core `dispatch`/`update`/`view` and everything they call use `try_lock` or lock-free reads; no blocking primitive is reachable from them (D7). The engine queries the interface uses are the `try_*` ones. `ExportFrames::ready`, `take` and `take_images` use `Shared::lock`, which spins, and `take` evaluates a frame on the caller, so the native stage reads frames through `Engine::try_request_samples` and `prepared_frame_now_at`. iced's global font system is an `RwLock`: nothing on the interface thread touches it before the `warm_up` proof. |
| 2 | `std::thread::spawn` does not exist on `wasm32-unknown-unknown`. `styk_design::warm_up_after` uses `thread::Builder::spawn` and, when that fails, builds the font system on the interface thread: the freeze it was written to prevent. The engine's own `Engine::work`, `spawn` and `step` are already host-driven. | Portable code starts work only through an injected spawner (`styk-services`: `spawn(job) -> Result`, which can fail and whose worker becomes ready later, asynchronously). `warm_up`, the watchdog thread of `main.rs` and every future `thread::spawn` in the core, `styk-ui`, `styk-design` or the services go through it. Growing the pool is a request, not a synchronous effect. |
| 3 | `std::time::Instant::now` and `SystemTime::now` panic on `wasm32-unknown-unknown`; `thread::sleep` works only on a worker. | No `Instant` or `SystemTime` in the core, the engine or the UI: time comes from an injected clock (the engine already takes a `Clock`; the core's frame scheduler, autosave timers and the automation mode do the same). No sleep on a path the interface can run. |
| 4 | A browser has no synchronous file, directory or process API: IndexedDB, File System Access, `fetch`, the clipboard and dialogs are promise based; there is no `std::env::args`, no `process::exit`, no environment. | `styk-services` traits that touch storage, files, dialogs, clipboard, fonts, encoding or audio are `async` (`impl Future + MaybeSend`), never `fn read(path) -> Vec<u8>`; results return to the core as effects or events. Paths are opaque handles the core does not open itself. Settings that read the environment (`STYK_FONT_WARMUP_DELAY_MS`) treat "absent" as normal. |
| 5 | Workers reach the interface thread only through a shared progress counter and `Atomics.notify`; a winit `EventLoopProxy` send from a worker under atomics is unverified. The measured wake is 0.3 ms median. | The core does not assume a channel send from a worker wakes the event loop. Frame and job results are announced by the engine's `Notifier` and progress counter (`Engine::with_notifier`); the UI turns that into one message. |
| 6 | The address space is 32-bit (`usize` is 32 bits; the shared memory's maximum is 2 GiB, 1 GiB or 512 MiB by what the page can reserve, D14) and an unrefused allocation beyond it aborts. | No `usize`-as-64-bit assumption in the core, the engine or the formats (sizes and offsets of files over 4 GiB are `u64`; `as u32` and `as usize` casts are checked). Budgets come from the host (`styk_alloc::set_limit`, `Budgets::for_device`), never from physical memory read in the core. |
| 7 | Panics abort on the web: no unwinding, and a poisoned lock is never seen. | Recovery, autosave and the "save failed, work kept" paths do not depend on `catch_unwind` or on poisoning to stay correct: a failed job returns an error value. |
| 8 | The Pivot codec is linked into any module that holds the engine: `styk-engine` depends on `styk-piv` unconditionally and calls it from `read_file`, `open_document_owned` and for `source_digest`; a separate codec module needs a seam. | Keep the source facts a byte-preserving save needs in one typed value (`SourceFacts { version, sha256 }` and the document digest, version 3) and keep `describe_source` the only writer of `_stykSource`, so a decoded document can be handed in without the decoder (see "The Pivot codec seam"). Add no callers of `styk_piv` outside `styk-engine`'s open paths and `document_export`. |
| 9 | The renderer is one WGSL pipeline for WebGPU and WebGL2 (D8) with device limits `downlevel_webgl2_defaults().using_resolution(adapter.limits())`: no storage buffers, no compute. iced's wasm compositor creates its instance with `new_instance_with_webgpu_detection` and the same limits plus `max_non_sampler_bindings: 2048`. | New GPU work (effects, drawing, previews) uses only what that limit set offers; a feature needing storage buffers or compute has a fallback pass or is native-only and says so. The shell's instance choice (`styk_render::native_gpu`: DX12 with FXC preferred) lives behind the window and platform layer: the stage, the renderer and `Renderer::new(device, queue, format)` take the device and the surface format they are given and never choose a backend, an adapter or a format. |
| 10 | `styk_render::read_frame` blocks (`device.poll(wait_indefinitely)`) and cannot run on the web; a read-back there is `map_async` with a callback. wgpu objects are not `Send` or `Sync` under atomics, which iced already allows (`MaybeSend`). | Any capture, screenshot or thumbnail read-back that portable code can call has a callback or future form; the blocking one stays in tools and tests. Core state shared across threads holds no wgpu types (draw lists, not GPU objects, cross to workers). |
| 11 | iced's `shader` widget needs the wgpu renderer; its software fallback drops custom shader primitives, so a canvas with no GPU backend would show no stage. | The stage is produced from a draw list through a narrow interface (`styk-draw`, `styk-render`, `styk-raster`), so a CPU-drawn stage widget can replace the GPU one: no stage logic (fit, camera, clipping, picking) lives inside the `shader::Primitive`. |
| 12 | Window input arrives as DOM events: the pinned winit and iced have no system fonts, no accessibility tree, no pen tilt or twist, no IME, no clipboard and no file drop on the web. | Text, clipboard and IME go through `styk-services` and the `InputMethod` and clipboard events the core already handles (S2a), not OS APIs; fonts come from the bundled set and the font service (`styk-platform::fonts` stays behind its trait); pen data are a `styk-core` input type fed by whichever source the platform has (S1). |
| 13 | Cross-origin isolation (COOP and COEP) is required for shared memory; without it the engine cannot run beside the interface, and slicing `Engine::step` on the interface thread does not bound a slice (a step runs a whole closure, decode or frame unit). | The core talks to the engine through narrow queries and plain-data view models cached by revision, never borrowed engine references or an `Arc<Generation>` inside a view model, so a build with the engine in a separate worker behind a message boundary stays possible. |
| 14 | `styk-platform` depends on `icu_collator` and Windows crates, and `styk-app` is a binary whose `main.rs` imports platform window code; a wasm build needs a library entry and the OS code behind `cfg`. | OS crates and `cfg(windows)` stay inside `styk-platform` (N8); `styk-app`'s startup is a library function the binary calls, so another entry can wire the same core; `icu_collator` and its data stay out of the core. |

N8's `cargo check --target wasm32-unknown-unknown` of the core, the engine crates and `styk-services` catches rows 2-4 and 14; the
rest are review rules.

## Position

Today's web build (`src/**`, `index.html`, `web/`, `scripts/build-web.mjs`, `engine/crates/styk-wasm`, the web tests) stays
and keeps working until the native app's web build passes the parity list: every row of "What today's web build does" and of `docs/WEB.md` ported and passing on the same browser matrix. The native web build is
the same `styk-app`, `styk-ui`, `styk-core` and engine, compiled for `wasm32-unknown-unknown`, with the engine's threads
as WebAssembly threads over one shared memory, drawing through iced on WebGPU with WebGL2 as the fallback. Going back to a
web view or to Electron is excluded. The only DOM elements the app owns are the canvas and one text-input element
(below).

Step 8 of the plan (Electron removed, with the JavaScript interface) must be split: today's web build *is* that JavaScript
interface plus the `styk-wasm` binding and `src/engine/*.mjs`. Until the native web build is the production site, step 8
removes `desktop/` and the Electron packaging and keeps the files above, frozen at today's feature set.

## What today's web build does (the contract)

`docs/WEB.md` and `docs/engine/threading.md` hold the detail; what the native web build must keep:

- One module over shared memory: nightly `nightly-2026-09-15`, `-Z build-std=std,panic_abort`,
  `+atomics,+bulk-memory,+mutable-globals,+simd128`, link arguments `--shared-memory --import-memory --max-memory=2147483648
  --export=__wasm_init_tls --export=__tls_size --export=__tls_align --export=__tls_base`, wasm-bindgen 0.2.129 `--target web`
  (`scripts/engine-build.mjs`). Profile `wasm` (fat LTO, one codegen unit, `panic = "abort"`, `strip = false`: D10, symbol names
  survive linking). Profile `wasm-dev` for iteration, never measured.
- Cross-origin isolation (`web/_headers`: COOP `same-origin`, COEP `require-corp`, CORP `same-origin`; CSP `script-src 'self'
  'wasm-unsafe-eval'`, `worker-src 'self' blob:`).
- The page creates the memory (D14): maximum 2 GiB, else 1 GiB, else 512 MiB, starting at the size the module declares for its
  imported memory (`src/engine/engine-memory.mjs`). 1 GiB or less budgets the frame cache like a 2 GiB device.
- Two engine workers at launch, grown to `min(hardwareConcurrency - 1, 8)` when a large file opens, playback prepares for a
  waiting person, or an export starts. Stack 2 MiB. A worker never ends inside the engine (guards in shared memory,
  `engine-guard.mjs`); the interface never blocks (D7): `try_lock` only, waiting is `Atomics.waitAsync` on the engine's
  progress counter, 250 ms ceiling, polling where `waitAsync` is absent.
- One WGSL pipeline for WebGPU and WebGL2 (D8, no storage buffers); device limits
  `Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits())`.
- IndexedDB recovery and library, File System Access with download fallback, WebCodecs exports, service worker and install,
  the unsupported-browser page, a touch tier. The size ceiling is Cloudflare's 25 MiB per file (`scripts/verify-web.mjs`).

## What the pinned toolkit offers (and lacks) on the web

Works at this revision (from source; the spike ran the build, the threads, the stage and the wake, see above):

- `iced_winit` has a wasm path. `run` ends with `event_loop.spawn_app(runner)` and returns, so the page keeps the loop. The
  window is a canvas (`display:block;width:100%;height:100%`) that replaces the element whose id is
  `window::Settings.platform_specific.target` (default `"iced"`) or is appended to `<body>`. The compositor is created with
  `spawn_local`, not `block_on`.
- The executor on wasm is `spawn_local`; `MaybeSend`/`MaybeSync` have no bounds, so non-`Send` wgpu and JS types are accepted.
  iced's `thread-pool` feature (workspace default here) is native only: on wasm the `wasm_bindgen` backend is chosen.
- iced feature `webgl` enables `wgpu/webgl`; `new_instance_with_webgpu_detection` drops BROWSER_WEBGPU when no adapter exists,
  so one module serves both backends. Device limits on wasm are the WebGL2 downlevel set plus `max_non_sampler_bindings: 2048`:
  the same the engine's stage asks for.
- winit's web backend has code for `target_feature = "atomics"`; wgpu handles are not `Send`/`Sync` under atomics (the
  situation of today's `styk-wasm`).
- Pointer events with coalescing and pressure; keyboard from DOM events; `contextmenu` and `prevent_default` configurable.

Gaps (each from source; each is a vendored patch or a `styk-platform::web` module, listed in the parity list):

| Gap | Evidence | Consequence |
| --- | --- | --- |
| Clipboard is a stub (`ClipboardUnavailable`) | `vendor/iced/winit/src/clipboard.rs` wasm branch | No copy or paste in fields. The request path is event based, so an async implementation fits. |
| `set_ime_allowed`, `set_ime_cursor_area`, `set_ime_purpose` are empty | `vendor/winit/src/platform_impl/web/window.rs` | No composition, dead keys, soft keyboard, spellcheck on a bare canvas. A DOM text element is needed. |
| No file-drop events | none in the canvas code | A listener outside winit. |
| Pen tilt and twist not forwarded | web backend | Drawing on the web loses tilt unless patched (S1's requirement). |
| No system fonts or fallback fonts on wasm | `cosmic-text` system font code is `not(wasm32)` | Missing-glyph boxes for scripts not bundled; the app is localised (Arabic included). |
| No accessibility tree | no `accesskit` in iced here | Screen readers, find, translation, tab order. How much today's page promises is a parity question. |
| `std::thread::spawn` unsupported on `wasm32-unknown-unknown` | std | `styk_design::warm_up` already falls back to building the font system on the calling thread when no thread starts: on the web that is the frozen window it was written to avoid. A worker-pool spawner is required. |
| Blocking primitives on the interface thread | `memory.atomic.wait32` is not allowed on a browser's main thread | A contended `Mutex::lock`, `Condvar::wait` or `RwLock` there throws and, with `panic = "abort"`, traps the module. D7 becomes a trap. |

## Design

### Modules

- `styk-services`: every trait that can touch storage, files, dialogs, clipboard, fonts, video or audio is asynchronous
  (`impl Future + MaybeSend`), never blocks, and answers through core effects. A synchronous `read(path) -> Vec<u8>` cannot
  exist on the web (IndexedDB, File System Access and `fetch` are promise based).
- `styk-platform::web` (`#[cfg(target_arch = "wasm32")]`): `boot` (feature detection: the port of `src/web-support.js`,
  isolation check, memory by the D14 ladder, panic hook, clock), `threads` (the worker pool), `wake` (below), `storage`/`recovery`/`library`
  (IndexedDB, the v2 layout, 8 copies and 512 MiB, Web Locks, `storage.persist()`), `files`, `clipboard`, `text_input`, `video`/`audio`
  (WebCodecs, Web Audio behind the S3 and S4 traits), `offline` (service worker, manifest).
- `styk-ui`, `styk-design`: no `cfg(wasm)` in feature code. The web differs in `Settings` (fonts, canvas target) and in services.
- `styk-app`: `[lib] crate-type = ["cdylib", "rlib"]`; `src/web.rs` holds `#[wasm_bindgen] start`. `src/main.rs` stays native.
- `xtask web-build`/`web-serve`/`web-verify`: the recipe above, then wasm-bindgen, then `wasm-opt` if present, then the file
  set, `_headers`, the service-worker file list and the size gate.

### Worker bootstrap (review finding 1)

A worker is a static module script (`worker-src 'self'`, no blob) that **initialises the module before any Rust runs**, with
the synchronous initialiser, as today's `engine-worker.mjs` does:

```js
import {initSync, thread_entry} from './styk_app.js';
self.onmessage = ({data: {module, memory, stack, address}}) => {
  initSync({module, memory, thread_stack_size: stack});   // throws on failure; nothing below runs then
  self.postMessage('ready');                              // acknowledged only after initSync succeeded
  thread_entry(address);                                  // does not return while the thread's closure runs
  self.close();
};
```

`initSync` takes `{module, memory, thread_stack_size}`; the asynchronous default export takes `module_or_path`, so the two are
never mixed. The pool counts a worker as running only on `ready`; an `error` event ends the watch and reports the worker as
lost to the engine (`Engine::note_worker_lost`). Spawning happens only on the main thread. `thread_entry(address)` takes a boxed
closure pointer posted with the message; the closure the engine's workers run is `engine.work()`.

The guard protocol (`engine-guard.mjs`: a worker never ends while inside the engine; claim after 5 s) ports with the same
meaning when workers other than the engine's own exist (exports, previews).

### One focus region for the canvas and the text element (review finding 2)

The winit canvas owns the keyboard listeners; a canvas `blur` emits `Focused(false)`, after which iced disables its input
method. A textarea that takes focus to receive composition would therefore turn the input method off. So:

- The canvas and the text element are **one logical focus region**. Focus moving between them is not a focus loss: the web
  window layer swallows the canvas `blur`/`focus` pair when the other end is the app's own text element, and forwards the
  element's `keydown`/`keyup` (including modifiers) to the canvas listeners.
- **One commit path.** Text enters the field only as `Ime::Commit` (or as winit's `KeyboardInput.text` when no composition is
  active, never both for one keystroke): `compositionstart/update/end` map to `Preedit`/`Commit`; `input` events of a composition
  are ignored; a plain `input` outside composition is a commit; `paste` is a clipboard read answered through the event path.
- Criteria beyond typing and composing: Backspace, arrows, selection, cut, undo, focus switching in both directions, composition
  cancel (Escape) and confirm.

### Threads, the wake and the real synchronisation paths (review finding 6)

Core state stays on the main thread; heavy work is `styk-engine` tasks on the engine's workers, which join the one shared
memory. JavaScript GPU objects cannot cross threads, so the device lives on the main thread and workers produce draw lists in
shared memory, as today. Export and preview workers get devices of their own.

The only bridge from workers to the interface is the engine's progress counter: `Atomics.notify` from the worker that finished
(`notify_progress`), and on the main thread an iced `Subscription`/`Task` over `Atomics.waitAsync(progress, 0, seen, ≤ 250 ms)`
(polling where `waitAsync` is absent) producing `Message::EngineProgress`. Whether a winit `EventLoopProxy` send from a worker
reaches the loop under atomics is unverified, so it is not used.

What D7 means on this build, and how it is checked: replacing JavaScript's `Atomics.wait` proves nothing, because the wasm
instruction `memory.atomic.wait32` and spin loops do not go through it. So the checks are on the real paths, and each says
what it does not show:

- **Mutex, Condvar, RwLock** on the main thread: a contended acquisition throws and traps the module. "No trap over the run" is
  the evidence of "no blocking acquisition observed"; it is not a proof for code paths the run did not take.
- **The allocator** (`styk-alloc`) spins on its own lock on every thread, the main thread included. The lock's slow path counts
  spins per thread (`styk_alloc::lock_spins`); the main thread reads its own count before and after each frame. A run reports
  the main thread's spins during a stress where workers open and decode while iced allocates.
- **Long tasks** (`PerformanceObserver('longtask')`) and the animation-frame gap histogram are recorded beside today's page on the
  same document.
- The claim "the interface never waits for a worker" is the D7 claim and is **not** concluded from the above alone: a later run
  reports what was observed and what was not exercised.

### The module without cross-origin isolation (review finding 3)

A page that is not isolated cannot share memory. Running the engine's work on the interface thread in slices (`pump()` in
today's page) does not bound a slice to a few milliseconds: `Engine::step` runs a whole queued closure, an image decode or a
frame unit, and frame preparation evaluates and encodes with no deadline. So the fallback is **not** `step()` on the main
thread. It is a **separate non-threaded engine module in one dedicated Worker**, behind a message boundary: the interface
thread posts commands and receives draw lists and view models as transferred buffers; the engine's work never runs on the
interface thread. This is the second-module layout (iced on the main thread, core and engine in the worker) that the
isolated build avoids; a later spike measures what `Engine::step` costs per slice on a dense scene on the main
thread to show the unbounded case, and it is not built here.

### The Pivot codec seam (review finding 4)

Building `styk-piv` as a separate module does not remove Pivot code from the app module: `styk-engine` depends on `styk-piv`
unconditionally and its open paths call the decoder (`document.rs`: `read_file`, the owned variant) and the source digest. The
seam, for a build with the codec in its own module:

- `styk-engine` gets a feature `piv` (default on). Without it, `.piv` and `.stk` bytes are refused by `open_document` with
  "needs the codec" and a new entry takes a **decoded document**: `OpenSource::Decoded { document, kind, version, filename, facts }`.
- The facts a byte-preserving save needs travel with the decoded document: `SourceFacts { version: u8, sha256 }` (the file's
  format version byte and the SHA-256 of its bytes), and the document's own digest (`styk_piv::source_digest`, digest version 3),
  which `describe_source` writes into `_stykSource` in the codec's order (`kind`, `version`, `sha256`, `document_sha256`,
  `document_digest_version`). The digest of the document as read must be computed in the codec module, before the engine
  prepares (and so changes) the document; the engine keeps the order of fields and signed zero through the handoff (a JSON round
  trip would turn `-0.0` into `0`).
- Export to Pivot (`document_export`) goes the other way: a request framed as today (`styk_piv::service::FRAMED_EXPORT`).
- Cost: the codec's 0.43 MiB (brotli) load on the first Pivot file, today's 32-bit limits (96 MiB source, 128 MiB document,
  160 MiB cache) and the file under 25 MiB. The alternative, the codec in the one module, costs its bytes in every first load.
  The codec's share of the module (attributed by symbol) decides it; neither is measured or built.

### Stage on every renderer (review finding 5)

The stage is an iced `shader` widget on iced's wgpu device: `styk_render::Renderer` renders into its frame in `prepare` and
draws it into iced's pass in `render`, one device. iced's `shader` widget needs the wgpu primitive renderer; iced's fallback
renderer (tiny-skia, used when no GPU backend exists) **drops custom shader primitives**, so with both WebGPU and WebGL2
unavailable the stage would be blank. The software path:

- A second stage widget in `styk-ui` selected by the compositor in use: the draw list rasterised by `styk-raster` on a worker
  (the CPU renderer already used for exports without a device) into an RGBA buffer, shown as an `image` widget
  (`image::Handle::from_rgba`).
- Bounded uploads: one frame in flight; a frame is replaced, never queued; the buffer is at most the stage's size; a result
  carries the document revision, tick and size it was made for, and a stale result is dropped, never shown.
- Verified by a real stage frame with both GPU backends disabled (WebGPU hidden and WebGL2 context creation refused), compared to
  the CPU rasteriser's native output. This is listed in the parity list and is not part of the first spike's build.

### Text input and clipboard

`Ime` support: iced raises `InputMethod::Enabled { position, purpose, .. }` and calls `set_ime_allowed`. The vendored winit web
`set_ime_*` get an implementation that positions the one text element (a visually hidden `<textarea>`) at the cursor rectangle
and gives it focus as part of the focus region above. If the owner counts that element as a web view there is no alternative:
IME on a bare canvas does not exist in browsers.

Clipboard: the wasm branch of `iced_winit`'s clipboard calls `navigator.clipboard.readText/writeText` through `spawn_local` and
answers through the existing event path, plus the element's `paste/copy/cut` listeners for browsers that need a user gesture.

### Fonts, files, storage, offline

Inter and Inter Tight are bundled (converted to TTF/OTF by N0: cosmic-text does not read WOFF2). Scripts beyond them load Noto
subsets on demand, cached by the service worker, and `queryLocalFonts` where present. Files: `showOpenFilePicker`/`showSaveFilePicker`
with an `<input type=file>` and Blob-download fallback that keeps the project edited and recovery retained. Recovery and the
library keep today's database names and schema so existing users' data survives the switch. The service worker, manifest and
update contract are today's.

### Size

One module holds engine, iced, wgpu, cosmic-text, core and design. The ceiling is 25 MiB per file. Reductions in order, if
needed: `wasm-opt -O3` (binaryen is installed here, not on `PATH`), `opt-level = "z"` for `styk-ui`/`styk-design`/iced, fonts and
`styk-piv` as separate files or modules, exports in a module of their own (they are separate workers already), a bucket with a
higher limit (infrastructure: the owner's call).

## The measurements the spike planned (not run, except what is listed above)

Planned: same machine, Chromium from the repository's `node_modules` (Playwright), off-screen, served by a local static server that
applies `web/_headers`. Today's whole web build is **remeasured as the baseline under the same delivery conditions** (the
documented 5.5 MiB / 3.25 s predate the engine module and are not used).

| Id | Measure |
| --- | --- |
| M1 | Module bytes raw / brotli / gzip, with `wasm-opt`; the share of `styk-piv`, iced, wgpu and the rest by symbol; 25 MiB verdict; today's engine, codec and drawing modules and the whole first load beside it |
| M2 | Time from navigation start to the first presented stage frame (cold, warm cache); today's page to its first frame |
| M3 | Worker-to-main wake latency under atomics (a worker notifies, the main thread's `waitAsync` Task runs); long tasks and frame gaps during a dense-scene run; main-thread allocator spins; `Engine::step` slice lengths |
| M4 | Stage frame on WebGPU and on WebGL2 against the desktop's frame of the same document, tick, size and view: differing pixel counts by magnitude (exact, 1, 2–4, over 4 levels), maximum difference, PSNR. The desktop frame is `styk render` (native `styk_render`, same draw list). `prim.wgsl` carries chunk FP's clip-position fix (divide before doubling), without which the backends disagree on thin triangles |
| M5 | Text input in a field: `héllo wörld`, composition `にほんご`, paste and copy (clipboard), Backspace, selection, focus round trips |
| M6 | The memory the page holds after the first frame, against today's page |

D13: no threshold is tuned. M4 reports counts, and states which differences are explained and which are not.

## Fallbacks that stay native

| If | Fallback | Cost |
| --- | --- | --- |
| iced/winit/wgpu do not build or run under atomics | Two modules: `styk-ui` (iced, non-threaded) on the main thread; `styk-core` and the engine in a threaded module; a typed command/view-model protocol between them | Largest. The core stops calling `styk-edit` directly on the web; one hop per command. |
| Waking the main thread needs more than `waitAsync` | A `MessageChannel` ping per batch from a small notifier worker | Small. |
| Module over 25 MiB | The reductions above | Moderate. |
| No WebGPU and no WebGL2 | iced `tiny-skia` plus the software stage | A visible compatibility tier. |
| Fonts too heavy | Per-language subsets on demand | A font pipeline in `xtask`. |
| A parity item cannot be reached (accessibility, page translation) | Ship the native web build as a documented subset at its own URL; today's stays | Two web builds in maintenance. |

## Work split for a later port

Each chunk is ownable on its own (no estimates: the spike stopped before the parity list was costed). W1 toolchain (`xtask web-*`, CI gate), W2 boot and
threads (`web::boot`, `threads`, `wake`, the isolated-or-not decision and the non-isolated worker module), W3 vendored
patches (clipboard, text element and focus region, drop, tilt, context menu), W4 fonts and text, W5 storage services, W6 files
and exports (and the Pivot codec seam), W7 offline/install/updates, W8 size and performance, W9 touch and phones, W10 cutover
(native web behind a flag, then default, today's build kept one release, then retired).
