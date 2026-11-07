//! A child process that can be ended from any thread, however it is blocked.
//!
//! The thread that waits for the exit owns the `Child`; everyone else holds a [`ChildGuard`], which ends the process
//! by its handle (`TerminateProcess` works on a suspended process too, and closes its end of every pipe, so a
//! blocked pipe write returns `BrokenPipe`). There is no timer: [`ChildGuard::wait`] sleeps on a condition variable
//! the waiter thread notifies when the process has exited.

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

#[cfg(windows)]
fn raw(child: &Child) -> usize {
    use std::os::windows::io::AsRawHandle;
    child.as_raw_handle() as usize
}

#[cfg(not(windows))]
fn raw(child: &Child) -> usize {
    child.id() as usize
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
    Ok((ChildGuard { shared }, ChildPipes { ..pipes }))
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

impl ChildGuard {
    pub fn pid(&self) -> u32 {
        self.shared.pid
    }

    /// Ends the process now. Harmless when it has exited already.
    pub fn terminate(&self) {
        let handle = self.shared.handle.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(Handle(raw)) = handle.as_ref() {
            #[cfg(windows)]
            // SAFETY: the handle is the live `Child`'s, which the waiter thread drops only after clearing it under this lock.
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(*raw as _, 1);
            }
            #[cfg(not(windows))]
            let _ = std::process::Command::new("kill").arg("-9").arg(raw.to_string()).status();
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
        child.terminate();
        let status = waiter.join().unwrap();
        assert!(!status.success());
        child.terminate();
    }
}
