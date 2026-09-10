# Desktop runtime

For GitHub automatic updates, release publishing, the startup splash, and update testing, see [UPDATES.md](../docs/UPDATES.md). Desktop codec sources now live in this private repository's `codecs/` directory; release builds no longer require sibling codec directories.

Run `npm ci` then `npm start` from `StykAnimate-webapp`, or use the root Windows launcher. Node.js 22 or newer and Python 3.11 or newer are required for development. The reproducible build workflow pins Node.js 24.11.0 and Python 3.12.9. `STYK_PYTHON` selects an explicit Python executable; activated virtual environments, conda installations, and standard Python commands are discovered automatically.

Electron runs the WebGPU workspace in an isolated, sandboxed renderer. A private Python child process loads the existing Pivot codecs once and listens on a dynamically allocated loopback port. Parsing and export stay out of the animation render loop. The native bridge exposes file dialogs, document state, menu actions, and window controls; it cannot execute arbitrary commands or access arbitrary paths.

The renderer should call `setDocumentState({name, dirty})` after document changes and save operations, subscribe to `onMenuAction`, and subscribe to `onOpenFile` for OS file associations. `openFile()` opens a native dialog and returns `{bytes: ArrayBuffer, filename, kind, nativePath, sourceBytes, timings}`. Pass these compact source bytes to the existing import worker with `importer.importFile(new File([result.bytes], result.filename))`; Electron main does not decode or IPC-copy expanded scene objects. `onOpenFile` uses the same contract, and `importTransport` is `source-bytes-v1`. `saveFile({data, encoding, defaultPath, filters})` accepts a `Uint8Array`, byte array, or text/base64 string and always asks the user for a destination. Window control methods support the custom header on Windows and Linux; macOS keeps native traffic lights.

`saveRecovery({data, name})`, `getRecovery()`, and `deleteRecovery()` keep a bounded, atomic recovery document in Electron's persistent user-data directory. `data` is base64; callers cannot choose a filesystem path. Recovery survives process restarts and the changed loopback origin on each launch. `npm run test:recovery` checks storage behavior and `npm run test:recovery:desktop` verifies recovery across two real Electron launches with different ports.

Large saves use `writeNativeBlob` from `src/native-files.mjs`. It writes a worker-produced Blob through native-approved stream tokens in 256 KiB chunks, acknowledges each write, checks the declared total, and atomically commits only after all bytes arrive. File saves use a native destination dialog; recovery saves use a fixed user-data destination. Cancellation preserves the prior complete file. The legacy methods above remain available for compatibility with small callers.

`getRecoveryInfo()` returns only name, timestamp, and size, so startup can show a recovery prompt without loading the document. `readNativeRecovery()` returns a Blob assembled from bounded native chunks when the user requests restoration. The 200 MiB desktop stream test verified exact output hashes, cancellation, and no renderer long tasks during save/recovery transfer; evidence is under `artifacts/native-streams-smoke.json`.

`getWorkspacePreferences()` and `setWorkspacePreferences(snapshot)` persist a plain JSON object, up to 16 KiB, in the fixed `workspace-preferences.json` file. Root passes these to `initWorkspaceLayout({preferences,onPersist})`, which debounces settled layout changes. The native process-restart test restores docked dimensions and floating panel geometry across different backend ports; evidence is in `artifacts/desktop-preferences-smoke.json`.

`getEditorSettings()` and `setEditorSettings(snapshot)` use a separate fixed `editor-settings.json` file with the same bounded JSON validation and atomic writes. Editor settings and panel layout persist independently across restarts and changing backend ports.

Project Save uses document capabilities. After a new or replacement document is accepted, the app calls `activateDocument({openToken})` and retains the returned `documentToken`. A native `.styk` open supplies a one-use `openToken`; other imports and new/recovered documents activate without a save target. Adding a stick figure does not replace the active document. `writeNativeBlob(...,{documentToken,saveAs:false})` reuses that document's confirmed `.styk` path, or opens the native chooser for its first save. `saveAs:true` always opens the chooser and changes the remembered target only after a complete atomic write. Cancelled dialogs, failed writes, and aborted streams retain the previous target. Switching documents invalidates old save capabilities and unfinished project streams. PIV files require a new `.styk` destination; exports continue to use the generic native chooser.

The helper still returns a save-success boolean. Its optional `onSaved(result)` callback receives the committed filename and document token. App code must compare the captured token with the active document before clearing dirty state after an asynchronous save. `npm run test:project-files` checks token rules; `npm run test:project-files:desktop` exercises actual native saves, cancellation, source protection, and editor-settings restart persistence. Evidence is recorded in `artifacts/desktop-project-files-smoke.json`.

