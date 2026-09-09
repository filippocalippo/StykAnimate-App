/** Native builder Delete / Ctrl+Delete and segment / branch mirror commands. */
import {buildGeometry} from './pivot/geometry.mjs';

const EPS = 1e-9;
function topology(segments) {
  const indices = new Map(segments.map((segment, index) => [segment.segment_id, index])), children = new Map(), order = [];
  segments.forEach((segment, index) => {
    if (segment.parent_id === 0) order.push(index);
    else { const list = children.get(segment.parent_id) ?? []; list.push(index); children.set(segment.parent_id, list); }
  });
  for (let i = 0; i < order.length; i++) for (const child of children.get(segments[order[i]].segment_id) ?? []) order.push(child);
  if (order.length !== segments.length) throw new Error('The figure contains an invalid joint hierarchy.');
  return {indices, children, order};
}
function points(segments, object, tree, root = {x: 0, y: 0}, scale = 1) {
  const joints = new Map([[0, root]]);
  for (const index of tree.order) {
    const segment = segments[index], start = joints.get(segment.parent_id), runtime = object?.runtime_segments?.[index];
    const angle = object?.angles?.[index] ?? segment.angle_rad, bend = object?.bend_flag ? object.bends[index] : runtime?.bend_rad ?? segment.bend_rad ?? 0;
    const length = (object?.len_flag ? object.lengths[index] : runtime?.length ?? segment.length) * scale;
    const x = Math.abs(bend) < 1e-7 ? length * Math.cos(angle) : length / bend * (Math.sin(angle + bend) - Math.sin(angle));
    const y = Math.abs(bend) < 1e-7 ? length * Math.sin(angle) : length / bend * (Math.cos(angle) - Math.cos(angle + bend));
    joints.set(segment.segment_id, {x: Math.fround(start.x + x), y: Math.fround(start.y + y)});
  }
  return joints;
}
function fit(start, end, bend, fallbackAngle, scale = 1) {
  const distance = Math.hypot(end.x - start.x, end.y - start.y), factor = Math.abs(bend) < EPS ? 1 : 2 * Math.sin(bend / 2) / bend;
  if (Math.abs(factor) < EPS && distance > EPS) throw new Error('Reduce the closed full-circle bend before removing its parent joint.');
  return {angle: distance < EPS ? fallbackAngle : Math.atan2(end.y - start.y, end.x - start.x) - bend / 2 - (factor * scale < 0 ? Math.PI : 0),
    length: distance < EPS ? 0 : distance / Math.abs(factor * scale)};
}
// Pivot's Ctrl+Delete merges a smooth, same-direction pair of arcs before
// fitting the surviving edge to its original endpoint (native 0xB09616).
function mergedBend(parentAngle, parentBend, childAngle, childBend) {
  const difference = Math.atan2(Math.sin(childAngle - parentAngle - parentBend), Math.cos(childAngle - parentAngle - parentBend));
  return Math.abs(parentBend) > .001 && Math.abs(parentBend + childBend) < 2 * Math.PI &&
    parentBend * childBend > 0 && Math.abs(difference) < .02 ? parentBend + childBend : childBend;
}
/** Resolve only needed objects and their ancestors, avoiding unrelated geometry. */
function componentGeometry(report, frame, required) {
  const needed = new Set(required);
  for (const slot of required) {
    let cursor = slot;
    while (frame.objects[cursor]?.join) {
      cursor = frame.objects[cursor].join.target_object_slot;
      if (needed.has(cursor)) break; needed.add(cursor);
    }
  }
  const slots = [...needed].sort((a, b) => a - b), local = new Map(slots.map((slot, index) => [slot, index]));
  const objects = slots.map((slot, index) => ({...frame.objects[slot], object_slot: index,
    join: frame.objects[slot].join ? {...frame.objects[slot].join, target_object_slot: local.get(frame.objects[slot].join.target_object_slot)} : null}));
  const geometry = buildGeometry(report, {...frame, objects, object_draw_order: objects.map((_, index) => index)});
  return slot => geometry.objects.get(local.get(slot));
}
function frameInstances(frame, typeId) {
  const slots = [];
  frame.objects.forEach((object, slot) => {if (object.figure_type_id === typeId) slots.push(slot);});
  return slots;
}
function retainRuntimePose(object, segments) {
  const runtime = object.runtime_segments; if (!runtime) return;
  for (const [flag, values, field, fallback] of [['len_flag', 'lengths', 'length', 0], ['bend_flag', 'bends', 'bend_rad', 0]]) {
    if (object[flag] || !segments.some((segment, index) => runtime[index]?.[field] !== undefined && runtime[index][field] !== (segment[field] ?? fallback))) continue;
    object[flag] = 1; object[values] = segments.map((segment, index) => runtime[index]?.[field] ?? segment[field] ?? fallback);
  }
}
function canonicalizeChildren(report, frame, roots) {
  const children = new Map();
  frame.objects.forEach((object, slot) => {
    if (!object.join) return;
    const list = children.get(object.join.target_object_slot) ?? []; list.push(slot); children.set(object.join.target_object_slot, list);
  });
  const affected = new Set(roots), queue = [...roots], moved = new Set();
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? []) {
    moved.add(child); if (!affected.has(child)) {affected.add(child); queue.push(child);}
  }
  if (!moved.size) return;
  const get = componentGeometry(report, frame, affected);
  for (const slot of moved) {const root = get(slot)?.root; if (root) {frame.objects[slot].root_x = root.x; frame.objects[slot].root_y = root.y;}}
}
function trimPolygons(figure, removedId) {
  figure.polyfills = (figure.polyfills ?? []).flatMap(polygon => {
    const ids = (polygon.segment_ids ?? []).filter(id => id !== removedId);
    return new Set(ids).size < 3 ? [] : [{...polygon, segment_ids: ids, segment_ids_raw: [...ids]}];
  });
}

