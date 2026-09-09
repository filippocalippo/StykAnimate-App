/** Independent layer poses reference native frames; pose channels never copy the
 * entire imported animation or replace unaffected layers with a baked movie. */
import {keyEasing} from './keyframe-easing.mjs';
import { layerIdForUid } from './layers.mjs';
import {animationOriginHandleOrientation} from './animation-origin.mjs';
import {rotateOriginSupport} from './animation-origin-support.mjs';
const tracks = new WeakMap();
const sourceIndices = new WeakMap();
const SCENE_FIELDS = ['background_id', 'background_id_b', 'background_mix', 'background_color', '_stykBackgroundColor'];

function blankPoseFrame(template) {
  const {background_color, _stykBackgroundColor, ...fields} = template || {};
  return {...fields, objects: [], object_count: 0, object_draw_order: [], object_draw_order_unique_ids: [],
    background_id: 0, background_id_b: 0, background_mix: 0,
    camera: {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0}};
}

export function invalidatePoseCache(report) {
  if (report) { tracks.delete(report); sourceIndices.delete(report); }
}

export function poseSourceFrame(report, id) {
  if (id === null || id === undefined) return null;
  const sources = report._styk?.frameSources;
  const retained = sources && Object.hasOwn(sources, id) ? sources[id] : null;
  if (retained) return retained;
  const frames = report.keyframes || [];
  let index = sourceIndices.get(report);
  const candidate = index?.ids.get(id);
  if (!index || index.frames !== frames || index.length !== frames.length ||
      (candidate !== undefined && frames[candidate]?._styk?.frameId !== id)) {
    index = { frames, length: frames.length, ids: new Map() };
    frames.forEach((frame, i) => { if (frame._styk?.frameId) index.ids.set(frame._styk.frameId, i); });
    sourceIndices.set(report, index);
  }
  const slot = index.ids.get(id);
  return slot === undefined ? null : frames[slot];
}

/** Wrappers retain native topology/assets/unknown fields and native easing, while
 * their new durations express actual chosen poses. Deleting a key therefore
 * removes its influence rather than merely hiding a marker on a time-warp. */
export function buildVirtualPoseTrack(report, channel, { resolveFrame } = {}) {
  let cache = tracks.get(report);
  if (!cache) tracks.set(report, cache = new WeakMap());
  const cached = cache.get(channel);
  if (cached?.keys === channel.keys) return cached;
  const keys = [...(channel.keys || [])].sort((a, b) => a.tick - b.tick || Number(Boolean(b.hidden)) - Number(Boolean(a.hidden)));
  const lookup = resolveFrame || (id => poseSourceFrame(report, id));
  const fixed = channel.target?.kind === 'camera' || channel.target?.kind === 'scene';
  const frames = keys.map((key, i) => {
    const blank = key.value === null || key.value?.frameId === null;
    const source = blank ? null : lookup(key.value?.frameId);
    if (!blank && !source) throw new Error(`The pose source for key ${key.id} is missing.`);
    const next = keys[i + 1];
    return {
      ...(source || blankPoseFrame(report.keyframes[0])),
      _styk: {...source?._styk, easing: key.interpolation === undefined ? source?._styk?.easing : keyEasing(key)},
      duration_raw: key.hidden ? 0 : next ? Math.max(0, next.tick - key.tick) : 1,
      // Fixed tracks need only their own fields. Sampling them must not evaluate
      // every figure again just to obtain a camera or background value.
      ...(fixed ? {objects: [], object_count: 0, object_draw_order: [], object_draw_order_unique_ids: []} : {}),
    };
  });
  const virtual = { ...report, keyframes: frames };
  // The callback uses the native evaluator. Dropping authored metadata also
  // keeps a caller's timeline helper from extending this local pose track.
  if (virtual._styk) { virtual._styk = { ...virtual._styk }; delete virtual._styk.animation; }
  const value = { keys: channel.keys, orderedKeys: keys, report: virtual, frames };
  cache.set(channel, value);
  return value;
}

