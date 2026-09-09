import {frameOrder, setOrder} from './pivot/structure.mjs';
import {objectBounds} from './renderer-geometry.mjs';
import {segmentBranchIndices} from './editor-builder.mjs';

const validIds = (uids, existing) => new Set([...uids].filter(uid => existing.has(uid)));

/** Selection is UI state: it must not invalidate scene caches or command history. */
function applySelection(editor, ids, preferred = editor.selectedUid) {
  editor._branchSelection = null;
  const active = editor.selectedUid;
  const nextActive = ids.has(preferred) ? preferred : [...ids].at(-1) ?? null;
  const changed = editor.selectedJoint !== -1 || active !== nextActive || ids.size !== editor.selectedUids.size ||
    [...ids].some(uid => !editor.selectedUids.has(uid));
  editor.selectedUids = ids;
  editor._selectedUid = nextActive;
  editor.selectedJoint = -1;
  if (changed) editor._emit('selection');
  return editor.selectedObjects;
}

function partitionLayers(editor, front) {
  const before = frameOrder(editor.selectionFrame), groups = new Map();
  for (const uid of before) { const id = editor.layerForUid(uid), group = groups.get(id) ?? {selected: [], others: [], cursor: 0};
    (editor.selectedUids.has(uid) ? group.selected : group.others).push(uid); groups.set(id, group); }
  for (const group of groups.values()) group.order = front ? [...group.others, ...group.selected] : [...group.selected, ...group.others];
  const after = before.map(uid => { const group = groups.get(editor.layerForUid(uid)); return group.order[group.cursor++]; });
  if (before.every((uid, index) => uid === after[index])) return false;
  return editor.transaction(front ? 'Bring figures to front' : 'Send figures to back', frame => {
    // Only the native paint-order slots change. Object slots remain join targets.
    setOrder(frame, after);
  }, {structural: true});
}

function selectedComponents(editor) {
  const objects = editor.selectionFrame.objects, roots = new Map(), groups = new Map();
  for (let selected = 0; selected < objects.length; selected++) {
    if (!editor.selectedUids.has(objects[selected].unique_id)) continue;
    let slot = selected;
    const path = [], visiting = new Set();
    while (!roots.has(slot) && objects[slot]?.join) {
      if (visiting.has(slot)) throw new Error('Figures contain a cyclic join.');
      visiting.add(slot); path.push(slot); slot = objects[slot].join.target_object_slot;
      if (!objects[slot]) throw new Error('Join target is missing.');
    }
    const root = roots.get(slot) ?? slot;
    roots.set(slot, root);
    for (const visited of path) roots.set(visited, root);
    const group = groups.get(root);
    if (group) group.push(selected); else groups.set(root, [selected]);
  }
  return groups;
}

function defaultBounds(geometry) {
  return objectBounds([
    ...geometry.segments.filter(segment => segment.seg.visible !== false).map(segment => ({
      ...segment, type: segment.seg.segment_type || 'line',
    })),
    ...geometry.polys,
  ]);
}

