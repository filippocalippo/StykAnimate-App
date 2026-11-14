//! Fast arithmetic for generated effects. Particle values are drawn, never stored in a
//! document, so they need not match V8's `Math` (decision 16 holds for stored arithmetic
//! only); they must be the same on every platform and in WebAssembly, so every function
//! here is built from IEEE operations that are exact everywhere (`+ - * /`, `sqrt`,
//! `floor`, bit casts) and never from the platform's `sin`, `exp` or `pow`.
//! Accuracy: about 1e-9 relative for `sin`, `cos`, `exp`, `ln`; `atan2` within 2e-8 rad.

use std::f64::consts::{FRAC_PI_2, LN_2, PI};

const TAU: f64 = PI * 2.0;

/// `sin(x)` and `cos(x)`.
#[inline]
pub fn sin_cos(x: f64) -> (f64, f64) {
    if !x.is_finite() {
        return (f64::NAN, f64::NAN);
    }
    // Reduce to [-π/4, π/4] and a quadrant.
    let q = (x * (2.0 / PI)).round();
    // Two-part π/2 for the reduction (Cody–Waite).
    let r = (x - q * 1.570_796_326_794_896_558) - q * 6.123_233_995_736_766e-17;
    let r2 = r * r;
    let s = r + r * r2 * (-1.666_666_666_666_663_2e-1 + r2 * (8.333_333_333_322_49e-3 + r2 * (-1.984_126_982_985_795e-4 + r2 * (2.755_731_370_707_007e-6 + r2 * (-2.505_076_025_340_686_3e-8 + r2 * 1.589_690_995_211_55e-10)))));
    let c = 1.0 - 0.5 * r2 + r2 * r2 * (4.166_666_666_666_66e-2 + r2 * (-1.388_888_888_887_411e-3 + r2 * (2.480_158_728_947_673e-5 + r2 * (-2.755_731_435_139_066_3e-7 + r2 * (2.087_572_321_298_175e-9 + r2 * -1.135_964_755_778_819_5e-11)))));
    match (q as i64).rem_euclid(4) {
        0 => (s, c),
        1 => (c, -s),
        2 => (-s, -c),
        _ => (-c, s),
    }
}

#[inline]
pub fn sin(x: f64) -> f64 {
    sin_cos(x).0
}

#[inline]
pub fn cos(x: f64) -> f64 {
    sin_cos(x).1
}

/// `atan(x)` for `0 <= x <= 1`.
#[inline]
fn atan01(x: f64) -> f64 {
    // atan(x) = atan(c) + atan((x - c) / (1 + x c)) around c = 0.5 keeps the series short.
    let (base, t) = if x > 0.4142135623730950 {
        // tan(π/8) splits [0, 1] in two; above it, reflect around π/4.
        (PI / 4.0, (x - 1.0) / (x + 1.0))
    } else {
        (0.0, x)
    };
    let t2 = t * t;
    // Odd series of atan on |t| <= tan(π/8) (~0.414): 12 terms are below 1e-10.
    let p = t * (1.0 + t2 * (-1.0 / 3.0 + t2 * (1.0 / 5.0 + t2 * (-1.0 / 7.0 + t2 * (1.0 / 9.0 + t2 * (-1.0 / 11.0 + t2 * (1.0 / 13.0 + t2 * (-1.0 / 15.0 + t2 * (1.0 / 17.0 + t2 * (-1.0 / 19.0 + t2 * (1.0 / 21.0 - t2 / 23.0)))))))))));
    base + p
}

/// `atan2(y, x)`.
#[inline]
pub fn atan2(y: f64, x: f64) -> f64 {
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    let (ax, ay) = (x.abs(), y.abs());
    let a = if ay <= ax { atan01(ay / ax) } else { FRAC_PI_2 - atan01(ax / ay) };
    let a = if x < 0.0 { PI - a } else { a };
    if y < 0.0 { -a } else { a }
}

