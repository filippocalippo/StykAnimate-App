//! Feature boundary for toolkit-free developer tools.
use std::path::Path;
fn validate(manifest: &str) -> Result<(), String> {
    let lines: Vec<_> = manifest
        .lines()
        .map(str::trim)
        .filter(|s| !s.starts_with('#'))
        .collect();
    for name in ["iced", "png", "styk-ui", "styk-design"] {
        let prefix = format!("{name} =");
        let line = lines
            .iter()
            .find(|line| line.starts_with(&prefix))
            .ok_or_else(|| format!("missing {name} dependency"))?;
        if !line.replace(' ', "").contains("optional=true") {
            return Err(format!("{name} must be optional in devtools"));
        }
    }
    let features = manifest
        .split("[features]")
        .nth(1)
        .ok_or("missing features")?;
    // Intentionally strict until there are more features: a new feature needs an explicit forwarding review.
    for line in features
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        if line != "default = []"
            && line != "ui = [\"dep:iced\", \"dep:png\", \"dep:styk-design\", \"dep:styk-ui\"]"
        {
            return Err(format!("unreviewed devtools feature: {line}"));
        }
    }
    Ok(())
}
pub fn check(root: &Path) -> Result<(), String> {
    let manifest = std::fs::read_to_string(root.join("engine/crates/styk-devtools/Cargo.toml"))
        .map_err(|e| e.to_string())?;
    validate(&manifest)?;
    println!("features: developer views are optional and off by default");
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_toolkit_in_headless_build() {
        let manifest = include_str!("../../styk-devtools/Cargo.toml");
        assert!(validate(manifest).is_ok());
        assert!(validate(&manifest.replace("optional = true", "optional = false")).is_err());
        assert!(validate(&manifest.replace("default = []", "default = [\"ui\"]")).is_err());
    }
}