function normalizedBounds(value) {
  const bounds = value && ('minX' in value ? value : {
    minX: value.x, minY: value.y, maxX: value.x + value.width, maxY: value.y + value.height,
  });
  if (!bounds || !['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(bounds[key])) ||
      bounds.maxX < bounds.minX || bounds.maxY < bounds.minY)
    throw new Error('Figure bounds must contain finite, ordered coordinates.');
  return bounds;
}

export const editorSelectionMethods = {
  /** Joins address slots; handles address IDs, never segment array offsets. */
  selectConnected(uid = this.selectedUid, {add = false, candidates} = {}) {
    const objects = this.selectionFrame.objects, start = objects.findIndex(o => o.unique_id === uid);
    if (start < 0) return this.selectedObjects;
    const neighbors = new Map(objects.map((_, slot) => [slot, []]));
    objects.forEach((object, slot) => {
      const target = object.join?.target_object_slot;
      if (neighbors.has(target)) { neighbors.get(slot).push(target); neighbors.get(target).push(slot); }
    });
    const slots = new Set([start]), queue = [start];
    for (let i = 0; i < queue.length; i++) for (const slot of neighbors.get(queue[i]))
      if (!slots.has(slot)) { slots.add(slot); queue.push(slot); }
    const eligible = candidates === undefined ? null : new Set(candidates);
    const ids = add ? new Set(this.selectedUids) : new Set();
    objects.forEach((object, slot) => { if (slots.has(slot) && (!eligible || eligible.has(object.unique_id))) ids.add(object.unique_id); });
    return applySelection(this, ids, uid);
  },

  selectBranch(uid, joint) {
    const objects = this.selectionFrame.objects, slot = objects.findIndex(o => o.unique_id === uid);
    const figure = this.report.figure_types.find(f => f.figure_type_id === objects[slot]?.figure_type_id);
    if (!figure?.segments[joint]) return false;
    const handles = new Set(segmentBranchIndices(figure.segments, figure.segments[joint].segment_id).map(i => figure.segments[i].segment_id));
    const slots = new Set([slot]), children = new Map();
    objects.forEach((object, index) => {
      if (!object.join) return;
      const target = object.join.target_object_slot;
      if (target === slot && !handles.has(object.join.target_handle_id)) return;
      if (!children.has(target)) children.set(target, []);
      children.get(target).push(index);
    });
    const queue = [slot];
    for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? [])
      if (!slots.has(child)) { slots.add(child); queue.push(child); }
    this.selectedUids = new Set(objects.filter((_, i) => slots.has(i)).map(o => o.unique_id));
    this._selectedUid = uid; this.selectedJoint = joint;
    this._branchSelection = {uid, joint};
    this._emit('selection'); return true;
  },

  /** Extract a posed branch as an independent definition, retaining its media,
   * internal polygons and attached figures. The source document is untouched. */
  copyBranchSelection() {
    const figure = this.figure, joint = this.selectedJoint;
    if (!figure?.segments[joint]) return 0;
    const indices = segmentBranchIndices(figure.segments, figure.segments[joint].segment_id);
    const handles = new Set(indices.map(i => figure.segments[i].segment_id));
    const boundary = figure.segments[joint].parent_id, geometry = this.geometry.objects.get(this.selectedSlot);
    const branch = structuredClone(figure);
    branch.figure_type_id = Math.max(0, ...this.report.figure_types.map(f => f.figure_type_id)) + 1;
    branch.name = `${figure.name || 'Figure'} branch`;
    branch.segments = indices.map(i => {
      const segment = structuredClone(figure.segments[i]), posed = geometry.segments[i];
      if (segment.parent_id === boundary) segment.parent_id = 0;
      segment.angle_rad = posed.angle; segment.bend_rad = posed.bend;
      segment.length = geometry.obj.scale ? posed.length / geometry.obj.scale : segment.length;
      return segment;
    });
    branch.segment_count = branch.segments.length;
    delete branch.segment_z_raw; delete branch.poly_z_raw;
    branch.polyfills = (branch.polyfills ?? []).filter(poly => poly.segment_ids.every(id => handles.has(id) || id === boundary)).map(poly => {
      poly.segment_ids = poly.segment_ids.map(id => id === boundary ? 0 : id);
      poly.segment_ids_raw = [...poly.segment_ids]; return poly;
    });
    if (branch._styk) delete branch._styk.animationOrigin;
    // Use the ordinary clipboard for joined objects, then replace only the
    // selected instance with its extracted branch and a fresh definition.
    const count = this.copySelection({wholeFigures: true}), clipboard = this._selectionClipboard;
    const object = clipboard.objects.find(o => o.unique_id === this.selectedUid);
    object.figure_type_id = branch.figure_type_id; object.join = null;
    object.root_x = geometry.segments[joint].start.x; object.root_y = geometry.segments[joint].start.y;
    object.angles = branch.segments.map(s => s.angle_rad);
    object.len_flag = 0; object.lengths = []; object.bend_flag = 0; object.bends = [];
    delete object._stykAnimationOrigin;
    clipboard.figures.push(branch);
    clipboard.figures = clipboard.figures.filter(f => clipboard.objects.some(o => o.figure_type_id === f.figure_type_id));
    clipboard.freshTypes = new Set([branch.figure_type_id]);
    return count;
  },
  /** Match every selected definition; candidates restrict newly eligible figures. */
  selectSameDefinition({add = false, candidates} = {}) {
    const objects = this.selectionFrame.objects;
    const definitions = new Set(objects.filter(object => this.selectedUids.has(object.unique_id)).map(object => object.figure_type_id));
    if (!definitions.size) return this.selectedObjects;
    const existing = new Set(objects.map(object => object.unique_id));
    const eligible = candidates === undefined ? existing : validIds(candidates, existing);
    const ids = add ? validIds(this.selectedUids, existing) : new Set();
    for (const object of objects)
      if (eligible.has(object.unique_id) && definitions.has(object.figure_type_id)) ids.add(object.unique_id);
    return applySelection(this, ids);
  },

  /** Toggle only eligible candidates; retain selections outside that domain. */
  invertSelection(candidates) {
    const existing = new Set(this.selectionFrame.objects.map(object => object.unique_id));
    const ids = validIds(this.selectedUids, existing);
    const eligible = candidates === undefined ? existing : validIds(candidates, existing);
    for (const uid of eligible) { if (ids.has(uid)) ids.delete(uid); else ids.add(uid); }
    return applySelection(this, ids);
  },

  /** Geometric hit testing belongs to the canvas. Pass initial UIDs on every drag update. */
  selectMarquee(uids, {mode = 'replace', initial = this.selectedUids} = {}) {
    if (!['replace', 'add', 'toggle', 'subtract'].includes(mode)) throw new Error('Choose a valid marquee selection mode.');
    const existing = new Set(this.selectionFrame.objects.map(object => object.unique_id));
    const hits = validIds(uids, existing), ids = mode === 'replace' ? new Set() : validIds(initial, existing);
    for (const uid of hits) {
      if (mode === 'subtract' || (mode === 'toggle' && ids.has(uid))) ids.delete(uid);
      else ids.add(uid);
    }
    return applySelection(this, ids);
  },

  bringToFront() { return partitionLayers(this, true); },
  sendToBack() { return partitionLayers(this, false); },

  /** Align selected artwork while translating its complete joined component. */
  alignSelection(axis, edge, {boundsOf = defaultBounds} = {}) {
    if (!['x', 'y'].includes(axis)) throw new Error('Alignment axis must be x or y.');
    if (!['start', 'center', 'end'].includes(edge)) throw new Error('Alignment edge must be start, center or end.');
    if (typeof boundsOf !== 'function') throw new Error('Provide a figure bounds function.');
    if (this._drag) this.commitDrag();
    const groups = selectedComponents(this);
    if (groups.size < 2) return false;
    let moved = false;
    this._objectEdit('Align figures', () => {
      this._expandTranslationDrag();
      const geometry = this.geometry, extents = new Map();
      const [lo, hi, position] = axis === 'x' ? ['minX', 'maxX', 'root_x'] : ['minY', 'maxY', 'root_y'];
      let start = Infinity, end = -Infinity;
      // Measure every selected member before changing any root. Unselected
      // parents and siblings move with the group without affecting its target.
      for (const [root, members] of groups) {
        let min = Infinity, max = -Infinity;
        for (const slot of members) {
          const entry = geometry.objects.get(slot);
          if (!entry) continue;
          const bounds = normalizedBounds(boundsOf(entry));
          min = Math.min(min, bounds[lo]); max = Math.max(max, bounds[hi]);
        }
        if (!Number.isFinite(min)) continue;
        extents.set(root, {min, max}); start = Math.min(start, min); end = Math.max(end, max);
      }
      if (extents.size < 2) return;
      const at = (min, max) => edge === 'start' ? min : edge === 'end' ? max : (min + max) / 2;
      const target = at(start, end);
      for (const [root, {min, max}] of extents) {
        const delta = target - at(min, max);
        if (!delta) continue;
        this.frame.objects[root][position] += delta; moved = true;
      }
    });
    return moved;
  },
};
