//! Trace-name ownership check. No runtime instrumentation or toolkit dependency.
use std::{collections::BTreeMap, path::Path};
fn walk(path: &Path, owner: &str, names: &mut BTreeMap<String, String>) -> Result<(), String> {
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            walk(&path, owner, names)?;
        } else if path.extension().is_some_and(|e| e == "rs") {
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            for marker in ["span!(\"", "counter!(\"", "mark!(\""] {
                for part in text.split(marker).skip(1) {
                    if let Some((name, _)) = part.split_once('"') {
                        if let Some(previous) = names.insert(name.into(), owner.into()) {
                            if previous != owner {
                                return Err(format!(
                                    "trace name {name} has two owners: {previous}, {owner}"
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
pub fn check(root: &Path) -> Result<(), String> {
    let mut names = BTreeMap::new();
    for entry in std::fs::read_dir(root.join("engine/crates")).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().join("src");
        let owner = entry.file_name().to_string_lossy().into_owned();
        if owner == "xtask" || owner == "styk-trace" {
            continue;
        }
        if path.is_dir() {
            walk(&path, &owner, &mut names)?;
        }
    }
    println!("trace: {} names each have one owner", names.len());
    Ok(())
}
