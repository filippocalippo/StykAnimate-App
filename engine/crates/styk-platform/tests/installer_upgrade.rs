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
    if script.file_name().is_some_and(|n| n == "installer.nsi") {
        // The Setup installs the files of a generated list and writes the manifest of them: the same tool that packages it.
        let list = out.with_extension("files.nsh");
        let example = payload_exe().with_file_name("release_feed.exe");
        run(Command::new(example).arg("files-script").arg("--source").arg(source).arg("--out").arg(&list), "release_feed files-script");
        command.arg(format!("/DFILES_SCRIPT={}", list.display()));
    }
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

fn setup_command(setup: &Path, arguments: &[&str], install_dir: &Path) -> Command {
    let mut command = Command::new(setup);
    command.args(arguments).raw_arg(format!("/D={}", install_dir.display()));
    command
}

fn native_setup(sandbox: &Sandbox, name: &str, version: &str) -> PathBuf {
    let files = sandbox.dir.join(format!("native-files-{name}"));
    lay_out(&files, &[("LICENSE", "license")]);
    let setup = sandbox.dir.join(format!("Native-Setup-{name}.exe"));
    let mut extra = Vec::new();
    if let Some(plugins) = plugins() {
        extra.push(format!("/DPLUGIN_DIR={}", plugins.display()));
    }
    build(sandbox, &repo_root().join("packaging/windows/installer.nsi"), version, &files, &setup, &extra);
    setup
}

fn electron_install(sandbox: &Sandbox, at: &Path) {
    let files = sandbox.dir.join("electron-files");
    lay_out(&files, &[("resources\\app.asar", "old"), ("chrome_100_percent.pak", "old")]);
    let setup = sandbox.dir.join("Electron-Setup.exe");
    build(sandbox, &repo_root().join("packaging/windows/test/electron-fixture.nsi"), "1.1.0", &files, &setup, &[]);
    run_setup(&setup, &["/S"], at);
}

#[test]
#[ignore = "builds and runs Setups with makensis (sandboxed); run with --ignored"]
fn an_upgrade_into_another_folder_removes_the_old_install_where_it_is_and_never_empties_the_new_folder() {
    let sandbox = Sandbox::new("moved");
    let (old, new) = (sandbox.dir.join("Programs").join("A"), sandbox.dir.join("Programs").join("B"));
    let guid_key = format!("{UNINSTALL}\\{APP_GUID}");
    electron_install(&sandbox, &old);
    let setup = native_setup(&sandbox, "moved", "2.0.0");

    // 1. The new folder holds someone's files: the Setup refuses, and neither folder is touched.
    std::fs::create_dir_all(&new).unwrap();
    std::fs::write(new.join("keep.txt"), "somebody's file").unwrap();
    let refused = setup_command(&setup, &["--updated", "/S"], &new).status().unwrap();
    assert!(!refused.success(), "a non-empty folder that is not ours is refused");
    assert_eq!(std::fs::read_to_string(new.join("keep.txt")).unwrap(), "somebody's file", "the folder's own files were not deleted");
    assert!(old.join("resources").join("app.asar").exists(), "the old install was not touched by the refused Setup");
    assert_eq!(sandbox.registry.read_text(&guid_key, "DisplayVersion").as_deref(), Some("1.1.0"));

    // 2. An empty new folder works: the old install goes from where it is, the new one lands in the new folder.
    std::fs::remove_file(new.join("keep.txt")).unwrap();
    run_setup(&setup, &["--updated", "/S"], &new);
    assert!(!old.join("resources").exists() && !old.join("chrome_100_percent.pak").exists(), "the old install's files are gone from the old folder");
    assert!(new.join("StykAnimate.exe").exists() && new.join("Uninstall StykAnimate.exe").exists());
    assert_eq!(sandbox.registry.read_text(&guid_key, "InstallLocation").as_deref(), Some(new.to_str().unwrap()));
    assert_eq!(sandbox.registry.read_text(&guid_key, "DisplayVersion").as_deref(), Some("2.0.0"));
    // The link the Electron app registered at run time now opens the new program.
    assert_eq!(
        sandbox.registry.read_text("Software\\Classes\\stykanimate\\shell\\open\\command", "").as_deref(),
        Some(format!("\"{}\" \"%1\"", new.join("StykAnimate.exe").display()).as_str()),
        "the link's command was rewritten for the new install"
    );
}

