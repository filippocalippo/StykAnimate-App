#[cfg(not(feature = "std"))]
use alloc::{string::String, vec::Vec};
use core::ops::Range;

use crate::{AttrsOwned, HashMap, ShapeGlyph};

/// Key for caching shape runs.
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct ShapeRunKey {
    pub text: String,
    pub default_attrs: AttrsOwned,
    pub attrs_spans: Vec<(Range<usize>, AttrsOwned)>,
    /// The run is shaped right to left (the same text shapes differently in the two directions).
    pub rtl: bool,
}

/// The longest run (in bytes) that is cached.
pub const MAX_CACHED_RUN_BYTES: usize = 256;

/// The most runs the cache holds before it starts again (a bound on its memory when nothing trims it).
pub const MAX_CACHED_RUNS: usize = 32_768;

/// A helper structure for caching shape runs.
#[derive(Clone, Default)]
pub struct ShapeRunCache {
    age: u64,
    misses: u64,
    cache: HashMap<ShapeRunKey, (u64, Vec<ShapeGlyph>)>,
}

impl ShapeRunCache {
    /// Get cache item, updating age if found
    pub fn get(&mut self, key: &ShapeRunKey) -> Option<&Vec<ShapeGlyph>> {
        self.cache.get_mut(key).map(|(age, glyphs)| {
            *age = self.age;
            &*glyphs
        })
    }

    /// Insert cache item with current age
    pub fn insert(&mut self, key: ShapeRunKey, glyphs: Vec<ShapeGlyph>) {
        if self.cache.len() >= MAX_CACHED_RUNS {
            self.cache.clear();
        }
        self.misses += 1;
        self.cache.insert(key, (self.age, glyphs));
    }

    /// How many runs were not found (and so were shaped and inserted) since the cache was made.
    pub fn misses(&self) -> u64 {
        self.misses
    }

    /// How many runs the cache holds.
    pub fn len(&self) -> usize {
        self.cache.len()
    }

    /// Whether the cache holds nothing.
    pub fn is_empty(&self) -> bool {
        self.cache.is_empty()
    }

    /// Remove anything in the cache with an age older than `keep_ages`
    pub fn trim(&mut self, keep_ages: u64) {
        self.cache
            .retain(|_key, (age, _glyphs)| *age + keep_ages >= self.age);
        // Increase age
        self.age += 1;
    }
}

impl core::fmt::Debug for ShapeRunCache {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_tuple("ShapeRunCache").finish()
    }
}
