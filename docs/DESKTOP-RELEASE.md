# Desktop build and release verification

Only Windows execution has been verified on this workstation. The existing GitHub Actions workflow builds unsigned Windows, macOS, and Linux artifacts on their respective hosts; it does not publish or use signing secrets. A successful CI run on another OS is required before claiming that platform is verified.

The lockfile pins Electron, electron-builder, and Playwright. `scripts/requirements-build.txt` pins the Python compiler dependencies, orjson and the offline video encoder wheel. Build with Python 3.12 and Node 24 using the commands below on the target OS and architecture. Windows additionally requires MSVC C++ build tools and a Windows SDK; the build scripts discover them through vswhere. macOS and Linux use their host C++ compiler.

```text
npm ci --no-audit --no-fund
python -m pip install -r scripts/requirements-build.txt
npm run build:frame-scan
npm run build:sidecar
npm run verify:sidecar
npm run build:video-encoder
```

On Windows, also run `npm run build:vfw` to build both 32-bit and 64-bit installed-codec helpers. The video staging step verifies MP4, AVI, WMV, and VP9 encoder availability and includes its license and provenance files. The frozen codec carries the native PIV scanner and compiled JSON encoder. Build guards reject stale source hashes, a missing native library, or a sidecar built for another OS or architecture.

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

The package verifier compares web modules, native IPC modules, the codec, the C++ scanner, and encoder helpers with the source/build hashes. The isolated desktop smoke checks real WebGPU startup, frozen codec health, both installed-codec helper architectures, offline video capabilities, real PIV/STK imports, native saves, and cancel/save-on-close behavior. Its screenshot and JSON evidence are written under `artifacts/`.

`mark:release` requires a successful smoke from that exact versioned executable, an unchanged verified file manifest, and the Setup, Portable, and unpacked executables. It rehashes the verified resources and records all three executable hashes before writing `verified-release.json`. The root launcher chooses the newest numeric version with that marker and the required runtime files. It skips unfinished folders and falls back to the preserved older executable when necessary. It never deletes old releases or closes another running app window.

The same host build prerequisites apply to macOS and Linux. Run `npm run dist:mac -- --publish never` or `npm run dist:linux -- --publish never` there. The Windows release marker and launcher are specific to Windows; they are not evidence of macOS or Linux execution.
