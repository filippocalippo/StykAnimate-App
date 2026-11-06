// Adapted from fdlibm 5.3, as V8 13.6 src/base/ieee754.cc implements pow (legacy::pow), which
// Node 22 and earlier use for Math.pow and Node 24 with --no-use-std-math-pow. V8 computes the
// last step as (z * t1) / ((t1 - 2) - (w + z * w)) where fdlibm 5.3, FreeBSD, musl and the
// `libm` crate compute (z * t1) / (t1 - 2) - (w + z * w); the two differ for about 3 % of inputs.
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely granted,
// provided that this notice is preserved.
// The original source was modified by Google Inc.
// Copyright 2016 the V8 project authors. All rights reserved.

const BP: [f64; 2] = [1.0, 1.5];
const DP_H: [f64; 2] = [0.0, f64::from_bits(0x3FE2B80340000000)];
const DP_L: [f64; 2] = [0.0, f64::from_bits(0x3E4CFDEB43CFD006)];
const TWO53: f64 = 9007199254740992.0;
const HUGE: f64 = 1.0e300;
const TINY: f64 = 1.0e-300;
const L1: f64 = f64::from_bits(0x3FE3333333333303);
const L2: f64 = f64::from_bits(0x3FDB6DB6DB6FABFF);
const L3: f64 = f64::from_bits(0x3FD55555518F264D);
const L4: f64 = f64::from_bits(0x3FD17460A91D4101);
const L5: f64 = f64::from_bits(0x3FCD864A93C9DB65);
const L6: f64 = f64::from_bits(0x3FCA7E284A454EEF);
const P1: f64 = f64::from_bits(0x3FC555555555553E);
const P2: f64 = f64::from_bits(0xBF66C16C16BEBD93);
const P3: f64 = f64::from_bits(0x3F11566AAF25DE2C);
const P4: f64 = f64::from_bits(0xBEBBBD41C5D26BF1);
const P5: f64 = f64::from_bits(0x3E66376972BEA4D0);
const LG2: f64 = f64::from_bits(0x3FE62E42FEFA39EF);
const LG2_H: f64 = f64::from_bits(0x3FE62E4300000000);
const LG2_L: f64 = f64::from_bits(0xBE205C610CA86C39);
const OVT: f64 = 8.0085662595372944372e-17;
const CP: f64 = f64::from_bits(0x3FEEC709DC3A03FD);
const CP_H: f64 = f64::from_bits(0x3FEEC709E0000000);
const CP_L: f64 = f64::from_bits(0xBE3E2FE0145B01F5);
const IVLN2: f64 = f64::from_bits(0x3FF71547652B82FE);
const IVLN2_H: f64 = f64::from_bits(0x3FF7154760000000);
const IVLN2_L: f64 = f64::from_bits(0x3E54AE0BF85DDF44);

fn hi(x: f64) -> i32 {
    (x.to_bits() >> 32) as i32
}

fn lo(x: f64) -> u32 {
    x.to_bits() as u32
}

fn with_hi(x: f64, word: i32) -> f64 {
    f64::from_bits(((word as u32 as u64) << 32) | (x.to_bits() & 0xffff_ffff))
}

fn with_lo_zero(x: f64) -> f64 {
    f64::from_bits(x.to_bits() & 0xffff_ffff_0000_0000)
}

/// fdlibm scalbn, used for the subnormal results of pow (`x` in [1/2, 2), `n` negative enough
/// that the result is below the normal range).
fn scalbn(mut x: f64, n: i32) -> f64 {
    const TWO54: f64 = 1.80143985094819840000e+16;
    const TWOM54: f64 = 5.55111512312578270212e-17;
    let mut hx = hi(x);
    let lx = lo(x);
    let mut k = (hx & 0x7ff00000) >> 20;
    if k == 0 {
        if (lx | (hx & 0x7fffffff) as u32) == 0 {
            return x;
        }
        x *= TWO54;
        hx = hi(x);
        k = ((hx & 0x7ff00000) >> 20) - 54;
        if n < -50000 {
            return TINY * x;
        }
    }
    if k == 0x7ff {
        return x + x;
    }
    k += n;
    if k > 0x7fe {
        return HUGE * HUGE.copysign(x);
    }
    if k > 0 {
        return with_hi(x, (hx & 0x800fffffu32 as i32) | (k << 20));
    }
    if k <= -54 {
        return if n > 50000 { HUGE * HUGE.copysign(x) } else { TINY * TINY.copysign(x) };
    }
    k += 54;
    x = with_hi(x, (hx & 0x800fffffu32 as i32) | (k << 20));
    x * TWOM54
}

