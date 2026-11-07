//! What a second start says to the running one: a length-prefixed request and a one-line answer.
//!
//! Every size is checked before anything is allocated or read, so a client cannot make the server hold more than
//! [`MAX_MESSAGE`] bytes.

use super::launch::{LaunchRequest, MAX_FILES_PER_REQUEST};
use super::protocol::parse_protocol;
use std::path::PathBuf;

/// The longest payload accepted, in bytes.
pub const MAX_MESSAGE: usize = 8 * 1024;

/// The server's answers, each one line.
pub const ANSWER_OK: &[u8] = b"OK\n";
/// The request is well formed but the queue is full: try again.
pub const ANSWER_BUSY: &[u8] = b"BUSY\n";
/// The request is refused for good.
pub const ANSWER_BAD: &[u8] = b"BAD\n";

/// What the server said.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// The request is in the queue.
    Ok,
    /// The queue is full.
    Busy,
    /// The request was refused.
    Bad,
}

/// Reads the server's answer line; anything else is `None`.
pub fn parse_answer(bytes: &[u8]) -> Option<Answer> {
    match bytes {
        ANSWER_OK => Some(Answer::Ok),
        ANSWER_BUSY => Some(Answer::Busy),
        ANSWER_BAD => Some(Answer::Bad),
        _ => None,
    }
}

/// Why a request could not be encoded or read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WireError {
    /// Longer than [`MAX_MESSAGE`].
    TooLarge,
    /// More files than a request may carry, or none.
    BadFileCount,
    /// Not a request: wrong tag, bad text, an invalid link, a path with a line break.
    Malformed,
}

/// The request as a frame: four bytes of payload length (little endian), then the payload.
pub fn encode(request: &LaunchRequest) -> Result<Vec<u8>, WireError> {
    let payload = match request {
        LaunchRequest::Files(files) => {
            if files.is_empty() || files.len() > MAX_FILES_PER_REQUEST {
                return Err(WireError::BadFileCount);
            }
            let mut text = String::from("F");
            for file in files {
                let path = file.to_string_lossy();
                if path.contains(['\n', '\r', '\0']) {
                    return Err(WireError::Malformed);
                }
                text.push('\n');
                text.push_str(&path);
            }
            text
        }
        LaunchRequest::Protocol(link) => format!("L\n{}", link.to_url()),
    };
    if payload.len() > MAX_MESSAGE {
        return Err(WireError::TooLarge);
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload.as_bytes());
    Ok(frame)
}

/// The payload length a frame header announces, checked against [`MAX_MESSAGE`] before any payload is read.
pub fn payload_len(header: [u8; 4]) -> Result<usize, WireError> {
    let len = u32::from_le_bytes(header) as usize;
    if len == 0 {
        Err(WireError::Malformed)
    } else if len > MAX_MESSAGE {
        Err(WireError::TooLarge)
    } else {
        Ok(len)
    }
}

/// The request a payload holds.
pub fn decode(payload: &[u8]) -> Result<LaunchRequest, WireError> {
    if payload.len() > MAX_MESSAGE {
        return Err(WireError::TooLarge);
    }
    let text = std::str::from_utf8(payload).map_err(|_| WireError::Malformed)?;
    let mut lines = text.split('\n');
    match lines.next() {
        Some("F") => {
            let files: Vec<PathBuf> = lines.map(PathBuf::from).collect();
            if files.is_empty() || files.len() > MAX_FILES_PER_REQUEST || files.iter().any(|file| file.as_os_str().is_empty()) {
                return Err(WireError::BadFileCount);
            }
            Ok(LaunchRequest::Files(files))
        }
        Some("L") => {
            let url = lines.next().ok_or(WireError::Malformed)?;
            if lines.next().is_some() {
                return Err(WireError::Malformed);
            }
            parse_protocol(url).map(LaunchRequest::Protocol).ok_or(WireError::Malformed)
        }
        _ => Err(WireError::Malformed),
    }
}

#[cfg(test)]
mod tests {
    use super::super::protocol::{ProtocolLink, PublicId};
    use super::*;

    fn round_trip(request: LaunchRequest) {
        let frame = encode(&request).unwrap();
        let len = payload_len(frame[..4].try_into().unwrap()).unwrap();
        assert_eq!(len, frame.len() - 4);
        assert_eq!(decode(&frame[4..]).unwrap(), request);
    }

    #[test]
    fn requests_round_trip() {
        round_trip(LaunchRequest::Protocol(ProtocolLink::Library(PublicId::parse("abcdefghij"))));
        round_trip(LaunchRequest::Protocol(ProtocolLink::Open));
        round_trip(LaunchRequest::Files(vec!["C:\\Users\\a b\\x.piv".into(), "ü.styk".into()]));
    }

    #[test]
    fn sizes_are_checked_before_anything_is_read() {
        assert_eq!(payload_len(((MAX_MESSAGE + 1) as u32).to_le_bytes()), Err(WireError::TooLarge));
        assert_eq!(payload_len(u32::MAX.to_le_bytes()), Err(WireError::TooLarge));
        assert_eq!(payload_len(0u32.to_le_bytes()), Err(WireError::Malformed));
        assert_eq!(payload_len((MAX_MESSAGE as u32).to_le_bytes()), Ok(MAX_MESSAGE));
    }

    #[test]
    fn too_many_or_too_long_is_refused_when_encoding() {
        let many: Vec<PathBuf> = (0..=MAX_FILES_PER_REQUEST).map(|n| format!("{n}.piv").into()).collect();
        assert_eq!(encode(&LaunchRequest::Files(many)), Err(WireError::BadFileCount));
        assert_eq!(encode(&LaunchRequest::Files(vec![])), Err(WireError::BadFileCount));
        assert_eq!(encode(&LaunchRequest::Files(vec!["a".repeat(MAX_MESSAGE).into()])), Err(WireError::TooLarge));
        assert_eq!(encode(&LaunchRequest::Files(vec!["a\nb.piv".into()])), Err(WireError::Malformed));
    }

    #[test]
    fn garbage_is_malformed_not_a_request() {
        for bad in [&b""[..], b"X\nfoo", b"F", b"F\n", b"L", b"L\nhttps://open", b"L\nstykanimate://open?x=1", b"L\nstykanimate://open\nextra", b"\xff\xfe", b"F\n\n"] {
            assert!(decode(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn an_invalid_link_cannot_cross_the_pipe() {
        assert_eq!(decode(b"L\nstykanimate://library/../x"), Err(WireError::Malformed));
    }

    #[test]
    fn answers_are_one_line() {
        assert_eq!(parse_answer(ANSWER_OK), Some(Answer::Ok));
        assert_eq!(parse_answer(ANSWER_BUSY), Some(Answer::Busy));
        assert_eq!(parse_answer(ANSWER_BAD), Some(Answer::Bad));
        assert_eq!(parse_answer(b"OK"), None);
    }
}
