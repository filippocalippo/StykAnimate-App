//! Machine memory at startup. The caller supplies these facts to the portable admission policy.
pub fn machine_memory() -> Option<styk_services::memory::MachineMemory> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        // SAFETY: the OS receives a correctly sized writable MEMORYSTATUSEX.
        if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 { return None; }
        Some(styk_services::memory::MachineMemory { physical: status.ullTotalPhys, available: status.ullAvailPhys })
    }
    #[cfg(not(windows))]
    None
}

pub fn document_memory_limit() -> usize { styk_services::memory::document_limit(machine_memory()) }
