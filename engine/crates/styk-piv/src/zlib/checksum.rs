//! Adler-32 (zlib stream trailer) and CRC-32 (PNG chunks).

const ADLER_BASE: u32 = 65521;
/// The most bytes that can be summed before the 32-bit sums must be reduced.
const ADLER_RUN: usize = 5552;

/// Continues an Adler-32 checksum (`1` starts one).
pub(crate) fn adler32(seed: u32, data: &[u8]) -> u32 {
    let (mut a, mut b) = (seed & 0xffff, seed >> 16);
    for chunk in data.chunks(ADLER_RUN) {
        for &byte in chunk {
            a += byte as u32;
            b += a;
        }
        a %= ADLER_BASE;
        b %= ADLER_BASE;
    }
    (b << 16) | a
}

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0xedb88320 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

static CRC_TABLE: [u32; 256] = crc_table();

/// CRC-32 of `data`, as `zlib.crc32` returns it.
pub(crate) fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &byte in data {
        c = CRC_TABLE[((c ^ byte as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_checksums() {
        assert_eq!(adler32(1, b""), 1);
        assert_eq!(adler32(1, b"Wikipedia"), 0x11e60398);
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
    }
}
