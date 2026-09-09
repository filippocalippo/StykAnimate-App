import {getFrameById, frameIndexForId, invalidateFrameIndex} from './frame-ids.mjs';
const clone = value => structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,127}$/.test(id);
const channelSources = new WeakMap();
// Report-owned frames can be reused after removal without sharing mutable
// objects with the immutable history snapshots they were copied from.
const sourceCopies = new WeakMap();
function references(channel, retained, candidates, visited) {
  if (!channel || channel.property !== 'pose' || visited.has(channel)) return;
  visited.add(channel);
  let entry = channelSources.get(channel);
  if (!entry || entry.keys !== channel.keys) {
    entry = {keys: channel.keys, ids: new Set(channel.keys.map(key => key.value?.frameId).filter(Boolean))}; channelSources.set(channel, entry);
  }
  // Native references can outnumber collectible captures by many orders of
  // magnitude. Intersect the smaller set instead of scanning the whole movie
  // once for each history snapshot.
  if (candidates.size < entry.ids.size) {
    for (const id of candidates) if (entry.ids.has(id)) retained.add(id);
  } else for (const id of entry.ids) if (candidates.has(id)) retained.add(id);
}

/** Validate persisted references before replacing the currently open document. */
export function validateFrameIdentities(report) {
  const iterator=validateFrameIdentitySteps(report);
  for (;;) {const step=iterator.next(); if (step.done) return step.value;}
}
export function* validateFrameIdentitySteps(report) {
  const ids = new Set(); let next = 1;
  const sources = report._styk?.frameSources;
  if (sources !== undefined && (!sources || typeof sources !== 'object' || Array.isArray(sources))) throw new Error('Invalid retained frame sources.');
  function* entries() {
    for (const frame of report.keyframes) yield [null,frame];
    for (const key in sources ?? {}) if (own(sources,key)) yield [key,sources[key]];
  }
  let work=0;
  for (const [key, frame] of entries()) {
    if (++work % 256 === 0) yield {phase:'identities', checked:work};
    const id = frame?._styk?.frameId;
    if (id === undefined && key === null) continue;
    if (!validId(id) || (key !== null && key !== id) || ids.has(id)) throw new Error('Frame source identities must be valid and unique.');
    ids.add(id);
    if (/^frame-[1-9]\d*$/.test(id)) {
      const number = Number(id.slice(6));
      if (!Number.isSafeInteger(number)) throw new Error('Frame identity capacity exceeded.');
      next = Math.max(next, number + 1);
    }
  }
  return next;
}

function beforeFrames(command) {
  if (command.kind === 'splice') return command.before;
  if (command.kind === 'ranges') return command.changes.flatMap(change => change.before);
  return [];
}