#[test]
#[ignore = "builds and runs Setups with makensis (sandboxed); run with --ignored"]
fn a_fresh_install_registers_the_link_and_uninstalling_removes_it() {
    let sandbox = Sandbox::new("link");
    let install = sandbox.dir.join("Programs").join("StykAnimate");
    let setup = native_setup(&sandbox, "link", "2.0.0");
    run_setup(&setup, &["/S", "/currentuser"], &install);
    let key = "Software\\Classes\\stykanimate";
    assert_eq!(sandbox.registry.read_text(key, "").as_deref(), Some("URL:stykanimate"));
    assert_eq!(sandbox.registry.read_text(key, "URL Protocol").as_deref(), Some(""));
    assert_eq!(sandbox.registry.read_text(&format!("{key}\\shell\\open\\command"), "").as_deref(), Some(format!("\"{}\" \"%1\"", install.join("StykAnimate.exe").display()).as_str()));
    let mut uninstall = Command::new(install.join("Uninstall StykAnimate.exe"));
    uninstall.arg("/currentuser").arg("/S").raw_arg(format!("_?={}", install.display()));
    run(&mut uninstall, "the uninstaller");
    assert!(!sandbox.registry.key_exists(key), "the link is released on uninstall");
}

#[test]
#[ignore = "builds and runs Setups with makensis (sandboxed); run with --ignored"]
fn two_setups_started_together_do_not_both_work_on_the_install() {
    let sandbox = Sandbox::new("twice-at-once");
    let install = sandbox.dir.join("Programs").join("StykAnimate");
    electron_install(&sandbox, &install);
    let setup = native_setup(&sandbox, "race", "2.0.0");
    let mut first = setup_command(&setup, &["--updated", "/S"], &install).spawn().unwrap();
    std::thread::sleep(Duration::from_millis(400));
    let second = setup_command(&setup, &["--updated", "/S"], &install).status().unwrap();
    let first = first.wait().unwrap();
    assert_eq!(second.code(), Some(4), "the second Setup refuses: another Setup is working on the install");
    assert!(first.success(), "the first Setup is not disturbed");
    assert_eq!(sandbox.registry.read_text(&format!("{UNINSTALL}\\{APP_GUID}"), "DisplayVersion").as_deref(), Some("2.0.0"));
    assert!(install.join("StykAnimate.exe").exists() && !install.join("resources").exists());
}

fn electron_install_machine(sandbox: &Sandbox, at: &Path) {
    let files = sandbox.dir.join("electron-files-machine");
    lay_out(&files, &[("resources\\app.asar", "old"), ("chrome_100_percent.pak", "old")]);
    let setup = sandbox.dir.join("Electron-Setup-machine.exe");
    build(sandbox, &repo_root().join("packaging/windows/test/electron-fixture.nsi"), "1.1.0", &files, &setup, &["/DMACHINE".to_string()]);
    run_setup(&setup, &["/S"], at);
}

fn set_text(sandbox: &Sandbox, key: &str, name: &str, value: &str) {
    use styk_services::shell::associations::{RegOp, Registry, Value};
    let mut registry = sandbox.registry.clone();
    registry.apply(&[RegOp::Set { key: key.to_string(), name: name.to_string(), value: Value::Text(value.to_string()) }]).unwrap();
}

