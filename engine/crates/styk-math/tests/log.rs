//! Math.log recorded from Node 24's V8 before using it in follow-camera stored arithmetic.
#[test]
fn natural_logarithm_matches_v8() {
    let bytes = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/log.bin")).unwrap();
    assert!(bytes.len() / 16 > 24_000);
    for pair in bytes.chunks_exact(16) {
        let x = f64::from_le_bytes(pair[..8].try_into().unwrap());
        let want = f64::from_le_bytes(pair[8..].try_into().unwrap());
        let got = styk_math::log(x);
        assert!(got.to_bits() == want.to_bits() || got.is_nan() && want.is_nan(), "log({x:e}): {got:e}, V8 {want:e}");
    }
}
