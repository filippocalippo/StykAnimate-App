//! Where a video export is written before it replaces the destination.
//!
//! A job owns a unique sibling directory of the destination, `.styk-<process>-<unique>.stage`, on the destination's
//! volume, so the last step is a rename and there is no copy path. Its name is short and does not depend on the
//! destination's: a destination name that fits the file system fits here. The encoder's outputs live in it under
//! correctly suffixed, initially nonexistent names (FFmpeg picks its muxer from a suffix; the Video for Windows helper
//! creates its output with `CREATE_NEW`). The destination is never touched until the commit; whatever happens, the stage
//! is removed unless a commit lost a race and the finished file is kept for another try.
//!
//! A stage left behind by a process that was killed is swept by the next export to that folder, under today's rule for
//! an abandoned job (`desktop/video-export-service.cjs`): untouched for two minutes ([`TTL`]), and in addition its
//! process must be gone.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use styk_services::video::VideoError;
use styk_services::Cancel;

use super::process::process_exists;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// How long an abandoned job's files may sit untouched before they are garbage (today's idle timer of the export service).
pub const TTL: Duration = Duration::from_secs(120);

const PREFIX: &str = ".styk-";
const SUFFIX: &str = ".stage";

/// A job's staging directory. Dropping it removes the directory and everything in it unless [`Stage::keep`] was called.
pub struct Stage {
    dir: PathBuf,
    keep: bool,
}

fn error_at(path: &Path, error: &std::io::Error) -> VideoError {
    VideoError::Destination { path: path.to_path_buf(), message: error.to_string() }
}

/// The longest file name the file system takes: 255 UTF-16 units on Windows, 255 bytes elsewhere.
fn name_length(name: &std::ffi::OsStr) -> usize {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        name.encode_wide().count()
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::ffi::OsStrExt;
        name.as_bytes().len()
    }
}

