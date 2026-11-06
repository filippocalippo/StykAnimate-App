# GitHub updates and releases

The private `filippocalippo/StykAnimate-App` repository builds the application. Public installers and update metadata go to `filippocalippo/styk-animate-releases`. Customers need no GitHub credentials. `RELEASES_TOKEN` is an Actions secret restricted to Contents write access on the releases repository; it is used only by the upload step and is never bundled in the app.

## Runtime

Installed Windows NSIS copies and writable Linux AppImages check 10 seconds after startup and every hour. Help → Check for updates also checks immediately. The updater downloads stable versions newer than the installed version, verifies the installer SHA-512, and reports progress to a narrow preload bridge. Checks/downloads are deduplicated. Failures allow retry; completed downloads remain cached until the user chooses **Restart to update**. Normal app exit does not silently install updates.

Restart flushes workspace settings and clipboard persistence. Unsaved projects offer Save and restart / Cancel / Discard and restart. A cancelled or unsuccessful save never launches the installer. The installer updates the existing installation directory and relaunches the app. Settings and projects remain outside the installation directory.

Development, unpacked, and Windows portable copies show an explanation and a downloads link. Linux updates require running an AppImage with write access to both the file and its containing folder; read-only copies explain how to move the app to a writable folder. macOS requires signing and platform testing before enabling updates there. Windows builds currently use the project's existing unsigned configuration; Windows may display its normal reputation warning on first installation.

Linux auto-update is new in **Unreleased**. The published 1.2.0 AppImage does not have it, so users must manually install the first release containing this feature. After that, `desktop/appimage-updater.cjs` uses electron-updater's existing GitHub provider, download verification and cache. On restart it asynchronously stages the verified download beside the installed file before the final save/close decision, then atomically replaces the same path. Versioned filenames and symlink launchers remain usable. Staging or replacement failures preserve the old file; Cancel removes the staged copy. At the final quit event, the updater releases the single-instance lock and launches the replacement independently of the old mounted image, preserving launch flags including X11. Projects and preferences remain outside the AppImage.

