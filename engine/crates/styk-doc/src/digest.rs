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

/// Bytes hashed between two questions to `cancel` in [`sha256_until`]: tens of milliseconds even in WebAssembly.
const CANCEL_STRIDE: usize = 4 << 20;

/// [`sha256`], asking `cancel` every few megabytes; `None` once it says so, with the hash dropped.
pub fn sha256_until(bytes: &[u8], cancel: &dyn Fn() -> bool) -> Option<[u8; 32]> {
    let mut hasher = Sha256::new();
    for stride in bytes.chunks(CANCEL_STRIDE) {
        if cancel() {
            return None;
        }
        update(&mut hasher, stride);
    }
    Some(hasher.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stepped_digest_equals_one_shot_digest() {
        let bytes: Vec<u8> = (0..STEP * 3 + 77).map(|i| (i * 31 + i / 7) as u8).collect();
        for length in [0, 1, 63, 64, 65, STEP - 1, STEP, STEP + 1, STEP * 2, STEP * 3, bytes.len()] {
            assert_eq!(sha256(&bytes[..length]), <[u8; 32]>::from(Sha256::digest(&bytes[..length])), "{length} bytes");
        }
        let mut hasher = Sha256::new();
        update(&mut hasher, &bytes[..5]);
        update(&mut hasher, &bytes[5..]);
        assert_eq!(<[u8; 32]>::from(hasher.finalize()), sha256(&bytes));
    }

    #[test]
    fn a_hash_that_may_be_stopped_asks_every_stride_and_gives_the_same_digest() {
        let bytes: Vec<u8> = (0..CANCEL_STRIDE * 2 + 5).map(|i| (i * 13 + i / 5) as u8).collect();
        let asked = std::cell::Cell::new(0);
        let digest = sha256_until(&bytes, &|| { asked.set(asked.get() + 1); false });
        assert_eq!(digest, Some(sha256(&bytes)));
        assert_eq!(asked.get(), 3, "once before each stride");
        assert_eq!(sha256_until(&[], &|| true), Some(sha256(&[])), "nothing to hash is nothing to stop");
        let asked = std::cell::Cell::new(0);
        assert_eq!(sha256_until(&bytes, &|| { asked.set(asked.get() + 1); asked.get() == 2 }), None);
        assert_eq!(asked.get(), 2, "it stops at the question, not a stride later");
    }
}
