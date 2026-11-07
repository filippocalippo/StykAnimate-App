//! Handing over to the installer: where the program is installed, whether the installer needs elevation, what it is
//! run with, and what a failure to start it means.
//!
//! Arguments are electron-updater's for an NSIS installer (`NsisUpdater.js`, `doInstall`): `--updated`, `/S` for a
//! silent run, `--force-run` to start the program again afterwards, and `/D=<directory>` to install where the
//! program is. `/D` must be the last argument, which NSIS requires.

/// Who the program is installed for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallScope {
    /// Under the user's profile; no elevation.
    CurrentUser,
    /// For every user, in Program Files; replacing it needs elevation.
    AllUsers,
}

/// How to run the installer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallPlan {
    /// The scope the update installs into.
    pub scope: InstallScope,
    /// Run it elevated (the `runas` verb).
    pub elevate: bool,
    /// The arguments, `/D=` last.
    pub args: Vec<String>,
}

/// The installer's arguments and elevation for an install of `scope` in `install_dir`, from a process that is or is
/// not already elevated.
pub fn install_plan(scope: InstallScope, process_elevated: bool, install_dir: &str) -> InstallPlan {
    // The installer is told which installation it updates: with both a per-user and an all-users install present it would
    // otherwise pick one of them, and might replace the wrong one.
    let scope_flag = if scope == InstallScope::AllUsers { "/allusers" } else { "/currentuser" };
    let mut args = vec!["--updated".to_string(), "/S".to_string(), "--force-run".to_string(), scope_flag.to_string()];
    args.push(format!("/D={}", install_dir.trim_end_matches(['\\', '/'])));
    InstallPlan { scope, elevate: scope == InstallScope::AllUsers && !process_elevated, args }
}

fn same_directory(a: &str, b: &str) -> bool {
    let normal = |s: &str| s.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase();
    !a.is_empty() && normal(a) == normal(b)
}

/// The scope of the install this program runs from: the one whose recorded install location (`InstallLocation` under
/// the installer's key, in `HKCU` or `HKLM`) is the program's own directory. `None` when neither is: a copy that was
/// not installed by the Setup (portable, or run from a build folder).
pub fn detect_scope(current_user_location: Option<&str>, all_users_location: Option<&str>, program_dir: &str) -> Option<InstallScope> {
    if current_user_location.is_some_and(|dir| same_directory(dir, program_dir)) {
        Some(InstallScope::CurrentUser)
    } else if all_users_location.is_some_and(|dir| same_directory(dir, program_dir)) {
        Some(InstallScope::AllUsers)
    } else {
        None
    }
}

/// What starting the installer led to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Handoff {
    /// The installer process is running: the program may quit now.
    Started,
    /// The person declined the elevation prompt.
    ElevationDeclined,
    /// It could not be started: the message names why.
    Failed(String),
}

impl Handoff {
    /// Whether the program should quit. Only a started installer lets it go; anything else leaves the program running
    /// with its update still ready.
    pub fn quit_now(&self) -> bool {
        matches!(self, Handoff::Started)
    }
}

/// Windows' "the operation was cancelled by the user" (`ERROR_CANCELLED`), what a declined UAC prompt returns.
pub const ERROR_CANCELLED: u32 = 1223;

/// Reads the error code of a failed `ShellExecuteEx`/`CreateProcess` into a [`Handoff`].
pub fn handoff_from_error(code: u32, what: &str) -> Handoff {
    if code == ERROR_CANCELLED { Handoff::ElevationDeclined } else { Handoff::Failed(format!("{what} (error {code})")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_arguments_are_electron_updaters_with_the_directory_last() {
        let plan = install_plan(InstallScope::CurrentUser, false, "C:\\Users\\me\\AppData\\Local\\Programs\\StykAnimate\\");
        assert_eq!(plan.args, ["--updated", "/S", "--force-run", "/currentuser", "/D=C:\\Users\\me\\AppData\\Local\\Programs\\StykAnimate"]);
        assert!(!plan.elevate);
    }

    #[test]
    fn the_installer_is_told_which_install_it_updates() {
        let user = install_plan(InstallScope::CurrentUser, false, "C:\\Users\\me\\StykAnimate");
        let all = install_plan(InstallScope::AllUsers, true, "C:\\Program Files\\StykAnimate");
        assert!(user.args.contains(&"/currentuser".to_string()) && !user.args.contains(&"/allusers".to_string()), "{:?}", user.args);
        assert!(all.args.contains(&"/allusers".to_string()) && !all.args.contains(&"/currentuser".to_string()), "{:?}", all.args);
        assert!(user.args.last().is_some_and(|a| a.starts_with("/D=")) && all.args.last().is_some_and(|a| a.starts_with("/D=")), "/D= stays last");
    }

    #[test]
    fn an_all_users_install_elevates_a_standard_process_and_not_an_elevated_one() {
        assert!(install_plan(InstallScope::AllUsers, false, "C:\\Program Files\\StykAnimate").elevate);
        assert!(!install_plan(InstallScope::AllUsers, true, "C:\\Program Files\\StykAnimate").elevate);
        assert!(!install_plan(InstallScope::CurrentUser, false, "C:\\x").elevate, "a current-user install never needs the prompt");
    }

    #[test]
    fn the_scope_is_the_install_whose_location_is_this_program() {
        let here = "C:\\Users\\me\\AppData\\Local\\Programs\\StykAnimate";
        assert_eq!(detect_scope(Some("c:/users/me/appdata/local/programs/stykanimate/"), None, here), Some(InstallScope::CurrentUser));
        assert_eq!(detect_scope(None, Some("C:\\Program Files\\StykAnimate"), "C:\\Program Files\\StykAnimate"), Some(InstallScope::AllUsers));
        assert_eq!(detect_scope(Some("C:\\Other"), Some("C:\\Else"), here), None, "a copy outside both installs is not updated in place");
        assert_eq!(detect_scope(Some(""), None, ""), None);
    }

    #[test]
    fn only_a_started_installer_lets_the_program_quit() {
        assert!(Handoff::Started.quit_now());
        assert!(!handoff_from_error(ERROR_CANCELLED, "start the installer").quit_now());
        assert_eq!(handoff_from_error(ERROR_CANCELLED, "x"), Handoff::ElevationDeclined);
        assert!(matches!(handoff_from_error(5, "start the installer"), Handoff::Failed(m) if m.contains("error 5")));
    }
}
