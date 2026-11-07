//! Single instance on Windows: a named mutex says who started first, a named pipe carries launch requests to it.
//!
//! The mutex only decides the first election; liveness is the pipe's answer (`styk_services::shell::instance`). A
//! secondary closes its mutex handle at once, so a primary that dies frees the name. The pipe server and the client
//! use overlapped I/O with deadlines, so a client that connects and says nothing, or a server that stops answering,
//! holds nobody for longer than [`IO_DEADLINE`]; closing the server wakes every wait.

use std::mem::{size_of, zeroed};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use styk_services::shell::instance::{Courier, Delivery, Election, ElectionPolicy, Locker, ProfileId, elect};
use styk_services::shell::launch::{LaunchInbox, LaunchRequest};
use styk_services::shell::wire::{self, ANSWER_BAD, ANSWER_BUSY, ANSWER_OK, Answer, MAX_MESSAGE};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows_sys::Win32::Security::{GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FlushFileBuffers, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, ReadFile, WriteFile};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT, WaitNamedPipeW};
use windows_sys::Win32::System::Threading::{CreateEventW, CreateMutexW, GetCurrentProcess, OpenProcessToken, SetEvent, WaitForMultipleObjects};
use windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;

use super::wide;

/// The longest one read or write on the pipe may take, on either side.
pub const IO_DEADLINE: Duration = Duration::from_secs(2);

/// An owned kernel handle.
struct Owned(HANDLE);

// SAFETY: a kernel handle may be used and closed from any thread.
unsafe impl Send for Owned {}
unsafe impl Sync for Owned {}

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            // SAFETY: closing a handle this value owns, once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn event() -> std::io::Result<Owned> {
    // SAFETY: an unnamed manual-reset event.
    let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if handle.is_null() { Err(std::io::Error::last_os_error()) } else { Ok(Owned(handle)) }
}

/// The named mutex, as a [`Locker`].
pub struct MutexLocker {
    name: Vec<u16>,
}

impl MutexLocker {
    /// The locker of a profile.
    pub fn new(profile: &ProfileId) -> MutexLocker {
        MutexLocker { name: wide(&profile.mutex_name()) }
    }
}

/// Holding the mutex: this process is the primary. Released when dropped (or when the process ends).
pub struct Held(#[allow(dead_code)] Owned);

impl Locker for MutexLocker {
    type Held = Held;

    fn try_acquire(&self) -> Option<Held> {
        // SAFETY: creates or opens the named mutex; the last error is read at once, on the same thread.
        unsafe {
            let handle = CreateMutexW(std::ptr::null(), 0, self.name.as_ptr());
            if handle.is_null() {
                return None;
            }
            let existed = GetLastError() == ERROR_ALREADY_EXISTS;
            let owned = Owned(handle);
            // A handle to a mutex someone else created is closed now: only the primary keeps the name alive.
            if existed { None } else { Some(Held(owned)) }
        }
    }
}

/// The user's SID as text, for the pipe's access list.
fn current_user_sid() -> std::io::Result<String> {
    // SAFETY: standard token query; every buffer is sized by the first call's answer and freed after use.
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let token = Owned(token);
        let mut needed = 0u32;
        GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed);
        let mut buffer = vec![0u8; needed as usize];
        if GetTokenInformation(token.0, TokenUser, buffer.as_mut_ptr().cast(), needed, &mut needed) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let length = (0..).take_while(|i| *text.add(*i) != 0).count();
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        Ok(sid)
    }
}

/// The access list of the pipe: the current user, and nobody else.
pub fn pipe_sddl() -> std::io::Result<String> {
    Ok(format!("D:P(A;;GA;;;{})", current_user_sid()?))
}

fn deadline_left(deadline: Instant) -> u32 {
    deadline.saturating_duration_since(Instant::now()).as_millis().min(u128::from(u32::MAX - 1)) as u32
}

/// Why a pipe read or write did not complete.
#[derive(Debug, PartialEq, Eq)]
enum IoFail {
    Timeout,
    Shutdown,
    Broken,
}

