//! A stand-in for the program, for the installer tests: it writes the arguments it was started with next to itself and
//! ends. It has no window and no console, so starting it shows nothing.
#![windows_subsystem = "windows"]

fn main() {
    let exe = std::env::current_exe().expect("the program has a path");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let _ = std::fs::write(exe.with_file_name("launched.txt"), args.join(" "));
}
