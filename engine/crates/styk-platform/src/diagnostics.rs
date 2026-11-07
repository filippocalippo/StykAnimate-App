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

/// Start a tool-only output job. The event loop receives its result asynchronously.
pub fn spawn(job: impl FnOnce() + Send + 'static) -> Result<(), String> {
    styk_services::Spawner::spawn(&crate::spawn::ThreadSpawner, "diagnostic-output", Box::new(job)).map_err(|error| error.to_string())
}

pub fn create_output_directory(path: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| error.to_string())
}

pub struct NativeDiagnostics;
impl styk_services::diagnostics::DiagnosticWindows for NativeDiagnostics {
    fn disturb_blocked_probe(&self) {
        // The sole intentional interface stall: the Blocked diagnostic tests recovery.
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    fn show(&self, window: &dyn raw_window_handle::HasWindowHandle) -> Result<(), String> {
        crate::window::show_without_activation(window).map_err(|error| error.to_string())
    }
    fn capture(&self, window: &dyn raw_window_handle::HasWindowHandle) -> Result<styk_services::diagnostics::Image, String> {
        crate::window::capture(window).map_err(|error| error.to_string())
    }
    fn save_image(&self, path: std::path::PathBuf, image: styk_services::diagnostics::Image, complete: Box<dyn FnOnce(Result<(), String>) + Send>) -> Result<(), String> {
        spawn(move || complete(crate::screenshot::write(&path, &image)))
    }
}

/// A diagnostic timer; its caller awaits a completion instead of blocking an executor.
pub fn after(duration: std::time::Duration, done: impl FnOnce() + Send + 'static) -> Result<(), String> {
    spawn(move || {
        std::thread::sleep(duration);
        done();
    })
}

/// Write a diagnostic report. Interactive callers must run this through `spawn`.
pub fn write_report(path: &std::path::Path, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|error| format!("{}: {error}", path.display()))
}

/// Cancels a diagnostic timeout on every exit path without joining the worker.
pub struct Deadline(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Drop for Deadline {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }
}

/// Fail an unattended screenshot that never completes; no interface-thread waits.
pub fn deadline(duration: std::time::Duration) -> Result<Deadline, String> {
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let worker = done.clone();
    spawn(move || {
        std::thread::sleep(duration);
        if !worker.load(std::sync::atomic::Ordering::Acquire) {
            eprintln!("--screenshot: no completed output within {} s", duration.as_secs());
            std::process::exit(1);
        }
    })?;
    Ok(Deadline(done))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_timer_completes_off_the_calling_thread() {
        let caller = std::thread::current().id();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        after(std::time::Duration::ZERO, move || sender.send(std::thread::current().id()).unwrap()).unwrap();
        assert_ne!(receiver.recv_timeout(std::time::Duration::from_secs(5)).unwrap(), caller);
    }
}