export const editorFrameMethods = {
  _initializeFrameIds(next = validateFrameIdentities(this.report)) {
    this._nextFrameIdentity = next;
    this._generatedFrameSources = new Set(); this._sourceTableWasPresent = this.report._styk.frameSources !== undefined;
    for (const frame of this.report.keyframes) if (!frame._styk?.frameId) this._assignFrameId(frame);
    invalidateFrameIndex(this.report);
  },
  _assignFrameId(frame) {
    if (!Number.isSafeInteger(this._nextFrameIdentity)) throw new Error('Frame identity capacity exceeded.');
    frame._styk = {...frame._styk, frameId: `frame-${this._nextFrameIdentity++}`}; return frame._styk.frameId;
  },
  getFrameId(index = this.frameIndex) {
    const frame = this.report.keyframes[index]; if (!frame) throw new Error('Choose an existing source frame.');
    return frame._styk?.frameId ?? this._assignFrameId(frame);
  },
  getFrameById(id) { return getFrameById(this.report, id); },
  frameIndexForId(id) { return frameIndexForId(this.report, id); },
  _newInsertedFrames(frames) {
    const existing = new Set(this.report.keyframes);
    return frames.map(value => { const frame = existing.has(value) ? clone(value) : value; this._assignFrameId(frame); return frame; });
  },
  _reconcileFrameIds(previous) {
    const live = new Set(this.report.keyframes), retained = new Set(Object.keys(this.report._styk?.frameSources ?? {}));
    const reserved = new Map([...previous].filter(([, frame]) => live.has(frame)));
    for (const frame of this.report.keyframes) {
      const id = frame._styk?.frameId;
      if (!id || retained.has(id) || (reserved.has(id) && reserved.get(id) !== frame)) this._assignFrameId(frame);
      retained.add(frame._styk.frameId);
    }
    invalidateFrameIndex(this.report);
  },
  _captureRemovedFrameSources(command) {
    if (command.frameSourceChanges) return;
    const frames = beforeFrames(command); if (!frames.length) return;
    invalidateFrameIndex(this.report);
    const referenced = new Set();
    for (const channel of [...this.animationChannels, ...(this._frameDraftStoredEdit?.before.animation?.channels ?? [])]) if (channel.property === 'pose')
      for (const key of channel.keys) if (key.value?.frameId) referenced.add(key.value.frameId);
    if (!referenced.size) return;
    const sources = this.report._styk.frameSources, changes = [];
    for (const frame of frames) {
      const id = frame._styk?.frameId;
      if (!referenced.has(id) || this.frameIndexForId(id) >= 0 || own(sources ?? {}, id)) continue;
      changes.push({id, before: {exists: false}, after: {exists: true, value: clone(frame)}});
      (this.report._styk.frameSources ??= {})[id] = clone(frame);
    }
    if (changes.length) { command.frameSourceChanges = changes; command.hadFrameSourceTable = sources !== undefined; }
  },
  _applyFrameSourceChanges(command, direction, prepared) {
    if (!command.frameSourceChanges?.length) return;
    const sources = this.report._styk.frameSources ??= {};
    let copies = sourceCopies.get(command); if (!copies) sourceCopies.set(command, copies = new Map());
    for (const change of command.frameSourceChanges) {
      const opposite = direction === 'after' ? 'before' : 'after';
      if (sources[change.id]) copies.set(`${opposite}:${change.id}`, sources[change.id]);
      const state = change[direction];
      if (state.exists) sources[change.id] = prepared?.[change.id] ?? copies.get(`${direction}:${change.id}`) ?? clone(state.value);
      else delete sources[change.id];
    }
    if (direction === 'before' && !command.hadFrameSourceTable && !Object.keys(sources).length) delete this.report._styk.frameSources;
  },
  /** Imported assets are retained; only this session's unreferenced pose captures
   * can be collected, after the undo/redo entries that needed them disappear. */
  _pruneFrameSources() {
    if (!this._generatedFrameSources?.size) return;
    const retained = new Set();
    const visited = new Set(), keep = channel => references(channel, retained, this._generatedFrameSources, visited);
    for (const channel of this.animationChannels) keep(channel);
    for (const channel of this.report._styk.simpleFrameDraft?.animationBaseline?.channels ?? []) keep(channel);
    for (const command of [...this._undo, ...this._redo]) {
      for (const side of ['before', 'after']) {
        for (const channel of command.draftAnimation?.[side]?.channels ?? []) keep(channel);
        const state = command.frameDraftState?.[side] ?? command.frameDraftJournal?.[side]?.state ?? command.frameDraftTopology?.[side]?.state;
        for (const channel of state?.animationBaseline?.channels ?? []) keep(channel);
        for (const channel of command.frameDraftStored?.[side]?.animation?.channels ?? []) keep(channel);
        for (const channel of command.frameDraftStored?.[side]?.state?.animationBaseline?.channels ?? []) keep(channel);
      }
      for (const id of command.retainedFrameSourceIds ?? []) retained.add(id);
      if (command.kind === 'animation') for (const value of [command.before, command.after]) for (const channel of value?.channels ?? []) keep(channel);
      if (command.kind === 'scene') for (const side of ['before', 'after']) for (const entry of command[side]?.channels ?? []) keep(entry.channel);
      for (const change of command.layerAnimationPatch?.changes ?? []) for (const side of ['before', 'after']) keep(change[side]?.channel);
      for (const change of command.frameSourceChanges ?? []) retained.add(change.id);
      if (command.kind === 'topology') for (const side of ['before', 'after']) for (const entry of command[side]?.frames ?? []) if (entry.sourceId) retained.add(entry.sourceId);
    }
    const removed = [], sources = this.report._styk.frameSources;
    for (const id of this._generatedFrameSources) if (!retained.has(id)) {
      if (sources?.[id]) { removed.push(sources[id]); delete sources[id]; }
      this._generatedFrameSources.delete(id);
    }
    if (removed.length) this._trackLayerCommand({kind: 'splice', before: removed, after: []}, 'after');
    if (sources && !Object.keys(sources).length && !this._sourceTableWasPresent) delete this.report._styk.frameSources;
  },
  captureFrameSource(frame = this.evaluatedFrame) {
    // Runtime segment caches can dwarf the saved pose. Omit them before cloning
    // while independently retaining every authoritative/unknown object field.
    const objects = frame.objects.map(object => Object.fromEntries(Object.keys(object)
      .filter(key => key !== 'runtime_segments').map(key => [key, object[key]])));
    const source = clone({...frame, objects}), id = this._assignFrameId(source);
    (this.report._styk.frameSources ??= {})[id] = source;
    this._registerFrameSources([source]);
    return id;
  },
  moveFrame(fromIndex, toIndex) {
    const frames = this.report.keyframes;
    if (![fromIndex, toIndex].every(index => Number.isInteger(index) && index >= 0 && index < frames.length)) throw new Error('Choose valid keyframe positions.');
    if (fromIndex === toIndex) return false;
    const start = Math.min(fromIndex, toIndex), end = Math.max(fromIndex, toIndex), before = clone(frames.slice(start, end + 1)), after = clone(before);
    const [moved] = after.splice(fromIndex - start, 1); after.splice(toIndex - start, 0, moved);
    return this._rangesEdit('Move keyframe', [{index: start, before, after}], {selectIndex: toIndex});
  },
  insertDuplicateFrames(indices = [this.frameIndex]) {
    const selected = this._frameIndices(indices); if (!selected.length) return 0;
    if (this.report.keyframes.length + selected.length > 100000) throw new Error('The animation supports at most 100,000 keyframes.');
    const changes = selected.map(index => ({index, before: [], after: this._newInsertedFrames([clone(this.report.keyframes[index])])}));
    this._rangesEdit('Insert duplicate keyframes', changes); return changes.length;
  },
};
