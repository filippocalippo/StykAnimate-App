import {validateObjectChanges, validateScene} from './pivot/model.mjs';
import {animationPropertyValue} from './animation-channels.mjs';
import {buildGeometry} from './pivot/geometry.mjs';
import {splitPosePropertyChanges} from './pose-property-split.mjs';
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A canvas gesture edits a composed pose without mutating imported source keys. */
export const editorAuthoredPoseMethods = {
  _authoredTransaction(label, mutate, {structural = false, timing = false} = {}) {
    if (!Number.isInteger(this.tick)) { this.tick = Math.round(this.tick); this._invalidate({viewOnly: true}); }
    const source = this.evaluatedFrame, index = this.frameIndex, native = this.report.keyframes[index], definitionCount = this.report.figure_types.length;
    this._authoredPoseEdit = {frame: clone(source), source, owned: new Set(source.objects.map((_, slot) => slot)), tick: this.tick, transaction: true};
    this._drag = {label, scope: 'selection', authored: true, index, before: source.objects, beforeSelection: this._selectionState(), changed: false};
    try {
      mutate(this.frame, this.report);
      // Legacy callbacks may replace a frame instead of mutating its fields.
      if (this.report.keyframes[index] !== native) { this._authoredPoseEdit.frame = this.report.keyframes[index]; this.report.keyframes[index] = native; }
      this._synchronizeAnimationOrigins(this.frame,source.objects,{includeNew:true});
      if (timing || this.frame.duration_raw !== source.duration_raw) throw new Error('Edit keyframe exposure through the timeline duration control.');
      this._authoredPoseEdit.structural = structural; this._invalidate();
      return this.commitAuthoredPoseDrag();
    } catch (error) { this.report.keyframes[index] = native; this.report.figure_types.length = definitionCount; this.cancelAuthoredPoseDrag(); throw error; }
  },
  _beginAuthoredPoseDrag(label, scope) {
    if (!this.propertyChannels && !this.animationChannels.length) return null;
    if (!Number.isInteger(this.tick)) { this.tick = Math.round(this.tick); this._invalidate({viewOnly: true}); }
    const source = this.evaluatedFrame;
    if (!source.objects.some(object => this.selectedUids.has(object.unique_id))) return false;
    const resolved = this.resolveTranslationSelection(this.selectedUids, {frame: source});
    // Ordinary posing includes descendants but leaves external ancestors fixed.
    const slots = scope === 'translation' ? resolved.affectedSlots : this._resolvePoseSlots(source);
    const geometry = this._geometry;
    this._authoredPoseEdit = {frame: {...source, objects: source.objects.slice()}, source, owned: new Set(), tick: this.tick};
    this._ownAuthoredSlots(slots);
    this._drag = {label, scope, authored: true, index: this.frameIndex,
      before: slots.map(slot => clone(this.frame.objects[slot])), beforeSelection: this._selectionState(), changed: false};
    this._evaluated = this.frame;
    if (geometry) this._geometry = geometry;
    return true;
  },
  _resolvePoseSlots(frame) {
    const selected = new Set(this.selectedUids), queue = [], seen = new Set(), children = new Map();
    frame.objects.forEach((object, slot) => {
      if (selected.has(object.unique_id)) { queue.push(slot); seen.add(slot); }
      if (object.join) { const parent = object.join.target_object_slot, values = children.get(parent) ?? []; values.push(slot); children.set(parent, values); }
    });
    for (let i = 0; i < queue.length; i++) for (const slot of children.get(queue[i]) ?? []) if (!seen.has(slot)) { seen.add(slot); queue.push(slot); }
    return [...seen].sort((a, b) => a - b);
  },
  _ownAuthoredSlots(slots) {
    const edit = this._authoredPoseEdit; if (!edit) return;
    for (const slot of slots) if (!edit.owned.has(slot)) { edit.frame.objects[slot] = clone(edit.frame.objects[slot]); edit.owned.add(slot); }
  },
  commitAuthoredPoseDrag() {
    const drag = this._drag, edit = this._authoredPoseEdit; if (!drag?.authored || !edit) return false;
    this._synchronizeAnimationOrigins(edit.frame,drag.before);
    const previous = new Map(drag.before.map(object => [object.unique_id, object]));
    const ids = new Set(previous.keys());
    if (edit.transaction) for (const object of edit.frame.objects) ids.add(object.unique_id);
    const after = edit.frame.objects.filter(object => ids.has(object.unique_id));
    if (edit.transaction ? same(edit.source, edit.frame) : same(drag.before, after)) { this._drag = null; this._authoredPoseEdit = null; this._invalidate(); return false; }
    try {
      if (!edit.transaction) validateObjectChanges(this.report, edit.frame, ids);
      if (after.some(object => object.join)) {
        const geometry = this.geometry;
        for (const object of after) if (object.join) {
          const root = geometry.objects.get(object.object_slot)?.root;
          if (root) { object.root_x = root.x; object.root_y = root.y; }
        }
        this._synchronizeAnimationOrigins(edit.frame,drag.before);
      }
      if (edit.transaction) validateScene({...this.report, keyframes: [edit.frame]});
    } catch (error) { this.cancelAuthoredPoseDrag(); throw error; }
    const split = this.propertyChannels ? splitPosePropertyChanges(this.report, edit.source, edit.frame, ids, edit.tick) : null;
    const entries = split?.entries ?? [];
    let sourceId;
    const poseSource = () => sourceId ??= this.captureFrameSource(split?.frame ?? edit.frame);
    if (!split || split.shapeIds.size) poseSource();
    const currentObjects = new Map(edit.frame.objects.map(object => [object.unique_id, object]));
    const changedObjects = [...after, ...drag.before].filter(object => {
      if (split && !split.shapeIds.has(object.unique_id)) return false;
      if (!edit.transaction) return true;
      const current = currentObjects.get(object.unique_id);
      return !current || !same(previous.get(object.unique_id), current);
    });
    const independent = new Set(changedObjects.filter(object => split && !edit.transaction || this.animationChannel({kind:'figure',uid:object.unique_id},'pose')).map(object => object.unique_id));
    const layers = new Set(changedObjects.filter(object => !independent.has(object.unique_id)).map(object => this.layerForUid(object.unique_id)));
    for (const uid of independent) {
      const target={kind:'figure',uid};this.nativePoseChannel(target);
      entries.push({target,property:'pose',tick:edit.tick,value:{frameId:poseSource()}});
    }
    if (edit.transaction && !same(edit.source.object_draw_order_unique_ids, edit.frame.object_draw_order_unique_ids))
      for (const object of after) layers.add(this.layerForUid(object.unique_id));
    for (const id of layers) {
      this.nativePoseChannel({kind: 'layer', id});
      entries.push({target: {kind: 'layer', id}, property: 'pose', tick: edit.tick, value: {frameId: poseSource()}});
    }
    if (edit.transaction && !same(edit.source.camera, edit.frame.camera)) {
      if (split) for (const property of ['x','y','scale','rotation']) {
        const target = {kind:'camera'}, value = animationPropertyValue(this.report, edit.frame, target, property);
        if (value !== animationPropertyValue(this.report, edit.source, target, property)) entries.push({target, property, tick:edit.tick, value});
      } else entries.push({target: {kind: 'camera'}, property: 'pose', tick: edit.tick, value: {frameId: poseSource()}});
    }
    if (edit.transaction && ['background_id', 'background_id_b', 'background_mix', '_stykBackgroundColor'].some(field => !same(edit.source[field], edit.frame[field])))
      if (split) {
        for (const property of ['backgroundId','color']) {
          const target = {kind:'scene'}, value = animationPropertyValue(this.report, edit.frame, target, property);
          if (value !== animationPropertyValue(this.report, edit.source, target, property)) entries.push({target, property, tick:edit.tick, value});
        }
      } else entries.push({target: {kind: 'scene'}, property: 'pose', tick: edit.tick, value: {frameId: poseSource()}});
    // Existing absolute transform curves must not snap the edited pose back.
    let committedGeometry, sourceGeometry;
    for (const channel of split ? [] : this.animationChannels) if (channel.keys.length && channel.target.kind === 'figure' && ids.has(channel.target.uid) && channel.property !== 'pose') {
      const value = animationPropertyValue(this.report, edit.frame, channel.target, channel.property,
        {resolveGeometry: (report, frame) => committedGeometry ??= this._geometry ?? buildGeometry(report, frame)});
      const beforeValue = animationPropertyValue(this.report, edit.source, channel.target, channel.property,
        {resolveGeometry: (report, frame) => sourceGeometry ??= buildGeometry(report, frame)});
      if (value !== undefined && value !== beforeValue) entries.push({target: channel.target, property: channel.property, tick: edit.tick, value});
    }
    // A pose key stores exactly the displayed frame at this tick. Keep its
    // geometry during the synchronous key-change notification; rebuilding every
    // unaffected figure on pointer release defeats the incremental drag path.
    this._authoredCommitPreview = edit.transaction ? null : {frame: edit.frame, geometry: this._geometry ?? committedGeometry, incremental: this._incremental};
    this._drag = null; this._authoredPoseEdit = null;
    try {
      this._invalidate();
      this._authoredCommandLabel = drag.label;
      this.addAnimationKeys(entries);
    } catch (error) { if (sourceId) delete this.report._styk.frameSources[sourceId]; this._authoredCommitPreview = null; this._invalidate(); throw error; }
    finally { this._authoredCommandLabel = null; this._authoredCommitPreview = null; }
    return true;
  },
  cancelAuthoredPoseDrag() {
    if (!this._authoredPoseEdit) return false;
    const drag = this._drag; this._drag = null; this._authoredPoseEdit = null; this._invalidate();
    if (drag?.beforeSelection) this._restoreSelection(drag.beforeSelection);
    this._emit('edit', {label: 'Cancel pose', animation: true, changedUids: drag?.before.map(object => object.unique_id) ?? []}); return true;
  },
};