export function samplePoseTrack(report, channel, tick, options) {
  const track = buildVirtualPoseTrack(report, channel, options), keys = track.orderedKeys;
  if (!keys.length || tick < keys[0].tick) return null;
  let low = 0, high = keys.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (keys[mid].tick <= tick) low = mid; else high = mid - 1; }
  const current = keys[low], next = keys[low + 1];
  const fraction = !next || next.tick <= current.tick
    ? 0 : Math.max(0, Math.min(1, (tick - current.tick) / (next.tick - current.tick)));
  return options.sampleNative(track.report, low, fraction);
}

function layerId(report, uid) {
  return layerIdForUid(report, uid);
}

function orderedObjects(frame) {
  const objects = frame?.objects || [], seen = new Set(), ordered = [];
  for (const slot of frame?.object_draw_order || []) if (objects[slot] && !seen.has(slot)) { seen.add(slot); ordered.push(objects[slot]); }
  objects.forEach((object, slot) => { if (!seen.has(slot)) ordered.push(object); });
  return ordered;
}

function handleOrientation(object, handle, definitions, handleIndices) {
  const figure = definitions.get(object?.figure_type_id);
  if (!figure) return null;
  if (figure._styk?.animationOrigin) return animationOriginHandleOrientation(figure, object, handle);
  let indices = handleIndices.get(figure);
  if (!indices) { indices = new Map(figure.segments.map((segment, index) => [segment.segment_id, index])); handleIndices.set(figure, indices); }
  const index = handle === 0 ? 0 : indices.get(handle) ?? -1;
  if (index < 0) return null;
  const segment = figure.segments[index];
  return Number(object.angles?.[index] ?? segment.angle_rad ?? 0) +
    (handle === 0 ? 0 : Number(object.bend_flag ? object.bends?.[index] ?? 0 : segment.bend_rad ?? 0));
}

/** Compose independently sampled figure sets and resolve native joins by UID,
 * never by stale object slots. Sampling a layer can add/remove figures. */
