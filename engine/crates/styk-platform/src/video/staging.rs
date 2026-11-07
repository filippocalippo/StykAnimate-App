//! Where a video export is written before it replaces the destination.
//!
//! A job owns a unique sibling directory of the destination, `.<name>.<id>.stage`, on the destination's volume, so the
//! last step is a rename and there is no copy path. The encoder's outputs live in it under correctly suffixed,
//! initially nonexistent names (FFmpeg picks its muxer from a suffix; the Video for Windows helper creates its output
//! with `CREATE_NEW`). The destination is never touched until the commit; whatever happens, the stage is removed
//! unless a commit lost a race and the finished file is kept for another try.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use styk_services::video::VideoError;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A job's staging directory. Dropping it removes the directory and everything in it unless [`Stage::keep`] was called.
pub struct Stage {
    dir: PathBuf,
    keep: bool,
}

fn destination_error(path: &Path, error: &std::io::Error) -> VideoError {
    VideoError::Destination { path: path.to_path_buf(), message: error.to_string() }
}

impl Stage {
    /// Checks that `destination` can be written *and replaced* and creates the stage beside it. Called before any
    /// frame is drawn; a failure names the folder or the file and leaves nothing behind.
    pub fn create(destination: &Path) -> Result<Stage, VideoError> {
        let folder = destination.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let name = destination.file_name().ok_or_else(|| VideoError::Destination { path: destination.to_path_buf(), message: "the destination has no file name".into() })?;
        let meta = fs::metadata(folder).map_err(|e| destination_error(folder, &e))?;
        if !meta.is_dir() {
            return Err(VideoError::Destination { path: folder.to_path_buf(), message: "the destination folder is not a folder".into() });
        }
        let id = format!("{:x}{:x}{:x}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()), SEQUENCE.fetch_add(1, Ordering::Relaxed));
        let dir = folder.join(format!(".{}.{id}.stage", name.to_string_lossy()));
        fs::create_dir(&dir).map_err(|e| destination_error(folder, &e))?;
        let stage = Stage { dir, keep: false };
        // A file can be created in the folder: write and flush a probe file in the stage.
        let mut probe = File::create(stage.path("probe")).map_err(|e| destination_error(folder, &e))?;
        probe.write_all(b"styk").and_then(|_| probe.flush()).map_err(|e| destination_error(folder, &e))?;
        drop(probe);
        let _ = fs::remove_file(stage.path("probe"));
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
                replace_probe(destination).map_err(|e| destination_error(destination, &e))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(destination_error(destination, &error)),
        }
        Ok(stage)
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

/// Flushes the finished file and moves it over `destination` (the filesystem's replace: `MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING` on Windows). On failure the artifact is untouched.
pub fn commit(artifact: &Path, destination: &Path) -> std::io::Result<u64> {
    let file = OpenOptions::new().write(true).open(artifact)?;
    file.sync_all()?;
    let bytes = file.metadata()?.len();
    drop(file);
    fs::rename(artifact, destination)?;
    Ok(bytes)
}