#[test]
#[ignore = "builds and runs Setups with makensis (sandboxed); run with --ignored"]
fn an_uninstall_record_pointed_at_an_unrelated_folder_deletes_nothing() {
    // The reproduction: install at A, copy its uninstaller beside someone's file in B, point only UninstallString at B, then
    // run the Setup for C. The old uninstaller (which deletes recursively) must never be run on B.
    let sandbox = Sandbox::new("record");
    let root = sandbox.dir.join("Programs");
    let (a, b, c) = (root.join("A"), root.join("B"), root.join("C"));
    let guid_key = format!("{UNINSTALL}\\{APP_GUID}");
    electron_install(&sandbox, &a);
    std::fs::create_dir_all(&b).unwrap();
    std::fs::copy(a.join("Uninstall StykAnimate.exe"), b.join("Uninstall StykAnimate.exe")).unwrap();
    std::fs::write(b.join("keep.txt"), "a personal file").unwrap();
    set_text(&sandbox, &guid_key, "UninstallString", &format!("\"{}\" /currentuser", b.join("Uninstall StykAnimate.exe").display()));
    let setup = native_setup(&sandbox, "record", "2.0.0");

    let status = setup_command(&setup, &["--updated", "/S", "/currentuser"], &c).status().unwrap();
    assert_eq!(status.code(), Some(5), "a record whose uninstaller is in another folder than InstallLocation is refused");
    assert_eq!(std::fs::read_to_string(b.join("keep.txt")).unwrap(), "a personal file", "B's file is still there");
    assert!(a.join("StykAnimate.exe").exists() && a.join("resources").join("app.asar").exists(), "A is untouched");
    assert!(!c.exists(), "nothing was installed");

    // The other inconsistencies, each refused with nothing deleted: InstallLocation naming B while the uninstaller is in A;
    // a consistent record for a folder that has no sign of being an installation of ours; an uninstaller with another name.
    set_text(&sandbox, &guid_key, "UninstallString", &format!("\"{}\" /currentuser", a.join("Uninstall StykAnimate.exe").display()));
    set_text(&sandbox, &format!("Software\\{APP_GUID}"), "InstallLocation", b.to_str().unwrap());
    assert_eq!(setup_command(&setup, &["--updated", "/S", "/currentuser"], &c).status().unwrap().code(), Some(5), "InstallLocation and the uninstaller disagree");

    std::fs::copy(payload_exe(), b.join("StykAnimate.exe")).unwrap();
    set_text(&sandbox, &guid_key, "UninstallString", &format!("\"{}\" /currentuser", b.join("Uninstall StykAnimate.exe").display()));
    assert_eq!(setup_command(&setup, &["--updated", "/S", "/currentuser"], &c).status().unwrap().code(), Some(5), "a consistent record for a folder with no installation evidence");

    std::fs::copy(b.join("Uninstall StykAnimate.exe"), b.join("Other.exe")).unwrap();
    set_text(&sandbox, &guid_key, "UninstallString", &format!("\"{}\" /currentuser", b.join("Other.exe").display()));
    assert_eq!(setup_command(&setup, &["--updated", "/S", "/currentuser"], &c).status().unwrap().code(), Some(5), "an uninstaller that is not today's");

    assert_eq!(std::fs::read_to_string(b.join("keep.txt")).unwrap(), "a personal file");
    assert!(a.join("resources").join("app.asar").exists() && !c.exists());
}

#[test]
#[ignore = "builds and runs Setups with makensis (sandboxed); run with --ignored"]
fn a_portable_copy_beside_a_personal_file_is_not_an_installation_to_replace_or_remove() {
    let sandbox = Sandbox::new("portable");
    let b = sandbox.dir.join("Documents").join("tools");
    std::fs::create_dir_all(&b).unwrap();
    std::fs::copy(payload_exe(), b.join("StykAnimate.exe")).unwrap();
    std::fs::write(b.join("thesis.txt"), "my thesis").unwrap();
    let setup = native_setup(&sandbox, "portable", "2.0.0");
    let status = setup_command(&setup, &["/S", "/currentuser"], &b).status().unwrap();
    assert_eq!(status.code(), Some(3), "a folder with files in it that is not the installation being replaced is refused");
    assert_eq!(std::fs::read_to_string(b.join("thesis.txt")).unwrap(), "my thesis");
    assert!(b.join("StykAnimate.exe").exists());
    assert!(!sandbox.registry.key_exists(&format!("{UNINSTALL}\\{APP_GUID}")), "nothing was registered against it");
}

