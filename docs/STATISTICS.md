# Statistics

StykAnimate sends anonymous statistics about how it runs: whether work is safe, whether the editor stays
responsive, whether old files open, and whether it crashes. They exist to answer those four questions for
every release, and to tell the people and agents who work on the app what to fix first.

This document is the contract. `src/stats/schema.mjs` is its machine-readable half: what that file does not
describe is not sent. Change both together.

## What is sent

One upload is a small JSON batch: the app's version, channel and platform, the machine in wide steps
(integrated or separate graphics, the graphics vendor, memory and processor count rounded up to a step, the
display's refresh rate, the graphics backend), and up to 16 reports. There are three kinds of report.

| Report | When | What it holds |
| --- | --- | --- |
| `session` | Once per session, after it ends. For a session that ended badly, at the next start. | How long the app was open and in use, how the session ended, the language and timeline mode, which features were touched, how far the session got (edit, play, save, export), a few whole-number counts, the largest project as ranges, file operations as counts per format, and the responsiveness numbers below. |
| `problem` | Each distinct error, engine stop, freeze, lost graphics device or lost window. | The error text made safe (`sanitizeMessage`), the message key when the app raised the error itself, up to 12 stack lines through our own code, what the app was doing, the names of the last 20 commands, the scene size and the features that were on. |
| `file` | Each open, save, export or recovery that failed. | The format and the program and format version that wrote the file, sizes as ranges, the stage and the reason, and for a save whether the file that was on disk is still as it was. |

A session's responsiveness numbers are a list of cells, one per thing the person did (`drag`, `play`,
`scrub`, `view`, `draw`) and scene size. Each cell holds frames counted, frames late, a frame-time histogram,
the worst frame, and where the time of the late frames went. The five slowest moments of the session are
listed separately with the same breakdown.

## What is never sent

- Anything from an animation: figures, frames, pictures, sound, text.
- Names of files, folders, figures or layers. Error text loses everything in quotes and every path, address
  and e-mail address before it is queued; the intake refuses text that this cleaning would have changed.
- Keys typed and pointer positions.
- Screenshots, recordings, traces.
- The model of the computer or of its graphics card.
- Any identifier of the installation or the person.

## Why it is anonymous

- **No installation identifier.** A session has a random 32-character id that exists only to tie that
  session's reports together and to let a retried upload be recognised. It is made when the session starts
  and forgotten once its summary is delivered. Nothing links two sessions.
- **The app answers the "same installation" questions itself.** It keeps, on the computer only, the day it
  was first run and the days it was last used, and sends four yes-or-no facts with a session: first session
  ever, first of this day, first of this week, and first in the second week after the first run. Active
  installs, new installs and people who came back are sums of those facts.
- **Ranges, not values.** Sizes, memory, processor count and project dimensions are steps.
- **The service stores no network address.** It uses the address to answer the request and to limit abuse
  for a minute, and writes nothing derived from it to its database. Cloudflare, which hosts the service,
  handles addresses to deliver requests, as any web host does.
- **Small groups stay hidden.** The dashboard shows a comparison only when at least 20 sessions stand
  behind it.

Anyone can send a made-up report to a public address. The intake checks every field, limits how much one
address and one day can add, and the dashboard's minimum group size keeps a handful of false reports from
moving a number; it cannot make false reports impossible.

## On and off

Statistics are on unless a person turns them off.

- **The first-start line:** while statistics are on and the line was not answered (`noticeSeen` false), Home
  shows one quiet line at the top of its page: "StykAnimate sends anonymous statistics about speed and
  crashes. Nothing from your animations." with "What is sent", "Turn off" and "OK". It stays, on every visit to
  Home, until one of "OK" and "Turn off" is pressed: both answer it for good (`markStatsNoticeSeen`), and "Turn
  off" also turns statistics off and says once that Preferences, Privacy turns them on again. "What is sent"
  opens "See the last report" and leaves the line in place. Using the switch in Preferences answers it too.
