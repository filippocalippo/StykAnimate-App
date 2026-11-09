//! Deliberate leak: the actual developer payload route linked into an optimized binary.
fn main() {
    let event = std::hint::black_box(styk_core::dev_extension::Event::Poll);
    println!(
        "{:?}",
        styk_core::dev_extension::route(event)
    );
}
