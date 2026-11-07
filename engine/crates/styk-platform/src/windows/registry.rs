//! The Windows registry, for the file associations and the link.
//!
//! A [`WindowsRegistry`] applies the changes of `styk_services::shell::associations` under one hive and one prefix.
//! Production uses the hive with no prefix (`Software\Classes\...`); tests and the upgrade proof use a sandbox prefix,
//! `HKCU\Software\StykAnimateSandbox\<id>\`, so nothing outside that key is ever touched.

use super::wide;
use styk_services::shell::associations::{RegOp, Registry, Value};
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY, KEY_WRITE, REG_NONE, REG_OPTION_NON_VOLATILE, REG_SZ, RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegDeleteValueW, RegOpenKeyExW,
    RegQueryValueExW, RegSetValueExW,
};
use windows_sys::Win32::UI::Shell::SHChangeNotify;

/// The key all sandboxes live under, in the current user's hive.
pub const SANDBOX_ROOT: &str = "Software\\StykAnimateSandbox";

/// Which hive a registration goes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hive {
    /// The current user (a current-user install, and the link at a packaged start).
    CurrentUser,
    /// The machine (an all-users install).
    LocalMachine,
}

/// A registry root: a hive and a prefix.
#[derive(Clone, Debug)]
pub struct WindowsRegistry {
    hive: HKEY,
    prefix: String,
    sandbox: bool,
}

impl WindowsRegistry {
    /// The real registry.
    pub fn production(hive: Hive) -> WindowsRegistry {
        WindowsRegistry { hive: if hive == Hive::CurrentUser { HKEY_CURRENT_USER } else { HKEY_LOCAL_MACHINE }, prefix: String::new(), sandbox: false }
    }

    /// A private root under the current user's `Software\StykAnimateSandbox\<id>`. `id` is letters, digits and `-`.
    pub fn sandbox(id: &str) -> WindowsRegistry {
        assert!(!id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "a sandbox id is letters, digits and dashes");
        WindowsRegistry { hive: HKEY_CURRENT_USER, prefix: format!("{SANDBOX_ROOT}\\{id}\\"), sandbox: true }
    }

    fn path(&self, key: &str) -> Vec<u16> {
        wide(&format!("{}{}", self.prefix, key))
    }

    fn create(&self, key: &str) -> Result<HKEY, String> {
        let mut handle: HKEY = std::ptr::null_mut();
        // SAFETY: creates or opens a key under this root; the handle is closed by the caller.
        let status = unsafe { RegCreateKeyExW(self.hive, self.path(key).as_ptr(), 0, std::ptr::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE | KEY_READ | KEY_WOW64_64KEY, std::ptr::null(), &mut handle, std::ptr::null_mut()) };
        if status == ERROR_SUCCESS { Ok(handle) } else { Err(format!("creating {key} failed (error {status})")) }
    }

    fn open(&self, key: &str, access: u32) -> Option<HKEY> {
        let mut handle: HKEY = std::ptr::null_mut();
        // SAFETY: opens a key under this root for reading or writing; the caller closes it.
        let status = unsafe { RegOpenKeyExW(self.hive, self.path(key).as_ptr(), 0, access | KEY_WOW64_64KEY, &mut handle) };
        (status == ERROR_SUCCESS).then_some(handle)
    }

    /// A text value, if the key and the value exist.
    pub fn read_text(&self, key: &str, name: &str) -> Option<String> {
        let handle = self.open(key, KEY_READ)?;
        let name = wide(name);
        let mut size = 0u32;
        let mut kind = 0u32;
        // SAFETY: a size query, then a read into a buffer of that size; the key is closed at the end.
        let text = unsafe {
            let ok = RegQueryValueExW(handle, name.as_ptr(), std::ptr::null(), &mut kind, std::ptr::null_mut(), &mut size) == ERROR_SUCCESS && kind == REG_SZ;
            let mut buffer = vec![0u16; size as usize / 2 + 1];
            let ok = ok && RegQueryValueExW(handle, name.as_ptr(), std::ptr::null(), &mut kind, buffer.as_mut_ptr().cast(), &mut size) == ERROR_SUCCESS;
            ok.then(|| {
                let length = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
                String::from_utf16_lossy(&buffer[..length])
            })
        };
        // SAFETY: closes the key opened above.
        unsafe { RegCloseKey(handle) };
        text
    }

    /// Whether a key exists.
    pub fn key_exists(&self, key: &str) -> bool {
        self.open(key, KEY_READ).map(|handle| {
            // SAFETY: closes the key opened above.
            unsafe { RegCloseKey(handle) };
        }).is_some()
    }

