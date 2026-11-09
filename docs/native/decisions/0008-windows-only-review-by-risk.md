# N8. Windows only in this phase; who builds what; checking scaled to risk

**Date:** 2026-11-07 (the owner; the final working rules of the same day replace the first version where they differ).
**Status:** accepted; overrides the phase prompt and the briefs where they conflict.

**Scope.** Every feature of today's app and every new one (docking, the new Settings, the developer tools, the
design-studio hooks), shipped and verified on Windows. macOS, Linux and the web build are not tested, run or packaged in
this phase (S5 is wrapped up with its constraints, `docs/native/web.md`). Adding them later is a port: every OS call behind
`styk-platform` traits, the GPU through wgpu only, nothing in the core or the engine a wasm32 or Unix target could not
build; a `cargo check` for wasm32 at gates.

**Roles.** The orchestrator (Opus) plans, cuts medium-sized chunks, writes the briefs, chooses each chunk's implementer
and reviewer, owns the architecture and has the last word on every merge; GPT-6 Astra (xhigh, read only) gives second
opinions on architecture or strategy. One Opus implementer, once: the reference slice (the interface architecture and the
Inspector on it, with `docs/native/patterns.md`). GPT-6 Astra implements most back-end and logic work (the engine host and
documents, `styk-platform` and `styk-services`, the developer tools' engine and `xtask`, export and audio plumbing, the
updater, the library, network services, and the logic behind screens in `styk-core`), never views. Sonnet implements
screens, panels, dialogs, menus and styling, and easy back-end work; interface fan-out starts after the reference slice
merges. GPT-6.1 Sol is the only reviewer, of back-end and logic work and of complex interactions, not of plain screens.

**Logic out of the screens.** Every feature is its logic (`styk-core` or the services) and its view; a view shows state and
sends messages, never decides behaviour or calls the engine. A view that hides logic is rejected at the merge.

**Checks by risk.** High risk (saving, recovery, formats and bytes, undo and history, the session, threading and locks,
input, playback and audio sync, export, memory and resource lifetimes): Astra implements, Sol xhigh reviews (one re-check
after a blocker), tests that fail without the change, byte checks where bytes matter, the orchestrator reads the whole
diff. Normal back-end: Sol high once; the orchestrator reads the findings and the architectural parts. Complex interaction
(the timeline, stage tools, the docking view, text fields): Sonnet on the core logic, Sol high once. Plain screens: a
screenshot compared with today's and one automated interaction through the automation mode; the orchestrator reads the
report and spot-checks the diff.

**Automatic guards** in `cargo xtask check`, early in the skeleton: dependency direction; no `windows` crate, Win32 types
or `cfg(windows)` outside `styk-platform`; no `unwrap`, `expect` or ignored `Result` in interface crates outside tests;
clippy `disallowed_methods` for file I/O, `sleep` and blocking waits in interface crates; views never import the engine; new
dependencies only from an allow list the orchestrator keeps; a screenshot difference limit per screen.

**A merge train, not catch-up rebuilds** (the owner, 2026-11-08). A finished chunk is not merged with `native-app` to be
re-tested on newer work; only on a real conflict or a dependency on code merged after it started. Reviewed chunks (their
own tests, review and the orchestrator's diff read done on their branches) merge onto `native-app` three or four in a
row, then one combined pass runs on the result (build, the changed crates' tests, `cargo xtask check`). High-risk chunks
and chunks that touch the same files or crates merge alone, with their own pass on the merged result. A failed pass stops
all merges until it is fixed (the culprit by the failing area, reverted if the fix is not quick); nothing is pushed or
branched from an untested train head. When a combined pass fails and the failure is small,
a fresh fixer (Astra for back-end and logic, Sonnet for interface code and mechanical breaks) gets the merged chunks, the
failing check with its output and the files; it finds the culprit and fixes it at the owner, never weakening a test,
touching frozen tapes and fixtures, loosening a threshold or adding a special case, and stops and reports when the real
fix is large, unclear or changes the design. Its diff gets the orchestrator's read (and Sol when it touches back-end,
logic or a high-risk area), then the pass runs again; other merges wait only during a small fix. The chunk is reverted
and sent back with the failure instead when the failure is in a high-risk area, the cause is unclear after one attempt,
or the fix would change the design. **Cheap checks while coding**: implementers iterate with `cargo check` and
`cargo clippy` on the crates they touch and build and test when a piece is done, only the changed crates; every chunk still
ends with its full done criteria.

**Cheaper interface work** (the owner, 2026-11-08): chunk K-fastui, after K-cmd and before the screen fan-out, adds a
developer-only `styk-screens` binary that renders catalogue screens headless from fixture view models through exactly the
app's view functions, widgets, fonts and renderer (pixel-identical to `stykanimate --screen`, checked at gates; never
shipped), for implementers' screenshot loop; the real app's screen check still runs before a chunk is done and before
every merge. It also measures `rust-lld` against the MSVC linker and switches dev and test builds only if clearly faster
with every test, guard and the release-isolation check passing. **Interface parity** (the owner, 2026-11-08, replacing stricter readings of 1:1): someone comparing the two apps side
by side sees the same app: layout, sizes and spacing within about 1 px, the same colours, fonts, weights, icons, radii,
states, text and noticeable behaviour. Identical anti-aliasing, ClearType edges, glyph rasterisation, dithering, sub-pixel
positions, exact pixel counts and millisecond timing are not required. Screenshot checks guard against mistakes: pixels
count as different past a channel difference of 24; a complete screen's limit sits a little above what it measures; the
agent compares the images at 100 % and 200 %, and a screen with nothing visibly different is done. Engine parity (saved
and export bytes, evaluation, the parity suites) stays exact.

