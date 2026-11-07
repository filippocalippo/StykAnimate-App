# N5. Today's Electron app is the reference for parity, not a product to keep fixing

**Date:** 2026-11-07. **Status:** accepted (the owner's decision).

**Decision.**
- `engine-rust` stays at the pushed gate b13 state (`99c62189`); users run that until the native app replaces it. The
  engine cleanup chunks (M, M2, D, X, L, P) merge into `native-app` only.
- Engine chunks are verified with the Rust tests, the engine parity suites and the save byte checks. Electron smokes,
  `npm test` and app runs are used only where they are the only way to compare a result with today's behaviour.
- Work whose cause or fix lives only on the browser or Electron side stops; what is known is recorded in
  `perf/native/findings/` and becomes an acceptance criterion of the native version where it applies. Stopped on this
  rule: X2 (browser exports of tdd2 differing between runs at ticks 183 to 188), the 4K export memory runs in the Electron
  app, the node crashes in the movieclip fuzz unless they come from engine code, the blocking locks in `styk-wasm`
  (`open.rs`, `stage.rs`) and the "attempted to take ownership of Rust value while it was borrowed" failure of a very
  compressible 250 MB Pivot file (a WebAssembly binding error). The native acceptance criteria they become: identical
  export frames across runs; bounded export memory at 4K; no lock the interface thread can wait on; that file opens
  natively and its memory is released when it closes.
- Movieclip, drawing and export behaviour is fixed in the engine and checked on the native path.

**Why.** The owner's time and the machine go to the app that replaces Electron. Fixing the browser binding or re-validating
engine changes through Electron costs builds and app runs that the native app does not need.

## The process change of the same day: build each commit once

The machine, not the agents, was the bottleneck (CPU at 100 %, three heavy jobs running and three waiting; a review waited
51 minutes for a queued full build that then failed, while the review itself took minutes). From now on: the implementer
builds and tests only the crates it changed, in one test profile, and leaves its worktree and build in place; the checker
runs the real verification once, in that worktree; reviewers read the diff and the pasted output and run at most one small
targeted check there; full suites run only at the gates. The seed store (`wt/shared-target`, crates.io dependencies only)
is restored so a new checkout compiles only the workspace and vendored crates; three heavy jobs use four compile threads
each, filling the twelve. The rules every agent reads are in `perf/briefs/native-common.md`.