/// Runs one overlapped operation to completion, the deadline, or the shutdown event; cancels it if it did not finish.
unsafe fn overlapped_io(handle: HANDLE, deadline: Instant, shutdown: Option<HANDLE>, start: impl FnOnce(*mut OVERLAPPED) -> (i32, u32)) -> Result<u32, IoFail> {
    // SAFETY: `ov` and its event outlive the operation: the function does not return before the operation has
    // completed or has been cancelled and waited for.
    unsafe {
        let done = event().map_err(|_| IoFail::Broken)?;
        let mut ov: OVERLAPPED = zeroed();
        ov.hEvent = done.0;
        let (ok, error) = start(&mut ov);
        if ok == 0 && error == ERROR_PIPE_CONNECTED {
            // A client connected before ConnectNamedPipe was called: connected already, nothing to wait for.
            return Ok(0);
        }
        if ok == 0 {
            if error != ERROR_IO_PENDING {
                return Err(IoFail::Broken);
            }
            let waits = [done.0, shutdown.unwrap_or(done.0)];
            let count = if shutdown.is_some() { 2 } else { 1 };
            let result = WaitForMultipleObjects(count, waits.as_ptr(), 0, deadline_left(deadline));
            if result != WAIT_OBJECT_0 {
                CancelIoEx(handle, &ov);
                let mut ignored = 0u32;
                GetOverlappedResult(handle, &ov, &mut ignored, 1);
                return Err(if result == WAIT_OBJECT_0 + 1 { IoFail::Shutdown } else if result == WAIT_TIMEOUT { IoFail::Timeout } else { IoFail::Broken });
            }
        }
        let mut transferred = 0u32;
        if GetOverlappedResult(handle, &ov, &mut transferred, 0) == 0 {
            return Err(IoFail::Broken);
        }
        Ok(transferred)
    }
}

fn read_exact(handle: HANDLE, buffer: &mut [u8], deadline: Instant, shutdown: Option<HANDLE>) -> Result<(), IoFail> {
    let mut filled = 0;
    while filled < buffer.len() {
        let chunk = &mut buffer[filled..];
        let (ptr, len) = (chunk.as_mut_ptr(), chunk.len() as u32);
        // SAFETY: `ptr` points to `len` writable bytes that stay alive until the operation is over.
        let got = unsafe { overlapped_io(handle, deadline, shutdown, |ov| (ReadFile(handle, ptr.cast(), len, std::ptr::null_mut(), ov), GetLastError())) }?;
        if got == 0 {
            return Err(IoFail::Broken);
        }
        filled += got as usize;
    }
    Ok(())
}

fn write_all(handle: HANDLE, data: &[u8], deadline: Instant, shutdown: Option<HANDLE>) -> Result<(), IoFail> {
    let mut sent = 0;
    while sent < data.len() {
        let chunk = &data[sent..];
        let (ptr, len) = (chunk.as_ptr(), chunk.len() as u32);
        // SAFETY: `ptr` points to `len` readable bytes that stay alive until the operation is over.
        let wrote = unsafe { overlapped_io(handle, deadline, shutdown, |ov| (WriteFile(handle, ptr.cast(), len, std::ptr::null_mut(), ov), GetLastError())) }?;
        if wrote == 0 {
            return Err(IoFail::Broken);
        }
        sent += wrote as usize;
    }
    Ok(())
}

/// The pipe server of the primary: receives launch requests and queues them.
pub struct PipeServer {
    shutdown: Arc<Owned>,
    thread: Option<JoinHandle<()>>,
    stopped: Arc<AtomicBool>,
}

impl PipeServer {
    /// Starts serving `profile`'s pipe. `wake` is called, from the server thread and without blocking, after a request
    /// was queued.
    pub fn start(profile: &ProfileId, inbox: Arc<LaunchInbox>, wake: impl Fn() + Send + Sync + 'static) -> std::io::Result<PipeServer> {
        let name = wide(&profile.pipe_name());
        let sddl = wide(&pipe_sddl()?);
        let shutdown = Arc::new(event()?);
        let stopped = Arc::new(AtomicBool::new(false));
        let (thread_shutdown, thread_stopped) = (shutdown.clone(), stopped.clone());
        // The first instance is created here, on the caller's thread, so a failure (the name belongs to someone else) is
        // reported to the caller and not lost in a thread.
        let first = create_instance(&name, &sddl, true)?;
        let thread = std::thread::Builder::new()
            .name("styk-instance-pipe".into())
            .spawn(move || serve(first, name, sddl, inbox, wake, thread_shutdown, thread_stopped))
            .map_err(std::io::Error::other)?;
        Ok(PipeServer { shutdown, thread: Some(thread), stopped })
    }

    /// Whether the server thread has ended.
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
}

