//! Native diagnostic window operations and asynchronous output, supplied by the host.
use std::path::PathBuf;
use raw_window_handle::HasWindowHandle;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub trait DiagnosticWindows: Send + Sync {
    fn show(&self, window: &dyn HasWindowHandle) -> Result<(), String>;
    fn capture(&self, window: &dyn HasWindowHandle) -> Result<Image, String>;
    /// Starts output off the interface thread and reports its terminal result once.
    fn save_image(&self, path: PathBuf, image: Image, complete: Box<dyn FnOnce(Result<(), String>) + Send>) -> Result<(), String>;
}
