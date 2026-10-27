import {messageError} from './localized-error.mjs';
import {segmentBranchIndices} from './pivot/structure.mjs';
import {figureFocusLocked} from './editor-layer-focus.mjs';
import {figurePalette, attachedFigurePalette} from './figure-colors.mjs';
import {isMovieclip} from './movieclips.mjs';
import {drawingMetadata} from './drawing-model.mjs';

const validIds = (uids, existing) => new Set([...uids].filter(uid => existing.has(uid)));

/** Selection is UI state: it must not invalidate scene caches or command history. */
function applySelection(editor, ids, preferred = editor.selectedUid) {
  ids = new Set([...ids].filter(uid => !figureFocusLocked(editor.report, uid)));
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

  selectPolygon(uid, index) {
    if (figureFocusLocked(this.report, uid)) return false;
    const object = this.selectionFrame.objects.find(object => object.unique_id === uid);
    const figure = this.report.figure_types.find(figure => figure.figure_type_id === object?.figure_type_id);
    const polygon = figure?.polyfills?.[index];if(!polygon)return false;
    this.select(uid,-1);
    this._polygonSelection={uid,index,id:polygon.polyfill_id,typeId:figure.figure_type_id};
    this._emit('selection');return true;
  },
  /** Toggle stable native handles inside one figure, without editing its pose. */
  toggleSegment(uid, joint) {
    if (figureFocusLocked(this.report, uid)) return false;
    this._polygonSelection = null;
    const object = this.selectionFrame.objects.find(object => object.unique_id === uid);
    const figure = this.report.figure_types.find(figure => figure.figure_type_id === object?.figure_type_id);
    const id = figure?.segments[joint]?.segment_id;
    if (id === undefined) return false;
    const ids = new Set(uid === this.selectedUid ? this.selectedSegmentIds : []);
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    const active = ids.has(id) ? id : [...ids].at(-1);
    this._selectedUid = uid; this.selectedUids = new Set([uid]); this._branchSelection = null;
    this.selectedJoint = active === undefined ? -1 : figure.segments.findIndex(segment => segment.segment_id === active);
    this._segmentSelection = {uid, active, ids};
    this._emit('selection'); return true;
  },

  selectBranch(uid, joint) {
    if (figureFocusLocked(this.report, uid)) return false;
    this._segmentSelection = null;
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
    this.selectedUids = new Set(objects.filter((object, i) => slots.has(i) && !figureFocusLocked(this.report, object.unique_id)).map(o => o.unique_id));
    this._selectedUid = uid; this.selectedJoint = joint;
    this._branchSelection = {uid, joint};
    this._emit('selection'); return true;
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
    if (!['replace', 'add', 'toggle', 'subtract'].includes(mode)) throw messageError(new Error(''), "errors.editorSelection.chooseAValidMarqueeSelectionMode", {});
    const existing = new Set(this.selectionFrame.objects.map(object => object.unique_id));
    const hits = validIds(uids, existing), ids = mode === 'replace' ? new Set() : validIds(initial, existing);
    for (const uid of hits) {
      if (mode === 'subtract' || (mode === 'toggle' && ids.has(uid))) ids.delete(uid);
      else ids.add(uid);
    }
    return applySelection(this, ids);
  },

  /** Whether the selected segment and everything hanging from it are only part of one figure, so that they can become a figure of their own. */
  canDisconnectSegment() {
    const figure = this.figure, segment = figure?.segments[this.selectedJoint];
    if (!segment || (this.selectedUids.size !== 1 && !this.branchSelected) || isMovieclip(figure) || drawingMetadata(figure)) return false;
    return segmentBranchIndices(figure.segments, segment.segment_id).length < figure.segments.length;
  },

  /** The colours of the selected figure, or of the figures attached to it when it is selected whole. */
  figurePalette() { return this.figure && this.object ? (this.selectedJoint < 0 ? attachedFigurePalette(this.report, this.selectionFrame, this.selectedUid) : figurePalette(this.report, this.figure, this.object)) : []; },
};