- **Nothing leaves before the line was shown:** the desktop process uploads only once Home has displayed the
  line on this installation (`noticeShown` in `stats-state.json`, set through `markStatsNoticeShown` the first
  time the line is on screen with no dialog over it) or the line was answered. Counting and queueing may run before that. A person who
  starts the app with Home turned off (Settings › Interface) keeps their reports on the computer until they
  visit Home once.
- **Preferences, Privacy** (`src/privacy-settings.mjs`): a switch "Send anonymous statistics", "See the last
  report" (a dialog with exactly what `previewStats()` returns, the last batch sent and what is waiting, as
  JSON, with Copy; "Nothing has been sent yet" before the first upload), and "Privacy note", which opens the
  website's privacy page (`openServicePage('privacy')`; the main process opens only its own fixed pages). Forced
  off, the switch is off and disabled with a line that says so; in a development run that uploads nothing, a
  line says reports are collected but not uploaded. The Help menu's item, the `privacy` command and a
  `stykanimate://privacy` link open Preferences at this section (`openPrivacy`). The browser build has no
  desktop bridge and shows neither the line nor the section.
- **Off means off:** no counting on the frame path, no queue on disk, no upload, and what was waiting is
  deleted. The environment variable `STYK_NO_STATS=1` forces off and hides the line and the switch's effect.
- **People who answered the old consent window:** whoever chose Reject there starts with statistics off and
  is not shown the line. Everyone else starts with them on and sees the line until they answer it. The old file
  (`telemetry-state.json`: identifier and queued summaries) is deleted at the first start of the new version.
- **Development runs** (an unpackaged app) collect and show "the last report" but upload only when
  `STYK_SITE_URL` names a local site (`http://127.0.0.1` or `http://localhost`). Tests and smoke scripts never
  reach the network: the smoke scripts and the desktop tests start with statistics off (`stats-state.json` written
  into their scratch data folder, or none at all in a fresh one, which uploads nothing in a development run), except `scripts/smoke-boot.mjs`, which checks that a development run collects and sends nothing.
- **The developer tools' page** (`npm run dev`, or the profiling command in Chrome) collects in memory even
  without a desktop process, and sends nothing, so the profiling command can read the same numbers.

## How much is sent

The app has many more users than the service needs reports from, and the service runs on a free hosting plan. So
the service says, in its answer to every upload, what share of sessions it wants: one of 100, 50, 25, 10, 5, 2
or 1 percent (`SAMPLE_STEPS`). The app remembers the share. When a session starts, the app draws a random
number: a session that is not chosen counts nothing and sends nothing, exactly as if statistics were off for
that session, except that the day still counts for the installation's own `first` facts. A chosen session's
reports all carry the share in force when it was chosen (`sample`), so the dashboard can estimate totals from
the sample. An installation reports every session until an answer tells it otherwise, so its first session is
always reported.

The service sets the share once a night from how many sessions the day before would have been at 100 percent
and how many it aims to store a day.

## The numbers

**Frames** (`src/stats/frames.mjs`). While a person drags, plays, scrubs, moves the view or draws, every frame
the frame loop draws for it is counted: a display callback in which the stage presented a picture (an edited
frame drawn, or a prepared one shown). What the person is doing is read when the frame is drawn: playing,
then scrubbing, drawing, moving the view (pan, zoom, a wheel zoom still gliding), then dragging (any editing
gesture). A frame's time runs from the callback that drew it to the next display callback, which is when it was
replaced, so a frame whose work overran its refresh shows as a longer interval. The first frame of a burst (the
callback before drew nothing for this interaction) is timed from the first input after the previous counted
frame (pointer, wheel or key, only its timestamp is kept) to the end of its paint. A frame after which the loop
stops ends with its paint. A frame is **late** when it took more than one and a half display refreshes
(`isLate`; 25 ms on a 60 Hz display). The refresh interval is the shortest of the last 32 intervals between the
loop's own display callbacks (`src/playback-cadence.mjs`), so a stall does not lengthen it. **Smooth share** is
one minus late over counted. Frames in a window that is hidden or unfocused are not counted.