pub(super) fn pow(x: f64, y: f64) -> f64 {
    let (hx, lx) = (hi(x), lo(x));
    let (hy, ly) = (hi(y), lo(y));
    let (ix, iy) = (hx & 0x7fffffff, hy & 0x7fffffff);

    // y == 0: x ** 0 = 1.
    if (iy as u32 | ly) == 0 {
        return 1.0;
    }
    // NaN: x + y.
    if ix > 0x7ff00000 || (ix == 0x7ff00000 && lx != 0) || iy > 0x7ff00000 || (iy == 0x7ff00000 && ly != 0) {
        return x + y;
    }

    // Whether y is an odd integer (1), an even one (2) or not an integer (0) when x < 0.
    let mut yisint = 0;
    if hx < 0 {
        if iy >= 0x43400000 {
            yisint = 2;
        } else if iy >= 0x3ff00000 {
            let k = (iy >> 20) - 0x3ff;
            if k > 20 {
                let j = ly >> (52 - k);
                if (j << (52 - k)) == ly {
                    yisint = 2 - (j & 1) as i32;
                }
            } else if ly == 0 {
                let j = iy >> (20 - k);
                if (j << (20 - k)) == iy {
                    yisint = 2 - (j & 1);
                }
            }
        }
    }

    // Special values of y.
    if ly == 0 {
        if iy == 0x7ff00000 {
            // y is ±infinity.
            return if ((ix - 0x3ff00000) as u32 | lx) == 0 {
                y - y // (±1) ** ±infinity is NaN
            } else if ix >= 0x3ff00000 {
                if hy >= 0 { y } else { 0.0 }
            } else if hy < 0 {
                -y
            } else {
                0.0
            };
        }
        if iy == 0x3ff00000 {
            return if hy < 0 { 1.0 / x } else { x };
        }
        if hy == 0x40000000 {
            return x * x;
        }
        if hy == 0x3fe00000 && hx >= 0 {
            return x.sqrt();
        }
    }

    let mut ax = x.abs();
    // Special values of x.
    if lx == 0 && (ix == 0x7ff00000 || ix == 0 || ix == 0x3ff00000) {
        let mut z = ax; // ±0, ±infinity, ±1
        if hy < 0 {
            z = 1.0 / z;
        }
        if hx < 0 {
            if ((ix - 0x3ff00000) | yisint) == 0 {
                z = (z - z) / (z - z); // (-1) ** non-integer is NaN
            } else if yisint == 1 {
                z = -z;
            }
        }
        return z;
    }

    let n = (hx >> 31) + 1;
    // (x < 0) ** non-integer is NaN.
    if (n | yisint) == 0 {
        return (x - x) / (x - x);
    }
    // The sign of the result: -1 for a negative base to an odd integer.
    let s = if (n | (yisint - 1)) == 0 { -1.0 } else { 1.0 };

    let (t1, t2);
    if iy > 0x41e00000 {
        // |y| > 2^31.
        if iy > 0x43f00000 {
            // |y| > 2^64: must overflow or underflow.
            if ix <= 0x3fefffff {
                return if hy < 0 { HUGE * HUGE } else { TINY * TINY };
            }
            if ix >= 0x3ff00000 {
                return if hy > 0 { HUGE * HUGE } else { TINY * TINY };
            }
        }
        // Overflow or underflow when x is not close to 1.
        if ix < 0x3fefffff {
            return if hy < 0 { s * HUGE * HUGE } else { s * TINY * TINY };
        }
        if ix > 0x3ff00000 {
            return if hy > 0 { s * HUGE * HUGE } else { s * TINY * TINY };
        }
        // |1 - x| <= 2^-20: log(x) is x - x^2/2 + x^3/3 - x^4/4.
        let t = ax - 1.0;
        let w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
        let u = IVLN2_H * t;
        let v = t * IVLN2_L - w * IVLN2;
        t1 = with_lo_zero(u + v);
        t2 = v - (t1 - u);
    } else {
        let mut n = 0;
        // Subnormal x.
        let mut ix = ix;
        if ix < 0x00100000 {
            ax *= TWO53;
            n -= 53;
            ix = hi(ax);
        }
        n += (ix >> 20) - 0x3ff;
        let j = ix & 0x000fffff;
        // The interval of the mantissa.
        ix = j | 0x3ff00000;
        let k;
        if j <= 0x3988E {
            k = 0; // |x| < sqrt(3/2)
        } else if j < 0xBB67A {
            k = 1; // |x| < sqrt(3)
        } else {
            k = 0;
            n += 1;
            ix -= 0x00100000;
        }
        ax = with_hi(ax, ix);

        // ss = s_h + s_l = (x - 1) / (x + 1) or (x - 1.5) / (x + 1.5).
        let u = ax - BP[k];
        let v = 1.0 / (ax + BP[k]);
        let ss = u * v;
        let s_h = with_lo_zero(ss);
        // t_h = ax + bp[k], high part.
        let t_h = with_hi(0.0, ((ix >> 1) | 0x20000000) + 0x00080000 + ((k as i32) << 18));
        let t_l = ax - (t_h - BP[k]);
        let s_l = v * ((u - s_h * t_h) - s_h * t_l);
        // log(ax).
        let s2 = ss * ss;
        let mut r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
        r += s_l * (s_h + ss);
        let s2 = s_h * s_h;
        let t_h = with_lo_zero(3.0 + s2 + r);
        let t_l = r - ((t_h - 3.0) - s2);
        // u + v = ss * (1 + ...).
        let u = s_h * t_h;
        let v = s_l * t_h + t_l * ss;
        // 2 / (3 log 2) * (ss + ...).
        let p_h = with_lo_zero(u + v);
        let p_l = v - (p_h - u);
        let z_h = CP_H * p_h;
        let z_l = CP_L * p_h + p_l * CP + DP_L[k];
        // log2(ax) = n + dp_h + z_h + z_l.
        let t = n as f64;
        t1 = with_lo_zero(((z_h + z_l) + DP_H[k]) + t);
        t2 = z_l - (((t1 - t) - DP_H[k]) - z_h);
    }

    // Split y into y1 + y2 and compute (y1 + y2) * (t1 + t2).
    let y1 = with_lo_zero(y);
    let p_l = (y - y1) * t1 + y * t2;
    let mut p_h = y1 * t1;
    let mut z = p_l + p_h;
    let j = hi(z);
    let i = lo(z);
    if j >= 0x40900000 {
        // z >= 1024.
        if ((j - 0x40900000) as u32 | i) != 0 {
            return s * HUGE * HUGE; // overflow
        } else if p_l + OVT > z - p_h {
            return s * HUGE * HUGE; // overflow
        }
    } else if (j & 0x7fffffff) >= 0x4090cc00 {
        // z <= -1075.
        if ((j as u32).wrapping_sub(0xc090cc00) | i) != 0 {
            return s * TINY * TINY; // underflow
        } else if p_l <= z - p_h {
            return s * TINY * TINY; // underflow
        }
    }

    // 2 ** (p_h + p_l).
    let i = j & 0x7fffffff;
    let mut k = (i >> 20) - 0x3ff;
    let mut n = 0;
    if i > 0x3fe00000 {
        // |z| > 0.5: n = [z + 0.5].
        n = j + (0x00100000 >> (k + 1));
        k = ((n & 0x7fffffff) >> 20) - 0x3ff;
        let t = with_hi(0.0, n & !(0x000fffff >> k));
        n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
        if j < 0 {
            n = -n;
        }
        p_h -= t;
    }
    let t = with_lo_zero(p_l + p_h);
    let u = t * LG2_H;
    let v = (p_l - (t - p_h)) * LG2 + t * LG2_L;
    z = u + v;
    let w = v - (z - u);
    let t = z * z;
    let t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    let r = (z * t1) / ((t1 - 2.0) - (w + z * w));
    z = 1.0 - (r - z);
    let j = hi(z).wrapping_add(n << 20);
    if (j >> 20) <= 0 {
        z = scalbn(z, n); // subnormal result
    } else {
        z = with_hi(z, j);
    }
    s * z
}
