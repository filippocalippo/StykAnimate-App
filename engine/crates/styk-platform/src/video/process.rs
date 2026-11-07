//! A child process that can be ended from any thread, however it is blocked. Windows only in this phase (decision N8).
//!
//! The thread that waits for the exit owns the `Child`; everyone else holds a [`ChildGuard`], which ends the process
//! with `TerminateProcess` on the child's handle: it works on a suspended process too and closes its end of every pipe, so
//! a blocked pipe write returns `BrokenPipe`. Nothing waits on the terminating thread: the waiter thread reaps the
//! process. There is no timer: [`ChildGuard::wait`] sleeps on a condition variable the waiter thread notifies when the
//! process has exited.
//!
//! Every child also joins a job object that kills its members when the last handle to it closes, which is when this
//! process ends, however it ends (a `taskkill /F` of the app included): an encoder, suspended or not, never outlives the
//! app that started it. A child is created suspended, put in the job and only then resumed, so there is no moment in which
//! it runs outside it.
//!
//! `ChildGuard` is the one place a process is ended: a Unix implementation replaces its handle by a stable one (a pidfd on
//! Linux) and nothing above it changes.

use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{Arc, Condvar, Mutex};

/// A process handle that other threads may use to end the process.
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

fn raw(child: &Child) -> usize {
    use std::os::windows::io::AsRawHandle;
    child.as_raw_handle() as usize
}

/// The job that kills its members when this process ends.
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
fn join_job(child: &Child) -> std::io::Result<()> {
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    let job = kill_on_close_job()?;
    // SAFETY: both handles are live: the job is never closed and the child is alive until it is waited for.
    if unsafe { AssignProcessToJobObject(job as _, raw(child) as _) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Whether process `pid` is in the kill-on-close job.
pub fn in_kill_on_close_job(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let Ok(job) = kill_on_close_job() else { return false };
    // SAFETY: a handle opened and closed here.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let mut inside = 0;
        let known = IsProcessInJob(process, job as _, &mut inside) != 0;
        CloseHandle(process);
        known && inside != 0
    }
}

/// Resumes the one thread of a process created suspended.
fn resume(pid: u32) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32};
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    // SAFETY: plain Win32 calls on handles opened and closed here.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut resumed = false;
        let mut more = Thread32First(snapshot, &mut entry) != 0;
        while more {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    resumed |= ResumeThread(thread) != u32::MAX;
                    CloseHandle(thread);
                }
            }
            more = Thread32Next(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        if resumed { Ok(()) } else { Err(std::io::Error::other("the encoder's thread could not be resumed")) }
    }
}

/// Starts `command` with piped stdin, stdout and stderr and no console window.
pub fn spawn(command: &mut Command, stdin: bool) -> std::io::Result<(ChildGuard, ChildPipes)> {
    spawn_with(command, stdin, &|_| {})
}

/// [`spawn`], calling `between` with the process id after the child is in its job and before it runs its first
/// instruction. Tests look at that moment.
#[doc(hidden)]
pub fn spawn_with(command: &mut Command, stdin: bool, between: &dyn Fn(u32)) -> std::io::Result<(ChildGuard, ChildPipes)> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child = command.stdin(if stdin { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    // Suspended from its first instruction until it is in the job: there is no moment in which it runs outside it.
    let started = join_job(&child).map_err(|error| std::io::Error::new(error.kind(), format!("the encoder could not be tied to this process: {error}")));
    let started = started.and_then(|()| {
        between(child.id());
        resume(child.id())
    });
    if let Err(error) = started {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
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

fn failed_status() -> ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    ExitStatus::from_raw(1)
}

/// Whether a process with this id exists (a stale stage folder names the process that made it).
pub fn process_exists(pid: u32) -> bool {
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

impl ChildGuard {
    pub fn pid(&self) -> u32 {
        self.shared.pid
    }

    /// Ends the process now with `TerminateProcess`; harmless when it has exited already. It never waits for the process:
    /// the waiter thread reaps it.
    pub fn terminate(&self) {
        let handle = self.shared.handle.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(Handle(raw)) = handle.as_ref() {
            // SAFETY: the handle is the live `Child`'s, which the waiter thread drops only after clearing it under this lock.
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(*raw as _, 1);
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

#[cfg(test)]
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

    /// Re-check finding 4: a child that is not yet in the kill-on-close job when it first runs can be left outside it by a
    /// kill of the app at that moment. Here the child would write a file the instant it ran; at the point between the
    /// assignment to the job and the first instruction it is in the job and has written nothing.
    #[test]
    fn a_child_is_in_the_kill_on_close_job_before_it_runs_its_first_instruction() {
        let marker = std::env::temp_dir().join(format!("styk-job-boundary-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let mut command = Command::new("cmd");
        command.arg("/c").arg(format!("echo ran> {}", marker.display()));
        let (child, _pipes) = spawn_with(&mut command, false, &|pid| {
            assert!(in_kill_on_close_job(pid), "the child is not in the job when it is about to run");
            std::thread::sleep(std::time::Duration::from_millis(400));
            assert!(!marker.exists(), "the child ran before it was released: it was running outside the job");
        })
        .unwrap();
        assert!(child.wait().success());
        assert!(marker.exists(), "and it runs once released");
        let _ = std::fs::remove_file(&marker);
    }
}
