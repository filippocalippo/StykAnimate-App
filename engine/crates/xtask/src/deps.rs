//! `cargo xtask deps` and `cargo xtask lock`: the two rules `Cargo.lock` can prove.
//!
//! - **Direction** (decision N1): nothing on the engine side (every engine crate, `styk-core`, `styk-services`,
//!   `styk-trace`) may depend, directly or through other crates, on iced or on the front-end side (`styk-ui`,
//!   `styk-devtools`, `styk-design`, `styk-platform`, `styk-app`, `xtask`). The lock file lists every package's
//!   dependencies, optional and target-specific ones included, so the check is stricter than any one build.
//! - **No git sources** (decision N2): `Cargo.lock` holds no `source = "git+..."` line; iced and its pre-release
//!   dependencies are vendored.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Crates the engine side must never reach.
const FRONT_END: &[&str] = &["styk-ui", "styk-devtools", "styk-design", "styk-platform", "styk-app", "styk-text-check", "xtask"];

/// Name prefixes of the windowing toolkit: iced and its own forks.
const TOOLKIT: &[&str] = &["iced", "winit", "cryoglyph"];

/// A package of the lock file: its dependency names (resolved to `name` or `name version` keys).
#[derive(Debug)]
struct Package {
    key: String,
    dependencies: Vec<String>,
}

fn quoted(line: &str) -> Vec<&str> {
    line.split('"').skip(1).step_by(2).collect()
}

fn read_lock(text: &str) -> Vec<(String, String, Vec<String>)> {
    let mut packages = Vec::new();
    let mut current: Option<(String, String, Vec<String>)> = None;
    let mut in_dependencies = false;
    for line in text.lines() {
        if line.starts_with("[[package]]") {
            packages.extend(current.take());
            current = Some((String::new(), String::new(), Vec::new()));
            in_dependencies = false;
        } else if let Some((name, version, dependencies)) = current.as_mut() {
            if let Some(rest) = line.strip_prefix("name = ") {
                *name = quoted(rest).first().copied().unwrap_or_default().to_string();
            } else if let Some(rest) = line.strip_prefix("version = ") {
                *version = quoted(rest).first().copied().unwrap_or_default().to_string();
            } else if line.starts_with("dependencies = [") {
                in_dependencies = true;
            } else if in_dependencies && line.starts_with(']') {
                in_dependencies = false;
            } else if in_dependencies {
                dependencies.extend(quoted(line).first().map(|dependency| (*dependency).to_string()));
            }
        }
    }
    packages.extend(current);
    packages
}

/// Packages keyed as the lock file refers to them: `name`, or `name version` for a name that appears more than once.
fn packages(text: &str) -> Vec<Package> {
    let raw = read_lock(text);
    let mut count: BTreeMap<&str, usize> = BTreeMap::new();
    for (name, ..) in &raw {
        *count.entry(name).or_default() += 1;
    }
    raw.iter()
        .map(|(name, version, dependencies)| Package {
            key: if count[name.as_str()] > 1 { format!("{name} {version}") } else { name.clone() },
            // A dependency entry may carry a version (and a source) only when its name is ambiguous.
            dependencies: dependencies.clone(),
        })
        .collect()
}

fn name_of(key: &str) -> &str {
    key.split(' ').next().unwrap_or(key)
}

/// The engine-side crates: the members of the workspace that are not front-end.
pub fn engine_side(crate_names: &[String]) -> Vec<String> {
    crate_names.iter().filter(|name| !FRONT_END.contains(&name.as_str())).cloned().collect()
}

fn forbidden(name: &str) -> bool {
    FRONT_END.contains(&name) || TOOLKIT.iter().any(|prefix| name == *prefix || name.starts_with(&format!("{prefix}_")) || name.starts_with(&format!("{prefix}-")))
}

/// Violations of the direction rule: each is the path from an engine-side crate to a forbidden one.
pub fn direction_violations(lock: &str, members: &[String]) -> Vec<String> {
    let packages = packages(lock);
    let by_key: BTreeMap<&str, &Package> = packages.iter().map(|p| (p.key.as_str(), p)).collect();
    let by_name: BTreeMap<&str, Vec<&Package>> = packages.iter().fold(BTreeMap::new(), |mut map, p| {
        map.entry(name_of(&p.key)).or_default().push(p);
        map
    });
    let lookup = |dependency: &str| -> Vec<&Package> {
        by_key.get(dependency).map(|p| vec![*p]).unwrap_or_else(|| by_name.get(name_of(dependency)).cloned().unwrap_or_default())
    };
    let mut violations = Vec::new();
    for member in engine_side(members) {
        let Some(start) = by_name.get(member.as_str()).and_then(|found| found.first()) else { continue };
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut queue = vec![(start.key.as_str(), member.clone())];
        while let Some((key, path)) = queue.pop() {
            let Some(package) = by_key.get(key) else { continue };
            for dependency in &package.dependencies {
                let name = name_of(dependency);
                if forbidden(name) {
                    violations.push(format!("{member} reaches {name} ({path} -> {name})"));
                    continue;
                }
                for next in lookup(dependency) {
                    if seen.insert(next.key.as_str()) {
                        queue.push((next.key.as_str(), format!("{path} -> {}", name_of(&next.key))));
                    }
                }
            }
        }
    }
    violations.sort();
    violations.dedup();
    violations
}

