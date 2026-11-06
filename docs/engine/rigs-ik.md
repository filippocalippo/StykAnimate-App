# Engine: inverse kinematics and rig constraints

How the Rust engine (`engine/crates/styk-eval`) evaluates IK, and where it meets rig constraints. The user-facing behaviour is in [`inverse-kinematics.md`](../inverse-kinematics.md), [`RIG-CONSTRAINTS.md`](../RIG-CONSTRAINTS.md) and [`FIGURE-JOINING.md`](../FIGURE-JOINING.md); the recorded fixtures (frozen) are the oracle ([`RUST-ENGINE-PORT.md`](../RUST-ENGINE-PORT.md)).

## Contract

- A pose object carries its controllers (`_stykIK`, `Object::ik`), keyed by the handle they end at. Only a controller that is **enabled and pinned** changes what a frame looks like: geometry derives the angles of its chain, and with stretch its lengths. Unpinned and disabled controllers are editing state.
- A solve is a pure function of the evaluated frame. It returns an `ik::Solution` (angles, optional lengths) that `geometry::build` reads in place of the pose's channels. Nothing is written to the document, nothing is cached between frames, and no solver state is carried: any tick evaluates on any thread, in any order.
- Evaluation order: (1) `ik::joined::solve` once per frame, for every joined assembly with a pin; (2) per object, after its root is resolved from its join, the assembly's solution or `ik::solve_local`; (3) the object's rig and geometry are evaluated from the solved channels.
- Between two keys, controllers tween with the pose (`ik::tween`, called from `eval::tween_object`): target position, target rotation and follower angles use the timeline's own channel sampler (linear, eased, Auto, Pivot's cubic). A controller tweens only toward a controller of the same handle that is enabled and pinned alike; otherwise the first key's controller holds.

## Modules

Origin editing uses the shared raw nested validator
`styk_eval::rig::validate_2d(&Value) -> Result<(), &'static str>` before constructing
typed rig plans. It preserves compiler dependency order, reference/range/bool/cycle
checks, accepted unknown metadata, and inactive null/false/zero connector values.
The origin fixtures record 102 malformed refusals plus 27 accepted cases; a refusal
preserves an already-open drag, document, counters and history.

| Module (`src/ik/`) | Holds |
| --- | --- |
| `mod.rs` | `Table`, `Controller`, `Target`, `BendReference`, `SpatialTarget`, `solve_local`, V8's `hypot` |
| `parse.rs` | `_stykIK` → `Table` (lenient) |
| `solve.rs` | `solve_points`: analytic two-bone solve, FABRIK for longer chains; `bend_reference` |
| `layout.rs` | chains, follower branches, attachment offsets on a `Skeleton` |
| `object.rs` | `solve_object`: every pinned controller of one `Skeleton` and `Pose` → `Solution` |
| `rig.rs` | `RigContext` (evaluate, refine, spatial solve, orientation), `authored_rig_target` |
| `spatial.rs` | 3D target space, quaternion helpers |
| `joined.rs` | assemblies of joined figures → one temporary skeleton → per-slot solutions |
| `interpolate.rs` | `interpolate`, `tween`, `Channel` |

The JavaScript keeps only what a document stores of a controller: `src/ik.mjs` (`ikLayout`, `ikChain`, `hasPinnedIK`, `validateIK`), which the interface reads and the open check runs.

`parity.rs` (crate root) compares a document with a reference dump; `styk compare` and the tests share it.

## Where IK meets rig constraints

