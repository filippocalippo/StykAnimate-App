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

**Proof** proportionate to risk (no exhaustive sweeps unless a real failure calls for one; representative scenes; full
suites at gates). **Reports** of about 30 lines (what changed, checks and results, screenshot scores, departures from the
brief, risks). Short Handoff updates at merges; decision records only for real decisions.
