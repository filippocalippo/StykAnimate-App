/** Current-pose Handle Edit Mode; distinct from reusable figure-definition edits.
 * https://www.pivotanimator.net/help5-2/handle_edit_mode.htm
 */
import {shortest} from './pivot/geometry.mjs';

const EPS = 1e-9;
const finitePoint = (x, y) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Handle coordinates must be finite.');
};

/** Solve the same circular arc between two endpoints. Optional bend editing
 * preserves the tangent at the endpoint being moved, as native R+right-drag.
 */
export function handleEditSegmentPose(shape, start, end, scale, {bend = false, movingEnd = false} = {}) {
  if (!(Math.abs(scale) > EPS)) throw new Error('Increase figure scale before repositioning a handle.');
  const dx = end.x - start.x, dy = end.y - start.y, distance = Math.hypot(dx, dy);
  let angle = shape.angle, curvature = shape.bend;
  const line = [0, 6].includes(shape.seg.primitive_code ?? (shape.seg.flags ?? 0) & 255);
  if (distance > EPS && bend && line) {
    const direction = Math.atan2(dy, dx);
    if (movingEnd) {
      const tangent = shape.angle + shape.bend;
      curvature = 2 * shortest(tangent - direction); angle = tangent - curvature;
    } else { curvature = 2 * shortest(direction - shape.angle); }
  }
  const factor = Math.abs(curvature) < EPS ? 1 : 2 * Math.sin(curvature / 2) / curvature;
  if (Math.abs(factor) < EPS && distance > EPS)
    throw new Error('Reduce the full-circle bend before moving its endpoint.');
  if (distance > EPS && !(bend && line))
    angle = Math.atan2(dy, dx) - curvature / 2 - (factor * scale < 0 ? Math.PI : 0);
  return {angle: shape.angle + shortest(angle - shape.angle),
    length: distance < EPS ? 0 : distance / Math.abs(scale * factor), bend: curvature};
}

function restoreObject(state, object) {
  const before = state.before;
  for (const index of state.indices) object.angles[index] = before.angles[index];
  object.root_x = before.root_x; object.root_y = before.root_y;
  object.len_flag = before.len_flag; object.lengths = before.lengths.slice();
  object.bend_flag = before.bend_flag; object.bends = before.bends.slice();
  if ('runtime_segments' in before) object.runtime_segments = before.runtime_segments;
  else delete object.runtime_segments;
}

export const editorHandleEditMethods = {
  beginHandleEditDrag({label = 'Reposition handle', bend = false} = {}) {
    const figure = this.figure, object = this.object, index = this.selectedJoint;
    if (!figure || !object || index < -1 || index >= figure.segments.length || index < 0 && object.join) return false;
    if (!(Math.abs(object.scale) > EPS)) throw new Error('Increase figure scale before repositioning a handle.');
    if (!this.beginDrag(label)) return false;
    try {
      const geometry = this.geometry, slot = this.selectedSlot;
      const vertex = index < 0 ? 0 : figure.segments[index].segment_id;
      const point = geometry.objects.get(slot)?.joints.get(vertex);
      if (!point) { this.cancelDrag(); return false; }
      const children = new Map();
      this.frame.objects.forEach((child, childSlot) => {
        if (!child.join) return;
        const key = `${child.join.target_object_slot}:${child.join.target_handle_id ?? 0}`;
        const list = children.get(key) || []; list.push(childSlot); children.set(key, list);
      });
      const snapshots = new Map(this._drag.before.map(value => [value.unique_id, value]));
      const queue = [{slot, vertex}], states = [], visited = new Set();
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const item = queue[cursor]; if (visited.has(item.slot)) continue; visited.add(item.slot);
        const g = geometry.objects.get(item.slot), before = snapshots.get(g?.obj.unique_id);
        if (!g || !before) throw new Error('The attached handle is outside the current pose gesture.');
        if (!(Math.abs(g.obj.scale) > EPS)) throw new Error('Increase attached figure scale before repositioning this handle.');
        const incident = g.segments.filter(shape => shape.seg.segment_id === item.vertex || shape.seg.parent_id === item.vertex);
        states.push({...item, g, before, indices: incident.map(shape => shape.index), incident,
          lengths: g.segments.map(shape => shape.length / Math.abs(g.obj.scale)),
          bends: g.segments.map(shape => shape.bend), moved: false});
        // Joined roots share this exact vertex. Their other endpoints remain
        // fixed too; only segments leaving those roots need a new pose.
        for (const childSlot of children.get(`${item.slot}:${item.vertex}`) || []) queue.push({slot: childSlot, vertex: 0});
      }
      this._drag.handleEdit = {uid: this.selectedUid, index, point: {...point}, states, bend};
      return true;
    } catch (error) { this.cancelDrag(); throw error; }
  },

  editHandlePosition(x, y, {bend} = {}) {
    finitePoint(x, y);
    const active = Boolean(this._drag?.handleEdit);
    if (!active && !this.beginHandleEditDrag({bend: bend ?? false})) return false;
    const drag = this._drag, edit = drag.handleEdit;
    if (drag.index !== this.frameIndex || edit.uid !== this.selectedUid || edit.index !== this.selectedJoint) {
      this.cancelDrag(); throw new Error('The selected handle changed during its gesture.');
    }
    try {
      const point = {x, y}, atStart = Math.hypot(x - edit.point.x, y - edit.point.y) < EPS;
      // Solve all edges before applying any mutation, including degenerate arcs.
      const plans = edit.states.map(state => ({state, changes: atStart ? [] : state.incident.map(shape => {
        const movingEnd = shape.seg.segment_id === state.vertex;
        return {index: shape.index, ...handleEditSegmentPose(shape, movingEnd ? shape.start : point,
          movingEnd ? point : shape.end, state.before.scale, {bend: bend ?? edit.bend, movingEnd})};
      })}));
      for (const {state, changes} of plans) {
        const object = this.frame.objects[state.slot];
        if (atStart) { if (state.moved) restoreObject(state, object); state.moved = false; continue; }
        // These private work vectors are allocated once per gesture. Updating
        // the incident indices keeps pointer work independent of branch length.
        object.lengths = state.lengths; object.len_flag = 1;
        const changedBends = changes.some(change => change.bend !== state.g.segments[change.index].bend);
        if (changedBends || state.before.bend_flag) { object.bends = state.bends; object.bend_flag = 1; }
        else { object.bends = state.before.bends.slice(); object.bend_flag = state.before.bend_flag; }
        for (const change of changes) {
          object.angles[change.index] = change.angle;
          state.lengths[change.index] = change.length; state.bends[change.index] = change.bend;
        }
        if (state.vertex === 0) { object.root_x = x; object.root_y = y; }
        delete object.runtime_segments; state.moved = true;
      }
      this.touch();
      if (!active) this.commitDrag();
      return true;
    } catch (error) { this.cancelDrag(); throw error; }
  },

  commitHandleEditDrag() { return this._drag?.handleEdit ? this.commitDrag() : false; },
  cancelHandleEditDrag() { return this._drag?.handleEdit ? this.cancelDrag() : false; },
};
