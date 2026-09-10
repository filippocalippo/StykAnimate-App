/** Atomic figure commands over native source keys or explicitly selected authored ticks. */
import {planFigureFrameOperation} from './range-figure-operations.mjs';
import {createObject} from './demo.mjs';
import {frameOrder, setOrder} from './pivot/structure.mjs';
import {evaluatedFrame, buildGeometry} from './pivot/geometry.mjs';
import {validateObjectChanges, validateScene} from './pivot/model.mjs';
import {animationChannelId, animationPropertyValue, validateAnimationDocument, validateAnimationValue} from './animation-channels.mjs';
import {AUTHORING_PROPERTIES, isDiscreteAnimationProperty} from './animation-properties.mjs';
import {splitPosePropertyChanges} from './pose-property-split.mjs';
import {snapshotPoseFrame, snapshotPoseObject} from './pose-snapshot.mjs';
import {translateIKTargets, remapIKFollowers} from './ik.mjs';

const clone = value => structuredClone(value);
const equal = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const zero = () => ({changedFrames: 0, changedTicks: [], insertedUids: []});
const labels = {add: 'Add figures across frames', paste: 'Paste figures across frames', duplicate: 'Duplicate figures across frames', delete: 'Delete figures across frames',
  appearance: 'Set figure appearance across frames', order: 'Order figures across frames', join: 'Join figures across frames',
  detach: 'Detach figures across frames', mirror: 'Flip figures across frames', scale: 'Scale figures across frames',
  rotate: 'Rotate figures across frames', align: 'Align figures across frames', center: 'Center figures across frames', reset: 'Reset poses across frames'};
