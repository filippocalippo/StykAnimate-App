//! A fast hasher for maps whose keys the engine makes: small integers (figure ids), addresses of nodes, tile coordinates. It is Fx hashing (the
//! multiply-and-rotate of rustc's own maps) with a final mix, and it is not safe for a key that can come from a file: someone who knows it can
//! build keys that all hash alike, and a map of them takes quadratic time. **Strings of a document (object keys, names, ids a file chooses) go
//! in a standard `HashMap`**, whose SipHash does not have that weakness (`Shape::index` does; a parser that keys by what it reads should too).

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

pub(crate) const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

#[derive(Default, Clone, Copy)]
pub struct FastHasher(u64);

impl FastHasher {
    #[inline]
    fn add(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(SEED);
    }
}

impl Hasher for FastHasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        let mut chunks = bytes.chunks_exact(8);
        for chunk in &mut chunks {
            self.add(u64::from_le_bytes(chunk.try_into().expect("a chunk of eight bytes")));
        }
        let rest = chunks.remainder();
        if !rest.is_empty() {
            let mut word = [0u8; 8];
            word[..rest.len()].copy_from_slice(rest);
            self.add(u64::from_le_bytes(word) ^ ((rest.len() as u64) << 56));
        }
    }

    #[inline]
    fn write_u8(&mut self, value: u8) { self.add(value as u64); }
    #[inline]
    fn write_u32(&mut self, value: u32) { self.add(value as u64); }
    #[inline]
    fn write_u64(&mut self, value: u64) { self.add(value); }
    #[inline]
    fn write_usize(&mut self, value: usize) { self.add(value as u64); }

    /// The state mixed once more: the multiplication leaves the low bits of keys that are multiples of a power of two (page-aligned addresses)
    /// unchanged, and a table indexes by them.
    #[inline]
    fn finish(&self) -> u64 {
        let mut mixed = self.0;
        mixed ^= mixed >> 32;
        mixed = mixed.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        mixed ^ (mixed >> 29)
    }
}

pub type FastBuild = BuildHasherDefault<FastHasher>;
pub type FastMap<K, V> = HashMap<K, V, FastBuild>;
pub type FastSet<K> = HashSet<K, FastBuild>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_a_power_of_two_apart_do_not_all_collide() {
        // Addresses of nodes, four kilobytes apart: the multiplication alone leaves their low bits equal.
        let started = std::time::Instant::now();
        let map: FastMap<usize, u32> = (0..300_000usize).map(|n| (0x1000_0000 + n * 4096, n as u32)).collect();
        assert!((0..300_000usize).all(|n| map.get(&(0x1000_0000 + n * 4096)) == Some(&(n as u32))));
        assert!(started.elapsed() < std::time::Duration::from_secs(3), "page-aligned keys took {:?}", started.elapsed());
    }

    #[test]
    fn a_fast_map_finds_what_it_holds() {
        let mut map: FastMap<std::sync::Arc<str>, u32> = FastMap::default();
        for (at, key) in ["root_x", "root_y", "angles", "unique_id", "figure_type_id", "object_slot", "x", "xy"].iter().enumerate() {
            map.insert(std::sync::Arc::from(*key), at as u32);
        }
        assert_eq!(map.get("angles"), Some(&2));
        assert_eq!(map.get("figure_type_id"), Some(&4));
        assert_eq!(map.get("x"), Some(&6));
        assert_eq!(map.get("xy"), Some(&7));
        assert_eq!(map.get("missing"), None);
        let numbers: FastMap<u32, usize> = (0..1000u32).map(|n| (n * 7, n as usize)).collect();
        assert!((0..1000u32).all(|n| numbers.get(&(n * 7)) == Some(&(n as usize))));
    }
}