#[test]
#[ignore = "builds and runs Setups with makensis (sandboxed); run with --ignored"]
fn the_native_uninstaller_removes_what_the_setup_installed_and_nothing_else() {
    let sandbox = Sandbox::new("manifest");
    let a = sandbox.dir.join("Programs").join("A");
    let files = sandbox.dir.join("files-manifest");
    lay_out(&files, &[("LICENSE", "l"), ("assets\\fonts\\inter.ttf", "f"), ("assets\\logo.svg", "s")]);
    let setup = sandbox.dir.join("Setup.exe");
    build(&sandbox, &repo_root().join("packaging/windows/installer.nsi"), "2.0.0", &files, &setup, &plugins().map(|p| vec![format!("/DPLUGIN_DIR={}", p.display())]).unwrap_or_default());
    run_setup(&setup, &["/S", "/currentuser"], &a);
    assert!(a.join("assets").join("fonts").join("inter.ttf").exists() && a.join("StykAnimate.files").exists());

    // The user adds their own files, in the program's folder and in a folder of the program's.
    std::fs::write(a.join("notes.txt"), "mine").unwrap();
    std::fs::create_dir_all(a.join("sub")).unwrap();
    std::fs::write(a.join("sub").join("mine.txt"), "mine too").unwrap();
    std::fs::write(a.join("assets").join("my-logo.png"), "mine").unwrap();

    // A copy of the uninstaller run from a folder with a personal file and no manifest deletes nothing there, and does not
    // unregister the real installation either.
    let x = sandbox.dir.join("elsewhere");
    std::fs::create_dir_all(&x).unwrap();
    std::fs::copy(a.join("Uninstall StykAnimate.exe"), x.join("Uninstall StykAnimate.exe")).unwrap();
    std::fs::write(x.join("keep.txt"), "keep").unwrap();
    let mut stray = Command::new(x.join("Uninstall StykAnimate.exe"));
    stray.arg("/currentuser").arg("/S").raw_arg(format!("_?={}", x.display()));
    run(&mut stray, "the uninstaller run from another folder");
    assert_eq!(std::fs::read_to_string(x.join("keep.txt")).unwrap(), "keep");
    assert!(sandbox.registry.key_exists(&format!("{UNINSTALL}\\{APP_GUID}")), "the real installation is still registered");

    let mut uninstall = Command::new(a.join("Uninstall StykAnimate.exe"));
    uninstall.arg("/currentuser").arg("/S").raw_arg(format!("_?={}", a.display()));
    run(&mut uninstall, "the uninstaller");
    assert!(!a.join("StykAnimate.exe").exists() && !a.join("LICENSE").exists() && !a.join("assets").join("fonts").exists() && !a.join("assets").join("logo.svg").exists(), "the program's own files are gone");
    assert_eq!(std::fs::read_to_string(a.join("notes.txt")).unwrap(), "mine");
    assert_eq!(std::fs::read_to_string(a.join("sub").join("mine.txt")).unwrap(), "mine too");
    assert_eq!(std::fs::read_to_string(a.join("assets").join("my-logo.png")).unwrap(), "mine", "a folder that still holds a personal file stays");
    assert!(!sandbox.registry.key_exists(&format!("{UNINSTALL}\\{APP_GUID}")));
}

#[test]
#[ignore = "builds and runs Setups with makensis (sandboxed); run with --ignored"]
fn with_both_scopes_installed_a_legacy_updater_naming_the_machine_install_replaces_that_one() {
    // Today's Electron updater passes /D=<running installation> and no scope flag. The scope is the one whose registration
    // names that folder: the machine's install is replaced, the user's install is left alone.
    let sandbox = Sandbox::new("scopes");
    let (user, machine) = (sandbox.dir.join("Programs").join("user"), sandbox.dir.join("Programs").join("machine"));
    electron_install(&sandbox, &user);
    electron_install_machine(&sandbox, &machine);
    let setup = native_setup(&sandbox, "scopes", "2.0.0");
    let guid_key = format!("{UNINSTALL}\\{APP_GUID}");
    run_setup(&setup, &["--updated", "/S"], &machine);

    assert!(machine.join("StykAnimate.exe").exists() && !machine.join("resources").exists(), "the machine install was replaced");
    assert_eq!(sandbox.registry.read_text(&format!("HKLM\\{guid_key}"), "DisplayVersion").as_deref(), Some("2.0.0"));
    assert_eq!(sandbox.registry.read_text(&format!("HKLM\\Software\\{APP_GUID}"), "InstallLocation").as_deref(), Some(machine.to_str().unwrap()));
    assert!(user.join("resources").join("app.asar").exists(), "the user's install was not removed");
    assert_eq!(sandbox.registry.read_text(&guid_key, "DisplayVersion").as_deref(), Some("1.1.0"), "and is still registered as it was");
    assert_eq!(sandbox.registry.read_text(&format!("Software\\{APP_GUID}"), "InstallLocation").as_deref(), Some(user.to_str().unwrap()));

    // An explicit scope without a destination keeps that scope's own folder.
    run(Command::new(&setup).args(["--updated", "/S", "/currentuser"]), "the Setup");
    assert!(user.join("StykAnimate.exe").exists() && !user.join("resources").exists(), "/currentuser updated the user's install in the user's folder");
    assert_eq!(sandbox.registry.read_text(&guid_key, "DisplayVersion").as_deref(), Some("2.0.0"));
    assert_eq!(sandbox.registry.read_text(&format!("Software\\{APP_GUID}"), "InstallLocation").as_deref(), Some(user.to_str().unwrap()));
}

