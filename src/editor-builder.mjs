/** Native Pivot figure authoring. Definition edits clone only the reusable figure. */
import {validateScene} from './pivot/model.mjs';
import {editorBuilderTopologyMethods} from './editor-builder-topology.mjs';
import {editorSpriteSegmentMethods} from './editor-sprite-segment.mjs';
import {editorBuilderStyleMethods} from './editor-builder-style.mjs';
import {editorBuilderBranchMethods} from './editor-builder-branch.mjs';

const clone = value => structuredClone(value);
const MAX_SEGMENTS = 30000;

/** Find a complete branch in linear time, retaining the document's segment order. */
export function segmentBranchIndices(segments, handleId) {
  const children = new Map();
  for (const segment of segments) {
    const list = children.get(segment.parent_id);
    if (list) list.push(segment.segment_id); else children.set(segment.parent_id, [segment.segment_id]);
  }
  const ids = new Set([handleId]), queue = [handleId];
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? []) {
    if (!ids.has(child)) { ids.add(child); queue.push(child); }
  }
  const indices = [];
  for (let i = 0; i < segments.length; i++) if (ids.has(segments[i].segment_id)) indices.push(i);
  return indices;
}
const finite = (value, label, minimum = -Infinity, maximum = Infinity) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
    throw new Error(`${label} must be a finite number between ${minimum} and ${maximum}.`);
  return value;
};
const rgb = value => {
  if (typeof value === 'string' && /^#[\da-f]{6}$/i.test(value)) value = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
  if (!Array.isArray(value) || value.length !== 3 || value.some(n => !Number.isInteger(n) || n < 0 || n > 255))
    throw new Error('Color must be a six-digit hex color or three RGB bytes.');
  return [...value];
};
const transparency = opacity => Math.round(255 * (1 - finite(opacity, 'Opacity', 0, 1)));
const bits = value => new Uint32Array(new Float32Array([value]).buffer)[0];
const vertexIds = (figure, values) => {
  if (!Array.isArray(values)) throw new Error('Choose at least three figure handles for a polygon.');
  const ids = [...values];
  if (ids.length > 1 && ids[0] === ids.at(-1)) ids.pop();
  const valid = new Set([0, ...figure.segments.map(s => s.segment_id)]);
  if (ids.length < 3 || ids.length > 65535 || new Set(ids).size !== ids.length || ids.some((id, i) =>
    !Number.isInteger(id) || !valid.has(id) || id === ids[(i + 1) % ids.length]))
    throw new Error('A polygon needs at least three distinct existing handles without repeated neighboring points.');
  return ids;
};
// Native CheckDuplicatePolygon compares a closed ordered cycle with either
// direction and any starting vertex; the same vertex set may draw other edges.
const polygonCycle = ids => {
  let start = 0; for (let i = 1; i < ids.length; i++) if (ids[i] < ids[start]) start = i;
  const forward = [], reverse = [];
  for (let i = 0; i < ids.length; i++) {forward.push(ids[(start + i) % ids.length]); reverse.push(ids[(start - i + ids.length) % ids.length]);}
  return [forward.join(','), reverse.join(',')].sort()[0];
};
const rejectDuplicatePolygon = (figure, polygon) => {
  const cycle = polygonCycle(polygon.segment_ids);
  if ((figure.polyfills ?? []).some(other => other !== polygon && other.segment_ids?.length === polygon.segment_ids.length && polygonCycle(other.segment_ids) === cycle))
    throw new Error('A polygon already uses this connection cycle.');
};
const patchPolygon = (figure, polygon, patch) => {
  if ('handleIds' in patch) polygon.segment_ids = vertexIds(figure, patch.handleIds);
  if ('color' in patch) polygon.color_rgb = rgb(patch.color);
  if ('opacity' in patch) { polygon.alpha_raw = transparency(patch.opacity); polygon.color_alpha = 1 - polygon.alpha_raw / 255; }
  if ('zOrder' in patch) { polygon.z_order = finite(patch.zOrder, 'Polygon order'); polygon.z_order_runtime_raw = polygon.z_order - 1; }
  polygon.segment_ids_raw = [...polygon.segment_ids]; polygon.vertex_id_space = 'joint_tip_ids';
};

function editDefinition(editor, label, mutate) {
  if (!editor.figure) return false;
  if (editor.dragging) editor.commitDrag();
  const before = clone(editor.figure), figure = clone(before), index = editor.report.figure_types.indexOf(editor.figure);
  mutate(figure);
  // Validate the changed definition without traversing every animation frame.
  validateScene({...editor.report, figure_types: [figure], backgrounds: [], keyframes: [{objects: [], duration_raw: 1}]});
  if (JSON.stringify(before) === JSON.stringify(figure)) return false;
  delete figure.segment_z_raw; delete figure.poly_z_raw;
  const selection = editor._selectionState();
  editor.report.figure_types[index] = figure;
  editor._record({kind: 'figure', label, index, before, after: clone(figure), beforeSelection: selection,
    afterSelection: selection, structural: false, timing: false});
  editor._invalidate(); editor._emit('edit', {label, definition: true});
  return figure;
}

export const editorBuilderMethods = {
  ...editorBuilderTopologyMethods,
  ...editorSpriteSegmentMethods,
  ...editorBuilderStyleMethods,
  ...editorBuilderBranchMethods,
  addPolygon(handleIds, {color = '#2b2b2b', opacity = 1, zOrder} = {}) {
    if (!this.figure) throw new Error('Select a figure before creating a polygon.');
    let polygon;
    editDefinition(this, 'Create polygon', figure => {
      figure.polyfills ??= [];
      if (figure.polyfills.length >= 20000) throw new Error('A figure supports at most 20,000 polygons.');
      const id = Math.max(0, ...figure.polyfills.map((p, i) => p.polyfill_id ?? i + 1)) + 1;
      // Fills start behind their skeleton so posing remains visually legible.
      const order = zOrder ?? Math.min(1, ...figure.segments.map(s => s.z_order ?? 1), ...figure.polyfills.map(p => p.z_order ?? 1)) - 1;
      polygon = {polyfill_id: id};
      patchPolygon(figure, polygon, {handleIds, color, opacity, zOrder: order}); rejectDuplicatePolygon(figure, polygon); figure.polyfills.push(polygon);
    });
    return polygon;
  },
  updatePolygon(index, patch = {}) {
    if (!Number.isInteger(index) || !this.figure?.polyfills?.[index]) throw new Error('Select an existing polygon.');
    for (const key of Object.keys(patch)) if (!['handleIds', 'color', 'opacity', 'zOrder'].includes(key)) throw new Error(`Polygon property ${key} is not editable.`);
    return editDefinition(this, 'Edit polygon', figure => {const polygon = figure.polyfills[index]; patchPolygon(figure, polygon, patch); if ('handleIds' in patch) rejectDuplicatePolygon(figure, polygon);});
  },
  removePolygon(index) {
    if (!Number.isInteger(index) || !this.figure?.polyfills?.[index]) return false;
    return editDefinition(this, 'Delete polygon', figure => { figure.polyfills.splice(index, 1); });
  },
  updateFigureStyle(patch = {}) {
    for (const key of Object.keys(patch)) if (!['name', 'outlineWidth', 'outlineColor', 'outlineOpacity'].includes(key)) throw new Error(`Figure property ${key} is not editable.`);
    return editDefinition(this, 'Edit figure style', figure => {
      if ('name' in patch) {
        if (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 255) throw new Error('Figure names must contain 1–255 characters.');
        figure.name = patch.name.trim();
      }
      if (Object.keys(patch).some(key => key.startsWith('outline'))) {
        figure.segment_decode ??= {};
        const style = figure.segment_decode.global_style ??= {u28: 0, outline_thickness: 0, rgb: [0, 0, 0], u30: 0};
        if ('outlineWidth' in patch) { style.outline_thickness = finite(patch.outlineWidth, 'Outline width', 0, 1e6); style.u28 = bits(style.outline_thickness); }
        if ('outlineColor' in patch) style.rgb = rgb(patch.outlineColor);
        if ('outlineOpacity' in patch) style.u30 = transparency(patch.outlineOpacity);
      }
    });
  },
  updateSegmentStyle(patch = {}) {
    return this.updateBuilderSegmentStyle(patch);
  },
  convertSegment(shape) { return this.updateSegmentStyle({shape}); },
  duplicateSegment({angleOffset = 0, parentId, branch = false, flip = false} = {}) {
    finite(angleOffset, 'Branch rotation');
    if (typeof branch !== 'boolean' || typeof flip !== 'boolean') throw new Error('Choose whether to duplicate the whole branch and flip it.');
    const figure = this.figure, selected = figure?.segments[this.selectedJoint];
    if (!selected) return false;
    const anchor = parentId ?? selected.parent_id;
    if (!Number.isInteger(anchor) || ![0, ...figure.segments.map(s => s.segment_id)].includes(anchor)) throw new Error('Choose an existing parent handle.');
    const indices = branch ? segmentBranchIndices(figure.segments, selected.segment_id) : [this.selectedJoint];
    const angleOf = angle => (flip ? angle < 0 ? -Math.PI - angle : Math.PI - angle : angle) + angleOffset;
    const ids = new Set(indices.map(i => figure.segments[i].segment_id));
    const firstId = Math.max(...figure.segments.map(s => s.segment_id)) + 1;
    if (figure.segments.length + indices.length > MAX_SEGMENTS) throw new Error('A figure supports at most 30,000 segments with 16-bit joint IDs.');
    const available = [];
    if (firstId + indices.length - 1 <= 65535) for (let i = 0; i < indices.length; i++) available.push(firstId + i);
    else {const used = new Set(figure.segments.map(segment => segment.segment_id)); for (let id = 1; id <= 65535 && available.length < indices.length; id++) if (!used.has(id)) available.push(id);}
    if (available.length !== indices.length) throw new Error('The figure has no free native joint IDs.');
    const remap = new Map(indices.map((i, offset) => [figure.segments[i].segment_id, available[offset]]));
    const initialCount = figure.segments.length;
    this._topologyEdit(`Duplicate ${branch ? 'segment branch' : 'segment'}`, next => {
      const maxOrder = Math.max(0, ...next.segments.map(s => s.z_order ?? 0), ...(next.polyfills ?? []).map(p => p.z_order ?? 0));
      const copies = indices.map(i => {
        const segment = clone(next.segments[i]); delete segment._logical_segment_id;
        segment.segment_id = remap.get(segment.segment_id);
        segment.parent_id = next.segments[i].segment_id === selected.segment_id ? anchor : remap.get(segment.parent_id);
        segment.angle_rad = angleOf(segment.angle_rad); if (flip) segment.bend_rad = -(segment.bend_rad ?? 0);
        // Native Duplicate copies image flags, while text flags start at the
        // AddSegment defaults. Generic FlipSegment has a different text path.
        if (segment.primitive_code === 2 && flip) segment.extra_u8_b = Number(!Boolean(segment.extra_u8_b ?? segment.extra?.[2]));
        if (segment.primitive_code === 5) {segment.extra_u8_a = 0; segment.extra_u8_b = 0;}
        if ([2, 5].includes(segment.primitive_code) && Array.isArray(segment.extra)) segment.extra = [segment.extra[0], segment.extra_u8_a ?? segment.extra[1], segment.extra_u8_b ?? segment.extra[2]];
        return segment;
      });
      const polygons = branch ? (next.polyfills ?? []).filter(poly => poly.segment_ids.every(id => ids.has(id) || id === selected.parent_id) && poly.segment_ids.some(id => ids.has(id))).map(clone) : [];
      if ((next.polyfills?.length ?? 0) + polygons.length > 20000) throw new Error('A figure supports at most 20,000 polygons.');
      let polygonId = Math.max(0, ...(next.polyfills ?? []).map((p, i) => p.polyfill_id ?? i + 1));
      for (const polygon of polygons) {
        polygon.polyfill_id = ++polygonId; polygon.segment_ids = polygon.segment_ids.map(id => remap.get(id) ?? anchor);
        polygon.segment_ids_raw = [...polygon.segment_ids];
      }
      [...copies, ...polygons].sort((a, b) => (a.z_order ?? 0) - (b.z_order ?? 0)).forEach((item, i) => { item.z_order = maxOrder + i + 1; item.z_order_runtime_raw = item.z_order - 1; });
      for (const frame of this._allSourceFrames()) for (const object of frame.objects) if (object.figure_type_id === next.figure_type_id) {
        for (const [flag, field, nativeField] of [['len_flag', 'lengths', 'length'], ['bend_flag', 'bends', 'bend_rad']]) {
          if (!object[flag] && object.runtime_segments?.some((runtime, index) => runtime[nativeField] !== undefined && runtime[nativeField] !== (next.segments[index][nativeField] ?? 0))) {
            object[flag] = 1; object[field] = next.segments.map((segment, index) => object.runtime_segments[index]?.[nativeField] ?? segment[nativeField] ?? 0);
          }
        }
        object.angles.push(...indices.map(i => angleOf(object.angles[i])));
        if (object.len_flag) object.lengths.push(...indices.map(i => object.lengths[i]));
        if (object.bend_flag) object.bends.push(...indices.map(i => (flip ? -1 : 1) * object.bends[i]));
        delete object.runtime_segments;
      }
      next.segments.push(...copies); next.polyfills = [...(next.polyfills ?? []), ...polygons];
      this.selectedJoint = initialCount + indices.indexOf(this.selectedJoint);
    }, {segmentMap: new Map([...remap].map(([source, target]) => [source, [source, target]]))});
    return {handleIds: indices.map(i => remap.get(figure.segments[i].segment_id)), selectedHandleId: remap.get(selected.segment_id)};
  },
  duplicateSegmentBranch(options = {}) {return this.duplicateSegment({...options, branch: true});},
};
