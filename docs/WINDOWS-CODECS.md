# Installed Windows AVI codecs

StykAnimate's Windows AVI bridge uses genuine installed Video for Windows compressors. This is a separate provider from the bundled FFmpeg AVI presets. Pivot's equivalent is **Windows AVI → Compress**, which opens codec-specific settings for codecs installed under Windows. [Pivot 5.2 Video manual](https://pivotanimator.net/help5-2/video.htm).

## Platform and codec selection

Two native helpers enumerate the 32-bit and 64-bit compressor registries using `ICInfo`, open a selected compressor with `ICOpen`, and test the requested canvas with `ICCompressQuery`. The original Pivot executable supplied in this workspace is 32-bit; the dual-helper implementation also exposes compatible 64-bit compressors. [Microsoft ICInfo documentation](https://learn.microsoft.com/en-us/windows/win32/api/vfw/nf-vfw-icinfo).

Each result has a stable `vfw:<architecture>:<registered-handler-hex>` identity. Registered aliases retain their identities even when the opened driver reports a canonical handler. A separate **Full frames (uncompressed)** entry uses Windows' uncompressed AVI path and is explicitly identified as built-in, rather than an installed compressor.

The bridge accepts bottom-up RGB24 DIB frames at the requested dimensions. Installed codecs that reject this input are listed with their actual rejection reason. It does not claim that every Windows codec accepts every canvas size or pixel format. Video for Windows is a Windows desktop API; these installed-codec choices are unavailable in the browser, macOS and Linux builds. Portable export formats and bundled FFmpeg presets remain separate choices.

## Data and configuration

[vfw-video-export.mjs](../src/vfw-video-export.mjs) takes a frame-rendering callback and returns an AVI Blob. Its worker converts each frame into bottom-up BGR bytes with DWORD row padding. Transparent pixels use a black matte, matching Pivot's documented Windows AVI behavior. Each IPC message carries at most 256 KiB and the next frame waits for native encoding acknowledgement.

[vfw-export-service.cjs](../desktop/vfw-export-service.cjs) owns helper selection, temporary output files and opaque configuration tokens. The renderer supplies neither executable paths nor driver DLL paths. Vendor codec code runs in a separate helper process. Cancellation terminates that owned process and removes its temporary output. Output is capped at 256 MiB, individual raw frames at 64 MiB, and total pixels at 16 million per frame.

The native helper creates the compressed stream with `AVIMakeCompressedStream`. Quality, keyframe interval, data rate and codec-specific configuration state are supplied through the native compression options. Controls are enabled only when the compressor advertises the corresponding capability. [Microsoft compressed-stream API](https://learn.microsoft.com/en-us/windows/win32/api/vfw/nf-vfw-avimakecompressedstream), [compression options structure](https://learn.microsoft.com/en-us/windows/win32/api/vfw/ns-vfw-avicompressoptions).

**Configure codec** opens the vendor's real `ICConfigure` dialog with an owner HWND obtained by Electron's main process. The service retains at most 16 opaque setting records, each capped at 1 MiB including its architecture/handler header. Settings are scoped to the chosen codec and canvas dimensions in the export controls. The main process restores the owner window's enabled state after the dialog completes or fails.

## Verification

- [Native bridge report](../artifacts/vfw-native-v1/report.json): both helpers build with MSVC `/W4 /WX`; nine real AVI outputs cover all currently installed RGB24-compatible handlers and uncompressed video. Three-frame outputs preserve rational 7:2 frame rate, orientation and color under an independent FFmpeg software decoder. Short/extra frame input and invalid dimensions are rejected; existing output files are preserved.
- [Native configuration report](../artifacts/vfw-configure-v2/report.json): actual 32-bit Cinepak and 64-bit Microsoft Video 1 dialogs were identified only by their owned helper PIDs, inspected, and cancelled through their own controls. Bounded configuration state was then reused in a three-frame AVI and independently decoded.
- [Service tests](../tests/vfw-video.test.mjs): seven passing tests cover exact BGR conversion/alpha/padding, platform capability boundaries, actual enumeration, all nine available codec choices with six independently decoded frames, odd uncompressed dimensions, output chunk bounds, invalid/concurrent requests, cancellation and reuse. [Results](../artifacts/vfw-service/report.json), [capabilities on the test machine](../artifacts/vfw-service/capabilities.json).
- [Actual Electron workflow](../tests/vfw-video.desktop.mjs): 21 checks cover renderer isolation, both compressor architectures, uncompressed AVI, bounded raw-frame IPC, cancellation/reuse, and rendering-error cleanup. The actual export dialog opens the vendor's Configure window, retains its settings token, forwards quality/keyframe/bitrate values, and saves the resulting AVI. Independent decoding confirms all six frames and native black matte. [Report](../artifacts/vfw-renderer/report.json), [dialog screenshot](../artifacts/vfw-renderer/export-controls.png).
- [Native keyframe interval proof](../artifacts/vfw-keyframe-check/report.json): 30-frame Cinepak and Microsoft Video 1 exports with interval 10 have AVI keyframe indices exactly `[0, 10, 20]`.
- [Native output bound](../artifacts/vfw-output-limit-v1/report.json): both helpers reject a streamed output crossing 256 MiB before waiting for the remaining declared frames, then remove the partial owned file.
- [Shared scene-worker integration](../artifacts/worker-video-renderer/report.json): nine actual desktop checks include selected export smoothing, real VFW Cancel and retry/Save, six independently decoded frames, supersampled edge levels, the zero-frame export guard, and dialog close/reopen cleanup.

These checks cover the codecs installed on the current Windows machine. Compatibility with an arbitrary third-party compressor still depends on that compressor accepting RGB24 input and implementing the Windows APIs correctly. Latest packaged-build verification is separate from these source/helper tests.
