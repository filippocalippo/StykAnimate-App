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
