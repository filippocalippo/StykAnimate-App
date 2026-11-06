//! `Math.sin`, `Math.cos`, `Math.atan2`, `Math.hypot`, `Math.asin`, `Math.acos`, `Math.exp`,
//! `Math.log`, `Math.log1p` and `Math.pow`
//! exactly as Node's V8 computes them.
//!
//! The editor stores the results of its arithmetic in documents, and the harnesses
//! that check the engine against it run the editor in Node, byte for byte. So the
//! engine rounds every stored result as Node does: V8 there computes sine, cosine and
//! `atan2` with fdlibm 5.3 (`src/base/ieee754.cc`), ported here over the `libm` crate's
//! `atan`, and `hypot` with its own scaled, compensated sum. The platform's library does
//! not agree (Rust's `f64::sin` on Linux differed in the last bit for 2.7 % of two
//! million inputs, `f64::atan2` for 17 %), and neither do browsers among themselves
//! (docs/engine/decisions/0016-v8-exact-math.md); with this crate the engine gives one
//! answer on every platform, natively and in WebAssembly. `asin`, `acos` and `exp` are the
//! `libm` crate's, which agree with V8's fdlibm on every recorded input (the platform's differ
//! on 7 %, 4 % and 10 % of them; V8 returns `Math.E` for `exp(1)`). `tests/v8.rs` checks all
//! these functions against recorded Node results (`Math.log` in `tests/log.rs`). `Math.pow` is
//! V8's own (`pow.rs`): Node 24 computes it with the C library's `pow` unless started with
//! `--no-use-std-math-pow`, and the platforms' differ from each other, from the `libm` crate's
//! and from V8's; the recorded results are V8's own.

// Vendored as it is upstream.
#[allow(clippy::all)]
mod rem_pio2_large;
mod log;
mod pow;

const fn word(bits: u64) -> f64 {
    f64::from_bits(bits)
}

fn high(x: f64) -> u32 {
    (x.to_bits() >> 32) as u32
}

const S1: f64 = word(0xBFC5555555555549);
const S2: f64 = word(0x3F8111111110F8A6);
const S3: f64 = word(0xBF2A01A019C161D5);
const S4: f64 = word(0x3EC71DE357B1FE7D);
const S5: f64 = word(0xBE5AE5E68A2B9CEB);
const S6: f64 = word(0x3DE5D93A5ACFD57C);

/// fdlibm's `__kernel_sin` on [-π/4, π/4]; `y` is the tail of `x`, used when `iy` is set.
fn kernel_sin(x: f64, y: f64, iy: bool) -> f64 {
    if high(x) & 0x7fffffff < 0x3e400000 && x as i32 == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if !iy { x + v * (S1 + z * r) } else { x - ((z * (0.5 * y - v * r) - y) - v * S1) }
}

const C1: f64 = word(0x3FA555555555554C);
const C2: f64 = word(0xBF56C16C16C15177);
const C3: f64 = word(0x3EFA01A019CB1590);
const C4: f64 = word(0xBE927E4F809C52AD);
const C5: f64 = word(0x3E21EE9EBDB4B1C4);
const C6: f64 = word(0xBDA8FAE9BE8838D4);

