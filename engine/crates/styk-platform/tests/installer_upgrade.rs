//! The Setup, built and run for real, against a registry sandbox: an Electron-style install is upgraded by the native
//! Setup the way an installed copy's updater runs it (`--updated /S --force-run /D=<dir>`).
//!
//! Everything is under `HKCU\Software\StykAnimateSandbox\<id>\` and a temporary folder; the real registry, the real
//! Start menu, desktop and Documents, and any installed StykAnimate are never touched (the Setups are built with the
//! `SANDBOX` define, which redirects every key and folder). These tests need `makensis` (`STYK_MAKENSIS`, or the copy
//! electron-builder caches) and are run on purpose: `cargo test -p styk-platform --test installer_upgrade -- --ignored`.
//! They fail, not skip, when it is missing.

#![cfg(windows)]

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use styk_platform::windows::registry::WindowsRegistry;
use styk_services::shell::associations::{ASSOCIATIONS, APP_GUID, PRODUCT_NAME};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().expect("the repository root")
}

fn makensis() -> PathBuf {
    if let Some(path) = std::env::var_os("STYK_MAKENSIS") {
        return PathBuf::from(path);
    }
    let cache = PathBuf::from(std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA")).join("electron-builder").join("Cache").join("nsis");
    for entry in std::fs::read_dir(&cache).unwrap_or_else(|e| panic!("no makensis: set STYK_MAKENSIS ({}: {e})", cache.display())).flatten() {
        let candidate = entry.path().join("makensis.exe");
        if candidate.exists() {
            return candidate;
        }
    }
    panic!("no makensis: set STYK_MAKENSIS");
}

fn plugins() -> Option<PathBuf> {
    let cache = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("electron-builder").join("Cache").join("nsis");
    std::fs::read_dir(cache).ok()?.flatten().map(|e| e.path().join("plugins")).find(|p| p.join("x86-unicode").join("WinShell.dll").exists())
}

fn payload_exe() -> PathBuf {
    // target/debug/deps/<test>.exe -> target/debug/examples/installer_payload.exe
    let exe = std::env::current_exe().unwrap();
    let path = exe.parent().unwrap().parent().unwrap().join("examples").join("installer_payload.exe");
    assert!(path.exists(), "build the examples first: {}", path.display());
    path
}

struct Sandbox {
    id: String,
    dir: PathBuf,
    registry: WindowsRegistry,
}

impl Sandbox {
    fn new(tag: &str) -> Sandbox {
        let id = format!("{tag}-{}", std::process::id());
        let dir = std::env::temp_dir().join(format!("styk-installer-{id}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let registry = WindowsRegistry::sandbox(&id);
        registry.delete_sandbox();
        Sandbox { id, dir, registry }
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        self.registry.delete_sandbox();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn run(command: &mut Command, what: &str) {
    let output = command.output().unwrap_or_else(|e| panic!("{what}: {e}"));
    assert!(output.status.success(), "{what} failed ({}):\n{}\n{}", output.status, String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}

/// Builds a Setup with the sandbox defines.
fn build(sandbox: &Sandbox, script: &Path, version: &str, source: &Path, out: &Path, extra: &[String]) {
    let mut command = Command::new(makensis());
    command.arg(format!("/DVERSION={version}")).arg(format!("/DSOURCE_DIR={}", source.display())).arg(format!("/DOUTFILE={}", out.display())).arg(format!("/DSANDBOX={}", sandbox.id)).arg(format!("/DSANDBOX_DIR={}", sandbox.dir.join("profile").display()));
    for arg in extra {
        command.arg(arg);
    }
    command.arg(script);
    run(&mut command, "makensis");
}

fn lay_out(dir: &Path, extra: &[(&str, &str)]) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::copy(payload_exe(), dir.join("StykAnimate.exe")).unwrap();
    for (name, content) in extra {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
}

/// Runs a Setup the way the updater does, with `/D=` last and unquoted.
fn run_setup(setup: &Path, arguments: &[&str], install_dir: &Path) {
    let mut command = Command::new(setup);
    command.args(arguments).raw_arg(format!("/D={}", install_dir.display()));
    run(&mut command, "the Setup");
}

fn wait_for(path: &Path) -> String {
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        if let Ok(text) = std::fs::read_to_string(path) {
            return text;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("{} never appeared", path.display());
}

const UNINSTALL: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

#[test]
#[ignore = "builds and runs two Setups with makensis (sandboxed); run with --ignored"]
fn the_native_setup_upgrades_an_electron_style_install_the_way_the_updater_runs_it() {
    let root = repo_root();
    let sandbox = Sandbox::new("upgrade");
    let install = sandbox.dir.join("Programs").join("StykAnimate");
    let guid_key = format!("{UNINSTALL}\\{APP_GUID}");

    // 1. The old install: the Electron app's layout, with files only Electron has.
    let electron_files = sandbox.dir.join("electron-files");
    lay_out(&electron_files, &[("resources\\app.asar", "old"), ("locales\\en-US.pak", "old"), ("chrome_100_percent.pak", "old")]);
    let electron_setup = sandbox.dir.join("Electron-Setup.exe");
    build(&sandbox, &root.join("packaging/windows/test/electron-fixture.nsi"), "1.1.0", &electron_files, &electron_setup, &[]);
    run_setup(&electron_setup, &["/S"], &install);
    assert_eq!(sandbox.registry.read_text(&guid_key, "DisplayVersion").as_deref(), Some("1.1.0"), "the old install is registered");
    assert!(install.join("resources").join("app.asar").exists());
    for item in ASSOCIATIONS {
        assert_eq!(sandbox.registry.read_text(&format!("Software\\Classes\\.{}", item.ext), "").as_deref(), Some(item.prog_id), "old .{} default", item.ext);
    }

    // 2. The native Setup, run as the installed copy's updater runs it.
    let native_files = sandbox.dir.join("native-files");
    lay_out(&native_files, &[("LICENSE", "license")]);
    let native_setup = sandbox.dir.join("Native-Setup.exe");
    let mut extra = Vec::new();
    if let Some(plugins) = plugins() {
        extra.push(format!("/DPLUGIN_DIR={}", plugins.display()));
    }
    build(&sandbox, &root.join("packaging/windows/installer.nsi"), "2.0.0", &native_files, &native_setup, &extra);
    println!("native Setup: {} bytes (payload stand-in)", std::fs::metadata(&native_setup).unwrap().len());
    let started = Instant::now();
    run_setup(&native_setup, &["--updated", "/S", "--force-run"], &install);
    println!("upgrade took {:?}", started.elapsed());

    // 3. Files: Electron's are gone, the native ones are there, in the same folder.
    assert!(!install.join("resources").exists(), "the old install's files were removed by its own uninstaller");
    assert!(!install.join("chrome_100_percent.pak").exists());
    assert!(install.join("StykAnimate.exe").exists() && install.join("LICENSE").exists());
    assert!(install.join("Uninstall StykAnimate.exe").exists(), "the uninstaller has the old name");

    // 4. The same registry identity: one uninstall key, now at the new version; the same install location.
    assert_eq!(sandbox.registry.read_text(&guid_key, "DisplayVersion").as_deref(), Some("2.0.0"));
    assert_eq!(sandbox.registry.read_text(&guid_key, "InstallLocation").as_deref(), Some(install.to_str().unwrap()));
    assert_eq!(sandbox.registry.read_text(&format!("Software\\{APP_GUID}"), "InstallLocation").as_deref(), Some(install.to_str().unwrap()));
    assert_eq!(sandbox.registry.read_text(&guid_key, "UninstallString").as_deref(), Some(format!("\"{}\" /currentuser", install.join("Uninstall StykAnimate.exe").display()).as_str()));

    // 5. The same ProgIDs for all eight formats, viewers included, now opening the native program.
    let exe = install.join("StykAnimate.exe");
    for item in ASSOCIATIONS {
        let ext = format!("Software\\Classes\\.{}", item.ext);
        assert_eq!(sandbox.registry.read_text(&ext, "").as_deref(), Some(item.prog_id), ".{}", item.ext);
        assert!(sandbox.registry.value_exists(&format!("{ext}\\OpenWithProgids"), item.prog_id));
        let command = sandbox.registry.read_text(&format!("Software\\Classes\\{}\\shell\\open\\command", item.prog_id), "");
        assert_eq!(command.as_deref(), Some(format!("\"{}\" \"%1\"", exe.display()).as_str()), "{}", item.prog_id);
    }

    // 6. Shortcuts under their old names; the library folder is there.
    assert!(sandbox.dir.join("profile").join("StartMenu").join(format!("{PRODUCT_NAME}.lnk")).exists());
    assert!(sandbox.dir.join("profile").join("Desktop").join(format!("{PRODUCT_NAME}.lnk")).exists());
    assert!(sandbox.dir.join("profile").join("Documents").join("StykAnimate").join("library").is_dir());

    // 7. --force-run started the new program.
    assert_eq!(wait_for(&install.join("launched.txt")), "--installer-test");

    // 8. Uninstalling removes the program and its registry entries, and keeps the library.
    let uninstaller = install.join("Uninstall StykAnimate.exe");
    let mut command = Command::new(&uninstaller);
    command.arg("/currentuser").arg("/S").raw_arg(format!("_?={}", install.display()));
    run(&mut command, "the uninstaller");
    assert!(!sandbox.registry.key_exists(&guid_key), "the uninstall entry is gone");
    assert!(!sandbox.registry.key_exists("Software\\Classes\\Pivot animation"));
    assert!(!sandbox.dir.join("profile").join("Desktop").join(format!("{PRODUCT_NAME}.lnk")).exists());
    assert!(sandbox.dir.join("profile").join("Documents").join("StykAnimate").join("library").is_dir(), "the library stays on uninstall");
}

#[test]
#[ignore = "builds and runs a Setup with makensis (sandboxed); run with --ignored"]
fn a_first_install_with_no_previous_version_and_a_second_run_over_it() {
    let root = repo_root();
    let sandbox = Sandbox::new("fresh");
    let install = sandbox.dir.join("Programs").join("StykAnimate");
    let files = sandbox.dir.join("files");
    lay_out(&files, &[]);
    let setup = sandbox.dir.join("Setup.exe");
    build(&sandbox, &root.join("packaging/windows/installer.nsi"), "2.0.0", &files, &setup, &[]);
    run_setup(&setup, &["/S", "/currentuser"], &install);
    assert!(install.join("StykAnimate.exe").exists());
    assert_eq!(sandbox.registry.read_text(&format!("{UNINSTALL}\\{APP_GUID}"), "DisplayVersion").as_deref(), Some("2.0.0"));
    // Running it again over itself upgrades in place through its own uninstaller.
    run_setup(&setup, &["--updated", "/S"], &install);
    assert!(install.join("StykAnimate.exe").exists() && install.join("Uninstall StykAnimate.exe").exists());
    assert_eq!(sandbox.registry.read_text(&format!("{UNINSTALL}\\{APP_GUID}"), "DisplayVersion").as_deref(), Some("2.0.0"));
}

#[test]
#[ignore = "builds a Setup with makensis; run with --ignored"]
fn the_setup_accepts_the_updaters_arguments_and_nothing_in_it_is_signed_or_published() {
    // Not a behaviour of the Setup but a guard on the process: this repository's packaging never signs or uploads.
    let script = std::fs::read_to_string(repo_root().join("packaging/windows/installer.nsi")).unwrap();
    for argument in ["--updated", "--force-run", "/allusers", "/currentuser"] {
        assert!(script.contains(argument), "the Setup reads {argument}");
    }
    for word in ["signtool", "SignTool", "upload", "curl"] {
        assert!(!script.contains(word), "{word}");
    }
}
