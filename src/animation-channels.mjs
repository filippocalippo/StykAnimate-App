/** Sparse authored channels overlay the untouched native Pivot animation. */
import {isAnimationStyleProperty, animationStyleValue, setAnimationStyle} from './animation-style.mjs';
import {animationRotation, animationOriginOffset, correctAnimationOrigins} from './animation-origin.mjs';
import {rotateOriginSupport} from './animation-origin-support.mjs';
import {normalizePaint} from './paint.mjs';
import {sampleNativePropertyCurve, shortestPropertyAngle} from './native-property-curve.mjs';
import {validateKeyEasing, easedProgress, easingMode, autoValue} from './keyframe-easing.mjs';
import {ANIMATION_PROPERTIES, isDiscreteAnimationProperty, isColorAnimationProperty, validateFigureZIndex} from './animation-properties.mjs';
const properties = Object.fromEntries(Object.entries(ANIMATION_PROPERTIES).map(([kind, values]) => [kind, new Set(values)]));
export function normalizeAnimationTarget(target) {
  if (!target || !properties[target.kind]) throw new Error('Choose a figure, segment, layer, camera, or scene animation target.');
  if (target.figureTypeId !== undefined && !['segment','polygon'].includes(target.kind)) throw new Error('Only segment and polygon animation can be scoped to a figure definition.');
  if (target.kind === 'polygon') {
    if (!Number.isInteger(target.uid) || target.uid < 0 || !Number.isInteger(target.polygonId) || target.polygonId < 1 || target.polygonId > 65535 || !Number.isSafeInteger(target.figureTypeId) || target.figureTypeId < 1)
      throw new Error('Polygon animation requires a figure UID, polygon identity, and figure definition identity.');
    return {kind:'polygon', uid:target.uid, polygonId:target.polygonId, figureTypeId:target.figureTypeId};
  }
  if (target.kind === 'figure' || target.kind === 'segment') {
    if (!Number.isInteger(target.uid) || target.uid < 0) throw new Error('Figure animation requires a native figure identity.');
    if (target.kind === 'segment') {
      if (!Number.isInteger(target.handleId) || target.handleId < 1 || target.handleId > 65535) throw new Error('Segment animation requires a native segment handle identity.');
      if (target.figureTypeId !== undefined && (!Number.isSafeInteger(target.figureTypeId) || target.figureTypeId < 1)) throw new Error('Segment animation scope requires a positive native figure definition identity.');
      return {kind: 'segment', uid: target.uid, handleId: target.handleId,
        ...(target.figureTypeId === undefined ? {} : {figureTypeId: target.figureTypeId})};
    }
    return {kind: 'figure', uid: target.uid};
  }
  if (target.kind === 'layer') {
    if (typeof target.id !== 'string' || !target.id || target.id.length > 256) throw new Error('Layer animation requires a layer identity.');
    return {kind: 'layer', id: target.id};
  }
  return {kind: target.kind};
}
export function animationChannelId(target, property) {
  target = normalizeAnimationTarget(target);
  if (!properties[target.kind].has(property)) throw new Error(`Property ${property} cannot animate on ${target.kind}.`);
  const identity = target.kind === 'polygon' ? `${target.uid}/${target.polygonId}@${target.figureTypeId}` : target.kind === 'segment' ? `${target.uid}/${target.handleId}${target.figureTypeId === undefined ? '' : `@${target.figureTypeId}`}` : target.uid ?? target.id ?? '';
  return `${target.kind}:${encodeURIComponent(identity)}:${property}`;
}
export function validateAnimationValue(target, property, value) {
  animationChannelId(target, property);
  if (property === 'paint') return normalizePaint(value);
  if (property === 'pose') {
    if (value === null) return {frameId: null};
    if (!value || !(value.frameId === null || typeof value.frameId === 'string' && value.frameId.length > 0)) throw new Error('A pose key must reference a native frame identity or a blank pose.');
    return {frameId: value.frameId};
  }
  if (target.kind === 'scene' && property === 'color' && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Animation values must be finite numbers.');
  if (property === 'zIndex') return validateFigureZIndex(value);
  if (property === 'scale' && (value < (target.kind === 'camera' ? 0.000001 : 0) || value > 1e6)) throw new Error('Animation scale is outside the supported range.');
  if (['opacity', 'outlineOpacity', 'gradientOpacity'].includes(property) && (value < 0 || value > 1)) throw new Error('Animation opacity must be between zero and one.');
  if (property === 'backgroundId' && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) throw new Error('Choose a valid background identity.');
  if (isColorAnimationProperty(property) && (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) throw new Error('Color must be a 32-bit color.');
  if (isColorAnimationProperty(property) && (target.kind === 'segment' || target.kind === 'polygon' || property === 'outlineColor') && value > 0xffffff) throw new Error('Style colors use RGB; opacity has its own channel.');
  if (['outlineWidth', 'thickness'].includes(property) && (value < 0 || value > 1e6)) throw new Error('Width must be between zero and 1,000,000.');
  return value;
}
const EMPTY_CHANNELS = Object.freeze([]), channelIndices = new WeakMap();
export function animationChannels(report) { return report?._styk?.animation?.channels ?? EMPTY_CHANNELS; }
export function findAnimationChannel(report, target, property) {
  const channels = animationChannels(report); let index = channelIndices.get(channels);
  if (!index) { index = new Map(channels.map(channel => [channel.id, channel])); channelIndices.set(channels, index); }
  return index.get(animationChannelId(target, property)) ?? null;
}
export function validateAnimationDocument(report) {
  const steps = validateAnimationDocumentSteps(report);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
/** Cooperative validation never mutates its document; callers may cancel between checkpoints. */
export function* validateAnimationDocumentSteps(report) {
  let scanned = 0;
  for (const frame of report.keyframes ?? []) {
    if (frame._styk?.easing) validateKeyEasing(frame._styk.easing);
    if (++scanned % 256 === 0) yield {phase: 'animation', frames: scanned};
  }
  for (const id in report._styk?.frameSources ?? {}) {
    const frame = report._styk.frameSources[id];
    if (frame._styk?.easing) validateKeyEasing(frame._styk.easing);
    if (++scanned % 256 === 0) yield {phase: 'animation', frames: scanned};
  }
  const animation = report?._styk?.animation; if (animation == null) return report;
  if (animation.version !== 1 || !Array.isArray(animation.channels) || animation.channels.length > 100000) throw new Error('Invalid authored animation channel table.');
  if (animation.nextKeyId !== undefined && (!Number.isSafeInteger(animation.nextKeyId) || animation.nextKeyId < 1)) throw new Error('Invalid animation key identity counter.');
  const channels = new Set(), validatedPoses = new WeakSet(); let keyCount = 0, sourceIds, figureTypeIds, visited = 0;
  for (const channel of animation.channels) {
    if (channel.id !== animationChannelId(channel.target, channel.property) || channels.has(channel.id) || !Array.isArray(channel.keys)) throw new Error('Animation channels must have unique stable identities.');
    if (channel.nativeProperties !== undefined && (channel.nativeProperties !== true || channel.property !== 'pose' || !['figure','layer'].includes(channel.target.kind)))
      throw new Error('Native property inheritance is only valid on figure and layer pose channels.');
    if(channel.maskedRanges!==undefined && (channel.property!=='pose' || channel.target.kind!=='figure' || !Array.isArray(channel.maskedRanges) || channel.maskedRanges.length>100000 || channel.maskedRanges.some((range,i)=>
      !Array.isArray(range)||range.length!==2||!Number.isInteger(range[0])||range[0]<0||!Number.isInteger(range[1])||range[1]<=range[0]||range[1]>10000001||i>0&&range[0]<=channel.maskedRanges[i-1][1])))
      throw new Error('Invalid pose visibility ranges.');
    if(channel.useBasePose!==undefined && (channel.useBasePose!==true||channel.property!=='pose'||channel.target.kind!=='figure'))throw new Error('Invalid native pose passthrough.');
    if(channel.orderAnchor!==undefined && (channel.property!=='pose'||channel.target.kind!=='figure'||!Number.isInteger(channel.orderAnchor)||channel.orderAnchor<0||channel.orderAnchor>0xffffffff||channel.orderAnchor===channel.target.uid))throw new Error('Invalid pose stacking anchor.');
    if (channel.target.figureTypeId !== undefined) {
      if (!figureTypeIds) {
        figureTypeIds = new Set();
        for (const figure of report.figure_types ?? []) {
          figureTypeIds.add(figure.figure_type_id);
          if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
        }
      }
      if (!figureTypeIds.has(channel.target.figureTypeId)) throw new Error(`Animation segment scope references missing figure definition ${channel.target.figureTypeId}.`);
    }
    if(channel.movieclipCurve!==undefined&&(channel.movieclipCurve!==true||!['figure','segment','polygon'].includes(channel.target.kind)))throw new Error('Invalid movieclip curve context.');
    if(channel.clipEnd!==undefined&&(channel.property!=='pose'||channel.target.kind!=='figure'||!Number.isInteger(channel.clipEnd)||channel.clipEnd<0||channel.clipEnd>10000001))throw new Error('Invalid movieclip end.');
    if(channel.movieclipPart!==undefined&&(channel.property!=='pose'||channel.target.kind!=='figure'||!Number.isInteger(channel.movieclipPart?.instance)||channel.movieclipPart.instance<0||channel.movieclipPart.instance>0xffffffff||typeof channel.movieclipPart.path!=='string'||channel.movieclipPart.path.length>1024))throw new Error('Invalid expanded movieclip identity.');
    if(channel.keys[0]?.tick<0&&!channel.movieclipCurve)throw new Error('Only movieclip curves can retain keys before the scene.');
    channels.add(channel.id); const ids = new Set(), occupied = new Set(); let previous = channel.movieclipCurve?-10000000:-1;
    if (channel.property === 'pose' && validatedPoses.has(channel.keys)) {
      if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
      continue;
    }
    for (const key of channel.keys) {
      if (++keyCount > 1000000) throw new Error('Authored animation exceeds the one-million-key limit.');
      if (typeof key.id !== 'string' || !key.id || ids.has(key.id)) throw new Error('Animation keys must have unique stable identities.');
      if (!Number.isInteger(key.tick) || key.tick < (channel.movieclipCurve?-10000000:0) || key.tick > 10000000 || key.tick < previous) throw new Error('Animation keys must be sorted at valid whole-frame times.');
      if (key.hidden && channel.property !== 'pose') throw new Error('Only native pose keys can be hidden.');
      if (key.passthrough !== undefined && (typeof key.passthrough !== 'boolean' || channel.property === 'pose')) throw new Error('Only scalar keys support a boolean passthrough interval.');
      if (key.nativeCurve !== undefined && (key.nativeCurve !== 'pchip' || !['x','y','scale','rotation'].includes(channel.property))) throw new Error('Invalid native property curve.');
      if (key.nativeRotation !== undefined && (key.nativeRotation !== true || channel.property !== 'rotation')) throw new Error('Invalid native rotation curve.');
      if (key.nativeValueMode !== undefined && (channel.target.kind !== 'figure' || !['color','opacity'].includes(key.nativeValueMode) || key.nativeValueMode !== channel.property)) throw new Error('Invalid native property sampling mode.');
      if (!key.hidden && occupied.has(key.tick)) throw new Error('Multiple property keys occupy the same frame.');
      if (!key.hidden) occupied.add(key.tick); ids.add(key.id); previous = key.tick;
      // Older documents may label background holds as linear. Preserve their
      // read compatibility; newly introduced depth tracks require explicit holds.
      validateKeyEasing(key, channel.property === 'zIndex' ? channel.property : undefined);
      validateAnimationValue(channel.target, channel.property, key.value);
      if (channel.property === 'pose' && key.value?.frameId != null) {
        if (!sourceIds) {
          sourceIds = new Set();
          for (const frame of report.keyframes ?? []) {
            const id = frame._styk?.frameId; if (id) sourceIds.add(id);
            if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
          }
          const retained = report._styk?.frameSources ?? {};
          for (const id in retained) {
            if (Object.hasOwn(retained,id)) sourceIds.add(id);
            if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
          }
        }
        if (!sourceIds.has(key.value.frameId)) throw new Error(`Animation pose references missing source frame ${key.value.frameId}.`);
      }
      if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
    }
    if (channel.property === 'pose') validatedPoses.add(channel.keys);
    if (++visited % 256 === 0) yield {phase:'animation',channels:channels.size,keys:keyCount};
  }
  return report;
}
export function animationEndTick(report) {
  let end = 0;
  for (const channel of animationChannels(report)) if (channel.keys?.length) {
    const keys = channel.keys, tick = keys.at(-1).tick;
    let visible = false;
    // Imported authoring files may place coincident hidden references after a
    // visible key. Every visible key still owns its final display frame.
    for (let i = keys.length - 1; i >= 0 && keys[i].tick === tick; i--) if (!keys[i].hidden) { visible = true; break; }
    end = Math.max(end, channel.clipEnd??0, tick + (visible ? 1 : 0));
  }
  return end;
}
export function sampleAnimationChannel(channel, tick) {
  const keys = channel?.keys;
  if (!keys?.length || tick < keys[0].tick) return undefined;
  let low = 0, high = keys.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (keys[mid].tick <= tick) low = mid; else high = mid - 1; }
  const a = keys[low], b = keys[low + 1];
  if (a.passthrough) return undefined;
  if (b?.passthrough) return a.value;
  if (!b || a.tick === tick || channel.property === 'pose' || isDiscreteAnimationProperty(channel.property)) return a.value;
  const fraction = (tick - a.tick) / (b.tick - a.tick), auto = easingMode(a) === 'auto';
  const t = auto ? fraction : easedProgress(a, fraction);
  if (a.nativeCurve === 'pchip') return sampleNativePropertyCurve(keys,low,t,a.nativeRotation);
  const value = get => {
    if (!auto) return get(a) + (get(b) - get(a)) * t;
    const previous = keys[low - 1], following = keys[low + 2];
    const neighbour = (key, duration) => key && !key.passthrough && key.value !== null ? {value: get(key), duration} : undefined;
    return autoValue(get(a), get(b), t, b.tick - a.tick,
      easingMode(previous) === 'auto' ? neighbour(previous, a.tick - previous.tick) : undefined,
      easingMode(b) === 'auto' ? neighbour(following, following?.tick - b.tick) : undefined);
  };
  if (isColorAnimationProperty(channel.property)) {
    // Null explicitly returns control to the Scene background track; it is not
    // an ARGB zero and cannot be numerically interpolated into a solid color.
    if (a.value === null || b.value === null) return a.value;
    if (a.nativeValueMode === 'color' && !auto) {
      const am=a.value>>>24,bm=b.value>>>24;if(!am&&!bm)return a.value;
      let color=0;
      for(let shift=0;shift<32;shift+=8) {
        let av=a.value>>>shift&255,bv=b.value>>>shift&255;
        if(shift<24){if(!am)av=bv;if(!bm)bv=av;}
        color|=(av+Math.trunc((bv-av)*t))<<shift;
      }
      return color>>>0;
    }
    let out = 0;
    for (let shift = 0; shift < 32; shift += 8) out |= Math.round(value(key => (key.value >>> shift) & 255)) << shift;
    return out >>> 0;
  }
  if(a.nativeValueMode === 'opacity' && !auto) {
    const av=Math.round((1-a.value)*255),bv=Math.round((1-b.value)*255);
    return 1-(av+Math.trunc((bv-av)*t))/255;
  }
  if(a.nativeRotation) {
    const end=a.value+shortestPropertyAngle(b.value-a.value);
    if(!auto)return a.value+(end-a.value)*t;
    const previous=keys[low-1],following=keys[low+2];
    return autoValue(a.value,end,t,b.tick-a.tick,
      previous && easingMode(previous)==='auto' ? {value:a.value-shortestPropertyAngle(a.value-previous.value),duration:a.tick-previous.tick} : undefined,
      following && easingMode(b)==='auto' ? {value:end+shortestPropertyAngle(following.value-b.value),duration:following.tick-b.tick} : undefined);
  }
  return value(key => key.value);
}

/** Read a property from an already evaluated frame (used for diamonds and controls). */
export function animationPropertyValue(report, frame, target, property, {resolveGeometry, objectIndex, figureIndex} = {}) {
  animationChannelId(target, property);
  if (property === 'pose') throw new Error('Pose keys reference source frames, not scalar property values.');
  if (target.kind === 'camera') return frame.camera?.[property === 'rotation' ? 'angle_rad' : property] ?? (property === 'scale' ? 1 : 0);
  if (target.kind === 'scene') {
    if (property === 'backgroundId') return frame.background_id ?? 0;
    return frame._stykBackgroundColor ?? report.backgrounds?.find(bg => bg.background_id === frame.background_id && bg.kind === 2)?.color ?? 0xffffffff;
  }
  const slot = objectIndex ? objectIndex.get(target.uid) ?? -1 : frame.objects.findIndex(object => object.unique_id === target.uid), object = frame.objects[slot];
  if (!object) return undefined;
  if (target.kind === 'figure' && property === 'color') return Number(object.color_override_raw ?? 0) >>> 0;
  if (property === 'zIndex') return object._stykZIndex ?? 0;
  const definition=()=>figureIndex?figureIndex.get(object.figure_type_id):report.figure_types.find(figure => figure.figure_type_id === object.figure_type_id);
  if (isAnimationStyleProperty(target, property)) return animationStyleValue(definition(), object, target, property);
  if (property === 'opacity') return 1 - Number(object.field28 ?? 0) / 255;
  if (property === 'rotation') {
    const figure = definition();
    return animationRotation(figure, object);
  }
  if (property === 'x' || property === 'y') {
    const world = object.join && resolveGeometry ? resolveGeometry(report, frame)?.objects.get(slot)?.root : null;
    if (object._stykAnimationOrigin) {
      if (!world) return object._stykAnimationOrigin[property];
      const figure = definition();
      return world[property] + animationOriginOffset(figure, object)[property];
    }
    return world?.[property] ?? object[property === 'x' ? 'root_x' : 'root_y'];
  }
  return object[property];
}

/** Apply scalar channels after per-layer pose composition; unchanged frames retain identity. */
export function composeAnimationChannels(report, frame, tick, {resolveGeometry} = {}) {
  const channels = animationChannels(report); if (!frame || !channels.length) return frame;
  const active = channels.filter(channel => channel.property !== 'pose').map(channel => ({channel, value: sampleAnimationChannel(channel, tick)})).filter(entry => entry.value !== undefined);
  active.sort((a,b) => Number(b.channel.property === 'paint') - Number(a.channel.property === 'paint'));
  if (!active.length) return frame;
  let out = frame, clonedObjects = false;
  const cloned = new Set(); let slots;
  const ensureFrame = () => { if (out === frame) out = {...frame}; return out; };
  const editObject = (slot, discardRuntime = true) => {
    ensureFrame(); if (!clonedObjects) { out.objects = [...frame.objects]; clonedObjects = true; }
    if (!cloned.has(slot)) { out.objects[slot] = {...out.objects[slot]}; cloned.add(slot); }
    if (discardRuntime) delete out.objects[slot].runtime_segments;
    return out.objects[slot];
  };
  const figureValues = new Map(), sceneValues = {}; let styleTypes, scopedStyles;
  for (const {channel, value} of active) {
    if (channel.target.kind === 'camera') {
      ensureFrame(); if (out.camera === frame.camera) out.camera = {x: 0, y: 0, scale: 1, angle_rad: 0, ...frame.camera, is_default: false};
      out.camera[channel.property === 'rotation' ? 'angle_rad' : channel.property] = value;
    } else if (channel.target.kind === 'scene') {
      sceneValues[channel.property] = value;
    } else if (['figure','segment','polygon'].includes(channel.target.kind)) {
      slots ??= new Map(frame.objects.map((object, index) => [object.unique_id, index]));
      const slot = slots.get(channel.target.uid); if (slot === undefined) continue;
      if (channel.target.kind === 'figure' && channel.property === 'color') { editObject(slot, false).color_override_raw = value; continue; }
      if (channel.property === 'zIndex') { editObject(slot, false)._stykZIndex = value; continue; }
      if (isAnimationStyleProperty(channel.target, channel.property)) {
        styleTypes ??= new Map(report.figure_types.map(figure => [figure.figure_type_id, figure]));
        // Missing/replaced handles stay dormant instead of styling a new segment.
        if (animationStyleValue(styleTypes.get(frame.objects[slot].figure_type_id), out.objects[slot], channel.target, channel.property) !== undefined) {
          // An applicable definition scope wins over the legacy global curve,
          // independently of their persisted order. Dormant scopes do not win.
          const scoped = channel.target.figureTypeId !== undefined;
          const identity = scoped || scopedStyles ? `${channel.target.kind}:${channel.target.uid}/${channel.target.handleId ?? channel.target.polygonId}:${channel.property}` : null;
          if (!scoped && scopedStyles?.has(identity)) continue;
          setAnimationStyle(editObject(slot, false), channel.target, channel.property, value);
          if (scoped) { scopedStyles ??= new Set(); scopedStyles.add(identity); }
        }
        continue;
      }
      const values = figureValues.get(slot) ?? {}; values[channel.property] = value; figureValues.set(slot, values);
    }
  }
  // Color and image selection are independent properties, regardless of edit order.
  if ('backgroundId' in sceneValues) {
    ensureFrame(); out.background_id = sceneValues.backgroundId; out.background_id_b = 0; out.background_mix = 0; delete out._stykBackgroundColor;
  }
  if ('color' in sceneValues) {
    ensureFrame(); if (sceneValues.color === null) delete out._stykBackgroundColor; else out._stykBackgroundColor = sceneValues.color;
  }
  if (!figureValues.size) return out;

  // A single iterative traversal composes inherited rotations. Rewalking every
  // ancestor's descendants becomes quadratic for deeply joined large scenes.
  const count = frame.objects.length, children = new Map(), parents = new Int32Array(count).fill(-1), roots = new Int32Array(count), ordered = [];
  for (let slot = 0; slot < count; slot++) {
    const parent = frame.objects[slot].join?.target_object_slot;
    if (parent === undefined) { ordered.push(slot); roots[slot] = slot; continue; }
    if (!Number.isInteger(parent) || parent < 0 || parent >= count) throw new Error('An animated figure has an invalid attachment.');
    parents[slot] = parent; const list = children.get(parent);
    if (list) list.push(slot); else children.set(parent, [slot]);
  }
  for (let i = 0; i < ordered.length; i++) for (const child of children.get(ordered[i]) ?? []) { roots[child] = roots[ordered[i]]; ordered.push(child); }
  if (ordered.length !== count) throw new Error('Animation channels cannot compose cyclic figure attachments.');
  const rotationDeltas = new Float64Array(count); let types;
  for (const slot of ordered) {
    const values = figureValues.get(slot) ?? {}, object = frame.objects[slot];
    if ('scale' in values) editObject(slot).scale = values.scale;
    if ('opacity' in values) editObject(slot).field28 = Math.round(255 * (1 - values.opacity));
    let delta = parents[slot] < 0 ? 0 : rotationDeltas[parents[slot]];
    if ('rotation' in values) {
      types ??= new Map(report.figure_types.map(figure => [figure.figure_type_id, figure]));
      const figure = types.get(object.figure_type_id);
      delta = values.rotation - animationRotation(figure, object);
    }
    rotationDeltas[slot] = delta;
    if (delta !== 0) {
      const changed = editObject(slot); changed.angles = object.angles.map(angle => angle + delta);
      if (object._stykAnimationOrigin?.ghosts) {types ??= new Map(report.figure_types.map(figure => [figure.figure_type_id, figure])); rotateOriginSupport(types.get(object.figure_type_id), changed, delta);}
    }
  }
  out = correctAnimationOrigins(report, out);
  clonedObjects = out.objects !== frame.objects;
  const needsWorld = [...figureValues].some(([slot, values]) => parents[slot] >= 0 && ('x' in values || 'y' in values));
  const world = needsWorld && resolveGeometry ? resolveGeometry(report, out) : null;
  const shiftX = new Float64Array(count), shiftY = new Float64Array(count);
  for (const slot of ordered) {
    const values = figureValues.get(slot); if (!values || !('x' in values || 'y' in values)) continue;
    const rootSlot = roots[slot], object = out.objects[slot]; let base = world?.objects.get(slot)?.root;
    if (object._stykAnimationOrigin) {
      if (parents[slot] < 0) base = object._stykAnimationOrigin;
      else if (base) {
        types ??= new Map(report.figure_types.map(figure => [figure.figure_type_id, figure]));
        const offset = animationOriginOffset(types.get(object.figure_type_id), object);
        base = {x: base.x + offset.x, y: base.y + offset.y};
      }
    }
    for (const [property, field, shifts] of [['x', 'root_x', shiftX], ['y', 'root_y', shiftY]]) if (property in values) {
      const delta = values[property] - ((base?.[property] ?? object[field]) + shifts[rootSlot]);
      if (delta !== 0) {
        const root = editObject(rootSlot); root[field] += delta;
        if (root._stykAnimationOrigin) root._stykAnimationOrigin = {...root._stykAnimationOrigin,
          [property]: root._stykAnimationOrigin[property] + delta};
      }
      shifts[rootSlot] += delta;
    }
  }
  return out;
}