/// The workspace members: the folders of `engine/crates`.
fn members(root: &Path) -> Result<Vec<String>, String> {
    let dir = root.join("engine/crates");
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().join("Cargo.toml").exists() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort();
    Ok(names)
}

pub fn deps(root: &Path) -> Result<(), String> {
    let lock = std::fs::read_to_string(root.join("engine/Cargo.lock")).map_err(|e| format!("engine/Cargo.lock: {e}"))?;
    let members = members(root)?;
    let violations = direction_violations(&lock, &members);
    if violations.is_empty() {
        println!("deps: {} engine-side crates reach no toolkit or front-end crate", engine_side(&members).len());
        Ok(())
    } else {
        Err(format!("{}\nthe engine and the core must not depend on iced, styk-ui or styk-devtools (decision N1)", violations.join("\n")))
    }
}

/// Lock lines that name a git source.
pub fn git_sources(lock: &str) -> Vec<String> {
    lock.lines().filter(|line| line.trim_start().starts_with("source = \"git+")).map(|line| line.trim().to_string()).collect()
}

pub fn lock(root: &Path) -> Result<(), String> {
    let lock = std::fs::read_to_string(root.join("engine/Cargo.lock")).map_err(|e| format!("engine/Cargo.lock: {e}"))?;
    let sources = git_sources(&lock);
    if sources.is_empty() {
        println!("lock: engine/Cargo.lock has no git source");
        Ok(())
    } else {
        Err(format!("{}\nCargo.lock must hold no git source: vendor the dependency and patch it in (decision N2)", sources.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCK: &str = r#"
[[package]]
name = "styk-core"
version = "0.1.0"
dependencies = [
 "styk-trace",
 "serde",
]

[[package]]
name = "styk-trace"
version = "0.1.0"

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "styk-ui"
version = "0.1.0"
dependencies = [
 "iced",
 "styk-core",
]

[[package]]
name = "iced"
version = "0.15.0-dev"
dependencies = [
 "iced_core",
]

[[package]]
name = "iced_core"
version = "0.15.0-dev"
"#;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn the_front_end_may_depend_on_the_core_but_not_the_other_way() {
        let members = names(&["styk-core", "styk-trace", "styk-ui"]);
        assert!(direction_violations(LOCK, &members).is_empty());
    }

    #[test]
    fn a_direct_dependency_on_iced_is_a_violation() {
        let lock = LOCK.replace("\"styk-trace\",\n \"serde\",", "\"styk-trace\",\n \"iced\",");
        let violations = direction_violations(&lock, &names(&["styk-core", "styk-trace", "styk-ui"]));
        assert_eq!(violations, ["styk-core reaches iced (styk-core -> iced)"]);
    }

    #[test]
    fn a_dependency_through_another_crate_is_a_violation_with_its_path() {
        let lock = LOCK.replace("[[package]]\nname = \"styk-trace\"\nversion = \"0.1.0\"\n", "[[package]]\nname = \"styk-trace\"\nversion = \"0.1.0\"\ndependencies = [\n \"styk-ui\",\n]\n");
        let violations = direction_violations(&lock, &names(&["styk-core", "styk-trace", "styk-ui"]));
        assert!(violations.contains(&"styk-core reaches styk-ui (styk-core -> styk-trace -> styk-ui)".to_string()), "{violations:?}");
    }

    #[test]
    fn versioned_duplicates_are_followed() {
        let lock = "[[package]]\nname = \"a\"\nversion = \"1\"\ndependencies = [\n \"b 2.0.0\",\n]\n\n[[package]]\nname = \"b\"\nversion = \"1.0.0\"\n\n[[package]]\nname = \"b\"\nversion = \"2.0.0\"\ndependencies = [\n \"winit\",\n]\n";
        assert_eq!(direction_violations(lock, &names(&["a"])), ["a reaches winit (a -> b -> winit)"]);
    }

    #[test]
    fn git_sources_are_found() {
        let lock = "source = \"registry+https://x\"\n  source = \"git+https://github.com/iced-rs/winit.git?rev=1#1\"\n";
        assert_eq!(git_sources(lock), ["source = \"git+https://github.com/iced-rs/winit.git?rev=1#1\""]);
        assert!(git_sources(LOCK).is_empty());
    }
}
