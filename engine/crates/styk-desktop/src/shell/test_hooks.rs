//! What the desktop smokes put in place of the person and the outside world. Electron's smokes replaced main-process
//! functions (`dialog.showMessageBox`, `shell.openExternal`); this app has no main process to reach, so the native
//! side asks these hooks instead.
//!
//! They exist only in development and developer builds (`debug_assertions` or the `devtools` feature): the
//! shipping build compiles [`folder`] to `None`. `STYK_TEST_HOOKS` names a folder:
//!
//! - `answers.json`: `{"<kind>": [answer, ...]}`, answers taken in order, one per question. Kinds: `message` (the
//!   unsaved-work question: `"save"`, `"cancel"` or `"discard"`), and those other areas add (`save`, `open`: a path
//!   or null for a cancelled dialog).
//! - `events.jsonl`: one JSON line per thing that would have left the app: `{"kind": "open-url", "value": url}`,
//!   `{"kind": "error-box", ...}`, `{"kind": "update-install", ...}`.
//! - `update.json`: `{"version": "9.9.9", "stepMs": 200}` stands in for the update feed: a check finds that version
//!   and "downloads" it in steps; Restart to update records `update-install` instead of running an installer.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value, json};

static FILES: Mutex<()> = Mutex::new(());

/// The hooks folder, when this build has hooks and the smoke named one.
pub fn folder() -> Option<PathBuf> {
    if cfg!(any(debug_assertions, feature = "devtools")) {
        std::env::var_os("STYK_TEST_HOOKS").filter(|v| !v.is_empty()).map(PathBuf::from)
    } else {
        None
    }
}

/// Reads one JSON file of the hooks folder.
pub fn read(name: &str) -> Option<Value> {
    let path = folder()?.join(name);
    let _guard = FILES.lock().unwrap_or_else(|e| e.into_inner());
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Takes the next answer of `kind` (`None`: the hooks give none, so the real question is asked).
pub fn take_answer(kind: &str) -> Option<Value> {
    let path = folder()?.join("answers.json");
    let _guard = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let mut answers: Map<String, Value> = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
    let list = answers.get_mut(kind)?.as_array_mut()?;
    if list.is_empty() {
        return None;
    }
    let answer = list.remove(0);
    let _ = std::fs::write(&path, serde_json::to_vec(&answers).unwrap_or_default());
    Some(answer)
}

/// Records something that would have left the app. True when the hooks took it (so the real action is skipped).
pub fn record(kind: &str, value: Value) -> bool {
    let Some(folder) = folder() else { return false };
    let _guard = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let line = format!("{}\n", json!({"kind": kind, "value": value}));
    use std::io::Write;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(folder.join("events.jsonl"))
        .and_then(|mut file| file.write_all(line.as_bytes()))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_are_taken_in_order_and_events_recorded() {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: this test alone sets the variable, and no other test reads it.
        unsafe { std::env::set_var("STYK_TEST_HOOKS", dir.path()) };
        std::fs::write(dir.path().join("answers.json"), r#"{"message":["cancel","save"]}"#).unwrap();
        assert_eq!(take_answer("message"), Some(Value::from("cancel")));
        assert_eq!(take_answer("message"), Some(Value::from("save")));
        assert_eq!(take_answer("message"), None);
        assert_eq!(take_answer("save"), None);
        assert!(record("open-url", "https://ko-fi.com/Q5Q41WY7QC".into()));
        let events = std::fs::read_to_string(dir.path().join("events.jsonl")).unwrap();
        assert!(events.contains("ko-fi"));
        unsafe { std::env::remove_var("STYK_TEST_HOOKS") };
    }
}
