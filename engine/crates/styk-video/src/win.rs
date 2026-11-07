//! Windows process measurements and test disturbances for `styk video`: private memory of a process, and suspending a
//! process (what a stalled encoder looks like). Test and measurement tools only; the export path never calls these.

#[cfg(windows)]
mod imp {
    #[repr(C)]
    struct ProcessMemoryCountersEx {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
        private_usage: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn CloseHandle(handle: isize) -> i32;
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(process: isize, counters: *mut ProcessMemoryCountersEx, cb: u32) -> i32;
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtSuspendProcess(process: isize) -> i32;
        fn NtResumeProcess(process: isize) -> i32;
    }

    const QUERY: u32 = 0x1000 | 0x0010;
    const SUSPEND_RESUME: u32 = 0x0800;

    /// Private bytes (committed, unshared) of process `pid`, or of this process.
    pub fn private_bytes(pid: Option<u32>) -> usize {
        // SAFETY: plain Win32 calls on a handle opened here (or the pseudo handle of this process) and a zeroed struct.
        unsafe {
            let (handle, owned) = match pid {
                Some(pid) => (OpenProcess(QUERY, 0, pid), true),
                None => (GetCurrentProcess(), false),
            };
            if handle == 0 {
                return 0;
            }
            let mut counters: ProcessMemoryCountersEx = std::mem::zeroed();
            counters.cb = std::mem::size_of::<ProcessMemoryCountersEx>() as u32;
            let ok = K32GetProcessMemoryInfo(handle, &mut counters, counters.cb);
            if owned {
                CloseHandle(handle);
            }
            if ok == 0 { 0 } else { counters.private_usage }
        }
    }

    pub fn suspend(pid: u32) -> bool {
        // SAFETY: a handle opened and closed here.
        unsafe {
            let handle = OpenProcess(SUSPEND_RESUME, 0, pid);
            if handle == 0 {
                return false;
            }
            let ok = NtSuspendProcess(handle) >= 0;
            CloseHandle(handle);
            ok
        }
    }

    pub fn resume(pid: u32) -> bool {
        // SAFETY: a handle opened and closed here.
        unsafe {
            let handle = OpenProcess(SUSPEND_RESUME, 0, pid);
            if handle == 0 {
                return false;
            }
            let ok = NtResumeProcess(handle) >= 0;
            CloseHandle(handle);
            ok
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn private_bytes(_pid: Option<u32>) -> usize {
        0
    }
    pub fn suspend(_pid: u32) -> bool {
        false
    }
    pub fn resume(_pid: u32) -> bool {
        false
    }
}

pub use imp::{private_bytes, resume, suspend};
