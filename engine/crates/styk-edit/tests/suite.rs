//! Every integration test of styk-edit as one binary: one link instead of one per file. Each file below is a module, so
//! `cargo test -p styk-edit --test suite <file>::` runs one file's tests. A file that needs the process to itself (its own
//! allocator, a measurement) stays a binary of its own in Cargo.toml.
mod damage;
mod branch_thickness;
mod camera_bake_order;
mod camera_follow;
mod clipboards;
mod connector_position;
mod draw_new_figure;
mod draw_order_easing;
mod duplicate_drag;
mod follow_sessions;
mod gesture_origins;
mod group_property_edit;
mod handle_hidden_key;
mod history_budget;
mod history_readiness;
mod joined_node_ik;
mod joined_spatial_ik;
mod layer_focus_lock;
mod layer_sheet_commands;
mod layer_sheet_planning;
mod legacy_timed_playback;
mod load;
mod load_join_repair;
mod load_parallel;
mod load_robust;
mod load_sheet;
mod measured_bounds;
mod motion_path_joined;
mod movieclip_admission;
mod movieclip_bake;
mod movieclip_drawing_layers;
mod movieclip_insertion;
mod movieclip_key_capacity;
mod movieclip_memory_gate;
mod movieclip_native_extension;
mod movieclip_nesting;
mod movieclip_ports;
mod movieclip_replay_worker;
mod movieclip_retained_patches;
mod movieclip_session_integration;
mod movieclip_sheet_extension;
mod movieclip_timed_sheet_commands;
mod movieclip_timed_sheet_expansion;
mod movieclip_timed_sheet_planning;
mod movieclips;
mod movieclips_joins;
mod movieclips_membership;
mod movieclips_native;
mod movieclips_presence;
mod movieclips_timed;
mod native_builder;
mod native_transform_channels;
mod origin;
mod origin_angle_lock;
mod origin_channels;
mod origin_motion;
mod origin_motion_native;
mod origin_motion_native_saved;
mod origin_pose;
mod origin_pose_choice;
mod origin_range;
mod origin_rig;
mod origin_rig_inactive;
mod origin_rig_pose;
mod origin_topology;
mod owner_calls;
mod pose_property;
mod recolor_opacity_only;
mod replay;
mod segment_clipboard;
mod selection_metadata;
mod session;
mod session_commands;
mod session_live_worker;
mod session_native;
mod spatial_shape;
mod sprite_segment;
mod vfx_remaining;

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
