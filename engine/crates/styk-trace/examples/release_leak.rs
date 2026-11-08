//! Compiled negative control for the shipping artifact guard, never a shipping target.
fn main() {
    styk_trace::mark!("negative-control");
    std::hint::black_box(styk_trace::ring_bytes());
}
