use super::*;
use styk_services::Cancel;
use styk_services::shell::Rect;
use std::io::{BufRead, BufReader, Read, Write};
use std::time::{Duration, Instant};

fn temp(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("styk-shell-f3-{tag}-{}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();
    dir
}

fn frame(x: i32) -> WindowFrame {
    WindowFrame { rect: Rect::new(x, 20, 1234, 777), maximized: true, scale_milli: 1500 }
}

#[test]
fn cancelled_window_save_preserves_previous_bytes() {
    let dir = temp("cancelled");
    let path = dir.join("window-state.txt");
    write_state_for_setup(&path, SetupKey(1), frame(10), &Cancel::new()).unwrap();
    let before = std::fs::read(&path).unwrap();
    let cancel = Cancel::new();
    cancel.cancel();
    assert!(write_state_for_setup(&path, SetupKey(2), frame(20), &cancel).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
#[ignore = "helper launched by two_processes_preserve_both_monitor_setups"]
fn window_state_child() {
    let path = PathBuf::from(std::env::var_os("STYK_WINDOW_STATE_TEST_PATH").expect("test path"));
    let key: u64 = std::env::var("STYK_WINDOW_STATE_TEST_KEY").unwrap().parse().unwrap();
    let mut go = [0];
    println!("WINDOW_READY");
    std::io::stdout().flush().unwrap();
    std::io::stdin().read_exact(&mut go).unwrap();
    for n in 0..40 {
        write_state_for_setup(&path, SetupKey(key), frame(key as i32 * 1000 + n), &Cancel::new()).unwrap();
    }
}

struct Child(crate::video::process::ChildGuard);
impl Drop for Child {
    fn drop(&mut self) {
        self.0.terminate();
        self.0.wait();
    }
}

#[test]
fn two_processes_preserve_both_monitor_setups() {
    use crate::video::process;
    let dir = temp("processes");
    let path = dir.join("window-state.txt");
    let mut children = Vec::new();
    for key in 1..=2 {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "shell::persistence_tests::window_state_child", "--ignored", "--nocapture"])
            .env("STYK_WINDOW_STATE_TEST_PATH", &path)
            .env("STYK_WINDOW_STATE_TEST_KEY", key.to_string());
        // The existing platform launcher puts each child in the kill-on-close job before it runs.
        let (child, mut pipes) = process::spawn(&mut command, true).unwrap();
        let stdout = pipes.stdout.take().unwrap();
        let mut stderr = pipes.stderr.take().unwrap();
        let (ready, receive) = std::sync::mpsc::channel();
        let out = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                assert_ne!(reader.by_ref().take(512).read_line(&mut line).unwrap(), 0);
                if line.trim_end().ends_with("WINDOW_READY") { break; }
            }
            ready.send(()).unwrap();
            std::io::copy(&mut reader, &mut std::io::sink()).unwrap()
        });
        let err = std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()).unwrap());
        children.push((Child(child), pipes.stdin.take().unwrap(), out, err));
        receive.recv_timeout(Duration::from_secs(60)).unwrap();
    }
    for (_, input, _, _) in &mut children { input.write_all(b"g").unwrap(); }
    let start = Instant::now();
    while children.iter().any(|(child, _, _, _)| !child.0.has_exited()) {
        if start.elapsed() > Duration::from_secs(60) {
            for (child, _, _, _) in &children { child.0.terminate(); }
            panic!("window-state children hung");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    for (child, _, out, err) in children {
        assert!(child.0.wait().success(), "window-state child failed");
        out.join().unwrap();
        err.join().unwrap();
    }
    let text = std::fs::read_to_string(&path).unwrap();
    let file = WindowStateFile::parse(&text);
    assert_eq!(file.to_text(), text, "whole canonical file");
    assert_eq!(file.setups.len(), 2);
    for key in 1..=2 {
        assert_eq!(file.frame_for(SetupKey(key)), Some(frame(key as i32 * 1000 + 39)));
    }
    std::fs::remove_dir_all(dir).unwrap();
}
