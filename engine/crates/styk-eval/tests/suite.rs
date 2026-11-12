//! Every integration test of styk-eval as one binary: one link instead of one per file. Each file below is a module, so
//! `cargo test -p styk-eval --test suite <file>::` runs one file's tests. A file that needs the process to itself (its own
//! allocator, a measurement) stays a binary of its own in Cargo.toml.
mod build_memory;
mod build_memory_stale;
mod cancellation;
mod channels;
mod clip_cache;
mod clip_paint;
mod connector_polygon;
mod document;
mod drawing;
mod drawing_bounds;
mod drawing_grid;
mod eval;
mod generators;
mod ik;
mod incremental;
mod incremental_cel;
mod lineage_cache;
mod movieclip_bake;
mod movieclip_hidden_parent;
mod movieclip_insertion;
mod movieclip_materialize;
mod movieclip_native_extension;
mod movieclip_native_membership;
mod movieclip_native_presence;
mod movieclip_patch_tracks;
mod movieclip_sheet_extension;
mod movieclip_source;
mod movieclip_source_coverage;
mod movieclip_source_generators;
mod movieclip_timed_native;
mod movieclip_timed_sheet;
mod movieclip_timed_sheet_commands;
mod movieclip_timed_sheet_expansion;
mod onion;
mod origin;
mod origin_validation;
mod picking;
mod picking_bounds;
mod picking_construction;
mod picking_joints;
mod records;
mod records_channel_value;
mod records_degrade;
mod records_native_draft;
mod records_origin;
mod rig_validation;
mod shape_geometry;
mod spatial;
mod text;
mod vfx;
mod vfx_layers;
mod vfx_owner_edges;

/// A test file that is neither a module above nor a `[[test]]` of the manifest would never run.
#[test]
fn every_test_file_is_built() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let suite = include_str!("suite.rs");
    let manifest = std::fs::read_to_string(dir.join("Cargo.toml")).unwrap();
    for entry in std::fs::read_dir(dir.join("tests")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "rs") {
            continue;
        }
        let stem = path.file_stem().unwrap().to_str().unwrap();
        let built = stem == "suite" || suite.contains(&format!("\nmod {stem};")) || manifest.contains(&format!("path = \"tests/{stem}.rs\""));
        assert!(built, "tests/{stem}.rs is not built: add `mod {stem};` to tests/suite.rs");
    }
}
