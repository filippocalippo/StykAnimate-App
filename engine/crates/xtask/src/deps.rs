//! `cargo xtask deps` and `cargo xtask lock`: the two rules `Cargo.lock` can prove.
//!
//! - **Direction** (decision N1): nothing on the engine side (every engine crate, `styk-core`, `styk-services`,
//!   `styk-trace`) may depend, directly or through other crates, on iced or on the front-end side (`styk-ui`,
//!   `styk-devtools`, `styk-design`, `styk-platform`, `styk-app`, `xtask`). The lock file lists every package's
//!   dependencies, optional and target-specific ones included, so the check is stricter than any one build.
//! - **App tools** (decision Q2): the headless tools of `styk-cli` that drive the app's own services (`styk-cli video`) may
//!   reach `styk-core`, `styk-services` and `styk-platform`, and only through the non-default `app-tools` feature. The lock
//!   file cannot tell a feature from a plain dependency, so the manifest is read: each of the three must be optional, only
//!   `app-tools` may enable them, `app-tools` may enable nothing else, and no default feature may turn it on. Those three
//!   crates must in turn reach no toolkit and no other front-end crate, so the tools never pull in iced or `styk-ui`.
//! - **No git sources** (decision N2): `Cargo.lock` holds no `source = "git+..."` line; iced and its pre-release
//!   dependencies are vendored.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Crates the engine side must never reach.
const FRONT_END: &[&str] = &["styk-ui", "styk-devtools", "styk-devtools-engine", "styk-design", "styk-platform", "styk-app", "styk-text-check", "xtask"];

/// The one engine-side crate allowed to reach front-end-side crates, and the crates it may reach, both only through its
/// `app-tools` feature (decision Q2).
const APP_TOOLS_CRATE: &str = "styk-cli";
const APP_TOOLS_REACH: &[&str] = &["styk-core", "styk-services", "styk-platform", "styk-devtools-engine"];
const APP_TOOLS_FEATURE: &str = "app-tools";

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
                // The approved edges of the app tools are checked by `app_tools_violations` and `app_tools_manifest_violations`.
                if member == APP_TOOLS_CRATE && path == APP_TOOLS_CRATE && APP_TOOLS_REACH.contains(&name) {
                    continue;
                }
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

