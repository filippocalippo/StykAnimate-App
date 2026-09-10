/** Bounded, document-owned memoization for derived IK poses. Artwork is excluded
 * from the dependency snapshot; every numeric solver input is compared by value,
 * so in-place edits, undo and arbitrary timeline seeks cannot reuse stale poses. */
import {solveObjectIK, ikConstruction} from './ik.mjs';

const documents = new WeakMap();
const MAX_ENTRIES = 1024, MAX_BONES = 250000;

function poseInputs(figure, object, root) {
  const polygons = (figure.polyfills ?? []).map(p => p.segment_ids ?? []);
  const values = new Float64Array(3 + figure.segments.length * 8 + polygons.reduce((n, p) => n + 1 + p.length, 0));
  values[0] = root.x; values[1] = root.y; values[2] = object.scale;
  figure.segments.forEach((segment, i) => {
    const at = 3 + i * 8;
    values[at] = segment.segment_id; values[at + 1] = segment.parent_id;
    values[at + 2] = object.angles[i];
    values[at + 3] = object.len_flag ? object.lengths[i] : segment.length;
    values[at + 4] = object.bend_flag ? object.bends[i] : segment.bend_rad ?? 0;
    values[at + 5] = Number(ikConstruction(segment)); values[at + 6] = segment.length;
    values[at + 7] = segment.angle_rad ?? object.angles[i];
  });
  let at = 3 + figure.segments.length * 8;
  for (const polygon of polygons) {values[at++] = polygon.length; for (const id of polygon) values[at++] = id;}
  return values;
}

export function evaluateIKPose(report, key, figure, object, root, layout) {
  let cache = documents.get(report);
  if (!cache) documents.set(report, cache = {entries: new Map(), bones: 0});
  const inputs = poseInputs(figure, object, root), controllers = JSON.stringify(object._stykIK);
  const previous = cache.entries.get(key), bones = figure.segments.length;
  if (previous && previous.controllers === controllers && previous.inputs.length === inputs.length &&
      inputs.every((value, i) => Object.is(value, previous.inputs[i]))) {
    cache.entries.delete(key); cache.entries.set(key, previous);
    return previous.solution;
  }
  const solution = solveObjectIK(figure, object, root, layout);
  if (previous) {cache.entries.delete(key); cache.bones -= previous.bones;}
  if (bones <= MAX_BONES) {
    cache.entries.set(key, {inputs, controllers, solution, bones}); cache.bones += bones;
    while (cache.entries.size > MAX_ENTRIES || cache.bones > MAX_BONES) {
      const oldest = cache.entries.keys().next().value;
      cache.bones -= cache.entries.get(oldest).bones; cache.entries.delete(oldest);
    }
  }
  return solution;
}
