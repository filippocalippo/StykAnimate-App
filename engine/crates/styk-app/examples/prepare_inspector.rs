//! Generates Debug data for scripts/native-inspector-models.mjs; never modifies references.
#[path = "../src/headless.rs"]
mod headless;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = std::env::args().nth(1).ok_or("output directory required")?;
    std::fs::create_dir_all(&out)?;
    for context in styk_core::screens::InspectorScreen::ALL {
        let core = pollster::block_on(headless::prepared_core(context))?;
        let panel = core.inspector();
        if panel.field().is_some() || panel.rename().is_some() || panel.text_draft().is_some() || core.focus().composing() { return Err("catalogue has live editing state; extend prepared model first".into()); }
        std::fs::write(std::path::Path::new(&out).join(format!("{}.debug", context.name())), format!("{:#?}", panel.model().ok_or("missing model")?))?;
    }
    Ok(())
}
