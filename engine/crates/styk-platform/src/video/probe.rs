//! Capability probes: `ffmpeg -version`, `-encoders`, `-muxers`, and the helper's `--list`.
//!
//! These are the only places in the export path with a clock: a probe is a question put to a program, not an export,
//! and a program that does not answer must not hold the dialog that asks. (Today: 10 s for FFmpeg, 15 s for the helper.)

use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

use super::process;

/// Runs `program args`, returning its standard output when it exits successfully within `limit`.
pub fn run(program: &Path, args: &[&str], limit: Duration, max_bytes: usize) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args);
    let (child, mut pipes) = process::spawn(&mut command, false).map_err(|e| e.to_string())?;
    let (tx, rx) = mpsc::channel();
    let mut stdout = pipes.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = stdout.read(&mut chunk) {
            if n == 0 || bytes.len() > max_bytes {
                break;
            }
            bytes.extend_from_slice(&chunk[..n]);
        }
        let _ = tx.send(bytes);
    });
    // Standard error is drained so a chatty program cannot block on a full pipe.
    let mut stderr = pipes.stderr.take().expect("piped stderr");
    let drain = std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = stderr.read_to_end(&mut sink);
    });
    let result = match rx.recv_timeout(limit) {
        Ok(bytes) if bytes.len() <= max_bytes => {
            let status = child.wait();
            if status.success() { Ok(String::from_utf8_lossy(&bytes).into_owned()) } else { Err(format!("{} exited with {status}", program.display())) }
        }
        Ok(_) => Err("the answer is larger than expected".to_string()),
        Err(_) => Err(format!("{} did not answer", program.display())),
    };
    child.terminate();
    let _ = reader.join();
    let _ = drain.join();
    result
}
