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
