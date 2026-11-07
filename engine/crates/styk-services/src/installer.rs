//! The file list of the Windows Setup, as the NSIS script includes it.
//!
//! The Setup installs exactly the files listed here and writes the same list into the installation (a manifest). The
//! native uninstaller removes those files and the folders they leave empty, and nothing else: it never deletes a
//! folder recursively, so a wrong install folder, an edited uninstall record or a user's own file next to the program
//! cannot be lost to it.
//!
//! The manifest is text, one entry per line: `F <relative path>` for a file, then `D <relative path>` for every folder
//! that holds files, deepest first (so removing them in order leaves the shallower ones empty before they are tried).

/// The name of the manifest inside the installation.
pub const MANIFEST_NAME: &str = "StykAnimate.files";

/// Escapes text for an NSIS double-quoted string.
pub fn nsis_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    for c in text.chars() {
        match c {
            '$' => out.push_str("$$"),
            '"' => out.push_str("$\\\""),
            '\r' => out.push_str("$\\r"),
            '\n' => out.push_str("$\\n"),
            '\t' => out.push_str("$\\t"),
            other => out.push(other),
        }
    }
    out
}

/// Whether a relative path from a manifest is safe to join onto the installation folder: not rooted, no drive, no
/// parent step, no wildcard, not empty.
pub fn is_safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with(['\\', '/'])
        && !path.contains([':', '*', '?', '"', '<', '>', '|', '\0'])
        && path.split(['\\', '/']).all(|part| !part.is_empty() && part != "." && part != "..")
}

/// The NSIS statements that install `files` (paths relative to `source`, with `\` separators) and write the manifest to
/// the open file handle `$manifest`. The caller has opened the manifest and closes it after.
pub fn files_script(source: &str, files: &[String]) -> String {
    let mut sorted: Vec<&String> = files.iter().collect();
    sorted.sort();
    let source = source.trim_end_matches(['\\', '/']);
    let mut out = String::new();
    let mut current: Option<&str> = None;
    let mut folders: Vec<String> = Vec::new();
    for file in sorted {
        let (folder, _) = file.rsplit_once('\\').unwrap_or(("", file));
        if current != Some(folder) {
            let target = if folder.is_empty() { "$INSTDIR".to_string() } else { format!("$INSTDIR\\{}", nsis_quote(folder)) };
            out.push_str(&format!("SetOutPath \"{target}\"\n"));
            current = Some(folder);
        }
        out.push_str(&format!("File \"{}\\{}\"\n", nsis_quote(source), nsis_quote(file)));
        out.push_str(&format!("FileWrite $manifest \"F {}$\\r$\\n\"\n", nsis_quote(file)));
        // Every folder on the way is the Setup's, however deep the file.
        let mut folder_path = String::new();
        for part in folder.split('\\').filter(|p| !p.is_empty()) {
            if !folder_path.is_empty() {
                folder_path.push('\\');
            }
            folder_path.push_str(part);
            if !folders.contains(&folder_path) {
                folders.push(folder_path.clone());
            }
        }
    }
    folders.sort_by(|a, b| b.matches('\\').count().cmp(&a.matches('\\').count()).then_with(|| a.cmp(b)));
    for folder in folders {
        out.push_str(&format!("FileWrite $manifest \"D {}$\\r$\\n\"\n", nsis_quote(&folder)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(files: &[&str]) -> Vec<String> {
        files.iter().map(|f| (*f).to_string()).collect()
    }

    #[test]
    fn every_file_is_installed_and_listed_and_folders_come_last_deepest_first() {
        let script = files_script("C:\\payload\\", &list(&["StykAnimate.exe", "LICENSE", "assets\\fonts\\inter.ttf", "assets\\logo.svg"]));
        assert!(script.contains("File \"C:\\payload\\StykAnimate.exe\""));
        assert!(script.contains("SetOutPath \"$INSTDIR\\assets\\fonts\"\nFile \"C:\\payload\\assets\\fonts\\inter.ttf\""));
        let manifest: Vec<&str> = script.lines().filter(|l| l.starts_with("FileWrite")).collect();
        assert_eq!(manifest.iter().filter(|l| l.contains("\"F ")).count(), 4);
        let folders: Vec<&&str> = manifest.iter().filter(|l| l.contains("\"D ")).collect();
        assert_eq!(folders.len(), 2, "assets and assets\\fonts");
        assert!(folders[0].contains("D assets\\fonts") && folders[1].contains("D assets$"), "deepest first: {folders:?}");
        let last_file = manifest.iter().rposition(|l| l.contains("\"F ")).unwrap();
        let first_folder = manifest.iter().position(|l| l.contains("\"D ")).unwrap();
        assert!(last_file < first_folder, "files before folders");
    }

    #[test]
    fn dollar_signs_and_quotes_in_names_cannot_become_nsis_syntax() {
        let script = files_script("C:\\pay$load", &list(&["a$(x).txt", "b\"c.txt"]));
        assert!(script.contains("File \"C:\\pay$$load\\a$$(x).txt\""), "{script}");
        assert!(script.contains("b$\\\"c.txt"), "{script}");
        assert!(!script.contains("a$(x)"), "an unescaped $( would be expanded by NSIS");
    }

    #[test]
    fn a_folder_with_no_files_is_not_listed_and_the_root_never_is() {
        let script = files_script("C:\\p", &list(&["a.txt"]));
        assert!(!script.contains("\"D "), "{script}");
    }

    #[test]
    fn only_plain_relative_paths_are_safe_to_remove() {
        for ok in ["a.txt", "sub\\a.txt", "sub/a.txt", "a b\\c.d"] {
            assert!(is_safe_relative(ok), "{ok}");
        }
        for bad in ["", "\\a", "/a", "C:\\a", "..\\a", "a\\..\\b", ".", "a\\.\\b", "a\\\\b", "a*", "a?b", "a\"b", "a|b", "\\\\server\\share"] {
            assert!(!is_safe_relative(bad), "{bad}");
        }
    }
}
