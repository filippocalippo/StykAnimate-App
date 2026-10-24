# Desktop build and release verification

The **Build and verify release** workflow builds Windows x64 Setup and Portable executables and a Linux x64 AppImage from the same commit. It verifies packaged files, startup, exports and update controls on both hosts. A disposable Windows runner also installs the previous public version and upgrades it to the exact candidate through the real updater and NSIS installer. Browser checks must pass before any upload to the public release repository.

A manual run with both inputs off keeps candidates and evidence in private workflow artifacts for 30 days. `upload_draft` uploads a draft; `publish` or a matching `v<version>` tag publishes. Automatic in-app installation supports Windows Setup and, starting with the next release after 1.2.0, writable Linux AppImages. The Linux job also runs a real isolated AppImage download/replacement/relaunch probe. See [Linux support](LINUX.md), [updates](UPDATES.md), and [release history and shipping](RELEASING.md). macOS packaging is unverified. Windows artifacts use the existing unsigned configuration.

To rerun the installed upgrade against retained bytes, dispatch the same workflow with `verify_windows_run=<candidate-run-id>` on the release branch. This mode downloads that run's Windows assets, validates their update checksums, extracts the expected archive directly from Setup, and runs only the isolated installer check. It never publishes or substitutes for the source, browser and packaging gates. Record both run IDs and matching candidate hashes in the release report.

After publication, add `verify_public_feed=true` to that retained-artifact run. It launches the exact candidate payload, downloads the now-public installer through electron-updater without installing it, checks progress and checksum verification, then confirms the candidate reports itself current. This avoids attempting a same-version installed upgrade after the public baseline has advanced.

The lockfile pins Electron, electron-builder, and Playwright. `scripts/engine-build.mjs` names the Rust toolchains (the pinned nightly with `rust-src` for the engine, stable for the Pivot codec, both with the `wasm32-unknown-unknown` target) and the `wasm-bindgen-cli` version; it builds both WebAssembly modules into `src/engine/pkg/`, which the package carries with the other web resources. `scripts/requirements-build.txt` pins the offline video encoder wheel. Build with Python 3.12.9 and Node 24.11.0 using the commands below on the target OS and architecture. Windows additionally requires MSVC C++ build tools and a Windows SDK for the installed-codec helpers; the build scripts discover them through vswhere.

```text
npm ci --no-audit --no-fund
node scripts/engine-build.mjs
python -m pip install -r scripts/requirements-build.txt
npm run build:video-encoder
```

On Windows, also run `npm run build:vfw` to build both 32-bit and 64-bit installed-codec helpers. The video staging step verifies MP4, AVI, WMV, and VP9 encoder availability and includes its license and provenance files. Build guards reject a missing or stale engine or codec module (its bytes must match `src/engine/pkg/build-info.json`), stale helper sources, and an encoder staged for another OS or architecture. No Python codec ships: the app runs the Pivot codec in the editor page.

Release artifacts are kept in separate numeric version directories. For a Windows 0.3.0 release, first set the root package and lockfile versions to 0.3.0, then run this sequence in PowerShell after source changes are frozen:

```powershell
npm run dist:win -- --publish never --config.directories.output=release/0.3.0
$env:STYK_PACKAGED_RESOURCES = Join-Path $PWD 'release/0.3.0/win-unpacked/resources'
$env:STYK_PACKAGED_EXECUTABLE = Join-Path $PWD 'release/0.3.0/win-unpacked/StykAnimate.exe'
npm run verify:package
npm run test:desktop:packaged
npm run verify:package
npm run mark:release
```

The package verifier compares web modules (the engine and codec modules included), native IPC modules and encoder helpers with the source/build hashes, and fails when the package still carries the retired Python codec. The isolated desktop smoke checks real WebGPU startup, that the Pivot codec runs its WebAssembly module with the desktop limits, both installed-codec helper architectures, offline video capabilities, real PIV/STK imports, native saves, and cancel/save-on-close behavior. Its screenshot and JSON evidence are written under `artifacts/`.

`mark:release` requires a successful smoke from that exact versioned executable, an unchanged verified file manifest, and the Setup, Portable, and unpacked executables. It rehashes the verified resources and records all three executable hashes before writing `verified-release.json`. The root launcher chooses the newest numeric version with that marker and the required runtime files. It skips unfinished folders and falls back to the preserved older executable when necessary. It never deletes old releases or closes another running app window.

The same host build prerequisites apply to macOS and Linux. Run `npm run dist:mac -- --publish never` or `npm run dist:linux -- --publish never` there. The Windows release marker and launcher are specific to Windows; they are not evidence of macOS or Linux execution.
