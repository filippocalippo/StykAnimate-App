//! StykAnimate's desktop app: a Tauri 2 window around today's web interface and engine (docs/tauri/README.md).
//!
//! Each area of the port registers its commands in one function (`register`) in its own module; this file calls the
//! three and nothing else per area, so the areas never edit the same lines.

pub mod files;
pub mod registry;
pub mod services;
pub mod shell;

pub use registry::Desktop;

/// Builds and runs the app. Returns when the last window closes.
pub fn run() {
    let mut desktop = Desktop::new();
    shell::register(&mut desktop);
    files::register(&mut desktop);
    services::register(&mut desktop);
    desktop.run();
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    /// The page can call exactly the commands that exist: every command is allowed in capabilities/main.json, and
    /// the file allows nothing else of the app's.
    #[test]
    fn capabilities_allow_exactly_the_registered_commands() {
        let mut desktop = crate::Desktop::new();
        crate::shell::register(&mut desktop);
        crate::files::register(&mut desktop);
        crate::services::register(&mut desktop);
        let registered: BTreeSet<String> = desktop.command_names().into_iter().map(str::to_owned).collect();
        let capabilities: serde_json::Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let permissions: Vec<&str> =
            capabilities["permissions"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
        let allowed: BTreeSet<String> =
            permissions.iter().filter_map(|p| p.strip_prefix("allow-")).map(|p| p.replace('-', "_")).collect();
        assert_eq!(allowed, registered);
        // Beyond the app's own commands, only listening to its events.
        let other: Vec<&&str> = permissions.iter().filter(|p| !p.starts_with("allow-")).collect();
        assert_eq!(other, [&"core:event:allow-listen", &"core:event:allow-unlisten"]);
    }
}