const frameFields = frame => Object.fromEntries(Object.entries(frame).filter(([key]) => !['objects', 'object_draw_order', 'object_draw_order_unique_ids'].includes(key)));
function fieldChanges(before, after) {
  const left = [], right = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (!equal(before[key], after[key]) || own(before, key) !== own(after, key)) {
    left.push({key, exists: own(before, key), value: clone(before[key])}); right.push({key, exists: own(after, key), value: clone(after[key])});
  }
  return [left, right];
}
function diffFrame(index, before, after) {
  const old = new Map(before.objects.map(object => [object.unique_id, object])), next = new Map(after.objects.map(object => [object.unique_id, object])), patches = [];
  for (const uid of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(uid), b = next.get(uid); if (a === b) continue;
    if (!a || !b) { patches.push({uid, before: a ? {exists: true, object: clone(a)} : {exists: false}, after: b ? {exists: true, object: clone(b)} : {exists: false}}); continue; }
    const [left, right] = fieldChanges(a, b);
    if (left.length) patches.push({uid, before: {exists: true, fields: left}, after: {exists: true, fields: right}});
  }
  const beforeSlots = before.objects.map(object => object.unique_id), afterSlots = after.objects.map(object => object.unique_id);
  const beforeOrder = frameOrder(before), afterOrder = frameOrder(after), [left, right] = fieldChanges(frameFields(before), frameFields(after));
  return {index, patches, ...(!equal(beforeSlots, afterSlots) ? {beforeSlots, afterSlots} : {}),
    ...(!equal(beforeOrder, afterOrder) ? {beforeOrder, afterOrder} : {}), ...(left.length ? {beforeFields: left, afterFields: right} : {})};
}
function applyFields(target, fields) { for (const field of fields ?? []) { if (field.exists) target[field.key] = clone(field.value); else delete target[field.key]; } }
function sample(editor, tick) {
  const entries = editor.timeline; let low = 0, high = entries.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (entries[mid].start <= tick) low = mid; else high = mid - 1; }
  const entry = entries[low]; return {index: low, tick, frame: evaluatedFrame(editor.report, low, entry.count > 0 ? Math.min(1, (tick - entry.start) / entry.count) : 0, tick)};
}
function targets(editor, options) {
  if (options.atPlayhead) return {authored: Boolean(editor.report._styk?.layerSheet || editor.animationChannels.length || editor.report._styk?.movieclipSource),
    frames: [{index: editor.frameIndex, tick: editor.tick, frame: editor.selectionFrame}]};
  if(editor.report._styk?.layerSheet&&options.indices?.sheetTicks)options={...options,ticks:options.indices.sheetTicks};
  if (options.ticks !== undefined) {
    const ticks = [...new Set(options.ticks)].sort((a, b) => a - b);
    if (ticks.some(tick => !Number.isInteger(tick) || tick < 0 || tick > 10000000)) throw new Error('Select whole animation ticks from 0 to 10,000,000.');
    return {authored: true, frames: ticks.map(tick => sample(editor, tick))};
  }
  const indices = editor._frameIndices(options.indices ?? [editor.frameIndex]);
  if (editor.report._styk?.layerSheet || editor.propertyChannels || editor.animationChannels.length) return {authored: true, frames: [...new Set(indices.map(index => editor.timeline[index].start))].map(tick => sample(editor, tick))};
  return {authored: false, frames: indices.map(index => ({index, tick: editor.timeline[index].start, frame: editor.report.keyframes[index]}))};
}
function insertionPlan(editor, operation) {
  let nextUid = editor._nextUid, nextType = 1;
  for (const figure of editor.report.figure_types) nextType = Math.max(nextType, figure.figure_type_id + 1);
  const definitions = [], hints = new Map();
  const identity = () => { if (nextUid > 0x7ffffffe) throw new Error('Object identity capacity reached.'); return nextUid++; };
  if (operation.kind === 'add') {
    const figure = editor.report.figure_types.find(value => value.figure_type_id === (operation.typeId ?? editor.report.figure_types[0]?.figure_type_id));
    if (!figure) throw new Error('Choose an existing figure definition.');
    const uid = identity(), x = operation.x ?? editor.report.canvas_width / 2, y = operation.y ?? editor.report.canvas_height / 2;
    if (![x, y].every(Number.isFinite)) throw new Error('Figure position must be finite.');
    return {objects: [createObject(figure, uid, x, y)], order: [uid], definitions, hints, nextUid};
  }
  const clipboard = editor._selectionClipboard ?? editor._figureClipboard;
  if (!clipboard) return null;
  const sourceObjects = clipboard.objects ?? [clipboard.object], sourceFigures = clipboard.figures ?? [clipboard.figure];
  const uidMap = new Map(sourceObjects.map(object => [object.unique_id, identity()])), types = new Map();
  const existingTypes = new Map(editor.report.figure_types.map(figure => [figure.figure_type_id, figure]));
  for (const original of sourceFigures) {
    let figure = clipboard.documentToken === editor._documentToken && !clipboard.freshTypes?.has(original.figure_type_id) ? existingTypes.get(original.figure_type_id) : null;
    if (!figure) { figure = {...clone(original), figure_type_id: nextType++}; definitions.push(figure); }
    types.set(original.figure_type_id, {figure, indices: new Map(original.segments.map((segment, index) => [segment.segment_id, index])),
      handles: new Set([0, ...figure.segments.map(segment => segment.segment_id)])});
  }
  const offset = operation.offset ?? 0;
  if (!Number.isFinite(offset)) throw new Error('Paste offset must be finite.');
  const objects = sourceObjects.map(original => {
    const object = snapshotPoseObject(original), {figure, indices} = types.get(original.figure_type_id);
    object.unique_id = uidMap.get(original.unique_id); object.figure_type_id = figure.figure_type_id; object.root_x += offset; object.root_y += offset;
    translateIKTargets(object, offset, offset); remapIKFollowers(object, uidMap);
    for (const [field, enabled, fallback] of [['angles', true, 'angle_rad'], ['lengths', object.len_flag, 'length'], ['bends', object.bend_flag, 'bend_rad']])
      if (enabled) object[field] = figure.segments.map(segment => original[field]?.[indices.get(segment.segment_id)] ?? segment[fallback] ?? 0);
    if (object.join) {
      const target = uidMap.get(object.join.target_unique_id);
      if (target === undefined) object.join = null; else object.join.target_unique_id = target;
    }
    const layer = clipboard.layers?.get(original.unique_id);
    if (clipboard.documentToken === editor._documentToken && editor.getLayer(layer)) hints.set(object.unique_id, layer);
    delete object.runtime_segments; return object;
  });
  const originals = new Map(sourceObjects.map(object => [object.unique_id, object]));
  for (let i = 0; i < objects.length; i++) if (objects[i].join) {
    const parent = originals.get(sourceObjects[i].join.target_unique_id);
    if (!parent || !types.get(parent.figure_type_id).handles.has(objects[i].join.target_handle_id)) objects[i].join = null;
  }
  return {objects, order: (clipboard.order ?? sourceObjects.map(object => object.unique_id)).map(uid => uidMap.get(uid)), definitions, hints, nextUid};
}
function insert(frame, payload) {
  if (frame.objects.length + payload.objects.length > 65535) throw new Error('A native keyframe supports at most 65,535 figures.');
  const objects = frame.objects.slice(), added = payload.objects.map(clone), slots = new Map(added.map((object, i) => [object.unique_id, objects.length + i]));
  for (const object of added) { object.object_slot = slots.get(object.unique_id); if (object.join) object.join.target_object_slot = slots.get(object.join.target_unique_id); objects.push(object); }
  const out = {...frame, objects}; setOrder(out, [...frameOrder(frame), ...payload.order]); if ('object_count' in out) out.object_count = objects.length;
  return {frame: out, changedUids: added.map(object => object.unique_id), structural: true};
}
function authoredDraft(editor, entries, sources = {}) {
  const before = editor.report._styk.animation ?? null, after = {...before, version: 1, nextKeyId: before?.nextKeyId ?? 1, channels: [...editor.animationChannels]};
  const edited = new Map();
  for (const entry of entries) {
    const id = animationChannelId(entry.target, entry.property); let channel = edited.get(id);
    if (!channel) {
      const index = after.channels.findIndex(value => value.id === id), previous = index < 0 ? entry.property === 'pose' ? editor.nativePoseChannel(entry.target) : editor.propertyChannels ? editor.nativePropertyChannel(entry.target, entry.property) : undefined : after.channels[index];
      channel = {...previous, id, target: entry.target, property: entry.property, source: 'authored', keys: (previous?.keys ?? []).map(clone)};
      edited.set(id, channel); if (index < 0) after.channels.push(channel); else after.channels[index] = channel;
    }
    const value = validateAnimationValue(entry.target, entry.property, entry.value); let key = channel.keys.find(key => key.tick === entry.tick && !key.hidden);
    if (key) { key.value = value; delete key.passthrough; }
    else {
      const used = new Set(channel.keys.map(key => key.id)); let keyId;
      do { keyId = `key-${after.nextKeyId++}`; } while (used.has(keyId));
      key = {id: keyId, tick: entry.tick, value, interpolation: entry.property === 'pose' || isDiscreteAnimationProperty(entry.property) ? 'hold' : 'linear'}; channel.keys.push(key);
    }
  }
  if (editor.propertyChannels) for (const entry of entries) if(entry.property === 'pose') {
    if(edited.get(animationChannelId(entry.target,'pose'))?.nativeProperties)continue;
    const targets=entry.target.kind === 'layer' ? (editor.layers.find(layer=>layer.id===entry.target.id)?.figureUids??[]).map(uid=>({kind:'figure',uid})) : [entry.target];
    for(const target of targets)for(const property of AUTHORING_PROPERTIES[target.kind]??[]) {
      if(property==='pose')continue;const id=animationChannelId(target,property);
      if(target.kind==='figure'&&['x','y','rotation'].includes(property)&&[...editor.report.keyframes,...Object.values(sources)].some(frame=>frame.objects.some(object=>object.unique_id===target.uid&&object.join)))continue;
      if(!after.channels.some(channel=>channel.id===id)) {const native=editor.nativePropertyChannel(target,property);if(native.keys.some(key=>!Object.is(key.value,native.keys[0]?.value)))after.channels.push(native);}
    }
  }
  for (const channel of edited.values()) channel.keys.sort((a, b) => a.tick - b.tick || Number(Boolean(b.hidden)) - Number(Boolean(a.hidden)));
  return {before, after};
}

