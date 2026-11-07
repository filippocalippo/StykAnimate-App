# winit (vendored)

- **Upstream:** https://github.com/iced-rs/winit.git (iced's fork of winit 0.30)
- **Revision:** `48116469f15d3bc52b5e56bb516694be8882870d`
- **Copied:** 2026-11-06, from the checkout cargo had fetched for this revision (decision N2, `docs/native/decisions/0002-vendored-iced.md`).
- **Left out:** `examples/`, `tests/`, `docs/`, `.github/`, and the contributor, lint and spelling configuration files.
- **Manifest edits:** `[dev-dependencies]`, the `[[example]]` target and the `include` entries for the removed folders. The nested `dpi` crate stays.

Licences are kept as shipped. Every source file the crates compile, and every file they `include_bytes!`/`include_str!`, is present.

## Local fixes

None yet. Each fix to this copy gets an entry here: what changed, why, and the upstream issue or pull request link, so
that the copy can be replaced by a newer upstream revision without losing or forgetting a fix.
