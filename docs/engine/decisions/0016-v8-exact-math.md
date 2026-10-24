# D16: Stored arithmetic uses one Math, the one Node's V8 has, bit for bit

Status: accepted. Recorded in [`docs/RUST-ENGINE-PORT.md`](../../RUST-ENGINE-PORT.md) section 4.

## Context

Editing commands store the results of trigonometry in documents (rotated roots and angles, poses aimed at the pointer). A port that is to produce the same bytes as the editor (D15) must round each result as V8 does. Drawing does not need this: geometry is rounded to single precision, which hides last-bit differences.

## Decision

`styk-math` provides `sin`, `cos` and `atan2` ported from fdlibm 5.3 as V8 has it (`src/base/ieee754.cc`, over the `libm` crate's `atan` and a vendored copy of its `rem_pio2_large`), and V8's `hypot`. Engine code whose results are stored in documents uses it; `f64::sin` and friends are not used there. `styk-eval`'s inverse-kinematics solver and rig constraints take all four from it.

## Evidence

On two million inputs, against Node's results: Rust's `f64::sin` (glibc) differed in the last bit 2.7 % of the time, `f64::cos` 2.4 %, `f64::atan2` 17 %; the `libm` crate 0.8 % for `sin` and 0.7 % for `cos` (fdlibm 5.3's cosine kernel has a correction musl dropped) and for `atan2` when |y/x| exceeds 2^60. `styk-math` matched V8 on all 2.8 million inputs tried: random angles, tiny and large values up to 1e308, every n·π/2 up to 64 and its neighbours, NaN, infinities and signed zeros. `engine/tools/math-fixtures.mjs` records 6,403 sine and cosine inputs and 4,147 `atan2`/`hypot` pairs for its tests.

## What "the editor's bytes" means (measured 2026-10-03)

JavaScript engines do not agree on these functions. Of 20,000 random inputs, against
Node 24 (V8 13.6, fdlibm): Chromium 153 differs in `sin` for 780, `cos` 593, `atan2`
3,418 and `hypot` 0; WebKit 26.6 in 759, 603, 3,408 and 7,017; Firefox 155 in 243, 233,
0 and 7,189. So the JavaScript app already stores poses that differ in their last
digits depending on the browser it runs in, and there is no single set of bytes to
match. The engine takes one definite answer, Node's, because the command-replay and
record harnesses run the editor in Node: there the comparison is byte for byte, which
is what found wrong key orders, a 2π winding and a held pose. In a browser the shadow
comparison (since deleted) accepted numbers within 1e-9 relative
and required everything else to be equal.

## Consequences

The engine gives the same numbers natively and in WebAssembly, on every platform and
in every browser, which the JavaScript engine does not. Evaluation tweens angles
through `styk_math::shortest`, and the IK solver and rig constraints use `styk-math`
throughout: posing a limb by its IK target stores the solved angles, and since the switch
the solver returns the editor's numbers bit for bit (`tests/ik.rs` compares them
exactly). `asin` and `acos` were added for 3D poses (`quaternionPose`, slerp): the
`libm` crate's agree with V8 on all 15,073 recorded inputs, the platform's differ on
1,046 and 605 of them. Geometry, whose points are rounded to single precision, still uses
the platform's functions. A function not yet in `styk-math` is ported and recorded before
a command uses it.

Added 2026-10-03 for generated effects (their batches and particles are compared with the
editor's bit for bit): `exp`, which is the `libm` crate's fdlibm port except that V8 returns
`Math.E` for 1 (two million inputs: no other difference; `f64::exp` differed for 10 %;
6,048 recorded in `exp.bin`).

Added 2026-10-23: `pow`, for `Math.pow` and `**` (custom pressure-size and opacity curves,
Bézier easing, rig influence and angle paths, generated-effect sizes and trails, the sharp
falloff of a motion path). It could not be had from the platform: V8 13.6 (Node 24)
computes it with the C library's `pow` unless started with `--no-use-std-math-pow`, and
those differ between platforms (Node 24 on Windows against Node 24 on Linux, on the same
inputs: 2,830 of 6.17 million, 0.05 %, each by one unit in the last place), so recordings
made on Linux (glibc) did not replay on Windows, and the pressure-size curve of the drawing
fixtures was the first to fail there. V8's own `pow`
(`ieee754::legacy::pow`: fdlibm 5.3 with V8's form of the last step, `(z * t1) / ((t1 - 2) -
(w + z * w))`, which Node 22 still uses by default) is the same everywhere, and `styk-math`
ports it. Against Node run with `--no-use-std-math-pow`, 6,174,743 inputs (random doubles
of every magnitude, the drawing curves' domain, Bézier `t ** 3`, the generators' and the
rig's exponents, integers, halves, negative bases, subnormals, near-overflow and
near-underflow results, bases near 1 with huge exponents, NaN, infinities and signed zeros)
gave no difference, on Windows and on Linux; Rust's `f64::powf` (the platform's) differed for
6.4 %, the `libm` crate's `pow` (fdlibm 5.3 as FreeBSD and musl have it) for 2.9 %, and Node
24's own default for 6.4 % (99.7 % of those by one unit in the last place, the rest by more).
`pow.bin` records 86,024 of them.

Engine code uses `styk_math::pow` for every `**` and `Math.pow` of the editor whose result
is stored, natively and in WebAssembly, without a platform branch. The tools that record
the editor pin Node's `Math.pow` to V8's own before it loads (`engine/tools/v8-pin.mjs`:
`v8.setFlagsFromString('--no-use-std-math-pow')`, imported first by every tool that runs
the editor and by each child process it starts, and refusing to go on if `Math.pow` or
`**` is not V8's own), so recordings no longer depend on the machine they are made on:
Node 24.11 on Windows, Node 24.11 on Linux and Node 22 (without the flag) record the same
bytes: regenerating the 60 fixture tools of the parity suite changes no file on Windows or on
Linux (WSL), and the pow-dependent ones change none under Node 22.21. The editor running in an
app (Electron, a browser) still computes `**` with its platform's `pow`, so a value it stores
can differ from the engine's in the last digit; the shadow comparison accepts that (1e-9
relative), as it does for a browser's `sin`.

Recording the fixtures with Node pinned changed nothing but `pow` results. The six trigonometry,
exponential and logarithm tables of `styk-math` build some inputs with `10 ** r`: 134 to 605
inputs per table moved by one or two units in the last place (and their results with them);
the tables also write every NaN in one canonical form, so Windows and Linux record the same
bytes. In the drawing fixtures the ten digests of the one case with custom pressure and
opacity curves changed; in the motion path falloff fixture the digest of the sharp shape
(`(1 - u) ** 3`) changed; and 40 numbers moved by one or two units in the last place in the
generator batches (9), the effect vectors (1) and the native transform projection oracle (30).
