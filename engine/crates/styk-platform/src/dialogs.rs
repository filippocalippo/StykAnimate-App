//! Window-lifetime registration and thread-owned native file pickers.
//! No application HWND crosses into the modal worker. Its dialog is created and destroyed on that worker; the app's subclass only invalidates a token.
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use styk_services::{Spawner, dialogs::{Choice, Completion, Dialogs, Filter, Request}, files::FileTarget};
use std::sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}};
use windows_sys::Win32::{Foundation::HWND, UI::{Shell::*, WindowsAndMessaging::*}};

#[derive(Default)]
struct Lifetime { gone: AtomicBool, epoch: AtomicU64 }
impl Lifetime {
    fn cancel(&self) { self.epoch.fetch_add(1, Ordering::Release); }
    fn destroy(&self) { self.gone.store(true, Ordering::Release); self.cancel(); }
    fn begin(self: &Arc<Self>) -> Result<Run, String> {
        let run = Run { owner: self.clone(), epoch: self.epoch.load(Ordering::Acquire) };
        if run.cancelled() { Err("the picker owner closed".into()) } else { Ok(run) }
    }
}
struct Run { owner: Arc<Lifetime>, epoch: u64 }
impl Run {
    fn cancelled(&self) -> bool { self.owner.gone.load(Ordering::Acquire) || self.owner.epoch.load(Ordering::Acquire) != self.epoch }
    fn finish(&self, result: Result<Choice, String>) -> Result<Choice, String> {
        if self.cancelled() { Ok(Choice::File(None)) } else { result }
    }
}

const SUBCLASS: usize = crate::input::windows::subclass_id::DIALOGS;
pub struct NativeDialogs { owner: Arc<Lifetime> }
impl NativeDialogs {
    /// Called by window::run on the app window's thread. The subclass retains the
    /// registration even after this short-lived service value has been dropped.
    pub fn new(window: &dyn HasWindowHandle) -> Result<Self, String> {
        let RawWindowHandle::Win32(handle) = window.window_handle().map_err(|e| e.to_string())?.as_raw() else { return Err("native pickers are unavailable on this platform".into()); };
        let hwnd = handle.hwnd.get() as HWND;
        // SAFETY: registration and removal run on the owning window thread; the subclass
        // owns exactly one Arc until WM_NCDESTROY. The worker never receives this HWND.
        unsafe {
            if GetWindowThreadProcessId(hwnd, std::ptr::null_mut()) != windows_sys::Win32::System::Threading::GetCurrentThreadId() { return Err("picker registration requires the window thread".into()); }
            let property = wide("StykAnimate.NativeDialogs.Lifetime");
            let data = GetPropW(hwnd, property.as_ptr()) as usize;
            if data != 0 {
                let owner = &*(data as *const Lifetime);
                if owner.gone.load(Ordering::Acquire) { return Err("the picker owner closed".into()); }
                Arc::increment_strong_count(data as *const Lifetime);
                return Ok(Self { owner: Arc::from_raw(data as *const Lifetime) });
            }
            let owner = Arc::new(Lifetime::default());
            let raw = Arc::into_raw(owner.clone());
            if SetPropW(hwnd, property.as_ptr(), raw as _) == 0 {
                drop(Arc::from_raw(raw)); return Err("could not register the picker owner".into());
            }
            if SetWindowSubclass(hwnd, Some(owner_proc), SUBCLASS, raw as usize) == 0 {
                RemovePropW(hwnd, property.as_ptr());
                drop(Arc::from_raw(raw)); return Err("could not register the picker owner".into());
            }
            Ok(Self { owner })
        }
    }
    /// Quit/session end cancels an existing run without waiting for a modal call.
    pub fn cancel(window: &dyn HasWindowHandle) {
        if let Ok(service) = Self::new(window) { service.owner.cancel(); }
    }
}
unsafe extern "system" fn owner_proc(hwnd: HWND, msg: u32, wp: usize, lp: isize, _: usize, data: usize) -> isize {
    // SAFETY: data is the subclass-owned Arc, removed exactly once at NCDESTROY.
    let owner = unsafe { &*(data as *const Lifetime) };
    if msg == WM_QUERYENDSESSION { owner.cancel(); }
    if msg == WM_DESTROY || msg == WM_NCDESTROY || (msg == WM_ENDSESSION && wp != 0) { owner.destroy(); }
    if msg == WM_NCDESTROY { unsafe { RemoveWindowSubclass(hwnd, Some(owner_proc), SUBCLASS); RemovePropW(hwnd, wide("StykAnimate.NativeDialogs.Lifetime").as_ptr()); drop(Arc::from_raw(data as *const Lifetime)); } }
    unsafe { DefSubclassProc(hwnd, msg, wp, lp) }
}
impl Dialogs for NativeDialogs {
    fn choose(&self, request: Request, complete: Completion) -> Result<(), String> {
        if crate::unattended::requested_by_environment()?.is_some() { return Err("native pickers are disabled in unattended runs".into()); }
        let run = self.owner.begin()?;
        crate::spawn::ThreadSpawner.spawn("styk-picker", Box::new(move || complete(run.finish(choose(&run, request))))).map_err(|e| e.to_string())
    }
}

fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }
fn filters(filters: &[Filter]) -> Vec<u16> {
    let mut out = Vec::new();
    for filter in filters {
        out.extend(wide(&filter.label));
        out.extend(wide(&filter.extensions.iter().map(|ext| format!("*.{ext}")).collect::<Vec<_>>().join(";")));
    }
    out.push(0); out
}
const CANCEL_TIMER: usize = 1;
unsafe extern "system" fn dialog_hook(hwnd: HWND, msg: u32, _: usize, lp: isize) -> usize {
    use windows_sys::Win32::UI::Controls::Dialogs::OPENFILENAMEW;
    // SAFETY: the modal call retains both OPENFILENAME and Run until this hook ends.
    unsafe {
        if msg == WM_INITDIALOG {
            let open = &*(lp as *const OPENFILENAMEW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, open.lCustData);
            // Modal dialogs pump their own messages. Cancellation is observed on their
            // own thread, even when the application's event loop has already quit.
            if SetTimer(hwnd, CANCEL_TIMER, 50, None) == 0 { PostMessageW(GetParent(hwnd), WM_COMMAND, 2, 0); }
        }
        if msg == WM_INITDIALOG || msg == WM_TIMER {
            let run = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Run;
            if !run.is_null() && (*run).cancelled() {
                PostMessageW(GetParent(hwnd), WM_COMMAND, 2 /* IDCANCEL */, 0);
            }
        }
        if msg == WM_DESTROY { KillTimer(hwnd, CANCEL_TIMER); }
    }
    0
}

fn choose(run: &Run, request: Request) -> Result<Choice, String> {
    use windows_sys::Win32::UI::Controls::Dialogs::*;
    use std::os::windows::ffi::OsStringExt;
    if run.cancelled() { return Ok(Choice::File(None)); }
    let (title, name, save, choices) = match request {
        Request::Open { title, filters } => (title, String::new(), false, filters),
        Request::Save { title, name, filter } => (title, std::path::Path::new(&name).with_extension("styk").to_string_lossy().into_owned(), true, vec![filter]),
    };
    let mut file = vec![0u16; 32768]; let initial = wide(&name);
    if initial.len() > file.len() { return Err("the suggested name exceeds the native path limit".into()); }
    file[..initial.len()].copy_from_slice(&initial);
    let title = wide(&title); let extension = wide("styk"); let filter = filters(&choices);
    // SAFETY: this thread owns the modal window and every buffer for its entire lifetime.
    // hwndOwner is intentionally null: no detached thread may retain the app's HWND.
    unsafe {
        let mut value: OPENFILENAMEW = std::mem::zeroed();
        value.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        value.lpstrFilter = filter.as_ptr(); value.lpstrFile = file.as_mut_ptr(); value.nMaxFile = file.len() as u32;
        value.lpstrTitle = title.as_ptr(); value.lpstrDefExt = extension.as_ptr();
        value.lpfnHook = Some(dialog_hook); value.lCustData = run as *const Run as isize;
        value.Flags = OFN_ENABLEHOOK | OFN_EXPLORER | OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST | if save { OFN_OVERWRITEPROMPT } else { OFN_FILEMUSTEXIST };
        let accepted = if save { GetSaveFileNameW(&mut value) } else { GetOpenFileNameW(&mut value) };
        if accepted == 0 {
            let error = CommDlgExtendedError();
            return if error == 0 { Ok(Choice::File(None)) } else { Err(format!("file picker failed: {error}")) };
        }
        let end = file.iter().position(|unit| *unit == 0).unwrap_or(file.len());
        Ok(Choice::File(Some(FileTarget::new(std::ffi::OsString::from_wide(&file[..end])))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owner_destruction_refuses_new_runs_and_discards_late_results() {
        let owner = Arc::new(Lifetime::default()); let run = owner.begin().unwrap();
        owner.destroy(); assert!(run.cancelled()); assert!(owner.begin().is_err());
        assert_eq!(run.finish(Ok(Choice::File(Some(FileTarget::new("late.styk"))))), Ok(Choice::File(None)));
    }
    #[test]
    fn session_end_cancels_without_waiting_and_a_veto_allows_a_new_run() {
        let owner = Arc::new(Lifetime::default()); let run = owner.begin().unwrap();
        owner.cancel(); assert!(run.cancelled()); assert!(!owner.begin().unwrap().cancelled());
    }
    #[test]
    fn registered_owner_messages_cancel_and_destroy_its_picker_runs() {
        struct Window(HWND);
        impl HasWindowHandle for Window {
            fn window_handle(&self) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
                let handle = raw_window_handle::Win32WindowHandle::new(std::num::NonZeroIsize::new(self.0 as isize).unwrap());
                // SAFETY: this message-only window is created and destroyed on the test thread.
                Ok(unsafe { raw_window_handle::WindowHandle::borrow_raw(RawWindowHandle::Win32(handle)) })
            }
        }
        let class = wide("STATIC");
        // A message-only window is never shown, activated or sent any input.
        let hwnd = unsafe { CreateWindowExW(0, class.as_ptr(), std::ptr::null(), 0, 0, 0, 0, 0, HWND_MESSAGE, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null()) };
        assert!(!hwnd.is_null());
        let owner = NativeDialogs::new(&Window(hwnd)).unwrap();
        let first = owner.owner.begin().unwrap();
        unsafe { SendMessageW(hwnd, WM_QUERYENDSESSION, 0, 0); }
        assert!(first.cancelled());
        let second = owner.owner.begin().unwrap();
        NativeDialogs::cancel(&Window(hwnd)); assert!(second.cancelled());
        let last = owner.owner.begin().unwrap();
        assert_ne!(unsafe { DestroyWindow(hwnd) }, 0);
        assert!(last.cancelled()); assert!(owner.owner.begin().is_err());
    }

    #[test]
    fn native_filter_preserves_labels_extensions_and_double_terminator() {
        assert_eq!(filters(&[Filter { label: "Figure Pivot".into(), extensions: vec!["stk".into(), "stkz".into()] }]), wide("Figure Pivot\0*.stk;*.stkz\0"));
    }
}
