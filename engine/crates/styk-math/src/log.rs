// Adapted from fdlibm, as V8 13.6 src/base/ieee754.cc implements log.
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely granted,
// provided that this notice is preserved.
// The original source was modified by Google Inc.
// Copyright 2016 the V8 project authors. All rights reserved.

pub(super) fn log(mut x: f64) -> f64 {
    const LN2_HI: f64 = 6.93147180369123816490e-01;
    const LN2_LO: f64 = 1.90821492927058770002e-10;
    const TWO54: f64 = 1.80143985094819840000e+16;
    const LG: [f64; 7] = [6.666666666666735130e-01, 3.999999999940941908e-01, 2.857142874366239149e-01, 2.222219843214978396e-01, 1.818357216161805012e-01, 1.531383769920937332e-01, 1.479819860511658591e-01];
    let mut hx = super::high(x) as i32;
    let lx = x.to_bits() as u32;
    let mut k = 0;
    if hx < 0x00100000 {
        if ((hx as u32 & 0x7fffffff) | lx) == 0 { return f64::NEG_INFINITY; }
        if hx < 0 { return f64::NAN; }
        k -= 54;
        x *= TWO54;
        hx = super::high(x) as i32;
    }
    if hx >= 0x7ff00000 { return x + x; }
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    let i = (hx + 0x95f64) & 0x100000;
    x = f64::from_bits((x.to_bits() & 0xffffffff) | ((hx | (i ^ 0x3ff00000)) as u64) << 32);
    k += i >> 20;
    let f = x - 1.0;
    let dk = k as f64;
    if (0x000fffff & (2 + hx)) < 3 {
        if f == 0.0 { return if k == 0 { 0.0 } else { dk * LN2_HI + dk * LN2_LO }; }
        let r = f * f * (0.5 - 0.33333333333333333 * f);
        return if k == 0 { f - r } else { dk * LN2_HI - ((r - dk * LN2_LO) - f) };
    }
    let s = f / (2.0 + f);
    let z = s * s;
    let w = z * z;
    let t1 = w * (LG[1] + w * (LG[3] + w * LG[5]));
    let t2 = z * (LG[0] + w * (LG[2] + w * (LG[4] + w * LG[6])));
    let r = t2 + t1;
    if ((hx - 0x6147a) | (0x6b851 - hx)) > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 { f - (hfsq - s * (hfsq + r)) } else { dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f) }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}
