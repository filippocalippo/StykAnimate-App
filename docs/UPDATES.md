# GitHub updates and releases

The private `filippocalippo/StykAnimate-App` repository builds the application. Public installers and update metadata go to `filippocalippo/styk-animate-releases`. Customers need no GitHub credentials. `RELEASES_TOKEN` is an Actions secret restricted to Contents write access on the releases repository; it is used only by the upload step and is never bundled in the app.

## Runtime

Installed Windows NSIS copies check 10 seconds after startup and every four hours. Help → Check for updates also checks immediately. The updater downloads stable versions newer than the installed version, verifies the installer SHA-512, and reports progress to a narrow preload bridge. Checks/downloads are deduplicated. Failures allow retry; completed downloads remain cached until the user chooses **Restart to update**. Normal app exit does not silently install updates.

Restart flushes workspace settings and clipboard persistence. Unsaved projects offer Save and restart / Cancel / Discard and restart. A cancelled or unsuccessful save never launches the installer. The installer updates the existing installation directory and relaunches the app. Settings and projects remain outside the installation directory.

Development, unpacked, and portable copies show an explanation and a downloads link. Automatic installation is currently Windows-only. macOS requires signing and platform testing before enabling updates there. Windows builds currently use the project's existing unsigned configuration; Windows may display its normal reputation warning on first installation.

The welcome splash appears once each process launch (not every renderer reload). Help → What’s new reopens it. It uses bundled `desktop/release-info.json`, so the displayed notes match the installed version and work offline. It has X, Escape, and Start animating close controls. Ko-fi links in the splash and export window use the same fixed destination and open the system browser.

## Publish a new version

1. Set a new, higher `x.y.z` version in `package.json` and `package-lock.json`. Update `desktop/release-info.json` with the same version and the release's patch notes.
2. Run `npm run release:prepare`, `npm run test:updates`, and `npm run test:updates:desktop`.
3. Commit the source to the private repository. Push a tag matching the version, for example `v0.5.1`. The **Build and release Windows app** workflow builds and publishes that version. Alternatively run the workflow manually: the default produces a draft; enable Publish to release it.
4. Confirm the workflow passed and the public release has the Setup installer, Portable executable, Setup `.blockmap`, `latest.yml`, and `SHA256SUMS.txt`.

Pushing the initial `codex/auto-updates` integration branch builds a draft only. Do not overwrite published releases; increment the version for corrections. Published GitHub assets must remain accessible and retain their generated filenames.

Builds use exact JavaScript/Python dependencies and the private repository's `codecs/` sources. No sibling checkout is required. The uploader validates installer version, filename, size and hash before uploading, then checks GitHub's asset names and available digests before publishing. It uploads a fixed allowlist, never the source tree or build logs. Public tags are created in the releases repository, which contains no app source.

## Build and publish locally

```powershell
npm ci
python -m pip install -r scripts/requirements-build.txt
npm run release:prepare
npm run build:frame-scan
npm run build:vfw
npm run build:sidecar
npm run verify:sidecar
npm run build:video-encoder
# Replace the version below with package.json's version.
npm run dist:win -- --x64 --publish never --config.directories.output=release/0.5.0
npm run release:verify
gh auth login
npm run release:publish
# Review the draft; then publish it:
npm run release:publish -- --publish
```

## Test a real update

1. Install an updater-enabled **Setup** build, such as 0.5.0. Earlier builds without this feature need this one manual install.
2. Publish a higher version (for example 0.5.1) with the workflow above. Publishing a source commit alone does not produce an update.
3. Open the older installed app, close its welcome splash, and choose Help → Check for updates. Confirm visible progress and that editing still works during download.
4. When Restart to update appears, make an unsaved edit. Click Restart, then Cancel: the app and edit must remain. Click again and choose Save and restart; save the project.
5. Confirm the app reopens, its splash shows the new installed version and matching patch notes, and the saved project opens correctly. Help → Check for updates should report up to date.
6. Test offline/retry and Later. Later dismisses the notice; Help → Check for updates brings the ready state back. Closing normally does not install the pending update.

`npm run test:updates` covers controller transitions and release artifact validation. `npm run test:updates:desktop` exercises the actual preload/main-process bridge, native save/cancel decisions, splash lifecycle, donation URLs, and rendered progress, with installer invocation substituted in that test process. Screenshots and results are written under `artifacts/updates`. A UI/controller test alone does not establish that a public installer upgrade succeeded; that requires the real installation test above.
