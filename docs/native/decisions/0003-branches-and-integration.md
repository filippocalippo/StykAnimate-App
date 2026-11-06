# N3. Branches and integration during the native phase

**Date:** 2026-11-06. **Status:** accepted.

- `native-app` was branched from `engine-rust` at `99c62189` before the gate of local `engine-rust` finished, so the
  inventory, the skeleton and the engine cleanup could start at once. Everything `engine-rust` gains in the cleanup
  (gate fixes, the movieclip, drawing-undo and export work) is merged forward into `native-app`; nothing from
  `native-app` goes back into `engine-rust`.
- The main checkout holds `native-app`: delegated chunks branch from its head. Merges into `engine-rust` happen in a
  separate integration checkout (`wt/int-engine-rust`, outside the repository); both go through `perf/merge.sh`, which
  refuses any commit address other than the noreply one.
- Chunks merge as soon as they pass their checks and both reviews, so later chunks build on current code. `native-app`
  is pushed after each passing gate. No release, tag, merge into `main`, or change to PR #17.