**Proof** proportionate to risk (no exhaustive sweeps unless a real failure calls for one; representative scenes; full
suites at gates). **Reports** of about 30 lines (what changed, checks and results, screenshot scores, departures from the
brief, risks). Short Handoff updates at merges; decision records only for real decisions.

**Process additions** (the owner, 2026-11-08, to cut rework without lowering the bar; the time went into rework, not
reviews, and the findings repeated the same types): (1) every implementer checks its diff against the "Known findings"
list in `perf/briefs/native-common.md` before handing in and reports `Self-check: done`; the list grows when Sol finds a
new recurring type; (2) high-risk and new-owner chunks write a half-page plan first (ownership, data flow, commands and
routing, persistence, close and quit), which Sol (high) checks before coding; plain screens on an existing core API need
none; (3) blockers and every finding about logic, ownership, routing, persistence, focus or keyboard, input, tests,
performance or the risk list are fixed before the merge; only purely cosmetic findings in screen chunks may merge with an
entry in the workspace's polish list in the Handoff, which one fixer clears before that workspace's gate (when in doubt,
not cosmetic); (4) no idle implementers: while a fixer works on one chunk, the next independent chunk starts. Screen
chunks with new behaviour stay two steps (Astra's core part, then Sonnet's views). Sol stays the only reviewer, blockers
block, high-risk chunks get xhigh and the orchestrator's full read.

**Throughput** (the owner, 2026-11-09; quality rules unchanged, the problem was parallelism): GPT-6 Astra stays the main
back-end and logic implementer and Opus 5.5 at medium effort is added beside it as extra back-end and logic capacity,
under the same reviews (this replaces "one Opus implementer"); Sonnet 5.5 stays the screens implementer; Sol stays the
only reviewer. Five or six implementers run whenever ready work exists, from a written plan (step 3:
`perf/briefs/native/step3-plan.md`). For screen chunks the core's interface is committed first and the views are built
against it while the logic is finished, on one branch with one review. Freezes stop merges only, never new chunks or
ongoing work. Merge conflicts, train passes and their small fixes go to a merge fixer; disk cleanup is a script. First
priority: the visible loop in the real app (open, stage, select, edit in Properties); then the skeleton gate; the
docked window's part 2 after it, during step 3.

**Model balance** (the owner, 2026-11-09, from the next chunk started; running work is not restarted): the Codex quota
is running down, so Opus 5.5 becomes the main back-end and logic implementer, at medium effort by default and xhigh only
for genuinely hard high-risk chunks (saving and formats, undo, the session, threading, playback and audio, export,
memory), sparingly and with a reason in the brief. GPT-6 Astra stays available for a minority of chunks, chiefly where a
chunk already has its context (fix rounds on its own diffs). Sonnet 5.5 stays the screens and views implementer; GPT-6.1
Sol stays the only reviewer with depth by risk. The machine is the ceiling (3 heavy jobs, a saturated 6-core CPU): the
agent count stays about where it is, implementers batch their final heavy runs into one queued job, and V0 has priority
in the queue.

**Gate 2 first and real-window usability** (the owner, 2026-11-09 afternoon): the skeleton gate is finished completely before step 3 continues; running step-3 work finishes its round and waits. After the owner found the app unusable in a 3-second test (lag, freeze, flicker, no handles) that no check had caught, the gate gains real-window usability checks on a release build (frame-time budgets beside Electron, a freeze watchdog, no blank or "preparing" frames, handles by screenshot, a recorded manual-style pass), visible content is never blanked for pending work, and the owner gets a release build in `perf/try/` after each gate-relevant merge.
