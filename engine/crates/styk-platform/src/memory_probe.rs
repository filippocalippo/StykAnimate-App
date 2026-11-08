//! Opt-in process address-space evidence. No heap locks, page touching or residency changes.
use styk_services::diagnostics::{MemoryDiagnostics, MemoryReport};

static ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
struct Admission;
impl Drop for Admission {
    fn drop(&mut self) {
        ACTIVE.store(false, std::sync::atomic::Ordering::Release);
    }
}
impl MemoryDiagnostics for super::NativeDiagnostics {
    fn memory(
        &self,
        complete: Box<dyn FnOnce(Result<MemoryReport, String>) + Send>,
    ) -> Result<(), String> {
        if ACTIVE
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Relaxed,
            )
            .is_err()
        {
            return Err("memory probe busy".into());
        }
        let admission = Admission;
        super::spawn(move || {
            let result = collect();
            drop(admission);
            complete(result);
        })
    }
}

#[cfg(not(windows))]
fn collect() -> Result<MemoryReport, String> {
    Err("memory diagnostics unavailable on this platform".into())
}

#[cfg(windows)]
fn collect() -> Result<MemoryReport, String> {
    windows_probe::collect(styk_services::diagnostics::MEMORY_REGIONS)
}

#[cfg(windows)]
mod windows_probe {
    use super::*;
    use std::collections::BTreeMap;
    use std::mem::{size_of, zeroed};
    use styk_services::diagnostics::{MEMORY_GROUPS, MemoryGroup, VideoMemory};
    use windows::Win32::Graphics::Dxgi::*;
    use windows::core::Interface;
    use windows_sys::Win32::System::Memory::*;
    use windows_sys::Win32::System::ProcessStatus::K32GetMappedFileNameW;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    pub(super) fn collect(limit: usize) -> Result<MemoryReport, String> {
        let mut report = MemoryReport {
            private_before: crate::diagnostics::private_bytes(None) as u64,
            ..Default::default()
        };
        report.limitations.push("Heap roots identify only their own allocation, not all heap segments; Rust System shares the process heap with foreign code. Anonymous allocation owners are unknown.".into());
        report.limitations.push("Image/mapped committed bytes are separate from MEM_PRIVATE; writable is not proof of private copy-on-write. DXGI usage overlaps GPU accounting and is not additive to process private. Residency unavailable without resource handles. Snapshot is non-atomic.".into());
        // SAFETY: fixed-size buffers and documented query APIs; no queried address is dereferenced.
        unsafe {
            let mut handles = [std::ptr::null_mut(); 1024];
            let count = GetProcessHeaps(handles.len() as u32, handles.as_mut_ptr()) as usize;
            if count == 0 {
                return Err("GetProcessHeaps failed".into());
            }
            report.truncated |= count > handles.len();
            let default_heap = GetProcessHeap();
            let mut heaps = BTreeMap::new();
            for &handle in handles.iter().take(count.min(handles.len())) {
                let mut info: MEMORY_BASIC_INFORMATION = zeroed();
                if VirtualQuery(handle, &mut info, size_of::<MEMORY_BASIC_INFORMATION>()) != 0 {
                    heaps.insert(info.AllocationBase as usize, handle == default_heap);
                }
            }
            let (stacks, incomplete) = super::stacks::bases();
            report.truncated |= incomplete;
            if incomplete {
                report
                    .limitations
                    .push("Thread enumeration or stack queries incomplete".into());
            }
            let mut groups = BTreeMap::<usize, MemoryGroup>::new();
            let mut address = 0usize;
            let mut ended = false;
            for _ in 0..limit.min(styk_services::diagnostics::MEMORY_REGIONS) {
                let mut info: MEMORY_BASIC_INFORMATION = zeroed();
                if VirtualQuery(
                    address as _,
                    &mut info,
                    size_of::<MEMORY_BASIC_INFORMATION>(),
                ) == 0
                {
                    let code = windows_sys::Win32::Foundation::GetLastError();
                    ended = code == windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
                    if !ended {
                        report
                            .limitations
                            .push(format!("VirtualQuery failed: {code}"));
                    }
                    break;
                }
                report.regions += 1;
                if info.State == MEM_COMMIT {
                    let base = info.AllocationBase as usize;
                    if !groups.contains_key(&base) && groups.len() == MEMORY_GROUPS {
                        report.truncated = true;
                        break;
                    }
                    let kind = match info.Type {
                        MEM_IMAGE => "image",
                        MEM_MAPPED => "mapped",
                        MEM_PRIVATE if stacks.contains(&base) => "thread_stack",
                        MEM_PRIVATE => match heaps.get(&base) {
                            Some(true) => "process_heap_root",
                            Some(false) => "other_heap_root",
                            None => "private_unknown",
                        },
                        _ => "other",
                    };
                    let group = groups.entry(base).or_insert_with(|| {
                        let mut name = [0u16; 512];
                        let n = if info.Type == MEM_IMAGE || info.Type == MEM_MAPPED {
                            K32GetMappedFileNameW(
                                GetCurrentProcess(),
                                info.BaseAddress,
                                name.as_mut_ptr(),
                                name.len() as u32,
                            ) as usize
                        } else {
                            0
                        };
                        // Basename only: never include private project paths in reports.
                        let module = (n > 0).then(|| {
                            String::from_utf16_lossy(&name[..n.min(name.len())])
                                .rsplit('\\')
                                .next()
                                .unwrap_or("")
                                .to_owned()
                        });
                        MemoryGroup {
                            allocation_base: base as u64,
                            kind,
                            module: if info.Type == MEM_IMAGE { module } else { None },
                            committed: 0,
                            writable: 0,
                        }
                    });
                    group.committed += info.RegionSize as u64;
                    if info.Protect
                        & (PAGE_READWRITE
                            | PAGE_WRITECOPY
                            | PAGE_EXECUTE_READWRITE
                            | PAGE_EXECUTE_WRITECOPY)
                        != 0
                    {
                        group.writable += info.RegionSize as u64;
                    }
                }
                match (info.BaseAddress as usize).checked_add(info.RegionSize) {
                    Some(next) if next > address => address = next,
                    _ => {
                        ended = true;
                        break;
                    }
                }
            }
            report.truncated |= !ended;
            report.groups = groups.into_values().collect();
            match CreateDXGIFactory1::<IDXGIFactory1>() {
                Ok(factory) => {
                    for index in 0..16 {
                        let adapter = match factory.EnumAdapters1(index) {
                            Ok(a) => a,
                            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                            Err(e) => {
                                report.truncated = true;
                                report.limitations.push(format!("EnumAdapters1: {e}"));
                                break;
                            }
                        };
                        let name = adapter
                            .GetDesc1()
                            .map(|d| {
                                String::from_utf16_lossy(&d.Description)
                                    .trim_end_matches('\0')
                                    .to_owned()
                            })
                            .unwrap_or_else(|_| "unknown".into());
                        match adapter.cast::<IDXGIAdapter3>() {
                            Ok(adapter) => {
                                for (segment, label) in [
                                    (DXGI_MEMORY_SEGMENT_GROUP_LOCAL, "local"),
                                    (DXGI_MEMORY_SEGMENT_GROUP_NON_LOCAL, "non_local"),
                                ] {
                                    let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
                                    match adapter.QueryVideoMemoryInfo(0, segment, &mut info) {
                                        Ok(()) => report.video.push(VideoMemory {
                                            adapter: name.clone(),
                                            segment: label,
                                            budget: info.Budget,
                                            usage: info.CurrentUsage,
                                            reservation: info.CurrentReservation,
                                        }),
                                        Err(e) => {
                                            report.limitations.push(format!("DXGI {label}: {e}"))
                                        }
                                    }
                                }
                            }
                            Err(e) => report.limitations.push(format!("IDXGIAdapter3: {e}")),
                        }
                        if index == 15 {
                            report.truncated = true;
                        }
                    }
                }
                Err(e) => report.limitations.push(format!("DXGI factory: {e}")),
            }
        }
        report.private_after = crate::diagnostics::private_bytes(None) as u64;
        Ok(report)
    }
    #[test]
    fn known_heap_mapping_and_thread_have_distinct_classes() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        let path = std::env::temp_dir().join(format!("styk-mp-{}.bin", std::process::id()));
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.set_len(65536).unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || {
            let local = 0usize;
            // SAFETY: metadata query for this live stack variable.
            let mut info: MEMORY_BASIC_INFORMATION = unsafe { zeroed() };
            assert_ne!(
                unsafe {
                    VirtualQuery(
                        (&local as *const usize).cast(),
                        &mut info,
                        size_of::<MEMORY_BASIC_INFORMATION>(),
                    )
                },
                0
            );
            tx.send(info.AllocationBase as u64).unwrap();
            done_rx.recv().unwrap();
        });
        let stack = rx.recv().unwrap();
        // SAFETY: test owns the heap, mapping and view until after collection.
        unsafe {
            let heap = HeapCreate(0, 65536, 0);
            assert!(!heap.is_null());
            let block = HeapAlloc(heap, 0, 256);
            assert!(!block.is_null());
            let mapping = CreateFileMappingW(
                file.as_raw_handle(),
                std::ptr::null(),
                PAGE_READWRITE,
                0,
                65536,
                std::ptr::null(),
            );
            assert!(!mapping.is_null());
            let view = MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, 65536);
            assert!(!view.Value.is_null());
            let result = collect(styk_services::diagnostics::MEMORY_REGIONS).unwrap();
            assert_eq!(
                result
                    .groups
                    .iter()
                    .find(|g| g.allocation_base == stack)
                    .unwrap()
                    .kind,
                "thread_stack"
            );
            assert_eq!(
                result
                    .groups
                    .iter()
                    .find(|g| g.allocation_base == view.Value as u64)
                    .unwrap()
                    .kind,
                "mapped"
            );
            let mut info: MEMORY_BASIC_INFORMATION = zeroed();
            assert_ne!(
                VirtualQuery(block, &mut info, size_of::<MEMORY_BASIC_INFORMATION>()),
                0
            );
            assert_eq!(
                result
                    .groups
                    .iter()
                    .find(|g| g.allocation_base == info.AllocationBase as u64)
                    .unwrap()
                    .kind,
                "other_heap_root"
            );
            assert_ne!(HeapFree(heap, 0, block), 0);
            assert_ne!(HeapDestroy(heap), 0);
            assert_ne!(UnmapViewOfFile(view), 0);
            assert_ne!(CloseHandle(mapping), 0);
        }
        done_tx.send(()).unwrap();
        thread.join().unwrap();
        drop(file);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn walk_is_bounded_and_observes_private_allocation() {
        // SAFETY: owned allocation released after the query; no address-space dereferences.
        unsafe {
            let block = VirtualAlloc(
                std::ptr::null(),
                2 * 1024 * 1024,
                MEM_COMMIT | MEM_RESERVE,
                PAGE_READWRITE,
            );
            assert!(!block.is_null());
            let result = collect(styk_services::diagnostics::MEMORY_REGIONS).unwrap();
            let group = result
                .groups
                .iter()
                .find(|g| g.allocation_base == block as u64)
                .unwrap();
            assert_eq!(group.kind, "private_unknown");
            assert_eq!(group.committed, 2 * 1024 * 1024);
            assert_ne!(VirtualFree(block, 0, MEM_RELEASE), 0);
            let bounded = collect(1).unwrap();
            assert_eq!(bounded.regions, 1);
            assert!(bounded.truncated);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_completes_on_worker() {
        let caller = std::thread::current().id();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        super::super::NativeDiagnostics
            .memory(Box::new(move |r| {
                tx.send((std::thread::current().id(), r)).unwrap()
            }))
            .unwrap();
        let (worker, result) = rx.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
        assert_ne!(caller, worker);
        assert!(result.is_ok());
    }
}

#[cfg(windows)]
mod stacks {
    use std::{
        collections::BTreeSet,
        mem::{size_of, zeroed},
    };
    use windows_sys::Win32::{
        Foundation::*,
        System::{
            Diagnostics::{Debug::ReadProcessMemory, ToolHelp::*},
            Memory::*,
            Threading::*,
        },
    };
    #[repr(C)]
    struct Basic {
        status: i32,
        teb: *const core::ffi::c_void,
        process: usize,
        thread: usize,
        affinity: usize,
        priority: i32,
        base_priority: i32,
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQueryInformationThread(
            handle: HANDLE,
            class: u32,
            data: *mut Basic,
            size: u32,
            returned: *mut u32,
        ) -> i32;
    }
    pub(super) fn bases() -> (BTreeSet<usize>, bool) {
        let mut bases = BTreeSet::new();
        // SAFETY: snapshot and thread handles are owned locally and closed on every path.
        // TEB fields are copied with ReadProcessMemory, never dereferenced; exit races fail the query.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return (bases, true);
            }
            let mut entry: THREADENTRY32 = zeroed();
            entry.dwSize = size_of::<THREADENTRY32>() as u32;
            let mut more = Thread32First(snapshot, &mut entry) != 0;
            let mut count = 0;
            let mut incomplete = !more && GetLastError() != ERROR_NO_MORE_FILES;
            while more && count < 4096 {
                count += 1;
                if entry.th32OwnerProcessID == GetCurrentProcessId() {
                    let thread = OpenThread(THREAD_QUERY_INFORMATION, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        let mut basic: Basic = zeroed();
                        let mut tib = [0usize; 3]; // ExceptionList, StackBase, StackLimit (NT_TIB).
                        let mut read = 0;
                        if NtQueryInformationThread(
                            thread,
                            0,
                            &mut basic,
                            size_of::<Basic>() as u32,
                            std::ptr::null_mut(),
                        ) >= 0
                            && basic.process == GetCurrentProcessId() as usize
                            && ReadProcessMemory(
                                GetCurrentProcess(),
                                basic.teb,
                                tib.as_mut_ptr().cast(),
                                size_of_val(&tib),
                                &mut read,
                            ) != 0
                            && read == size_of_val(&tib)
                            && tib[1] > 0
                        {
                            let mut info: MEMORY_BASIC_INFORMATION = zeroed();
                            if VirtualQuery(
                                (tib[1] - 1) as _,
                                &mut info,
                                size_of::<MEMORY_BASIC_INFORMATION>(),
                            ) != 0
                            {
                                bases.insert(info.AllocationBase as usize);
                            } else {
                                incomplete = true;
                            }
                        } else {
                            incomplete = true;
                        }
                        CloseHandle(thread);
                    } else {
                        incomplete = true;
                    }
                }
                more = Thread32Next(snapshot, &mut entry) != 0;
                if !more && GetLastError() != ERROR_NO_MORE_FILES {
                    incomplete = true;
                }
            }
            CloseHandle(snapshot);
            (bases, incomplete || more)
        }
    }
}
