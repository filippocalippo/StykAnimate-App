//! The window-owned Windows pickers. Only their worker may enter a modal OS call.
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use styk_services::{Spawner, dialogs::{Choice, Completion, Dialogs, Request}, files::FileTarget};

pub struct NativeDialogs { owner: isize }
impl NativeDialogs {
    pub fn new(window: &dyn HasWindowHandle) -> Result<Self, String> {
        match window.window_handle().map_err(|error| error.to_string())?.as_raw() {
            RawWindowHandle::Win32(handle) => Ok(Self { owner: handle.hwnd.get() }),
            _ => Err("native pickers are unavailable on this platform".into()),
        }
    }
}
impl Dialogs for NativeDialogs {
    fn choose(&self, request: Request, complete: Completion) -> Result<(), String> {
        // An unattended run must supply its choices at the service boundary; never show a desktop dialog.
        if crate::unattended::requested_by_environment()?.is_some() { return Err("native pickers are disabled in unattended runs".into()); }
        let owner = self.owner;
        crate::spawn::ThreadSpawner.spawn("styk-picker", Box::new(move || complete(choose(owner, request)))).map_err(|error| error.to_string())
    }
}

fn choose(owner: isize, request: Request) -> Result<Choice, String> {
    use windows_sys::Win32::UI::Controls::Dialogs::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
    use std::os::windows::ffi::OsStringExt;
    let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    // SAFETY: the owner is this process's live app window. All buffers outlive their modal call.
    unsafe {
        let owner = owner as windows_sys::Win32::Foundation::HWND;
        if IsWindow(owner) == 0 { return Err("the picker owner closed".into()); }
        if let Request::Color { initial } = request {
            let mut custom = [0u32; 16];
            let mut value: CHOOSECOLORW = std::mem::zeroed();
            value.lStructSize = std::mem::size_of::<CHOOSECOLORW>() as u32;
            value.hwndOwner = owner;
            value.rgbResult = u32::from(initial[0]) | u32::from(initial[1]) << 8 | u32::from(initial[2]) << 16;
            value.lpCustColors = custom.as_mut_ptr(); value.Flags = CC_FULLOPEN | CC_RGBINIT;
            return if ChooseColorW(&mut value) != 0 {
                Ok(Choice::Color(Some([value.rgbResult as u8, (value.rgbResult >> 8) as u8, (value.rgbResult >> 16) as u8])))
            } else if CommDlgExtendedError() == 0 { Ok(Choice::Color(None)) } else { Err(format!("colour picker failed: {}", CommDlgExtendedError())) };
        }
        let (title, name, save) = match request { Request::Open { title } => (title, String::new(), false), Request::Save { title, name } => (title, std::path::Path::new(&name).with_extension("styk").to_string_lossy().into_owned(), true), Request::Color { .. } => unreachable!() };
        let mut file = vec![0u16; 32768];
        let initial = wide(&name);
        if initial.len() > file.len() { return Err("the suggested name exceeds the native path limit".into()); }
        file[..initial.len()].copy_from_slice(&initial);
        let title = wide(&title); let extension = wide("styk");
        let filter = wide(if save { "StykAnimate\0*.styk\0" } else { "StykAnimate / Pivot\0*.styk;*.piv;*.json\0" });
        let mut value: OPENFILENAMEW = std::mem::zeroed();
        value.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32; value.hwndOwner = owner;
        value.lpstrFilter = filter.as_ptr(); value.lpstrFile = file.as_mut_ptr(); value.nMaxFile = file.len() as u32;
        value.lpstrTitle = title.as_ptr(); value.lpstrDefExt = extension.as_ptr();
        value.Flags = OFN_EXPLORER | OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST | if save { OFN_OVERWRITEPROMPT } else { OFN_FILEMUSTEXIST };
        let accepted = if save { GetSaveFileNameW(&mut value) } else { GetOpenFileNameW(&mut value) };
        if accepted == 0 {
            let error = CommDlgExtendedError();
            return if error == 0 { Ok(Choice::File(None)) } else { Err(format!("file picker failed: {error}")) };
        }
        let end = file.iter().position(|unit| *unit == 0).unwrap_or(file.len());
        Ok(Choice::File(Some(FileTarget::new(std::ffi::OsString::from_wide(&file[..end])))))
    }
}
