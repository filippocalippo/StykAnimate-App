import {sampleAnimationChannel} from './animation-channels.mjs';

/** Inspector provenance is derived from the evaluator's scalar-over-pose model.
 * No synthetic scalar keys are persisted or allocated for inherited poses. */
export function animationPropertyState(editor, target, property, options = {}) {
  const tick = editor.tick, poseOnly = property === 'pose';
  const channel = poseOnly ? null : editor.animationChannel(target, property, options);
  const own = neighbours(channel?.keys ?? [], tick);
  const scalar = sampleAnimationChannel(channel, tick);
  if (editor.propertyChannels && !poseOnly) return {key:own.current?.passthrough ? null : own.current,
    keyed:Boolean(own.current && !own.current.passthrough), animated:keySummary(channel?.keys).animated,
    autoKey:true, poseKeyed:false, poseAnimated:false, source:scalar !== undefined ? 'property' : 'base',
    poseOnly:false, previous:Boolean(own.previous), next:Boolean(own.next), previousKey:own.previous, nextKey:own.next};
  let poseTarget = target, inheritsPose = poseOnly || target.kind === 'camera' || target.kind === 'scene' ||
    target.kind === 'figure' && ['x', 'y', 'scale', 'rotation', 'opacity'].includes(property);
  if (target.kind === 'segment' || target.kind === 'figure' && ['outlineOpacity', 'zIndex'].includes(property)) {
    const object = editor.evaluatedFrame.objects.find(object => object.unique_id === target.uid);
    inheritsPose = target.kind === 'segment' ? Number.isFinite(object?._stykStyle?.segments?.[target.handleId]?.[property]) :
      property === 'zIndex' ? object?._stykZIndex !== undefined : object?._stykStyle?.outlineOpacity !== undefined;
    poseTarget = {kind: 'figure', uid: target.uid};
  }
  const pose = inheritsPose ? editor.nativePoseChannel(poseTarget) : null;
  // A scalar interval masks every pose key until the next scalar boundary.
  // Skip that interval outright instead of scanning thousands of masked keys.
  const previousControlled = own.current ? own.previous && !own.previous.passthrough : scalar !== undefined;
  const inherited = neighbours(pose?.keys ?? [], tick, key => sampleAnimationChannel(channel, key.tick) === undefined,
    {previous: !previousControlled, next: scalar === undefined, min: own.previous?.tick, max: own.next?.tick});
  const usesPose = inheritsPose && scalar === undefined;
  const key = own.current?.passthrough ? null : own.current;
  const previousKey = later(own.previous, inherited.previous), nextKey = earlier(own.next, inherited.next);
  return {key, keyed: Boolean(key), animated: keySummary(channel?.keys).animated,
    autoKey: property === 'zIndex' || Boolean(channel?.keys.length),
    poseKeyed: usesPose && Boolean(inherited.current), poseAnimated: usesPose && keySummary(pose?.keys).visible,
    source: scalar !== undefined ? 'property' : usesPose ? 'pose' : 'shared',
    poseOnly, previous: Boolean(previousKey), next: Boolean(nextKey), previousKey, nextKey};
}
const summaries = new WeakMap(), emptySummary = Object.freeze({visible: false, animated: false});
function keySummary(keys) {
  if (!keys) return emptySummary;
  let summary = summaries.get(keys);
  if (!summary) { summary = {visible: keys.some(key => !key.hidden), animated: keys.some(key => !key.hidden && !key.passthrough)}; summaries.set(keys, summary); }
  return summary;
}
const later = (a, b) => !a ? b : !b || a.tick >= b.tick ? a : b;
const earlier = (a, b) => !a ? b : !b || a.tick <= b.tick ? a : b;
function neighbours(keys, tick, accepts = () => true, limits = {}) {
  let low = 0, high = keys.length;
  while (low < high) { const mid = (low + high) >>> 1; if (keys[mid].tick < tick) low = mid + 1; else high = mid; }
  let current = null, previous = null, next = null, end = low;
  while (end < keys.length && keys[end].tick === tick) { if (!keys[end].hidden && accepts(keys[end])) current = keys[end]; end++; }
  if (limits.previous !== false) for (let i = low - 1; i >= 0; i--) {
    if (keys[i].tick <= (limits.min ?? -Infinity)) break;
    if (!keys[i].hidden && accepts(keys[i])) { previous = keys[i]; break; }
  }
  if (limits.next !== false) for (let i = end; i < keys.length; i++) {
    if (keys[i].tick >= (limits.max ?? Infinity)) break;
    if (!keys[i].hidden && accepts(keys[i])) { next = keys[i]; break; }
  }
  return {current, previous, next};
}
