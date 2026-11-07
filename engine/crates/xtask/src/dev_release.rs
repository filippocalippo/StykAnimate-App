//! Artifact isolation guard. It inspects supplied artifacts; builds remain in the machine queue.
use std::{fs::File, io::Read, path::Path};
const FORBIDDEN: &[&[u8]] = &[
    b"styk_devtools",
    b"styk_trace::ring",
    b"stykanimate-dev-",
    b".styktrace",
];
fn scan(mut input: impl Read) -> Result<(), String> {
    let mut tail = Vec::new();
    let mut scratch = [0; 64 * 1024];
    loop {
        let n = input.read(&mut scratch).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(());
        }
        tail.extend_from_slice(&scratch[..n]);
        for needle in FORBIDDEN {
            if tail.windows(needle.len()).any(|part| part == *needle) {
                return Err(format!(
                    "release contains developer marker {}",
                    String::from_utf8_lossy(needle)
                ));
            }
        }
        let keep = FORBIDDEN.iter().map(|s| s.len()).max().unwrap_or(1) - 1;
        if tail.len() > keep {
            tail.drain(..tail.len() - keep);
        }
    }
}
pub fn run(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("check-release <stykanimate.exe> [stykanimate.pdb]; build shipping artifacts separately first".into());
    }
    for path in paths {
        let file = File::open(Path::new(path)).map_err(|e| format!("{path}: {e}"))?;
        scan(file)?;
    }
    println!("release markers: clean ({} artifacts)", paths.len());
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leaking_artifacts_fail_including_chunk_boundaries() {
        assert!(scan(b"ordinary release code".as_slice()).is_ok());
        for marker in FORBIDDEN {
            let mut bytes = vec![0; 64 * 1024 - 3];
            bytes.extend_from_slice(marker);
            assert!(scan(bytes.as_slice()).is_err());
        }
    }
    #[test]
    fn missing_artifact_is_not_a_pass() {
        assert!(run(&["no-such-artifact.exe".into()]).is_err());
    }
}