    /// Whether a value (of any type) exists.
    pub fn value_exists(&self, key: &str, name: &str) -> bool {
        let Some(handle) = self.open(key, KEY_READ) else { return false };
        let name = wide(name);
        // SAFETY: a size-and-type query only; the key is closed after.
        let found = unsafe { RegQueryValueExW(handle, name.as_ptr(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) == ERROR_SUCCESS };
        // SAFETY: closes the key opened above.
        unsafe { RegCloseKey(handle) };
        found
    }

    /// Deletes the whole sandbox this root is (never anything else).
    pub fn delete_sandbox(&self) {
        if !self.sandbox {
            return;
        }
        // SAFETY: deletes the sandbox key and everything under it; the prefix was built by `sandbox` and starts with
        // `SANDBOX_ROOT`.
        unsafe { RegDeleteTreeW(self.hive, wide(self.prefix.trim_end_matches('\\')).as_ptr()) };
    }
}

impl Registry for WindowsRegistry {
    fn apply(&mut self, ops: &[RegOp]) -> Result<(), String> {
        for op in ops {
            match op {
                RegOp::Set { key, name, value } => {
                    let handle = self.create(key)?;
                    let name_w = wide(name);
                    let (kind, data): (u32, Vec<u16>) = match value {
                        Value::Text(text) => (REG_SZ, wide(text)),
                        Value::Empty => (REG_NONE, Vec::new()),
                    };
                    // SAFETY: writes `data` (a zero-terminated UTF-16 string, or nothing) into the key just opened.
                    let status = unsafe { RegSetValueExW(handle, if name.is_empty() { std::ptr::null() } else { name_w.as_ptr() }, 0, kind, data.as_ptr().cast(), (data.len() * 2) as u32) };
                    // SAFETY: closes the key opened above.
                    unsafe { RegCloseKey(handle) };
                    if status != ERROR_SUCCESS {
                        return Err(format!("setting {key}\\{name} failed (error {status})"));
                    }
                }
                RegOp::DeleteValue { key, name } => {
                    if let Some(handle) = self.open(key, KEY_WRITE) {
                        // SAFETY: deletes one value of the key just opened (a missing value is not an error here).
                        unsafe {
                            RegDeleteValueW(handle, wide(name).as_ptr());
                            RegCloseKey(handle);
                        }
                    }
                }
                RegOp::DeleteKey { key } => {
                    // SAFETY: deletes the key and its subkeys under this root (a missing key is not an error here).
                    unsafe { RegDeleteTreeW(self.hive, self.path(key).as_ptr()) };
                }
            }
        }
        Ok(())
    }
}

/// Tells Explorer the file associations changed (production roots only).
pub fn notify_associations_changed() {
    const SHCNE_ASSOCCHANGED: i32 = 0x0800_0000;
    // SAFETY: a notification with no item.
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, 0, std::ptr::null(), std::ptr::null()) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use styk_services::shell::associations::{ASSOCIATIONS, file_type_ops, file_type_removal_ops, protocol_ops, protocol_removal_ops};

    struct Sandbox(WindowsRegistry);

    impl Sandbox {
        fn new(tag: &str) -> Sandbox {
            let registry = WindowsRegistry::sandbox(&format!("{tag}-{}", std::process::id()));
            registry.delete_sandbox();
            Sandbox(registry)
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            self.0.delete_sandbox();
        }
    }

    const EXE: &str = "C:\\Sandbox\\StykAnimate.exe";

    #[test]
    fn registering_writes_every_class_and_unregistering_leaves_only_what_the_uninstaller_leaves() {
        let mut sandbox = Sandbox::new("assoc");
        let registry = &mut sandbox.0;
        registry.apply(&file_type_ops(EXE)).unwrap();
        registry.apply(&protocol_ops(EXE)).unwrap();
        for item in ASSOCIATIONS {
            assert_eq!(registry.read_text(&format!("Software\\Classes\\.{}", item.ext), "").as_deref(), Some(item.prog_id), ".{}", item.ext);
            assert!(registry.value_exists(&format!("Software\\Classes\\.{}\\OpenWithProgids", item.ext), item.prog_id));
            assert_eq!(registry.read_text(&format!("Software\\Classes\\{}\\shell\\open\\command", item.prog_id), "").as_deref(), Some("\"C:\\Sandbox\\StykAnimate.exe\" \"%1\""));
        }
        assert_eq!(registry.read_text("Software\\Classes\\stykanimate", "URL Protocol").as_deref(), Some(""));
        assert_eq!(registry.read_text("Software\\Classes\\stykanimate\\shell\\open\\command", "").as_deref(), Some("\"C:\\Sandbox\\StykAnimate.exe\" \"%1\""));

        registry.apply(&file_type_removal_ops()).unwrap();
        registry.apply(&protocol_removal_ops()).unwrap();
        assert!(!registry.key_exists("Software\\Classes\\Pivot animation"));
        assert!(!registry.value_exists("Software\\Classes\\.piv\\OpenWithProgids", "Pivot animation"));
        assert!(!registry.key_exists("Software\\Classes\\stykanimate"));
        assert_eq!(registry.read_text("Software\\Classes\\.piv", "").as_deref(), Some("Pivot animation"), "the extension's default stays, as the uninstaller leaves it");
    }

    #[test]
    fn registering_twice_is_the_same_as_once() {
        let mut sandbox = Sandbox::new("twice");
        sandbox.0.apply(&file_type_ops(EXE)).unwrap();
        sandbox.0.apply(&file_type_ops(EXE)).unwrap();
        assert_eq!(sandbox.0.read_text("Software\\Classes\\.styk", "").as_deref(), Some("StykAnimate project"));
    }

    #[test]
    fn deleting_a_sandbox_leaves_no_trace_and_a_production_root_refuses_to_delete() {
        let sandbox = Sandbox::new("gone");
        let mut copy = sandbox.0.clone();
        copy.apply(&protocol_ops(EXE)).unwrap();
        assert!(copy.key_exists("Software\\Classes\\stykanimate"));
        copy.delete_sandbox();
        assert!(!copy.key_exists("Software\\Classes\\stykanimate"));
        let real = WindowsRegistry::production(Hive::CurrentUser);
        real.delete_sandbox(); // a no-op: only a sandbox deletes itself
        assert!(real.key_exists("Software"), "the real hive is untouched");
        let outside = WindowsRegistry::sandbox("probe");
        assert!(!outside.key_exists("Software\\Classes\\stykanimate"), "and the sandbox does not see the owner's registrations");
    }
}