export function composePoseChannels(report, baseFrame, tick, options = {}) {
  const channels = (report._styk?.animation?.channels || []).filter(channel => channel.property === 'pose');
  if (!channels.length || !baseFrame) return baseFrame;
  if (typeof options.sampleNative !== 'function') throw new Error('Pose channels require the native frame evaluator.');
  let result = baseFrame;
  const replacements = new Map();
  const figureReplacements = new Set(channels.filter(channel => channel.target.kind === 'figure').map(channel => channel.target.uid));
  const owner = uid => figureReplacements.has(uid) ? `figure:${uid}` : layerId(report, uid);
  for (const channel of channels) {
    const sampled = samplePoseTrack(report, channel, tick, options) || blankPoseFrame(baseFrame);
    const kind = channel.target?.kind;
    if (kind === 'layer') replacements.set(channel.target.id, sampled);
    else if (kind === 'figure') replacements.set(`figure:${channel.target.uid}`, sampled);
    else if (kind === 'camera') result = { ...result, camera: { ...(sampled.camera || { is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0 }) } };
    else if (kind === 'scene') {
      result = { ...result };
      for (const field of SCENE_FIELDS) { if (field in sampled) result[field] = sampled[field]; else delete result[field]; }
    }
  }
  if (!replacements.size) return result;
  const records = [], included = new Set();
  // Retain base slot order for unchanged instances; new appearances are appended
  // in source paint order. Layer ordering is applied after this composition.
  for (const object of baseFrame.objects) {
    const sampled = replacements.get(owner(object.unique_id));
    if (!sampled) { records.push({ object, source: baseFrame }); included.add(object.unique_id); }
  }
  for (const [id, sampled] of replacements) for (const object of orderedObjects(sampled)) {
    if (owner(object.unique_id) !== id || included.has(object.unique_id)) continue;
    records.push({ object, source: sampled }); included.add(object.unique_id);
  }
  const slots = new Map(records.map(({ object }, slot) => [object.unique_id, slot]));
  const definitions = new Map(report.figure_types.map(figure => [figure.figure_type_id, figure]));
  const geometry = new WeakMap(), handleIndices = new Map();
  const worldRoot = record => {
    if (typeof options.resolveGeometry !== 'function') throw new Error('A disappearing joined parent requires native geometry resolution.');
    let resolved = geometry.get(record.source);
    if (!resolved) geometry.set(record.source, resolved = {
      geometry: options.resolveGeometry(report, record.source),
      slots: new Map(record.source.objects.map((object, slot) => [object, slot])),
    });
    const sourceSlot = resolved.slots.get(record.object);
    return resolved.geometry.objects.get(sourceSlot)?.root || { x: record.object.root_x, y: record.object.root_y };
  };
  const objects = records.map((record, slot) => {
    const object = record.object;
    if (!object.join) return object.object_slot === slot ? object : { ...object, object_slot: slot };
    const parent = record.source.objects[object.join.target_object_slot], parentSlot = slots.get(parent?.unique_id);
    const targetHandle = object.join.target_handle_id;
    const target = parentSlot === undefined ? null : records[parentSlot].object;
    if (parentSlot === undefined || handleOrientation(target, targetHandle, definitions, handleIndices) === null) {
      const root = worldRoot(record);
      return { ...object, object_slot: slot, root_x: root.x, root_y: root.y, join: null, runtime_segments: undefined };
    }
    return { ...object, object_slot: slot, join: { ...object.join, target_object_slot: parentSlot } };
  });
  // Resolve parent-before-child without recursion for very deep native rigs.
  // Independent retiming cannot introduce a silent cyclic skeleton.
  const done = new Set();
  for (let start = 0; start < objects.length; start++) {
    if (done.has(start)) continue;
    const path = [], visiting = new Set(); let slot = start;
    while (!done.has(slot)) {
      if (visiting.has(slot)) throw new Error('These layer poses create a cyclic figure attachment.');
      visiting.add(slot); path.push(slot);
      const parent = objects[slot].join?.target_object_slot;
      if (parent === undefined) break;
      slot = parent;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const childSlot = path[i], child = objects[childSlot];
      if (child.join) {
        const source = records[childSlot], sourceParent = source.source.objects[source.object.join.target_object_slot];
        const parent = objects[child.join.target_object_slot], handle = child.join.target_handle_id;
        const before = handleOrientation(sourceParent, handle, definitions, handleIndices), after = handleOrientation(parent, handle, definitions, handleIndices);
        const delta = before === null || after === null ? 0 : after - before;
        if (Math.abs(delta) > 1e-12) {
          const rotated = {...child, angles: child.angles.map(angle => angle + delta), runtime_segments: undefined};
          rotateOriginSupport(definitions.get(child.figure_type_id), rotated, delta);
          objects[childSlot] = rotated;
        }
      }
      done.add(childSlot);
    }
  }
  // Each layer owns its sampled pose's internal stacking order. Native baseline
  // order is relevant only to layers whose pose track was not replaced.
  const order = [], ordered = new Set(), emittedLayers = new Set();
  const append = object => {
    const slot = slots.get(object.unique_id);
    if (slot !== undefined && !ordered.has(slot)) { order.push(slot); ordered.add(slot); }
  };
  const appendLayer = id => {
    if (emittedLayers.has(id)) return;
    emittedLayers.add(id);
    for (const object of orderedObjects(replacements.get(id)))
      if (owner(object.unique_id) === id) append(object);
  };
  for (const object of orderedObjects(baseFrame)) {
    const id = owner(object.unique_id);
    if (replacements.has(id)) appendLayer(id); else append(object);
  }
  for (const id of replacements.keys()) appendLayer(id);
  objects.forEach((_, slot) => { if (!ordered.has(slot)) order.push(slot); });
  return { ...result, objects, object_count: objects.length, object_draw_order: order,
    object_draw_order_unique_ids: order.map(slot => objects[slot].unique_id) };
}
