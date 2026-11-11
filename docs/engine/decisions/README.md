# Engine decisions

Architecture decision records of the Rust engine port. Each states the context, the decision, the evidence it rests on and what follows. New decisions get the next number; a reversed decision gets a new record that supersedes it.

- [D1: The engine workspace grows from the measured prototype](0001-engine-workspace.md)
- [D2: A lossless copy-on-write document store, typed views per record](0002-lossless-document-store.md)
- [D3: One WebAssembly module with threads](0003-threaded-webassembly.md)
- [D4: The engine replaces the JavaScript engine document by document, feature by feature](0004-strangler-gate.md)
- [D5: zstd from the C library](0005-zstd-from-c.md)
- [D6: One threaded WebAssembly build on a pinned nightly](0006-pinned-nightly-wasm.md)
- [D7: The interface thread never blocks](0007-interface-thread-never-blocks.md)
- [D8: One renderer pipeline for WebGPU, native and WebGL2](0008-renderer-without-storage-buffers.md)
- [D9: The engine build output is generated, not committed](0009-generated-engine-build-output.md)
- [D10: Never strip the WebAssembly profile](0010-keep-wasm-symbols.md)
- [D11: Array textures always have at least two layers](0011-array-textures-two-layers.md)
- [D12: A mirror of the document in the engine until the engine owns it](0012-document-mirror.md)
- [D13: What counts as the same picture in the app](0013-app-parity-rule.md)
- [D14: The shared memory's maximum adapts to what the device can reserve](0014-shared-memory-maximum.md)
- [D15: Editing moves to the engine command by command, record for record](0015-commands-record-for-record.md)
- [D16: Stored arithmetic uses one Math, the one Node's V8 has, bit for bit](0016-v8-exact-math.md)
- [D17: The drawing raster engine is its own crate, run by the drawing workers in its own module](0017-drawing-raster-engine.md)
- [D18: What the editor draws at random is handed to the engine](0018-editor-draws.md)
- [D19: The engine owns the document; the editor keeps a read view patched from it](0019-engine-owns-the-document.md)
