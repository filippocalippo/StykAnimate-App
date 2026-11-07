//! The file types and the link the program owns, and the registry layout that claims them.
//!
//! The ProgIDs are today's: electron-builder names each class after the association's `name` in `package.json`
//! (`NsisTarget.js`: `APP_ASSOCIATE ext item.name ...`), so a default a user chose for `.piv` still resolves to a class
//! that exists after the upgrade. All eight formats are written the same way, Viewer-role ones included, as today.

use super::protocol::SCHEME;
use std::collections::BTreeMap;

/// Whether the program edits the format or only views it (`package.json` `role`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// Stick Nodes formats the program imports.
    Viewer,
    /// The program's own and Pivot's formats.
    Editor,
}

/// One file type: extension without the dot, MIME type, ProgID (and friendly name), role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Association {
    /// The extension, lowercase, no dot.
    pub ext: &'static str,
    /// The MIME type.
    pub mime: &'static str,
    /// The ProgID and the class's description.
    pub prog_id: &'static str,
    /// Viewer or editor.
    pub role: Role,
}

/// The eight rows of `package.json` `build.fileAssociations`.
pub const ASSOCIATIONS: [Association; 8] = [
    Association { ext: "nodes", mime: "application/x-sticknodes-figure", prog_id: "Stick Nodes figure", role: Role::Viewer },
    Association { ext: "nodemc", mime: "application/x-sticknodes-movieclip", prog_id: "Stick Nodes movie clip", role: Role::Viewer },
    Association { ext: "stknds", mime: "application/x-sticknodes-project", prog_id: "Stick Nodes project", role: Role::Viewer },
    Association { ext: "piv", mime: "application/x-pivot-animation", prog_id: "Pivot animation", role: Role::Editor },
    Association { ext: "stk", mime: "application/x-pivot-figure", prog_id: "Pivot stick figure", role: Role::Editor },
    Association { ext: "stykmov", mime: "application/vnd.stykanimate.movieclip", prog_id: "StykAnimate movieclip", role: Role::Editor },
    Association { ext: "stkz", mime: "application/vnd.stykanimate.figure", prog_id: "StykAnimate figure", role: Role::Editor },
    Association { ext: "styk", mime: "application/vnd.stykanimate.project", prog_id: "StykAnimate project", role: Role::Editor },
];

/// The application id of the Electron app (`package.json` `appId`), kept so the taskbar, shortcuts and the uninstall
/// entry stay the same thing.
pub const APP_ID: &str = "app.stykanimate.desktop";

/// The uninstall and install-location key name: the v5 UUID electron-builder derives from [`APP_ID`].
pub const APP_GUID: &str = "da89159e-9653-5b0d-96ae-4aeef8dc5497";

/// The product name.
pub const PRODUCT_NAME: &str = "StykAnimate";

/// A registry value to set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    /// A text value (`REG_SZ`).
    Text(String),
    /// A value with no data (`REG_NONE`).
    Empty,
}

/// One change to the registry, under `HKCU` or `HKLM` as the install scope says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegOp {
    /// Creates the key if needed and sets a value (`""` is the key's default value).
    Set {
        /// Key path below the hive.
        key: String,
        /// Value name.
        name: String,
        /// Value.
        value: Value,
    },
    /// Deletes one value.
    DeleteValue {
        /// Key path.
        key: String,
        /// Value name.
        name: String,
    },
    /// Deletes a key and everything under it.
    DeleteKey {
        /// Key path.
        key: String,
    },
}

fn set(key: String, name: &str, value: Value) -> RegOp {
    RegOp::Set { key, name: name.to_string(), value }
}

fn text(value: impl Into<String>) -> Value {
    Value::Text(value.into())
}

/// The registry changes that claim every file type for `exe`, as electron-builder's installer does.
pub fn file_type_ops(exe: &str) -> Vec<RegOp> {
    let mut ops = Vec::new();
    for item in ASSOCIATIONS {
        let ext_key = format!("Software\\Classes\\.{}", item.ext);
        let class = format!("Software\\Classes\\{}", item.prog_id);
        ops.push(set(ext_key.clone(), "", text(item.prog_id)));
        ops.push(set(format!("{ext_key}\\OpenWithProgids"), item.prog_id, Value::Empty));
        ops.push(set(class.clone(), "", text(item.prog_id)));
        ops.push(set(format!("{class}\\DefaultIcon"), "", text(format!("\"{exe},0\""))));
        ops.push(set(format!("{class}\\shell"), "", text("open")));
        ops.push(set(format!("{class}\\shell\\open"), "", text(format!("Open with {PRODUCT_NAME}"))));
        ops.push(set(format!("{class}\\shell\\open\\command"), "", text(format!("\"{exe}\" \"%1\""))));
    }
    ops
}

/// The changes that release the file types, as electron-builder's uninstaller does: the class and the
/// `OpenWithProgids` entry go; the extension's default is left alone.
pub fn file_type_removal_ops() -> Vec<RegOp> {
    let mut ops = Vec::new();
    for item in ASSOCIATIONS {
        ops.push(RegOp::DeleteValue { key: format!("Software\\Classes\\.{}\\OpenWithProgids", item.ext), name: item.prog_id.to_string() });
        ops.push(RegOp::DeleteKey { key: format!("Software\\Classes\\{}", item.prog_id) });
    }
    ops
}