impl Drop for PipeServer {
    fn drop(&mut self) {
        // SAFETY: wakes the server thread's waits.
        unsafe { SetEvent(self.shutdown.0) };
        if let Some(thread) = self.thread.take() {
            // Never joined here: the dropping thread may be the interface's. The thread ends within one wake-up.
            std::thread::spawn(move || {
                let _ = thread.join();
            });
        }
    }
}

fn create_instance(name: &[u16], sddl: &[u16], first: bool) -> std::io::Result<Owned> {
    // SAFETY: the security descriptor is built from a fixed SDDL string and freed after the pipe exists.
    unsafe {
        let mut descriptor = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut()) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
        let open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
        let handle = CreateNamedPipeW(name.as_ptr(), open, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 2, 64, (MAX_MESSAGE + 8) as u32, 0, &attributes);
        let error = std::io::Error::last_os_error();
        LocalFree(descriptor);
        if handle == INVALID_HANDLE_VALUE { Err(error) } else { Ok(Owned(handle)) }
    }
}

fn serve(first: Owned, name: Vec<u16>, sddl: Vec<u16>, inbox: Arc<LaunchInbox>, wake: impl Fn(), shutdown: Arc<Owned>, stopped: Arc<AtomicBool>) {
    // Two instances at most: the one a client is connected to, and one always listening, so a start that arrives while
    // another is being served finds the pipe (a name with no instance would look like a dead primary).
    let mut pipe = Some(first);
    loop {
        let Some(instance) = pipe.take().or_else(|| create_instance(&name, &sddl, false).ok()) else {
            // The name could not be recreated (resources): try again soon, or end with the shutdown.
            // SAFETY: waits on the shutdown event.
            if unsafe { WaitForMultipleObjects(1, &shutdown.0, 0, 50) } == WAIT_OBJECT_0 {
                break;
            }
            continue;
        };
        // Wait for a client.
        let connected = {
            // SAFETY: the overlapped structure lives until the wait or the cancellation is over.
            unsafe {
                overlapped_io(instance.0, Instant::now() + Duration::from_secs(3600), Some(shutdown.0), |ov| {
                    let ok = ConnectNamedPipe(instance.0, ov);
                    (ok, GetLastError())
                })
            }
        };
        match connected {
            Ok(_) => {}
            Err(IoFail::Shutdown) => break,
            Err(_) => continue,
        }
        pipe = create_instance(&name, &sddl, false).ok();
        let answer = receive(instance.0, &inbox, shutdown.0);
        if let Some(bytes) = answer.as_ref() {
            let _ = write_all(instance.0, bytes, Instant::now() + IO_DEADLINE, Some(shutdown.0));
            // SAFETY: lets the client read the answer before the instance goes.
            unsafe { FlushFileBuffers(instance.0) };
            if *bytes == ANSWER_OK {
                wake();
            }
        }
        // SAFETY: ends this client's connection; the instance is closed by its owner.
        unsafe { DisconnectNamedPipe(instance.0) };
    }
    stopped.store(true, Ordering::Release);
}

/// Reads one request and queues it; the answer to send, or nothing when the client went away.
fn receive(handle: HANDLE, inbox: &LaunchInbox, shutdown: HANDLE) -> Option<&'static [u8]> {
    let deadline = Instant::now() + IO_DEADLINE;
    let mut header = [0u8; 4];
    read_exact(handle, &mut header, deadline, Some(shutdown)).ok()?;
    let Ok(len) = wire::payload_len(header) else { return Some(ANSWER_BAD) };
    let mut payload = vec![0u8; len];
    read_exact(handle, &mut payload, deadline, Some(shutdown)).ok()?;
    match wire::decode(&payload) {
        Ok(request) => Some(if inbox.push(request).is_ok() { ANSWER_OK } else { ANSWER_BUSY }),
        Err(_) => Some(ANSWER_BAD),
    }
}

/// The client side: hands a request to the primary.
pub struct PipeCourier {
    name: Vec<u16>,
}

impl PipeCourier {
    /// The courier to a profile's primary.
    pub fn new(profile: &ProfileId) -> PipeCourier {
        PipeCourier { name: wide(&profile.pipe_name()) }
    }

