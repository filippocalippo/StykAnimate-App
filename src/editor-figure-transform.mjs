/** Native Alt+handle transforms about the selected figure's own origin.
 * https://www.pivotanimator.net/help5-2/size_and_rotation.htm
 */
import {shortest} from './pivot/geometry.mjs';
import {rotateOriginSupport} from './animation-origin-support.mjs';
const EPS = 1e-9;
const coordinates = (x, y) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Transform coordinates must be finite.');
};

export function createFigureHandleTransform(origin, start) {
  coordinates(origin.x, origin.y); coordinates(start.x, start.y);
  const dx = start.x - origin.x, dy = start.y - origin.y, distance = Math.hypot(dx, dy);
  if (!(distance > EPS)) throw new Error('Drag a handle away from the figure origin to rotate or scale.');
  return {origin: {...origin}, distance, lastAngle: Math.atan2(dy, dx), rotation: 0};
}

/** Accumulates crossings of ±π without altering the original scale reference.
 * Ctrl locks scale; Shift locks rotation. Toolbar toggles work independently.
 */
export function figureHandleTransform(state, point, {rotate = true, scale = true, ctrlKey = false, shiftKey = false} = {}) {
  coordinates(point.x, point.y);
  const dx = point.x - state.origin.x, dy = point.y - state.origin.y, distance = Math.hypot(dx, dy);
  if (distance > EPS) {
    const angle = Math.atan2(dy, dx);
    state.rotation += shortest(angle - state.lastAngle); state.lastAngle = angle;
  }
  return {radians: rotate && !shiftKey ? state.rotation : 0, factor: scale && !ctrlKey ? distance / state.distance : 1};
}

export const editorFigureTransformMethods = {
  beginFigureHandleDrag(x, y, {rotate = true, scale = true, label = 'Transform figure'} = {}) {
    if (!this.object || this.selectedJoint < 0 || !this.figure?.segments[this.selectedJoint]) return false;
    const original = this.geometry.objects.get(this.selectedSlot), handle = original?.segments[this.selectedJoint]?.end;
    x ??= handle?.x; y ??= handle?.y; coordinates(x, y);
    if (!original || !(Math.abs(this.object.scale) > EPS)) throw new Error('Increase figure scale before transforming a handle.');
    // Validate before beginning a command so invalid starts leave history alone.
    createFigureHandleTransform(original.root, {x, y});
    if (!this.beginDrag(label)) return false;
    try {
      const slot = this.selectedSlot, geometry = this.geometry, children = new Map();
      this.frame.objects.forEach((object, index) => {
        if (!object.join) return;
        const values = children.get(object.join.target_object_slot) || [];
        values.push(index); children.set(object.join.target_object_slot, values);
      });
      const queue = [slot], affected = new Set(queue);
      for (let cursor = 0; cursor < queue.length; cursor++) for (const index of children.get(queue[cursor]) || [])
        if (!affected.has(index)) { affected.add(index); queue.push(index); }
      const snapshots = new Map(this._drag.before.map(object => [object.unique_id, object]));
      this._drag.figureHandle = {uid: this.selectedUid, rotate, scale,
        transform: createFigureHandleTransform(geometry.objects.get(slot).root, {x, y}),
        targets: queue.map(index => ({slot: index, before: snapshots.get(this.frame.objects[index].unique_id)}))};
      return true;
    } catch (error) { this.cancelDrag(); throw error; }
  },

  transformFigureHandle(x, y, options = {}) {
    coordinates(x, y);
    const active = Boolean(this._drag?.figureHandle);
    if (!active && !this.beginFigureHandleDrag(undefined, undefined, options)) return false;
    const drag = this._drag, edit = drag.figureHandle;
    if (drag.index !== this.frameIndex || edit.uid !== this.selectedUid) {
      this.cancelDrag(); throw new Error('The selected figure changed during its gesture.');
    }
    try {
      const {radians, factor} = figureHandleTransform(edit.transform, {x, y}, {...edit, ...options});
      for (const {slot, before} of edit.targets) {
        const object = this.frame.objects[slot];
        if (before._stykAnimationOrigin) object._stykAnimationOrigin = {...before._stykAnimationOrigin};
        object.scale = before.scale * factor;
        for (let index = 0; index < before.angles.length; index++) object.angles[index] = before.angles[index] + radians;
        rotateOriginSupport(this.report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id), object, radians);
        // The selected origin remains fixed; joined descendants derive their
        // positions from the transformed parent vertices and commit canonically.
        if (Math.abs(radians) < EPS && Math.abs(factor - 1) < EPS) {
          object.scale = before.scale;
          for (let index = 0; index < before.angles.length; index++) object.angles[index] = before.angles[index];
          if (before._stykAnimationOrigin) object._stykAnimationOrigin = {...before._stykAnimationOrigin};
          if ('runtime_segments' in before) object.runtime_segments = before.runtime_segments;
          else delete object.runtime_segments;
        } else delete object.runtime_segments;
      }
      this.touch(); if (!active) this.commitDrag(); return true;
    } catch (error) { this.cancelDrag(); throw error; }
  },
  commitFigureHandleDrag() { return this._drag?.figureHandle ? this.commitDrag() : false; },
  cancelFigureHandleDrag() { return this._drag?.figureHandle ? this.cancelDrag() : false; },
};
