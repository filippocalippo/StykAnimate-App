//! JavaScript's number semantics where the drawing engine's results depend on them:
//! `Math.round`, the conversions typed arrays apply on store (`Uint8ClampedArray`,
//! `Float32Array`, `Uint8Array`), `ToUint32` and `Math.imul`.
//!
//! The JavaScript raster engine is the oracle (docs/RUST-ENGINE-PORT.md, S6): every
//! pixel it writes goes through one of these conversions, so the port must apply the
//! same ones at the same places to produce the same bytes.

/// `Math.round(x)`: the nearest integer, ties toward +∞, exact for every double
/// (`floor(x + 0.5)` is wrong for 0.49999999999999994).
#[inline]
pub fn round(x: f64) -> f64 {
    let r = x.ceil();
    if r - 0.5 > x { r - 1.0 } else { r }
}

/// The value a `Uint8ClampedArray` stores for `x` (ECMAScript `ToUint8Clamp`): NaN is 0,
/// the range is clamped and fractions round half to even.
#[inline]
pub fn u8c(x: f64) -> u8 {
    if x.is_nan() || x <= 0.0 {
        return 0;
    }
    if x >= 255.0 {
        return 255;
    }
    let f = x.floor();
    let half = f + 0.5;
    if half < x {
        return (f + 1.0) as u8;
    }
    if x < half {
        return f as u8;
    }
    let f = f as u8;
    if f % 2 == 0 { f } else { f + 1 }
}

/// `Math.round(x)` stored into a `Uint8ClampedArray`.
#[inline]
pub fn round_u8(x: f64) -> u8 {
    u8c(round(x))
}

/// The value a `Uint8Array` stores for `x` (`ToUint8`: truncation modulo 256).
#[inline]
pub fn to_u8(x: f64) -> u8 {
    if !x.is_finite() {
        return 0;
    }
    (x.trunc().rem_euclid(256.0)) as u8
}

/// `x >>> 0` (`ToUint32`).
#[inline]
pub fn to_u32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    x.trunc().rem_euclid(4294967296.0) as u32
}

/// `x | 0` (`ToInt32`).
#[inline]
pub fn to_i32(x: f64) -> i32 {
    to_u32(x) as i32
}

/// `Math.imul(a, b)` on values already converted with `ToInt32`.
#[inline]
pub fn imul(a: i32, b: i32) -> i32 {
    a.wrapping_mul(b)
}

/// `Math.max(a, b)` for numbers that are never NaN or signed zeros where it matters.
#[inline]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b { a } else { b }
}

/// `Math.min(a, b)` with JavaScript's NaN propagation.
#[inline]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b { a } else { b }
}

/// The editor's `clamp(n, a = 0, b = 1)`: `Math.max(a, Math.min(b, n))`.
#[inline]
pub fn clamp(n: f64, a: f64, b: f64) -> f64 {
    max(a, min(b, n))
}

/// `clamp(n)` over [0, 1].
#[inline]
pub fn clamp01(n: f64) -> f64 {
    clamp(n, 0.0, 1.0)
}

/// `Math.log2(x)` (fdlibm's, as V8 and the `libm` crate have it).
#[inline]
pub fn log2(x: f64) -> f64 {
    libm::log2(x)
}

/// A JavaScript number that is an integer (`Number.isInteger`).
#[inline]
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `Number.isSafeInteger`.
#[inline]
pub fn is_safe_integer(x: f64) -> bool {
    is_integer(x) && x.abs() <= 9007199254740991.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_is_javascripts() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(254.5), 255.0);
        assert_eq!(u8c(2.5), 2);
        assert_eq!(u8c(3.5), 4);
        assert_eq!(u8c(f64::NAN), 0);
        assert_eq!(u8c(300.0), 255);
        assert_eq!(u8c(-3.0), 0);
        assert_eq!(to_u32(-1.0), 4294967295);
        assert_eq!(to_u32(4294967296.0 + 5.0), 5);
        assert_eq!(to_u8(257.0), 1);
    }
}
