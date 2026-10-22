# macOS support

StykAnimate builds and runs as a local Apple Silicon (arm64) desktop app from the
same source tree, Electron shell and frozen codec as Windows and Linux. The
oldest supported version is **macOS 12 Monterey**, the minimum of the bundled
Electron 39. Local builds are ad hoc signed: they run on the Mac that built them
and pass `codesign --verify`, but Gatekeeper rejects them elsewhere. **They are
not ready for public distribution.** Intel Macs, Developer ID signing,
notarization, automatic updates and publishing are not set up yet; see
[What a public release still needs](#what-a-public-release-still-needs).

## Prerequisites

- An Apple Silicon Mac with the Xcode Command Line Tools (`xcode-select --install`)
  for `c++`, `codesign`, `lipo` and `vtool`.
- Node.js 24.11.0 and Python 3.12.9, the versions the release workflow pins. The
  Python must itself support macOS 12: the python.org universal2 installer or a
  python-build-standalone `aarch64-apple-darwin` build both target 11.0. Homebrew
  and pyenv builds target the Mac they were built on and are rejected by the
  packaging check below. Nothing needs to be installed system-wide; both runtimes
  work from any directory.

## Build and package

From the repository root:

```bash
npm ci --no-audit --no-fund
/path/to/python3.12 -m venv .venv
.venv/bin/python -m pip install -r scripts/requirements-build.txt
# pip picks wheels for the build machine's macOS (orjson's needs macOS 15 on a
# new Mac); install the release dependencies for macOS 12 instead:
.venv/bin/python -m pip install --target build/python-build-deps \
  --platform macosx_12_0_arm64 --only-binary=:all: -r scripts/requirements-build.txt
export STYK_PYTHON="$PWD/.venv/bin/python"
npm run build:frame-scan        # C++ PIV scanner, -mmacosx-version-min from package.json
npm run build:sidecar           # freezes the codec with PyInstaller (uses build/python-build-deps first)
npm run verify:sidecar
npm run build:video-encoder     # FFmpeg from the pinned imageio-ffmpeg wheel
npm run dist:mac:local          # ad hoc signed .app, DMG and ZIP
npm run verify:package
npm run test:boot:packaged
npm run test:export:packaged
```

Output, for version 1.2.5:

- `release/mac-arm64/StykAnimate.app`
- `release/StykAnimate-1.2.5-mac-arm64.dmg` and `.zip` (with blockmaps and
  `latest-mac.yml`, which nothing consumes yet)

`npm run dist:mac` without `:local` looks for a signing identity in the keychain
and, finding none, leaves the bundle unsigned; `verify:package` then rejects it
because its signature no longer seals the files.

## What the build checks

- **Deployment target.** `package.json` `build.mac.minimumSystemVersion` (12.0)
  is the single source. The scanner is compiled for it, electron-builder writes
  it to `LSMinimumSystemVersion`, and `scripts/before-pack.cjs` refuses to package
  if any Mach-O file in the frozen codec or the encoder lacks arm64 code or
  declares a newer minimum. `verify:package` repeats the check over the whole
  `.app` (Electron, helpers, Python, orjson, the scanner and FFmpeg).
- **Scanner integrity.** PyInstaller re-signs the libraries it collects on macOS,
  and packaging signs every native file again, so their bytes change after the
  verified build. The scanner is built with an `@rpath` install name, so those
  copies differ from the verified library only in their code signature.
  `scripts/macos-binaries.mjs` removes the signature with `codesign` and clears
  the one size field that depends on it (the `__LINKEDIT` mapping); everything
  else, including all code, data and load commands, must match exactly. Windows
  and Linux keep plain byte comparison.
- **Bundle signature.** `verify:package` runs `codesign --verify --deep --strict`
  on the `.app`.

## Desktop conventions

- The window keeps the standard traffic lights over the editor's title bar, and
  closing the last window leaves the app running; clicking the Dock icon opens a
  new one.
- Command is the editor's main modifier (`Mod` in `src/hotkeys.mjs`). Command+H
  hides the app, so Show / hide unselected handles is Shift+Command+H; Last used
  project is Control+Tab because Command+Tab switches apps.
- The application menu (`desktop/native-menu.cjs`) adds the app menu (About,
  Hide, Quit), a Window menu (Minimize, Zoom), Close Project (Command+W), Close
  Window (Shift+Command+W) and Edit menu key equivalents for Undo, Redo, Cut, Copy,
  Paste and Select All, which Chromium needs for editing text fields on macOS.
  The editor sees each key first; see [Shortcuts](hotkeys.md).
- Double-clicking a supported file in Finder, or `open -a StykAnimate file.styk`,
  opens it in the running app (`open-file`). `stykanimate://` links arrive the
  same way (`open-url`).
- The codec reports its resident memory through `proc_pid_rusage` for local
  diagnostics.
- File > New Window starts another process on the same profile, as on Windows and
  Linux. On macOS, Electron's `requestSingleInstanceLock()` never lets a process
  that failed it reach `ready`, so the primary workspace is decided by an
  exclusive `flock` lock on `primary-workspace.lock` in the profile
  (`claimPrimaryWorkspace` in `desktop/workspace-instance.cjs`), taken atomically
  when the file is opened. The kernel releases it when the process ends, even
  after a crash or `kill -9`, so a stale claim or a reused process ID cannot keep
  it; the codec and other child processes never inherit it. Windows and Linux keep
  Electron's lock. The primary keeps running with no window, as Mac apps do;
  a New Window process quits when its window closes.
- Processes sharing a profile write its settings, shortcuts and project list
  through atomic replacement, so a file is never torn, but the last writer wins
  (as on Windows and Linux). Each process keeps its recovery copies and browser
  data in its own directory (`workspaces/<pid>` for secondary windows).

## Verification on this build

Checked on an Apple M2 running macOS 27.2 with Node 24.11.0 and a
python-build-standalone CPython 3.12.9 (the release workflow installs 3.12.9
with `actions/setup-python`; the version matches, the build does not), from a
clean checkout of the build steps above:

- `npm run check`, `npm run changelog:check`, `npm test` (also with the host
  forced to Windows) and the backend `unittest` suite pass; skips need the
  private Pivot corpus, Windows codecs or fonts, or a Linux AppImage.
- `verify:package`: 20 Mach-O files, all arm64-only, declare macOS 11.0 or 12.0;
  none links a library outside the bundle or the system; `codesign --verify
  --deep --strict` passes; `spctl --assess` rejects the ad hoc app as expected.
  This inspects the binaries' deployment targets; the app has not been run on
  macOS 12 itself.
- `test:boot:packaged` (WebGPU on Metal, frozen codec with orjson and the C++
  scanner) and `test:export:packaged` (MP4, WebM, AVI, WMV and GIF, each decoded
  by FFmpeg) pass on the packaged app; `tests/audio.desktop.mjs` passes from
  source.
- Desktop smokes that pass from source: recovery, preferences, home,
  native-streams, renderer-recovery, updates, public-library, hotkeys, fonts,
  project-tabs, library, shared-clipboard, drawing and library-drag; recovery,
  preferences, library and renderer-recovery also pass against the packaged app.
- On the packaged app, key events posted to the app process while it was
  frontmost (`CGEventPostToPid`) confirmed: text fields edit once per Command
  A/C/X/V/Z and Shift+Command+Z; Command+Z on the canvas undoes one step without
  the menu acting; with Undo reassigned, Command+Z does nothing and the new key
  undoes; Shift+Command+H toggles handles; Command+H hides the app; Command+W
  closes one project; Shift+Command+W asks about unsaved work in the real alert.
  The real Save and Open panels were driven with keyboard events (cancel, save,
  reopen); an imported tone played in sync, saved and reopened through `open -a`
  (as Finder does) without a second process; New Window, closing it, reopening
  the app with no window, a killed primary and Command+Q behaved as described
  above. These used the Accessibility permission and are not part of the
  repository. No physical keyboard, trackpad gestures or pen pressure were tested.

Known smoke failures on this Mac, the same on the unchanged previous commit:

- fonts, intermittently (about one run in five): one 70–90 ms renderer long task
  while the Installed fonts list fills with the 770 macOS fonts. The list's
  usual cost is 20–30 ms.
- simple-boundaries tests the Simple timeline's working frame (Frame 1 / 0),
  which the app no longer enables; the smoke needs updating to the current
  Simple timeline.
- project-files, frame-clipboard, sprite-builder and app-save need private
  samples.

## Known limitations

- Apple Silicon only. The pinned imageio-ffmpeg 0.6.0 Intel macOS binary is
  built with `--enable-nonfree` and cannot be redistributed; the staging script
  rejects it. An Intel build needs another FFmpeg (for example a GPL build with
  libx264 and libvpx passed with `--source`), an x86_64 Python for 12.0, and an
  Intel machine or runner to freeze and test it.
- Ad hoc signed: Gatekeeper (`spctl --assess`) rejects the app on other Macs,
  and a downloaded copy is quarantined. Do not share these builds.
- Automatic updates report "unavailable" on macOS (`desktop/updates.cjs`).
- Installed Windows video codecs (VfW) are Windows-only; MP4, WebM, AVI, WMV and
  GIF export use the bundled FFmpeg.
- Several F-keys in the default shortcuts (F8–F12) are media keys on Mac
  keyboards unless Fn is held, and macOS may claim F11 (Show Desktop).
- The Electron default entitlements (`allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation`) apply to every
  executable, including the codec and FFmpeg, which need fewer.
- File associations use extension-based document types; there are no exported
  type identifiers (UTIs) yet.

## What a public release still needs

1. A Developer ID Application certificate, hardened-runtime entitlements narrowed
   per executable, and notarization (`notarytool`) with stapling.
2. A macOS job in `.github/workflows/desktop-release.yml` and `ci.yml` using the
   pinned Node and a Python built for 12.0, running the commands above, the boot
   and export smokes, and `spctl --assess` on the notarized result.
3. `scripts/release-assets.mjs` and `scripts/publish-release.mjs` support for the
   DMG, ZIP and `latest-mac.yml`, and electron-updater's macOS updater (it needs
   the signed ZIP) in `desktop/updates.cjs`.
4. Optional: Intel or universal builds, and UTIs for the document types.
