# Web build (Cloudflare)

The editor also runs as a static website. It is the same code as the desktop app,
Pivot codec included; nothing about a project is sent to a server.

```bash
npm ci
node scripts/engine-build.mjs   # the engine and the Pivot codec, into src/engine/pkg/
npm run web:build       # build/web; prints the current file count and size
npm run web:verify      # checks the build before it is deployed
npm run web:preview     # build, then serve build/web on http://127.0.0.1:47850
npm run test:web        # end to end in a real browser, under the production headers
```

## Deploying

The editor is its own Cloudflare Worker, `stykanimate-app` (`web/wrangler.jsonc`), separate
from the public site's Worker (`stykanimate`), so the two deploy and roll back independently.
Cloudflare serves the built files; the Worker script (`web/worker.js`) runs only for
`/community/*` (see [The community library window](#the-community-library-window)).
It is served at `https://app.stykanimate.com` (a custom domain on the site's zone) and at
`stykanimate-app.<account>.workers.dev`.

```bash
npm ci --prefix web                   # once: installs the pinned wrangler
npx --prefix web wrangler login       # or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
npm run web:deploy -- --dry-run         # build, verify, let wrangler validate the config
npm run web:deploy                      # deploy
STYK_WEB_URL=https://... npm run test:web   # run the end-to-end test against the deployment
npx --prefix web wrangler rollback --config web/wrangler.jsonc   # go back to the previous version
```

`web:deploy` refuses to deploy a site that fails `web:verify`, and deploys what is built from
the working tree: build from a clean checkout of the commit you mean to publish. Cloudflare
applies `web/_headers` to every static response.

The active marketing site lives in the separate `StykAnimate-Site` repository. Its launch links point to the browser editor. Static app
pages allow indexing; `/community/*` API responses remain `noindex` and excluded
in `robots.txt`. Deploy the verified editor before deploying the site's launch links.

The reusable `web-verify.yml` workflow builds and tests the production files on
Windows and Linux. Windows must export real MP4/AAC sound; Linux verifies a clear
AAC-unavailable result where necessary and real WebM/Opus sound. Firefox and WebKit
run the storage, library and browser-support checks on Linux. The release workflow
retains the exact deployable `browser-release` artifact for 30 days; it does not
deploy it automatically. Record the deployed build hash from `build-info.json`
and run the live checks after an authorized deployment.

## How it is built

There is no bundler. The site is the desktop app's web resources (the file set
comes from the `web` filter in `package.json`, so the two builds cannot drift),
which include the WebAssembly modules of the engine and of the Pivot codec in
`src/engine/pkg/` (built by `node scripts/engine-build.mjs`; the web build stops when
the codec is missing). `index.html` is marked `<meta name="styk-codec"
content="browser">`, which selects the codec's web profile (see below).

Modules are not content-hashed, so `_headers` tells browsers to revalidate them;
Cloudflare answers with `304` and an ETag, and the codec module is not
downloaded again. Once the app is installed, the service worker answers instead
(see [Install and offline](#install-and-offline)).

Cold-load measurements (cache disabled, headless Chromium, this repository's
build): about 600 requests over a 21-level-deep module graph. Served over
HTTP/1.1 without compression by the development server it took 3.9 s on
localhost and 5.9 s at 50 ms latency and 20 Mbps. Over a local HTTP/2 server at
20 ms and 20 Mbps it took 3.25 s, and declaring the whole module graph up front
with `modulepreload` did not change that (3.21 s): loading is transfer-bound, not
waterfall-bound, so the page preloads only what starts the engine (its start module, loader and WebAssembly
file), which would otherwise begin late in the graph. Brotli level 5 estimates
what Cloudflare sends: 5.5 MiB for the editor and assets on first load (measured
before the engine's own module joined the site), and, only when a Pivot file is first
opened, 0.43 MiB for the codec module (1.47 MiB raw). Before the Rust codec, that first
Pivot file cost 5.9 MiB of Python runtime and codec sources (13.3 MiB raw). If cold load ever matters more than
simplicity, content-hashed bundles are a build-only change.

`web:verify` fails the build for: a module the app imports that was not shipped, a
file over Cloudflare's 25 MiB limit or more than 20,000 files, a `_headers` file
Cloudflare would reject or without a script policy, a page that does not select the
in-browser codec, a missing codec module, and any private file (`desktop/`, `backend/`,
`codecs/`, `.env`, keys). It
also checks the install manifest and service worker described below.

## Install and offline

The site can be installed as an app (Chrome and Edge on desktop and Android;
Safari's Add to Home Screen) and starts with no network. The pieces are added to
the web page by `build-web.mjs` and never reach the desktop app's page:

- `web/manifest.webmanifest` and `web/icons/` make it installable: an app window,
  the mark as its icon, a maskable icon and an Apple touch icon. The icons are
  rendered from `mark.svg` by `node scripts/build-web-icons.mjs` and committed.
- `web/sw.js` is the service worker. The build writes this build's file list, each
  file with a hash, into it; the version is a hash of that list, so it changes
  exactly when a file does. `src/web-offline.mjs` registers it three seconds after
  the page has loaded, so a first visit's own requests are not shared with filling
  the cache.
- Each version has one cache. Installing stores the editor (12 MiB) and every
  request is then answered from it, so the app always runs one consistent version.
  The Pivot codec module (1.5 MiB) is stored right after, unless the browser asks to
  save data, and is kept the first time it is used either way.
- A new build installs in the background and takes over when every window of the
  old one has been closed, so an open project is never swapped under its owner;
  the open app shows a short notice. Files whose hash did not change are copied
  from the previous cache instead of downloaded, so an update costs what changed
  (the Pivot codec is not fetched again unless it changed). The old cache is deleted when the new
  version takes over.
- `_headers` serves `/sw.js` and the manifest with `no-cache`, which is how an
  installed app finds out about a new version. An installed app also asks the
  browser to keep its storage (`navigator.storage.persist()`); a tab does not, so
  a browser may still clear a tab's recovery data under storage pressure.

`tests/web-offline.browser.mjs` (part of `npm run test:web`) installs the built site
in Chrome, stops the server, and checks that the app starts, saves, exports and
reopens a Pivot file and an MP4 with no network; then that a changed build
downloads only its changed file, waits for the old window to close and replaces the
old cache. Chrome's own installability check reports no errors for the served
site. Not verified: install and offline use in Safari or Firefox, and installing on a phone.

## Autosave and the libraries in the browser

**Autosave.** A moment after each edit (2.5 s by default, Settings → Recovery), and at once when the
tab is hidden (a phone may discard a background tab without warning), the project is written to
IndexedDB as one copy per tab. Browser playback pauses before the hidden-tab snapshot;
active edits, resource publication and cancellation still use the usual export barriers.
The next visit offers "Restore unsaved work"; an acknowledged file save clears only that
tab's copy. Project Save uses a file picker where the browser offers
one; otherwise it starts a download, keeps the project edited and retains recovery because
downloads cannot report that a file was written. A manual download also keeps recovery when
timed autosave is disabled. If storage is blocked or full,
the editor keeps working, says so once, and retries less often
(`src/browser-recovery.mjs`, `scheduleRecovery` in `app.mjs`). The document is stored as an
ArrayBuffer, not a Blob, because WebKit cannot keep a Blob in IndexedDB reliably.

The v2 recovery database stores bytes and display metadata separately, migrating the old
singleton in place. Recovery lists read only metadata; choosing Restore reads one project.
Page-lifetime Web Locks exclude live tabs' copies and reserve a copy until restoration
finishes. A restored copy adopts its abandoned key, so saving it clears the correct copy.
Without Web Locks, tabs still have unique keys; restoring keeps the source copy until it is
explicitly discarded. Manage copies in the recovery offer selects or discards abandoned
copies. Storage is bounded to eight copies and 512 MiB; a full store rejects a new write
without evicting existing work, while updating one's own copy remains possible within the
byte budget. Close older tabs if they block the database upgrade.

**My library** (`src/web-library.mjs`) is the desktop library's interface (`desktop/library-store.cjs`)
over IndexedDB, so the Library panel is one implementation for both: the same folders, names,
unique names, moves, previews and kinds. Files are ArrayBuffers in one store and their entries
(name, kind, size, PNG preview) in another, so listing never reads a file, and a rename or move
re-keys an entry and its bytes in one transaction. Writes take a Web Lock shared by every tab
(`navigator.locks`, where the browser has it) so two tabs cannot take the same name. There is no
recycle bin, so removing deletes, and the panel says so; there is no "Show in folder". A full
browser reports it in words the person can act on. Nothing is sent to a server.

**Storage is the browser's.** It can be cleared by the person, by a private window ending, or under
pressure: an installed app asks the browser to keep it (`navigator.storage.persist()`), a tab does
not, and Safari removes a website's script-written data after 7 days without a visit unless the
site is added to the Home Screen. Export what matters (Save downloads a project).

**Community library** (`src/community-library.mjs`) is the browser twin of `desktop/public-library.cjs`
with the same rules and messages; `tests/community-library.test.mjs` runs both against the same
indexes and requires the same answers.

## The community library window

The site's API sends no CORS headers, so a browser on `app.stykanimate.com` cannot read it.
Rather than loosen the production site, the editor asks its own origin and `web/worker.js` passes
on exactly three shapes of request, GET only, and refuses everything else:

| Request | Goes to |
| --- | --- |
| `/community/content` | `SITE_URL/api/v1/content` |
| `/community/files/index/<version>.json` and `/community/files/i/<id>/<name>` | `FILES_URL/…` (the public file host) |
| `/community/get/<id>?k=i/<id>/<name>.stkz` | the site's counting route; its redirect is followed here, only to the site's own hosts |

`SITE_URL` and `FILES_URL` are variables in `wrangler.jsonc`. Answers are size-bounded (by header and
by counting bytes), carry `nosniff`, a sandboxing CSP and no cookies, and immutable files are cached at
the edge. The page's own CSP is unchanged because the requests are same-origin. The service worker
never touches `/community/*`. The site counts one download per person per asset: the first download
goes through the counting route and is remembered in `localStorage`, later ones read the public file.
`scripts/serve-web.mjs` runs the same Worker code locally, against the real site or a stand-in
(`tests/support/community-site.mjs`).

## Browsers

The 1.2 candidate workflow runs real browsers through
`tests/support/cross-browser.mjs`, using the locked Playwright version:

| Check | Chromium on Windows/Linux | Firefox on Linux | WebKit on Linux |
| --- | --- | --- | --- |
| Editor starts and unsupported features are explained | yes | yes | yes |
| Autosave, restore, clear on save, flush on hide, blocked storage | yes | yes | yes |
| My library and community catalogue, verified downloads and previews | yes | yes | yes |
| Native/Pivot round trips, images and video export | yes | not covered by this suite | not covered by this suite |
| Offline startup, saving, export and safe version replacement | yes | not covered by this suite | not covered by this suite |

Windows must encode MP4 with real AAC sound. The Linux run checks an explicit
AAC-unavailable result when the browser cannot encode it, and always verifies
WebM with real Opus sound. It never counts a silent file as an audio-export pass.

Playwright WebKit is not Safari, and this does not certify physical phones or
Safari itself. The previous Windows WebKit build lacked `OffscreenCanvas`; the
Linux build used for this release runs the full storage/editor suites. The app
checks `OffscreenCanvas`, WebAssembly, IndexedDB, Web Crypto, `createImageBitmap`,
`structuredClone`, dialogs and workers before loading. Missing features produce
an explanation instead of a blank editor. WebGPU is optional.

On a phone or a tablet the editor opens its touch interface ([docs/TOUCH.md](TOUCH.md)); `npm run
test:touch` checks it in Chromium with touch emulation. Real phones and tablets, and Safari (the
engine of every iOS browser), are not part of the automated checks.

## Security

`_headers` sends the policy `index.html` already declares in its own tag, plus the
directives a tag cannot carry: `script-src 'self' 'wasm-unsafe-eval'` (WebAssembly
compiles; `eval` does not), `worker-src 'self' blob:`, `object-src 'none'`,
`frame-ancestors 'none'`, `nosniff`, `no-referrer`, and a Permissions-Policy with
camera, microphone, geolocation and payment off. The browser build sends no
telemetry and has no feedback channel, update check or server codec.
Never deploy `backend/server.py` (the Python codec, kept as a development test oracle)
publicly: it can read the folder it runs in.

## The Pivot codec in the browser

Pivot (`.piv`, `.stk`) files use a binary format whose reader and writer are the Rust
codec `engine/crates/styk-piv`, compiled to WebAssembly (`src/engine/pkg/styk_codec*`).
The desktop app runs the same module the same way; see
[Pivot files and the codec service](engine/formats-piv.md).

- `src/codec-request.mjs`: the import and export workers ask for `/api/import`,
  `/api/export` and `/api/source` through one function, over a `MessagePort` to the codec
  worker, and get a standard `Response`.
- `src/codec-web-host.mjs` (page) and `src/codec-web-worker.mjs` (worker) own the worker,
  its queue (`src/codec-web-shell.mjs`) and cancellation; `src/codec-engine.mjs` loads the
  module and answers one request.
- The Python codec (`codecs/`, `backend/`) is the development test oracle only: the
  parity replay checks that the Rust codec answers what it answered. The web build ships
  and starts no Python (`web:verify` rejects `backend/` and `codecs/`).

The module (0.43 MiB at Brotli 5) loads on the first Pivot import or export, never at
startup, and is then cached. Native projects (`.styk`, `.stkz`, `.stykmov`), Stick Nodes
files and every image, GIF and WebM export do not need it.

The web build's page selects the codec's web profile, which differs from the desktop's on
purpose:

- Limits are lower because WebAssembly memory is 32-bit and shares the tab: 96 MiB for a
  Pivot source, 128 MiB for a native document, a 160 MiB cache (the desktop allows 128,
  256 and 384 MiB).
- A Pivot import carries its verified original in its document instead of a lease in the
  codec, so nothing depends on the codec worker outliving the import.
- The first Pivot import or export says that the converter is loading.
- There is no workspace: no sample listing and no opening by path.

One request runs at a time. The site is cross-origin isolated, so cancelling the running
import sets a flag in shared memory and the codec stops at its next checkpoint, keeping the
worker and its cache. A browser that is not isolated cannot share that flag: there,
cancelling the running import stops the codec worker and the next request starts a fresh
one; if other jobs are waiting on it, the cancelled job is skipped instead, so nobody
else's request is lost.

## What works in the browser

| | Web |
| --- | --- |
| Editing, animating, drawing, timeline, undo, IK, effects | Same code as the desktop app |
| Rendering | WebGPU, or WebGL2 |
| `.styk` / `.stkz` / `.stykmov` save and open | Yes (a download on save, the file dialog on open) |
| Pivot `.piv` / `.stk` import and export | Yes, the WebAssembly codec; an unchanged import re-exports byte for byte |
| Stick Nodes import | Yes |
| PNG, SVG, GIF, APNG, PNG/JPEG/GIF/SVG sequences | Yes |
| WebM video | Yes, WebCodecs VP8/VP9 with Opus sound (opaque background) |
| MP4 video | Yes, WebCodecs H.264 with AAC sound, where the browser can encode them (opaque background) |
| AVI, WMV, installed Windows codecs | Desktop only, offered with a reason |
| Install as an app, start with no network | Yes, a service worker stores the editor and the Pivot codec |
| Autosave and crash recovery | Yes, IndexedDB (see [below](#autosave-and-the-libraries-in-the-browser)) |
| My library | Yes, in the browser's own storage (IndexedDB) |
| Community library | Yes, through the editor's own origin |
| System fonts | Where the browser offers local fonts (Chromium); otherwise open a font file |
| Feedback, telemetry, updates | Not present |
| Phones and tablets | The touch interface: layouts, gestures and sheets made for fingers and pens ([docs/TOUCH.md](TOUCH.md)) |

`tests/web-build.browser.mjs` runs the built site in a real browser, including
under Cloudflare's own runtime (`wrangler dev`), and covers boot and rendering,
native save and open, the Pivot export/reopen/re-export round trip, the PNG, SVG,
GIF, WebM and sequence exports, and the desktop-only formats being offered with a
reason. It fails on any console error, page error or CSP violation. Stick Nodes
import, crash recovery and local fonts use the same code as before in the browser
and are not part of that test.
