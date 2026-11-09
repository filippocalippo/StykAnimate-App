// The shipping build has no console window; the developer build keeps it for logs.
#![cfg_attr(all(not(debug_assertions), not(feature = "devtools")), windows_subsystem = "windows")]

fn main() {
    styk_desktop::run();
}
