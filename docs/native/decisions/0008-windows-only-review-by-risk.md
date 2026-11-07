# N8. Windows only in this phase; checking scaled to risk

**Date:** 2026-11-07 (the owner). **Status:** accepted; overrides the phase prompt and the briefs where they conflict.

**Scope.** Every feature of today's app and every new one (docking, the new Settings, the developer tools, the
design-studio hooks), shipped and verified on Windows. macOS, Linux and the web build are not tested, run, measured or
packaged in this phase; their spikes and CI legs stop (S5 is wrapped up with the constraints it found). Adding them later
must be a port: every OS call behind `styk-platform` traits, no Windows types or `cfg(windows)` outside it, no threading or
file assumptions only Windows allows, the GPU through wgpu only, nothing in the core or the engine a wasm32 or Unix target
could not build. A near-free `cargo check` for wasm32 at gates is the only check.

**Roles.** The orchestrator (Opus) plans, cuts medium-sized chunks and writes precise briefs, and reads every diff before
merging (architecture, hot-path performance, obvious bugs). Sonnet implements; no Sonnet checkers. GPT-6.1 Sol is the only
reviewer: xhigh for high-risk work (saves, recovery, formats and bytes, undo and history, the document and session,
threading and locks, input, playback and audio sync, export, memory and resource lifetimes, the engine), high and one round
for widgets with behaviour (fields, docking, the timeline's interactions), none by default for interface replication
(screens, panels, menus, dialogs, styling), which is done when the build, clippy and tests are clean and the screenshot
matches today's. A re-check only after a blocker, or in a high-risk area.

**Proof** is proportionate: no exhaustive sweeps unless a real failure calls for one, representative scenes for
performance, full suites only at gates. **Overhead:** short Handoff updates at merges, decision records only for real
decisions, no findings documents for routine things.
