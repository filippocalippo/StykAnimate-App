/** Native Pivot document fixtures: the starter animation uses the same data path as imports. */
import {synchronizeAnimationOrigin} from './animation-origin.mjs';
const PI = Math.PI;
const segment = (id, parent, length, angle, thickness = 10, extra = {}) => ({
  segment_id: id, parent_id: parent, length, angle_rad: angle, thickness,
  bend_rad: 0, primitive_code: 0, aux_code: 0, flags: 0, segment_type: 'line',
  segment_kind: 'line', color_rgb: [43, 43, 43], transparency: 0,
  visible: true, z_order: id, ...extra,
});

export function defaultFigure(figure_type_id = 1) {
  const segments = [
    segment(1, 0, 78, -PI / 2, 11),
    segment(2, 1, 44, -PI / 2, 8, {primitive_code: 1, flags: 1, segment_type: 'circle', segment_kind: 'circle'}),
    segment(3, 1, 53, 1.05, 9), segment(4, 3, 48, 1.32, 8),
    segment(5, 1, 53, 2.02, 9), segment(6, 5, 48, 1.65, 8),
    segment(7, 0, 66, 1.12, 11), segment(8, 7, 63, 1.52, 10),
    segment(9, 0, 66, 2.00, 11), segment(10, 9, 63, 1.68, 10),
  ];
  return {figure_type_id, name: 'Walker', segment_count: segments.length, segments,
    polyfills: [], image_assets: [], text_assets: []};
}

export function createObject(figure, unique_id, x, y, extra = {}) {
  return synchronizeAnimationOrigin(figure, {object_slot: 0, unique_id, figure_type_id: figure.figure_type_id,
    root_x: x, root_y: y, scale: 1, color_override_raw: 0, field28: 0,
    angles: figure.segments.map(s => s.angle_rad), len_flag: 0, lengths: [],
    bend_flag: 0, bends: [], join: null, ...extra}, {initialize: true});
}

export function createFrame(objects = [], duration_raw = 1) {
  objects.forEach((object, i) => { object.object_slot = i; });
  return {duration_raw, background_id: 0, background_id_b: 0, background_mix: 0,
    camera: {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0}, objects,
    object_draw_order: objects.map((_, i) => i),
    object_draw_order_unique_ids: objects.map(o => o.unique_id)};
}

export function emptyDocument() {
  return {version: 5, canvas_width: 960, canvas_height: 540, fps: 24,
    auto_easing: false, auto_easing_disabled_raw: 1, auto_easing_source: 'file',
    backgrounds: [], figure_types: [defaultFigure()],
    keyframes: [createFrame()], _styk: {format: 'StykAnimate', format_version: 1, name: 'Untitled animation'}};
}

export function createDemo() {
  const report = emptyDocument(), walker = report.figure_types[0];
  const ground = {figure_type_id: 2, name: 'Ground', segments: [
    segment(1, 0, 640, 0, 2, {color_rgb: [228, 229, 237], aux_code: 1, flags: 256, is_static: true}),
  ], polyfills: [], image_assets: [], text_assets: []};
  const ball = {figure_type_id: 3, name: 'Bounce', segments: [
    segment(1, 0, 28, -PI / 2, 0, {color_rgb: [240, 165, 71], primitive_code: 3, flags: 3,
      segment_type: 'circle', segment_kind: 'circleFill'}),
  ], polyfills: [], image_assets: [], text_assets: []};
  report.figure_types.push(ground, ball);
  report.keyframes = Array.from({length: 24}, (_, i) => {
    const phase = (i + 3) / 24 * PI * 2, swing = Math.sin(phase), lift = Math.cos(phase * 2);
    const pose = createObject(walker, 1, 450 + Math.sin(phase) * 9, 292 - lift * 3);
    pose.angles = [-PI / 2 + 0.055, -PI / 2 + 0.055,
      PI / 2 - swing * 0.68, PI / 2 - swing * 0.43 - 0.4,
      PI / 2 + swing * 0.68, PI / 2 + swing * 0.43 - 0.4,
      PI / 2 + swing * 0.51, PI / 2 + Math.max(0, -swing) * 0.86,
      PI / 2 - swing * 0.51, PI / 2 + Math.max(0, swing) * 0.86];
    const floor = createObject(ground, 2, 160, 423, {_styk: {locked: true}});
    const orb = createObject(ball, 3, 652, 423 - Math.abs(Math.sin(phase)) * 92);
    return createFrame([pose, floor, orb], 2);
  });
  report._styk.name = 'First steps';
  return report;
}
