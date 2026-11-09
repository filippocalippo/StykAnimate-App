# Tauri port: the decision and the inventory

**Decision (owner, 2026-11-09 evening).** StykAnimate ships on **Tauri 2** with today's web interface and the Rust
engine as it runs today (threaded WebAssembly in the webview). Electron goes. The native iced interface on `native-app`
is paused and kept; its engine-crate fixes are carried here. Brief: `perf/tauri-prompt.md` (outside the repository).
Deadline: 2026-11-10 about 14:00 local, at full parity; docking and developer tools in parallel; the performance audit
right after the port merges.

**Why Tauri, and where it lives.** Tauri 2 keeps today's interface byte for byte (the same pages, CSS and engine
binding), so parity is the interface we already ship rather than a rebuild; WebView2 is the system Chromium, so the
installer and memory drop the bundled Chromium and Node; the backend is Rust beside the engine crates, so file, export
and library services can share code with the engine. The app crate is `engine/crates/styk-desktop`, a member of the
engine workspace (one lockfile, one target folder, the existing queue and checks).

**The renderer keeps its API.** `desktop/preload.cjs` becomes one small bridge module that implements the same names
with Tauri `invoke` and events; Tauri capabilities allow exactly these commands. The pages stay cross-origin isolated
(COOP `same-origin`, COEP `require-corp`, CORP `same-origin`), checked at start with `crossOriginIsolated === true`
and WebGPU; the engine's no-worker fallback never ships.

**Areas** (one Opus owner each, logic and interface together): 0 engine carry-over from `native-app`; 1 shell,
packaging and updater (the crate, the bridge, the web host, window, single instance, associations, protocol, NSIS,
updater); 2 files, library, recovery and user-data migration; 3 export, audio, fonts, localization and the remaining
services; 4 docking; 5 developer tools.

## The 86 IPC channels in `desktop/main.cjs` (85 invoke, 1 send), by area