The welcome splash appears once each process launch (not every renderer reload). Help → What’s new reopens it. At startup it is one of the prompts that open one at a time (the overlay manager's prompt queue, `src/ui/overlay-manager.mjs`): it waits for the first rendered frame and for any open dialog or menu to close, and the first-run privacy choice follows it. It uses bundled `desktop/release-info.json`, so the displayed notes match the installed version and work offline. The fixed header keeps Donate visible, categorized notes scroll independently, and X, Escape and Start animating close it. Recent releases fetches up to 20 stable published changelogs from the fixed public service endpoint through a bounded, cached main-process request; the version selector keeps installed notes available offline and renders all remote content as text. Ko-fi links in the splash and Help → Support development use the same fixed destination and open the system browser.

## Publish a new version

1. Follow [the release history procedure](RELEASING.md): move completed `CHANGELOG.md` Unreleased entries into one new highest `x.y.z` section and align `package.json` and both root version fields in `package-lock.json`.
2. Run `npm run release:prepare`, `npm run changelog:check`, `npm run test:updates`, and `npm run test:updates:desktop`. Commit both generated note files with the history and version files; do not author `desktop/release-info.json` directly.
3. Push the prepared source and dispatch **Build and verify release** with both inputs off. This verifies Windows, Linux and browser candidates without publication. Review its artifacts and installation evidence. When shipping is authorized, enable `upload_draft` for a draft, or `publish` for publication; a matching `v<version>` tag also publishes automatically.
4. Confirm the workflow passed and the public release has the Setup installer, Portable executable, Setup `.blockmap`, `latest.yml`, Linux AppImage, `latest-linux.yml`, and `SHA256SUMS.txt`. Deploy and verify the browser build, then refresh the website catalogue when shipping all three platforms.

Do not overwrite published releases; increment the version for corrections. Published GitHub assets must remain accessible and retain their generated filenames.

Builds use exact JavaScript/Python dependencies and the Rust engine and Pivot codec built from this repository's `engine/` (`node scripts/engine-build.mjs`). No sibling checkout is required. The uploader validates installer version, filename, size and hash before uploading, then checks GitHub's asset names and available digests before publishing. It uploads a fixed allowlist, never the source tree or build logs. Public tags are created in the releases repository, which contains no app source.

## Build and publish locally

```powershell
npm ci
python -m pip install -r scripts/requirements-build.txt
npm run release:prepare
node scripts/engine-build.mjs
npm run build:vfw
npm run build:video-encoder
# Replace the version below with package.json's version.
npm run dist:win -- --x64 --publish never --config.directories.output=release/0.5.0
npm run release:verify -- release/0.5.0 --platform=win32
# Build Linux on its own host, verify with --platform=linux, and copy its
# AppImage and latest-linux.yml into the same release/<version> directory.
npm run release:verify
gh auth login
npm run release:publish
# Review the draft; then publish it:
npm run release:publish -- --publish
```

## Test a real update

Before publication, the release workflow runs `scripts/verify-release-install.mjs`
on a disposable Windows GitHub runner. It verifies the previous public Setup's
GitHub digest, installs it, downloads the exact candidate from a loopback feed,
checks Cancel and Save before restart, and exercises the real NSIS replacement and
automatic relaunch. It then opens the saved project in the installed candidate and
checks profile preservation. Evidence records both installer hashes and the source
commit in `artifacts/release-install/evidence.json`. The guard refuses ordinary
local execution because this test uses the real application identity.

1. Install an updater-enabled **Setup** build, such as 0.5.0. Earlier builds without this feature need this one manual install.
2. Publish a higher version (for example 0.5.1) with the workflow above. Publishing a source commit alone does not produce an update.
3. Open the older installed app, close its welcome splash, and choose Help → Check for updates. Confirm visible progress and that editing still works during download.
4. When Restart to update appears, make an unsaved edit. Click Restart, then Cancel: the app and edit must remain. Click again and choose Save and restart; save the project.
5. Confirm the app reopens, its splash shows the new installed version and matching patch notes, and the saved project opens correctly. Help → Check for updates should report up to date.
6. Test offline/retry and Later. Later dismisses the notice; Help → Check for updates brings the ready state back. Closing normally does not install the pending update.

`npm run test:updates` covers controller transitions and release artifact validation. `npm run test:updates:desktop` exercises the actual preload/main-process bridge, native save/cancel decisions, splash lifecycle, donation URLs, and rendered progress, with installer invocation substituted in that test process. Screenshots and results are written under `artifacts/updates`. A UI/controller test alone does not establish that a public installer upgrade succeeded; that requires the real installation test above.

For repeatable installation verification, run `node scripts/verify-update-install.mjs` on Windows. It builds two tiny NSIS fixtures with a unique application identity, installs the first into `artifacts/updates`, downloads the second through the production UpdateService, runs the real installer, verifies automatic relaunch at the new version, and uninstalls the fixture. It does not replace an existing StykAnimate installation. Evidence is `artifacts/updates/installer-smoke.json`.

On Linux, `npm run test:updates:linux` builds two isolated AppImages using the locked updater and shipping AppImage toolset. It rejects a bad checksum, retries the download, verifies Cancel and ordinary quit preserve the old bytes, then replaces and automatically relaunches the new version at the original filename. It checks exact installed hashes, the single-instance lock and profile preservation; evidence is `artifacts/updates/appimage-smoke.json`. Run under `xvfb-run -a` without a desktop display. The release workflow runs this probe as well as the full application's packaged startup and save/cancel UI tests. The fixture probe establishes the updater mechanism; it does not certify a future public release's exact AppImage, which must also be checked when that version ships.

After publishing, `node scripts/verify-github-update.mjs` launches the packaged app with a temporary profile and reports an older version only inside that test process. It downloads and verifies the real public installer through electron-updater without installing it, then verifies that the actual packaged version reports current. Set `STYK_PACKAGED_EXECUTABLE` to test a different unpacked build. Evidence is `artifacts/updates/github-smoke.json`.