## Build installers

Use Node.js 24.11.0 and Python 3.12.9 on each target operating system and architecture:

```text
npm ci --no-audit --no-fund
python -m pip install -r scripts/requirements-build.txt
npm run build:sidecar
npm run verify:sidecar
npm run dist -- --publish never
```

The JavaScript dependency versions are exact, with transitive versions and integrity hashes in `package-lock.json`; Python build dependencies are pinned in `scripts/requirements-build.txt`. The frozen codec includes its Python interpreter and the compiled orjson 3.12.0 encoder. Its build manifest records the OS, architecture, Python, PyInstaller, and encoder versions. The packaging guard rejects a sidecar built for a different OS or architecture and rejects an unaccelerated release. Encoder licenses are copied into `resources/sidecar/THIRD_PARTY/orjson`. `verify:sidecar` starts the frozen executable, checks the active encoder, and checks import and byte-exact PIV export when the local fixtures are present.

Windows targets NSIS and portable, macOS targets DMG and ZIP, and Linux targets AppImage. A DEB can additionally be built after supplying the project's actual homepage and maintainer metadata to electron-builder; those identities are not invented for this local project. Source codecs are copied into resources for traceability and the development-Python fallback. The release build requires the self-contained sidecar, so recipients do not need Node.js or Python installed. Signing credentials and notarization are deployment configuration and are not included.

The repository-level `.github/workflows/desktop-build.yml` defines Windows, macOS, and Linux jobs that install the pinned dependencies, run source/unit and codec checks, freeze a native sidecar, and upload unsigned build artifacts. It can be run manually or on relevant pull requests. It has read-only repository permissions and never publishes a release. The workflow has been added locally; it has not been executed by a remote CI service. **Only the Windows runtime and package have been verified here.** macOS and Linux remain configured build targets awaiting execution on those systems.

The persistent frame clipboard uses a separate fixed `frame-clipboard.styk` file and the same token-bound 256 KiB binary transfer mechanism as project/recovery saves. `installNativeFrameClipboard` handles worker serialization and cross-origin desktop restart restoration; close flows await its `flush()` promise. See `docs/FRAME-CLIPBOARD.md` for the editing and persistence contract.

Installed fonts are discovered by `FontService` from known system directories. `listFonts()` returns display metadata and opaque IDs; `readFont(id)` returns a bounded owned binary buffer. The renderer cannot supply a filesystem path. TTC/OTC faces are reconstructed as standalone TTF/OTF data for the embedded-outline text worker.

Native MP4/H.264, AVI/MPEG-4 and WMV/WMV2 export uses a separate, bundled FFmpeg process. Build it with `npm run build:video-encoder` after installing `scripts/requirements-build.txt`. The staging script accepts only the pinned imageio-ffmpeg 0.6.0 wheel's binary by default, records its configuration and SHA-256, and copies full license texts and provenance. `build/video-encoder` is included as `resources/video-encoder`; packaging checks OS/architecture. The service has fixed encoder and temporary roots, opaque job IDs, bounded PNG frame chunks and no renderer-controlled command arguments or output paths. Platform capability probing reports which presets the staged binary actually supports. The supplied Windows encoder has been staged and exercised locally; macOS/Linux encoder packaging remains unexecuted here.

`npm run pack` generates an unpacked Electron app. `npm run check` checks JavaScript syntax. `npm run test:desktop` starts the real Electron application, waits for the editor, checks renderer isolation and WebGPU adapter availability, verifies native import/save, and saves a screenshot and JSON evidence under `artifacts/`. `npm run test:desktop:packaged` runs the same checks against the unpacked build; `STYK_PACKAGED_EXECUTABLE` can select its path explicitly.

Electron uses Chromium's default hardware driver compatibility checks. `STYK_GPU_UNSAFE=1` opts into Chromium's experimental WebGPU driver path on development machines where needed. `STYK_DEVTOOLS=1` opens developer tools and `STYK_DEBUG=1` prints codec process logs.

On this Windows automation host, running Electron inside the restricted test-process sandbox caused GPU child processes to exit with `0xC0000135` before the first window. The same commands passed with approved host GPU access and workspace test profiles; Electron's own renderer sandbox remained enabled. All eight Electron runtime DLL hashes matched the preserved package. This was a test-host access restriction, and required no DLL replacement, WebGPU disabling, or software-renderer switch. Evidence is recorded in `artifacts/desktop-launch-diagnosis.json`.
