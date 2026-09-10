import {ensureLayerState, validateLayerState, layerIdForUid, FIXED_LAYER_IDS} from './layers.mjs';
import {planLayerMembershipMigration} from './editor-layer-migration.mjs';
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => structuredClone(value);
const cleanName = name => { if (typeof name !== 'string' || !name.trim() || name.trim().length > 160) throw new Error('Layer names need 1–160 characters.'); return name.trim(); };
function leaf(state, path) { let object = state; for (const key of path.slice(0, -1)) object = object[key]; return [object, path.at(-1)]; }
function capture(state, path) { const [object, key] = leaf(state, path); return {exists: owns(object, key), value: clone(object[key])}; }
function write(state, path, value) { const [object, key] = leaf(state, path); if (value.exists) object[key] = clone(value.value); else delete object[key]; }
function animationPatch(plan) {
  const before = plan.beforeAnimation, after = plan.afterAnimation;
  const old = new Map((before?.channels ?? []).map((channel, index) => [channel.id, {exists: true, index, channel}]));
  const next = new Map((after?.channels ?? []).map((channel, index) => [channel.id, {exists: true, index, channel}]));
  const changes = [...new Set([...old.keys(), ...next.keys()])].filter(id => old.get(id)?.channel !== next.get(id)?.channel)
    .map(id => ({id, before: old.get(id) ?? {exists: false}, after: next.get(id) ?? {exists: false}}));
  const metadata = value => { if (!value) return {exists: false}; const {channels, ...fields} = value; return {exists: true, fields}; };
  return {changes, before: metadata(before), after: metadata(after)};
}
function framesOf(command, direction) {
  const sources = command.frameSourceUidCounts ? [] : (command.frameSourceChanges ?? []).filter(change => change[direction]?.exists).map(change => change[direction].value);
  if (command.frameUidCounts) return sources;
  const value = command[direction];
  if (command.kind === 'figure-range') return [...command.changes.map(change => ({objects: change.patches.filter(patch => patch[direction].exists).map(patch => ({unique_id: patch.uid}))})), ...sources];
  if (command.kind === 'frame') return [value, ...sources];
  if (['import', 'figure-splice', 'project'].includes(command.kind)) return value?.frame ? [value.frame, ...sources] : sources;
  if (command.kind === 'splice') return [...value, ...sources];
  if (command.kind === 'ranges') return [...command.changes.flatMap(change => change[direction]), ...sources];
  return sources;
}
export const editorLayerMethods = {
  _initializeLayers() {
    const state = ensureLayerState(this.report); validateLayerState(state);
    this._layerUidCounts = new Map(); this._layerSeenUids = new Set(); this._layerGroups = new Map(state.order.map(id => [id, new Set()]));
    for (const frame of [...this.report.keyframes, ...Object.values(this.report._styk.frameSources ?? {})]) for (const object of frame.objects) {
      const uid = object.unique_id; this._layerUidCounts.set(uid, (this._layerUidCounts.get(uid) ?? 0) + 1); this._layerSeenUids.add(uid);
    }
    for (const uid of this._layerUidCounts.keys()) this._layerGroups.get(layerIdForUid(this.report, uid)).add(uid);
    this._layerRevision = (this._layerRevision ?? 0) + 1; this._layerDescriptors = null; this._layerUidArrays = new Map();
  },
  _layerChanged({reindex = false} = {}) {
    const state = ensureLayerState(this.report);
    if (reindex) {
      this._layerGroups = new Map(state.order.map(id => [id, new Set()]));
      for (const uid of this._layerUidCounts.keys()) this._layerGroups.get(layerIdForUid(this.report, uid)).add(uid);
      this._layerUidArrays = new Map();
    }
    this._layerRevision++; this._layerDescriptors = null; this._layerEventPending = true; this._nativeAnimationChannels = null;
  },
  getLayers() {
    if (this._layerDescriptors) return this._layerDescriptors;
    const state = ensureLayerState(this.report);
    const fixed = FIXED_LAYER_IDS.map(id => ({id, kind: id, name: id === 'scene' ? 'Scene' : 'Camera',
      permanent: true, visible: state.fixed?.[id]?.visible !== false, locked: state.fixed?.[id]?.locked === true, figureUids: []}));
    return this._layerDescriptors = [...fixed, ...state.order.map(id => ({id, kind: 'layer', ...state.byId[id], permanent: false, figureUids: this.getLayerFigureUids(id)}))];
  },
  getLayer(id) { return this.getLayers().find(layer => layer.id === id) ?? null; },
  layerForUid(uid) { return layerIdForUid(this.report, uid); },
  getLayerFigureUids(id) {
    let values = this._layerUidArrays.get(id);
    if (!values) { values = [...(this._layerGroups.get(id) ?? [])]; this._layerUidArrays.set(id, values); }
    return values;
  },
  setActiveLayer(id) {
    if (!this.getLayer(id)) throw new Error('Choose an existing layer.');
    const state = ensureLayerState(this.report); if (state.activeId === id) return false;
    state.activeId = id; this._emit('selection', {layerSelection: true, activeLayerId: id, layerRevision: this.layerRevision}); return true;
  },
  _layerEdit(label, updates, {structural = false, reindex = false, activeId, migration} = {}) {
    if (this._drag) this.commitDrag();
    const state = ensureLayerState(this.report), beforeSelection = this._selectionState();
    const changes = updates.map(([path, value, remove = false]) => ({path, before: capture(state, path), after: {exists: !remove, value: clone(value)}}))
      .filter(change => JSON.stringify(change.before) !== JSON.stringify(change.after));
    if (!changes.length) return false;
    for (const change of changes) write(state, change.path, change.after);
    if (activeId !== undefined) state.activeId = activeId;
    const command = {kind: 'layers', label, changes, beforeSelection, structural, timing: Boolean(migration)};
    if(this.report._styk.layerSheet){
      const before=this.report._styk.layerSheet,tracks={...before.tracks};
      for(const id of state.order)tracks[id]??={keys:[],end:0};
      for(const id of Object.keys(tracks))if(!FIXED_LAYER_IDS.includes(id)&&!state.order.includes(id))delete tracks[id];
      const after={...before,tracks};this.report._styk.layerSheet=after;command.layerSheetPatch={before,after};command.timing=true;
    }
    if (migration) {
      command.layerAnimationPatch = animationPatch(migration);
      command.frameSourceChanges = migration.frameSourceChanges;
      command.hadFrameSourceTable = migration.hadFrameSourceTable;
      if (migration.sourceBytes !== undefined) command.sourceBytes = migration.sourceBytes;
      if (migration.frameSourceUidCounts) command.frameSourceUidCounts = migration.frameSourceUidCounts;
      this._nextFrameIdentity = migration.nextFrameIdentity;
      this._applyFrameSourceChanges(command, 'after', migration.preparedFrameSources);
      this.report._styk.animation = migration.afterAnimation;
    }
    this._layerChanged({reindex});
    this._invalidate({timing: Boolean(migration)});
    command.afterSelection = this._selectionState(); this._record(command);
    this._emit('edit', {label, layers: true, layerMetadata: true, layerRevision: this.layerRevision, structural, animation: Boolean(migration), timing: Boolean(migration)}); return true;
  },
  _applyLayerAnimationPatch(patch, direction) {
    const state = patch[direction];
    if (!state.exists) { delete this.report._styk.animation; return; }
    const changed = new Set(patch.changes.map(change => change.id));
    const channels = this.animationChannels.filter(channel => !changed.has(channel.id));
    const insertions = patch.changes.map(change => change[direction]).filter(value => value.exists).sort((a, b) => a.index - b.index);
    for (const value of insertions) channels.splice(value.index, 0, clone(value.channel));
    this.report._styk.animation = {...clone(state.fields), channels};
  },
  _applyLayerChanges(changes, direction) {
    const state = ensureLayerState(this.report);
    for (const change of changes) write(state, change.path, change[direction]);
    this._layerChanged({reindex: true});
  },
  createLayer(name, {index, activate = true} = {}) {
    const state = ensureLayerState(this.report), id = `layer-${state.nextId}`;
    if (state.order.length >= 10000) throw new Error('A project supports at most 10,000 user layers.');
    const insertion = index ?? state.order.length;
    if (!Number.isInteger(insertion) || insertion < 0 || insertion > state.order.length) throw new Error('Invalid layer position.');
    const title = cleanName(name ?? `Layer ${state.nextId}`), order = state.order.slice(); order.splice(insertion, 0, id);
    this._layerEdit('Create layer', [[['byId', id], {name: title, visible: true, locked: false}], [['order'], order], [['nextId'], state.nextId + 1]],
      {structural: true, reindex: true, activeId: activate ? id : undefined}); return this.getLayer(id);
  },
  renameLayer(id, name) {
    if (FIXED_LAYER_IDS.includes(id)) throw new Error('Scene and Camera are permanent tracks and cannot be renamed.');
    if (!owns(ensureLayerState(this.report).byId, id)) throw new Error('Choose an existing user layer.');
    return this._layerEdit('Rename layer', [[['byId', id, 'name'], cleanName(name)]]);
  },
  deleteLayer(id, {targetLayerId} = {}) {
    if(this.report._styk?.layerSheet&&!targetLayerId)return this.sheetDeleteLayer(id);
    if (this._drag) this.commitDrag();
    const state = ensureLayerState(this.report), position = state.order.indexOf(id);
    if (position < 0) throw new Error('Scene and Camera cannot be deleted.');
    if (state.order.length === 1) throw new Error('Keep at least one user layer.');
    const target = targetLayerId ?? state.order[position - 1] ?? state.order[position + 1];
    if (target === id || !owns(state.byId, target)) throw new Error('Choose another user layer for its figures.');
    if(this.report._styk.layerSheet&&!this._sheetDeletingLayer){
      return this.movieclipBatch('Delete layer',()=>{this.sheetAssignFigures(this.getLayerFigureUids(id),target);this._sheetDeletingLayer=true;
        try{return this.deleteLayer(id,{targetLayerId:target});}finally{this._sheetDeletingLayer=false;}});
    }
    const migration = planLayerMembershipMigration(this, this.getLayerFigureUids(id), target, {deletedLayerId: id});
    const updates = [[['order'], state.order.filter(value => value !== id)], [['byId', id], undefined, true]];
    if (state.defaultLayerId === id) updates.push([['defaultLayerId'], target]);
    for (const [uid, assignment] of Object.entries(state.assignments)) if (assignment === id) updates.push([['assignments', uid], target]);
    return this._layerEdit('Delete layer', updates, {structural: true, reindex: true, activeId: state.activeId === id ? target : undefined, migration});
  },
  reorderLayers(ids) {
    const state = ensureLayerState(this.report), order = [...ids];
    if (order.length !== state.order.length || new Set(order).size !== order.length || order.some(id => !owns(state.byId, id))) throw new Error('Include every user layer exactly once. Scene and Camera cannot be reordered.');
    return this._layerEdit('Reorder layers', [[['order'], order]], {structural: true});
  },
  moveLayerTo(id, index) {
    const state = ensureLayerState(this.report), from = state.order.indexOf(id);
    if (from < 0 || !Number.isInteger(index) || index < 0 || index >= state.order.length) throw new Error('Choose a valid user layer position.');
    const order = state.order.slice(); order.splice(from, 1); order.splice(index, 0, id); return this.reorderLayers(order);
  },
  assignFiguresToLayer(uids, id) {
    if(this.report._styk?.layerSheet)return this.sheetAssignFigures(uids,id);
    if (this._drag) this.commitDrag();
    const state = ensureLayerState(this.report); if (!owns(state.byId, id)) throw new Error('Figures belong to user layers, not Scene or Camera.');
    const ids = [...new Set(uids)]; if (ids.some(uid => !this._layerUidCounts.has(uid))) throw new Error('Choose figures present in this animation.');
    const updates = ids.filter(uid => this.layerForUid(uid) !== id).map(uid => [['assignments', String(uid)], id]);
    const migration = updates.length ? planLayerMembershipMigration(this, ids, id) : null;
    return this._layerEdit('Assign figures to layer', updates, {structural: true, reindex: true, migration});
  },
  setLayerVisible(id, visible) { return this._setLayerFlag(id, 'visible', visible); },
  setLayerLocked(id, locked) { return this._setLayerFlag(id, 'locked', locked); },
  _setLayerFlag(id, key, value) {
    if (typeof value !== 'boolean' || !this.getLayer(id)) throw new Error('Choose an existing track and a boolean state.');
    const state = ensureLayerState(this.report); state.fixed ??= {scene: {visible: true, locked: false}, camera: {visible: true, locked: false}};
    return this._layerEdit(key === 'visible' ? 'Set layer visibility' : 'Set layer lock', [[[FIXED_LAYER_IDS.includes(id) ? 'fixed' : 'byId', id, key], value]]);
  },
  _trackLayerCommand(command, direction, {record = false} = {}) {
    const previous = framesOf(command, direction === 'after' ? 'before' : 'after'), next = framesOf(command, direction);
    if (!previous.length && !next.length && !command.frameSourceUidCounts && !command.frameUidCounts) return;
    const delta = new Map();
    for (const [frames, sign] of [[previous, -1], [next, 1]]) for (const frame of frames) for (const object of frame.objects)
      delta.set(object.unique_id, (delta.get(object.unique_id) ?? 0) + sign);
    for (const [side, sign] of [[direction === 'after' ? 'before' : 'after', -1], [direction, 1]])
      for (const counts of [command.frameSourceUidCounts,command.frameUidCounts])
        for (const [uid, count] of counts?.[side] ?? []) delta.set(uid, (delta.get(uid) ?? 0) + count * sign);
    let changed = false; const state = ensureLayerState(this.report), assignments = [];
    for (const [uid, amount] of delta) {
      if (!amount) continue;
      const previousCount = this._layerUidCounts.get(uid) ?? 0, count = previousCount + amount;
      let membershipChanged = (previousCount > 0) !== (count > 0);
      if (count <= 0) { this._layerUidCounts.delete(uid); if (previousCount > 0) this._layerGroups.get(this.layerForUid(uid))?.delete(uid); }
      else {
        if (record && !this._layerSeenUids.has(uid)) {
          const layer = this._newLayerHints?.get(uid) ?? (state.byId[state.activeId] ? state.activeId : state.defaultLayerId);
          if (layer !== this.layerForUid(uid)) {
            const change = {path: ['assignments', String(uid)], before: capture(state, ['assignments', String(uid)]), after: {exists: true, value: layer}};
            write(state, change.path, change.after); assignments.push(change); membershipChanged = true;
          }
        }
        this._layerUidCounts.set(uid, count); this._layerSeenUids.add(uid);
        if (membershipChanged) this._layerGroups.get(this.layerForUid(uid))?.add(uid);
      }
      // Capturing another pose of an existing UID changes its retention count,
      // not the layer hierarchy. Preserve panel/track indexes for normal drags.
      if (membershipChanged) { this._layerUidArrays.delete(this.layerForUid(uid)); changed = true; }
    }
    this._newLayerHints?.clear();
    if (assignments.length) command.layerChanges = assignments;
    if (changed) { this._layerChanged(); command.layers = true; }
  },
  _registerFrameSources(frames) {
    if (!frames.length) return;
    for (const frame of frames) if (frame._styk?.frameId && !this._generatedFrameSources.has(frame._styk.frameId)) {
      this._generatedFrameSources.add(frame._styk.frameId);
      // Pose sources are referenced by tiny key IDs in commands. Account for
      // their numeric arrays and object storage as part of the history budget.
      this._pendingSourceBytes = (this._pendingSourceBytes ?? 0) + 256 + frame.objects.reduce((bytes, object) =>
        bytes + 512 + 8 * ((object.angles?.length ?? 0) + (object.lengths?.length ?? 0) + (object.bends?.length ?? 0)), 0);
    }
    const command = {kind: 'splice', before: [], after: frames};
    this._trackLayerCommand(command, 'after', {record: true});
    if (command.layerChanges?.length) (this._pendingSourceLayerChanges ??= []).push(...command.layerChanges);
  },
};
