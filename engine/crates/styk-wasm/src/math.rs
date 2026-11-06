//! The engine's `Math` (styk-math: Node's V8 results, D16) for verification harnesses,
//! which put these in place of the browser's `Math` functions so the JavaScript editor computes
//! what Node computes and its results can be compared with the engine's exactly. The app never
//! calls them.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn math_sin(x: f64) -> f64 {
    styk_math::sin(x)
}

#[wasm_bindgen]
pub fn math_cos(x: f64) -> f64 {
    styk_math::cos(x)
}

#[wasm_bindgen]
pub fn math_atan2(y: f64, x: f64) -> f64 {
    styk_math::atan2(y, x)
}

#[wasm_bindgen]
pub fn math_hypot(x: f64, y: f64) -> f64 {
    styk_math::hypot(x, y)
}

/// `Math.hypot(...values)` for any count.
#[wasm_bindgen]
pub fn math_norm(values: &[f64]) -> f64 {
    styk_math::norm(values)
}

#[wasm_bindgen]
pub fn math_asin(x: f64) -> f64 {
    styk_math::asin(x)
}

#[wasm_bindgen]
pub fn math_acos(x: f64) -> f64 {
    styk_math::acos(x)
}

#[wasm_bindgen]
pub fn math_log(x: f64) -> f64 {
    styk_math::log(x)
}
