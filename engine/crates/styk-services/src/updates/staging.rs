//! Names and ownership records for the update download, which every process of a user shares.
//!
//! All processes use `%LOCALAPPDATA%\StykAnimate\updates\<version>\`. One of them downloads at a time, under a lock file
//! it creates exclusively; its partial file has a name no other process uses; the verified installer is renamed to a
//! name derived from its hash and is never written again. The file operations are in `styk_platform::windows::updates`.

/// The name of the lock file in a version's staging folder.
pub const LOCK_FILE: &str = "download.lock";

/// A lock older than this is stale even if its process still exists (pids are reused).
pub const LOCK_MAX_AGE_MS: u64 = 2 * 60 * 60 * 1000;

/// Who holds the download lock, and since when.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockRecord {
    /// The process id.
    pub pid: u32,
    /// When it took the lock, in milliseconds since the Unix epoch.
    pub since_ms: u64,
}

impl LockRecord {
    /// The file's text.
    pub fn to_text(&self) -> String {
        format!("{} {}\n", self.pid, self.since_ms)
    }

    /// Reads a lock file; a damaged one is `None` (and counts as stale).
    pub fn parse(text: &str) -> Option<LockRecord> {
        let mut parts = text.split_whitespace();
        let record = LockRecord { pid: parts.next()?.parse().ok()?, since_ms: parts.next()?.parse().ok()? };
        parts.next().is_none().then_some(record)
    }

    /// Whether the lock may be taken over: its holder is gone, or it has been held for too long, or the file is damaged.
    pub fn is_stale(record: Option<LockRecord>, now_ms: u64, alive: &dyn Fn(u32) -> bool) -> bool {
        match record {
            None => true,
            Some(lock) => !alive(lock.pid) || now_ms.saturating_sub(lock.since_ms) > LOCK_MAX_AGE_MS,
        }
    }
}

/// The base64 alphabet's value of a character, for decoding a feed's hash.
fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decodes standard base64 with padding; `None` for anything else.
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let last = index + 1 == bytes.len() / 4;
        let pad = chunk.iter().rev().take_while(|b| **b == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return None;
        }
        let mut value = 0u32;
        for b in &chunk[..4 - pad] {
            value = (value << 6) | u32::from(base64_value(*b)?);
        }
        value <<= 6 * pad as u32;
        out.extend_from_slice(&value.to_be_bytes()[1..4 - pad]);
    }
    Some(out)
}

/// Standard base64 with padding.
pub fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[((value >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The immutable name of a verified installer: `Setup-<version>-<first 8 bytes of its sha512, hex>.exe`. The same bytes
/// always get the same name, so a second process that finds it knows what it is.
pub fn artifact_name(version: &str, sha512_b64: &str) -> Option<String> {
    let digest = decode_base64(sha512_b64).filter(|d| d.len() == 64)?;
    if version.is_empty() || version.len() > 40 || !version.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+')) {
        return None;
    }
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    Some(format!("Setup-{version}-{hex}.exe"))
}

/// A partial download's name: private to one process and one attempt.
pub fn part_name(pid: u32, attempt: u64) -> String {
    format!("Setup.{pid}.{attempt:x}.part")
}

/// Whether a file name in a staging folder is a partial download.
pub fn is_part_name(name: &str) -> bool {
    name.starts_with("Setup.") && name.ends_with(".part")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "AkhkLETWEbqgXa8ZyQhjSA5e8jKYbYsvkvA68ambkVXg5cIyhSObh8m2qeCWxuLiJSTbLyomjQwEwAZAzvJhtw==";

    #[test]
    fn base64_decodes_the_real_hash_to_64_bytes() {
        let bytes = decode_base64(SHA).unwrap();
        assert_eq!(bytes.len(), 64);
        assert_eq!(&bytes[..8], &[0x02, 0x48, 0x64, 0x2c, 0x44, 0xd6, 0x11, 0xba]);
        assert_eq!(encode_base64(&bytes), SHA, "encoding is the decoding's inverse");
        for sample in [&b""[..], b"M", b"Ma", b"Man", b"Many"] {
            assert_eq!(decode_base64(&encode_base64(sample)).unwrap(), sample);
        }
        assert_eq!(decode_base64("TWFu").unwrap(), b"Man");
        assert_eq!(decode_base64("TWE=").unwrap(), b"Ma");
        assert_eq!(decode_base64("TQ==").unwrap(), b"M");
        for bad in ["TWF", "TW=u", "T===", "TW!u", "=WFu"] {
            assert_eq!(decode_base64(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_artifact_name_follows_the_bytes() {
        assert_eq!(artifact_name("1.2.0", SHA).unwrap(), "Setup-1.2.0-0248642c44d611ba.exe");
        assert_eq!(artifact_name("../1", SHA), None);
        assert_eq!(artifact_name("1.2.0", "AAAA"), None, "not a sha512");
    }

    #[test]
    fn partial_files_have_private_names() {
        assert_ne!(part_name(10, 1), part_name(11, 1));
        assert_ne!(part_name(10, 1), part_name(10, 2));
        assert!(is_part_name(&part_name(10, 255)) && !is_part_name("Setup-1.2.0-0248642c44d611ba.exe") && !is_part_name(LOCK_FILE));
    }

    #[test]
    fn a_lock_is_stale_when_its_holder_is_gone_old_or_unreadable() {
        let lock = LockRecord { pid: 7, since_ms: 1_000 };
        assert_eq!(LockRecord::parse(&lock.to_text()), Some(lock));
        assert!(!LockRecord::is_stale(Some(lock), 2_000, &|_| true));
        assert!(LockRecord::is_stale(Some(lock), 2_000, &|_| false), "the holder died");
        assert!(LockRecord::is_stale(Some(lock), 1_000 + LOCK_MAX_AGE_MS + 1, &|_| true), "pid reuse cannot hold a lock forever");
        assert!(LockRecord::is_stale(None, 0, &|_| true));
        assert_eq!(LockRecord::parse("7"), None);
        assert_eq!(LockRecord::parse("7 8 9"), None);
        assert_eq!(LockRecord::parse("x y"), None);
    }
}