export const editorBuilderTopologyMethods = {
  /** Plain Delete removes one segment; Ctrl+Delete preserves surviving joints. */
  deleteSingleSegment({preserveEndpoints = false} = {}) {
    const figure = this.figure, index = this.selectedJoint, segment = figure?.segments[index];
    if (!segment) return false;
    if (typeof preserveEndpoints !== 'boolean') throw new Error('Choose whether to preserve the other joints.');
    if (figure.segments.length === 1) throw new Error('A figure needs at least one segment. Delete the figure to remove it completely.');
    const tree = topology(figure.segments), children = tree.children.get(segment.segment_id) ?? [];
    const defaults = preserveEndpoints && children.length ? points(figure.segments, null, tree) : null;
    return this._topologyEdit(preserveEndpoints ? 'Remove joint (Unsplit)' : 'Delete single segment', next => {
      const touched = [];
      for (const frame of this._allSourceFrames()) {
        const instances = frameInstances(frame, next.figure_type_id); if (!instances.length) continue;
        touched.push({frame, instances}); const typed = new Set(instances), detached = [];
        frame.objects.forEach((object, slot) => {if (object.join?.target_handle_id === segment.segment_id && typed.has(object.join.target_object_slot)) detached.push(slot);});
        const needed = [...detached, ...instances.filter(slot => frame.objects[slot].join)], get = needed.length ? componentGeometry(this.report, frame, needed) : null;
        // An external figure whose exact attachment handle disappears stays put.
        for (const slot of detached) {const object = frame.objects[slot], root = get(slot).root; object.root_x = root.x; object.root_y = root.y; object.join = null;}
        for (const slot of instances) {
          const object = frame.objects[slot];
          retainRuntimePose(object, next.segments);
          if (preserveEndpoints && children.length) {
            const scale = Math.abs(object.scale) > EPS ? object.scale : 1;
            const root = get?.(slot)?.root ?? {x: object.root_x, y: object.root_y};
            const joints = points(next.segments, object, tree, root, scale), start = joints.get(segment.parent_id);
            const lengths = object.len_flag ? object.lengths : next.segments.map((s, i) => object.runtime_segments?.[i]?.length ?? s.length);
            const bends = object.bend_flag ? object.bends : next.segments.map((s, i) => object.runtime_segments?.[i]?.bend_rad ?? s.bend_rad ?? 0);
            for (const childIndex of children) {
              const child = next.segments[childIndex], bend = mergedBend(object.angles[index], bends[index], object.angles[childIndex], bends[childIndex]);
              const pose = fit(start, joints.get(child.segment_id), bend, object.angles[childIndex], scale);
              object.angles[childIndex] = pose.angle; lengths[childIndex] = pose.length; bends[childIndex] = bend;
            }
            object.len_flag = 1; object.lengths = lengths; object.bend_flag = 1; object.bends = bends;
          }
          object.angles.splice(index, 1); if (object.len_flag) object.lengths.splice(index, 1); if (object.bend_flag) object.bends.splice(index, 1);
          delete object.runtime_segments;
        }
      }
      for (const childIndex of children) {
        const child = next.segments[childIndex];
        if (defaults) {const bend = mergedBend(segment.angle_rad, segment.bend_rad ?? 0, child.angle_rad, child.bend_rad ?? 0);
          const pose = fit(defaults.get(segment.parent_id), defaults.get(child.segment_id), bend, child.angle_rad); child.angle_rad = pose.angle; child.length = pose.length; child.bend_rad = bend;}
        child.parent_id = segment.parent_id;
      }
      next.segments.splice(index, 1); trimPolygons(next, segment.segment_id);
      for (const {frame, instances} of touched) canonicalizeChildren(this.report, frame, instances);
      this.selectedJoint = segment.parent_id === 0 ? -1 : next.segments.findIndex(s => s.segment_id === segment.parent_id);
    }, {originFreezeHandles: preserveEndpoints ? new Set(children.map(index => figure.segments[index].segment_id)) : undefined});
  },
  unsplitSegment() {return this.deleteSingleSegment({preserveEndpoints: true});},
  /** Reflect around the selected segment's parent joint; Shift includes its branch. */
  mirrorSegment(axis = 'horizontal', {branch = false} = {}) {
    if (!['horizontal', 'vertical'].includes(axis)) throw new Error('Choose a horizontal or vertical flip.');
    const figure = this.figure, index = this.selectedJoint, segment = figure?.segments[index]; if (!segment) return false;
    const tree = topology(figure.segments), indices = [index];
    if (branch) for (let i = 0; i < indices.length; i++) for (const child of tree.children.get(figure.segments[indices[i]].segment_id) ?? []) indices.push(child);
    const reflect = angle => axis === 'horizontal' ? (angle < 0 ? -Math.PI - angle : Math.PI - angle) : -angle;
    return this._topologyEdit(`Flip ${branch ? 'branch' : 'segment'} ${axis}`, next => {
      const frames = [];
      for (const frame of this._allSourceFrames()) {
        const instances = frameInstances(frame, next.figure_type_id); if (!instances.length) continue; frames.push({frame, instances});
        for (const slot of instances) {
          const object = frame.objects[slot];
          retainRuntimePose(object, next.segments);
          for (const i of indices) {object.angles[i] = reflect(object.angles[i]); if (object.bend_flag) object.bends[i] = -object.bends[i];}
          delete object.runtime_segments;
        }
      }
      for (const i of indices) {
        const current = next.segments[i]; current.angle_rad = reflect(current.angle_rad); current.bend_rad = -(current.bend_rad ?? 0);
        if ([2, 5].includes(current.primitive_code)) {
          current.extra_u8_b = Number(!Boolean(current.extra_u8_b ?? current.extra?.[2]));
          if (Array.isArray(current.extra)) current.extra = current.extra.map((value, index) => index === 2 ? current.extra_u8_b : value);
        }
      }
      for (const {frame, instances} of frames) canonicalizeChildren(this.report, frame, instances);
    });
  },
  mirrorSegmentBranch(axis = 'horizontal') {return this.mirrorSegment(axis, {branch: true});},
};
