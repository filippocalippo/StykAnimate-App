//! Current-user developer pipe. Shares the S6 identity, SQOS and cancellable I/O rules.
use crate::windows::instance::{
    IoFail, Owned, deadline_left, event, overlapped_io, pipe_sddl, process_is_current_user,
    read_exact, write_all,
};
use crate::windows::wide;
use std::{
    mem::size_of,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use styk_services::{
    Spawner,
    control::{Inbox, MAX_REQUEST, MAX_RESPONSE, Operation, Request, Running, Transport},
};
use windows_sys::Win32::Foundation::{
    GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{SetEvent, WaitForMultipleObjects};
fn create_instance(name: &[u16], sddl: &[u16], first: bool) -> std::io::Result<Owned> {
    // SAFETY: the security descriptor is built from a fixed SDDL string and freed after the pipe exists.
    unsafe {
        let mut descriptor = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let open = PIPE_ACCESS_DUPLEX
            | FILE_FLAG_OVERLAPPED
            | if first {
                FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };
        let handle = CreateNamedPipeW(
            name.as_ptr(),
            open,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            2,
            64,
            (MAX_REQUEST + 8) as u32,
            0,
            &attributes,
        );
        let error = std::io::Error::last_os_error();
        LocalFree(descriptor);
        if handle == INVALID_HANDLE_VALUE {
            Err(error)
        } else {
            Ok(Owned(handle))
        }
    }
}

const DEADLINE: Duration = Duration::from_secs(2);
fn endpoint(name: &str) -> Result<Vec<u16>, String> {
    if !name.starts_with("stykanimate-dev-")
        || name.len() > 96
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("invalid local endpoint".into());
    }
    Ok(wide(&format!(r"\\.\pipe\{name}")))
}
struct Stop(Arc<Owned>, Arc<AtomicBool>);
struct Finished(Arc<AtomicBool>);
impl Drop for Finished {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
impl Running for Stop {
    fn cancel(&self) {
        unsafe {
            SetEvent(self.0.0);
        }
    }
    fn is_finished(&self) -> bool {
        self.1.load(Ordering::Acquire)
    }
}
impl Drop for Stop {
    fn drop(&mut self) {
        self.cancel();
    }
}
fn stopped(stop: &Owned) -> bool {
    unsafe { WaitForMultipleObjects(1, &stop.0, 0, 0) == WAIT_OBJECT_0 }
}
fn read_line(
    pipe: HANDLE,
    max: usize,
    deadline: Instant,
    stop: Option<HANDLE>,
) -> Result<Vec<u8>, IoFail> {
    let mut bytes = Vec::with_capacity(max);
    let mut scratch = [0u8; 4096];
    loop {
        let n = unsafe {
            overlapped_io(pipe, deadline, stop, |ov| {
                (
                    ReadFile(
                        pipe,
                        scratch.as_mut_ptr().cast(),
                        4096,
                        std::ptr::null_mut(),
                        ov,
                    ),
                    GetLastError(),
                )
            })
        }? as usize;
        if n == 0 {
            return Err(IoFail::Broken);
        }
        let end = scratch[..n].iter().position(|b| *b == b'\n');
        let take = end.unwrap_or(n);
        if take > max - bytes.len() || end.is_some_and(|i| i + 1 != n) {
            return Err(IoFail::Broken);
        }
        bytes.extend_from_slice(&scratch[..take]);
        if end.is_some() {
            return Ok(bytes);
        }
    }
}

fn connect(name: &[u16]) -> Result<Owned, String> {
    // Identification-level SQOS prevents a squatting server from acting as the caller.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let pipe = Owned(handle);
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe.raw(), &mut pid) } == 0
        || !process_is_current_user(pid)
    {
        return Err("pipe server is not the current user".into());
    }
    Ok(pipe)
}
const CONTROL_BYTES: usize = 4 * 1024 * 1024;
const CONNECTION_BYTES: usize = 128 * 1024;
static USED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static REFUSED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
struct Admission;
impl Admission {
    fn reserve() -> Result<Self, String> {
        if USED
            .try_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(CONNECTION_BYTES)
                    .filter(|n| *n <= CONTROL_BYTES)
            })
            .is_err()
        {
            REFUSED.fetch_add(1, Ordering::Relaxed);
            return Err("control byte budget exhausted".into());
        }
        Ok(Self)
    }
}
impl Drop for Admission {
    fn drop(&mut self) {
        USED.fetch_sub(CONNECTION_BYTES, Ordering::AcqRel);
    }
}
pub struct LocalControl;
impl LocalControl {
    pub fn accounting() -> (usize, u64) {
        (
            USED.load(Ordering::Relaxed),
            REFUSED.load(Ordering::Relaxed),
        )
    }
}
impl LocalControl {
    pub fn free_disk_bytes() -> Result<u64, String> {
        let mut available = 0u64;
        let current = std::env::current_dir().map_err(|e| e.to_string())?;
        let path = wide(&current.to_string_lossy());
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(available)
    }
}
// Connection-level errors have no decoded request ID. Only fixed transport reasons enter this formatter.
fn transport_error(reason: &'static str) -> Vec<u8> {
    format!(r#"{{"id":null,"ok":false,"error":{{"what":"transport failed","where":"named pipe","input":null,"cause":"{reason}","hint":"retry after the host is ready"}}}}"#).into_bytes()
}
impl Transport for LocalControl {
    fn serve(
        &self,
        spawner: &dyn Spawner,
        name: &str,
        inbox: Arc<Inbox>,
    ) -> Result<Box<dyn Running>, String> {
        let admission = Admission::reserve()?;
        let name = endpoint(name)?;
        let sddl = wide(&pipe_sddl().map_err(|e| e.to_string())?);
        let pipe = create_instance(&name, &sddl, true).map_err(|e| e.to_string())?;
        let stop = Arc::new(event().map_err(|e| e.to_string())?);
        let shutdown = stop.clone();
        let finished = Arc::new(AtomicBool::new(false));
        let finish = finished.clone();
        spawner
            .spawn(
                "devtools.pipe",
                Box::new(move || {
                    let _admission = admission;
                    let _finished = Finished(finish);
                    while !stopped(&shutdown) {
                        let accepted = unsafe {
                            overlapped_io(
                                pipe.raw(),
                                Instant::now() + Duration::from_secs(86400),
                                Some(shutdown.0),
                                |ov| (ConnectNamedPipe(pipe.raw(), ov), GetLastError()),
                            )
                        };
                        if accepted == Err(IoFail::Shutdown) {
                            break;
                        }
                        if accepted.is_err() {
                            unsafe { DisconnectNamedPipe(pipe.raw()) };
                            continue;
                        }
                        let deadline = Instant::now() + DEADLINE;
                        if let Ok(bytes) =
                            read_line(pipe.raw(), MAX_REQUEST, deadline, Some(shutdown.0))
                        {
                            let reply = Arc::new(Mutex::new(None::<Vec<u8>>));
                            let answer = reply.clone();
                            let Ok(ready) = event().map(Arc::new) else {
                                break;
                            };
                            let signal = ready.clone();
                            let cancelled = Arc::new(AtomicBool::new(false));
                            let request_cancel = cancelled.clone();
                            let request = Request::new(
                                bytes,
                                cancelled.clone(),
                                Box::new(move |bytes| {
                                    let mut slot = answer.try_lock().map_err(|_| "reply busy")?;
                                    if request_cancel.load(Ordering::Acquire) {
                                        return Err("request cancelled".into());
                                    }
                                    *slot = Some(bytes);
                                    unsafe { SetEvent(signal.0) };
                                    Ok(())
                                }),
                            );
                            let response = if inbox.push(request).is_err() {
                                Some(transport_error("control queue full"))
                            } else {
                                let handles = [ready.0, shutdown.0];
                                let status = unsafe {
                                    WaitForMultipleObjects(
                                        2,
                                        handles.as_ptr(),
                                        0,
                                        deadline_left(deadline),
                                    )
                                };
                                if status == WAIT_OBJECT_0 {
                                    reply.lock().ok().and_then(|mut slot| slot.take())
                                } else {
                                    cancelled.store(true, Ordering::Release);
                                    Some(transport_error("host timeout or shutdown"))
                                }
                            };
                            if let Some(mut bytes) = response {
                                if bytes.last() != Some(&b'\n') {
                                    bytes.reserve_exact(1);
                                    bytes.push(b'\n');
                                }
                                if write_all(
                                    pipe.raw(),
                                    &bytes,
                                    Instant::now() + DEADLINE,
                                    Some(shutdown.0),
                                )
                                .is_ok()
                                {
                                    let mut ack = [0];
                                    let _ = read_exact(
                                        pipe.raw(),
                                        &mut ack,
                                        Instant::now() + DEADLINE,
                                        Some(shutdown.0),
                                    );
                                }
                            }
                        }
                        unsafe { DisconnectNamedPipe(pipe.raw()) };
                    }
                }),
            )
            .map_err(|e| e.to_string())?;
        Ok(Box::new(Stop(stop, finished)))
    }
    fn request(
        &self,
        spawner: &dyn Spawner,
        name: &str,
        mut message: Vec<u8>,
    ) -> Result<Operation, String> {
        if message.last() == Some(&b'\n') {
            message.pop();
        }
        if message.capacity() > MAX_REQUEST + 1
            || message.len() > MAX_REQUEST
            || message.contains(&b'\n')
        {
            return Err("one bounded JSON line required".into());
        }
        let admission = Admission::reserve()?;
        let name = endpoint(name)?;
        let stop = Arc::new(event().map_err(|e| e.to_string())?);
        let shutdown = stop.clone();
        let finished = Arc::new(AtomicBool::new(false));
        let finish = finished.clone();
        let completion = Arc::new(Mutex::new(None));
        let output = completion.clone();
        spawner
            .spawn(
                "devtools.client",
                Box::new(move || {
                    let _admission = admission;
                    let _finished = Finished(finish);
                    let outcome = (|| {
                        let pipe = connect(&name)?;
                        message.reserve_exact(1);
                        message.push(b'\n');
                        write_all(
                            pipe.raw(),
                            &message,
                            Instant::now() + DEADLINE,
                            Some(shutdown.0),
                        )
                        .map_err(|e| format!("pipe write: {e:?}"))?;
                        let response = read_line(
                            pipe.raw(),
                            MAX_RESPONSE,
                            Instant::now() + DEADLINE,
                            Some(shutdown.0),
                        )
                        .map_err(|e| format!("pipe read: {e:?}"))?;
                        write_all(
                            pipe.raw(),
                            &[0],
                            Instant::now() + DEADLINE,
                            Some(shutdown.0),
                        )
                        .map_err(|e| format!("pipe acknowledgement: {e:?}"))?;
                        Ok(response)
                    })();
                    if let Ok(mut slot) = output.lock() {
                        *slot = Some(outcome);
                    }
                }),
            )
            .map_err(|e| e.to_string())?;
        Ok(Operation {
            completion,
            cancel: Box::new(Stop(stop, finished)),
        })
    }
}
#[cfg(test)]
mod dev_control_tests {
    use super::*;
    fn name(tag: &str) -> String {
        format!("stykanimate-dev-{}-{tag}", std::process::id())
    }
    #[test]
    fn current_user_identity_and_bounded_roundtrip() {
        assert!(process_is_current_user(std::process::id()));
        assert!(!process_is_current_user(0));
        assert!(pipe_sddl().unwrap().starts_with("D:P(A;;GA;;;S-1-"));
        let spawner = crate::spawn::ThreadSpawner;
        let inbox = Arc::new(Inbox::default());
        let name = name("roundtrip");
        let server = LocalControl.serve(&spawner, &name, inbox.clone()).unwrap();
        let client = LocalControl
            .request(&spawner, &name, b"{\"id\":1,\"op\":\"hello\"}".to_vec())
            .unwrap();
        let end = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(request) = inbox.pop() {
                assert!(!request.is_cancelled());
                request
                    .respond(b"{\"id\":1,\"ok\":true}\n".to_vec())
                    .unwrap();
                break;
            }
            assert!(Instant::now() < end);
            std::thread::sleep(Duration::from_millis(1));
        }
        loop {
            if let Some(reply) = client.take() {
                assert_eq!(reply.unwrap(), b"{\"id\":1,\"ok\":true}");
                break;
            }
            assert!(Instant::now() < end);
            std::thread::sleep(Duration::from_millis(1));
        }
        server.cancel();
        assert!(
            LocalControl
                .request(&spawner, &name, vec![0; MAX_REQUEST + 1])
                .is_err()
        );
    }
    #[test]
    fn cancelling_a_silent_host_wakes_the_client() {
        let spawner = crate::spawn::ThreadSpawner;
        let inbox = Arc::new(Inbox::default());
        let name = name("cancel");
        let server = LocalControl.serve(&spawner, &name, inbox).unwrap();
        let client = LocalControl
            .request(&spawner, &name, b"{}".to_vec())
            .unwrap();
        client.cancel.cancel();
        server.cancel();
        let end = Instant::now() + Duration::from_secs(1);
        loop {
            if let Some(reply) = client.take() {
                assert!(reply.is_err());
                break;
            }
            assert!(Instant::now() < end);
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    #[test]
    fn the_actual_pipe_acl_is_current_user_only() {
        use windows_sys::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SE_KERNEL_OBJECT,
        };
        use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
        let name = name("acl");
        let pipe = create_instance(
            &endpoint(&name).unwrap(),
            &wide(&pipe_sddl().unwrap()),
            true,
        )
        .unwrap();
        let actual = unsafe {
            let mut descriptor = std::ptr::null_mut();
            assert_eq!(
                GetSecurityInfo(
                    pipe.raw(),
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut descriptor
                ),
                0
            );
            let mut string = std::ptr::null_mut();
            assert_ne!(
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut string,
                    std::ptr::null_mut()
                ),
                0
            );
            let len = (0..).take_while(|i| *string.add(*i) != 0).count();
            let result = String::from_utf16_lossy(std::slice::from_raw_parts(string, len));
            LocalFree(string.cast());
            LocalFree(descriptor);
            result
        };
        assert_eq!(actual, pipe_sddl().unwrap().replace(";GA;", ";FA;"));
    }
    #[test]
    fn the_client_only_allows_identification_impersonation() {
        use windows_sys::Win32::Security::{
            GetTokenInformation, RevertToSelf, TOKEN_QUERY, TokenImpersonationLevel,
        };
        use windows_sys::Win32::System::Pipes::ImpersonateNamedPipeClient;
        use windows_sys::Win32::System::Threading::{GetCurrentThread, OpenThreadToken};
        let name = endpoint(&name("sqos")).unwrap();
        let pipe = create_instance(&name, &wide(&pipe_sddl().unwrap()), true).unwrap();
        let level = std::thread::scope(|scope| {
            let server = scope.spawn(|| {
                let deadline = Instant::now() + DEADLINE;
                unsafe {
                    overlapped_io(pipe.raw(), deadline, None, |ov| {
                        (ConnectNamedPipe(pipe.raw(), ov), GetLastError())
                    })
                }
                .unwrap();
                let mut byte = [0];
                read_exact(pipe.raw(), &mut byte, deadline, None).unwrap();
                unsafe {
                    assert_ne!(ImpersonateNamedPipeClient(pipe.raw()), 0);
                    let mut token = std::ptr::null_mut();
                    assert_ne!(
                        OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token),
                        0
                    );
                    let token = Owned(token);
                    let mut level = 99u32;
                    let mut size = 0;
                    assert_ne!(
                        GetTokenInformation(
                            token.0,
                            TokenImpersonationLevel,
                            (&mut level as *mut u32).cast(),
                            4,
                            &mut size
                        ),
                        0
                    );
                    assert_ne!(RevertToSelf(), 0);
                    level
                }
            });
            let client = connect(&name).unwrap();
            write_all(client.raw(), b"x", Instant::now() + DEADLINE, None).unwrap();
            server.join().unwrap()
        });
        assert!(level <= 1, "server received impersonation level {level}");
    }
    #[test]
    fn cancellation_wakes_accept_partial_read_and_blocked_write() {
        for mode in ["accept", "read", "write"] {
            let name = name(mode);
            let inbox = Arc::new(Inbox::default());
            let server = LocalControl
                .serve(&crate::spawn::ThreadSpawner, &name, inbox.clone())
                .unwrap();
            let client = if mode == "accept" {
                None
            } else {
                Some(connect(&endpoint(&name).unwrap()).unwrap())
            };
            if let Some(client) = &client {
                write_all(
                    client.raw(),
                    if mode == "write" { b"{}\n" } else { b"{" },
                    Instant::now() + DEADLINE,
                    None,
                )
                .unwrap();
            }
            if mode == "write" {
                let end = Instant::now() + DEADLINE;
                loop {
                    if let Some(request) = inbox.pop() {
                        request.respond(vec![b'x'; MAX_RESPONSE]).unwrap();
                        break;
                    }
                    assert!(Instant::now() < end);
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
            server.cancel();
            let end = Instant::now() + Duration::from_secs(1);
            loop {
                if server.is_finished() {
                    break;
                }
                assert!(Instant::now() < end, "cancel did not close {mode}");
                std::thread::sleep(Duration::from_millis(1));
            }
            drop(client);
        }
    }
}
