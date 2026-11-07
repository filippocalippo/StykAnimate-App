# cosmic-text (vendored)

- **Upstream:** https://github.com/hecrj/cosmic-text.git (a fork of pop-os/cosmic-text)
- **Revision:** `6adc2364289fd241daed751948a03d0aea5a31ca`
- **Copied:** 2026-11-06, from the checkout cargo had fetched for this revision (decision N2, `docs/native/decisions/0002-vendored-iced.md`).
- **Left out:** `examples/`, `benches/`, `tests/`, `fonts/` (git-lfs files the tests and examples use; no source file includes them), `sample/`, `screenshots/`, `.github/`, the helper shell scripts and `deny.toml`.
- **Manifest edits:** `[dev-dependencies]`, the three `[[bench]]` targets and the `examples/*` workspace members.

Licences are kept as shipped. Every source file the crates compile, and every file they `include_bytes!`/`include_str!`, is present.

## Local fixes

None yet. Each fix to this copy gets an entry here: what changed, why, and the upstream issue or pull request link, so
that the copy can be replaced by a newer upstream revision without losing or forgetting a fix.

- **S2a: per-grapheme caret and selection geometry.** New `src/caret.rs` (`GraphemeBox`, `grapheme_boxes`, `caret_x`), `src/buffer.rs` (`LayoutRun::highlight` and `Buffer::hit` divide a ligature's graphemes in the glyph's direction). The graphemes of a right-to-left ligature were laid out left to right, mirroring selection rectangles and clicks inside it. Caret motion is unchanged (it matches Chromium on Windows, measured). Upstream issue: none found (searched 2026-11-07).
- **S2t, optical size end to end** (`attrs.rs`, `font/mod.rs`, `font/system.rs`, `font/fallback/mod.rs`, `shape.rs`, `layout.rs`, `glyph_cache.rs`, `swash.rs`): `OpticalSize` (the `opsz` axis in sixteenths of a pixel) in `Attrs`, `ShapeGlyph`, `LayoutGlyph` and `CacheKey`; `FontSystem::get_font_instance(id, weight, optical_size)` caches by all three (a face without an `opsz` axis is one instance); `Font::new` builds the shaping instance with it; swash's scaler gets `wght` and `opsz` coordinates (`scaler_for`, replacing two copies). Why: with only `wght` carried, a size-dependent optical size shaped one way and rasterized another (the review's finding 14). Not yet proposed upstream.
- **S2t, fallback families at their nearest weight** (`font/fallback/mod.rs`, `family_faces`): a script or common fallback family was used only if it had a face at exactly the requested weight; Segoe UI has no 500, so Arabic and Hebrew fell through to Arial. Faces are now taken nearest weight first, the heavier on a tie (what DirectWrite and Chromium do). `FontSystem::set_fallback` replaces the fallback lists after construction; `Script` is re-exported.
- **S2t, `LayoutRun::line_ascent` and `line_descent`** (`buffer.rs`): the line's font metrics, so a renderer can place the baseline as the browser does (see cryoglyph).

- **S2t, basic shaping at the face's coordinates, features split runs** (`shape.rs`, `attrs.rs`): `shape_skip_glyphs` (the basic, ASCII path) and the missing-glyph substitution read swash's metrics at the face's variation coordinates instead of the empty set, so advances are the ones the glyphs are rasterized at (a weight 760 text was laid out at weight 400 and drawn at 760); `Attrs::compatible` compares `font_features`, so adjacent spans with different OpenType features are separate shaping runs (the second span's `tnum` was lost).