The frame loop calls the counter three times a display callback (`tick`, `drawn`, `end`), each behind
`if (stats.on)`: with statistics off it is never called and takes no clock read.

**Scene size** is the number of draw-list primitives the stage drew for the frame on show: the stage's
`stats.primitives` (`src/engine/engine-stage.mjs`), which is styk-render's `Stats.prims` for the last frame
drawn, edited or prepared. Each visible segment is one primitive; faces, pictures, text and onion skins add
theirs. It is read at most twice a second, in five ranges (`sceneOf`).

**Where the time went.** Each late frame's time is split over the stages of `STAGES`. Three come from spans of
`src/trace.mjs`, the same spans the developer tools record, which the collector hears by name and duration
while statistics are on (`listenSpans`):

| Stage | What it measures |
| --- | --- |
| `edit` | `edit session call` spans: every call into the edit session (src/engine/engine-owner.mjs `sessionCall`), in the frame's callback or before it |
| `geometry` | `stage geometry` spans: an edited frame's poses, session view and onion skins sent to the engine (engine-stage.mjs `drawEdit`, before `render_edit`) |
| `draw` | `stage submit` spans (the engine drawing and submitting an edited frame) and `stage draw prepared` spans (a prepared frame shown) |
| `interface` | the frame loop's paint (`paint`) less its `geometry` and `draw`: overlays, the camera monitor and the interface's own work in the paint |
| `wait` | for the first frame of a burst: from its input to the display callback that drew it (waiting for a prepared frame, or for the interface) |
| `other` | the rest of the frame's time: work outside the paint before the next display callback (other tasks, the browser's own) |

The list had `evaluate` and `overlay`; no span measures them on their own (evaluation runs inside the edit
session's calls and the engine's draw, overlays inside the paint), so they were removed rather than reported
as zeros. A cell sums the stages of its late frames; a slow moment keeps its own. Every slow moment is one of
the frames counted in the cell with the same `doing` and scene size.

**A session** (`src/stats/session.mjs`) starts when the desktop process starts (or the window's page is reopened
after its process was lost) and ends when the app quits. Its `day` is the UTC day on which it started. Its
summary is sent once; a repeat is a retried upload, and the intake keeps one. `minutes` counts time with the window in front and
either input in the last minute or an animation playing, in steps of 15 seconds; `mode` splits those minutes
by the timeline mode. `commands` are the 24 most used ids of the command registry (`src/ui/command-catalog.mjs`)
run through the app's command dispatch; another name is never counted. Features are touched by the commands
that use them and by a few direct uses (the library tab, node IK, a building tool). `reached`: `edit` at the
first edit, `play` at the first playback, `save` and `export` at the first that succeeded. `project` is the
largest project on show during the session, by scene size and then by figures drawn; its `frames` is the animation's
length in frames (ticks), not its keyframes.

`counts` are whole numbers, each capped (`COUNTS` in schema.mjs), and absent when zero:

| Count | What it counts |
| --- | --- |
| `edits` | finished edits of the document (a live drag counts once, when it ends) |
| `undos`, `redos` | the `undo` and `redo` commands |
| `keyframes` | keyframes made with a command: `add-frame` (Add frame), `extend-keyframe`, `insert-blank-key` and `insert-copied-key`. Keyframes made any other way are not counted |
| `plays`, `playSeconds` | playbacks started, and the seconds they ran |
| `opens`, `saves`, `exports` | file operations of that kind that succeeded (a save is one the person asked for, not an autosave) |
| `commands` | commands of the registry run through the command dispatch |
| `graphicsLost`, `graphicsBack` | the graphics device lost, and back |
| `problems` | problems the collector heard, repeats included (each distinct one is a `problem` report once) |