/// fdlibm 5.3's `__kernel_cos` on [-π/4, π/4], with the `qx` correction later
/// versions (FreeBSD, musl, the `libm` crate) replaced: that is where they differ from V8.
fn kernel_cos(x: f64, y: f64) -> f64 {
    let ix = high(x) & 0x7fffffff;
    if ix < 0x3e400000 && x as i32 == 0 {
        return 1.0;
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3FD33333 {
        return 1.0 - (0.5 * z - (z * r - x * y));
    }
    let qx = if ix > 0x3fe90000 { 0.28125 } else { f64::from_bits(((ix - 0x00200000) as u64) << 32) };
    let hz = 0.5 * z - qx;
    let a = 1.0 - qx;
    a - (hz - (z * r - x * y))
}

const INVPIO2: f64 = word(0x3FE45F306DC9C883);
const PIO2_1: f64 = word(0x3FF921FB54400000);
const PIO2_1T: f64 = word(0x3DD0B4611A626331);
const PIO2_2: f64 = word(0x3DD0B4611A600000);
const PIO2_2T: f64 = word(0x3BA3198A2E037073);
const PIO2_3: f64 = word(0x3BA3198A2E000000);
const PIO2_3T: f64 = word(0x397B839A252049C1);

/// High words of n·π/2 for n = 1..32 (fdlibm's `npio2_hw`).
const NPIO2_HW: [u32; 32] = [
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB,
    0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C, 0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
];

/// fdlibm 5.3's `__ieee754_rem_pio2`: `x` = n·π/2 + (y0 + y1), |y0 + y1| ≤ π/4.
fn rem_pio2(x: f64) -> (i32, f64, f64) {
    let hx = high(x) as i32;
    let ix = (hx & 0x7fffffff) as u32;
    if ix <= 0x3fe921fb {
        return (0, x, 0.0);
    }
    if ix < 0x4002d97c {
        // |x| < 3π/4: n = ±1.
        let (sign, t) = if hx > 0 { (1.0, x) } else { (-1.0, -x) };
        let z = t - PIO2_1;
        let (y0, y1) = if ix != 0x3ff921fb {
            let y0 = z - PIO2_1T;
            (y0, (z - y0) - PIO2_1T)
        } else {
            let z = z - PIO2_2;
            let y0 = z - PIO2_2T;
            (y0, (z - y0) - PIO2_2T)
        };
        return (sign as i32, sign * y0, sign * y1);
    }
    if ix <= 0x413921fb {
        // |x| ≤ 2^19·π/2: two or three steps of Cody and Waite.
        let t = x.abs();
        let n = (t * INVPIO2 + 0.5) as i32;
        let f = n as f64;
        let mut r = t - f * PIO2_1;
        let mut w = f * PIO2_1T;
        let mut y0;
        if n < 32 && ix != NPIO2_HW[n as usize - 1] {
            y0 = r - w;
        } else {
            let j = ix >> 20;
            y0 = r - w;
            let i = j as i32 - ((high(y0) >> 20) & 0x7ff) as i32;
            if i > 16 {
                let t = r;
                w = f * PIO2_2;
                r = t - w;
                w = f * PIO2_2T - ((t - r) - w);
                y0 = r - w;
                let i = j as i32 - ((high(y0) >> 20) & 0x7ff) as i32;
                if i > 49 {
                    let t = r;
                    w = f * PIO2_3;
                    r = t - w;
                    w = f * PIO2_3T - ((t - r) - w);
                    y0 = r - w;
                }
            }
        }
        let y1 = (r - y0) - w;
        return if hx < 0 { (-n, -y0, -y1) } else { (n, y0, y1) };
    }
    if ix >= 0x7ff00000 {
        return (0, f64::NAN, f64::NAN);
    }
    // Huge arguments: z = |x| scaled to [2^23, 2^24), split into 24-bit pieces.
    let e0 = (ix >> 20) as i32 - 1046;
    let mut z = f64::from_bits((((ix as i64 - ((e0 as i64) << 20)) as u64) << 32) | (x.to_bits() & 0xffffffff));
    let mut tx = [0.0; 3];
    for item in tx.iter_mut().take(2) {
        *item = z as i32 as f64;
        z = (z - *item) * word(0x4170000000000000);
    }
    tx[2] = z;
    let mut nx = 3;
    while nx > 1 && tx[nx - 1] == 0.0 {
        nx -= 1;
    }
    let mut ty = [0.0; 3];
    // Precision 2, as fdlibm 5.3 and V8 ask (the same reduction as precision 1).
    let n = rem_pio2_large::rem_pio2_large(&tx[..nx], &mut ty, e0, 2);
    if hx < 0 { (-n, -ty[0], -ty[1]) } else { (n, ty[0], ty[1]) }
}

/// `Math.sin`.
pub fn sin(x: f64) -> f64 {
    let ix = high(x) & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return kernel_sin(x, 0.0, false);
    }
    if ix >= 0x7ff00000 {
        return f64::NAN;
    }
    let (n, y0, y1) = rem_pio2(x);
    match n & 3 {
        0 => kernel_sin(y0, y1, true),
        1 => kernel_cos(y0, y1),
        2 => -kernel_sin(y0, y1, true),
        _ => -kernel_cos(y0, y1),
    }
}

/// `Math.cos`.
pub fn cos(x: f64) -> f64 {
    let ix = high(x) & 0x7fffffff;
    if ix <= 0x3fe921fb {
        return kernel_cos(x, 0.0);
    }
    if ix >= 0x7ff00000 {
        return f64::NAN;
    }
    let (n, y0, y1) = rem_pio2(x);
    match n & 3 {
        0 => kernel_cos(y0, y1),
        1 => -kernel_sin(y0, y1, true),
        2 => -kernel_cos(y0, y1),
        _ => kernel_sin(y0, y1, true),
    }
}

