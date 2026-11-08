//! Developer commands only; keep separate from the concurrently maintained guards.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn command(program: &str, args: &[String]) -> String {
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(quoted)
        .collect::<Vec<_>>()
        .join(" ")
}
struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn tail(mut input: impl Read) -> Result<Vec<u8>, String> {
    let mut kept = Vec::with_capacity(65536);
    let mut scratch = [0; 4096];
    loop {
        let n = input.read(&mut scratch).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(kept);
        }
        if kept.len() + n > 65536 {
            kept.drain(..kept.len() + n - 65536);
        }
        kept.extend_from_slice(&scratch[..n]);
    }
}
fn execute(root: &Path, program: &str, args: &[String], heavy: bool) -> Result<String, String> {
    let mut lock = None;
    let mut cmd;
    if heavy && std::env::var_os("STYK_QUEUE_ACTIVE").is_none() {
        if let Ok(prefix) = std::env::var("STYK_QUEUE_CMD") {
            cmd = Command::new("bash");
            cmd.args([
                "-c",
                &format!("{prefix} {}", quoted(&command(program, args))),
            ]);
        } else {
            let path = root.join("artifacts/devtools-heavy.lock");
            fs::create_dir_all(path.parent().ok_or("lock has no parent")?)
                .map_err(|e| e.to_string())?;
            let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_|"another heavy developer task owns artifacts/devtools-heavy.lock; use STYK_QUEUE_CMD")?;
            writeln!(file, "{}", std::process::id()).map_err(|e| e.to_string())?;
            lock = Some(Lock(path));
            cmd = Command::new(program);
            cmd.args(args);
        }
    } else {
        cmd = Command::new(program);
        cmd.args(args);
    }
    let mut child = cmd
        .current_dir(root)
        .env("STYK_BACKGROUND_WINDOW", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;
    let stdout = child.stdout.take().ok_or("stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("stderr unavailable")?;
    // Offline task runner only: two bounded pipe drains prevent a full stderr pipe deadlocking a child.
    let (a, b, status) = std::thread::scope(|scope| {
        let a = scope.spawn(|| tail(stdout));
        let b = scope.spawn(|| tail(stderr));
        (
            a.join().map_err(|_| "stdout reader failed"),
            b.join().map_err(|_| "stderr reader failed"),
            child.wait(),
        )
    });
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&b??),
        String::from_utf8_lossy(&a??)
    );
    drop(lock);
    let status = status.map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "{program} exit {}\n{}",
            status.code().unwrap_or(2),
            last_lines(&text, 28)
        ));
    }
    Ok(text)
}
fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<_> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}
/// Capture the ordinary command through the same bounded drains; never mix diagnostics with JSON.
pub fn run_json(root: &Path, args: &[String]) -> bool {
    let args: Vec<_> = args
        .iter()
        .filter(|arg| arg.as_str() != "--json")
        .cloned()
        .collect();
    let result = std::env::current_exe()
        .map_err(|e| e.to_string())
        .and_then(|exe| execute(root, &exe.to_string_lossy(), &args, false));
    let ok = result.is_ok();
    let output = match result {
        Ok(text) | Err(text) => text,
    };
    let mut end = output.len().min(512);
    while !output.is_char_boundary(end) {
        end -= 1;
    }
    let mut escaped = String::new();
    for c in output[..end].chars() {
        match c {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            c if c < ' ' => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            c => escaped.push(c),
        }
    }
    println!(
        "{{\"ok\":{ok},\"output\":\"{escaped}\",\"truncated\":{}}}",
        end < output.len()
    );
    ok
}
fn cargo(root: &Path, args: Vec<String>) -> Result<(), String> {
    let mut command = vec!["--manifest-path".into(), "engine/Cargo.toml".into()];
    let first = args.first().ok_or("cargo task missing")?.clone();
    command.extend(args.into_iter().skip(1));
    command.insert(0, first);
    let text = execute(root, "cargo", &command, true)?;
    println!("{}", last_lines(&text, 12));
    Ok(())
}
fn cli(root: &Path, args: &[String]) -> Result<(), String> {
    let mut run = vec![
        "run".into(),
        "--quiet".into(),
        "-p".into(),
        "styk-cli".into(),
        "--features".into(),
        "app-tools".into(),
        "--".into(),
    ];
    // Both `profile` and `scenario` dispatch the measuring CLI operation here.
    // Inspection/schema/compare commands do not measure and keep their fast dev build.
    if args.first().is_some_and(|arg| arg == "profile") {
        run.insert(1, "--release".into());
    }
    run.extend_from_slice(args);
    cargo(root, run)
}
fn crate_graph(root: &Path) -> Result<BTreeMap<String, BTreeSet<String>>, String> {
    let mut graph = BTreeMap::new();
    for entry in fs::read_dir(root.join("engine/crates")).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().join("Cargo.toml");
        if !path.is_file() {
            continue;
        }
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let name = text
            .lines()
            .find_map(|l| {
                l.trim()
                    .strip_prefix("name = \"")
                    .and_then(|s| s.strip_suffix('"'))
            })
            .ok_or("crate name missing")?
            .to_string();
        let deps = text
            .lines()
            .filter(|l| l.contains("path = \"../"))
            .filter_map(|l| l.split_once('='))
            .map(|(name, _)| name.trim().to_string())
            .collect();
        graph.insert(name, deps);
    }
    Ok(graph)
}
fn affected(
    graph: &BTreeMap<String, BTreeSet<String>>,
    mut changed: BTreeSet<String>,
) -> BTreeSet<String> {
    loop {
        let before = changed.len();
        for (name, deps) in graph {
            if deps.iter().any(|d| changed.contains(d)) {
                changed.insert(name.clone());
            }
        }
        if before == changed.len() {
            return changed;
        }
    }
}
pub fn run(root: &Path, args: &[String]) -> Result<(), String> {
    let op = args
        .first()
        .map(String::as_str)
        .ok_or("developer command missing")?;
    let rest = &args[1..];
    match op {
        "build" => {
            let mut profile = "quick";
            let mut dev = false;
            let mut at = 0;
            while at < rest.len() {
                match rest[at].as_str() {
                    "--profile" => {
                        at += 1;
                        profile = rest.get(at).ok_or("--profile needs quick or release")?;
                    }
                    "--devtools" => dev = true,
                    "--tracy" => {
                        return Err("Tracy is deferred to K-stage; no listener is linked".into());
                    }
                    "--json" => {}
                    _ => return Err("unknown build option".into()),
                }
                at += 1;
            }
            if !["quick", "release"].contains(&profile) {
                return Err("profile must be quick or release".into());
            }
            // Separate cargo invocations prevent feature unification contaminating the shipping app.
            for (package, feature) in [("styk-app", "devtools"), ("styk-cli", "app-tools")] {
                let mut a = vec![
                    "build".into(),
                    "-p".into(),
                    package.into(),
                    "--profile".into(),
                    profile.into(),
                ];
                if dev {
                    a.extend(["--features".into(), feature.into()]);
                }
                cargo(root, a)?;
                let path =
                    root.join("engine/target")
                        .join(profile)
                        .join(if package == "styk-app" {
                            "stykanimate.exe"
                        } else {
                            "styk.exe"
                        });
                let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
                println!("{}: {size} bytes", path.display());
            }
            Ok(())
        }
        "test" => {
            let mut packages = BTreeSet::new();
            let mut at = 0;
            while at < rest.len() {
                match rest[at].as_str() {
                    "-p" => {
                        at += 1;
                        packages.insert(rest.get(at).ok_or("-p needs crate")?.clone());
                    }
                    "--changed" => {
                        let base = execute(
                            root,
                            "git",
                            &["merge-base".into(), "HEAD".into(), "native-app".into()],
                            false,
                        )?;
                        let diff = execute(
                            root,
                            "git",
                            &["diff".into(), "--name-only".into(), base.trim().into()],
                            false,
                        )?;
                        let changed = diff
                            .lines()
                            .filter_map(|p| {
                                p.strip_prefix("engine/crates/")
                                    .and_then(|p| p.split('/').next())
                            })
                            .map(str::to_owned)
                            .collect();
                        packages.extend(affected(&crate_graph(root)?, changed));
                    }
                    "--json" => {}
                    _ => return Err("test needs --changed or -p crate".into()),
                }
                at += 1;
            }
            if packages.is_empty() {
                return Err("no changed crates; specify -p explicitly".into());
            }
            let mut args = vec!["test".into()];
            for package in packages {
                args.extend(["-p".into(), package]);
            }
            cargo(root, args)
        }
        "profile" => {
            let mut a = vec!["profile".into()];
            a.extend_from_slice(rest);
            cli(root, &a)
        }
        "compare" => {
            if rest
                .iter()
                .any(|a| ["--branch", "--flag", "--params"].contains(&a.as_str()))
            {
                return Err("compare-profile accepts measured profile files; branch/flag/parameter experiments require their owning registry and isolated measured builds".into());
            }
            let mut a = vec!["compare-profile".into()];
            a.extend_from_slice(rest);
            cli(root, &a)
        }
        "scenario" => {
            let name = rest.first().ok_or("scenario needs a name")?;
            if rest.iter().any(|s| s == "--window") {
                return Err("window scenarios are deferred to K-stage".into());
            }
            if !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err("invalid scenario name".into());
            }
            let path = format!("scenarios/{name}.styk-auto");
            let mut a = vec!["profile".into(), "--scenario".into(), path];
            a.extend_from_slice(&rest[1..]);
            cli(root, &a)
        }
        "screenshot" => {
            let screen = rest.first().ok_or("screenshot needs screen id")?;
            let mut a = vec![
                "run".into(),
                "--quiet".into(),
                "-p".into(),
                "styk-app".into(),
                "--".into(),
                "--screen".into(),
                screen.clone(),
                "--screenshot".into(),
                "artifacts/devtools-screen.png".into(),
            ];
            let mut against = None;
            let mut at = 1;
            while at < rest.len() {
                match rest[at].as_str() {
                    "--against" => {
                        at += 1;
                        against = Some(rest.get(at).ok_or("--against needs PNG")?.clone());
                    }
                    "--size" | "--scale" => {
                        a.push(rest[at].clone());
                        at += 1;
                        a.push(rest.get(at).ok_or("screen option needs value")?.clone());
                    }
                    "--theme" => {
                        return Err(
                            "screen theme selection requires the catalogue's theme adapter".into(),
                        );
                    }
                    "--json" => {}
                    _ => return Err("unknown screenshot option".into()),
                }
                at += 1;
            }
            cargo(root, a)?;
            if let Some(reference) = against {
                cli(
                    root,
                    &[
                        "devtools-png-compare".into(),
                        reference,
                        "artifacts/devtools-screen.png".into(),
                        "artifacts/devtools-screen-diff.png".into(),
                    ],
                )?;
            }
            Ok(())
        }
        "doctor" => {
            for (tool, arg) in [
                ("rustc", "--version"),
                ("wasm-bindgen", "--version"),
                ("clang", "--version"),
            ] {
                match execute(root, tool, &[arg.into()], false) {
                    Ok(text) => println!("{tool}: {}", text.lines().next().unwrap_or("")),
                    Err(e) => println!("{tool}: unavailable ({})", e.lines().next().unwrap_or("")),
                }
            }
            println!(
                "STYK_BACKGROUND_WINDOW={}",
                std::env::var("STYK_BACKGROUND_WINDOW").unwrap_or_else(|_| "unset".into())
            );
            println!(
                "heavy lock: {}",
                root.join("artifacts/devtools-heavy.lock").exists()
            );
            cli(root, &["devtools-doctor".into()])
        }
        "check-trace" => super::dev_trace::check(root),
        "check-schema" => cli(root, &["devtools-schema".into(), "--check".into()]),
        "flags" => {
            println!(
                "{{\"rows\":[],\"n_total\":0,\"registry\":\"no experiment flags registered\"}}"
            );
            Ok(())
        }
        "design-export" => {
            if rest.iter().any(|a| a == "--check") {
                super::design::check(root)
            } else {
                super::design::generate(root)
            }
        }
        "renderdoc" => {
            let app = root.join("engine/target/release/stykanimate.exe");
            if !app.is_file() {
                return Err("build the developer app before renderdoc".into());
            }
            execute(
                root,
                "renderdoccmd",
                &["capture".into(), app.to_string_lossy().into_owned()],
                true,
            )
            .map(|text| println!("{}", last_lines(&text, 28)))
        }
        "serve-web" => {
            Err("N8: this phase builds and runs Windows only; serve-web is unavailable".into())
        }
        _ => Err(format!("unknown developer task {op}")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_crates_include_transitive_reverse_dependencies() {
        let graph = BTreeMap::from([
            ("core".into(), BTreeSet::from(["engine".into()])),
            ("ui".into(), BTreeSet::from(["core".into()])),
        ]);
        assert_eq!(affected(&graph, BTreeSet::from(["engine".into()])).len(), 3);
    }
    #[test]
    fn output_is_bounded_while_read_and_shell_arguments_remain_literal() {
        assert_eq!(tail(&vec![b'x'; 100000][..]).unwrap().len(), 65536);
        assert_eq!(quoted("a'b"), "'a'\"'\"'b'");
        assert_eq!(last_lines("a\nb\nc", 2), "b\nc");
    }
}