/// The changes that register the `stykanimate://` link for `exe` (Electron's `setAsDefaultProtocolClient`).
pub fn protocol_ops(exe: &str) -> Vec<RegOp> {
    let key = format!("Software\\Classes\\{SCHEME}");
    vec![
        set(key.clone(), "", text(format!("URL:{SCHEME}"))),
        set(key.clone(), "URL Protocol", text("")),
        set(format!("{key}\\DefaultIcon"), "", text(format!("\"{exe}\",0"))),
        set(format!("{key}\\shell\\open\\command"), "", text(format!("\"{exe}\" \"%1\""))),
    ]
}

/// The changes that remove the link's registration.
pub fn protocol_removal_ops() -> Vec<RegOp> {
    vec![RegOp::DeleteKey { key: format!("Software\\Classes\\{SCHEME}") }]
}

/// A registry the ops are applied to.
pub trait Registry {
    /// Applies the changes in order.
    fn apply(&mut self, ops: &[RegOp]) -> Result<(), String>;
}

/// A registry in memory: what the ops would leave behind, for tests.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FakeRegistry {
    /// Key (lowercase path) to its values.
    pub keys: BTreeMap<String, BTreeMap<String, Value>>,
}

impl FakeRegistry {
    /// A value, if set.
    pub fn get(&self, key: &str, name: &str) -> Option<&Value> {
        self.keys.get(&key.to_ascii_lowercase())?.get(name)
    }
}

impl Registry for FakeRegistry {
    fn apply(&mut self, ops: &[RegOp]) -> Result<(), String> {
        for op in ops {
            match op {
                RegOp::Set { key, name, value } => {
                    self.keys.entry(key.to_ascii_lowercase()).or_default().insert(name.clone(), value.clone());
                }
                RegOp::DeleteValue { key, name } => {
                    if let Some(values) = self.keys.get_mut(&key.to_ascii_lowercase()) {
                        values.remove(name);
                    }
                }
                RegOp::DeleteKey { key } => {
                    let prefix = key.to_ascii_lowercase();
                    self.keys.retain(|existing, _| existing != &prefix && !existing.starts_with(&format!("{prefix}\\")));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "C:\\Users\\me\\AppData\\Local\\Programs\\StykAnimate\\StykAnimate.exe";

    #[test]
    fn the_table_is_package_json() {
        let package: Vec<(&str, &str, &str)> = ASSOCIATIONS.iter().map(|a| (a.ext, a.mime, a.prog_id)).collect();
        assert_eq!(package.len(), 8);
        assert!(package.contains(&("piv", "application/x-pivot-animation", "Pivot animation")));
        assert!(package.contains(&("styk", "application/vnd.stykanimate.project", "StykAnimate project")));
        assert_eq!(ASSOCIATIONS.iter().filter(|a| a.role == Role::Viewer).count(), 3);
    }

    #[test]
    fn the_layout_is_electron_builders_for_every_format() {
        let mut registry = FakeRegistry::default();
        registry.apply(&file_type_ops(EXE)).unwrap();
        for item in ASSOCIATIONS {
            let ext = format!("Software\\Classes\\.{}", item.ext);
            assert_eq!(registry.get(&ext, ""), Some(&Value::Text(item.prog_id.into())), "{} default is its class, viewers too", item.ext);
            assert_eq!(registry.get(&format!("{ext}\\OpenWithProgids"), item.prog_id), Some(&Value::Empty));
            let class = format!("Software\\Classes\\{}", item.prog_id);
            assert_eq!(registry.get(&format!("{class}\\shell\\open\\command"), ""), Some(&Value::Text(format!("\"{EXE}\" \"%1\""))));
            assert_eq!(registry.get(&format!("{class}\\shell\\open"), ""), Some(&Value::Text("Open with StykAnimate".into())));
            assert_eq!(registry.get(&format!("{class}\\DefaultIcon"), ""), Some(&Value::Text(format!("\"{EXE},0\""))));
        }
    }

    #[test]
    fn registering_twice_changes_nothing() {
        let mut once = FakeRegistry::default();
        once.apply(&file_type_ops(EXE)).unwrap();
        let mut twice = once.clone();
        twice.apply(&file_type_ops(EXE)).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn removal_leaves_the_extension_default_as_the_uninstaller_does() {
        let mut registry = FakeRegistry::default();
        registry.apply(&file_type_ops(EXE)).unwrap();
        registry.apply(&file_type_removal_ops()).unwrap();
        assert!(registry.get("Software\\Classes\\Pivot animation", "").is_none());
        assert!(registry.get("Software\\Classes\\Pivot animation\\shell\\open\\command", "").is_none());
        assert!(registry.get("Software\\Classes\\.piv\\OpenWithProgids", "Pivot animation").is_none());
        assert_eq!(registry.get("Software\\Classes\\.piv", ""), Some(&Value::Text("Pivot animation".into())));
    }

    #[test]
    fn the_link_is_a_url_protocol_with_the_command() {
        let mut registry = FakeRegistry::default();
        registry.apply(&protocol_ops(EXE)).unwrap();
        assert_eq!(registry.get("Software\\Classes\\stykanimate", ""), Some(&Value::Text("URL:stykanimate".into())));
        assert_eq!(registry.get("Software\\Classes\\stykanimate", "URL Protocol"), Some(&Value::Text(String::new())));
        assert_eq!(registry.get("Software\\Classes\\stykanimate\\shell\\open\\command", ""), Some(&Value::Text(format!("\"{EXE}\" \"%1\""))));
        registry.apply(&protocol_removal_ops()).unwrap();
        assert!(registry.keys.is_empty());
    }
}