const PI_O_4: f64 = word(0x3FE921FB54442D18);
const PI_O_2: f64 = word(0x3FF921FB54442D18);
const PI: f64 = word(0x400921FB54442D18);
const PI_LO: f64 = word(0x3CA1A62633145C07);
const TINY: f64 = 1.0e-300;

/// `Math.atan2(y, x)`: fdlibm 5.3's `__ieee754_atan2`, as V8 has it. FreeBSD and musl
/// changed its handling of |y/x| beyond 2^60; their `atan` (from `libm`) is fdlibm's.
pub fn atan2(y: f64, x: f64) -> f64 {
    if x.is_nan() || y.is_nan() {
        return x + y;
    }
    let (hx, lx) = ((x.to_bits() >> 32) as i32, x.to_bits() as u32);
    let (hy, ly) = ((y.to_bits() >> 32) as i32, y.to_bits() as u32);
    let (ix, iy) = (hx & 0x7fffffff, hy & 0x7fffffff);
    if x == 1.0 {
        return libm::atan(y);
    }
    let mut m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
    if iy as u32 | ly == 0 {
        return match m {
            0 | 1 => y,
            2 => PI + TINY,
            _ => -PI - TINY,
        };
    }
    if ix as u32 | lx == 0 {
        return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
    }
    if ix == 0x7ff00000 {
        return if iy == 0x7ff00000 {
            match m {
                0 => PI_O_4 + TINY,
                1 => -PI_O_4 - TINY,
                2 => 3.0 * PI_O_4 + TINY,
                _ => -3.0 * PI_O_4 - TINY,
            }
        } else {
            match m {
                0 => 0.0,
                1 => -0.0,
                2 => PI + TINY,
                _ => -PI - TINY,
            }
        };
    }
    if iy == 0x7ff00000 {
        return if hy < 0 { -PI_O_2 - TINY } else { PI_O_2 + TINY };
    }
    let k = (iy - ix) >> 20;
    let z = if k > 60 {
        m &= 1;
        PI_O_2 + 0.5 * PI_LO
    } else if hx < 0 && k < -60 {
        0.0
    } else {
        libm::atan((y / x).abs())
    };
    match m {
        0 => z,
        1 => -z,
        2 => PI - (z - PI_LO),
        _ => (z - PI_LO) - PI,
    }
}

