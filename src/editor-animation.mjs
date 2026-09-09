/** Authored animation metadata and bounded, undoable sparse-key operations. */
import {animationChannels, animationEndTick, animationChannelId, findAnimationChannel, normalizeAnimationTarget,
  validateAnimationValue, animationPropertyValue, sampleAnimationChannel} from './animation-channels.mjs';
import {buildGeometry, evaluatedFrame, nativeTimeline} from './pivot/geometry.mjs';
import {previewBranchStyleAnimation,commitBranchStyleAnimation,cancelBranchStyleAnimation} from './editor-branch-style.mjs';

import {keyEasing, assignKeyEasing, validateKeyEasing} from './keyframe-easing.mjs';
import {AUTHORING_PROPERTIES, isDiscreteAnimationProperty} from './animation-properties.mjs';
import {projectNativePropertyChannel} from './native-property-projection.mjs';
const MAX_TICK = 10000000;
const checkTick = tick => { if (!Number.isInteger(tick) || tick < 0 || tick > MAX_TICK) throw new Error('Keyframe time must be an integer from 0 to 10,000,000.'); return tick; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortKeys = keys => keys.sort((a, b) => a.tick - b.tick || Number(Boolean(b.hidden)) - Number(Boolean(a.hidden)));
function context(editor) { return {resolveGeometry: (report, frame) => frame === editor._evaluated ? editor.geometry : buildGeometry(report, frame)}; }
function currentAnimation(editor) { return editor.report._styk?.animation ?? null; }
function assignAnimation(editor, animation) {
  const previousPoses=animationChannels(editor.report).filter(channel=>channel.property==='pose');
  const nextPoses=(animation?.channels??[]).filter(channel=>channel.property==='pose');
  const retainPropertyMarkers=previousPoses.length===nextPoses.length && previousPoses.every((channel,index)=>channel===nextPoses[index]);
  editor.report._styk ??= {};
  if (animation) editor.report._styk.animation = animation; else delete editor.report._styk.animation;
  editor._invalidate({timing: true, retainPropertyMarkers});
}
function draftAnimation(editor) {
  const before = currentAnimation(editor), after = {...before, version: 1, nextKeyId: before?.nextKeyId ?? 1, channels: [...animationChannels(editor.report)]};
  const cloned = new Map(), indices = new Map(after.channels.map((channel, index) => [channel.id, index]));
  const draft = {before, after, sources: {}, poseSources: new Map(), changed: false,
    finalize() { const sorted=new Set();for (const channel of cloned.values()) if(!sorted.has(channel.keys)){sortKeys(channel.keys);sorted.add(channel.keys);} },
    addChannel(channel) { indices.set(channel.id, after.channels.length); after.channels.push(channel); cloned.set(channel.id, channel); return channel; },
    shareChannel(source, target, id) {
      const channel={...source,target,id},index=indices.get(id);
      if(index===undefined)this.addChannel(channel);else{after.channels[index]=channel;cloned.set(id,channel);}
      this.changed=true;return channel;
    },
    detachPoseProperties(channel) {
      if (!editor.propertyChannels || channel.property !== 'pose') return;
      // Native appearance stays on the native clock until that property is
      // explicitly authored. One pose edit must not expand an entire layer
      // into figures × properties × frames scalar keys.
      if (channel.nativeProperties) return;
      const target = channel.target, targets = target.kind === 'layer'
        ? (editor.layers.find(layer => layer.id === target.id)?.figureUids ?? []).map(uid => ({kind:'figure',uid})) : [target];
      for (const owner of targets) for (const property of AUTHORING_PROPERTIES[owner.kind] ?? []) {
        if (property === 'pose') continue;
        if(owner.kind==='figure' && ['x','y','rotation'].includes(property) && [editor.evaluatedFrame,...editor.report.keyframes].some(frame=>frame.objects.some(object=>object.unique_id===owner.uid&&object.join))) continue;
        const id = animationChannelId(owner, property);
        if (indices.has(id)) continue;
        const native = editor.nativePropertyChannel(owner, property);
        // Moving a Pose cannot alter a property that is constant in every source.
        if(native.keys.every(key=>Object.is(key.value,native.keys[0]?.value)))continue;
        if (native.keys.length) { draft.addChannel({...native, source:'authored', keys:native.keys.map(key => ({...key}))}); draft.changed = true; }
      }
    },
    channel(id, {adopt = true} = {}) {
    if (cloned.has(id)) return cloned.get(id);
    let index = indices.get(id);
    if (index === undefined && adopt) {
      const native = editor._nativeAnimationChannels?.get(id);
      if (native) { index = after.channels.length; indices.set(id, index); after.channels.push({...native, source: 'authored'}); }
    }
    if (index === undefined) return null;
    const channel = {...after.channels[index], target: {...after.channels[index].target}, keys: after.channels[index].keys.map(key => ({...key}))};
    after.channels[index] = channel; cloned.set(id, channel); draft.detachPoseProperties(channel); return channel;
  }};
  return draft;
}
function recordAnimation(editor, label, draft, selection = editor._selectionState()) {
  if (!draft.changed) return false;
  draft.finalize?.();
  if (draft.sources && Object.keys(draft.sources).length) {
    editor.report._styk ??= {}; editor.report._styk.frameSources ??= {};
    Object.assign(editor.report._styk.frameSources, draft.sources);
    editor._registerFrameSources?.(Object.values(draft.sources));
  }
  assignAnimation(editor, draft.after);
  editor._record({kind: 'animation', label, before: draft.before, after: draft.after, beforeSelection: selection,
    afterSelection: editor._selectionState(), structural: false, timing: true});
  editor._emit('edit', {label, animation: true, timing: true}); return true;
}
function mutateAnimation(editor, label, mutate) {
  if (editor._animationEdit) editor.commitAnimationEdit();
  if (editor.dragging) editor.commitDrag();
  const draft = draftAnimation(editor), selection = editor._selectionState(), result = mutate(draft);
  recordAnimation(editor, label, draft, selection); return result;
}
function frameAtTick(editor, tick, ignorePreview = false) {
  if (!ignorePreview && tick === editor.tick) return {frame: editor.evaluatedFrame, index: editor.frameIndex};
  const rows = editor.timeline; let low = 0, high = rows.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (rows[mid].start <= tick) low = mid; else high = mid - 1; }
  const row = rows[low];
  return {index: low, frame: evaluatedFrame(editor.report, low, row.count > 0 ? Math.min(1, (tick - row.start) / row.count) : 0, tick)};
}
function poseValue(editor, draft, tick) {
  if (draft.poseSources.has(tick)) return draft.poseSources.get(tick);
  const {frame, index} = frameAtTick(editor, tick);
  if (frame === editor.report.keyframes[index]) return {frameId: editor.getFrameId(index)};
  // The snapshot is an immutable source asset; history moves only references.
  // Keep it for redo, avoiding copies of all source poses on every property drag.
  const source = structuredClone(frame), frameId = editor._assignFrameId(source);
  for (const object of source.objects) delete object.runtime_segments;
  draft.sources[frameId] = source; const value = {frameId}; draft.poseSources.set(tick, value); return value;
}
function putKey(editor, draft, entry) {
  if(entry.exactTarget!==undefined&&typeof entry.exactTarget!=='boolean')throw new Error('Exact animation targeting must be a boolean.');
  const property = entry.property, tick = checkTick(entry.tick ?? editor.tick),target = entry.exactTarget
    ? normalizeAnimationTarget(entry.target) : editor.resolveAnimationTarget(entry.target,property,tick);
  const id = animationChannelId(target, property);
  let channel = draft.channel(id);
  if (!channel && editor.propertyChannels && property !== 'pose') {
    const native = editor.nativePropertyChannel(target, property);
    channel = draft.addChannel({...native, source: 'authored', keys: native.keys.map(key => ({...key}))});
    draft.changed = true;
  }
  if (!channel) channel = draft.addChannel({id, target, property, keys: []});
  draft.detachPoseProperties(channel);
  let raw=entry.value;
  if(raw===undefined){
    if(property==='pose')raw=poseValue(editor,draft,tick);
    else if(entry.exactTarget){
      const {frame}=frameAtTick(editor,tick),visible=animationPropertyValue(editor.report,frame,target,property,context(editor));
      // A persisted global row owns its own curve even when an instance scope
      // overrides the displayed style. Dormant scoped targets remain absent.
      raw=visible===undefined?undefined:sampleAnimationChannel(channel,tick)??visible;
    }else raw=editor.animationValue(target,property,tick);
  }
  if (raw === undefined) throw new Error('The selected figure is not present at this time.');
  draft.keyTicks ??= new Map();
  let ticks = draft.keyTicks.get(channel);
  if (!ticks) { ticks = new Map(channel.keys.filter(key => !key.hidden).map(key => [key.tick, key])); draft.keyTicks.set(channel, ticks); }
  let key = ticks.get(tick);
  const value = validateAnimationValue(target, property, raw), interpolation = entry.interpolation ?? key?.interpolation ?? (property === 'pose' || isDiscreteAnimationProperty(property) ? 'hold' : 'linear');
  const easing = {interpolation, ...(interpolation === 'bezier' ? {bezier: entry.bezier ?? key?.bezier} : {})};
  validateKeyEasing(easing, property);
  if (key) {
    if (!same(key.value, value) || key.interpolation !== interpolation || !same(key.bezier, easing.bezier) || key.passthrough) {
      key.value = value; assignKeyEasing(key, easing); delete key.passthrough; delete key.nativeCurve; delete key.nativeValueMode; delete key.nativeRotation; draft.changed = true;
    }
  } else {
    key = {id: nextKeyIdentity(draft, channel), tick, value, ...keyEasing(easing)}; channel.keys.push(key); ticks.set(tick, key); draft.changed = true;
  }
  return key;
}
function nextKeyIdentity(draft, channel) {
  draft.keyIds ??= new Map();
  let ids = draft.keyIds.get(channel), id;
  if (!ids) { ids = new Set(channel.keys.map(key => key.id)); draft.keyIds.set(channel, ids); }
  do {
    if (!Number.isSafeInteger(draft.after.nextKeyId) || draft.after.nextKeyId < 1) throw new Error('Animation key identity capacity exceeded.');
    id = `key-${draft.after.nextKeyId++}`;
  } while (ids.has(id));
  ids.add(id);
  return id;
}
function selectionGroups(selection) {
  if (!Array.isArray(selection)) throw new Error('Choose animation keys.');
  const groups = new Map();
  for (const item of selection) {
    if (!item || typeof item.channelId !== 'string' || !Array.isArray(item.keyIds)) throw new Error('Key selections require channel IDs and key IDs.');
    const ids = groups.get(item.channelId) ?? new Set(); for (const id of item.keyIds) ids.add(id); groups.set(item.channelId, ids);
  }
  return groups;
}
function checkCollisions(keys) {
  const occupied = new Set();
  for (const key of keys) {
    checkTick(key.tick); if (key.hidden) continue;
    if (occupied.has(key.tick)) throw new Error('Another key already occupies that time on this property.');
    occupied.add(key.tick);
  }
}

