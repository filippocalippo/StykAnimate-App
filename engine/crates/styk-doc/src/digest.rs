//! SHA-256 of large buffers, fed in steps.
//!
//! V8 compiles WebAssembly with a baseline compiler first and optimises a function only between calls
//! (no on-stack replacement). Hashing a 175 MB container in one `update` is one call of the block
//! function for its whole run, which therefore never leaves the baseline tier: about eight times slower
//! than optimised code (`docs/engine/formats.md`, "Hashing large buffers"). Each step here is a call of its own, so the optimised
//! code is picked up within the first megabyte. The digest is the same whatever the step.

use sha2::{Digest, Sha256};

/// Bytes per step: a few hundred blocks, enough to use up V8's tier-up budget in the first step or two.
const STEP: usize = 16 * 1024;

#[inline(never)]
fn step(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(bytes);
}

/// `hasher.update(bytes)` in steps.
pub fn update(hasher: &mut Sha256, bytes: &[u8]) {
    for chunk in bytes.chunks(STEP) {
        step(hasher, chunk);
    }
}

/// The SHA-256 digest of `bytes`.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    update(&mut hasher, bytes);
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stepped_digest_equals_one_shot_digest() {
        let bytes: Vec<u8> = (0..STEP * 3 + 77).map(|i| (i * 31 + i / 7) as u8).collect();
        assert_eq!(sha256(&bytes), <[u8; 32]>::from(Sha256::digest(&bytes)));
        assert_eq!(sha256(&[]), <[u8; 32]>::from(Sha256::digest([])));
        let mut hasher = Sha256::new();
        update(&mut hasher, &bytes[..5]);
        update(&mut hasher, &bytes[5..]);
        assert_eq!(<[u8; 32]>::from(hasher.finalize()), sha256(&bytes));
    }
}
