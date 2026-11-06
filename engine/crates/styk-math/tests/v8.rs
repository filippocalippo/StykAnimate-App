//! styk-math against what V8 returned (engine/tools/math-fixtures.mjs), bit for bit.

fn read(name: &str) -> Vec<f64> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join(name);
    std::fs::read(path).unwrap().chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()
}

fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
}

#[test]
fn sine_and_cosine() {
    let cases = read("sincos.bin");
    let wrong: Vec<String> = cases
        .chunks_exact(3)
        .filter(|c| !same(styk_math::sin(c[0]), c[1]) || !same(styk_math::cos(c[0]), c[2]))
        .map(|c| format!("x {:e}: sin {:e} (V8 {:e}), cos {:e} (V8 {:e})", c[0], styk_math::sin(c[0]), c[1], styk_math::cos(c[0]), c[2]))
        .collect();
    assert!(cases.len() > 18_000 && wrong.is_empty(), "{} of {} differ: {:#?}", wrong.len(), cases.len() / 3, &wrong[..wrong.len().min(10)]);
}

#[test]
fn arc_tangent_and_hypotenuse() {
    let cases = read("atan2-hypot.bin");
    for c in cases.chunks_exact(4) {
        assert!(same(styk_math::atan2(c[0], c[1]), c[2]), "atan2({:e}, {:e})", c[0], c[1]);
        assert!(same(styk_math::hypot(c[0], c[1]), c[3]), "hypot({:e}, {:e})", c[0], c[1]);
    }
}

#[test]
fn exponential() {
    let cases = read("exp.bin");
    let wrong: Vec<String> = cases.chunks_exact(2).filter(|c| !same(styk_math::exp(c[0]), c[1])).map(|c| format!("exp({:e}) = {:e} (V8 {:e})", c[0], styk_math::exp(c[0]), c[1])).collect();
    assert!(cases.len() > 12_000 && wrong.is_empty(), "{} of {} differ: {:#?}", wrong.len(), cases.len() / 2, &wrong[..wrong.len().min(10)]);
}

#[test]
fn logarithm_of_one_plus() {
    let cases = read("log1p.bin");
    let wrong: Vec<String> = cases.chunks_exact(2).filter(|c| !same(styk_math::log1p(c[0]), c[1])).map(|c| format!("log1p({:e}) = {:e} (V8 {:e})", c[0], styk_math::log1p(c[0]), c[1])).collect();
    assert!(cases.len() > 24_000 && wrong.is_empty(), "{} of {} differ: {:#?}", wrong.len(), cases.len() / 2, &wrong[..wrong.len().min(10)]);
}

/// The platform's functions are not V8's: the reason this crate exists. If this
/// starts failing, std became V8-exact on this platform and the crate could go.
#[test]
fn std_differs_from_v8() {
    let cases = read("sincos.bin");
    assert!(cases.chunks_exact(3).any(|c| !same(c[0].cos(), c[2]) || !same(libm::cos(c[0]), c[2])));
}

#[test]
fn arc_sine_and_arc_cosine() {
    let cases = read("asin-acos.bin");
    let wrong: Vec<String> = cases
        .chunks_exact(3)
        .filter(|c| !same(styk_math::asin(c[0]), c[1]) || !same(styk_math::acos(c[0]), c[2]))
        .map(|c| format!("x {:e}: asin {:e} (V8 {:e}), acos {:e} (V8 {:e})", c[0], styk_math::asin(c[0]), c[1], styk_math::acos(c[0]), c[2]))
        .collect();
    assert!(cases.len() / 3 > 15_000 && wrong.is_empty(), "{} of {} differ: {:#?}", wrong.len(), cases.len() / 3, &wrong[..wrong.len().min(10)]);
    // The platform's do not agree with V8 here either.
    assert!(cases.chunks_exact(3).any(|c| !same(c[0].asin(), c[1]) || !same(c[0].acos(), c[2])));
}

#[test]
fn power() {
    let cases = read("pow.bin");
    let wrong: Vec<String> = cases.chunks_exact(3).filter(|c| !same(styk_math::pow(c[0], c[1]), c[2])).map(|c| format!("pow({:e}, {:e}) = {:e} (V8 {:e})", c[0], c[1], styk_math::pow(c[0], c[1]), c[2])).collect();
    assert!(cases.len() / 3 > 80_000 && wrong.is_empty(), "{} of {} differ: {:#?}", wrong.len(), cases.len() / 3, &wrong[..wrong.len().min(10)]);
    // Neither the platform's pow nor the libm crate's (fdlibm 5.3 as FreeBSD and musl have it) is V8's own.
    assert!(cases.chunks_exact(3).any(|c| !same(c[0].powf(c[1]), c[2])));
    assert!(cases.chunks_exact(3).any(|c| !same(libm::pow(c[0], c[1]), c[2])));
}
