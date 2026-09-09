import {easingMode, keyEasing} from './keyframe-easing.mjs';
/** One chosen pose per selected native key; this command never bakes a movie. */
import {evaluatedNativeFrame, evaluatedFrame, nativeTimeline, buildGeometry} from './pivot/geometry.mjs';
import {animationPropertyValue, sampleAnimationChannel, validateAnimationDocumentSteps} from './animation-channels.mjs';
import {buildVirtualPoseTrack} from './animation-pose.mjs';
import {validateSceneSteps} from './pivot/model.mjs';
import {invalidateFrameIndex} from './frame-ids.mjs';

export const INBETWEEN_LIMITS = Object.freeze({insertedFrames: 10000, objectPoses: 250000, segmentValues: 3000000});
const clone = value => structuredClone(value);
const MAX_TICK = 10000000;
function checkRatio(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)
    throw new Error('Choose an interpolation ratio from zero to one.');
}
/** Native frames can store at most two backgrounds. Do not silently reduce a
 * three/four-image blend to the evaluator's dominant-background approximation. */
export function canInsertBackgroundTransition(start, end, ratio) {
  if (ratio === 0 || ratio === 1) return true;
  const a = start.background_id ?? 0, b = start.background_id_b ?? 0, m = start.background_mix ?? 0;
  const c = end.background_id ?? 0, d = end.background_id_b ?? 0, n = end.background_mix ?? 0;
  if (m && n) return a === c && b === d || a === d && b === c;
  if (m) return c === a || c === b;
  if (n) return a === c || a === d;
  return true;
}
function checkBackground(start, end, ratio) {
  if (!canInsertBackgroundTransition(start, end, ratio))
    throw new Error('This inbetween needs more than two background images. Choose an endpoint ratio, or simplify the neighboring background blends before inserting.');
}
function cleanFrame(frame, frameId, duration = 1) {
  const result = clone({...frame,objects:[]});
  for (const {runtime_segments,...object} of frame.objects) result.objects.push(clone(object));
  result.duration_raw = duration;
  result._styk = {...result._styk, frameId};
  return result;
}
function identityPlan(editor) {
  let next = editor._nextFrameIdentity;
  return {
    get next() { return next; },
    take() {
      if (!Number.isSafeInteger(next) || next < 1 || !Number.isSafeInteger(next + 1))
        throw new Error('Frame identity capacity exceeded.');
      return `frame-${next++}`;
    },
  };
}
function allocationBudget() {
  let objects = 0, values = 0;
  return frame => {
    objects += frame.objects.length;
    for (const object of frame.objects) values += (object.angles?.length ?? 0) + (object.lengths?.length ?? 0) + (object.bends?.length ?? 0);
    if (objects > INBETWEEN_LIMITS.objectPoses || values > INBETWEEN_LIMITS.segmentValues)
      throw new Error('Insert fewer inbetweens at once: a command supports 250,000 captured figure poses and 3,000,000 segment values.');
  };
}
function animationPatch(before, after) {
  const changes = before.channels.flatMap((channel, index) => channel === after.channels[index] ? [] :
    [{id: channel.id, before: {exists: true, index, channel}, after: {exists: true, index, channel: after.channels[index]}}]);
  const metadata = value => { const {channels, ...fields} = value; return {exists: true, fields}; };
  return {changes, before: metadata(before), after: metadata(after)};
}

