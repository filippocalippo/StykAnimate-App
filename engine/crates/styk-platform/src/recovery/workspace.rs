//! Secondary-process workspace adoption, using today's workspaces/<pid> layout.
use super::{check, io};
use std::fs;
use std::path::PathBuf;
use std::os::windows::fs::MetadataExt;
use styk_services::{Cancel, files::FileTarget, recovery::{RecoveryError, RecoveryFuture, Workspaces}};
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use styk_services::shell::instance::{RenameFailure, WorkspaceEntry, WorkspaceFs, workspace_directory};
use crate::windows::updates::process_alive;

pub struct LocalWorkspaces { profile: PathBuf, pid: u32 }
impl LocalWorkspaces {
    pub fn new(profile: impl Into<PathBuf>) -> Self { Self { profile: profile.into(), pid: std::process::id() } }
    fn adopt_with(&self, alive: &dyn Fn(u32) -> bool, cancel: &Cancel) -> Result<FileTarget, RecoveryError> {
        check(cancel)?;
        let root = self.profile.join("workspaces"); fs::create_dir_all(&root).map_err(io)?;
        if fs::symlink_metadata(&root).map_err(io)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(RecoveryError::Invalid); }
        let destination = root.join(self.pid.to_string());
        if let Ok(meta) = fs::symlink_metadata(&destination) {
            return if meta.is_dir() && meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 { Ok(FileTarget::new(destination)) } else { Err(RecoveryError::Invalid) };
        }
        workspace_directory(&RealFs, &self.profile, self.pid, alive).map(FileTarget::new).map_err(io)
    }
}
struct RealFs;
impl WorkspaceFs for RealFs {
    fn create_dir_all(&self, path: &std::path::Path) -> std::io::Result<()> { fs::create_dir_all(path) }
    fn exists(&self, path: &std::path::Path) -> bool { path.exists() }
    fn entries(&self, path: &std::path::Path) -> std::io::Result<Vec<WorkspaceEntry>> {
        fs::read_dir(path)?.map(|entry| {
            let entry = entry?; let meta = fs::symlink_metadata(entry.path())?;
            Ok(WorkspaceEntry { name: entry.file_name().to_string_lossy().into_owned(), is_dir: meta.is_dir() && meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 })
        }).collect()
    }
    fn rename(&self, from: &std::path::Path, to: &std::path::Path) -> Result<(), RenameFailure> {
        fs::rename(from, to).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => RenameFailure::Missing,
            std::io::ErrorKind::AlreadyExists => RenameFailure::Exists,
            std::io::ErrorKind::PermissionDenied => RenameFailure::Denied,
            _ => RenameFailure::Other,
        })
    }
}
impl Workspaces for LocalWorkspaces {
    fn adopt<'a>(&'a self, cancel: &'a Cancel) -> RecoveryFuture<'a, FileTarget> { Box::pin(async move { self.adopt_with(&process_alive, cancel) }) }
}

/// The shell calls this before the interface exists; asynchronous core callers use `Workspaces`.
pub(crate) fn at_startup(profile: &std::path::Path) -> Result<PathBuf, RecoveryError> {
    LocalWorkspaces::new(profile).adopt_with(&process_alive, &Cancel::new()).map(|target| target.path().to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dead_workspace_is_renamed_whole_and_live_workspace_is_untouched() {
        let root = std::env::temp_dir().join(format!("styk-recovery-workspace-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let folders = root.join("workspaces"); fs::create_dir(&folders).unwrap();
        for pid in [101, 102] { fs::create_dir(folders.join(pid.to_string())).unwrap(); }
        fs::write(folders.join("101/recovery.styk"), b"legacy").unwrap();
        fs::write(folders.join("102/recovery.styk"), b"live").unwrap();
        let service = LocalWorkspaces { profile: root.clone(), pid: 103 };
        let adopted = service.adopt_with(&|pid| pid == 102, &Cancel::new()).unwrap();
        assert_eq!(adopted.path(), folders.join("103"));
        assert_eq!(fs::read(adopted.path().join("recovery.styk")).unwrap(), b"legacy");
        assert_eq!(fs::read(folders.join("102/recovery.styk")).unwrap(), b"live");
        assert!(!folders.join("101").exists());
        for pid in [102, 103] { fs::remove_file(folders.join(format!("{pid}/recovery.styk"))).unwrap(); fs::remove_dir(folders.join(pid.to_string())).unwrap(); }
        fs::remove_dir(folders).unwrap(); fs::remove_dir(root).unwrap();
    }
}