A session ends `clean` when the app quit in order, `crashed` when the window's process was lost, and `unknown`
when the next start finds it was never closed (power loss, a forced end, a crash of the whole app). A session
that ended badly carries `unsaved`: whether any open project had unsaved changes, as the main process last
knew it (the window's document state). `recovery` is filled at the start that follows: `offered` when the
app offered recovery copies that no open project owns (`offerRecovery` in src/app.mjs, the copies
desktop/recovery.cjs keeps of projects with unsaved changes), then `restored` or `failed` for a copy the person
chose to restore.

**`when`** is the local weekday (0 is Sunday) and part of the day (`dayPartOf` of the local hour) at which the
session started.

**The four `first` facts** use the computer's own days, and weeks that run from Monday to Sunday: `ever` is the
first session of the installation, `day` its first on this day, `week` its first in this week, and `back` its
first on days 7 to 13 after the day of the first run.

**Files** (`src/stats/files.mjs`). A session counts each open, save, autosave (the recovery copy written in the
background), export and recovery (a copy restored) by format: succeeded, failed, cancelled, and the time the
successes took. A failure also becomes a `file` report with its stage and reason: a worker marks the failures
it posts (`fileStage`, `fileReason`), and an error otherwise gives its reason by its operating system code or
message key. `made` is the program and format version that wrote an opened file, as the engine's reader
reports it (`pivot/5`, `stykanimate/12`). `kept` is `untouched` for a save that failed before writing (the file
on disk is replaced only by a finished write) and `unknown` for one that failed while writing. A session keeps at most
16 rows (one per operation, format and `made`); a further row is not counted.

The words these use (`FORMATS`, `FILE_STAGES` and `FILE_REASONS` in schema.mjs), where the name does not say it:

| Word | Means |
| --- | --- |
| `styk` | a StykAnimate project (`.styk`, or the older `.json`) |
| `styk-figure`, `styk-movieclip` | a StykAnimate figure (`.stkz`) and movieclip (`.stykmov`) |
| `pivot-animation`, `pivot-figure` | a Pivot animation (`.piv`) and figure (`.stk`) |
| `sticknodes`, `sticknodes-figure`, `sticknodes-movieclip` | a Stick Nodes project (`.stknds`), figure (`.nodes`) and movieclip (`.nodemc`) |
| `archive` | a `.zip` opened for the Stick Nodes files in it |
| `picture` | one picture (`.png`, `.jpg`, `.webp`, `.bmp`): an opened picture, or a single frame exported |
| `apng` | an animated PNG export |
| `picture-sequence` | an export of every frame as its own picture (PNG, JPEG, GIF or SVG), delivered as one `.zip` |
| `video`, `sound`, `gif`, `svg` | as named; `unknown` is anything else |
| stage `request` | the call to the file service that converts Pivot and Stick Nodes files (`src/codec-request.mjs`), which runs in a worker of the page |
| reason `transfer-failed` | the document, or a result, could not be handed between the page and a worker: the browser could not copy it across, or the export worker failed while taking the document in |
| reason `service-unavailable` | that file service answered with an error of its own (status 500 or above), or an export's request to it got no answer |

**Problems** (`src/stats/problems.mjs`). Uncaught errors and rejections, errors the app shows (`fail`), engine
refusals of a frame (`renderer` errors), a lost graphics device and its return, failed saves, opens and
exports (also `file` reports), engine panics on any thread, and from the main process the window's process
lost (`window-gone`, with Electron's reason word) and the window not responding (`frozen`). A person's cancel
and an action refused with a message to them are not problems. The same problem in the same session is one
report, sent once: `times` is how often the session hit it before the report was uploaded. The text loses
everything `sanitizeMessage` removes. It is the text the code wrote, in English, never a translated interface
message: an error the app raised itself (`messageError`) sends its message key, and as its message the English
text of that key with its placeholders left unfilled. The stack is our own code only (`src/stats/stack.mjs`), at most 12 lines:

- JavaScript: `function src/<path>:<line>` for a script the app's own origin serves from `/src/` (not
  `src/devtools/`, not `vendor/`). In the packaged app the bundle's lines are read back to their module through
  the line tables `scripts/build-app.mjs` writes to `src/frame-map.json` for every module of ours (all of `src/`
  but the engine's generated glue and the language files), fetched the first time a problem is described:
  nothing reads them at start. A worker's failure brings its stack text to the interface thread, where it is
  read the same way.
- The engine: the panic hooks (engine/crates/styk-wasm/src/lib.rs `start`, and the codec's and the drawing
  engine's) write `StykAnimate … panic: panicked at <file>:<line>:<column>:` and the message to `console.error`.
  `src/engine/engine-panic.mjs` keeps that text on the interface thread and in every engine worker; a worker
  posts it with the failure it causes (the preparation threads, which post no failure, send it on its own).
  The report is of type `engine`: the message, the Rust place as `<crate>/src/<file>.rs:<line>` (never the
  path it was built at), then the Rust functions of the WebAssembly stack the hook ran in, without their hash,
  generic arguments and the panic machinery. The trap that follows a panic is not reported again.

## How it flows

```
editor (src/stats/)  ──►  desktop process (desktop/stats.cjs)  ──►  https://stykanimate.com/api/v1/stats
  counts, builds reports     checks, queues on disk, uploads            checks again, stores, no address kept
```

The editor's collector (`src/stats/collector.mjs`) holds the session in memory and hands the desktop process a
fresh summary at most once a minute and when the page is hidden or closed, and each problem and failed file
operation as it happens. The desktop process validates everything with `schema.mjs`, adds what only it knows
(the session's id, day, ending, the four `first` facts, the installation's age range and the time of day), and
keeps two files: `stats-state.json` in the app's data folder (on or off, the line shown and answered, the first-run day,
recent days of use, the last batch sent) and `stats-session.json` in the window process's own folder (the
running session and the queue: at most 64 reports and 7 days). A second window process (another workspace)
keeps its own session file in its workspace folder.

It uploads about five seconds after the app starts, when it quits (waiting at most two seconds), and every 30
minutes while reports other than the running session are waiting; at most 16 reports and 32 KB a batch, oldest
first, four batches an upload at most. The running session's summary is never uploaded while it runs, and
nothing is uploaded before the first-start line was shown ("On and off"). The
request is `POST <site>/api/v1/stats` with the JSON batch, no other header than its content type and no
identifier. The intake's answers:

| Answer | The desktop process |
| --- | --- |
| 200 `{ok: true, sample: 25}` | removes the batch's reports from the queue, keeps the batch as the last sent, and remembers the share for the sessions that start from now on ("How much is sent") |
| 400, 413, 422 | drops the batch's reports, never retried |
| 429, 5xx | keeps them; tries again after `Retry-After` seconds (at most a day) or 30 minutes |
| 410 | drops the batch and uploads nothing for a day (collection is paused) |
| anything else, a network error, a 200 without `{ok: true}` | keeps them; tries again in 30 minutes |

The bridge the preload script exposes (`window.stykDesktop`), all of it:

| Call | Does |
| --- | --- |
| `getStatsState()` | `{enabled, counting, forcedOff, noticeSeen, uploads}`: `counting` is false while statistics are off and in a session that was not chosen ("How much is sent"); the editor collects only while it is true. `uploads` is false in a development run without a local site |
| `setStatsEnabled(on)` | turns statistics on or off and returns the state; using the switch also answers the first-start line |
| `markStatsNoticeSeen()` | records that the first-start line was answered ("OK" or "Turn off"): Home no longer shows it |
| `markStatsNoticeShown()` | records that Home displayed the first-start line: from then on uploads may go |
| `sendStatsSession(summary, facts)` | the running session's summary so far; `facts` are what only the page knows of the machine: the graphics backend and the refresh rate it observes |
| `sendStatsReport(report)` | one `problem` or `file` report |
| `previewStats()` | `{lastSent, waiting}`: the last batch uploaded and the reports queued |
| `onStatsState(callback)` | the state, whenever it changes |

## Reading the statistics

The dashboard is the site's admin, behind its sign-in. Agents and scripts read the same numbers with
`npm run stats` (`scripts/stats.mjs`), which asks the site's report views (`GET /api/v1/admin/stats/<view>`, described in
the website's `worker/stats/README.md`) and prints them as short text, or unchanged with `--json`.

- `STYK_STATS_KEY`: the read-only key. It is kept in the environment and never written into this repository,
  which is public; the owner makes it and sets it on the website with `npx wrangler secret put STATS_READ_KEY`.
  The reader never prints it and sends it only to the one origin below, following no redirect.
- `STYK_STATS_URL`: the site, `https://stykanimate.com` when unset. `http:` is accepted only for `localhost` and `127.0.0.1`.

| Command | What it prints |
| --- | --- |
| `release [version]` (the default) | the four promises with their change and reason, and what needs attention |
| `findings`, `show <id>` | the findings (at most three); one finding whole, with its evidence and its brief for an agent |
| `responsiveness [doing]` | smooth share by scene size and machine class for `drag`, `play`, `scrub`, `view` or `draw`, where the late frames' time went, and the profiling command that reproduces it |
| `safety` | saves, recovery, file opens and exports, and why they failed |
| `problems`, `problem <signature>` | what broke; one problem with its stack, trails, what the sessions share and its brief |
| `usage`, `curiosities` | who uses the app and how; numbers worth a smile |

Every command takes `--release`, `--compare <version|none>`, `--days 7|30|90`, `--platform`, `--channel`, `--fresh` and `--json`;
`npm run stats -- help` lists them. Each text says how fresh its numbers are and, when the period was sampled,
that its totals are estimates. The exit code is 0 when the view was read, 1 when the site refused or could not
be reached, and 2 for a wrong command line or setting (nothing is sent then).

```text
$ npm run stats -- release 9.1.0
StykAnimate 9.1.0 · 6 days out · 1,050 sessions · compared with 9.0.0
9.1.0 needs attention: a new engine stop reached 28 sessions, and 5 more things to look at.

  Work is safe       99.7%    -0.3
  Stays responsive   97.1%    -0.9   dragging, 50,000-200,000 segments, integrated graphics under 16 GB
  Old files open     97.3%    same   8 of 42 opens of Stick Nodes 4.3 files failed
  Doesn't crash      97.0%    +0.2   28 sessions hit an engine stop (new)

Needs attention
  E-a786  The engine stops: index out of bounds: the len is # but the i…  critical, new in 9.1.0
  R-ff75  Dragging stutters in scenes of 50,000 to 200,000 segments on…   worse than 9.0.0
  F-5a1c  Stick Nodes 4.3 files fail to open                              since 9.1.0
  and 3 more not shown (the views give the three that reach most sessions)

Numbers to 2026-11-12 23:30 UTC · last 7 days (2026-11-06 to 2026-11-12) · stable channel, all platforms
9.0.0's totals are estimated from a sample.
Next: npm run stats -- show E-a786        (add --json for the numbers alone)
```

(Releases 9.1.0 and 9.0.0 are the synthetic ones of the tests, `tests/stats-reader.test.mjs`.)

A responsiveness finding names the command that reproduces it at a desk: `npm run perf -- run` with the scenario of
the activity and the workload nearest the scene size ([PERFORMANCE.md](PERFORMANCE.md)). That tool measures frames
with the developer tools' recorder, not with the collector's counter, so judge a change by
`npm run perf -- compare <the run before>`, and expect the dashboard's smooth share to follow once a release is out.

## Checks

- `node --test tests/stats-schema.test.mjs`: what a report may hold, the words the app uses, and the text cleaning.
- `node --test tests/stats-collector.test.mjs`: the frame counter, problems, engine panics, file failures, the
  summary, off meaning off, and the trace layer's listener.
- `node --test tests/stats-service.test.mjs`: the desktop service (queue, migration, off, the boundary, uploads
  and each answer, the three endings, the `first` facts), the bridge and the packaged files.
- `node --test tests/stats-interface.test.mjs`: when Home shows the first-start line and what its buttons do, the
  Privacy section's states and controls, and what "See the last report" shows.
- `npm run test:privacy` (`tests/privacy.browser.mjs`): the line on Home and the Privacy section in a page, with a
  desktop bridge faked in it.
- `npm run test:stats` runs the four unit test files. `tests/devtools.test.mjs` holds the trace layer to its guarantees with a
  listener, and `tests/app-bundle.test.mjs` the line tables.
