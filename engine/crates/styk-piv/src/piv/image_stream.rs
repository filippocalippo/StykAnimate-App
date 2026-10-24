//! Where a JPEG ends inside an already bounded Pivot resource (`image_stream.py`).
//!
//! A Pivot 4 background stores an absolute end offset, and saved files can keep
//! old data after the image's end marker. Only the JPEG grammar can tell the
//! real end: metadata segments may themselves contain marker bytes.

use crate::error::{PyResult, value_error};

/// The end of the first complete JPEG in `data[start..end]`.
pub(crate) fn jpeg_end(data: &[u8], start: usize, end: u64) -> PyResult<usize> {
    let header_ok = (start as u64) < end && end <= data.len() as u64 && data.get(start..start + 2) == Some(&[0xff, 0xd8]);
    if !header_ok {
        return Err(value_error(format!("Invalid JPEG header at byte {start}")));
    }
    let end = end as usize;
    let (mut pos, mut scan, mut has_scan) = (start + 2, false, false);
    while pos < end {
        if scan {
            match data[pos..end].iter().position(|&b| b == 0xff) {
                Some(found) => pos += found,
                None => break,
            }
        } else if data[pos] != 0xff {
            return Err(value_error(format!("Invalid JPEG marker at byte {pos}")));
        }
        while pos < end && data[pos] == 0xff {
            pos += 1;
        }
        if pos >= end {
            break;
        }
        let marker = data[pos];
        pos += 1;
        if scan && (marker == 0 || (0xd0..=0xd7).contains(&marker)) {
            // Byte stuffing and restart markers within entropy data.
            continue;
        }
        if marker == 0xd9 && has_scan {
            return Ok(pos);
        }
        if matches!(marker, 0 | 0xd8 | 0xd9) || (0xd0..=0xd7).contains(&marker) {
            return Err(value_error(format!("Invalid JPEG marker at byte {}", pos - 1)));
        }
        if marker == 1 {
            continue;
        }
        if pos + 2 > end {
            break;
        }
        let length = u16::from_be_bytes([data[pos], data[pos + 1]]) as usize;
        if length < 2 || pos + length > end {
            return Err(value_error(format!("Invalid JPEG segment length at byte {pos}")));
        }
        pos += length;
        // A DNL segment may occur within a scan; other tables precede another scan.
        scan = marker == 0xda || (scan && marker == 0xdc);
        has_scan |= marker == 0xda;
    }
    Err(value_error(format!("Truncated JPEG at byte {start}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Metadata holding a false end marker, two scans, stuffed bytes and a restart marker.
    fn jpeg() -> Vec<u8> {
        let mut data = b"\xff\xd8\xff\xe1\x00\x08meta\xff\xd9".to_vec();
        data.extend_from_slice(b"\xff\xda\x00\x02abc\xff\x00\xd9\xff\xd0def");
        data.extend_from_slice(b"\xff\xc4\x00\x04hi\xff\xda\x00\x02xyz\xff\xd9");
        data
    }

    #[test]
    fn finds_the_real_end_and_keeps_truncation_strict() {
        let data = jpeg();
        let mut padded = data.clone();
        padded.extend_from_slice(b"junk");
        assert_eq!(jpeg_end(&padded, 0, padded.len() as u64).unwrap(), data.len());
        for end in 0..data.len() {
            assert!(jpeg_end(&data, 0, end as u64).is_err(), "end {end}");
        }
        for bad in [&b"\xff\xd8\xff\xd9"[..], b"\xff\xd8junk\xff\xd9", b"\xff\xd8\xff\xe1\x00\x01\xff\xd9", b"\xff\xd8\xff\xe1\xff\xff"] {
            assert!(jpeg_end(bad, 0, bad.len() as u64).is_err());
        }
    }
}
