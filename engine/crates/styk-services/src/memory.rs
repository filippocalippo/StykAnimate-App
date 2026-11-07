//! Host memory facts, independent of a platform or allocator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MachineMemory { pub physical: u64, pub available: u64 }

/// Native admission limit: at most half the physical RAM and three quarters of what was available at launch.
/// The allocator keeps its existing extra sixteenth in reserve. Clamp for a 32-bit host without truncation.
pub fn document_limit(memory: Option<MachineMemory>) -> usize {
    let bytes = memory.map_or(1 << 30, |memory| (memory.physical / 2).min(memory.available.saturating_sub(memory.available / 4)));
    usize::try_from(bytes).unwrap_or(isize::MAX as usize).min(isize::MAX as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn memory_budget_leaves_room_for_the_os_and_uses_checked_sizes() {
        assert_eq!(document_limit(None), 1 << 30);
        assert_eq!(document_limit(Some(MachineMemory { physical: 8 << 30, available: 4 << 30 })), (3usize << 30).min(isize::MAX as usize));
        assert_eq!(document_limit(Some(MachineMemory { physical: 8 << 30, available: 8 << 30 })), usize::try_from(4u64 << 30).unwrap_or(isize::MAX as usize).min(isize::MAX as usize));
        assert_eq!(document_limit(Some(MachineMemory { physical: u64::MAX, available: u64::MAX })), isize::MAX as usize);
    }
}
