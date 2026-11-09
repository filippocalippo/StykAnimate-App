//! Check linked symbols and developer catalogue markers in optimized binaries.
//! MSVC linker maps keep symbols without enabling release debug information.
use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

fn lines(
    mut input: impl BufRead,
    mut visit: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    loop {
        let mut line = Vec::new();
        let n = input
            .by_ref()
            .take(16 * 1024 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(());
        }
        if line.len() > 16 * 1024 {
            return Err("symbol line exceeds 16 KiB".into());
        }
        visit(
            std::str::from_utf8(&line)
                .map_err(|e| e.to_string())?
                .trim(),
        )?;
    }
}
struct Pe {
    timestamp: u32,
    base: u64,
    size: u64,
}
fn pe(mut file: File) -> Result<Pe, String> {
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos).map_err(|e| e.to_string())?;
    if &dos[..2] != b"MZ" {
        return Err("not a PE executable".into());
    }
    let offset = u32::from_le_bytes(dos[60..64].try_into().map_err(|_| "PE offset")?);
    file.seek(SeekFrom::Start(offset as u64))
        .map_err(|e| e.to_string())?;
    let mut header = [0u8; 88];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    if &header[..4] != b"PE\0\0" {
        return Err("invalid PE signature".into());
    }
    let u32_at =
        |at| u32::from_le_bytes([header[at], header[at + 1], header[at + 2], header[at + 3]]);
    let base = match u16::from_le_bytes([header[24], header[25]]) {
        0x20b => u64::from_le_bytes(header[48..56].try_into().map_err(|_| "PE image base")?),
        0x10b => u32_at(52) as u64,
        _ => return Err("unsupported PE optional header".into()),
    };
    Ok(Pe {
        timestamp: u32_at(8),
        base,
        size: u32_at(80) as u64,
    })
}
fn symbols(input: impl BufRead, image: &Pe, name: &str) -> Result<usize, String> {
    let (mut named, mut timestamp, mut base, mut table, mut count) =
        (false, false, false, false, 0usize);
    lines(input, |line| {
        if !named && !line.is_empty() {
            if line != name {
                return Err("linker map names a different executable".into());
            }
            named = true;
        }
        if let Some(value) = line
            .strip_prefix("Timestamp is ")
            .and_then(|s| s.split_whitespace().next())
        {
            if u32::from_str_radix(value, 16).ok() != Some(image.timestamp) {
                return Err("linker map timestamp does not match executable".into());
            }
            timestamp = true;
        }
        if let Some(value) = line.strip_prefix("Preferred load address is ") {
            if u64::from_str_radix(value.trim(), 16).ok() != Some(image.base) {
                return Err("linker map image base does not match executable".into());
            }
            base = true;
        }
        if line.contains("Publics by Value") {
            table = true;
        }
        let mut fields = line.split_whitespace();
        if let (Some(section), Some(symbol), Some(address)) =
            (fields.next(), fields.next(), fields.next())
        {
            if table
                && section.contains(':')
                && u64::from_str_radix(address, 16)
                    .ok()
                    .is_some_and(|a| a >= image.base && a - image.base < image.size)
            {
                count += 1;
                // Both Rust v0 and legacy mangling retain the crate identifier.
                if symbol.contains("styk_screens")
                    || symbol.contains("styk_trace")
                    || symbol.contains("styk_devtools")
                    || symbol.contains("dev_extension")
                {
                    return Err(format!("release contains linked developer symbol {symbol}"));
                }
            }
        }
        Ok(())
    })?;
    if !(named && timestamp && base && table && count > 0) {
        return Err("incomplete linker map; symbol isolation was not proved".into());
    }
    Ok(count)
}
pub fn run(paths: &[String]) -> Result<(), String> {
    if paths.len() != 2 {
        return Err("check-release <shipping.exe> <matching.map>; link with -C link-arg=/MAP:<absolute.map>, keeping release debug=0".into());
    }
    let exe = Path::new(&paths[0]);
    let image = pe(File::open(exe).map_err(|e| e.to_string())?)?;
    let name = exe
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("invalid executable name")?;
    let count = symbols(
        BufReader::new(File::open(&paths[1]).map_err(|e| e.to_string())?),
        &image,
        name,
    )?;
    catalogue(File::open(exe).map_err(|e| e.to_string())?)?;
    println!("release symbols: clean ({count} linked symbols; PE/map identity matched)");
    Ok(())
}
/// Catalogue data can be inlined into core code with no surviving developer symbol.
fn catalogue(mut input: impl Read) -> Result<(), String> {
    const KEYS: &[&[u8]] = &[
        b"dev.profiler",
        b"dev.parameters",
        b"dev.overlay",
        b"dev.saveProfile",
        b"dev.loadProfile",
        b"dev.logs",
        b"dev.mark",
        b"dev.start",
        b"dev.stop",
        b"dev.export",
        b"dev.set",
        b"dev.reset",
        b"dev.close",
        b"dev.filter",
        b"dev.error",
        b"dev.unavailable",
        b"capture.cap_mb",
    ];
    let mut bytes = [0u8; 8192 + 32];
    let mut tail = 0;
    loop {
        let n = input
            .read(&mut bytes[tail..8192])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(());
        }
        let used = tail + n;
        if KEYS
            .iter()
            .any(|key| bytes[..used].windows(key.len()).any(|w| w == *key))
        {
            return Err("release contains developer route/catalogue data".into());
        }
        tail = used.min(32);
        bytes.copy_within(used - tail..used, 0);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn map(symbol: &str) -> String {
        format!(
            "app\nTimestamp is ab\nPreferred load address is 1000\nAddress Publics by Value\n0001:00000000 {symbol} 00001010 f object.o\n"
        )
    }
    #[test]
    fn symbols_require_identity_and_reject_both_rust_manglings() {
        let pe = Pe {
            timestamp: 0xab,
            base: 0x1000,
            size: 0x100,
        };
        assert_eq!(symbols(map("main").as_bytes(), &pe, "app"), Ok(1));
        for name in [
            "_RNvNtCshash_10styk_trace4ring10ring_bytes",
            "_ZN10styk_trace4ring8registry17hashE",
            "_RNvCshash_12styk_screens10initialize",
            "_RNvCshash_13styk_devtools10initialize",
        ] {
            assert!(
                symbols(map(name).as_bytes(), &pe, "app")
                    .unwrap_err()
                    .contains("linked developer symbol")
            );
        }
        assert!(symbols(map("main").as_bytes(), &pe, "other").is_err());
        assert!(symbols(map("main").replace("ab", "ac").as_bytes(), &pe, "app").is_err());
        assert!(symbols(b"app\n".as_slice(), &pe, "app").is_err());
        assert!(symbols(vec![b'x'; 16385].as_slice(), &pe, "app").is_err());
    }
    #[test]
    fn missing_evidence_is_not_a_pass() {
        assert!(run(&["missing.exe".into()]).is_err());
    }
    #[test]
    fn inlined_catalogue_and_route_leaks_are_rejected() {
        assert!(catalogue(b"ordinary product catalogue".as_slice()).is_ok());
        for key in ["dev.profiler", "dev.parameters", "dev.overlay", "capture.cap_mb"] {
            let mut bytes = vec![0; 8189];
            bytes.extend_from_slice(key.as_bytes());
            assert!(catalogue(bytes.as_slice()).is_err());
        }
        let pe = Pe {
            timestamp: 0xab,
            base: 0x1000,
            size: 0x100,
        };
        assert!(
            symbols(
                map("_ZN9styk_core13dev_extension5routeE").as_bytes(),
                &pe,
                "app"
            )
            .is_err()
        );
    }
}
