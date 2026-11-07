//! A child process that can be ended from any thread, however it is blocked.
//!
//! The thread that waits for the exit owns the `Child`; everyone else holds a [`ChildGuard`], which ends the process
//! by a direct operating-system call (`TerminateProcess` on Windows, which works on a suspended process too and closes
//! its end of every pipe, so a blocked pipe write returns `BrokenPipe`; `kill(SIGKILL)` elsewhere). Nothing waits on the
//! terminating thread: the waiter thread reaps the process. There is no timer: [`ChildGuard::wait`] sleeps on a
//! condition variable the waiter thread notifies when the process has exited.
//!
//! On Windows every child also joins a job object that kills its members when the last handle to it closes, which is
//! when this process ends, however it ends (a `taskkill /F` of the app included): an encoder, suspended or not, never
//! outlives the app that started it.

use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{Arc, Condvar, Mutex};

/// A process handle that other threads may use to end the process (a process id where there are no handles).
struct Handle(usize);

struct Shared {
    /// The raw handle while the `Child` is alive; cleared (under this lock) before it is dropped.
    handle: Mutex<Option<Handle>>,
    exit: Mutex<Option<ExitStatus>>,
    exited: Condvar,
    pid: u32,
}

#[derive(Clone)]
pub struct ChildGuard {
    shared: Arc<Shared>,
}

pub struct ChildPipes {
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

#[cfg(windows)]
fn raw(child: &Child) -> usize {
    use std::os::windows::io::AsRawHandle;
    child.as_raw_handle() as usize
}

#[cfg(not(windows))]
fn raw(child: &Child) -> usize {
    child.id() as usize
}

/// The job that kills its members when this process ends.
#[cfg(windows)]
fn kill_on_close_job() -> std::io::Result<usize> {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    static JOB: OnceLock<Result<usize, i32>> = OnceLock::new();
    JOB.get_or_init(|| {
        // SAFETY: plain Win32 calls; the handle is kept for the life of the process on purpose (closing it ends the members).
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 {
                return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
            }
            Ok(job as usize)
        }
    })
    .as_ref()
    .map(|job| *job)
    .map_err(|code| std::io::Error::from_raw_os_error(*code))
}

/// Puts `child` in the kill-on-close job.
#[cfg(windows)]
fn join_job(child: &Child) -> std::io::Result<()> {
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    let job = kill_on_close_job()?;
    // SAFETY: both handles are live: the job is never closed and the child is alive until it is waited for.
    if unsafe { AssignProcessToJobObject(job as _, raw(child) as _) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Starts `command` with piped stdin, stdout and stderr and no console window.
pub fn spawn(command: &mut Command, stdin: bool) -> std::io::Result<(ChildGuard, ChildPipes)> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.stdin(if stdin { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    #[cfg(windows)]
    if let Err(error) = join_job(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(std::io::Error::new(error.kind(), format!("the encoder could not be tied to this process: {error}")));
    }
    let pipes = ChildPipes { stdin: child.stdin.take(), stdout: child.stdout.take(), stderr: child.stderr.take() };
    let shared = Arc::new(Shared { handle: Mutex::new(Some(Handle(raw(&child)))), exit: Mutex::new(None), exited: Condvar::new(), pid: child.id() });
    let waiter = shared.clone();
    std::thread::Builder::new()
        .name("styk video child".into())
        .spawn(move || {
            let status = child.wait();
            *waiter.handle.lock().unwrap_or_else(|e| e.into_inner()) = None;
            drop(child);
            // A wait that failed counts as an exit that failed.
            *waiter.exit.lock().unwrap_or_else(|e| e.into_inner()) = Some(status.unwrap_or_else(|_| failed_status()));
            waiter.exited.notify_all();
        })
        .expect("a thread to wait for the encoder");
    Ok((ChildGuard { shared }, pipes))
}

#[cfg(windows)]
fn failed_status() -> ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    ExitStatus::from_raw(1)
}

#[cfg(not(windows))]
fn failed_status() -> ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    ExitStatus::from_raw(1 << 8)
}

#[cfg(not(windows))]
unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

/// Whether a process with this id exists (a stale stage folder names the process that made it).
pub fn process_exists(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: a handle opened and closed here.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                // No such process; any other refusal means it exists but is not ours to ask.
                return GetLastError() != ERROR_INVALID_PARAMETER;
            }
            let mut code = 0u32;
            let known = GetExitCodeProcess(handle, &mut code) != 0;
            CloseHandle(handle);
            !known || code == STILL_ACTIVE as u32
        }
    }
    #[cfg(not(windows))]
    {
        // SAFETY: signal 0 only checks that the process can be signalled.
        unsafe { kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(1) }
    }
}

impl ChildGuard {
    pub fn pid(&self) -> u32 {
        self.shared.pid
    }

    /// Ends the process now with a direct operating-system call; harmless when it has exited already. It never waits for
    /// the process: the waiter thread reaps it.
    pub fn terminate(&self) {
        let handle = self.shared.handle.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(Handle(raw)) = handle.as_ref() {
            #[cfg(windows)]
            // SAFETY: the handle is the live `Child`'s, which the waiter thread drops only after clearing it under this lock.
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(*raw as _, 1);
            }
            #[cfg(not(windows))]
            // SAFETY: the id is the live child's (not yet reaped: the waiter clears it under this lock first); SIGKILL is 9.
            unsafe {
                kill(*raw as i32, 9);
            }
        }
    }

    /// Whether the process has exited.
    pub fn has_exited(&self) -> bool {
        self.shared.exit.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    /// Blocks until the process has exited (ended by [`ChildGuard::terminate`] or by itself).
    pub fn wait(&self) -> ExitStatus {
        let mut exit = self.shared.exit.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(status) = *exit {
                return status;
            }
            exit = self.shared.exited.wait(exit).unwrap_or_else(|e| e.into_inner());
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn terminate_wakes_a_wait_on_a_process_that_would_never_exit() {
        let mut command = Command::new("cmd");
        command.args(["/c", "pause"]);
        let (child, _pipes) = spawn(&mut command, true).unwrap();
        let waiter = {
            let child = child.clone();
            std::thread::spawn(move || child.wait())
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!child.has_exited());
        assert!(process_exists(child.pid()));
        child.terminate();
        let status = waiter.join().unwrap();
        assert!(!status.success());
        child.terminate();
        assert!(!process_exists(child.pid()), "a reaped process no longer exists");
    }
}
