// Pose-choice presets for edit-scenarios.mjs: authoring poses compiled into a figure's existing
// channel choice selector (`figure._styk.poseChoices`, as tests/rig-pose-choices.test.mjs builds
// them). Each choice writes the group's complete union of channels, reset values included, and
// leaves the figure's orientation and unrelated groups alone.
import {validateFigurePoseChoices} from '../../src/rig-pose-choices.mjs';

const indexOfSegment = (figure, name) => {
  const index = figure.segments.findIndex(segment => segment.name === name);
  if (index < 0) throw new Error(`Missing ${name}`);
  return index;
};

/** The angles and lengths of `figure` posed by `{bend: {name: radians}, swing: {name: [turn, tilt]}, length: {name: units}}`. */
function poseObject(figure, object, {bend = {}, swing = {}, length = {}} = {}) {
  const segments = figure.segments, byId = new Map(segments.map((segment, i) => [segment.segment_id, i]));
  object.angles = segments.map(segment => segment.angle_rad);
  object.lengths = segments.map(segment => segment.length);
  for (const name of Object.keys(length)) object.lengths[indexOfSegment(figure, name)] = length[name];
  for (const name of [...Object.keys(bend), ...Object.keys(swing)]) indexOfSegment(figure, name);
  const total = new Map();
  segments.forEach((segment, i) => {
    const rig = segment._stykRig?.spatial;
    if (!rig || rig.bindings) return;
    const sum = (rig.parent ? total.get(rig.parent) ?? 0 : 0) + (bend[segment.name] ?? 0);
    total.set(segment.segment_id, sum);
    object.angles[i] += sum;
    if (swing[segment.name]) {
      object.angles[byId.get(rig.turn)] += swing[segment.name][0];
      object.angles[byId.get(rig.pitch)] += swing[segment.name][1] ?? 0;
    }
  });
  return object;
}

export function compilePoseChoices(figure, groups) {
  const allowed = new Set();
  for (const segment of figure.segments) if (segment._stykRig?.spatial?.origin) {
    const rig = segment._stykRig.spatial;
    allowed.add(segment.segment_id); allowed.add(rig.turn); allowed.add(rig.pitch);
  }
  figure._styk = {...figure._styk, poseChoices: groups.map(group => {
    const objects = group.choices.map(choice => poseObject(figure, {}, choice.pose));
    const angles = [], lengths = [];
    for (let i = 0; i < figure.segments.length; i++) {
      if (!allowed.has(figure.segments[i].segment_id)) continue;
      if (objects.some(o => Math.abs(o.angles[i] - figure.segments[i].angle_rad) > 1e-8)) angles.push(i);
      if (objects.some(o => Math.abs(o.lengths[i] - figure.segments[i].length) > 1e-8)) lengths.push(i);
    }
    return {name: group.name, choices: group.choices.map((choice, j) => ({id: j + 1, label: choice.label,
      angles: angles.map(i => [figure.segments[i].segment_id, objects[j].angles[i] - figure.segments[i].angle_rad]),
      lengths: lengths.map(i => [figure.segments[i].segment_id, objects[j].lengths[i]])}))};
  })};
  validateFigurePoseChoices(figure);
  return figure;
}