function keyAt(channel, tick) {
  let result;
  for (const key of channel.keys) { if (key.tick > tick) break; result = key; }
  return result;
}
function sceneTransition(report, channel, tick) {
  const track = buildVirtualPoseTrack(report, channel), keys = track.orderedKeys;
  let index = -1;
  for (let i = 0; i < keys.length && keys[i].tick <= tick; i++) index = i;
  if (index < 0 || index === keys.length - 1 || easingMode(keys[index]) === 'constant') return;
  const duration = keys[index + 1].tick - keys[index].tick;
  if (duration > 0) checkBackground(track.frames[index], track.frames[index + 1], (tick - keys[index].tick) / duration);
}
function shiftedTick(tick, entries) {
  let low = 0, high = entries.length;
  while (low < high) { const mid = (low + high) >>> 1; if (entries[mid].originalTick <= tick) low = mid + 1; else high = mid; }
  const shifted = tick + (entries[low - 1]?.cumulativeDuration ?? 0);
  if (!Number.isSafeInteger(shifted) || shifted > MAX_TICK)
    throw new Error('Inserting here would move an authored key beyond frame 10,000,000.');
  return shifted;
}
function* planAnimation(editor, entries, identities, budget) {
  const report = editor.report, before = report._styk.animation;
  if (!before?.channels.length) return null;
  const after = {...before, nextKeyId: before.nextKeyId ?? 1, channels: []}, sources = [];
  const poseChannels = before.channels.filter(channel => channel.property === 'pose');
  const visibleInsertions = entries.filter(entry => entry.duration > 0).length;
  const maximumKeys = before.channels.reduce((count, channel) => count + channel.keys.length +
    (channel.property === 'pose' ? entries.length : visibleInsertions), 0);
  if (maximumKeys > 1000000)
    throw new Error('Insert fewer inbetweens to stay within the one-million authored-key limit.');
  const poseReport = {...report, version: 5, auto_easing: false, _styk: {...report._styk, animation: {...before, channels: poseChannels}}};
  let completed=0;
  for (const entry of entries) {
    // Scalar channels are sampled separately. Their rotations/scales must not
    // be baked into a layer pose and then applied a second time on playback.
    entry.pose = evaluatedFrame(poseReport, entry.sourceIndex, entry.sampleRatio, entry.sourceTick);
    if (poseChannels.length) {
      for (const channel of poseChannels) if (channel.target.kind === 'scene') sceneTransition(report, channel, entry.sourceTick);
      budget(entry.pose);
      const source = cleanFrame(entry.pose, identities.take(), entry.duration);
      entry.sourceId = source._styk.frameId; sources.push(source);
    }
    yield {phase:'sampling animation',completed:++completed,total:entries.length};
  }
  completed=0;
  for (const channel of before.channels) {
    const keys=[];let visited=0;
    for (const key of channel.keys) {
      const tick = shiftedTick(key.tick, entries);
      keys.push(tick === key.tick ? key : {...key,tick});
      if (++visited%256===0) yield {phase:'animation',completed,total:before.channels.length};
    }
    const used = new Set(keys.map(key => key.id));
    const insertedIds = new Set();
    for (const entry of entries) {
      let value;
      if (channel.property === 'pose') value = {frameId: entry.sourceId};
      else {
        // Scalar channels have no hidden-key representation. A zero-exposure
        // insertion remains a pose tween target and does not add scalar keys.
        if (entry.duration === 0) continue;
        value = sampleAnimationChannel(channel, entry.sourceTick);
        if (value === undefined) {
          // A curve may begin between the requested sample and insertion time.
          // Key the underlying pose value so that later curve cannot mask it.
          value = channel.target.kind === 'scene' && channel.property === 'color'
            ? entry.pose._stykBackgroundColor ?? null
            : animationPropertyValue(report, entry.pose, channel.target, channel.property, {resolveGeometry: (r,f) => entry.geometry ??= buildGeometry(r,f)});
        }
        if (value === undefined) continue; // The figure is absent in this pose.
      }
      let id;
      do {
        if (!Number.isSafeInteger(after.nextKeyId) || after.nextKeyId < 1 || !Number.isSafeInteger(after.nextKeyId + 1))
          throw new Error('Animation key identity capacity exceeded.');
        id = `key-${after.nextKeyId++}`;
      } while (used.has(id));
      used.add(id);
      insertedIds.add(id);
      keys.push({id, tick: entry.tick, value, ...keyEasing(keyAt(channel, entry.sourceTick)),
        ...(entry.duration === 0 ? {hidden: true} : {})});
      if (++visited%256===0) yield {phase:'animation',completed,total:before.channels.length};
    }
    keys.sort((a, b) => a.tick - b.tick || Number(Boolean(b.hidden)) - Number(Boolean(a.hidden)) ||
      Number(insertedIds.has(b.id)) - Number(insertedIds.has(a.id)));
    after.channels.push(keys.length === channel.keys.length && keys.every((key, index) => key === channel.keys[index]) ? channel : {...channel, keys});
    yield {phase:'animation',completed:++completed,total:before.channels.length};
  }
  return {before, after, sources, patch: animationPatch(before, after)};
}