| # | Channel | main.cjs line | Kind | Area |
|---|---|---|---|---|
| 1 | `styk:update-state` | 281 | invoke | 1 shell |
| 2 | `styk:update-check` | 282 | invoke | 1 shell |
| 3 | `styk:update-releases` | 283 | invoke | 1 shell |
| 4 | `styk:donate` | 284 | invoke | 1 shell |
| 5 | `styk:release-history` | 285 | invoke | 1 shell |
| 6 | `styk:release-info` | 286 | invoke | 1 shell |
| 7 | `styk:update-restart` | 292 | invoke | 1 shell |
| 8 | `styk:support-context` | 316 | invoke | 3 services |
| 9 | `styk:support-live` | 317 | invoke | 3 services |
| 10 | `styk:support-live-close` | 318 | invoke | 3 services |
| 11 | `styk:support-save-state` | 320 | invoke | 3 services |
| 12 | `styk:support-request` | 321 | invoke | 3 services |
| 13 | `styk:support-copy-access` | 322 | invoke | 3 services |
| 14 | `styk:support-restore` | 323 | invoke | 3 services |
| 15 | `styk:support-download` | 324 | invoke | 3 services |
| 16 | `styk:telemetry-state` | 335 | invoke | 3 services |
| 17 | `styk:telemetry-consent` | 336 | invoke | 3 services |
| 18 | `styk:telemetry-record` | 337 | invoke | 3 services |
| 19 | `styk:telemetry-preview` | 338 | invoke | 3 services |
| 20 | `styk:telemetry-sync` | 339 | invoke | 3 services |
| 21 | `styk:telemetry-delete` | 340 | invoke | 3 services |
| 22 | `styk:telemetry-feedback` | 341 | invoke | 3 services |
| 23 | `styk:telemetry-export` | 342 | invoke | 3 services |
| 24 | `styk:service-page` | 347 | invoke | 3 services |
| 25 | `styk:performance-trace` | 353 | invoke | 3 services |
| 26 | `styk:library-reveal` | 369 | invoke | 2 files |
| 27 | `styk:library-trash` | 370 | invoke | 2 files |
| 28 | `styk:library-thumbnail-cache` | 371 | invoke | 2 files |
| 29 | `styk:public-library-list` | 376 | invoke | 3 services |
| 30 | `styk:public-library-preview` | 377 | invoke | 3 services |
| 31 | `styk:public-library-read` | 378 | invoke | 3 services |
| 32 | `styk:public-library-save` | 382 | invoke | 3 services |
| 33 | `styk:public-library-page` | 388 | invoke | 3 services |
| 34 | `styk:page-listening` | 390 | invoke | 1 shell |
| 35 | `styk:public-library-link` | 391 | invoke | 3 services |
| 36 | `styk:recent-list` | 393 | invoke | 2 files |
| 37 | `styk:recent-open` | 394 | invoke | 2 files |
| 38 | `styk:recent-clear` | 395 | invoke | 2 files |
| 39 | `styk:projects-list` | 398 | invoke | 2 files |
| 40 | `styk:projects-open` | 399 | invoke | 2 files |
| 41 | `styk:projects-update` | 400 | invoke | 2 files |
| 42 | `styk:projects-remove` | 401 | invoke | 2 files |
| 43 | `styk:projects-reveal` | 402 | invoke | 2 files |
| 44 | `styk:projects-preview` | 403 | invoke | 2 files |
| 45 | `styk:projects-preview-set` | 405 | invoke | 2 files |
| 46 | `styk:projects-folder` | 410 | invoke | 2 files |
| 47 | `styk:clipboard-text-read` | 417 | invoke | 3 services |
| 48 | `styk:clipboard-text-write` | 422 | invoke | 3 services |
| 49 | `styk:video-save` | 436 | invoke | 3 services |
| 50 | `styk:vfw-save` | 452 | invoke | 3 services |
| 51 | `styk:vfw-configure` | 462 | invoke | 3 services |
| 52 | `styk:new-window` | 474 | invoke | 1 shell |
| 53 | `styk:fonts-list` | 487 | invoke | 3 services |
| 54 | `styk:fonts-read` | 488 | invoke | 3 services |
| 55 | `styk:workspace-preferences-get` | 492 | invoke | 2 files |
| 56 | `styk:workspace-preferences-set` | 493 | invoke | 2 files |
| 57 | `styk:editor-settings-get` | 494 | invoke | 2 files |
| 58 | `styk:editor-settings-set` | 495 | invoke | 2 files |
| 59 | `styk:vfx-presets-get` | 501 | invoke | 2 files |
| 60 | `styk:vfx-presets-set` | 502 | invoke | 2 files |
| 61 | `styk:document-activate` | 520 | invoke | 2 files |
| 62 | `styk:document-select` | 527 | invoke | 2 files |
| 63 | `styk:document-release` | 533 | invoke | 2 files |
| 64 | `styk:project-write-begin` | 534 | invoke | 2 files |
| 65 | `styk:file-write-begin` | 585 | invoke | 2 files |
| 66 | `styk:recovery-write-begin` | 600 | invoke | 2 files |
| 67 | `styk:file-write-chunk` | 616 | invoke | 2 files |
| 68 | `styk:file-write-patch` | 617 | invoke | 2 files |
| 69 | `styk:file-write-finish` | 618 | invoke | 2 files |
| 70 | `styk:file-write-cancel` | 628 | invoke | 2 files |
| 71 | `styk:recovery-info` | 637 | invoke | 2 files |
| 72 | `styk:recovery-list` | 645 | invoke | 2 files |
| 73 | `styk:recovery-read-begin` | 650 | invoke | 2 files |
| 74 | `styk:file-read-chunk` | 657 | invoke | 2 files |
| 75 | `styk:file-read-close` | 658 | invoke | 2 files |
| 76 | `styk:recovery-save` | 659 | invoke | 2 files |
| 77 | `styk:recovery-get` | 666 | invoke | 2 files |
| 78 | `styk:recovery-delete` | 669 | invoke | 2 files |
| 79 | `styk:open-file` | 681 | invoke | 2 files |
| 80 | `styk:save-file` | 686 | invoke | 2 files |
| 81 | `styk:window` | 713 | invoke | 1 shell |
| 82 | `styk:window-state` | 724 | invoke | 1 shell |
| 83 | `styk:samples-list` | 726 | invoke | 3 services |
| 84 | `styk:sample-read` | 730 | invoke | 3 services |
| 85 | `styk:memory-bytes` | 734 | send | 1 shell |
| 86 | `styk:document-state` | 738 | invoke | 1 shell |

**Main-to-renderer events:** `styk:public-library-link`, `styk:menu-action`, `styk:file-opened`, `styk:support-live-event`, `styk:window-state`, `styk:update-state-changed`, `styk:telemetry-state-changed`