`rig.rs` (crate root) evaluates rig relationships; IK uses it through three additions: `RigPlan::dependencies` (which joints a joint reads), `State::space` (the local space a joint's rig derives) and the public `spatial_quaternion`.

Editing reads one more: `State::child_space` (the space the joints below a joint are authored in, from `RigPlan::outputs`, kept per joint as `RigJoint::child_space` and `RigJoint::rotation`), which a stroke drawn into a rigged figure is stored in.

A rigged bone is not drawn where its authored angle points. For a skeleton with a rig plan, `solve_object` therefore: solves the chain on the **rendered** joint positions; inverts each bone's local space (`authored_rig_target`) for a first guess of the authored angle; then `RigContext::refine` corrects the authored angles by damped least squares until the rendered endpoint reaches the target (40 steps, tolerance 1e-4). A two-bone spatial limb with a 3D target is solved analytically instead (`solve_spatial`). Only the joints the driven bones depend on are evaluated in these loops.

Chains stop at a derived joint (`layout::derived_rig_joint`: skin, connector, angle lock, angle path, weighted joint): IK never drives one.

## Invariants

- **Arithmetic fixed by the recordings**, operation by operation: operand order, iteration counts (32 FABRIK passes, 40 refinement steps), tolerances, clamps, the dead band of Both. `ik::wrap` is `((a + π) mod 2π + 2π) mod 2π − π`, not `atan2(sin, cos)`; `ik::norm` is V8's scaled, Kahan-summed `Math.hypot`. Trigonometry comes from the platform's libm, so results agree with the recordings to the last bits, not bit for bit.
- **Handle order is the recordings'**: tables are `BTreeMap<u32, _>`, which iterates in ascending integer key order, like the recorded JSON objects. Controllers solve in the order of their chain's base in the breadth-first layout, then by handle; a chain that shares a bone with an earlier one is left as posed (`Outcome::conflict`).
- **Followers read the authored pose**, never the angles being solved. Branches leaving the endpoint follow the target's rotation; everything else below the chain inherits its bone's change once.
- **Stretch never accumulates**: lengths start from the pose on every solve and scale by `max(1, distance / reach)`.
- **Joined assemblies** solve at scale 1 with each figure's lengths pre-multiplied by its scale, and scatter lengths back divided by it (the round trip is kept; the recordings store it). An assembly containing a movieclip is not compiled; its figures solve on their own.
- Library code stays free of clocks, threads and files (it builds for `wasm32-unknown-unknown`).

## Choices of the engine

- No memoization: a solve depends only on the frame, and the engine caches whole frames.
- Malformed tables are read leniently (`ik::parse`); the open check (`validateIK` in `src/ik.mjs`) rejects the file. Where a joined assembly cannot be built (a cyclic join, a join to a missing handle), it is left unsolved.
- Per-controller diagnostics keep what evaluation and tests need (`Outcome`); the follower tables written back while editing belong to the editing commands (`styk-edit`).

## Changing it

- **A solver option** (a controller field): add it to `Controller`, read it in `parse.rs`, decide in `interpolate.rs` whether it tweens or holds, use it in `object.rs` or `solve.rs`. Add a Rust test in `tests/ik.rs` that states the expected result and fails without it.
- **A rig relationship**: its evaluation belongs in `rig.rs`. For IK, add what it reads to the dependency list in `rig::plan`; set `State::space` if posing the joint directly must be inverted; add it to `derived_rig_joint` if IK must not drive it; and remap its handle references in `joined::remap_rig`.
- **The recorded fixtures are frozen** ([README](README.md#fixtures)): a new or changed behaviour gets a Rust test that states its expected result; nothing re-records `fixtures/ik/`.

## Testing

```sh
cd engine && cargo test -p styk-eval              # unit tests + tests/ik.rs, well under a second
cargo clippy -p styk-eval --all-targets
cargo build -p styk-eval --target wasm32-unknown-unknown
```

`tests/ik.rs` loads every fixture and:

- compares joints and primitives with the recorded editor dump within `parity::TOLERANCE` (2e-3);
- compares what the solver derived (each reference's `frames[].ik`, unrounded): angles and stretched lengths bit for bit (the solver's trigonometry is `styk-math`'s, [D16](decisions/0016-v8-exact-math.md)), and the same iteration count per controller. The position tolerance alone would hide a wrong threshold or a missing iteration;
- checks that each fixture with a pin stops matching when its controllers are removed;
- replays recorded inputs of the point solver and the controller interpolation (`vectors.json`, bit for bit).

The fixtures were recorded earlier from the JavaScript editor's own commands, except `movieclip` (the clip was captured by the editor, its instance placed by hand) and `legacy-tables` and `conflict` (states the commands no longer write but evaluation still handles).
