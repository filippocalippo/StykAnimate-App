import {assignKeyEasing, easingMode, keyEasing, autoKeyRange} from './keyframe-easing.mjs';
import {animationChannelId, animationPropertyValue, sampleAnimationChannel, validateAnimationDocument} from './animation-channels.mjs';
import {samplePoseTrack} from './animation-pose.mjs';
import {isColorAnimationProperty, isDiscreteAnimationProperty} from './animation-properties.mjs';
import {evaluatedNativeFrame, buildGeometry, nativeTimeline} from './pivot/geometry.mjs';

const clone = value => structuredClone(value);
const MAX_TICKS = 10000, MAX_OBJECTS = 250000, MAX_VALUES = 3000000;
const sorted = keys => keys.sort((a, b) => a.tick - b.tick || Number(Boolean(b.hidden)) - Number(Boolean(a.hidden)));
const context = {sampleNative: evaluatedNativeFrame, resolveGeometry: buildGeometry};

/** Insert a time interval into sparse channels. Existing key identities and all
 * original native frames remain editable. Only the connected tween runs whose
 * interpolation context changes get exact integer pose samples. One-frame and
 * hold-separated runs elsewhere keep their original sparse keys and sources. */
export function planAuthoredClipboard(editor, {frames, assets, index, nextFrameIdentity, append = false, trustedSource = false, authoringAppend = false}) {
  const report = editor.report, before = report._styk.animation;
  if (!before?.channels.length) return null;
  const rows = nativeTimeline(report), last = rows.at(-1);
  const at = index < rows.length ? rows[index].start : last ? last.start + report.keyframes.at(-1).duration_raw : 0;
  if (append && (index !== report.keyframes.length || before.channels.some(channel => channel.keys.some(key => key.tick >= at))))
    throw new Error('An appended pose must follow all existing animation keys.');
  let insertedTicks = 0;
  const entries = frames.map((frame, i) => {
    const count = index === report.keyframes.length && i === frames.length - 1 ? Math.min(1, frame.duration_raw) : frame.duration_raw;
    const entry = {frame, tick: at + insertedTicks, count}; insertedTicks += count; return entry;
  });
  if (at + insertedTicks > 10000000) throw new Error('Pasting these frames exceeds the ten-million-tick timeline limit.');
  for (const channel of before.channels) {
    const end = channel.keys.at(-1)?.tick;
    if (end >= at && end + insertedTicks > 10000000) throw new Error('Moving these animation keys exceeds the ten-million-tick timeline limit.');
  }
  const after = {...before, channels: [], nextKeyId: before.nextKeyId ?? 1}, sources = [], pending = new Map();
  const usedFrames = new Set([...report.keyframes, ...Object.values(report._styk.frameSources ?? {}), ...frames].map(frame => frame._styk?.frameId));
  let ticks = 0, objects = 0, values = 0;
  function budget(frame) {
    if (++ticks > MAX_TICKS) throw new Error('This paste needs more than 10,000 local interpolation samples. Paste a smaller frame interval.');
    objects += frame?.objects?.length ?? 0;
    for (const object of frame?.objects ?? []) values += (object.angles?.length ?? 0) + (object.lengths?.length ?? 0) + (object.bends?.length ?? 0);
    if (objects > MAX_OBJECTS || values > MAX_VALUES) throw new Error('This paste exceeds the local pose preservation budget. Paste into a shorter tween run.');
  }
  const keyIndexes = new WeakMap(), changedKeys = new Set();
  function key(channel, tick, value, interpolation = 'hold', extra = {}) {
    let lookup = keyIndexes.get(channel);
    if (!lookup) {
      lookup = {ticks: new Map(channel.keys.filter(value => !value.hidden).map(value => [value.tick, value])), ids: new Set(channel.keys.map(value => value.id))};
      keyIndexes.set(channel, lookup);
    }
    const existing = lookup.ticks.get(tick);
    if (existing && !extra.hidden) { Object.assign(existing, {value, ...extra}); assignKeyEasing(existing, {interpolation, ...(interpolation === "bezier" ? {bezier: extra.bezier ?? existing.bezier} : {})}); if (!extra.passthrough) delete existing.passthrough; changedKeys.add(existing); return existing; }
    let id;
    do {
      if (!Number.isSafeInteger(after.nextKeyId) || after.nextKeyId < 1) throw new Error('Animation key identity capacity exceeded.');
      id = `key-${after.nextKeyId++}`;
    } while (lookup.ids.has(id));
    const result = {id, tick, value, interpolation, ...extra}; channel.keys.push(result); lookup.ids.add(id); if (!extra.hidden) lookup.ticks.set(tick, result); changedKeys.add(result); return result;
  }
  function capturePose(channel, tick) {
    const cacheKey = `${channel.id}@${tick}`;
    if (pending.has(cacheKey)) return pending.get(cacheKey);
    const sampled = samplePoseTrack(report, channel, tick, context);
    if (!sampled) { pending.set(cacheKey, {frameId: null}); return {frameId: null}; }
    budget(sampled);
    const frame = clone({...sampled, objects: sampled.objects.map(({runtime_segments, ...object}) => object)});
    let id;
    do {
      if (!Number.isSafeInteger(nextFrameIdentity) || nextFrameIdentity < 1) throw new Error('Frame identity capacity exceeded.');
      id = `frame-${nextFrameIdentity++}`;
    } while (usedFrames.has(id));
    usedFrames.add(id); frame._styk = {...frame._styk, frameId: id}; frame.duration_raw = 1;
    sources.push({id, before: {exists: false}, after: {exists: true, value: frame}});
    const value = {frameId: id}; pending.set(cacheKey, value); return value;
  }
  // Key values/easing are immutable. Only the key record's time or interval
  // metadata changes; cloning every nested value costs hundreds of ms on large curves.
  const shift = original => ({...original, source: 'authored', keys: original.keys.map(value => ({...value, tick: value.tick >= at ? value.tick + insertedTicks : value.tick}))});
  function scalar(original) {
    const channel = shift(original), oldKeys = original.keys;
    if (!oldKeys.length || !insertedTicks) return channel;
    if (append && oldKeys.at(-1).tick < at && !oldKeys.some(value => easingMode(value) === 'auto' || value.nativeCurve)) {
      if(authoringAppend) {
        // A new authored frame continues the last property key's easing. A
        // clipboard insertion, below, deliberately isolates the pasted interval.
        const tail=oldKeys.at(-1);
        if(tail.tick<last.start)key(channel,last.start,clone(tail.value),tail.interpolation??'linear',tail.bezier?{bezier:tail.bezier}:{});
        return channel;
      }
      assignKeyEasing(channel.keys.at(-1), {interpolation: 'hold'});
      key(channel, at, clone(oldKeys.at(-1).value), 'hold', {passthrough: true});
      sorted(channel.keys); return channel;
    }
    const current = [...oldKeys].reverse().find(value => value.tick <= at);
    if (isColorAnimationProperty(original.property) || oldKeys.some(key => key.nativeCurve || ['auto','bezier','ease-in','ease-out'].includes(easingMode(key)))) {
      // ARGB channels round each component at each tick. Re-interpolating a
      // rounded split value can drift by one, so preserve this one color span.
      const previous = [...oldKeys].reverse().find(value => value.tick < at), next = oldKeys.find(value => value.tick >= at);
      const [left, right] = autoKeyRange(oldKeys, Math.max(0, oldKeys.indexOf(previous)), next ? oldKeys.indexOf(next) : oldKeys.length - 1);
      const start = Math.min(at, oldKeys[left].tick), end = Math.max(at, oldKeys[right].tick);
      if (end - start > MAX_TICKS) throw new Error('This paste needs more than 10,000 color samples. Split the color tween before pasting.');
      for (let tick = start; tick < end; tick++) {
        const value = sampleAnimationChannel(original, tick);
        if (value !== undefined) { budget(); key(channel, tick >= at ? tick + insertedTicks : tick, value); }
      }
    } else if (at > 0) {
      const value = sampleAnimationChannel(original, at - 1);
      if (value !== undefined) key(channel, at - 1, value);
    }
    const resume = sampleAnimationChannel(original, at), placeholder = current?.value ?? oldKeys[0].value;
    key(channel, at, clone(placeholder), 'hold', {passthrough: true});
    const existingResume = channel.keys.find(value => value.tick === at + insertedTicks && !value.hidden);
    if (!existingResume || insertedTicks === 0) key(channel, at + insertedTicks, clone(resume === undefined ? placeholder : resume), current?.interpolation ?? 'hold', {...(current?.bezier ? {bezier: clone(current.bezier)} : {}), ...(resume === undefined ? {passthrough: true} : {})});
    sorted(channel.keys); return channel;
  }
  function pose(original) {
    const channel = shift(original), oldKeys = sorted(original.keys.slice());
    if (!insertedTicks) {
      if (!oldKeys.length) key(channel, 0, {frameId: null});
      return channel;
    }
    const heldTail = append && oldKeys.length && oldKeys.at(-1).tick < at &&
      !report.auto_easing && !oldKeys.some(value => easingMode(value) === 'auto');
    if (heldTail) assignKeyEasing(channel.keys.at(-1), {interpolation: 'hold'});
    if (oldKeys.length && insertedTicks && !heldTail) {
      let left = -1;
      for (let i = 0; i < oldKeys.length; i++) if (oldKeys[i].tick < at) left = i;
      let right = oldKeys.findIndex(value => value.tick >= at);
      if (left >= 0) {
        if (right < 0) right = left;
        [left, right] = autoKeyRange(oldKeys, left, right);
        // Native automatic easing walks exactly these >1-frame connected runs.
        // Keep whole affected runs, including the endpoint samples, so adding
        // boundary keys never perturbs a neighbouring Hermite tangent.
        if (report.auto_easing) {
          while (left > 0 && oldKeys[left].tick - oldKeys[left - 1].tick > 1) left--;
          while (right < oldKeys.length - 1 && oldKeys[right + 1].tick - oldKeys[right].tick > 1) right++;
        }
        const start = oldKeys[left].tick, end = Math.max(at, oldKeys[right].tick);
        if (end - start > MAX_TICKS) throw new Error('This paste needs more than 10,000 local pose samples. Split the connected tween run before pasting.');
        const visibleKeys = new Map(oldKeys.filter(value => !value.hidden).map(value => [value.tick, value]));
        for (let tick = start; tick <= end; tick++) {
          const targetTick = tick >= at ? tick + insertedTicks : tick;
          const existing = visibleKeys.get(tick); if (existing) budget();
          key(channel, targetTick, existing ? clone(existing.value) : capturePose(original, tick), tick === end ? existing?.interpolation ?? 'hold' : 'hold', tick === end && existing?.bezier ? {bezier: clone(existing.bezier)} : {});
        }
      }
    }
    if (insertedTicks) {
      const resumeTick = at + insertedTicks;
      if (!append && !channel.keys.some(value => value.tick === resumeTick && !value.hidden)) key(channel, resumeTick, capturePose(original, at));
      for (const entry of entries) key(channel, entry.tick, {frameId: entry.frame._styk.frameId},
        entry.frame._styk?.easing?.interpolation ?? (report.version >= 5 ? 'linear' : 'hold'), {...(entry.frame._styk?.easing?.bezier ? {bezier: clone(entry.frame._styk.easing.bezier)} : {}), ...(entry.count ? {} : {hidden: true})});
      // The last inserted pose should finish inside the inserted interval. A
      // hold endpoint prevents it from tweening into the resumed destination.
      const tail = entries.findLast(entry => entry.count > 0);
      if (tail && tail.count > 1) key(channel, resumeTick - 1, {frameId: tail.frame._styk.frameId});
    }
    sorted(channel.keys); return channel;
  }
  const originalPoses = new Map(before.channels.filter(channel => channel.property === 'pose').map(channel => [channel.id, channel]));
  for (const original of before.channels) if (original.property !== 'pose') {
    const channel=scalar(original);
    if(editor.propertyChannels)for(const entry of entries)if(entry.count) {
      let value=animationPropertyValue(report,entry.frame,channel.target,channel.property,{resolveGeometry:buildGeometry});
      if(channel.target.kind==='scene'&&channel.property==='color')value=entry.frame._stykBackgroundColor ?? report.backgrounds?.find(bg=>bg.background_id===entry.frame.background_id&&bg.kind===2)?.color ?? (entry.frame.background_id ? null : 0xffffffff);
      if(value!==undefined) {
        const easing=authoringAppend?keyEasing(original.keys.at(-1)??{interpolation:'linear'}):entry.frame._styk?.easing??{interpolation:'hold'};
        key(channel,entry.tick,value,isDiscreteAnimationProperty(channel.property)?'hold':easing.interpolation??'linear',easing.bezier?{bezier:easing.bezier}:{});
      }
    }
    sorted(channel.keys);after.channels.push(channel);
  }
  // Native destination layers need a pose track too: otherwise previously
  // authored figures can remain visible over the inserted foreign scene.
  // A native final frame has one displayed tick. A plain append cannot alter
  // earlier native samples, so native tracks can stay native. Avoid allocating
  // scene/camera/layer keys for the entire movie merely to append one pose.
  const nativeAppend = append && !report.auto_easing &&
    before.channels.every(channel => !channel.keys.length || channel.keys.at(-1).tick <= (last?.start ?? 0)) &&
    !report.keyframes.some(frame => frame._styk?.easing?.interpolation === 'auto');
  const targets = nativeAppend ? [] : [...report._styk.layers.order.map(id => ({kind: 'layer', id})), {kind: 'scene'}, {kind: 'camera'}];
  for (const target of targets) {
    const id = animationChannelId(target, 'pose'), original = originalPoses.get(id) ?? editor.nativePoseChannel(target);
    after.channels.push(pose(original)); originalPoses.delete(id);
  }
  // Appending can extend beyond the native final frame while authored channels
  // continue. Explicit blank endpoints keep the pasted actors from leaking into
  // that resumed tail just because the native final frame is still held.
  for (const layer of assets.layers.additions) {
    const target = {kind: 'layer', id: layer.id}, id = animationChannelId(target, 'pose');
    after.channels.push(pose({id, target, property: 'pose', source: 'authored', keys: []}));
  }
  for (const original of originalPoses.values()) after.channels.push(pose(original));
  if (append) for (const channel of after.channels) channel.keys = channel.keys.filter(key => key.tick < at + insertedTicks);
  const prior = new Map(before.channels.map((channel, index) => [channel.id, {exists: true, index, channel}]));
  const next = new Map(after.channels.map((channel, index) => [channel.id, {exists: true, index, channel}]));
  const metadata = animation => { const {channels, ...fields} = animation; return {exists: true, fields}; };
  const patch = {before: metadata(before), after: metadata(after), changes: [...new Set([...prior.keys(), ...next.keys()])]
    .map(id => ({id, before: prior.get(id) ?? {exists: false}, after: next.get(id) ?? {exists: false}}))};
  const preview = {...report, keyframes: [...report.keyframes.slice(0, index), ...frames, ...report.keyframes.slice(index)],
    _styk: {...report._styk, animation: after, frameSources: {...report._styk.frameSources, ...Object.fromEntries(sources.map(change => [change.id, change.after.value]))}}};
  if (trustedSource) {
    // The editor has already validated the input. A uniform time shift keeps
    // existing order, IDs, values, and references valid; key() replaces occupied
    // visible ticks and allocates collision-free IDs. Validate new/changed keys
    // and the complete resulting table/key limits without rescanning every curve.
    if (after.channels.reduce((sum, channel) => sum + channel.keys.length, 0) > 1000000)
      throw new Error('Authored animation exceeds the one-million-key limit.');
    validateAnimationDocument({...preview, _styk: {...preview._styk, animation: {...after,
      channels: after.channels.map(channel => ({...channel, keys: channel.keys.filter(key => changedKeys.has(key))}))}}});
  } else validateAnimationDocument(preview);
  return {after, patch, frameSourceChanges: sources, nextFrameIdentity, sampledTicks: ticks, insertedTicks, at};
}
