//! Every command recording in engine/tests/edit replays
//! without a difference, and the scenarios of ported commands run to the end.

use std::path::Path;

const PORTED: &[&str] = &[
    "selection-sets-native", "selection-sets-sheet", "selection-sets-autokey-sheet",
    "ik-movieclip-parent-sheet",
    "segment-clipboard-native", "segment-clipboard-sheet",
    // Origin motion sheet gestures; @motionFrame is a worker/native-only replay view.
    "origin-motion-layout-sheet", "origin-motion-layout-autokey-sheet",
    "origin-motion-offsets-sheet", "origin-motion-offsets-autokey-sheet",
    "origin-motion-support-sheet", "origin-motion-support-autokey-sheet",
    "origin-motion-support-pinned-sheet", "origin-motion-support-pinned-autokey-sheet",
    "origin-motion-support-free-sheet", "origin-motion-support-free-autokey-sheet",
    "origin-motion-saved-layout-sheet", "origin-motion-saved-layout-autokey-sheet",
    "origin-motion-saved-support-sheet", "origin-motion-saved-support-autokey-sheet",
    // Native saved scalar authoring; projected native properties remain unavailable.
    "native-transform-channels-plain-new", "native-transform-channels-plain-saved",
    "native-transform-channels-layout-new", "native-transform-channels-layout-saved",
    "native-transform-channels-offsets-new", "native-transform-channels-offsets-saved",
    "native-transform-channels-support-new", "native-transform-channels-support-saved",
    "native-transform-channels-future-plain",
    // Optional selection metadata and its canonical history/view owner.
    "selection-metadata-layout-autokey-sheet",
    "selection-metadata-layout-native",
    "selection-metadata-layout-sheet",
    "selection-metadata-plain-autokey-sheet",
    "selection-metadata-plain-native",
    "selection-metadata-plain-sheet",
    "selection-metadata-saved-layout-autokey-sheet",
    "selection-metadata-saved-layout-sheet",
    "selection-metadata-saved-support-autokey-sheet",
    "selection-metadata-saved-support-sheet",
    "selection-metadata-support-autokey-sheet",
    "selection-metadata-support-native",
    "selection-metadata-support-sheet",
    // Animation-origin whole-figure gestures (native, sheet, retained support and offsets).
    "origin-gestures-layout-native", "origin-gestures-layout-sheet", "origin-gestures-offsets-native", "origin-gestures-offsets-sheet",
    "origin-gestures-support-native", "origin-gestures-support-sheet", "origin-gestures-support-autokey-sheet",
    // Animation-origin construction edits and reusable definitions, every pose source.
    "origin-reroot-new-native", "origin-reroot-new-sheet", "origin-reroot-layout-native", "origin-reroot-layout-sheet",
    "origin-reroot-offsets-native", "origin-reroot-offsets-sheet", "origin-reroot-support-native", "origin-reroot-support-sheet",
    "origin-topology-layout-native", "origin-topology-layout-sheet", "origin-topology-offsets-native", "origin-topology-offsets-sheet",
    "origin-topology-support-native", "origin-topology-support-sheet",
    "origin-pose-layout-native", "origin-pose-layout-sheet", "origin-pose-layout-autokey-sheet",
    "origin-pose-offsets-native", "origin-pose-offsets-sheet", "origin-pose-offsets-autokey-sheet",
    "origin-pose-support-native", "origin-pose-support-sheet", "origin-pose-support-autokey-sheet",
    "origin-pose-support-pinned-native", "origin-pose-support-pinned-sheet", "origin-pose-support-free-native", "origin-pose-support-free-sheet",
    // Origin figure scalar edits and saved channels, including live preview pose reads.
    "origin-range-layout-native",
    "origin-range-layout-sheet",
    "origin-range-layout-autokey-sheet",
    "origin-range-offsets-native",
    "origin-range-offsets-sheet",
    "origin-range-offsets-autokey-sheet",
    "origin-range-support-native",
    "origin-range-support-sheet",
    "origin-range-support-autokey-sheet",
    "origin-range-saved-layout-sheet",
    "origin-range-saved-layout-autokey-sheet",
    "origin-range-saved-support-sheet",
    "origin-range-saved-support-autokey-sheet",
    "origin-join-layout-native",
    "origin-join-layout-sheet",
    "origin-join-layout-autokey-sheet",
    "origin-join-offsets-native",
    "origin-join-offsets-sheet",
    "origin-join-offsets-autokey-sheet",
    "origin-join-support-native",
    "origin-join-support-sheet",
    "origin-join-support-autokey-sheet",
    "origin-join-saved-layout-sheet",
    "origin-join-saved-layout-autokey-sheet",
    "origin-join-saved-support-sheet",
    "origin-join-saved-support-autokey-sheet",
    "origin-channels-future-sheet",
    "origin-channels-layout-sheet", "origin-channels-layout-autokey-sheet",
    "origin-channels-offsets-sheet", "origin-channels-offsets-autokey-sheet",
    "origin-channels-support-sheet", "origin-channels-support-autokey-sheet",
    "origin-channels-saved-layout-sheet", "origin-channels-saved-layout-autokey-sheet",
    "origin-channels-saved-support-sheet", "origin-channels-saved-support-autokey-sheet",
    // Editor-recorded movieclip definition creation, sparse capture and current-frame conversion.
    "clip-empty-native", "clip-empty-sheet", "clip-create-definition-native", "clip-create-definition-sheet", "clip-create-loose-sheet", "clip-create-joined-sheet",
    "clip-create-multilayer-sheet", "clip-create-locked-sheet", "clip-create-errors-sheet", "clip-unique-sheet", "clip-break-sheet", "clip-break-joined-sheet", "clip-break-flip-sheet", "clip-break-nested-sheet",
    "move-native", "move-joined", "drag-cancel", "selection-native", "rotate-native", "transform-joined", "pose-native", "pose-joints", "pose-joined", "pose-snap",
    // The app's configuration: gestures on a layer sheet.
    "move-sheet", "gestures-sheet", "autokey-sheet", "layers-sheet", "locked-sheet", "movieclip-sheet", "movieclip-loose-sheet",
    // Keys and frames of the layer timeline.
    "keys-sheet", "frames-sheet", "frames-movieclip-sheet", "frames-timed-clip-sheet",
    // Commands that draft the whole frame.
    "figures-sheet", "figures-layers-sheet",
    // Inverse-kinematics controllers: the document the app starts with, posing unpinned limbs,
    // gestures around pinned limbs (followers, stretch, chains of four bones).
    "startup-sheet", "ik-unpinned-sheet", "pinned-ik-sheet", "ik-followers-sheet", "ik-chains-sheet",
    // IK across joined figures: pinned and free, a follower joined late, the start document joined.
    "ik-joined-sheet", "ik-joined-unpinned-sheet", "ik-joined-late-sheet", "startup-join-sheet",
    // Stick Nodes curves; rig controls, alone and with pinned IK.
    "sticknodes-sheet", "rig-sheet", "ik-rig-follow-sheet", "ik-rig-stretch-sheet",
    // Documents with 3D bones, meshes, surfaces, perspective and part proportions.
    "spatial-mesh-perspective-sheet", "spatial-mesh-sheet-sheet", "spatial-surfaces-skin-sheet", "spatial-surfaces-perspective-sheet",
    "spatial-mesh-mechanism-sheet", "spatial-clip-mesh-sheet",
    // 3D bones: turned, dragged, twisted; mechanisms' hinges and slides.
    "spatial-turn-sheet", "spatial-mechanism-sheet", "spatial-drag-sheet", "spatial-mechanism-drag-sheet",
    // A planted 3D leg (spatial IK target): Both, a side, mirrored.
    "ik-spatial-sheet", "ik-spatial-side-sheet", "ik-spatial-mirrored-sheet",
    // Posing 3D IK targets: planted (flat pole, depth push, swivel, pole and depth), bent to a side, free.
    "ik-spatial-target-sheet", "ik-spatial-side-target-sheet", "ik-spatial-free-sheet",
    "ik-spatial-steer-sheet", "ik-spatial-side-steer-sheet", "ik-spatial-mirrored-steer-sheet", "spatial-reset-sheet",
    // Pose choices: 3D bones shown one at a time, presets over channels.
    "pose-choices-sheet", "pose-presets-sheet", "pose-choice-mechanism-sheet",
    // IK controllers' settings: switched, pinned, stretched, chain and bend, targets turned, 3D feet.
    "ik-settings-sheet", "ik-settings-pinned-sheet", "ik-settings-spatial-sheet", "ik-settings-rig-sheet", "ik-settings-followers-sheet",
    // The layer list: names, colours, visibility, locks, new layers, order.
    "layer-list-sheet", "layers-native", "layers-folders-sheet",
    // Figures added from the library.
    "add-figure-sheet", "add-figure-layers-sheet",
    // Keys moved and copied along the timeline.
    "move-frames-sheet", "move-frames-imported-sheet",
    // The inspector's figure fields.
    "update-object-sheet", "update-object-native", "update-segment-sheet", "update-segment-rig-sheet",
    // Camera motion clips.
    "camera-motion-sheet", "palette-sheet", "audio-sheet", "audio-none-sheet", "sheet-clipboard-sheet", "sheet-clipboard-empty-sheet", "sheet-clipboard-ik-sheet", "polygons-sheet", "polygons-native", "polygons-native-file-sheet", "vfx-clips-sheet", "batch-sheet", "sheet-selection-sheet", "figure-clipboard-sheet", "figure-clipboard-ik-sheet", "figure-clipboard-vfx-sheet", "project-settings-sheet", "project-settings-format4-sheet", "import-figure-sheet", "layer-parallax-sheet", "layer-parallax-camera-sheet", "movieclip-rename-sheet", "movieclip-playback-sheet", "movieclip-playback-timed-sheet", "sheet-transfer-sheet", "handle-edit-native", "handle-edit-sheet", "handle-edit-startup-sheet", "handle-edit-ik-sheet", "handle-edit-chain-sheet", "handle-edit-sticknodes-sheet", "handle-edit-full-turn-sheet", "figure-transform-native", "figure-transform-sheet", "figure-transform-ik-sheet", "handle-commands-native", "handle-commands-sheet", "handle-commands-ik-sheet", "handle-commands-camera-native", "handle-commands-camera-sheet", "camera-commands-sheet", "move-frames-clip-sheet", "move-frames-presence-clip-sheet", "clipboard-presence-clip-sheet", "property-clip-patches-sheet", "camera-bake-sheet", "figure-clipboard-clip-sheet", "range-clip-sheet", "clip-playback-all-sheet", "camera-motion-add-sheet", "camera-motion-paste-sheet", "vfx-stack-sheet", "vfx-clip-add-sheet", "ik-settings-second-figure-sheet",
    // Property edits on a layer sheet: inspector scrubs, keyed values, scene colours, outlines, polygon opacity, effects.
    "property-scrub-sheet", "property-autokey-sheet", "property-keys-sheet", "property-locked-sheet", "scene-color-sheet", "figure-style-sheet", "polygon-opacity-sheet", "vfx-parameter-sheet",
    // Documents with property channels (a layer sheet's legacyAnimation).
    "channels-figure-sheet", "channels-pose-sheet", "channels-vfx-sheet", "channels-camera-scene-sheet", "channels-movieclip-sheet", "channels-style-sheet", "channels-curves-sheet", "channels-outline-sheet", "channels-follow-sheet",
    // Figures changed across frames, figure order, joins, branch flips (transform-native ends with one).
    "range-appearance-sheet", "range-appearance-colors-sheet", "range-order-sheet", "range-joins-sheet", "range-transforms-sheet", "range-autokey-sheet", "range-locked-sheet", "range-branch-sheet", "range-native", "transform-native",
    "range-ik-pinned-sheet", "range-ik-joined-sheet", "range-ik-followers-sheet", "range-movieclip-sheet",
    // Recolouring figures: palettes, gradients and paints, styles, polygons, format 4, mesh colours.
    "recolor-sheet", "recolor-format4-sheet", "recolor-mesh-sheet", "recolor-native",
    // The builder: segment styles, branch caps and fills, the figure's name and outline.
    "builder-styles-sheet", "builder-styles-native", "builder-styles-override-native", "builder-order-sheet", "builder-order-native",
    // Rig relationships: Smart Stretch, behaviours, angle locks, stretch parts, IK refusals.
    "rig-behavior-sheet", "rig-behavior-native", "rig-behavior-ik-sheet",
    // The figure's topology: segments added, deleted, unsplit, flipped, moved, split, duplicated; rig joints appended.
    "topology-sheet", "topology-native", "topology-joined-sheet", "topology-joined-native", "topology-ik-sheet", "topology-followers-sheet",
    "topology-rig-sheet", "topology-vfx-sheet", "topology-sticknodes-sheet",
    // Rig edits by dragging: repositioned, turned, stretched, slid and bent joints.
    "rig-drag-sheet", "rig-drag-native", "rig-drag-plain-sheet", "replace-definition-sheet", "replace-definition-joined-native",
    // Motion-path edits: trail points at their own ticks, falloffs of each shape, IK, layers, a movieclip, the camera.
    "motion-path-sheet", "motion-path-falloff-sheet", "motion-path-autokey-sheet", "motion-path-layers-sheet", "motion-path-locked-sheet", "motion-path-movieclip-sheet",
    "motion-path-camera-sheet", "motion-path-ik-sheet", "motion-path-ik-unpinned-sheet", "motion-path-ik-pinned-sheet", "motion-path-ik-followers-sheet", "motion-path-ik-joined-sheet",
    "motion-path-ik-joined-unpinned-sheet", "motion-path-sticknodes-sheet",
];

#[test]
fn recordings_replay() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/edit");
    let mut seen = Vec::new();
    for entry in std::fs::read_dir(&folder).unwrap() {
        let path = entry.unwrap().path();
        if !path.to_string_lossy().ends_with(".reference.json") {
            continue;
        }
        let reference = styk_doc::json::parse(&std::fs::read(&path).unwrap()).unwrap();
        let outcome = styk_edit::replay::replay(&reference).unwrap();
        assert!(outcome.passed(), "{}: {:#?}", outcome.scenario, outcome.mismatches);
        if PORTED.contains(&outcome.scenario.as_str()) {
            assert_eq!((outcome.matched, &outcome.unported), (outcome.steps, &None), "{}", outcome.scenario);
        }
        seen.push(outcome.scenario);
    }
    for name in PORTED {
        assert!(seen.iter().any(|s| s == name), "{name} has no recording");
    }
}