/** Plan without reserving identities or mutating source data/history. Existing
 * durations retain their meaning. Native insertion inherits the right exposure,
 * except ratio zero inherits the left exposure; index zero copies the first key. */
export function planInsertInbetweens(editor, ratio = 0.5, indices = [editor.frameIndex]) {
  const iterator=planInsertInbetweenSteps(editor,ratio,indices);
  for (;;) {const step=iterator.next();if(step.done)return step.value;}
}
export function* planInsertInbetweenSteps(editor, ratio = 0.5, indices = [editor.frameIndex]) {
  checkRatio(ratio);
  const report=editor.report;
  if(!Array.isArray(indices)||indices.some(index=>!Number.isInteger(index)||index<0||index>=report.keyframes.length))throw new Error('Choose existing source frames.');
  const targets = [...new Set(indices)].sort((a,b)=>a-b), skippedIndices = [];
  if (targets.length > INBETWEEN_LIMITS.insertedFrames || report.keyframes.length + targets.length > 100000)
    throw new Error('Insert at most 10,000 inbetweens at once, within the 100,000-keyframe document limit.');
  const identities = identityPlan(editor), budget = allocationBudget(), rows = nativeTimeline(report);
  // Native TTweener.FForceLinear is explicitly set for this command, even if
  // animation playback uses automatic easing. Existing project mode is kept.
  const samplingReport = {...report, version: 5, auto_easing: false};
  let cumulativeDuration = 0;
  const entries=[];
  for (const [ordinal,index] of targets.entries()) {
    const originalTick = rows[index].start, tick = originalTick + cumulativeDuration;
    if (tick > MAX_TICK && report._styk.animation?.channels.length)
      throw new Error('The inserted authored pose would exceed frame 10,000,000.');
    const sourceIndex = Math.max(0, index - 1), sampleRatio = index === 0 ? 0 : ratio;
    if (index > 0) checkBackground(report.keyframes[index - 1], report.keyframes[index], ratio);
    const sampled = evaluatedNativeFrame(samplingReport, sourceIndex, sampleRatio);
    const duration = report.keyframes[index === 0 || ratio > 0 ? index : index - 1].duration_raw;
    cumulativeDuration += duration;
    budget(sampled);
    entries.push({index, insertedIndex: index + ordinal, originalTick, tick, ratio, sourceIndex, sampleRatio, duration, cumulativeDuration,
      sourceTick: rows[sourceIndex].start + (originalTick - rows[sourceIndex].start) * sampleRatio,
      frame: cleanFrame(sampled, identities.take(), duration)});
    yield {phase:'sampling',completed:ordinal+1,total:targets.length};
  }
  if (!entries.length) return {entries, skippedIndices, nextFrameIdentity: identities.next, animation: null};
  const animation = yield* planAnimation(editor, entries, identities, budget);
  // Validate only newly captured poses against the shared asset tables. Existing
  // source frames and large bitmap/text payloads are not cloned for this check.
  yield* validateSceneSteps({...report, keyframes: [...entries.map(entry => entry.frame), ...(animation?.sources ?? [])]});
  if (animation) {
    const keyframes = report.keyframes.slice();
    for (const entry of [...entries].reverse()) keyframes.splice(entry.index, 0, entry.frame);
    const sources = {...report._styk.frameSources};
    for (const source of animation.sources) sources[source._styk.frameId] = source;
    yield* validateAnimationDocumentSteps({...report, keyframes, _styk: {...report._styk, animation: animation.after, frameSources: sources}});
  }
  return {entries, skippedIndices, nextFrameIdentity: identities.next, animation};
}

