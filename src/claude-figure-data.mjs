import { createFrame } from './demo.mjs';

/**
 * StykAnimate Claude Mascot Figure Definition
 * Editable 2D character rig featuring block geometry,
 * the signature terracotta palette (#D97757), dual arms,
 * and 4 independent IK-ready legs.
 */

export function createClaudeFigureData({ root_x = 480, root_y = 320 } = {}) {
  const terracotta = [217, 119, 87];
  const white = [255, 255, 255];

  const segments = [
    // 1: Torso / Main Head-Body Block (parent 0 = root)
    {
      segment_id: 1,
      parent_id: 0,
      name: 'Torso',
      length: 65,
      angle_rad: -Math.PI / 2,
      thickness: 72,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...terracotta],
      transparency: 0,
      visible: true,
      z_order: 1
    },
    // 2: Left Arm
    {
      segment_id: 2,
      parent_id: 1,
      name: 'Left arm',
      length: 42,
      angle_rad: Math.PI,
      thickness: 16,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...terracotta],
      transparency: 0,
      visible: true,
      z_order: 2
    },
    // 3: Right Arm
    {
      segment_id: 3,
      parent_id: 1,
      name: 'Right arm',
      length: 42,
      angle_rad: 0,
      thickness: 16,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...terracotta],
      transparency: 0,
      visible: true,
      z_order: 3
    },
    // 4: Left Leg (Outer)
    {
      segment_id: 4,
      parent_id: 0,
      name: 'Left leg outer',
      length: 36,
      angle_rad: Math.PI / 2,
      thickness: 14,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...terracotta],
      transparency: 0,
      visible: true,
      z_order: 4
    },
    // 5: Left Leg (Inner)
    {
      segment_id: 5,
      parent_id: 0,
      name: 'Left leg inner',
      length: 36,
      angle_rad: Math.PI / 2,
      thickness: 14,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...terracotta],
      transparency: 0,
      visible: true,
      z_order: 5
    },
    // 6: Right Leg (Inner)
    {
      segment_id: 6,
      parent_id: 0,
      name: 'Right leg inner',
      length: 36,
      angle_rad: Math.PI / 2,
      thickness: 14,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...terracotta],
      transparency: 0,
      visible: true,
      z_order: 6
    },
    // 7: Right Leg (Outer)
    {
      segment_id: 7,
      parent_id: 0,
      name: 'Right leg outer',
      length: 36,
      angle_rad: Math.PI / 2,
      thickness: 14,
      bend_rad: 0,
      primitive_code: 0,
      aux_code: 0,
      flags: 0,
      segment_type: 'line',
      segment_kind: 'line',
      color_rgb: [...terracotta],
      transparency: 0,
      visible: true,
      z_order: 7
    }
  ];

  const figure = {
    figure_type_id: 2,
    name: 'Claude',
    segment_count: segments.length,
    segments,
    polyfills: [],
    image_assets: [],
    text_assets: []
  };

  const object = {
    object_slot: 0,
    unique_id: 2,
    figure_type_id: 2,
    root_x,
    root_y,
    scale: 1,
    color_override_raw: 0,
    field28: 0,
    angles: [-Math.PI / 2, Math.PI, 0, Math.PI / 2, Math.PI / 2, Math.PI / 2, Math.PI / 2],
    len_flag: 0,
    lengths: [],
    bend_flag: 0,
    bends: [],
    join: null,
    _stykIK: {
      "4": { enabled: true, pinned: false, allowStretch: false, chainLength: 1, bendDirection: 0, target: { x: root_x, y: root_y + 36, rotation: 0 }, followers: {} },
      "5": { enabled: true, pinned: false, allowStretch: false, chainLength: 1, bendDirection: 0, target: { x: root_x, y: root_y + 36, rotation: 0 }, followers: {} },
      "6": { enabled: true, pinned: false, allowStretch: false, chainLength: 1, bendDirection: 0, target: { x: root_x, y: root_y + 36, rotation: 0 }, followers: {} },
      "7": { enabled: true, pinned: false, allowStretch: false, chainLength: 1, bendDirection: 0, target: { x: root_x, y: root_y + 36, rotation: 0 }, followers: {} }
    },
    color_override_rgb: [0, 0, 0],
    color_override_mix: 0,
    transparency: 0,
    opacity: 1
  };

  return { figure, object };
}

export function createClaudeFigureDocument(options = {}) {
  const { figure, object } = createClaudeFigureData(options);
  const figureName = options.name || figure.name;
  const namedFigure = { ...figure, name: figureName };
  return {
    version: 5,
    canvas_width: 960,
    canvas_height: 540,
    fps: 24,
    auto_easing: false,
    auto_easing_disabled_raw: 1,
    figure_types: [namedFigure],
    backgrounds: [],
    keyframes: [createFrame([object], 1)],
    _styk: { format: 'StykAnimate', format_version: 1, name: figureName }
  };
}

