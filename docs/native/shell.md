# The native shell

The window and everything around it: frame and chrome, DPI, monitors, window state, single instance, file associations,
the `stykanimate://` protocol, the updater and the installer. It is the S6 spike design revised with
its review (13 findings, all accepted) and with what the code in `styk-services::shell`, `::updates` and
`styk-platform::windows` settled. Today's behaviour is `desktop/main.cjs`, `desktop/updates.cjs`,
`desktop/workspace-instance.cjs`, `package.json` `build` and `desktop/installer.nsh`; where this page says "today", that
is the reference ([N5](decisions/0005-electron-is-the-reference.md)).

## Owners

| Concern | Pure (no OS code, tested headless) | OS implementation |
| --- | --- | --- |
| Hit testing, non-client button states, band metrics | `styk_services::shell::chrome` | `styk_platform::windows::chrome` (window subclass) |
| Window frame, monitors, setup key, fit | `shell::window_state` | `windows::monitors` (placement, enumeration) |
| Launch requests, protocol links, queue, wire format | `shell::protocol`, `shell::launch`, `shell::wire` | `windows::instance` (mutex, pipe) |
| Workspace directory of a dead process | `shell::instance` | the same module |
| Associations table, registry layout | `shell::associations` | `windows::registry`, `windows::associations` |
| Feed, versions, state machine, install plan, staging | `styk_services::updates` | `windows::updates` (HTTP, staging, installer) |

`styk-services` holds no OS code and no dependencies. The band's three window buttons are drawn by `styk-ui` and publish
their rectangles; `styk-app` wires the window, the instance and the updater to the core.

## The window

