# iced (vendored)

- **Upstream:** https://github.com/iced-rs/iced
- **Revision:** `8ff48c42b0d5188223501ea1ccc506fd5beaf36a`
- **Copied:** 2026-11-06, from the checkout cargo had fetched for this revision (decision N2, `docs/native/decisions/0002-vendored-iced.md`).
- **Left out:** `examples/`, `benches/`, `docs/`, `tests/` and each crate's `tests/`, `.cargo/`, `.github/`, `Cargo.lock`, `Cross.toml`, the roadmap, contributing and dependency notes, `clippy.toml`.
- **Manifest edits:** the root `Cargo.toml` lost its `[[bench]]` targets, `[dev-dependencies]` and the `examples/*` workspace member; `widget/Cargo.toml` lost its `[dev-dependencies]`. The crates still inherit `workspace = true` dependencies from that root, and the root's `[workspace.dependencies]` still names `winit`, `cryoglyph` and `cosmic-text` by git URL: `engine/Cargo.toml` patches those URLs to the copies beside it.

Licences are kept as shipped. Every source file the crates compile, and every file they `include_bytes!`/`include_str!`, is present.

## Local fixes

None yet. Each fix to this copy gets an entry here: what changed, why, and the upstream issue or pull request link, so
that the copy can be replaced by a newer upstream revision without losing or forgetting a fix.

- **S2t, typography on `Font`** (`core/src/font.rs`, `graphics/src/text.rs`, `graphics/src/text/{paragraph,cache}.rs`): `Weight::Value(u16)` (any `wght`), `Font::optical_size` (`Default` or `Auto`, resolved from the logical text size by `to_attributes_sized`), `Font::features` (OpenType tags, forwarded to the shaper) and `Font::tracking` (thousandths of an em, cosmic-text's `letter_spacing`); all are part of the paragraph cache key because `Font` is hashed. `to_attributes(font)` stays for the editor and input (another spike's files) and leaves `Auto` at the default coordinate. Why: the interface uses weights 450, 650 and 760, `tnum`, tracking and Inter's optical size, which the nine named weights and an attribute-less `Font` cannot express.
- **S2t, `text::font_system_if_built()`** (`graphics/src/text.rs`): the global font system as a plain `static` that can be asked, without building it, whether it exists. Why: building it scans every installed font; the program builds it on a worker and lets the interface thread touch it only after (`styk_design::warm_up`).
- **S2t, `Shaping::Auto` for fonts that need full shaping** (`graphics/src/text.rs`, `to_shaping(shaping, text, font)`): `Auto` chooses the basic shaper only for ASCII text in a font with no OpenType features and no named family. The basic shaper applies no feature and no kerning, so a default `text("0123456789")` in a bundled family with `tnum` was laid out proportionally and unkerned while the browser shapes it in full.
