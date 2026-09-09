# Installed Windows AVI compressors

`vfw-bridge.cpp` is a fixed subprocess bridge to Windows Video for Windows. It
enumerates registered compressors through `ICInfo`/`ICOpen`, queries each
compressor for the requested RGB24 dimensions, and writes AVI through
`AVIFileCreateStream`, `AVIMakeCompressedStream`, and `AVIStreamWrite`.

Build both architectures with `python scripts/build-vfw-bridge.py`. The script
discovers Visual Studio C++ tools using `vswhere`, selects the newest complete
installed Windows SDK, and retains explicit `--msvc`, `--sdk`, and `--sdk-version`
overrides. The helpers use the static C runtime. `native/bin/build-info.json`
records source and binary SHA256 values for packaging verification. Windows x86
and x64 codec registrations can differ; the original Pivot 5.2 executable is x86.

The trusted desktop service owns process arguments, output paths, configuration
state files, and opaque renderer tokens. A renderer selects an enumerated codec
identity; it cannot supply a DLL path or arbitrary configuration bytes.

## Protocol

All text output is newline-delimited UTF-8 JSON. Handler values are decimal
unsigned 32-bit registered FourCC values. Handler `0` represents uncompressed
RGB24. Native registered identities remain distinct even when `ICGetInfo`
returns a shared canonical handler for two aliases.

```text
--list width height
--configure handler width height ownerHWND stateFile
--encode outputPath handler width height fpsNumerator fpsDenominator totalFrames quality keyframeEvery dataRate [stateFile]
```

`--list` returns architecture, stride, frame size, and codecs with actual RGB24
compatibility and native quality/configuration/keyframe/data-rate capabilities.
Unsupported compressors remain visible with a reason. Configuration invokes the
installed compressor's native dialog with the supplied valid owner window.
Cancel retains the compressor's current settings; negative native errors fail.

Encoding stdin consists of exactly `totalFrames` bottom-up BGR24 frames. Rows
have stride `(width * 3 + 3) & ~3`, including padding bytes. FPS remains a reduced
rational value. Quality is `-1` for the codec default or `0..10000`; keyframe and
data-rate values use `0` for defaults. Unsupported requested controls fail.

The helper emits `ready` before reading frames, `frame` with a zero-based index
only after that frame's successful `AVIStreamWrite`, and `complete` after closing
the AVI. An `error` includes a code and message, with exit status 1. Short input,
extra bytes, encoder failures, and dimension violations remove only the new
partial output owned by this invocation. Existing output files are preserved.

Opaque state is at most 1 MiB including its 20-byte header: `STYKVFW1`, a 32-bit
architecture value, a 32-bit handler, and a 32-bit payload length, followed by
the unmodified `ICGetState` payload. Reuse validates the header and passes codec
parameters through native compression options. Limits also enforce dimensions
at most 16384, at most 16 Mi pixels and 64 MiB per frame, and at most one million
frames. Actual output size is checked after every accepted frame and after AVI
header finalization; crossing 256 MiB fails immediately and removes the partial
file. The desktop service adds cancellation.

## Verification

`tests/vfw-native-smoke.py` exercises actual installed encoders and independently
decodes the AVI outputs using FFmpeg. FFmpeg does not encode the VFW output.
`tests/vfw-configure-smoke.py` cancels only dialogs owned by the helper PID, checks
the bounded state header, then encodes with that saved configuration.
`tests/vfw-output-limit-smoke.py` crosses the production 256 MiB cap in both
architectures and verifies rejection before EOF plus partial-file cleanup.

This machine passed nine supported encoder/architecture combinations, including
x86 Cinepak and both Microsoft Video 1 architectures. Configuration round trips
passed Cinepak and Microsoft Video 1. A separate 30-frame static-image proof
confirmed keyframe interval 10 produces AVI keyframes at 0, 10, and 20 for all
three installed temporal encoder/architecture combinations. Compressor support
on another computer is discovered at runtime rather than assumed from this list.
