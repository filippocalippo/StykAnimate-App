//! `stykanimate://` links: `open`, `privacy`, `library` and `library/<public id>`. A link that starts the app waits
//! until the window exists; a link from a second launch goes to the first window (shell::instance).

use tauri::{AppHandle, Manager};

use super::{Shell, window};

/// What a link asks for, when it is one the app accepts.
#[derive(Debug, PartialEq, Eq)]
pub enum Link {
    Open,
    Privacy,
    /// The public library, or one of its assets (by public id).
    Library(Option<String>),
}

fn public_id(value: &str) -> bool {
    value.len() == 10 && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Parses a link under today's rules: no user, password, port, query or fragment.
pub fn parse(value: &str) -> Option<Link> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "stykanimate"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let host = url.host_str().unwrap_or("");
    let path = url.path();
    let root = path.is_empty() || path == "/";
    match host {
        "open" if root => Some(Link::Open),
        "privacy" if root => Some(Link::Privacy),
        "library" if root => Some(Link::Library(None)),
        "library" => {
            let asset = path.strip_prefix('/')?;
            let asset = asset.strip_suffix('/').unwrap_or(asset);
            (public_id(asset)).then(|| Link::Library(Some(asset.to_owned())))
        }
        _ => None,
    }
}

/// Handles a link: brings the window forward and tells the page. False when the link is not one the app accepts.
pub fn handle(app: &AppHandle, value: &str) -> bool {
    let Some(link) = parse(value) else { return false };
    let shell = app.state::<Shell>();
    let Some(main) = app.get_webview_window(window::MAIN) else {
        *shell.pending_link.lock().unwrap_or_else(|e| e.into_inner()) = Some(value.to_owned());
        return true;
    };
    if main.is_minimized().unwrap_or(false) {
        let _ = main.unminimize();
    }
    let _ = main.show();
    if !shell.background {
        let _ = main.set_focus();
    }
    match link {
        Link::Open => {}
        Link::Privacy => shell.send_action(app, "privacy"),
        Link::Library(asset) => {
            *shell.public_library_link.lock().unwrap_or_else(|e| e.into_inner()) = Some(asset.unwrap_or_default());
            shell.push(app, "styk:public-library-link", serde_json::Value::Null);
        }
    }
    true
}

/// Makes this copy the handler of `stykanimate://` for the current user, as Electron's
/// `setAsDefaultProtocolClient` did: `HKCU\Software\Classes\stykanimate`.
#[cfg(windows)]
pub fn register_scheme() {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.to_string_lossy().into_owned();
    let result = (|| -> std::io::Result<()> {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(r"Software\Classes\stykanimate")?;
        key.set_value("", &"URL:StykAnimate")?;
        key.set_value("URL Protocol", &"")?;
        let (command, _) = key.create_subkey(r"shell\open\command")?;
        command.set_value("", &format!("\"{exe}\" \"%1\""))?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("The stykanimate:// links could not be registered: {error}");
    }
}

#[cfg(not(windows))]
pub fn register_scheme() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_todays_links_only() {
        assert_eq!(parse("stykanimate://open"), Some(Link::Open));
        assert_eq!(parse("stykanimate://privacy/"), Some(Link::Privacy));
        assert_eq!(parse("stykanimate://library"), Some(Link::Library(None)));
        assert_eq!(parse("stykanimate://library/abcde12345"), Some(Link::Library(Some("abcde12345".into()))));
        assert_eq!(parse("stykanimate://library/abcde12345/"), Some(Link::Library(Some("abcde12345".into()))));
        assert_eq!(parse("stykanimate://library/ABCDE12345"), None);
        assert_eq!(parse("stykanimate://library/short"), None);
        assert_eq!(parse("stykanimate://open?x=1"), None);
        assert_eq!(parse("stykanimate://open#x"), None);
        assert_eq!(parse("stykanimate://user@open"), None);
        assert_eq!(parse("stykanimate://open:80"), None);
        assert_eq!(parse("stykanimate://other"), None);
        assert_eq!(parse("https://open"), None);
        assert_eq!(parse("stykanimate://open/x"), None);
    }
}
