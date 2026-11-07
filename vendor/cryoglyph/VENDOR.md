# cryoglyph (vendored)

- **Upstream:** https://github.com/iced-rs/cryoglyph.git
- **Revision:** `cf38ed5ea0cfe95270b31ced2910560a7fcc5003`
- **Copied:** 2026-11-06, from the checkout cargo had fetched for this revision (decision N2, `docs/native/decisions/0002-vendored-iced.md`).
- **Left out:** `benches/`, `examples/`, `samples/`, `.github/`.
- **Manifest edits:** `[dev-dependencies]` and the `[[bench]]` target. Its `cosmic-text` git dependency is patched to the copy beside it by `engine/Cargo.toml`.

Licences are kept as shipped. Every source file the crates compile, and every file they `include_bytes!`/`include_str!`, is present.

## Local fixes

None yet. Each fix to this copy gets an entry here: what changed, why, and the upstream issue or pull request link, so
that the copy can be replaced by a newer upstream revision without losing or forgetting a fix.

- **S2t, Chromium's baseline** (`src/text_render.rs`, `baseline`): glyph rows are placed on `round((line_top + round(ascent) + floor((line_height - round(ascent) - round(descent)) / 2)) * scale)` instead of `round(line_y * scale)`, using the new `LayoutRun::line_ascent` and `line_descent`. Why: Chromium rounds the font metrics in logical pixels and floors the half leading, so the same text sat up to one pixel off in rows and 70 of 98 rows were a pixel off at 150 % when the metrics were rounded at the drawn size (`docs/native/typography.md`, section 4).
