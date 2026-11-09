//! Where this copy keeps its files: the same folders as the Electron app, so an update loses nothing.
//!
//! - **User data**: `STYK_USER_DATA_DIR`, else `.desktop-data` in the source tree for a development copy, else the
//!   folder Electron named after the app (`%APPDATA%\StykAnimate` on Windows, `~/.config/StykAnimate` on Linux,
//!   `~/Library/Application Support/StykAnimate` on macOS).
//! - **Instance**: the first window's process uses the user-data folder itself; every further process owns a
//!   workspace folder (`workspaces/<pid>`) for its recovery copies and browser storage, reusing an inactive process's
//!   folder so recovery stays discoverable after a crash or restart (port of desktop/workspace-instance.cjs).

use std::path::{Path, PathBuf};

/// The source tree, for a development copy.
pub fn source_root() -> PathBuf {
    std::env::var_os("STYK_APP_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
}

/// The user-data folder. `config_dir` is the platform's per-user application data folder (Electron's `appData`).
pub fn user_data_dir(packaged: bool, config_dir: Option<PathBuf>) -> PathBuf {
    if let Some(path) = std::env::var_os("STYK_USER_DATA_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(path);
    }
    if !packaged {
        return source_root().join(".desktop-data");
    }
    config_dir.unwrap_or_else(std::env::temp_dir).join("StykAnimate")
}

/// A further process's workspace folder under `profile`.
pub fn workspace_directory(profile: &Path, pid: u32, alive: impl Fn(u32) -> bool) -> std::io::Result<PathBuf> {
    let root = profile.join("workspaces");
    let directory = root.join(pid.to_string());
    std::fs::create_dir_all(&root)?;
    if directory.exists() {
        return Ok(directory);
    }
    for entry in std::fs::read_dir(&root)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(other) = name.parse::<u32>() else { continue };
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) || name != other.to_string() || alive(other) {
            continue;
        }
        match std::fs::rename(entry.path(), &directory) {
            Ok(()) => return Ok(directory),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
                ) || error.raw_os_error() == Some(32) => {}
            Err(error) => return Err(error),
        }
    }
    std::fs::create_dir_all(&directory)?;
    Ok(directory)
}

/// Whether a process with this id is running.
#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: plain Win32 calls on a handle this function opens and closes.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // Access denied still means it exists; only a missing process is free to take over.
            return windows_sys::Win32::Foundation::GetLastError() == 5;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok == 0 || code == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
pub fn process_alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists() || !Path::new("/proc").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_further_process_reuses_an_inactive_workspace() {
        let profile = tempfile::tempdir().unwrap();
        let dead = profile.path().join("workspaces/111");
        std::fs::create_dir_all(&dead).unwrap();
        std::fs::write(dead.join("recovery.styk"), b"x").unwrap();
        let taken = workspace_directory(profile.path(), 222, |pid| pid != 111).unwrap();
        assert_eq!(taken, profile.path().join("workspaces/222"));
        assert!(taken.join("recovery.styk").exists());
        assert!(!dead.exists());
        // A live process's folder is left alone.
        std::fs::create_dir_all(profile.path().join("workspaces/333")).unwrap();
        let fresh = workspace_directory(profile.path(), 444, |pid| pid == 333).unwrap();
        assert!(fresh.exists() && profile.path().join("workspaces/333").exists());
        // The same process gets its own folder back.
        assert_eq!(workspace_directory(profile.path(), 444, |_| true).unwrap(), fresh);
    }

    #[test]
    fn user_data_is_electrons_folder_when_packaged() {
        if std::env::var_os("STYK_USER_DATA_DIR").is_some() {
            return;
        }
        assert_eq!(user_data_dir(true, Some(PathBuf::from("R"))), PathBuf::from("R").join("StykAnimate"));
        assert!(user_data_dir(false, None).ends_with(".desktop-data"));
    }
}
