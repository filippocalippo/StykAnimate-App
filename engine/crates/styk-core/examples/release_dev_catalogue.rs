//! Deliberate data-only leak: compiled without the developer feature or developer crates.
#[path = "../src/dev_extension_catalogue.rs"]
mod shipping_catalogue;
fn main() {
    println!("{:?}", std::hint::black_box(shipping_catalogue::CATALOGUE));
}
