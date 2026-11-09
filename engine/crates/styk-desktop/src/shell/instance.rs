//! One first window per profile, as Electron's single-instance lock gave: the first process owns the profile folder;
//! each later ordinary launch still opens its own window and project (with its own workspace folder, see
//! shell::profile), and only `stykanimate://` links go to the first window, without opening another editor.
//!
//! The lock and the channel are one local endpoint named after the profile: a named pipe on Windows (created with
//! `first_pipe_instance`, so a second creator fails), a Unix socket elsewhere. A link arrives as one short UTF-8
//! message and is checked like any other (shell::links).

use std::path::Path;

use tauri::AppHandle;

/// The longest link the first window reads from a later launch.
const MAX_LINK: usize = 4096;

fn endpoint_name(profile: &Path) -> String {
    // FNV-1a of the profile path: two profiles (development copies, tests) never share a first window.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in profile.to_string_lossy().to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("StykAnimate-{hash:016x}")
}

/// Whether this process is the first window's, and the endpoint it then serves.
pub struct Claim {
    pub primary: bool,
    #[cfg(windows)]
    server: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
    #[cfg(unix)]
    server: Option<tokio::net::UnixListener>,
}

#[cfg(windows)]
fn pipe_path(profile: &Path) -> String {
    format!(r"\\.\pipe\{}", endpoint_name(profile))
}

#[cfg(windows)]
pub fn claim(profile: &Path) -> Claim {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = pipe_path(profile);
    let server = tauri::async_runtime::block_on(async move { ServerOptions::new().first_pipe_instance(true).create(&name) });
    match server {
        Ok(server) => Claim { primary: true, server: Some(server) },
        Err(_) => Claim { primary: false, server: None },
    }
}

#[cfg(unix)]
fn socket_path(profile: &Path) -> std::path::PathBuf {
    profile.join(".instance.sock")
}

#[cfg(unix)]
pub fn claim(profile: &Path) -> Claim {
    let path = socket_path(profile);
    if std::os::unix::net::UnixStream::connect(&path).is_ok() {
        return Claim { primary: false, server: None };
    }
    let _ = std::fs::remove_file(&path);
    let server = tauri::async_runtime::block_on(async move { tokio::net::UnixListener::bind(&path) });
    match server {
        Ok(server) => Claim { primary: true, server: Some(server) },
        Err(_) => Claim { primary: false, server: None },
    }
}

#[cfg(not(any(windows, unix)))]
pub fn claim(_profile: &Path) -> Claim {
    Claim { primary: true }
}

fn deliver(app: &AppHandle, bytes: &[u8]) {
    let Ok(text) = std::str::from_utf8(bytes) else { return };
    let link = text.trim().to_owned();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        super::links::handle(&handle, &link);
    });
}

/// Serves later launches' links for as long as the app runs.
#[cfg(windows)]
pub fn serve(app: &AppHandle, claim: Claim) {
    use tokio::io::AsyncReadExt;
    use tokio::net::windows::named_pipe::ServerOptions;
    let Some(mut server) = claim.server else { return };
    let app = app.clone();
    let name = {
        let shell = tauri::Manager::state::<super::Shell>(&app);
        pipe_path(&shell.user_data)
    };
    tauri::async_runtime::spawn(async move {
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                continue;
            }
            let mut connected = server;
            server = match ServerOptions::new().create(&name) {
                Ok(next) => next,
                Err(error) => {
                    eprintln!("Links from later launches can no longer be received: {error}");
                    return;
                }
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut bytes = Vec::new();
                let mut limited = (&mut connected).take(MAX_LINK as u64);
                let read = limited.read_to_end(&mut bytes);
                if tokio::time::timeout(std::time::Duration::from_secs(5), read).await.is_ok() {
                    deliver(&app, &bytes);
                }
            });
        }
    });
}

#[cfg(unix)]
pub fn serve(app: &AppHandle, claim: Claim) {
    use tokio::io::AsyncReadExt;
    let Some(listener) = claim.server else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut bytes = Vec::new();
                let mut limited = stream.take(MAX_LINK as u64);
                let read = limited.read_to_end(&mut bytes);
                if tokio::time::timeout(std::time::Duration::from_secs(5), read).await.is_ok() {
                    deliver(&app, &bytes);
                }
            });
        }
    });
}

#[cfg(not(any(windows, unix)))]
pub fn serve(_app: &AppHandle, _claim: Claim) {}

/// Hands a link to the first window (a later launch that was started only for it).
#[cfg(windows)]
pub fn forward(profile: &Path, link: &str) {
    use tokio::io::AsyncWriteExt;
    use tokio::net::windows::named_pipe::ClientOptions;
    let name = pipe_path(profile);
    let link = link.to_owned();
    tauri::async_runtime::block_on(async move {
        for _ in 0..50 {
            match ClientOptions::new().open(&name) {
                Ok(mut client) => {
                    let _ = client.write_all(link.as_bytes()).await;
                    let _ = client.shutdown().await;
                    return;
                }
                // All instances busy: the first window is between two connections.
                Err(error) if error.raw_os_error() == Some(231) => {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await
                }
                Err(_) => return,
            }
        }
    });
}

#[cfg(unix)]
pub fn forward(profile: &Path, link: &str) {
    use std::io::Write;
    if let Ok(mut stream) = std::os::unix::net::UnixStream::connect(socket_path(profile)) {
        let _ = stream.write_all(link.as_bytes());
    }
}

#[cfg(not(any(windows, unix)))]
pub fn forward(_profile: &Path, _link: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_claim_wins_per_profile() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let first = claim(a.path());
        assert!(first.primary);
        assert!(!claim(a.path()).primary);
        assert!(claim(b.path()).primary);
        assert_ne!(endpoint_name(a.path()), endpoint_name(b.path()));
    }
}