/// `Math.hypot(...values)` as V8 computes it: scaled by the largest magnitude and
/// summed with Kahan compensation. `sqrt(x² + y²)` and libm's `hypot` differ from it in
/// the last bit often enough to move a solver's accept/reject decisions.
pub fn norm(values: &[f64]) -> f64 {
    let mut max = 0.0f64;
    let mut nan = false;
    for v in values {
        let a = v.abs();
        if a == f64::INFINITY {
            return f64::INFINITY;
        }
        nan |= a.is_nan();
        if a > max {
            max = a;
        }
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut compensation) = (0.0f64, 0.0f64);
    for v in values {
        let n = v.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `Math.hypot(x, y)`.
pub fn hypot(x: f64, y: f64) -> f64 {
    norm(&[x, y])
}

/// The editor's `shortest(a)`: `Math.atan2(Math.sin(a), Math.cos(a))`, the angle in (-π, π].
pub fn shortest(a: f64) -> f64 {
    atan2(sin(a), cos(a))
}

/// `Math.asin` (fdlibm's, as the `libm` crate has it: identical to V8's on every recorded input).
pub fn asin(x: f64) -> f64 {
    libm::asin(x)
}

/// `Math.acos` (fdlibm's, as the `libm` crate has it: identical to V8's on every recorded input).
pub fn acos(x: f64) -> f64 {
    libm::acos(x)
}

/// `Math.exp(x)`: fdlibm's `__ieee754_exp`, which V8 has in `ieee754::exp` and the `libm`
/// crate ports from FreeBSD unchanged (the platform's `f64::exp` differed from Node for 10 %
/// of two million inputs, the `libm` crate for none), except that V8 returns `Math.E` for 1.
pub fn exp(x: f64) -> f64 {
    if x == 1.0 {
        return std::f64::consts::E;
    }
    libm::exp(x)
}

/// `Math.pow(x, y)` and `x ** y`: V8's own `ieee754::legacy::pow`, fdlibm 5.3 with V8's form of
/// its last step. The `libm` crate's `pow` (fdlibm 5.3 as FreeBSD and musl have it) differed from
/// it for 2.9 % of six million inputs, the platform's `f64::powf` for 6.4 %. V8 13.6 uses the C
/// library's `pow` for `Math.pow` by default (`--use-std-math-pow`), which differs between
/// platforms for about 0.05 % of inputs, so the recorded results come from Node run with
/// `--no-use-std-math-pow` (engine/tools/v8-pin.mjs).
pub fn pow(x: f64, y: f64) -> f64 {
    pow::pow(x, y)
}

/// `Math.log(x)`: fdlibm's logarithm with V8's normalization and rounding order.
/// `libm::log` rewrites its branches and differs by one bit on recorded inputs.
pub fn log(x: f64) -> f64 {
    log::log(x)
}

/// `Math.log1p(x)`: fdlibm's `log1p` as V8 has it in `ieee754::log1p` (FreeBSD's msun). The
/// `libm` crate's is musl's rewrite, which differed from Node for about 1 in 1,000 inputs.
pub fn log1p(x: f64) -> f64 {
    const LN2_HI: f64 = 6.93147180369123816490e-01;
    const LN2_LO: f64 = 1.90821492927058770002e-10;
    const TWO54: f64 = 1.80143985094819840000e+16;
    const LP: [f64; 7] = [6.666666666666735130e-01, 3.999999999940941908e-01, 2.857142874366239149e-01, 2.222219843214978396e-01, 1.818357216161805012e-01, 1.531383769920937332e-01, 1.479819860511658591e-01];
    let hx = high(x) as i32;
    let ax = hx & 0x7fffffff;
    let mut k = 1i32;
    let (mut f, mut hu, mut c) = (0.0, 0i32, 0.0);
    if hx < 0x3fda827a {
        // 1 + x < √2
        if ax >= 0x3ff00000 {
            // x <= -1
            return if x == -1.0 { f64::NEG_INFINITY } else { (x - x) / (x - x) };
        }
        if ax < 0x3e200000 {
            // |x| < 2^-29
            return if TWO54 + x > 0.0 && ax < 0x3c900000 { x } else { x - x * x * 0.5 };
        }
        if hx > 0 || hx <= 0xbfd2bec4u32 as i32 {
            // √2/2 <= 1 + x < √2
            k = 0;
            f = x;
            hu = 1;
        }
    }
    if hx >= 0x7ff00000 {
        return x + x;
    }
    if k != 0 {
        let mut u;
        if hx < 0x43400000 {
            u = 1.0 + x;
            hu = high(u) as i32;
            k = (hu >> 20) - 1023;
            // The correction term.
            c = if k > 0 { 1.0 - (u - x) } else { x - (u - 1.0) };
            c /= u;
        } else {
            u = x;
            hu = high(u) as i32;
            k = (hu >> 20) - 1023;
            c = 0.0;
        }
        hu &= 0x000fffff;
        let with_high = |value: f64, word: i32| f64::from_bits(((word as u32 as u64) << 32) | (value.to_bits() & 0xffffffff));
        if hu < 0x6a09e {
            // u ≲ √2: normalize u.
            u = with_high(u, hu | 0x3ff00000);
        } else {
            // Normalize u / 2.
            k += 1;
            u = with_high(u, hu | 0x3fe00000);
            hu = (0x00100000 - hu) >> 2;
        }
        f = u - 1.0;
    }
    let hfsq = 0.5 * f * f;
    let k = k as f64;
    if hu == 0 {
        // |f| < 2^-20
        if f == 0.0 {
            if k == 0.0 {
                return 0.0;
            }
            c += k * LN2_LO;
            return k * LN2_HI + c;
        }
        let r = hfsq * (1.0 - 0.66666666666666666 * f);
        return if k == 0.0 { f - r } else { k * LN2_HI - ((r - (k * LN2_LO + c)) - f) };
    }
    let s = f / (2.0 + f);
    let z = s * s;
    let r = z * (LP[0] + z * (LP[1] + z * (LP[2] + z * (LP[3] + z * (LP[4] + z * (LP[5] + z * LP[6]))))));
    if k == 0.0 { f - (hfsq - s * (hfsq + r)) } else { k * LN2_HI - ((hfsq - (s * (hfsq + r) + (k * LN2_LO + c))) - f) }
}
