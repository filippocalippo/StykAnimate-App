# N1. The native app lives in the engine's Cargo workspace, in new crates

**Date:** 2026-11-06. **Status:** accepted.

**Decision.** The app's crates (`styk-trace`, `styk-services`, `styk-platform`, `styk-core`, `styk-design`, `styk-ui`,
`styk-devtools`, `styk-app`, `xtask`) are members of the existing workspace in `engine/`, beside the engine crates. The
workspace root stays at `engine/` for this phase.

**Why.** One workspace gives one `Cargo.lock`, one wgpu version and one set of profiles for the engine and the app (the
stage shares iced's wgpu device, so the versions must agree). Moving the workspace root to the repository root would
touch every build script, CI job, seed script and document that names `engine/` while the Electron app still builds
from it; that move, if still wanted, happens once Electron is gone (phase step 8), as one deliberate change.

**Service traits apart from their implementations.** `styk-services` holds only traits, plain types and test fakes;
`styk-platform` holds the per-target implementations. The core depends on the traits alone, so its tests compile fast,
never touch OS APIs, and a touch or web build supplies its own implementations.
