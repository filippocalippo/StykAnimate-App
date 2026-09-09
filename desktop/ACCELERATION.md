# Native import transport

The preserved `release/baseline-0.1.0` package remains runnable. Its exact web and native module hashes are recorded in `artifacts/package-baseline-0.1.0.json` and its own `BUILD-INFO.json`.

The next source iteration changes native opening to pass the selected file's compact bytes to the import worker. Electron main performs bounded filesystem reading and returns an `ArrayBuffer`; it no longer requests, parses, or IPC-copies expanded JSON. The existing Python decoder and worker preserve the document format and export path.

## Recorded desktop comparison

`scripts/benchmark-native-import.mjs` invokes the actual native open action, waits for the project to load into the WebGPU editor, and observes renderer and Electron-main timer gaps. Each file was imported once into a fresh codec cache on Windows with NVIDIA Lovelace. These observations include OS scheduling, test overhead, and concurrent machine activity. They are not input-to-display measurements or guarantees.

| File | Source / expanded JSON | Baseline / compact UI open | Baseline / compact main maximum timer gap | Baseline / compact renderer longest task |
| --- | --- | --- | --- | --- |
| Goku/Broly | 0.74 / 11.95 MB | 1,289 / 919 ms | 150 / 32 ms | 409 / 120 ms |
| Shroobs JJK | 6.87 / 37.36 MB | 2,371 / 1,832 ms | 210 / 44 ms | 710 / 172 ms |

Both paths loaded the complete projects: 40 keyframes / 105 first-frame figures for Goku and 29 keyframes / 61 first-frame figures for Shroobs. Evidence is in `artifacts/native-import-baseline-0.1.0.json` and `artifacts/native-import-source-bytes.json`. The remaining renderer tasks warrant profiling document transfer, validation, and initial geometry preparation separately.

## Existing C++ code

`StykAnimate/src/platform/Codec.cpp` is a Windows launcher for `StykAnimate/tools/codec_bridge.py`. Its `Codec::load()` and `save()` exchange JSON files with Python; it contains no PIV/STK parser that can be reused to accelerate decoding. The native project's CMake configuration also rejects non-Windows builds.

The authoritative grammar lives in `tools/piv_codec.py`, `piv_legacy*.py`, `piv_side_tables.py`, `piv_full_writer.py`, and the bridge's STK path. The new backend already uses bulk `struct.unpack_from`; zlib and numeric unpacking execute native library code.

A compiled sidecar, Node addon, or WebAssembly decoder would therefore require a real grammar port, including legacy versions, bounded decompression, media tables, opaque byte retention, validation, and corpus differential tests. A standalone native sidecar would have the least coupling to Electron once implemented. Node addons would add platform binding work; WebAssembly would fit the import worker but needs a separate portable core and buffer API.

The smaller next transport step is a versioned metadata envelope with transferable numeric and asset buffers while retaining the tested decoder and export fallback. Reconstructing every record as ordinary objects on the UI thread would retain allocation costs, so the editor must progressively consume those buffers for the change to be useful.

`StykAnimate/src/model/Scene.cpp` contains an independently reusable evaluation engine (`evaluate`, `evaluateKeyframe`, `replaceObject(s)`, and `translateObjects`), although extracting it would require a standalone build target and typed pose interface. Import work and playback work remain separate: Python is absent from dragging and playback, so playback improvements need evaluation/render profiling rather than a faster file decoder.