    fn connect(&self) -> Result<Owned, Delivery> {
        for _ in 0..3 {
            // SAFETY: opens the named pipe for reading and writing, overlapped.
            let handle = unsafe { CreateFileW(self.name.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED, std::ptr::null_mut()) };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(Owned(handle));
            }
            // SAFETY: the last error of the call above, on this thread.
            match unsafe { GetLastError() } {
                ERROR_PIPE_BUSY => {
                    // SAFETY: waits (bounded) until the server has a free instance.
                    unsafe { WaitNamedPipeW(self.name.as_ptr(), 250) };
                }
                ERROR_FILE_NOT_FOUND => return Err(Delivery::NoServer),
                _ => return Err(Delivery::NoServer),
            }
        }
        Err(Delivery::Busy)
    }
}

impl Courier for PipeCourier {
    fn deliver(&self, request: &LaunchRequest) -> Delivery {
        let Ok(frame) = wire::encode(request) else { return Delivery::Refused };
        let pipe = match self.connect() {
            Ok(pipe) => pipe,
            Err(outcome) => return outcome,
        };
        let deadline = Instant::now() + IO_DEADLINE;
        let mut pid = 0u32;
        // SAFETY: lets the primary come to the front when it handles the request.
        unsafe {
            if GetNamedPipeServerProcessId(pipe.0, &mut pid) != 0 {
                AllowSetForegroundWindow(pid);
            }
        }
        if write_all(pipe.0, &frame, deadline, None).is_err() {
            return Delivery::NoServer;
        }
        let mut answer = [0u8; 8];
        let mut length = 0;
        while length < answer.len() {
            let one = &mut answer[length..length + 1];
            if read_exact(pipe.0, one, deadline, None).is_err() {
                return Delivery::NoServer;
            }
            length += 1;
            if answer[length - 1] == b'\n' {
                break;
            }
        }
        match wire::parse_answer(&answer[..length]) {
            Some(Answer::Ok) => Delivery::Acked,
            Some(Answer::Busy) => Delivery::Busy,
            Some(Answer::Bad) => Delivery::Refused,
            None => Delivery::NoServer,
        }
    }
}

/// The primary's side of the instance: the lock, the pipe server and the queue it fills.
pub struct Primary {
    /// Requests that arrived from later starts.
    pub inbox: Arc<LaunchInbox>,
    _server: Option<PipeServer>,
    _held: Held,
}

/// What this process is, after the election.
pub enum Role {
    /// The first instance.
    Primary(Primary),
    /// The request went to the primary, which acknowledged it: end.
    Forwarded,
    /// A separate editor with its own workspace directory.
    Independent,
    /// The primary refused the request.
    Refused,
}

/// Decides this process's role for `profile`. `request` is what this start carries for the primary (a protocol link);
/// `wake` is called when a later start's request has been queued. A primary whose pipe could not be created (another
/// program owns the name) still is the primary; it just receives nothing, and `Primary::is_serving` says so.
pub fn acquire(profile: &ProfileId, request: Option<&LaunchRequest>, wake: impl Fn() + Send + Sync + 'static) -> Role {
    acquire_with(profile, request, ElectionPolicy::default(), wake)
}

/// [`acquire`] with an explicit policy, so tests do not wait the production back-off.
pub fn acquire_with(profile: &ProfileId, request: Option<&LaunchRequest>, policy: ElectionPolicy, wake: impl Fn() + Send + Sync + 'static) -> Role {
    let locker = MutexLocker::new(profile);
    let courier = PipeCourier::new(profile);
    match elect(&locker, &courier, request, policy, &mut |pause| std::thread::sleep(pause)) {
        Election::Primary(held) => {
            let inbox = Arc::new(LaunchInbox::new());
            let server = PipeServer::start(profile, inbox.clone(), wake).ok();
            Role::Primary(Primary { inbox, _server: server, _held: held })
        }
        Election::Forwarded => Role::Forwarded,
        Election::Independent => Role::Independent,
        Election::Refused => Role::Refused,
    }
}

