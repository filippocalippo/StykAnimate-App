//! Adler-32 (zlib stream trailer) and CRC-32 (PNG chunks).

const ADLER_BASE: u32 = 65521;
/// The most bytes that can be summed before the 32-bit sums must be reduced.
const ADLER_RUN: usize = 5552;

/// Continues an Adler-32 checksum (`1` starts one).
pub(crate) fn adler32(seed: u32, data: &[u8]) -> u32 {
    let (mut a, mut b) = (seed & 0xffff, seed >> 16);
    for chunk in data.chunks(ADLER_RUN) {
        // Sixteen bytes at a time: the sums of a block do not depend on one another, so they are taken together (a compiler
        // vectorizes them), and the result is the byte by byte one: b gains sixteen times a, and the bytes weighted by how many
        // times each is counted.
        let blocks = chunk.chunks_exact(16);
        let rest = blocks.remainder();
        for block in blocks {
            let (mut sum, mut weighted) = (0u32, 0u32);
            for (i, &byte) in block.iter().enumerate() {
                sum += byte as u32;
                weighted += (16 - i as u32) * byte as u32;
            }
            b += 16 * a + weighted;
            a += sum;
        }
        for &byte in rest {
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

    /// The definition, a byte at a time.
    fn adler32_bytes(seed: u32, data: &[u8]) -> u32 {
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

    #[test]
    fn blocks_of_sixteen_give_the_checksum_a_byte_at_a_time_gives() {
        let mut state = 0x1234_5678_u64;
        let mut next = || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (state >> 33) as u8
        };
        let bytes: Vec<u8> = (0..40_000).map(|_| next()).collect();
        let worst = vec![255u8; 20_000];
        for data in [&bytes[..], &worst[..]] {
            for length in [0, 1, 15, 16, 17, 31, 5551, 5552, 5553, 11104, 11105, 16 * 347 * 3 + 7, data.len()] {
                for seed in [1, 0xfff0_fff0, 0x0001_fff0, 0xfff0_0001] {
                    assert_eq!(adler32(seed, &data[..length.min(data.len())]), adler32_bytes(seed, &data[..length.min(data.len())]), "{length} bytes from {seed:#x}");
                }
            }
        }
    }

    #[test]
    fn known_checksums() {
        assert_eq!(adler32(1, b""), 1);
        assert_eq!(adler32(1, b"Wikipedia"), 0x11e60398);
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
    }
}
