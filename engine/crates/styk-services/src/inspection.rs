//! Fixed-size publication slot for owner-produced inspection data. Neither side waits.
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};
pub const SNAPSHOT_BYTES: usize = 4096;
#[derive(Clone)]
pub struct Snapshot {
    bytes: [u8; SNAPSHOT_BYTES],
    len: usize,
    pub revision: u64,
}
impl Snapshot {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}
#[derive(Default)]
pub struct Slot {
    value: Mutex<Option<Snapshot>>,
    refused: AtomicU64,
}
impl Slot {
    pub fn publish(&self, revision: u64, bytes: &[u8]) -> Result<(), &'static str> {
        if bytes.len() > SNAPSHOT_BYTES {
            self.refused.fetch_add(1, Ordering::Relaxed);
            return Err("inspection exceeds 4096 bytes");
        }
        let mut value = match self.value.try_lock() {
            Ok(v) => v,
            Err(_) => {
                self.refused.fetch_add(1, Ordering::Relaxed);
                return Err("inspection busy");
            }
        };
        let mut snapshot = Snapshot {
            bytes: [0; SNAPSHOT_BYTES],
            len: bytes.len(),
            revision,
        };
        snapshot.bytes[..bytes.len()].copy_from_slice(bytes);
        *value = Some(snapshot);
        Ok(())
    }
    pub fn read(&self) -> Result<Option<Snapshot>, &'static str> {
        self.value
            .try_lock()
            .map(|value| value.clone())
            .map_err(|_| "inspection busy")
    }
    pub fn refused(&self) -> u64 {
        self.refused.load(Ordering::Relaxed)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refusal_keeps_the_last_snapshot_and_cold_read_never_waits() {
        let slot = Slot::default();
        assert!(slot.read().unwrap().is_none());
        slot.publish(3, b"ready").unwrap();
        assert!(slot.publish(4, &[0; SNAPSHOT_BYTES + 1]).is_err());
        assert_eq!(slot.read().unwrap().unwrap().revision, 3);
        let guard = slot.value.lock().unwrap();
        assert!(slot.read().is_err());
        assert!(slot.publish(5, b"later").is_err());
        drop(guard);
        assert_eq!(slot.refused(), 2);
    }
}