/// What the crates the app tools reach must not reach in turn: the toolkit and every front-end crate except the ones
/// the tools may use themselves (`styk-platform` is front-end, and allowed).
pub fn app_tools_violations(lock: &str) -> Vec<String> {
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
    for start_name in APP_TOOLS_REACH {
        let Some(start) = by_name.get(start_name).and_then(|found| found.first()) else { continue };
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut queue = vec![(start.key.as_str(), (*start_name).to_string())];
        while let Some((key, path)) = queue.pop() {
            let Some(package) = by_key.get(key) else { continue };
            for dependency in &package.dependencies {
                let name = name_of(dependency);
                if forbidden(name) && !APP_TOOLS_REACH.contains(&name) {
                    violations.push(format!("{APP_TOOLS_CRATE}'s {APP_TOOLS_FEATURE} reaches {name} ({path} -> {name})"));
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

/// The manifest side of the app-tools rule, on the text of `styk-cli/Cargo.toml`.
pub fn app_tools_manifest_violations(manifest: &str) -> Vec<String> {
    let mut violations = Vec::new();
    let mut section = String::new();
    let mut optional: BTreeMap<&str, bool> = BTreeMap::new();
    let mut features: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut pending: Option<(String, String)> = None;
    for line in manifest.lines() {
        let line = line.trim();
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = header.to_string();
            pending = None;
            continue;
        }
        if section == "dependencies" {
            if let Some((name, value)) = line.split_once('=') {
                let name = name.trim();
                if let Some(tool) = APP_TOOLS_REACH.iter().find(|t| **t == name) {
                    optional.insert(tool, value.replace(' ', "").contains("optional=true"));
                }
            }
        } else if section == "features" {
            // A feature's list may span lines.
            if let Some((name, mut rest)) = pending.take() {
                rest.push_str(line);
                if line.contains(']') {
                    features.insert(name, quoted(&rest).iter().map(|v| v.to_string()).collect());
                } else {
                    pending = Some((name, rest));
                }
            } else if let Some((name, value)) = line.split_once('=') {
                let (name, value) = (name.trim().to_string(), value.trim().to_string());
                if value.contains(']') {
                    features.insert(name, quoted(&value).iter().map(|v| v.to_string()).collect());
                } else {
                    pending = Some((name, value));
                }
            }
        }
    }
    for tool in APP_TOOLS_REACH {
        if optional.get(tool) == Some(&false) {
            violations.push(format!("{APP_TOOLS_CRATE} depends on {tool} without making it optional"));
        }
    }
    let expected: BTreeSet<String> = APP_TOOLS_REACH.iter().map(|t| format!("dep:{t}")).chain(["dep:serde_json".into()]).collect();
    match features.get(APP_TOOLS_FEATURE) {
        Some(list) => {
            let have: BTreeSet<String> = list.iter().cloned().collect();
            for extra in have.difference(&expected) {
                violations.push(format!("the {APP_TOOLS_FEATURE} feature enables {extra}, which is not an app tool"));
            }
        }
        None if !optional.is_empty() => violations.push(format!("{APP_TOOLS_CRATE} has optional app-tool dependencies and no {APP_TOOLS_FEATURE} feature")),
        None => {}
    }
    for (name, list) in &features {
        if name == APP_TOOLS_FEATURE {
            continue;
        }
        for entry in list {
            let entry = entry.trim_start_matches("dep:");
            if APP_TOOLS_REACH.contains(&entry) || entry == APP_TOOLS_FEATURE {
                violations.push(format!("the {name} feature turns on {entry}: only {APP_TOOLS_FEATURE} may, and nothing may enable it by default"));
            }
        }
    }
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
    crate::dev_features::check(root)?;
    let lock = std::fs::read_to_string(root.join("engine/Cargo.lock")).map_err(|e| format!("engine/Cargo.lock: {e}"))?;
    let members = members(root)?;
    let mut violations = direction_violations(&lock, &members);
    violations.extend(app_tools_violations(&lock));
    let cli = root.join("engine/crates").join(APP_TOOLS_CRATE).join("Cargo.toml");
    violations.extend(app_tools_manifest_violations(&std::fs::read_to_string(&cli).map_err(|e| format!("{}: {e}", cli.display()))?));
    if violations.is_empty() {
        println!(
            "deps: {} engine-side crates reach no toolkit or front-end crate ({APP_TOOLS_CRATE} reaches {} only through its non-default {APP_TOOLS_FEATURE} feature)",
            engine_side(&members).len(),
            APP_TOOLS_REACH.join(", ")
        );
        Ok(())
    } else {
        Err(format!(
            "{}\nthe engine and the core must not depend on iced, styk-ui or styk-devtools (decision N1); the one exception is the {APP_TOOLS_FEATURE} feature of {APP_TOOLS_CRATE} (decision Q2)",
            violations.join("\n")
        ))
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

    const CLI_LOCK: &str = "[[package]]\nname = \"styk-cli\"\nversion = \"0.1.0\"\ndependencies = [\n \"styk-core\",\n \"styk-platform\",\n \"styk-services\",\n]\n\n[[package]]\nname = \"styk-core\"\nversion = \"0.1.0\"\ndependencies = [\n \"styk-services\",\n]\n\n[[package]]\nname = \"styk-services\"\nversion = \"0.1.0\"\n\n[[package]]\nname = \"styk-platform\"\nversion = \"0.1.0\"\ndependencies = [\n \"styk-services\",\n \"windows-sys\",\n]\n\n[[package]]\nname = \"windows-sys\"\nversion = \"0.61.0\"\n";

    #[test]
    fn the_cli_may_reach_the_app_tool_crates() {
        let members = names(&["styk-cli", "styk-core", "styk-services", "styk-platform"]);
        assert!(direction_violations(CLI_LOCK, &members).is_empty());
        assert!(app_tools_violations(CLI_LOCK).is_empty());
    }

    #[test]
    fn another_front_end_crate_is_still_forbidden_to_the_cli() {
        let lock = CLI_LOCK.replace("\"styk-core\",\n \"styk-platform\",", "\"styk-core\",\n \"styk-platform\",\n \"styk-ui\",");
        let violations = direction_violations(&lock, &names(&["styk-cli", "styk-core", "styk-services", "styk-platform"]));
        assert_eq!(violations, ["styk-cli reaches styk-ui (styk-cli -> styk-ui)"]);
    }

    #[test]
    fn other_engine_crates_still_may_not_reach_the_platform() {
        let lock = format!("{CLI_LOCK}\n[[package]]\nname = \"styk-export\"\nversion = \"0.1.0\"\ndependencies = [\n \"styk-platform\",\n]\n");
        let violations = direction_violations(&lock, &names(&["styk-cli", "styk-core", "styk-export"]));
        assert_eq!(violations, ["styk-export reaches styk-platform (styk-export -> styk-platform)"]);
    }

    #[test]
    fn the_platform_may_not_pull_in_the_toolkit_for_the_tools() {
        let lock = CLI_LOCK.replace("\"styk-services\",\n \"windows-sys\",", "\"styk-services\",\n \"iced\",\n \"windows-sys\",");
        assert_eq!(app_tools_violations(&lock), ["styk-cli's app-tools reaches iced (styk-platform -> iced)"]);
    }

    const CLI_MANIFEST: &str = "[package]\nname = \"styk-cli\"\n\n[features]\napp-tools = [\"dep:styk-core\", \"dep:styk-services\", \"dep:styk-platform\"]\n\n[dependencies]\nstyk-eval = { path = \"../styk-eval\" }\nstyk-core = { path = \"../styk-core\", optional = true }\nstyk-services = { path = \"../styk-services\", optional = true }\nstyk-platform = { path = \"../styk-platform\", optional = true }\n";

    #[test]
    fn the_manifest_with_an_optional_app_tools_feature_passes() {
        assert!(app_tools_manifest_violations(CLI_MANIFEST).is_empty());
        let multiline = CLI_MANIFEST.replace("app-tools = [\"dep:styk-core\", \"dep:styk-services\", \"dep:styk-platform\"]", "app-tools = [\n    \"dep:styk-core\",\n    \"dep:styk-services\",\n    \"dep:styk-platform\",\n]");
        assert!(app_tools_manifest_violations(&multiline).is_empty());
    }

    #[test]
    fn a_plain_dependency_on_a_tool_crate_is_a_violation() {
        let manifest = CLI_MANIFEST.replace("styk-platform = { path = \"../styk-platform\", optional = true }", "styk-platform = { path = \"../styk-platform\" }");
        assert_eq!(app_tools_manifest_violations(&manifest), ["styk-cli depends on styk-platform without making it optional"]);
    }

    #[test]
    fn a_default_feature_that_turns_the_tools_on_is_a_violation() {
        let manifest = CLI_MANIFEST.replace("[features]\n", "[features]\ndefault = [\"app-tools\"]\n");
        assert_eq!(app_tools_manifest_violations(&manifest), ["the default feature turns on app-tools: only app-tools may, and nothing may enable it by default"]);
    }

    #[test]
    fn another_feature_that_enables_a_tool_crate_is_a_violation() {
        let manifest = CLI_MANIFEST.replace("[features]\n", "[features]\ngpu = [\"dep:styk-platform\"]\n");
        assert_eq!(app_tools_manifest_violations(&manifest), ["the gpu feature turns on styk-platform: only app-tools may, and nothing may enable it by default"]);
    }

    #[test]
    fn the_app_tools_feature_may_enable_nothing_else() {
        let manifest = CLI_MANIFEST.replace("\"dep:styk-platform\"]", "\"dep:styk-platform\", \"dep:styk-ui\"]");
        assert_eq!(app_tools_manifest_violations(&manifest), ["the app-tools feature enables dep:styk-ui, which is not an app tool"]);
    }

    #[test]
    fn optional_tool_crates_without_the_feature_are_a_violation() {
        let manifest = CLI_MANIFEST.replace("app-tools = [\"dep:styk-core\", \"dep:styk-services\", \"dep:styk-platform\"]\n", "");
        assert_eq!(app_tools_manifest_violations(&manifest), ["styk-cli has optional app-tool dependencies and no app-tools feature"]);
    }

    #[test]
    fn git_sources_are_found() {
        let lock = "source = \"registry+https://x\"\n  source = \"git+https://github.com/iced-rs/winit.git?rev=1#1\"\n";
        assert_eq!(git_sources(lock), ["source = \"git+https://github.com/iced-rs/winit.git?rev=1#1\""]);
        assert!(git_sources(LOCK).is_empty());
    }
}