#[test]
#[ignore = "builds and runs Setups with makensis (sandboxed); run with --ignored"]
fn a_lock_that_cannot_be_taken_stops_the_setup_before_it_changes_anything() {
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
    use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let sandbox = Sandbox::new("lock");
    let install = sandbox.dir.join("Programs").join("StykAnimate");
    let setup = native_setup(&sandbox, "lock", "2.0.0");
    // Somebody holds the Setup's lock name with an access list that lets nobody else open it: acquiring it fails, and a
    // Setup that goes on regardless would be working unprotected.
    let user = std::env::var("USERNAME").unwrap();
    let name: Vec<u16> = format!("Global\\StykAnimateSetup-user-{user}-{APP_GUID}-{}\0", sandbox.id).encode_utf16().collect();
    let sddl: Vec<u16> = "D:P\0".encode_utf16().collect();
    // SAFETY: a descriptor from a fixed string, a mutex made with it, both released at the end of the test.
    let (mutex, descriptor) = unsafe {
        let mut descriptor = std::ptr::null_mut();
        assert_ne!(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut()), 0);
        let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor, bInheritHandle: 0 };
        (CreateMutexW(&attributes, 0, name.as_ptr()), descriptor)
    };
    assert!(!mutex.is_null());
    let status = setup_command(&setup, &["/S", "/currentuser"], &install).status().unwrap();
    // SAFETY: closing what was made above.
    unsafe {
        CloseHandle(mutex);
        LocalFree(descriptor);
    }
    assert_eq!(status.code(), Some(6), "an exclusion that cannot be taken is a refusal");
    assert!(!install.exists(), "nothing was installed");
    assert!(!sandbox.registry.key_exists(&format!("{UNINSTALL}\\{APP_GUID}")));
    // Once nobody holds it, the same Setup works.
    run_setup(&setup, &["/S", "/currentuser"], &install);
    assert!(install.join("StykAnimate.exe").exists());
}

/// A release server for one version: the "latest" alias redirects to the tag; the feed, its signature and the Setup are
/// files of the tag.
fn serve_release(tag: &'static str, files: Vec<(String, Vec<u8>)>) -> (String, std::sync::Arc<std::sync::atomic::AtomicBool>) {
    let http = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let base = format!("http://{}", http.server_addr().to_ip().unwrap());
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let halt = stop.clone();
    std::thread::spawn(move || {
        while !halt.load(std::sync::atomic::Ordering::SeqCst) {
            let Ok(Some(request)) = http.recv_timeout(Duration::from_millis(50)) else { continue };
            let url = request.url().to_string();
            if url == "/o/r/releases/latest/download/latest.yml" {
                let location = format!("/o/r/releases/download/{tag}/latest.yml");
                let _ = request.respond(tiny_http::Response::empty(302).with_header(tiny_http::Header::from_bytes("Location", location).unwrap()));
                continue;
            }
            let name = url.rsplit('/').next().unwrap_or("");
            match files.iter().find(|(n, _)| n == name) {
                Some((_, body)) if url.starts_with(&format!("/o/r/releases/download/{tag}/")) => {
                    let _ = request.respond(tiny_http::Response::from_data(body.clone()));
                }
                _ => {
                    let _ = request.respond(tiny_http::Response::empty(404));
                }
            }
        }
    });
    (base, stop)
}