export const editorRangeCommandMethods = {
  /** A result reports actual changes; missing figure identities are skipped. */
  applyFigureRange(operation, options = {}) {
    if (!operation || !labels[operation.kind]) throw new Error('Choose a supported figure range operation.');
    if (this._drag) this.commitDrag(); if (this._animationEdit) this.commitAnimationEdit();
    const uids = [...new Set(options.uids ?? this.selectedUids)], target = targets(this, options);
    if (!target.frames.length) return zero();
    if (operation.kind === 'order' && target.authored) operation = {...operation, numericOrder: true};
    let payload = ['add', 'paste'].includes(operation.kind) ? insertionPlan(this, operation) : null;
    if (operation.kind === 'duplicate') {
      const wanted = new Set(uids), present = new Set();
      for (const entry of target.frames) for (const object of entry.frame.objects) if (wanted.has(object.unique_id)) present.add(object.unique_id);
      let nextUid = this._nextUid; const uidMap = new Map(), hints = new Map();
      for (const uid of uids) if (present.has(uid)) {
        if (nextUid > 0x7ffffffe) throw new Error('Object identity capacity reached.');
        uidMap.set(uid, nextUid); hints.set(nextUid++, this.layerForUid(uid));
      }
      if (!uidMap.size) return zero();
      operation = {...operation, uidMap}; payload = {definitions: [], hints, order: [...uidMap.values()], nextUid};
    }
    if (operation.kind === 'paste' && !payload) return zero();
    if (!payload && !uids.length) return zero();
    const report = payload?.definitions.length ? {...this.report, figure_types: [...this.report.figure_types, ...payload.definitions]} : this.report;
    if (payload?.definitions.length) validateScene({...report, figure_types: payload.definitions, backgrounds: [], keyframes: [{objects: [], duration_raw: 1}]});
    const plans = [];
    for (const entry of target.frames) {
      const planned = payload && operation.kind !== 'duplicate' ? insert(entry.frame, payload) : planFigureFrameOperation(report, entry.frame, uids, {...operation, referenceUid: operation.referenceUid ?? this.selectedUid});
      if (!planned) continue;
      this._synchronizeAnimationOrigins(planned.frame,entry.frame.objects,{includeNew:true,report});
      const present = new Set(planned.frame.objects.map(object => object.unique_id));
      validateObjectChanges(report, planned.frame, planned.changedUids.filter(uid => present.has(uid)));
      plans.push({...entry, ...planned, beforeFrame: entry.frame});
    }
    if (!plans.length) return zero();
    const label = options.label ?? labels[operation.kind], selection = this._selectionState(), insertedUids = payload?.order ?? [];
    if (target.authored) this._commitAuthoredFigureRange(plans, {...operation, uids}, payload, report, label, selection);
    else {
      const changes = plans.map(plan => diffFrame(plan.index, plan.beforeFrame, plan.frame));
      const figureIndex = this.report.figure_types.length;
      if (payload?.definitions.length) this.report.figure_types.push(...payload.definitions);
      for (const plan of plans) this.report.keyframes[plan.index] = plan.frame;
      if (payload) { this._nextUid = payload.nextUid; this._newLayerHints = payload.hints; }
      const retainGeometry=Boolean(payload?.objects);
      this._invalidate({retainGeometry}); if (insertedUids.length) this._selectIds(insertedUids);
      this._record({kind: 'figure-range', label, changes, ...(payload?.definitions.length ? {figureIndex, figures: clone(payload.definitions)} : {}),
        beforeSelection: selection, afterSelection: this._selectionState(), structural: plans.some(plan => plan.structural), timing: false, retainGeometry});
      this._emit('edit', {label, structural: plans.some(plan => plan.structural), changedUids: [...new Set(plans.flatMap(plan => plan.changedUids))], frameIndices: plans.map(plan => plan.index)});
    }
    return {changedFrames: plans.length, changedTicks: plans.map(plan => plan.tick), insertedUids};
  },
  _applyFigureRangeCommand(command, direction) {
    if (command.figures) {
      const ids = new Set(command.figures.map(figure => figure.figure_type_id));
      if (direction === 'after') {
        for (const figure of command.figures) if (!this.report.figure_types.some(value => value.figure_type_id === figure.figure_type_id)) this.report.figure_types.push(clone(figure));
      } else {
        for (const frame of Object.values(this.report._styk.frameSources ?? {})) for (const object of frame.objects) ids.delete(object.figure_type_id);
        this.report.figure_types = this.report.figure_types.filter(figure => !ids.has(figure.figure_type_id));
      }
    }
    for (const change of command.changes) {
      const frame = this.report.keyframes[change.index], objects = new Map(frame.objects.map(object => [object.unique_id, object]));
      for (const patch of change.patches) {
        const state = patch[direction];
        if (!state.exists) objects.delete(patch.uid);
        else if (state.object) objects.set(patch.uid, clone(state.object));
        else { const object = {...objects.get(patch.uid)}; applyFields(object, state.fields); objects.set(patch.uid, object); }
      }
      frame.objects = change[`${direction}Slots`] ? change[`${direction}Slots`].map(uid => objects.get(uid)) : frame.objects.map(object => objects.get(object.unique_id));
      if (change[`${direction}Order`]) setOrder(frame, clone(change[`${direction}Order`]));
      applyFields(frame, change[`${direction}Fields`]);
    }
  },
  _commitAuthoredFigureRange(plans, operation, payload, report, label, selection) {
    if(this.report._styk?.layerSheet)return this._commitSheetRange(plans,payload,label,selection);
    const entries = [], sources = {}; let nextSource = this._nextFrameIdentity;
    const numericOrder = operation.kind === 'order' && operation.numericOrder;
    const scalarOnly = numericOrder || operation.kind === 'scale' || (operation.kind === 'appearance' && !Object.keys(operation.patch ?? {}).some(key => !['field28', 'opacity'].includes(key)));
    for (const plan of plans) {
      const changed = new Set(plan.changedUids), objects = new Map(plan.frame.objects.map(object => [object.unique_id, object]));
      const previous = new Map(plan.beforeFrame.objects.map(object => [object.unique_id, object])), geometries = new WeakMap();
      const split=this.propertyChannels ? splitPosePropertyChanges(report,plan.beforeFrame,plan.frame,changed,plan.tick) : null;
      if(split)entries.push(...split.entries);
      const valueAt = (target, property, frame) => animationPropertyValue(report, frame, target, property, {resolveGeometry: (r, f) => {
        let geometry = geometries.get(f); if (!geometry) { geometry = buildGeometry(r, f); geometries.set(f, geometry); } return geometry;
      }});
      if (!numericOrder && (split ? split.shapeIds.size || operation.kind === 'order' : !scalarOnly)) {
        const source = snapshotPoseFrame(split?.frame ?? plan.frame), id = `frame-${nextSource++}`; source._styk = {...source._styk, frameId: id};
        sources[id] = source;
        const independent=new Set([...changed].filter(uid=>this.propertyChannels&&operation.kind==='pose'||this.animationChannel({kind:'figure',uid},'pose')));
        for(const uid of independent)entries.push({target:{kind:'figure',uid},property:'pose',tick:plan.tick,value:{frameId:id}});
        const layers = new Set([...plan.beforeFrame.objects, ...plan.frame.objects].filter(object => changed.has(object.unique_id)&&!independent.has(object.unique_id)).map(object => payload?.hints.get(object.unique_id) ??
          (payload?.order.includes(object.unique_id) ? (this.getLayer(this.activeLayerId)?.kind === 'layer' ? this.activeLayerId : this.report._styk.layers.defaultLayerId) : this.layerForUid(object.unique_id))));
        if (operation.kind === 'order') for (const uid of optionsUids(plan, operation, changed)) layers.add(this.layerForUid(uid));
        for (const layer of layers) entries.push({target: {kind: 'layer', id: layer}, property: 'pose', tick: plan.tick, value: {frameId: id}});
      }
      if(split)continue;
      const required = new Map();
      const add = (uid, property) => { if (!objects.has(uid)) return; const properties = required.get(uid) ?? new Set(); properties.add(property); required.set(uid, properties); };
      if (operation.kind === 'order') for (const uid of changed)
        if ((objects.get(uid)?._stykZIndex ?? 0) !== (previous.get(uid)?._stykZIndex ?? 0)) add(uid, 'zIndex');
      if (operation.kind === 'scale') for (const uid of operation.uids) {
        const object = objects.get(uid), before = previous.get(uid); if (!object || !before) continue;
        if (object.scale !== before.scale) add(uid, 'scale');
        if (!object.join) { if (object.root_x !== before.root_x) add(uid, 'x'); if (object.root_y !== before.root_y) add(uid, 'y'); }
      }
      if (operation.kind === 'appearance' && ('field28' in (operation.patch ?? {}) || 'opacity' in (operation.patch ?? {}) || operation.opacity !== undefined)) for (const uid of changed) add(uid, 'opacity');
      for (const channel of this.animationChannels) if (channel.keys.length && channel.target.kind === 'figure' && channel.property !== 'pose' && changed.has(channel.target.uid) && objects.has(channel.target.uid) &&
        !equal(valueAt(channel.target, channel.property, plan.beforeFrame), valueAt(channel.target, channel.property, plan.frame))) add(channel.target.uid, channel.property);
      for (const [uid, properties] of required) for (const property of properties) {
        const target = {kind: 'figure', uid}; entries.push({target, property, tick: plan.tick,
          value: valueAt(target, property, plan.frame)});
      }
    }
    const animation = authoredDraft(this, entries, sources), sourceTable = {...this.report._styk.frameSources, ...sources};
    validateAnimationDocument({...report, _styk: {...this.report._styk, animation: animation.after, frameSources: sourceTable}});
    const figureIndex = this.report.figure_types.length;
    if (payload?.definitions.length) this.report.figure_types.push(...payload.definitions);
    if (payload) { this._nextUid = payload.nextUid; this._newLayerHints = payload.hints; }
    if (Object.keys(sources).length) { this.report._styk.frameSources ??= {}; Object.assign(this.report._styk.frameSources, sources); this._registerFrameSources(Object.values(sources)); }
    this._nextFrameIdentity = nextSource; this.report._styk.animation = animation.after; this._invalidate({timing: true});
    if (payload?.order.length) this._selectIds(payload.order);
    this._record({kind: 'animation', label, before: animation.before, after: animation.after, beforeSelection: selection, afterSelection: this._selectionState(), structural: true, timing: true,
      ...(payload?.definitions.length ? {figureDefinitionSplice: {index: figureIndex, figures: clone(payload.definitions)}} : {})});
    this._emit('edit', {label, animation: true, structural: true, timing: true, changedUids: [...new Set(plans.flatMap(plan => plan.changedUids))]});
  },
  addFigureInFrames(typeId, indices, options = {}) { return this.applyFigureRange({kind: 'add', typeId, x: options.x, y: options.y}, {...options, indices}); },
  pasteFiguresInFrames(indices, options = {}) { return this.applyFigureRange({kind: 'paste', offset: options.offset}, {...options, indices}); },
  duplicateFiguresInFrames(indices, options = {}) { return this.applyFigureRange({kind: 'duplicate', offset: options.offset}, {...options, indices}); },
  duplicateInFrames(indices, options = {}) { return this.duplicateFiguresInFrames(indices, options); },
  deleteFiguresInFrames(indices, options = {}) { return this.applyFigureRange({kind: 'delete'}, {...options, indices}); },
  updateFiguresInFrames(patch, indices, options = {}) { return this.applyFigureRange({kind: 'appearance', patch}, {...options, indices}); },
  orderFiguresInFrames(direction, indices, options = {}) { return this.applyFigureRange({kind: 'order', direction}, {...options, indices}); },
  joinFiguresInFrames(targetUid, handleId = 0, indices, options = {}) { return this.applyFigureRange({kind: 'join', targetUid, handleId}, {...options, indices}); },
  detachFiguresInFrames(indices, options = {}) { return this.applyFigureRange({kind: 'detach'}, {...options, indices}); },
  mirrorFiguresInFrames(axis = 'horizontal', indices, options = {}) { return this.applyFigureRange({kind: 'mirror', axis}, {...options, indices}); },
  scaleFiguresInFrames(value, indices, options = {}) { return this.applyFigureRange({kind: 'scale', [options.relative ? 'factor' : 'value']: value}, {...options, indices}); },
  rotateFiguresInFrames(radians, indices, options = {}) { return this.applyFigureRange({kind: 'rotate', radians, center: options.center}, {...options, indices}); },
  alignFiguresInFrames(axis, edge, indices, options = {}) { return this.applyFigureRange({kind: 'align', axis, edge, boundsOf: options.boundsOf}, {...options, indices}); },
  centerFiguresInFrames(indices, options = {}) { return this.applyFigureRange({kind: 'center'}, {...options, indices}); },
  resetPoseInFrames(indices, options = {}) { return this.applyFigureRange({kind: 'reset'}, {...options, indices}); },
};
function optionsUids(plan, operation, changed) { return changed.size ? changed : plan.frame.objects.map(object => object.unique_id); }