/// `e^x`.
#[inline]
pub fn exp(x: f64) -> f64 {
    if x < -700.0 {
        return 0.0;
    }
    if x > 700.0 {
        return f64::INFINITY;
    }
    let n = (x / LN_2).round();
    let r = (x - n * 0.693_147_180_369_123_8) - n * 1.908_214_929_270_587_7e-10;
    // e^r on |r| <= ln2/2 (Taylor to r^12).
    let p = 1.0 + r * (1.0 + r * (0.5 + r * (1.0 / 6.0 + r * (1.0 / 24.0 + r * (1.0 / 120.0 + r * (1.0 / 720.0 + r * (1.0 / 5040.0 + r * (1.0 / 40320.0 + r * (1.0 / 362880.0 + r * (1.0 / 3628800.0 + r * (1.0 / 39916800.0 + r / 479001600.0)))))))))));
    p * f64::from_bits(((n as i64 + 1023) as u64) << 52)
}

/// `ln(x)` for `x > 0`.
#[inline]
pub fn ln(x: f64) -> f64 {
    if x <= 0.0 {
        return f64::NEG_INFINITY;
    }
    if !x.is_finite() {
        return x;
    }
    let bits = x.to_bits();
    let mut e = ((bits >> 52) & 0x7ff) as i64 - 1023;
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if e == -1023 {
        // Subnormal: normalize.
        let n = x * f64::from_bits(0x4330_0000_0000_0000);
        let b = n.to_bits();
        e = ((b >> 52) & 0x7ff) as i64 - 1023 - 52;
        m = f64::from_bits((b & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    }
    if m > std::f64::consts::SQRT_2 {
        m *= 0.5;
        e += 1;
    }
    // ln(m) = 2 atanh(s), s = (m - 1) / (m + 1), |s| < 0.172.
    let s = (m - 1.0) / (m + 1.0);
    let s2 = s * s;
    let p = 2.0 * s * (1.0 + s2 * (1.0 / 3.0 + s2 * (1.0 / 5.0 + s2 * (1.0 / 7.0 + s2 * (1.0 / 9.0 + s2 * (1.0 / 11.0 + s2 * (1.0 / 13.0 + s2 * (1.0 / 15.0 + s2 / 17.0))))))));
    p + e as f64 * LN_2
}

/// `x^y` for `x >= 0` (0^y is 0 for y > 0, 1 for y == 0).
#[inline]
pub fn powf(x: f64, y: f64) -> f64 {
    if y == 1.0 {
        return x;
    }
    if y == 0.0 {
        return 1.0;
    }
    if x <= 0.0 {
        return 0.0;
    }
    exp(y * ln(x))
}

/// `sqrt(x * x + y * y)` (IEEE `sqrt` is exact everywhere).
#[inline]
pub fn hypot(x: f64, y: f64) -> f64 {
    (x * x + y * y).sqrt()
}

/// An angle wrapped to `[-π, π]`.
#[inline]
pub fn wrap(a: f64) -> f64 {
    a - (a / TAU).round() * TAU
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agrees_with_the_platform_within_its_stated_accuracy() {
        let mut worst = [0.0f64; 6];
        for i in -20000..20000 {
            let x = i as f64 * 0.00731;
            let (s, c) = sin_cos(x);
            worst[0] = worst[0].max((s - x.sin()).abs());
            worst[1] = worst[1].max((c - x.cos()).abs());
            let y = (i as f64 * 0.37).sin() * 3.0;
            worst[2] = worst[2].max((atan2(y, x) - y.atan2(x)).abs());
            let e = i as f64 * 0.0011;
            worst[3] = worst[3].max(((exp(e) - e.exp()) / e.exp()).abs());
            let l = (i + 20001) as f64 * 0.013;
            worst[4] = worst[4].max((ln(l) - l.ln()).abs());
            worst[5] = worst[5].max(((powf(l, 0.37) - l.powf(0.37)) / l.powf(0.37)).abs());
        }
        assert!(worst[0] < 1e-9 && worst[1] < 1e-9, "sin {} cos {}", worst[0], worst[1]);
        assert!(worst[2] < 2e-8, "atan2 {}", worst[2]);
        assert!(worst[3] < 1e-12 && worst[4] < 1e-12 && worst[5] < 1e-12, "exp {} ln {} pow {}", worst[3], worst[4], worst[5]);
        assert_eq!(atan2(0.0, 0.0), 0.0);
        assert_eq!(powf(0.0, 2.0), 0.0);
        assert_eq!(powf(3.5, 1.0), 3.5);
    }
}