#[test]
#[ignore = "builds and runs a Setup with makensis (sandboxed); run with --ignored"]
fn the_updater_finds_downloads_verifies_and_runs_the_setup_end_to_end() {
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use styk_platform::windows::updates::{Ed25519Integrity, HeldInstaller, HttpFeed, HttpStage, launch_installer, sha512_base64};
    use styk_services::updates::feed::{Endpoint, Version};
    use styk_services::updates::flow::{CheckOutcome, run_check};
    use styk_services::updates::plan::{Handoff, InstallScope, install_plan};
    use styk_services::updates::state::{UpdateState, UpdateStatus};

    let root = repo_root();
    let sandbox = Sandbox::new("updater");
    let install = sandbox.dir.join("Programs").join("StykAnimate");
    let guid_key = format!("{UNINSTALL}\\{APP_GUID}");

    // The installed copy (an Electron-style 1.1.0) and the release it will update to.
    let electron_files = sandbox.dir.join("electron-files");
    lay_out(&electron_files, &[("resources\\app.asar", "old")]);
    let electron_setup = sandbox.dir.join("Electron-Setup.exe");
    build(&sandbox, &root.join("packaging/windows/test/electron-fixture.nsi"), "1.1.0", &electron_files, &electron_setup, &[]);
    run_setup(&electron_setup, &["/S"], &install);

    let native_files = sandbox.dir.join("native-files");
    lay_out(&native_files, &[("LICENSE", "license")]);
    let release = sandbox.dir.join("release");
    std::fs::create_dir_all(&release).unwrap();
    let setup = release.join("StykAnimate-2.0.0-Setup-x64.exe");
    build(&sandbox, &root.join("packaging/windows/installer.nsi"), "2.0.0", &native_files, &setup, &[]);
    let sha512 = sha512_base64(&setup, &|| false).unwrap().unwrap();
    let size = std::fs::metadata(&setup).unwrap().len();
    let yml = format!("version: 2.0.0\nfiles:\n  - url: StykAnimate-2.0.0-Setup-x64.exe\n    sha512: {sha512}\n    size: {size}\npath: StykAnimate-2.0.0-Setup-x64.exe\nsha512: {sha512}\n");
    let pair = Ed25519KeyPair::from_seed_unchecked(&[3u8; 32]).unwrap();
    let public: [u8; 32] = pair.public_key().as_ref().try_into().unwrap();
    let signature = pair.sign(yml.as_bytes());
    let (base, stop) = serve_release("v2.0.0", vec![("latest.yml".into(), yml.into_bytes()), ("latest.yml.sig".into(), signature.as_ref().to_vec()), ("StykAnimate-2.0.0-Setup-x64.exe".into(), std::fs::read(&setup).unwrap())]);

    let endpoint = Endpoint { base, owner: "o".into(), repo: "r".into() };
    let mut state = UpdateState::new("1.1.0", None);
    let started = Instant::now();
    let outcome = run_check(
        &mut state,
        &Version::parse("1.1.0").unwrap(),
        &HttpFeed { endpoint: endpoint.clone() },
        &Ed25519Integrity::new(Some(public)),
        &HttpStage { root: sandbox.dir.join("updates"), endpoint },
        &|| started.elapsed().as_millis() as u64,
        &|| false,
        &mut |_| {},
    );
    let CheckOutcome::Ready { installer, version, file } = outcome else { panic!("the check ended with {outcome:?}") };
    assert_eq!((version.as_str(), state.status), ("2.0.0", UpdateStatus::Ready));
    println!("check, download and verify of a {size} byte Setup took {:?}", started.elapsed());

    // The restart: the verified file is held, the plan is a current-user install (no elevation), the Setup runs.
    let held = HeldInstaller::open_verified(&installer, &file, &|| false).expect("the staged file is the one the feed describes");
    let plan = install_plan(InstallScope::CurrentUser, false, install.to_str().unwrap());
    assert!(!plan.elevate);
    assert_eq!(launch_installer(&held, &plan), Handoff::Started);
    assert_eq!(wait_for(&install.join("launched.txt")), "--installer-test", "the new program was started by --force-run");
    assert_eq!(sandbox.registry.read_text(&guid_key, "DisplayVersion").as_deref(), Some("2.0.0"));
    assert!(!install.join("resources").exists(), "the old install's files are gone");
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
}
