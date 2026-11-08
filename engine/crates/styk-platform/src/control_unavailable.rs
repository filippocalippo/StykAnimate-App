//! Portable seam; only Windows is implemented in this phase.
use std::sync::Arc;
use styk_services::{
    Spawner,
    control::{Inbox, Operation, Running, Transport},
};
pub struct LocalControl;
impl Transport for LocalControl {
    fn serve(&self, _: &dyn Spawner, _: &str, _: Arc<Inbox>) -> Result<Box<dyn Running>, String> {
        Err("local control transport is unavailable on this platform".into())
    }
    fn request(&self, _: &dyn Spawner, _: &str, _: Vec<u8>) -> Result<Operation, String> {
        Err("local control transport is unavailable on this platform".into())
    }
}

impl LocalControl {
    pub fn accounting() -> (usize, u64) {
        (0, 0)
    }
}
impl LocalControl {
    pub fn free_disk_bytes() -> Result<u64, String> {
        Err("disk query unavailable on this platform".into())
    }
}
