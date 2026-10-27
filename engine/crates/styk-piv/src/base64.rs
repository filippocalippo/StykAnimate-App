//! Base64 decoding with the acceptance rules of Python's `binascii.a2b_base64`.
//!
//! The codec decodes embedded media and original sources with
//! `base64.b64decode(text, validate=True)`. What that accepts is not "canonical
//! base64": `AAAA=` is fine, unused low bits are ignored, whitespace is not
//! allowed. The same strings must be accepted and rejected here.

fn value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// `base64.b64decode(text, validate=strict)`. `None` where Python raises
/// `binascii.Error` (a `ValueError`); the callers replace its text.
pub(crate) fn decode(text: &[u8], strict: bool) -> Option<Vec<u8>> {
    // `b64decode` first encodes a `str` argument as ASCII.
    if !text.is_ascii() {
        return None;
    }
    if strict && text.first() == Some(&b'=') {
        return None;
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let (mut quad, mut left, mut pads) = (0u8, 0u8, 0u8);
    let mut padding_started = false;
    for (index, &byte) in text.iter().enumerate() {
        if byte == b'=' {
            padding_started = true;
            if quad >= 2 {
                pads += 1;
                if quad + pads >= 4 {
                    // The quad is complete: nothing may follow in strict mode.
                    if strict && index + 1 < text.len() {
                        return None;
                    }
                    return Some(out);
                }
            }
            continue;
        }
        let Some(bits) = value(byte) else {
            if strict {
                return None;
            }
            continue;
        };
        if strict && padding_started {
            return None;
        }
        pads = 0;
        match quad {
            0 => {
                quad = 1;
                left = bits;
            }
            1 => {
                quad = 2;
                out.push((left << 2) | (bits >> 4));
                left = bits & 0x0f;
            }
            2 => {
                quad = 3;
                out.push((left << 4) | (bits >> 2));
                left = bits & 0x03;
            }
            _ => {
                quad = 0;
                out.push((left << 6) | bits);
                left = 0;
            }
        }
    }
    (quad == 0).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_mode_accepts_and_rejects_what_python_does() {
        // `base64.b64decode(x, validate=True)` in CPython 3.12.
        assert_eq!(decode(b"aGkh", true), Some(b"hi!".to_vec()));
        assert_eq!(decode(b"aGk=", true), Some(b"hi".to_vec()));
        assert_eq!(decode(b"aA==", true), Some(b"h".to_vec()));
        assert_eq!(decode(b"", true), Some(Vec::new()));
        // Unused low bits are ignored, and a pad after complete quads is accepted.
        assert_eq!(decode(b"aB==", true), Some(b"h".to_vec()));
        assert_eq!(decode(b"aGkh=", true), Some(b"hi!".to_vec()));
        for bad in [&b"aGk"[..], b"a", b"=aGk", b"aGk=x", b"aG k", b"aA=a", b"aGkh=aGkh", b"aGk==", "é".as_bytes()] {
            assert_eq!(decode(bad, true), None, "{bad:?}");
        }
    }

    #[test]
    fn lenient_mode_skips_other_characters() {
        assert_eq!(decode(b"aG\nkh", false), Some(b"hi!".to_vec()));
        assert_eq!(decode(b"aGk", false), None);
    }
}
