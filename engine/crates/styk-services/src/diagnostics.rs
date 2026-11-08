//! Native diagnostic window operations and asynchronous output, supplied by the host.
use raw_window_handle::HasWindowHandle;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub trait DiagnosticWindows: Send + Sync {
    /// Deliberate 50 ms UI disturbance, only for the explicitly selected Blocked probe.
    fn disturb_blocked_probe(&self);
    fn show(&self, window: &dyn HasWindowHandle) -> Result<(), String>;
    fn capture(&self, window: &dyn HasWindowHandle) -> Result<Image, String>;
    /// Starts output off the interface thread and reports its terminal result once.
    fn save_image(
        &self,
        path: PathBuf,
        image: Image,
        complete: Box<dyn FnOnce(Result<(), String>) + Send>,
    ) -> Result<(), String>;
}

/// Fixed bounds apply to OS calls as well as retained summaries.
pub const MEMORY_REGIONS: usize = 65_536;
pub const MEMORY_GROUPS: usize = 4096;
#[derive(Clone, Debug, Default)]
pub struct MemoryReport {
    pub private_before: u64,
    pub private_after: u64,
    pub regions: usize,
    pub truncated: bool,
    pub groups: Vec<MemoryGroup>,
    pub video: Vec<VideoMemory>,
    pub limitations: Vec<String>,
}
#[derive(Clone, Debug)]
pub struct MemoryGroup {
    pub allocation_base: u64,
    pub kind: &'static str,
    pub module: Option<String>,
    pub committed: u64,
    pub writable: u64,
}
#[derive(Clone, Debug)]
pub struct VideoMemory {
    pub adapter: String,
    pub segment: &'static str,
    pub budget: u64,
    pub usage: u64,
    pub reservation: u64,
}
/// Explicit request only. The implementation runs on a worker and calls completion once.
pub trait MemoryDiagnostics: Send + Sync {
    fn memory(
        &self,
        complete: Box<dyn FnOnce(Result<MemoryReport, String>) + Send>,
    ) -> Result<(), String>;
}
