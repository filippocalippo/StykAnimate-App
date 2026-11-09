//! Resolve the exact shipping packages with normal/build edges and the host target.
use std::{
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Command, Stdio},
};

fn inspect(mut input: impl BufRead) -> Result<usize, String> {
    let mut packages = 0;
    loop {
        let mut line = Vec::new();
        let n = input
            .by_ref()
            .take(16 * 1024 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if n > 16 * 1024 {
            return Err("cargo feature line exceeds 16 KiB".into());
        }
        let line = std::str::from_utf8(&line)
            .map_err(|e| e.to_string())?
            .trim();
        if line.starts_with("styk-screens ") {
            return Err("shipping resolution includes styk-screens".into());
        }
        if line.contains("feature \"devtools\"") || line.split(" features=[").nth(1).is_some_and(|f| f.split(']').next().is_some_and(|f| f.split(',').any(|f| f.trim() == "devtools"))) {
            return Err("shipping resolution enables a developer extension seam".into());
        }
        if line.starts_with("styk-devtools ") || line.starts_with("styk-devtools-engine ") {
            return Err("shipping resolution includes styk-devtools".into());
        }
        if line.starts_with("styk-trace ") {
            if line.contains("feature \"enabled\"") {
                return Err("shipping resolution enables styk-trace/enabled".into());
            }
            if let Some(features) = line.split(" features=[").nth(1) {
                let features = features
                    .split(']')
                    .next()
                    .ok_or("missing resolved features")?;
                if features.split(',').any(|f| f.trim() == "enabled") {
                    return Err("shipping resolution enables styk-trace/enabled".into());
                }
            }
        }
        if line.contains(" features=[") {
            packages += 1;
        }
    }
    if packages == 0 {
        return Err("cargo tree supplied no resolved packages".into());
    }
    Ok(packages)
}
fn resolve(root: &Path, target: &str, package: &str, features: &[&str]) -> Result<usize, String> {
    let mut child = Command::new("cargo")
        .current_dir(root)
        .args([
            "tree",
            "--locked",
            "--manifest-path",
            "engine/Cargo.toml",
            "-p",
            package,
            "--target",
            target,
            "-e",
            "normal,build,features",
            "--prefix",
            "none",
            "--format",
            "{p} features=[{f}]",
        ])
        .args(features)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| e.to_string())?;
    // Drain completely even after a rejection, so the child cannot block on a full pipe.
    let mut output = BufReader::new(child.stdout.take().ok_or("cargo tree stdout missing")?);
    let result = inspect(&mut output);
    let drain = std::io::copy(&mut output, &mut std::io::sink()).map_err(|e| e.to_string());
    let status = child.wait().map_err(|e| e.to_string())?;
    drain?;
    if !status.success() {
        return Err(format!("cargo tree failed for {package}: {status}"));
    }
    result
}
fn host() -> Result<String, String> {
    let mut child = Command::new("rustc")
        .arg("-vV")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut output = child.stdout.take().ok_or("rustc stdout missing")?;
    let mut bytes = Vec::new();
    let read = output
        .by_ref()
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string());
    let drain = std::io::copy(&mut output, &mut std::io::sink()).map_err(|e| e.to_string());
    let status = child.wait().map_err(|e| e.to_string())?;
    read?;
    drain?;
    if !status.success() || bytes.len() > 8192 {
        return Err("rustc host lookup failed or exceeded 8 KiB".into());
    }
    let text = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
    text.lines()
        .find_map(|l| l.strip_prefix("host: "))
        .map(str::to_owned)
        .ok_or("rustc host missing".into())
}
pub fn check(root: &Path) -> Result<(), String> {
    let target = host()?;
    for (package, bin) in [("styk-app", "stykanimate"), ("styk-cli", "styk")] {
        let count = resolve(root, &target, package, &[])?;
        println!(
            "shipping features: {package}/{bin} clean ({count} resolved entries; target {target}; default features; normal/build edges)"
        );
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_enabled_trace_and_devtools_in_resolved_features() {
        assert!(inspect(b"styk-trace v0.1.0 features=[]\n".as_slice()).is_ok());
        for line in [
            "styk-trace v0.1.0 features=[enabled]",
            "styk-trace feature \"enabled\"",
            "styk-screens v0.1.0 features=[]",
            "styk-devtools v0.1.0 features=[]",
            "styk-devtools-engine v0.1.0 features=[]",
            "styk-core v0.1.0 features=[engine,devtools]",
            "styk-ui feature \"devtools\"",
            "iced_winit v0.15.0 features=[devtools]",
        ] {
            assert!(inspect(line.as_bytes()).is_err());
        }
        assert!(inspect(b"".as_slice()).is_err());
    }
    #[test]
    #[ignore = "resolves real Cargo graphs; run explicitly in the machine queue"]
    fn production_crate_developer_feature_is_rejected() {
        let root=crate::root();let target=host().unwrap();
        let error=resolve(&root,&target,"styk-core",&["--features","devtools"]).unwrap_err();
        assert_eq!(error,"shipping resolution enables a developer extension seam");
    }
    #[test]
    #[ignore = "resolves real Cargo graphs; run explicitly in the machine queue"]
    fn developer_cli_resolution_is_rejected() {
        let root = crate::root();
        let target = host().unwrap();
        let error = resolve(&root, &target, "styk-cli", &["--features", "app-tools"]).unwrap_err();
        assert!(
            error.contains("styk-devtools") || error.contains("styk-trace/enabled"),
            "{error}"
        );
    }
}
