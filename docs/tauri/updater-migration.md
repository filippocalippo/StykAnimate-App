# From the Electron app to the Tauri app: how existing users update

Every installed Electron copy (1.x) updates itself with electron-updater from the public GitHub releases of
`filippocalippo/styk-animate-releases`, reading `latest.yml`. The Tauri app updates with `tauri-plugin-updater`
from the same releases, reading `latest.json`. The first Tauri release publishes both feeds, so the people on 1.x
move over through the update they already know, and keep everything.

## What the first Tauri release publishes

`node scripts/tauri-build.mjs` writes, in `release/<version>/`:

| File | Read by | What it is |
|---|---|---|
| `StykAnimate-<v>-Setup-x64.exe` | people, both updaters | Tauri's NSIS installer (per user, today's name) |
| `StykAnimate-<v>-Setup-x64.exe.sig` | build check | the minisign signature of the installer |
| `latest.json` | the Tauri app | version, notes, date, and for `windows-x86_64` the installer's URL and signature |
| `latest.yml` | Electron copies (1.x) | version, the installer's name, SHA-512 and size, in electron-updater's format |
| `StykAnimate-<v>-Portable-x64.exe` | people | the portable copy (no self-update, as today) |
| `SHA256SUMS.txt` | people | checksums of the above |

There is no `.blockmap`: electron-updater then downloads the whole installer, which is what a first install of a new
app should do anyway.

## What happens on a 1.x copy

1. The Electron app checks as always (10 s after start, hourly, or Help → Check for updates), finds the higher
   version in `latest.yml`, downloads the Setup and checks its SHA-512.
2. The person chooses **Restart to update**, answering the unsaved-work question as today.
3. electron-updater quits the app and runs the Setup with `--updated /S --force-run`.
4. The Setup's pre-install step (`windows/installer-hooks.nsh`) finds the Electron copy by its electron-builder key
   (`fe40c1cb-7216-5497-9775-a306daabe735`, from the app id) and runs its uninstaller silently, in place, waiting for
   it. That uninstaller keeps the user's data (electron-builder keeps app data unless told otherwise). It runs
   before the new file associations and shortcuts are written, because it removes the old ones (same ProgIDs).
5. The Setup installs the Tauri app for the current user (`%LOCALAPPDATA%\StykAnimate`), registers the same file
   types, creates `Documents\StykAnimate\library`, and, because of `--force-run`, starts the app.
6. The Tauri app reads the user's data where Electron kept it: `%APPDATA%\StykAnimate` (settings, layout, hotkeys,
   recovery, recent files, the project list, presets) and `Documents\StykAnimate\library`. It registers
   `stykanimate://` for itself on first start.

From then on the Tauri app updates from `latest.json`: same check times, verified download, install only on
Restart to update, after the unsaved-work question. The NSIS installer runs in passive mode (progress, no
questions) and reopens the app.

## Keys and signing

- **Installer signing (Authenticode)**: none, as today (`"signExecutable": false`). Windows may show its reputation
  warning on a first manual install, as it does now.
- **Update signing (minisign)**: required by tauri-plugin-updater. The public key is in `tauri.conf.json`; the
  private key was generated on 2026-11-09 at `%USERPROFILE%\.tauri\stykanimate-updater.key` (no password) and is not
  in the repository. Before the first release it goes into the release workflow as the secret
  `TAURI_SIGNING_PRIVATE_KEY` (and an empty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). Losing it means installed Tauri
  copies can no longer update; replacing it means shipping the new public key in a release signed with the old one.

## What still has to be done before shipping

- The release workflow and `scripts/release-assets.mjs` / `publish-release.mjs` still expect electron-builder's
  files (`.blockmap`, `latest-linux.yml`, the AppImage); they need the table above instead.
- The real migration (an installed 1.x copy updating to the Tauri Setup) must be run on a clean Windows machine or
  the release workflow's runner (`scripts/verify-release-install.mjs`), never on a workstation with the owner's own
  installation: step 4 would remove it.
- Linux and macOS: the Tauri app is built and tested on Windows only for now. Linux AppImage users (1.2.x) keep the
  Electron AppImage until a Linux build (WebKitGTK has no WebGPU; that needs its own decision).