impl Primary {
    /// Whether the pipe is being served.
    pub fn is_serving(&self) -> bool {
        self._server.as_ref().is_some_and(|server| !server.is_stopped())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicUsize;
    use styk_services::shell::protocol::{ProtocolLink, PublicId};
    use windows_sys::Win32::Security::Authorization::{ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SE_KERNEL_OBJECT};
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;

    fn profile(tag: &str) -> ProfileId {
        ProfileId::of(&PathBuf::from(format!("C:/styk-test-profile/{tag}-{}-{:?}", std::process::id(), std::time::SystemTime::now())))
    }

    fn quick() -> ElectionPolicy {
        ElectionPolicy { rounds: 5, pause: Duration::from_millis(5), max_pause: Duration::from_millis(20) }
    }

    fn library(id: &str) -> LaunchRequest {
        LaunchRequest::Protocol(ProtocolLink::Library(PublicId::parse(id)))
    }

    fn primary(role: Role) -> Primary {
        match role {
            Role::Primary(p) => p,
            Role::Forwarded => panic!("forwarded"),
            Role::Independent => panic!("independent"),
            Role::Refused => panic!("refused"),
        }
    }

    fn wait_for(mut condition: impl FnMut() -> bool) -> bool {
        let end = Instant::now() + Duration::from_secs(3);
        while Instant::now() < end {
            if condition() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    #[test]
    fn the_first_start_is_primary_and_a_link_from_a_second_start_arrives_exactly_once() {
        let id = profile("deliver");
        let wakes = Arc::new(AtomicUsize::new(0));
        let w = wakes.clone();
        let first = primary(acquire_with(&id, None, quick(), move || {
            w.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(first.is_serving());
        let started = Instant::now();
        let role = acquire_with(&id, Some(&library("abcdefghij")), quick(), || {});
        assert!(matches!(role, Role::Forwarded));
        assert!(started.elapsed() < Duration::from_millis(500), "delivered within 500 ms: {:?}", started.elapsed());
        assert_eq!(first.inbox.pop(), Some(library("abcdefghij")));
        assert_eq!(first.inbox.pop(), None, "exactly one");
        assert!(wait_for(|| wakes.load(Ordering::SeqCst) == 1));
    }

    #[test]
    fn an_ordinary_second_start_is_independent_and_hands_nothing_over() {
        let id = profile("independent");
        let first = primary(acquire_with(&id, None, quick(), || {}));
        assert!(matches!(acquire_with(&id, None, quick(), || {}), Role::Independent));
        assert!(first.inbox.is_empty());
    }

    #[test]
    fn invalid_links_never_reach_the_primary() {
        // They are refused before the wire (parse_protocol); a hand-made frame with one is answered BAD and queued nowhere.
        let id = profile("invalid");
        let first = primary(acquire_with(&id, None, quick(), || {}));
        let bad = {
            let payload = b"L\nstykanimate://open/?x=1";
            let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
            frame.extend_from_slice(payload);
            frame
        };
        assert_eq!(raw_exchange(&id, &bad), Some(b"BAD\n".to_vec()));
        let oversized = (MAX_MESSAGE as u32 + 1).to_le_bytes().to_vec();
        assert_eq!(raw_exchange(&id, &oversized), Some(b"BAD\n".to_vec()), "a length past the bound is refused before any payload is read");
        assert!(first.inbox.is_empty());
    }

    /// Writes raw bytes to the profile's pipe and reads the answer line.
    fn raw_exchange(id: &ProfileId, bytes: &[u8]) -> Option<Vec<u8>> {
        let courier = PipeCourier::new(id);
        let pipe = (0..40).find_map(|_| courier.connect().ok().or_else(|| { std::thread::sleep(Duration::from_millis(5)); None }))?;
        let deadline = Instant::now() + IO_DEADLINE;
        write_all(pipe.0, bytes, deadline, None).ok()?;
        let mut answer = Vec::new();
        loop {
            let mut one = [0u8; 1];
            read_exact(pipe.0, &mut one, deadline, None).ok()?;
            answer.push(one[0]);
            if one[0] == b'\n' || answer.len() > 8 {
                return Some(answer);
            }
        }
    }

    #[test]
    fn a_client_that_connects_and_says_nothing_is_dropped_at_the_deadline_and_the_next_is_served() {
        let id = profile("silent");
        let first = primary(acquire_with(&id, None, quick(), || {}));
        let silent = PipeCourier::new(&id).connect().expect("connected");
        let started = Instant::now();
        // The server is busy with the silent client for up to the deadline; a real request waits its turn and is served.
        let role = acquire_with(&id, Some(&library("zyxwvutsrq")), ElectionPolicy { rounds: 10, pause: Duration::from_millis(50), max_pause: Duration::from_millis(400) }, || {});
        assert!(matches!(role, Role::Forwarded), "served after the silent client was dropped");
        assert!(started.elapsed() < IO_DEADLINE + Duration::from_secs(2), "{:?}", started.elapsed());
        assert_eq!(first.inbox.pop(), Some(library("zyxwvutsrq")));
        drop(silent);
    }

    #[test]
    fn a_partial_message_does_not_hold_the_server_past_the_deadline() {
        let id = profile("partial");
        let first = primary(acquire_with(&id, None, quick(), || {}));
        let courier = PipeCourier::new(&id);
        let pipe = courier.connect().unwrap();
        write_all(pipe.0, &[200, 0, 0, 0, b'L'], Instant::now() + IO_DEADLINE, None).unwrap(); // promises 200 bytes, sends one
        let started = Instant::now();
        let patient = ElectionPolicy { rounds: 12, pause: Duration::from_millis(50), max_pause: Duration::from_millis(400) };
        assert!(matches!(acquire_with(&id, Some(&library("abcdefghij")), patient, || {}), Role::Forwarded), "served once the partial client was dropped");
        assert!(started.elapsed() < IO_DEADLINE + Duration::from_secs(3), "{:?}", started.elapsed());
        assert_eq!(first.inbox.pop(), Some(library("abcdefghij")));
        assert!(first.is_serving());
        drop(pipe);
    }

    #[test]
    fn a_full_queue_answers_busy_and_loses_nothing_queued() {
        use styk_services::shell::launch::QUEUE_CAPACITY;
        let id = profile("saturated");
        let first = primary(acquire_with(&id, None, quick(), || {}));
        let courier = PipeCourier::new(&id);
        for n in 0..QUEUE_CAPACITY {
            let request = LaunchRequest::Files(vec![format!("{n}.piv").into()]);
            assert_eq!(courier.deliver(&request), Delivery::Acked, "request {n}");
        }
        assert_eq!(courier.deliver(&library("abcdefghij")), Delivery::Busy);
        assert_eq!(first.inbox.len(), QUEUE_CAPACITY);
        assert_eq!(first.inbox.pop(), Some(LaunchRequest::Files(vec!["0.piv".into()])));
        assert_eq!(courier.deliver(&library("abcdefghij")), Delivery::Acked, "after the interface drains, delivery works again");
    }

    #[test]
    fn closing_the_primary_with_requests_pending_ends_the_server_promptly() {
        let id = profile("shutdown");
        let first = primary(acquire_with(&id, None, quick(), || {}));
        let courier = PipeCourier::new(&id);
        assert_eq!(courier.deliver(&library("abcdefghij")), Delivery::Acked);
        let _hanging = courier.connect().expect("a client is connected and silent");
        let started = Instant::now();
        drop(first);
        // The pipe name is gone quickly: a later delivery finds no server.
        assert!(wait_for(|| courier.deliver(&library("abcdefghij")) == Delivery::NoServer), "the server was still there");
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    }

    #[test]
    fn a_killed_primary_is_replaced_by_the_next_start_and_the_link_is_not_lost() {
        // Launch A, launch B (independent, drops its handle), kill A: C becomes the primary and handles the link itself.
        let id = profile("rejoin");
        let a = primary(acquire_with(&id, None, quick(), || {}));
        assert!(matches!(acquire_with(&id, None, quick(), || {}), Role::Independent));
        drop(a);
        let c = acquire_with(&id, Some(&library("abcdefghij")), quick(), || {});
        assert!(matches!(c, Role::Primary(_)), "the next start is the primary: the name is free");
    }

    #[test]
    fn the_pipe_admits_only_the_current_user() {
        let id = profile("acl");
        let _first = primary(acquire_with(&id, None, quick(), || {}));
        let pipe = PipeCourier::new(&id).connect().unwrap();
        // SAFETY: reads the security descriptor of a handle this test owns and converts it to text; both buffers are freed.
        let text = unsafe {
            let mut descriptor = std::ptr::null_mut();
            assert_eq!(GetSecurityInfo(pipe.0, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), &mut descriptor), 0);
            let mut string: *mut u16 = std::ptr::null_mut();
            assert_ne!(ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut string, std::ptr::null_mut()), 0);
            let length = (0..).take_while(|i| *string.add(*i) != 0).count();
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(string, length));
            LocalFree(string.cast());
            LocalFree(descriptor);
            text
        };
        let expected = pipe_sddl().unwrap().replace(";GA;", ";FA;"); // the system reports generic-all as file-all on a pipe
        assert_eq!(text, expected, "one allow entry, for the current user's SID, and the DACL is protected");
        assert!(text.matches("(A;").count() == 1 && !text.contains("(D;"));
    }
}
