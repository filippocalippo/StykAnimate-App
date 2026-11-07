//! Release tooling for the updater, run by `cargo xtask package` (and by the owner at release time).
//!
//! ```text
//! release_feed keygen <seed-file>                      writes a new signing seed, prints the public key as Rust bytes
//! release_feed files-script --source <dir> --out <file>   writes the NSIS statements that install a folder and its manifest
//! release_feed publish --installer <exe> --version <v> --out <dir> [--key-seed <seed-file>]
//!                                                      writes latest.yml, latest.yml.sig (with a seed) and SHA256SUMS.txt
//! ```
//!
//! The seed is the private signing key: keep it out of the repository. Nothing here uploads or publishes anything.

use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{Ed25519KeyPair, KeyPair};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use styk_platform::windows::updates::sha512_base64;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if text.len() % 2 != 0 || !text.is_ascii() {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok()).collect()
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            walk(root, &path, out)?;
        } else if let Ok(relative) = path.strip_prefix(root) {
            out.push(relative.to_string_lossy().replace('/', "\\"));
        }
    }
    Ok(())
}

fn keypair(seed_file: &Path) -> Result<Ed25519KeyPair, String> {
    let seed = unhex(&std::fs::read_to_string(seed_file).map_err(|e| format!("{}: {e}", seed_file.display()))?).ok_or("the seed file is not hexadecimal")?;
    Ed25519KeyPair::from_seed_unchecked(&seed).map_err(|_| "the seed must be 32 bytes".to_string())
}

fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("keygen") => {
            let path = PathBuf::from(args.get(1).ok_or("keygen needs a seed file")?);
            if path.exists() {
                return Err(format!("{} exists: refusing to overwrite a signing key", path.display()));
            }
            let mut seed = [0u8; 32];
            SystemRandom::new().fill(&mut seed).map_err(|_| "no randomness")?;
            std::fs::write(&path, hex(&seed)).map_err(|e| e.to_string())?;
            let pair = Ed25519KeyPair::from_seed_unchecked(&seed).map_err(|_| "bad seed")?;
            println!("public key for UPDATE_PUBLIC_KEY: {:?}", pair.public_key().as_ref());
            Ok(())
        }
        Some("files-script") => {
            // The Setup's file list: the NSIS statements that install every file under --source and write the manifest.
            let (mut source, mut out) = (None, None);
            let mut rest = args[1..].iter();
            while let Some(arg) = rest.next() {
                let value = rest.next().ok_or_else(|| format!("{arg} needs a value"))?;
                match arg.as_str() {
                    "--source" => source = Some(PathBuf::from(value)),
                    "--out" => out = Some(PathBuf::from(value)),
                    other => return Err(format!("unknown option {other}")),
                }
            }
            let (source, out) = (source.ok_or("--source")?, out.ok_or("--out")?);
            let mut files = Vec::new();
            walk(&source, &source, &mut files).map_err(|e| e.to_string())?;
            std::fs::write(out, styk_services::installer::files_script(&source.to_string_lossy(), &files)).map_err(|e| e.to_string())
        }
        Some("publish") => {
            let (mut installer, mut version, mut out, mut seed) = (None, None, None, None);
            let mut rest = args[1..].iter();
            while let Some(arg) = rest.next() {
                let value = rest.next().ok_or_else(|| format!("{arg} needs a value"))?;
                match arg.as_str() {
                    "--installer" => installer = Some(PathBuf::from(value)),
                    "--version" => version = Some(value.clone()),
                    "--out" => out = Some(PathBuf::from(value)),
                    "--key-seed" => seed = Some(PathBuf::from(value)),
                    other => return Err(format!("unknown option {other}")),
                }
            }
            let (installer, version, out) = (installer.ok_or("--installer")?, version.ok_or("--version")?, out.ok_or("--out")?);
            let name = installer.file_name().and_then(|n| n.to_str()).ok_or("the installer has no name")?.to_string();
            let size = std::fs::metadata(&installer).map_err(|e| e.to_string())?.len();
            let sha512 = sha512_base64(&installer, &|| false).map_err(|e| e.to_string())?.ok_or("cancelled")?;
            let yml = format!("version: {version}\nfiles:\n  - url: {name}\n    sha512: {sha512}\n    size: {size}\npath: {name}\nsha512: {sha512}\n");
            std::fs::write(out.join("latest.yml"), &yml).map_err(|e| e.to_string())?;
            if let Some(seed) = seed {
                let signature = keypair(&seed)?.sign(yml.as_bytes());
                std::fs::write(out.join("latest.yml.sig"), signature.as_ref()).map_err(|e| e.to_string())?;
            }
            let mut sums = String::new();
            for file in [name.as_str(), "latest.yml"] {
                let bytes = std::fs::read(out.join(file)).map_err(|e| e.to_string())?;
                sums.push_str(&format!("{}  {file}\n", hex(&Sha256::digest(&bytes))));
            }
            std::fs::write(out.join("SHA256SUMS.txt"), sums).map_err(|e| e.to_string())
        }
        _ => Err("usage: release_feed keygen <seed-file> | publish --installer <exe> --version <v> --out <dir> [--key-seed <file>]".into()),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(message) = run(&args) {
        eprintln!("{message}");
        std::process::exit(1);
    }
}
