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
  for a minute, and writes nothing derived from it.
- **Small groups stay hidden.** The dashboard shows a comparison only when at least 20 sessions stand
  behind it.

Anyone can send a made-up report to a public address. The intake checks every field, limits how much one
address and one day can add, and the dashboard's minimum group size keeps a handful of false reports from
moving a number; it cannot make false reports impossible.

## On and off

Statistics are on unless a person turns them off.

- **First start:** Home shows one line, once: what is sent, with "What is sent", "Turn off" and "OK".
- **Preferences, Privacy:** a switch, "See the last report" (the exact JSON last sent and what is waiting),
  and a link to the privacy note on the website.
- **Off means off:** no counting on the frame path, no queue on disk, no upload, and what was waiting is
  deleted. The environment variable `STYK_NO_STATS=1` forces off and hides the line and the switch's effect.
- **People who answered the old consent window:** whoever chose Reject there starts with statistics off and
  is not shown the line. Everyone else starts with them on and sees the line once. The old file
  (`telemetry-state.json`: identifier and queued summaries) is deleted at the first start of the new version.
- **Development runs** (an unpackaged app) collect and show "the last report" but upload only when
  `STYK_SITE_URL` names a local site. Tests and smoke scripts never reach the network.

## The numbers

**Frames.** While a person drags, plays, scrubs, moves the view or draws, every frame the interface thread
produces is counted: its time is the interval between two display callbacks in which the stage was drawn for
that interaction. The first frame of a burst is timed from the input that started it. A frame is **late**
when it took more than one and a half display refreshes (`isLate`; 25 ms on a 60 Hz display). The refresh
interval is the one the app observes from its own display callbacks. **Smooth share** is one minus late over
counted. Frames in a window that is hidden or unfocused are not counted.

**Scene size** is the number of segments the engine drew for the frame on show, as reported by the stage,
in five ranges (`sceneOf`).

**Where the time went.** Each late frame's time is split over the stages of `STAGES`, measured by the spans
of `src/trace.mjs`, the same spans the developer tools record. A cell sums the stages of its late frames;
a slow moment keeps its own.

**A session** starts when the window is ready and ends when the app quits. `minutes` counts time with the
window in front and either input in the last minute or an animation playing. A session ends `clean` when
the app quit in order, `crashed` when the window's process was lost, and `unknown` when the next start finds
it was never closed (power loss, a forced end, a crash of the whole app).

**Files.** A session counts each open, save, autosave, export and recovery by format: succeeded, failed,
cancelled, and the time the successes took. A failure also becomes a `file` report with its stage and
reason. `made` is the program and format version that wrote an opened file, as its reader reports it.

**Problems.** The same problem in the same session is one report with a count. The stack is our own code
only: module and line for JavaScript (through the bundle's line tables), function names for the engine,
and the Rust file and line from the engine's panic message.

## How it flows

```
editor (src/stats/)  ──►  desktop process (desktop/stats.cjs)  ──►  https://stykanimate.com/api/v1/stats
  counts, builds reports     checks, queues on disk, uploads            checks again, stores, no address kept
```

The editor's collector holds the session in memory and hands the desktop process a fresh summary at most
once a minute, and each problem and failed file operation as it happens. The desktop process validates
everything with `schema.mjs`, keeps a bounded queue in the app's data folder (at most 64 reports and 7 days),
and uploads when the app starts, when it quits (waiting at most two seconds), and every 30 minutes while
reports other than the running session are waiting. An upload the intake refuses as invalid is dropped, never
retried; one it cannot take now is retried later.

The bridge the preload script exposes (`window.stykDesktop`), all of it:

| Call | Does |
| --- | --- |
| `getStatsState()` | `{enabled, forcedOff, noticeSeen, uploads}`: `uploads` is false in a development run without a local site |
| `setStatsEnabled(on)` | turns statistics on or off and returns the state |
| `markStatsNoticeSeen()` | records that the first-start line was shown |
| `sendStatsSession(summary)` | the running session's summary so far |
| `sendStatsReport(report)` | one `problem` or `file` report |
| `previewStats()` | `{lastSent, waiting}`: the last batch uploaded and the reports queued |
| `onStatsState(callback)` | the state, whenever it changes |

## Reading the statistics

The dashboard is the site's admin, behind its sign-in. Agents and scripts read the same numbers with
`npm run stats` (`scripts/stats.mjs`), which needs a read-only key in the environment variable
`STYK_STATS_KEY`; the key is never written into this repository, which is public.

The profiling command (`scripts/styk-profile.mjs`, [DEVTOOLS.md](DEVTOOLS.md)) reports smooth share with the
collector's own frame counter, so a number from the dashboard and a number from a desk mean the same thing.

## Checks

- `node --test tests/stats-schema.test.mjs`: what a report may hold, and the text cleaning.
- `node --test tests/stats-*.test.mjs`: the collector, the desktop service and the bridge.