impl Stage {
    /// Checks that `destination` can be written *and replaced* and creates the stage beside it. Called before any
    /// frame is drawn; a failure names the folder or the file and leaves nothing behind.
    pub fn create(destination: &Path) -> Result<Stage, VideoError> {
        let folder = destination.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let name = destination.file_name().ok_or_else(|| VideoError::Destination { path: destination.to_path_buf(), message: "the destination has no file name".into() })?;
        if name_length(name) > 255 {
            return Err(VideoError::Destination { path: destination.to_path_buf(), message: "the file name is too long (at most 255 characters)".into() });
        }
        let meta = fs::metadata(folder).map_err(|e| error_at(folder, &e))?;
        if !meta.is_dir() {
            return Err(VideoError::Destination { path: folder.to_path_buf(), message: "the destination folder is not a folder".into() });
        }
        sweep_stale(folder);
        let id = format!("{:x}-{:x}{:x}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()), SEQUENCE.fetch_add(1, Ordering::Relaxed));
        let dir = folder.join(format!("{PREFIX}{id}{SUFFIX}"));
        fs::create_dir(&dir).map_err(|e| error_at(folder, &e))?;
        let stage = Stage { dir, keep: false };
        // The operation the commit will do, on disposable names: a file made in the stage is renamed into the folder.
        // First under a short name (a failure is the folder's), then under a name as long as the destination's (a failure
        // is the file's: the name, or the whole path, is not accepted here).
        stage.probe(folder, &format!("{PREFIX}probe-{id}")).map_err(|e| error_at(folder, &e))?;
        let wanted = name_length(name);
        let mut long = format!("{PREFIX}probe-{id}");
        while long.len() < wanted {
            long.push('_');
        }
        stage.probe(folder, &long).map_err(|e| VideoError::Destination { path: destination.to_path_buf(), message: format!("this file name is not accepted in this folder: {e}") })?;
        // An existing destination can be replaced: opening it with the DELETE right and full sharing is what the
        // rename needs, and it changes nothing.
        match fs::metadata(destination) {
            Ok(existing) => {
                if existing.is_dir() {
                    return Err(VideoError::Destination { path: destination.to_path_buf(), message: "a folder with this name exists".into() });
                }
                if existing.permissions().readonly() {
                    return Err(VideoError::Destination { path: destination.to_path_buf(), message: "the file is read-only".into() });
                }
                replace_probe(destination).map_err(|e| error_at(destination, &e))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error_at(destination, &error)),
        }
        Ok(stage)
    }

    /// Makes a file in the stage, moves it into `folder` as `name` and removes it there.
    fn probe(&self, folder: &Path, name: &str) -> std::io::Result<()> {
        let inside = self.path("probe");
        let mut file = File::create(&inside)?;
        file.write_all(b"styk").and_then(|_| file.flush())?;
        drop(file);
        let outside = folder.join(name);
        let moved = fs::rename(&inside, &outside);
        let _ = fs::remove_file(&inside);
        let _ = fs::remove_file(&outside);
        moved
    }

    /// A path inside the stage.
    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Leaves the stage in place when it is dropped (a finished file kept for another commit).
    pub fn keep(&mut self) {
        self.keep = true;
    }
}

impl Drop for Stage {
    fn drop(&mut self) {
        if !self.keep {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
}

/// Whether `name` is a file one of our jobs makes in its stage.
fn ours(name: &str) -> bool {
    name == "probe" || name == "mix.f32" || name == "animation.avi" || name.starts_with("video.") || name.starts_with("mixed.")
}

/// The process that made a stage folder, from its name `.styk-<process in hex>-<unique>.stage`.
fn owner_of(folder_name: &str) -> Option<u32> {
    let rest = folder_name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    u32::from_str_radix(rest.split('-').next()?, 16).ok()
}

/// Removes the stage folders in `folder` that a killed export left: made by a process that no longer exists and
/// untouched for [`TTL`], holding only files an export makes. Returns how many it removed. Anything else is left alone.
pub fn sweep_stale(folder: &Path) -> usize {
    let Ok(entries) = fs::read_dir(folder) else { return 0 };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(owner) = owner_of(&name) else { continue };
        let path = entry.path();
        if owner == std::process::id() || process_exists(owner) || !path.is_dir() {
            continue;
        }
        let Ok(inside) = fs::read_dir(&path) else { continue };
        let files: Vec<_> = inside.filter_map(Result::ok).collect();
        if !files.iter().all(|f| ours(&f.file_name().to_string_lossy())) {
            continue;
        }
        let newest = files.iter().filter_map(|f| f.metadata().ok()?.modified().ok()).chain(path.metadata().ok().and_then(|m| m.modified().ok())).max();
        if newest.is_some_and(|t| now.duration_since(t).unwrap_or_default() >= TTL) && fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(windows)]
fn replace_probe(destination: &Path) -> std::io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    const DELETE: u32 = 0x0001_0000;
    const SHARE_ALL: u32 = 7;
    OpenOptions::new().access_mode(DELETE).share_mode(SHARE_ALL).open(destination).map(|_| ())
}

#[cfg(not(windows))]
fn replace_probe(destination: &Path) -> std::io::Result<()> {
    OpenOptions::new().read(true).open(destination).map(|_| ())
}

/// Why a gated commit did not replace the destination.
#[derive(Debug)]
pub enum CommitError {
    /// The job was cancelled before the commit boundary: nothing was replaced.
    Cancelled,
    Io(std::io::Error),
}

/// Flushes the finished file and moves it over `destination` (the filesystem's replace: `MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING` on Windows), unless `cancel` fired first. The flush can be slow, so it happens before the
/// commit boundary (`Cancel::begin_commit`): an edit or a close during it still cancels, and once the boundary is
/// crossed a cancel is too late and changes nothing. `after_flush` runs between the two (tests hold the flush there).
pub fn commit_gated(artifact: &Path, destination: &Path, cancel: &Cancel, after_flush: &dyn Fn()) -> Result<u64, CommitError> {
    let file = OpenOptions::new().write(true).open(artifact).map_err(CommitError::Io)?;
    file.sync_all().map_err(CommitError::Io)?;
    let bytes = file.metadata().map_err(CommitError::Io)?.len();
    drop(file);
    after_flush();
    if !cancel.begin_commit() {
        return Err(CommitError::Cancelled);
    }
    fs::rename(artifact, destination).map_err(CommitError::Io)?;
    Ok(bytes)
}

/// [`commit_gated`] for a finished file kept after a lost race: no job, so nothing to cancel.
pub fn commit(artifact: &Path, destination: &Path) -> std::io::Result<u64> {
    match commit_gated(artifact, destination, &Cancel::new(), &|| {}) {
        Ok(bytes) => Ok(bytes),
        Err(CommitError::Io(error)) => Err(error),
        Err(CommitError::Cancelled) => unreachable!("a new Cancel is never cancelled"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("styk-staging-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_cancel_during_the_flush_stops_the_commit_and_leaves_the_destination() {
        let dir = scratch("gate");
        let (artifact, destination) = (dir.join("video.mp4"), dir.join("out.mp4"));
        fs::write(&artifact, b"new").unwrap();
        fs::write(&destination, b"old").unwrap();
        let cancel = Cancel::new();
        // An edit arrives while the flush is held.
        let result = commit_gated(&artifact, &destination, &cancel, &|| {
            cancel.cancel();
        });
        assert!(matches!(result, Err(CommitError::Cancelled)));
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        assert!(artifact.exists());
        // Without a cancel it replaces, and a cancel after the boundary is too late.
        let cancel = Cancel::new();
        commit_gated(&artifact, &destination, &cancel, &|| {}).unwrap();
        assert!(!cancel.cancel());
        assert_eq!(fs::read(&destination).unwrap(), b"new");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_stage_name_does_not_depend_on_the_destination_name() {
        let dir = scratch("short");
        // 230 characters: the old stage name (".<name>.<id>.stage") passed 255 and failed; this one fits.
        let destination = dir.join(format!("{}.mp4", "n".repeat(226)));
        let stage = Stage::create(&destination).unwrap();
        assert!(stage.dir().file_name().unwrap().len() < 60);
        drop(stage);
        // Longer than the file system takes: refused naming the file, not the folder.
        let too_long = dir.join(format!("{}.mp4", "n".repeat(260)));
        match Stage::create(&too_long) {
            Err(VideoError::Destination { path, .. }) => assert_eq!(path, too_long),
            other => panic!("{:?}", other.err()),
        }
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_owner_of_a_stage_is_read_from_its_name() {
        assert_eq!(owner_of(".styk-1f4-abc123.stage"), Some(0x1f4));
        assert_eq!(owner_of(".styk-zz-1.stage"), None);
        assert_eq!(owner_of("movie.stage"), None);
    }

    /// Sets the modification time of a file or a folder (a folder needs backup semantics to be opened on Windows).
    fn set_modified(path: &Path, time: SystemTime) {
        let mut options = OpenOptions::new();
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_WRITE_ATTRIBUTES, full sharing, FILE_FLAG_BACKUP_SEMANTICS.
            options.access_mode(0x100).share_mode(7).custom_flags(0x0200_0000);
        }
        #[cfg(not(windows))]
        options.write(true);
        options.open(path).unwrap().set_modified(time).unwrap();
    }

    fn age(path: &Path, seconds: u64) {
        let old = SystemTime::now() - Duration::from_secs(seconds);
        for file in fs::read_dir(path).unwrap().filter_map(Result::ok) {
            set_modified(&file.path(), old);
        }
        set_modified(path, old);
    }

    #[test]
    fn a_stage_of_a_dead_process_is_swept_after_the_ttl_and_nothing_else_is() {
        let dir = scratch("sweep");
        // A process id that is not running (the largest 32-bit value is not a process id on any system we run on).
        let dead = format!("{PREFIX}{:x}-1{SUFFIX}", u32::MAX - 1);
        let stale = dir.join(&dead);
        fs::create_dir(&stale).unwrap();
        fs::write(stale.join("video.mp4"), b"partial").unwrap();
        age(&stale, 3600);
        // Too fresh: untouched for less than the TTL.
        let fresh = dir.join(format!("{PREFIX}{:x}-2{SUFFIX}", u32::MAX - 1));
        fs::create_dir(&fresh).unwrap();
        fs::write(fresh.join("video.mp4"), b"partial").unwrap();
        // Ours by name, but holding a file an export never makes.
        let foreign = dir.join(format!("{PREFIX}{:x}-3{SUFFIX}", u32::MAX - 1));
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("holiday.mp4"), b"precious").unwrap();
        age(&foreign, 3600);
        // A live process (this one).
        let alive = dir.join(format!("{PREFIX}{:x}-4{SUFFIX}", std::process::id()));
        fs::create_dir(&alive).unwrap();
        fs::write(alive.join("video.mp4"), b"partial").unwrap();
        age(&alive, 3600);
        // A user's folder that merely looks similar.
        let user = dir.join("holidays.stage");
        fs::create_dir(&user).unwrap();
        age(&user, 3600);

        assert_eq!(sweep_stale(&dir), 1);
        assert!(!stale.exists() && fresh.exists() && foreign.exists() && alive.exists() && user.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
