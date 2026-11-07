//! `cargo xtask package`: the Windows Setup.
//!
//! Builds the program, lays out the files the Setup installs, runs `makensis` on `packaging/windows/installer.nsi`, and
//! writes `latest.yml`, its signature and `SHA256SUMS.txt` next to the Setup (through the `release_feed` example of
//! `styk-platform`, which has the hash and signature code the updater itself uses). Nothing is signed with a
//! certificate, uploaded or published.

use std::path::{Path, PathBuf};
use std::process::Command;

/// `cargo xtask package [--profile release|quick] [--exe <built program>] [--key-seed <file>]`. `--exe` packages a program
/// already built (to try the packaging without building).
pub fn package(root: &Path, args: &[&str]) -> Result<(), String> {
    let mut profile = "release";
    let mut seed: Option<&str> = None;
    let mut exe: Option<&str> = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match *arg {
            "--profile" => profile = rest.next().copied().ok_or("--profile needs release or quick")?,
            "--exe" => exe = Some(rest.next().copied().ok_or("--exe needs a path")?),
            "--key-seed" => seed = Some(rest.next().copied().ok_or("--key-seed needs a file")?),
            other => return Err(format!("unknown option {other}")),
        }
    }
    if !matches!(profile, "release" | "quick") {
        return Err("--profile is release or quick (quick is for trying the packaging, never shipped)".into());
    }
    let version = package_version(root)?;
    let out = root.join("artifacts").join("package").join(&version);
    let payload = out.join("payload");
    let _ = std::fs::remove_dir_all(&payload);
    std::fs::create_dir_all(&payload).map_err(|e| e.to_string())?;

    let built = match exe {
        Some(path) => PathBuf::from(path),
        None => {
            run(Command::new("cargo").current_dir(root.join("engine")).args(["build", "--profile", profile, "-p", "styk-app"]), "building the program")?;
            let profile_dir = if profile == "release" { "release" } else { "quick" };
            root.join("engine").join("target").join(profile_dir).join("stykanimate.exe")
        }
    };
    std::fs::copy(&built, payload.join("StykAnimate.exe")).map_err(|e| format!("copying {}: {e}", built.display()))?;
    for notice in ["LICENSE", "THIRD_PARTY_NOTICES.md"] {
        std::fs::copy(root.join(notice), payload.join(notice)).map_err(|e| format!("copying {notice}: {e}"))?;
    }

    // The Setup installs exactly the files of this list and writes the manifest the uninstaller removes by.
    let list = out.join("files.nsh");
    run(
        Command::new("cargo").current_dir(root.join("engine")).args(["run", "--quiet", "-p", "styk-platform", "--example", "release_feed", "--", "files-script"]).arg("--source").arg(&payload).arg("--out").arg(&list),
        "listing the files",
    )?;
    let setup = out.join(format!("StykAnimate-{version}-Setup-x64.exe"));
    let makensis = makensis()?;
    let mut command = Command::new(&makensis);
    command.arg(format!("/DVERSION={version}")).arg(format!("/DFILES_SCRIPT={}", list.display())).arg(format!("/DOUTFILE={}", setup.display()));
    command.arg(format!("/DICON_FILE={}", root.join("desktop").join("assets").join("stykanimate.ico").display()));
    if let Some(plugins) = winshell_plugins() {
        command.arg(format!("/DPLUGIN_DIR={}", plugins.display()));
    }
    command.arg(root.join("packaging").join("windows").join("installer.nsi"));
    run(&mut command, "makensis")?;

    let mut feed = Command::new("cargo");
    feed.current_dir(root.join("engine")).args(["run", "--quiet", "-p", "styk-platform", "--example", "release_feed", "--", "publish"]);
    feed.arg("--installer").arg(&setup).args(["--version", &version]).arg("--out").arg(&out);
    if let Some(seed) = seed {
        feed.arg("--key-seed").arg(seed);
    }
    run(&mut feed, "writing the feed")?;
    println!("{}", setup.display());
    Ok(())
}

fn run(command: &mut Command, what: &str) -> Result<(), String> {
    let status = command.status().map_err(|e| format!("{what}: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("{what} failed ({status})")) }
}

/// The version in `package.json`, the release's one source (`docs/RELEASING.md`).
pub fn package_version(root: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(root.join("package.json")).map_err(|e| format!("package.json: {e}"))?;
    let at = text.find("\"version\"").ok_or("package.json has no version")?;
    let rest = &text[at + "\"version\"".len()..];
    let start = rest.find('"').ok_or("package.json version is malformed")? + 1;
    let end = rest[start..].find('"').ok_or("package.json version is malformed")?;
    Ok(rest[start..start + end].to_string())
}

/// `makensis`: `STYK_MAKENSIS`, else the copy electron-builder caches.
fn makensis() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("STYK_MAKENSIS") {
        return Ok(PathBuf::from(path));
    }
    let cache = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).ok_or("LOCALAPPDATA is not set")?.join("electron-builder").join("Cache").join("nsis");
    for entry in std::fs::read_dir(&cache).map_err(|e| format!("no makensis: set STYK_MAKENSIS ({}: {e})", cache.display()))?.flatten() {
        let candidate = entry.path().join("makensis.exe");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("no makensis: set STYK_MAKENSIS to its path".into())
}

/// A folder holding `x86-unicode\WinShell.dll`, from electron-builder's cached NSIS resources, if present.
fn winshell_plugins() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("STYK_NSIS_PLUGINS") {
        return Some(PathBuf::from(path));
    }
    let cache = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("electron-builder").join("Cache").join("nsis");
    std::fs::read_dir(cache).ok()?.flatten().map(|e| e.path().join("plugins")).find(|p| p.join("x86-unicode").join("WinShell.dll").exists())
}
