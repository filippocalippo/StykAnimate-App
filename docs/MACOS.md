# Apple Silicon macOS build

The Mac package uses native ARM64 Electron, Python codecs, the C++ PIV scanner and an offline FFmpeg encoder. It does not require Rosetta, Python or Node.js on the computer that runs the packaged app.

## Build

Use an Apple Silicon Mac with native ARM64 Node.js 22+ (24.11.0 for release builds), uv, and Xcode or its command-line tools. Accept the Xcode license before building. From the repository root:

```sh
npm run build:mac:arm64
```

The script installs locked npm dependencies, creates a Python 3.12.9 environment with uv, builds and verifies the native codecs, stages the pinned ARM64 encoder, and creates a DMG and ZIP under `release/`. Use `npm run build:mac:arm64 -- --dir` for just `release/mac-arm64/StykAnimate.app`.

The scanner targets macOS 12 or later, matching Electron's minimum. Compatibility with older macOS versions still needs testing; local verification is on the build machine. Intel and universal Mac packages are outside this build path.

The SDK comes from `xcrun --sdk macosx --show-sdk-path`, so it matches the selected toolchain. Python is selected through uv instead of an unrelated Conda or system interpreter.

## Local signing

This command creates a local ad-hoc signature. It does not use an Apple developer account, notarize, publish, or enable automatic updates. macOS can still require approval for an app downloaded from the internet. For distribution to other people, use a separate Developer ID signing and notarization process.

The frozen codec and pinned encoder already have valid ad-hoc signatures. The Mac signing configuration preserves their bytes so package verification can compare them with the build. PyInstaller changes the scanner's Mach-O signature during freezing; the sidecar manifest records both its original build hash and its frozen hash.

## Verify the exact app

```sh
codesign --verify --deep --strict release/mac-arm64/StykAnimate.app
npm run verify:package
npm run test:boot:packaged
npm run test:export:packaged
```

The boot check opens an isolated profile, closes the first-run welcome screen, checks rendering and native codecs, saves a changed project with Command-S, and imports that saved file again. It keeps a screenshot, the project and a JSON report in `artifacts/boot-packaged/`.

The export check creates MP4, WebM, AVI, WMV and GIF files, then decodes each file and checks its frame count. Videos and its JSON report remain in `artifacts/exports-packaged/`. These checks need a logged-in graphical macOS session. They do not change personal app data. Private Pivot sample files are not required.

To build and open the app, run `./script/build_and_run.sh`. It asks an existing instance to quit before rebuilding and stops if it remains open. `--verify` runs the boot check; `--debug` starts LLDB; `--logs` opens the app and shows its system logs.