Settings: `decorations: false`, `resizable`, 1560 x 1000 logical, minimum 1000 x 680, `undecorated_shadow`,
`exit_on_close_request: false` (the close guard of the core decides). No native frame is ever used as a fallback: a
fallback that changes the window's look is an open defect (the orchestrator's decision on the review), listed under
[manual checks](#manual-checks).

After the window opens, `window::run` hands the HWND to `windows::chrome::attach`, which installs one subclass
(`SetWindowSubclass`, its own id). It chains with other subclasses (the pen input of `styk-platform::windows::input`
installs its own id): each handles only its messages and calls `DefSubclassProc` otherwise.

`WM_NCHITTEST`, from the physical client point and the published `ChromeRegions`:

1. Fullscreen, or no regions published (a hidden band, a destroyed window): `HTCLIENT`. There are no resize edges in
   fullscreen and no stale caption regions after the band hides.
2. Maximized: no resize edges.
3. Otherwise the border is the system's frame metric at the window's DPI (`SM_CXSIZEFRAME + SM_CXPADDEDBORDER`, 8 px at
   100 %). A corner is the border by two borders. Edge codes `HTLEFT .. HTBOTTOMRIGHT`. The top edge yields to the
   window buttons, so the close button's top pixels are the button.
4. The maximize button rectangle: `HTMAXBUTTON` (Windows 11 shows the snap-layouts flyout for it).
5. A caption rectangle outside every no-drag rectangle: `HTCAPTION` (native move, double-click maximise, system menu,
   Aero Snap, shake: what Electron's drag region gives today).
6. Else `HTCLIENT`.

`HTMAXBUTTON` is a non-client area, so the client gets no mouse messages there. The subclass runs the button itself with
a small state machine (`shell::chrome::MaxButton`, tested on its own): `Idle`, `Hover`, `Pressed` (armed while the pointer
is over the button), cancelled by mouse leave, release outside the button, capture loss (`WM_CAPTURECHANGED`),
deactivation, fullscreen, the band hiding and `WM_NCDESTROY`. A press takes the mouse capture (so the release arrives even
outside the window) and activates only on release over the button. The state is an atomic the wndproc writes and the
interface reads, and a click is a counter the interface takes (it then toggles through iced, so no click is lost or doubled); the wndproc only does a non-blocking `try_send` of a wake-up, so a full channel loses nothing (the
state is read, not replayed) and the wndproc never waits.

`ChromeRegions` is published after each layout by the interface and read by the wndproc under a lock held for one
pointer swap. Window controls are drawn by the band at today's sizes: 44 px wide at the band's height, 36 px once the
band folds `winctl` (`topbar.css`), 16 px glyphs, hover `surface-hover`, close hover `danger-soft` with `danger-text`.
The maximise glyph does not change when maximised (today's page never swaps it).

DPI: per-monitor v2 (winit sets it before the first window; the app manifest also declares it). On `WM_DPICHANGED` winit
keeps the logical size; the subclass only reads the DPI for its border.

## Window state (new; today saves none)

Replaced atomically (write a temporary file, then rename): `window-state.txt`, a small, capped file. Geometry is in
physical pixels in screen coordinates, per monitor setup: the `SetupKey` is a hash of the sorted `(x, y, w, h, scale)` of
every monitor; a setup never seen uses `last`.

- **Coordinates.** `WINDOWPLACEMENT` is in workspace coordinates (relative to a work area), which a top or left taskbar
  displaces, and which is documented differently for tool windows; it is not used. The normal rectangle is read with
  `GetWindowRect` while the window is neither maximized nor minimized and kept by the shell (so a maximized window still
  knows its restore rectangle); restore is `SetWindowPos` (screen coordinates, twice, so a `WM_DPICHANGED` caused by the
  move cannot leave a rescaled rectangle), then `ShowWindow` for the maximized state. Iced's `Position::Specific` is
  logical and converted at the new window's scale, so it is never used to restore.
- **Fit.** `fit_to_monitors`: the size is at least the minimum at the destination scale and at most its work area; the
  band's grip must be reachable: the window's top strip, as high as the band (52 or compact 44 logical, `topbar_h`) and at
  least 64 logical px wide, intersects some work area. Otherwise the default size is centred on the primary work area
  (clamped to it on a display smaller than 1560 x 1000).
- **When.** Saved 500 ms after the last move, resize or maximise, and at close. `STYK_BACKGROUND_WINDOW=1` neither reads nor
  writes it.

## Single instance, launch requests

Today: the lock is per user-data directory; a second process is an independent editor with its own recovery directory
`workspaces/<pid>` (reusing a dead pid's), except that protocol links go to the primary. Same here.

- `Local\StykAnimate-<ProfileId>` (FNV of the profile directory) is a named mutex; the pipe
  `\\.\pipe\StykAnimate-<ProfileId>` serves requests. **The mutex is not liveness**: a secondary closes its handle at once,
  and only a primary that answers on the pipe counts. A forwarder that finds the mutex taken connects to the pipe (the server always keeps a second instance listening, so a start that arrives while another is served never sees a missing name); if the
  pipe is absent or silent (a primary that died, or died mid-forward), it retries with a bounded back-off, and if the
  mutex is released in the meantime it becomes the primary itself and handles the request locally, so no link is lost.
  After the bound it runs as an independent editor.
- **Delivery acknowledgement.** The client exits only after the primary replies `OK` (the request is in the bounded
  queue). `BUSY` is retried within the bound; a failure is reported on stderr with a non-zero exit.
- **Bounds.** A message is at most 8 KiB (16 files); the queue holds 64 requests; a connection has a 2 s read deadline
  (overlapped reads, cancelled on the deadline); at most one connection is served at a time; closing the server cancels
  every wait. A full queue answers `BUSY` and drops nothing silently.
- **Security.** The pipe's DACL admits only the current user, remote clients are rejected. A client opens the pipe at
  `SECURITY_IDENTIFICATION` (a squatting server learns who we are but cannot act as us) and sends nothing unless the server
  process runs as the current user. The server waits at most one second after answering for the client to take the answer, so
  a client that never reads cannot hold the pipe or its shutdown.
- **Rules of today.** `parse_protocol` keeps `handleProtocol`: no userinfo, query, fragment or port; `open`, `privacy`,
  `library`, `library/<publicId>` only. File arguments keep the extension list of `main.cjs`.

## Associations and the protocol

The ProgIDs are today's (`item.name` of the electron-builder entries, e.g. `Pivot animation`, `StykAnimate project`), so a
default a user chose keeps working, all eight formats included: `.ext` default and `OpenWithProgids` name the ProgID;
`DefaultIcon` is `"<exe>",0`; `shell\open` is "Open with StykAnimate" with `"<exe>" "%1"`. HKCU for a current-user install,
HKLM for all users. Uninstall removes the `OpenWithProgids` value and the ProgID key, as electron-builder does. The
`stykanimate` protocol is written to HKCU at a packaged launch if it differs (`setAsDefaultProtocolClient` today).
A registry root parameter points all of it at a sandbox key for tests (`windows::registry::Root`).

## The updater

Feed and installer stay the GitHub release assets, so installed Electron copies and native copies share one pipeline.

- **Release identity.** The feed URL is `releases/latest/download/latest.yml`. The tag it belongs to is read from the
  redirect of that request, and the signature and the installer are resolved against that tag
  (`releases/download/<tag>/<name>`, spaces to `-` as electron-updater does), never against `latest` again, so a release
  published between requests cannot mix files. Redirects stay on `github.com` and `githubusercontent.com` hosts over https.
- **Signature.** `latest.yml.sig` is an Ed25519 signature over the exact feed bytes; the public key is compiled into the
  app (`UPDATE_PUBLIC_KEY`). Without a key the updater is unavailable. The installer is verified against the feed's
  `sha512` and `size`. Downgrades and prereleases are refused.
- **Staging across processes.** All processes of a user share `%LOCALAPPDATA%\StykAnimate\updates\<version>\`. A download
  takes `download.lock`, a file opened with no sharing and deleted on close: the kernel owns the lock, so it lasts exactly as
  long as its holder lives (no age or pid to judge, nothing to take over, nothing to delete from under a live holder). It
  writes a uniquely named `.part`, verifies it and renames it to the immutable `Setup-<sha512 prefix>.exe` only if absent. A
  process that loses the lock waits for the artifact and re-verifies it. The staged file is only a candidate: at the restart
  the program opens it with `FILE_SHARE_READ`, checks its size and SHA-512 through that handle against the signed feed, and
  keeps the handle until the installer has started, so a file replaced while the update waited is never run.
- **Policy** as today: first check after 10 s, then hourly; `idle | checking | downloading | current | ready | restarting |
  error | unavailable` with the same fields and message keys; restart only from `ready`, after the close guard.
- **Install handoff.** `InstallPlan` from the install scope (read from the install-location keys) and whether the process
  is elevated: an all-users install from a standard process runs the installer with the `runas` verb. Arguments are
  electron-updater's: `--updated /S --force-run /D=<install dir>`. The app quits only after the installer process has
  started; a spawn failure or a cancelled UAC prompt leaves the app running in `error`, the verified file kept.

## The installer: NSIS

`packaging/windows/installer.nsi`, built with `makensis` (the copy in electron-builder's cache, or `STYK_MAKENSIS`).
**NSIS over WiX/MSI** because the Electron updater in installed copies already runs `Setup.exe --updated /S --force-run
/D=<dir>`, which only an NSIS-style executable accepts, and because the upgrade has to find and run electron-builder's
own uninstaller. WiX would need a bootstrapper for the install-mode choice and a transition release.

Upgrade path kept from the Electron install: the same uninstall key (`Software\Microsoft\Windows\CurrentVersion\Uninstall\
da89159e-9653-5b0d-96ae-4aeef8dc5497`, the v5 UUID of `app.stykanimate.desktop`) and install-location key, the same install
directory semantics (current user: `%LOCALAPPDATA%\Programs\StykAnimate`; all users: `%ProgramFiles%\StykAnimate`; the
previous location is read back and reused), the same ProgIDs and protocol, shortcuts named `StykAnimate` in the Start menu
and on the desktop, `Uninstall StykAnimate.exe`, and the library folder `Documents\StykAnimate\library`, kept on uninstall.
The old uninstaller is run silently from a copy (`/S /KEEP_APP_DATA /currentuser|/allusers --updated _?=<dir>`), as
electron-builder's own installer does for its upgrades. Portable: a zip, no registry, no updater.

`cargo xtask package` builds the release binary, runs `makensis`, and writes `latest.yml`, `latest.yml.sig` (with a key the
caller supplies) and `SHA256SUMS.txt`. Nothing is signed with a certificate and nothing is uploaded.

## What is checked, and how

| What | Where | How |
| --- | --- | --- |
| Pure contracts: protocol links (12+ cases of `handleProtocol`), launch queue and wire format, election with a dead or dying primary, workspace directories, window frames (two monitors, mixed scale, any taskbar edge, a display smaller than the window), hit testing, the maximize button, feed, versions, update flow, install plan, staging names | `cargo test -p styk-services` | fakes only |
| The window subclass, monitors and restore, single instance over a real pipe (acknowledged delivery, bounds, silent and partial clients, saturation, shutdown, DACL), registry in a sandbox key, updater over HTTP (redirects, signature, resume, two callers, stale locks, cancel) | `cargo test -p styk-platform` | real windows far off-screen, real pipes, a local HTTP server |
| The Setup: an Electron-style install upgraded the way the updater runs it, then the whole updater (check, download, verify, hand-off, restart) | `cargo test -p styk-platform --test installer_upgrade -- --ignored` | `makensis`; registry under `HKCUSoftwareStykAnimateSandbox<id>`, folders under a temporary directory |
| The real iced window: hit testing, fullscreen and hidden-band regions, per-monitor-v2 awareness, minimum size, snap-zone rectangles, a synthetic DPI change, no taskbar button, foreground unchanged | `STYK_BACKGROUND_WINDOW=1 stykanimate --shell-check` | messages to the app's own window |

The Electron install in the Setup proof is a **fixture** written to electron-builder's layout (read from its NSIS templates):
the real 1.1.0 Setup writes the user's real file associations and uninstall entry, and no throwaway Windows account or virtual
machine can be made without administrator rights here.

## Manual checks

What only a person at the screen can do (decision N6; no injected input): the snap-layouts flyout on hover and choosing a
zone; Win+arrow and drag-to-edge snapping; resize cursors on every edge; the look of the shadow, corners and the 1 px line
against Electron's; moving the window across two real monitors of different scale; a top or left taskbar on real
hardware; the UAC prompt of an all-users update and an all-users install and upgrade as a standard user; the real 1.1.0 Electron Setup
upgraded by the native Setup on a throwaway Windows account or VM, with a default chosen for each format; frame pacing while
the system moves or sizes the window (that loop needs a real pointer); restoring a maximized window on a real monitor; a
snap zone narrower than the 1000 px minimum.**What it protects against.** Mistakes and inconsistent state: a registration that points at the wrong folder, a destination with
someone else's files, two Setups at once, an update file replaced while it waited, a stale record. It does not defend against a
process that already has the rights to change the installation folder or the user's registry: that process could replace the
program itself. The reasoning is decision [N10](decisions/0010-installer-threat-model.md). One consequence is kept on purpose: the
uninstaller never removes anything through a junction or a symbolic link (every directory on a manifest entry's path, and the
installation folder itself, is checked for a reparse point; an entry behind one is skipped and counted, and a link that is itself
listed is removed as the link), because following a link turns a stale or surprising folder into a deletion elsewhere without
any attacker at all.

Deleting is bounded at its root. **The native uninstaller never deletes a folder recursively**: the Setup installs the files of a
generated list (`release_feed files-script`) and writes the same list into the installation (`StykAnimate.files`); the uninstaller
removes those files and the folders they leave empty, nothing else, and only registers or unregisters when the registration names
its own folder. **The Electron uninstaller** (electron-builder's, the only one that deletes recursively) runs only on a
registration that agrees with itself and with the folder: `InstallLocation` is the folder of `UninstallString`, the uninstaller is
today's `Uninstall StykAnimate.exe`, the folder holds our manifest or the Electron installation (`StykAnimate.exe` and
`resourcesapp-update.yml` or `app.asar`), and the key is today's GUID in the scope being replaced; anything else is refused with
exit code 5 and nothing is deleted. A destination that is not empty is refused (3) unless it is that validated installation.
The scope and destination are resolved together from what is registered: an explicit `/allusers` or `/currentuser` wins; a
legacy `/D=` with no flag belongs to the scope whose `InstallLocation` it names (none: a new installation for the current user);
no `/D=` means the scope's registered folder. The install transaction is excluded by a `Global` mutex taken by the Setup that
actually works (for all users with a DACL for administrators and SYSTEM), after the elevating wrapper has handed over without
holding it; failing to create it is a refusal (6), a held one is (4). One Setup, in order: an all-users install from a standard
user starts itself again elevated (after the mode page, and for a silent upgrade) and ends; the registry is the 64-bit view;
file types and the `stykanimate` link are written in the hive of the install mode; and `--force-run` starts the program as the user
(`StdUtils::ExecShellAsUser`), not with the Setup's elevated token. The updater passes `/currentuser` or `/allusers` for the
install it detected. Upgrade path kept from the Electron install: the same uninstall key (`Software\Microsoft\Windows\CurrentVersion\Uninstall\
da89159e-9653-5b0d-96ae-4aeef8dc5497`, the v5 UUID of `app.stykanimate.desktop`) and install-location key, the same install
directory semantics (current user: `%LOCALAPPDATA%\Programs\StykAnimate`; all users: `%ProgramFiles%\StykAnimate`; the
previous location is read back and reused), the same ProgIDs and protocol, shortcuts named `StykAnimate` in the Start menu
and on the desktop, `Uninstall StykAnimate.exe`, and the library folder `Documents\StykAnimate\library`, kept on uninstall.
The old uninstaller is run silently from a copy (`/S /KEEP_APP_DATA /currentuser|/allusers --updated _?=<dir>`), as
electron-builder's own installer does for its upgrades. Portable: a zip, no registry, no updater.

`cargo xtask package` builds the release binary, runs `makensis`, and writes `latest.yml`, `latest.yml.sig` (with a key the
caller supplies) and `SHA256SUMS.txt`. Nothing is signed with a certificate and nothing is uploaded.

## What is checked, and how

| What | Where | How |
| --- | --- | --- |
| Pure contracts: protocol links (12+ cases of `handleProtocol`), launch queue and wire format, election with a dead or dying primary, workspace directories, window frames (two monitors, mixed scale, any taskbar edge, a display smaller than the window), hit testing, the maximize button, feed, versions, update flow, install plan, staging names | `cargo test -p styk-services` | fakes only |
| The window subclass, monitors and restore, single instance over a real pipe (acknowledged delivery, bounds, silent and partial clients, saturation, shutdown, DACL), registry in a sandbox key, updater over HTTP (redirects, signature, resume, two callers, stale locks, cancel) | `cargo test -p styk-platform` | real windows far off-screen, real pipes, a local HTTP server |
| The Setup: an Electron-style install upgraded the way the updater runs it, then the whole updater (check, download, verify, hand-off, restart) | `cargo test -p styk-platform --test installer_upgrade -- --ignored` | `makensis`; registry under `HKCUSoftwareStykAnimateSandbox<id>`, folders under a temporary directory |
| The real iced window: hit testing, fullscreen and hidden-band regions, per-monitor-v2 awareness, minimum size, snap-zone rectangles, a synthetic DPI change, no taskbar button, foreground unchanged | `STYK_BACKGROUND_WINDOW=1 stykanimate --shell-check` | messages to the app's own window |

The Electron install in the Setup proof is a **fixture** written to electron-builder's layout (read from its NSIS templates):
the real 1.1.0 Setup writes the user's real file associations and uninstall entry, and no throwaway Windows account or virtual
machine can be made without administrator rights here.

## Manual checks

What only a person at the screen can do (decision N6; no injected input): the snap-layouts flyout on hover and choosing a
zone; Win+arrow and drag-to-edge snapping; resize cursors on every edge; the look of the shadow, corners and the 1 px line
against Electron's; moving the window across two real monitors of different scale; a top or left taskbar on real
hardware; the UAC prompt of an all-users update and an all-users install and upgrade as a standard user; the real 1.1.0 Electron Setup
upgraded by the native Setup on a throwaway Windows account or VM, with a default chosen for each format; frame pacing while
the system moves or sizes the window (that loop needs a real pointer); restoring a maximized window on a real monitor; a
snap zone narrower than the 1000 px minimum.
