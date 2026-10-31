//! Payloads: the pictures and originals a document holds as [`Blob`]s, named by a token.
//!
//! The interface's read view does not hold a picture's text. Where a file lifts a large blob out of the
//! skeleton (`S2S:`, `S2D:`), the view names it with a token (`S2P:<token>`) and asks for the text on first
//! use ([`text`]). A token is minted for a blob the view is shown ([`register`]), once per blob. The registry
//! holds blobs weakly: a payload no document or history entry holds any more is gone, and its token answers
//! `None`, so naming a payload never keeps a deleted picture alive.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use crate::Blob;

/// Blobs whose text is shorter than this (in UTF-16 units) stay in the skeleton, in files and in the view.
pub const MIN_LEN: usize = 64 * 1024;

/// The text of a payload token is this prefix and its number.
pub const MARKER: &str = "S2P:";

/// Whether a file lifts `blob` out of the skeleton when it is held under `key`: the base64 fields of pictures
/// and originals, and the `data:` URLs of pictures and drawing tiles, from [`MIN_LEN`] on.
pub fn lifts(blob: &Blob, key: &str) -> bool {
    if blob.text_len() < MIN_LEN {
        return false;
    }
    match key {
        "data_base64" | "source_base64" => blob.prefix.is_empty(),
        "data_url" | "styk_tiles" => {
            let prefix: &str = &blob.prefix;
            prefix.starts_with("data:") && prefix.find(',') == Some(prefix.len() - 1) && prefix.len() - 1 > 5 && prefix[..prefix.len() - 1].ends_with(";base64")
        }
        _ => false,
    }
}

#[derive(Default)]
struct Registry {
    next: u64,
    tokens: HashMap<u64, Weak<Blob>>,
    /// The token of a blob, by its address (checked against the blob on lookup: an address can be reused).
    by_address: HashMap<usize, u64>,
    /// Entries at the last purge; the next one comes when the table has doubled.
    purged_at: usize,
}

static REGISTRY: Mutex<Option<Registry>> = Mutex::new(None);

fn registry<T>(then: impl FnOnce(&mut Registry) -> T) -> T {
    let mut guard = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    then(guard.get_or_insert_with(Registry::default))
}

/// The token that names `blob`, minted on first use.
pub fn register(blob: &Arc<Blob>) -> u64 {
    registry(|r| {
        let address = Arc::as_ptr(blob) as usize;
        if let Some(&token) = r.by_address.get(&address)
            && r.tokens.get(&token).and_then(Weak::upgrade).is_some_and(|held| Arc::ptr_eq(&held, blob))
        {
            return token;
        }
        if r.tokens.len() >= r.purged_at.max(256) * 2 {
            r.tokens.retain(|_, weak| weak.strong_count() > 0);
            let live: std::collections::HashSet<u64> = r.tokens.keys().copied().collect();
            r.by_address.retain(|_, token| live.contains(token));
            r.purged_at = r.tokens.len();
        }
        r.next += 1;
        let token = r.next;
        r.tokens.insert(token, Arc::downgrade(blob));
        r.by_address.insert(address, token);
        token
    })
}

/// The blob a token names, while a document or history entry still holds it.
pub fn blob(token: u64) -> Option<Arc<Blob>> {
    registry(|r| r.tokens.get(&token).and_then(Weak::upgrade))
}

/// The text a payload stands for: its prefix and the base64 of its bytes.
pub fn text(token: u64) -> Option<String> {
    let blob = blob(token)?;
    let mut out = String::with_capacity(blob.prefix.len() + blob.bytes.len().div_ceil(3) * 4);
    out.push_str(&blob.prefix);
    // SAFETY: base64 appends ASCII only, so `out` stays valid UTF-8.
    crate::json::base64_into(&blob.bytes, unsafe { out.as_mut_vec() });
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(prefix: &str, size: usize) -> Arc<Blob> {
        Arc::new(Blob { prefix: Arc::from(prefix), bytes: Arc::from(vec![7u8; size]) })
    }

    #[test]
    fn a_token_names_its_blob_and_gives_its_text() {
        let picture = sample("data:image/png;base64,", 3);
        let token = register(&picture);
        assert_eq!(register(&picture), token, "a blob has one token");
        assert_eq!(text(token).as_deref(), Some("data:image/png;base64,BwcH"));
        assert!(Arc::ptr_eq(&blob(token).unwrap(), &picture));
    }

    #[test]
    fn a_payload_nothing_holds_any_more_is_gone() {
        let picture = sample("", 10);
        let token = register(&picture);
        drop(picture);
        assert_eq!(text(token), None);
        let other = sample("", 10);
        assert_ne!(register(&other), token, "a reused address is another payload");
    }

    #[test]
    fn the_table_forgets_what_is_gone() {
        for _ in 0..2000 {
            register(&sample("", 1));
        }
        let held = sample("", 1);
        register(&held);
        assert!(registry(|r| r.tokens.len()) < 1200, "dead entries are purged as the table grows");
    }

    #[test]
    fn only_large_picture_fields_lift() {
        let large = sample("data:image/png;base64,", MIN_LEN);
        assert!(lifts(&large, "data_url") && lifts(&large, "styk_tiles") && !lifts(&large, "data_base64") && !lifts(&large, "name"));
        assert!(lifts(&sample("", MIN_LEN), "data_base64") && lifts(&sample("", MIN_LEN), "source_base64"));
        assert!(!lifts(&sample("", 100), "data_base64"), "short text stays in the skeleton");
        assert!(!lifts(&sample("x,", MIN_LEN), "data_url"), "the prefix must be a base64 data URL");
    }
}