/** Lightweight worker-safe sampler: no history planning or source snapshots. */
export function sampleInbetweenPreview(report, ratio = 0.5, index = 0) {
    checkRatio(ratio);
    if (!Number.isInteger(index) || !report.keyframes[index]) throw new Error('Choose an existing source frame.');
    const rows = nativeTimeline(report), sourceIndex = Math.max(0, index - 1), sampleRatio = index === 0 ? 0 : ratio;
    const sourceTick = rows[sourceIndex].start + (rows[index].start - rows[sourceIndex].start) * sampleRatio;
    if (index > 0) checkBackground(report.keyframes[index - 1], report.keyframes[index], ratio);
    for (const channel of report._styk?.animation?.channels ?? []) if (channel.property === 'pose' && channel.target.kind === 'scene') sceneTransition(report, channel, sourceTick);
    const samplingReport = {...report, version: 5, auto_easing: false};
    const frame = evaluatedFrame(samplingReport, sourceIndex, sampleRatio, sourceTick);
    return {frame, ratio, sourceTick, insertionTick: rows[index].start, index};
}

export const editorInbetweenMethods = {
  /** Read-only preview shares the insertion sampler and transition checks. */
  previewInbetween(ratio = 0.5, index = this.frameIndex) {
    return sampleInbetweenPreview(this.report, ratio, index);
  },
  insertInbetweenFrames(ratio = 0.5, indices = [this.frameIndex]) {
    // Finish an existing gesture before sampling its committed document state.
    checkRatio(ratio); this._frameIndices(indices);
    if (this._animationEdit) this.commitAnimationEdit();
    if (this._drag) this.commitDrag();
    const plan = planInsertInbetweens(this, ratio, indices);
    return this._commitInbetweenPlan(plan,ratio);
  },
  _commitInbetweenPlan(plan,ratio) {
    const result = {insertedFrames: plan.entries.length, ratio, skippedIndices: plan.skippedIndices,
      indices: plan.entries.map(entry => entry.insertedIndex), ticks: plan.entries.map(entry => entry.tick),
      frameIds: plan.entries.map(entry => entry.frame._styk.frameId), durations: plan.entries.map(entry => entry.duration)};
    if (!plan.entries.length) return result;
    const beforeSelection = this._selectionState(), command = {kind: 'ranges', label: 'Insert inbetweens',
      changes: plan.entries.map(entry => ({index: entry.index, before: [], after: [entry.frame]})),
      beforeSelection, structural: true, timing: true};
    if(plan.prepared)Object.assign(command,{reuseFrameCopies:true,frameUidCounts:plan.prepared.frameUidCounts,
      frameSourceUidCounts:plan.prepared.frameSourceUidCounts,precomputedBytes:plan.prepared.precomputedBytes});
    if (plan.animation) {
      command.layerAnimationPatch = plan.animation.patch;
      command.frameSourceChanges = plan.animation.sources.map(source => ({id: source._styk.frameId,
        before: {exists: false}, after: {exists: true, value: source}}));
      command.hadFrameSourceTable = this.report._styk.frameSources !== undefined;
    }
    if(plan.prepared)this.report.keyframes=plan.prepared.keyframes;
    else for (const entry of [...plan.entries].reverse()) this.report.keyframes.splice(entry.index, 0, clone(entry.frame));
    this._nextFrameIdentity = plan.nextFrameIdentity;
    if (plan.animation) {
      this._applyFrameSourceChanges(command, 'after',plan.prepared?.preparedFrameSources);
      this.report._styk.animation = plan.animation.after;
    }
    // Inserted frames are separately owned snapshots; existing objects and
    // definitions were not mutated. Recompare the new evaluated pose against
    // the retained scene instead of discarding all geometry at publication.
    invalidateFrameIndex(this.report); this._invalidate({timing: true,retainGeometry:true});
    this.frameIndex = result.indices[0]; this.tick = result.ticks[0]; this._selectIds([]);
    command.afterSelection = this._selectionState(); this._record(command);
    this._seekGeometry?.retainRevision(this.revision);
    this._emit('edit', {label: command.label, structural: true, timing: true, animation: Boolean(plan.animation), insertedFrameIndices: result.indices});
    return result;
  },
};

export function installEditorInbetweens(Editor) { Object.assign(Editor.prototype, editorInbetweenMethods); return Editor; }
