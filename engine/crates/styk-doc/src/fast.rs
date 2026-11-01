//! A fast hasher for the maps the engine keeps by object key or by figure id. Their keys are short strings and small integers the engine
//! chooses (never an attacker's), where the standard hasher's SipHash costs more than the lookup it serves: every `Obj::get` of an object
//! with more than a few keys went through it. Fx hashing (the multiply-and-rotate of rustc's own maps).

use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

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

    #[inline]
    fn finish(&self) -> u64 { self.0 }
}

pub type FastBuild = BuildHasherDefault<FastHasher>;
pub type FastMap<K, V> = HashMap<K, V, FastBuild>;
pub type FastSet<K> = HashSet<K, FastBuild>;

#[cfg(test)]
mod tests {
    use super::*;

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