export const editorAnimationMethods = {
  /** Detach only the property being authored, retaining its original frame keys.
   * Source poses remain immutable assets; no composed frame is baked per tick. */
  nativePropertyChannel(target, property, options={}) {
    return projectNativePropertyChannel(this,target,property,options,tick=>frameAtTick(this,tick,true).frame);
  },
  get animationChannels() { return animationChannels(this.report); },
  get animationEndTick() { return animationEndTick(this.report); },
  segmentAnimationTarget(uid,handleId,property,tick=this.tick){
    const target={kind:'segment',uid,handleId};
    if(!this.animationChannels.some(channel=>channel.target.kind==='segment'&&channel.target.uid===uid&&channel.target.handleId===handleId&&
      channel.target.figureTypeId!==undefined&&(property===undefined||channel.property===property)))return normalizeAnimationTarget(target);
    const {frame}=frameAtTick(this,tick),object=frame.objects.find(object=>object.unique_id===uid);
    return normalizeAnimationTarget(object?{...target,figureTypeId:object.figure_type_id}:target);
  },
  resolveAnimationTarget(target,property,tick=this.tick){
    return target?.kind==='segment'&&target.figureTypeId===undefined?this.segmentAnimationTarget(target.uid,target.handleId,property,tick):normalizeAnimationTarget(target);
  },
  animationChannel(target, property, {exactTarget=false}={}) { return findAnimationChannel(this.report, exactTarget?normalizeAnimationTarget(target):this.resolveAnimationTarget(target,property), property); },
  animationValue(target, property, tick = this.tick, {exactTarget=false}={}) {
    checkTick(tick); const {frame} = frameAtTick(this, tick);
    target=exactTarget?normalizeAnimationTarget(target):this.resolveAnimationTarget(target,property,tick);
    const visible=animationPropertyValue(this.report,frame,target,property,context(this));
    return exactTarget&&property!=='pose'&&visible!==undefined?(sampleAnimationChannel(findAnimationChannel(this.report,target,property),tick)??visible):visible;
  },
  nearestAnimationKey(target, property, direction, tick = this.tick, options={}) {
    const keys = this.animationChannel(target, property,options)?.keys ?? []; let low = 0, high = keys.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (direction < 0 ? keys[mid].tick < tick : keys[mid].tick <= tick) low = mid + 1; else high = mid;
    }
    for (let index = direction < 0 ? low - 1 : low; index >= 0 && index < keys.length; index += direction < 0 ? -1 : 1)
      if (!keys[index].hidden) return keys[index];
    return null;
  },
  /** Native descriptors are lazy, so unopened tracks allocate no per-frame keys. */
  nativePoseChannel(target, {nativeOnly = false} = {}) {
    target = normalizeAnimationTarget(target); const id = animationChannelId(target, 'pose');
    const authored = !nativeOnly && this.animationChannel(target, 'pose'); if (authored) return authored;
    this._nativeAnimationChannels ??= new Map();
    const cacheId = nativeOnly ? `${id}:native-baseline` : id;
    const cached = this._nativeAnimationChannels.get(cacheId), timing = this.timeline;
    if (cached?._timeline === timing && cached?._document === this._documentToken) return cached;
    let markers = this._nativePoseMarkerCache;
    if (markers?.timing !== timing || markers?.document !== this._documentToken) {
      const keys = nativeTimeline(this.report).map((row, index) => ({id:`native:pose:${this.getFrameId(index)}`, tick:row.start,
        value:{frameId:this.getFrameId(index)}, ...(this.report.keyframes[index]._styk?.easing ?? (this.report.version < 5 ? {interpolation:'constant'} : this.report.auto_easing ? {} : {interpolation:'linear'})),
        ...(row.count === 0 ? {hidden:true} : {})}));
      this._nativePoseMarkerCache = markers = {timing, document:this._documentToken, keys};
    }
    const emptyLayer = target.kind === 'layer' && !this.layers?.find(layer => layer.id === target.id)?.figureUids?.length;
    const inherited = !nativeOnly && target.kind === 'figure' ? this.animationChannel({kind:'layer',id:this.layerForUid(target.uid)}, 'pose') : null;
    const markerKeys = inherited ? inherited.keys : emptyLayer ? [] : markers.keys;
    // Key identity is scoped by channel ID. Native figures therefore share the
    // same immutable sequence, and connected edits can preserve that sharing.
    const descriptor = {id, target, property: 'pose', source: 'native', keys:markerKeys};
    if (['figure','layer'].includes(target.kind) && (inherited ? inherited.nativeProperties : this.propertyChannels)) descriptor.nativeProperties = true;
    Object.defineProperties(descriptor, {_timeline: {value: timing}, _document: {value: this._documentToken},
      markerKeys:{value:markerKeys}, markerKeyId:{value:key=>key.id}});
    this._nativeAnimationChannels.set(cacheId, descriptor); return descriptor;
  },
  adoptNativePoseTrack(target) {
    const descriptor = this.nativePoseChannel(target);
    if (descriptor.source !== 'native') return descriptor;
    return mutateAnimation(this, 'Make pose track independent', draft => { const channel = draft.channel(descriptor.id); draft.changed = true; return channel; });
  },
  addAnimationKey(target, property, tick = this.tick, value, {exactTarget=false}={}) { return this.addAnimationKeys([{target, property, tick, value,exactTarget}])[0]; },
  addAnimationKeys(entries) {
    if (!Array.isArray(entries) || !entries.length) return [];
    return mutateAnimation(this, 'Add animation keys', draft => {
      const shared=new Map(), occurrences=new Map();
      for(const entry of entries){const id=animationChannelId(entry.target,entry.property);occurrences.set(id,(occurrences.get(id)??0)+1);}
      return entries.map(entry=>{
        const target=entry.target,id=animationChannelId(target,entry.property);
        const source=this.animationChannel(target,entry.property) ?? this._nativeAnimationChannels?.get(id);
        // Equal native/connected pose sequences with the same edit remain one
        // sequence. Independent curves and repeated edits of a target use COW.
        const eligible=target.kind==='figure'&&entry.property==='pose'&&source?.nativeProperties&&occurrences.get(id)===1;
        const signature=eligible?JSON.stringify({...entry,target:undefined}):null;
        const prior=eligible?shared.get(source.keys)?.get(signature):null;
        if(prior){if(prior.changed)draft.shareChannel({...source,source:'authored',keys:prior.channel.keys},target,id);return prior.key;}
        const key=putKey(this,draft,entry);
        if(eligible){let edits=shared.get(source.keys);if(!edits)shared.set(source.keys,edits=new Map());
          edits.set(signature,{channel:draft.after.channels.find(channel=>channel.id===id),key,
            changed:!same(source.keys.find(value=>value.tick===(entry.tick??this.tick)&&!value.hidden),key)});}
        return key;
      });
    });
  },
  setAnimationKey(channelId, keyId, patch) {
    return mutateAnimation(this, 'Edit animation key', draft => {
      const channel = draft.channel(channelId), key = channel?.keys.find(key => key.id === keyId);
      if (!key) throw new Error('The animation key no longer exists.');
      if ('tick' in patch) key.tick = checkTick(patch.tick);
      if ('value' in patch) { key.value = validateAnimationValue(channel.target, channel.property, patch.value); delete key.passthrough; }
      if ('value' in patch || 'interpolation' in patch || 'bezier' in patch) {delete key.nativeCurve;delete key.nativeValueMode;delete key.nativeRotation;}
      if ('hidden' in patch) {
        if (channel.property !== 'pose' || typeof patch.hidden !== 'boolean') throw new Error('Only pose keys can be hidden.');
        if (patch.hidden) key.hidden = true; else delete key.hidden;
      }
      if ('interpolation' in patch || 'bezier' in patch) assignKeyEasing(key, validateKeyEasing({interpolation: patch.interpolation ?? key.interpolation,
        ...((patch.interpolation ?? key.interpolation) === 'bezier' ? {bezier: patch.bezier ?? key.bezier} : {})}, channel.property));
      checkCollisions(channel.keys); sortKeys(channel.keys); draft.changed = true; return key;
    });
  },
  setAnimationKeysEasing(selection, easing) {
    const fields = keyEasing(easing);
    return mutateAnimation(this, 'Change keyframe easing', draft => {
      for (const [channelId, ids] of selectionGroups(selection)) {
        const channel = draft.channel(channelId);
        if (!channel) throw new Error('The animation channel no longer exists.');
        const keys = new Map(channel.keys.map(key => [key.id, key]));
        for (const id of ids) {
          const key = keys.get(id);
          if (!key) throw new Error('The animation key no longer exists.');
          validateKeyEasing(fields, channel.property);
          if (!same(keyEasing(key), fields) || key.interpolation === undefined || key.nativeCurve || key.nativeRotation || key.nativeValueMode) { assignKeyEasing(key, fields); delete key.nativeCurve;delete key.nativeValueMode;delete key.nativeRotation;draft.changed = true; }
        }
      }
      return draft.changed;
    });
  },
  revealAnimationKey(channelId, keyId, duration = 1) {
    if (!Number.isInteger(duration) || duration < 1) throw new Error('A restored pose needs at least one frame.');
    return mutateAnimation(this, 'Restore hidden pose key', draft => {
      const channel = draft.channel(channelId), index = channel?.keys.findIndex(key => key.id === keyId);
      if (!channel || index < 0 || !channel.keys[index].hidden) return false;
      const tick = channel.keys[index].tick; delete channel.keys[index].hidden;
      for (let i = index + 1; i < channel.keys.length; i++) channel.keys[i].tick = checkTick(channel.keys[i].tick + duration);
      checkCollisions(channel.keys); sortKeys(channel.keys); draft.changed = true; return tick;
    });
  },
  scaleAnimationKeys(selection, factor, anchorTick) {
    if (!Number.isFinite(factor) || factor <= 0) throw new Error('Timing scale must be greater than zero.');
    checkTick(anchorTick);
    return mutateAnimation(this, 'Scale animation timing', draft => {
      for (const [channelId, ids] of selectionGroups(selection)) {
        const channel = draft.channel(channelId);
        if (!channel) throw new Error('The animation channel no longer exists.');
        if ([...ids].some(id => !channel.keys.some(key => key.id === id))) throw new Error('The animation key no longer exists.');
        for (const key of channel.keys) if (ids.has(key.id)) {
          const tick = checkTick(Math.round(anchorTick + (key.tick - anchorTick) * factor));
          draft.changed ||= tick !== key.tick; key.tick = tick;
        }
        checkCollisions(channel.keys);
      }
      return draft.changed;
    });
  },
  moveAnimationKeys(selection, deltaTick, {replace = false} = {}) {
    if (!Number.isInteger(deltaTick)) throw new Error('Move keys by a whole number of frames.');
    if (!deltaTick) return false;
    return mutateAnimation(this, 'Move animation keys', draft => {
      for (const [channelId, ids] of selectionGroups(selection)) {
        const channel = draft.channel(channelId); if (!channel) throw new Error('The animation channel no longer exists.');
        const existing = new Set(channel.keys.map(key => key.id));
        if ([...ids].some(id => !existing.has(id))) throw new Error('The animation key no longer exists.');
        for (const key of channel.keys) if (ids.has(key.id)) key.tick = checkTick(key.tick + deltaTick);
        if (replace) {
          const destinations = new Set(channel.keys.filter(key => ids.has(key.id) && !key.hidden).map(key => key.tick));
          channel.keys = channel.keys.filter(key => ids.has(key.id) || key.hidden || !destinations.has(key.tick));
        }
        checkCollisions(channel.keys); sortKeys(channel.keys); draft.changed ||= ids.size > 0;
      }
      return draft.changed;
    });
  },
  deleteAnimationKeys(selection) {
    return mutateAnimation(this, 'Delete animation keys', draft => {
      for (const [channelId, ids] of selectionGroups(selection)) {
        const channel = draft.channel(channelId); if (!channel) continue;
        const count = channel.keys.length; channel.keys = channel.keys.filter(key => !ids.has(key.id)); draft.changed ||= count !== channel.keys.length;
        // Empty pose channels intentionally represent an empty layer/camera/scene track.
      }
      return draft.changed;
    });
  },
  duplicateAnimationKeys(selection, deltaTick = 1, {replace = false} = {}) {
    if (!Number.isInteger(deltaTick)) throw new Error('Duplicate keys by a whole number of frames.');
    return mutateAnimation(this, 'Duplicate animation keys', draft => {
      const result = [];
      for (const [channelId, ids] of selectionGroups(selection)) {
        const channel = draft.channel(channelId); if (!channel) throw new Error('The animation channel no longer exists.');
        const copies = channel.keys.filter(key => ids.has(key.id)).map(key => ({...key, id: nextKeyIdentity(draft, channel), tick: checkTick(key.tick + deltaTick)}));
        if (replace) {
          const destinations = new Set(copies.filter(key => !key.hidden).map(key => key.tick));
          channel.keys = channel.keys.filter(key => key.hidden || !destinations.has(key.tick));
        }
        channel.keys.push(...copies); checkCollisions(channel.keys); sortKeys(channel.keys); draft.changed ||= copies.length > 0;
        result.push({channelId, keyIds: copies.map(key => key.id)});
      }
      return result;
    });
  },
  beginAnimationEdit(target, property, {exactTarget=false}={}) {
    if (this._animationEdit) this.commitAnimationEdit();
    if (this.dragging) this.commitDrag();
    target = exactTarget?normalizeAnimationTarget(target):this.resolveAnimationTarget(target,property); animationChannelId(target, property);
    if (property === 'pose') throw new Error('Use pose keys to edit a layer pose track.');
    const initialValue=this.animationValue(target,property,this.tick,{exactTarget});
    if(initialValue===undefined)throw new Error('The selected figure is not present at this time.');
    this._animationEdit = {target, property,exactTarget, tick: this.tick, before: currentAnimation(this), beforeChannel: this.animationChannel(target, property,{exactTarget}),
      initialValue, selection: this._selectionState(), changed: false}; return this._animationEdit;
  },
  previewAnimationEdit(value) {
    if(this._animationEdit?.branchStyle)return previewBranchStyleAnimation(this,value);
    const edit = this._animationEdit; if (!edit) throw new Error('Begin a property edit before previewing it.');
    value = validateAnimationValue(edit.target, edit.property, value);
    const draft = draftAnimation(this); putKey(this, draft, {target: edit.target, property: edit.property, tick: edit.tick, value,exactTarget:edit.exactTarget});
    if (!draft.changed) return value;
    draft.finalize();
    assignAnimation(this, draft.after); edit.changed = true;
    this._emit('edit', {live: true, animation: true, changedChannels: [animationChannelId(edit.target, edit.property)]}); return value;
  },
  commitAnimationEdit() {
    if(this._animationEdit?.branchStyle)return commitBranchStyleAnimation(this);
    const edit = this._animationEdit; if (!edit) return false;
    this._animationEdit = null;
    if (!edit.changed) return false;
    const channel = this.animationChannel(edit.target, edit.property,{exactTarget:edit.exactTarget}), key = channel?.keys.find(key => key.tick === edit.tick && !key.hidden);
    const originalKey = edit.beforeChannel?.keys.find(key => key.tick === edit.tick && !key.hidden);
    if (same(edit.beforeChannel, channel) || !originalKey && key?.value === edit.initialValue) {
      assignAnimation(this, edit.before); this._emit('edit', {animation: true, label: 'Cancel unchanged property edit'}); return false;
    }
    return recordAnimation(this, `Animate ${edit.property}`, {before: edit.before, after: currentAnimation(this), changed: true}, edit.selection);
  },
  cancelAnimationEdit() {
    if(this._animationEdit?.branchStyle)return cancelBranchStyleAnimation(this);
    const edit = this._animationEdit; if (!edit) return false;
    this._animationEdit = null; assignAnimation(this, edit.before);
    this._emit('edit', {animation: true, label: 'Cancel property edit'}); return true;
  },
};
