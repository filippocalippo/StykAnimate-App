import {messageError} from './localized-error.mjs';
/** Preserve independently authored poses when figures change layer membership.
 * Planning is atomic: it shares native frames and unaffected channel objects,
 * and allocates only immutable source assets for the destination pose track. */
import {animationChannelId} from './animation-channels.mjs';
import {evaluatedFrame, timeline} from './pivot/geometry.mjs';
import {layerIdForUid} from './layers.mjs';

export const LAYER_MIGRATION_LIMITS = Object.freeze({maxTicks: 10000, maxObjectPoses: 250000, maxSegmentValues: 3000000});
export const LAYER_MIGRATION_WORKER_LIMITS = Object.freeze({maxTicks: 10000000, maxObjectPoses: 2000000, maxSegmentValues: 12000000});
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isLayerPose = channel => channel.target?.kind === 'layer' && channel.property === 'pose';

function checkBudget(ticks, channels, limits) {
  if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > limits.maxTicks)
    throw messageError(new Error(''), limits === LAYER_MIGRATION_LIMITS ? 'errors.editorLayerMigration.useBackgroundMigration' : 'errors.editorLayerMigration.timeRange');
  const keys = channels.reduce((sum, channel) => sum + channel.keys.length, 0);
  if (keys + ticks > 1000000) throw messageError(new Error(''), "errors.editorLayerMigration.preservingThisLayerMoveWouldExceedTheOne", {});
}

/** Keep the destination's figures and native ancestry needed to resolve their
 * attachment orientations. Other layers keep their existing source references. */
function compactPoseFrame(report, frame, moving, targetLayerId) {
  const keep = new Set(), queue = [];
  frame.objects.forEach((object, slot) => {
    if (moving.has(object.unique_id) || layerIdForUid(report, object.unique_id) === targetLayerId) { keep.add(slot); queue.push(slot); }
  });
  for (let index = 0; index < queue.length; index++) {
    const parent = frame.objects[queue[index]].join?.target_object_slot;
    if (parent !== undefined && !keep.has(parent)) {
      if (!frame.objects[parent]) throw messageError(new Error(''), "errors.editorLayerMigration.layerMigrationEncounteredAMissingAttachmentParent", {});
      keep.add(parent); queue.push(parent);
    }
  }
  const slots = [...keep].sort((a, b) => a - b), remap = new Map(slots.map((slot, index) => [slot, index]));
  const objects = slots.map(slot => {
    const source = frame.objects[slot], object = Object.fromEntries(Object.keys(source).filter(key => key !== 'runtime_segments').map(key => [key, source[key]]));
    object.object_slot = remap.get(slot);
    if (object.join) object.join = {...object.join, target_object_slot: remap.get(object.join.target_object_slot)};
    return object;
  });
  const order = (frame.object_draw_order ?? frame.objects.map((_, slot) => slot)).filter(slot => keep.has(slot)).map(slot => remap.get(slot));
  return {...frame, objects, object_count: objects.length, object_draw_order: order, object_draw_order_unique_ids: order.map(slot => objects[slot].unique_id)};
}

/** Call before changing assignments. The caller publishes this plan together
 * with the membership changes as one undoable command. Sampling every integer
 * tick preserves playback exactly; destination keys intentionally use hold. */
export function* planLayerMembershipMigrationSteps(editor, uids, targetLayerId, {deletedLayerId, worker = false, maxSourceBytes = worker ? 128 * 1024 * 1024 : Infinity} = {}) {
  const report = editor.report, state = report._styk?.layers;
  if (!state || !owns(state.byId, targetLayerId)) throw messageError(new Error(''), "errors.editorLayerAsync.chooseAnExistingDestinationUserLayer", {});
  if (deletedLayerId !== undefined && (!owns(state.byId, deletedLayerId) || deletedLayerId === targetLayerId))
    throw messageError(new Error(''), "errors.editorLayerMigration.chooseADifferentDestinationBeforeDeletingALayer", {});
  const members = [...new Set(uids)], sourceIds = new Set();
  for (const uid of members) {
    if (!Number.isInteger(uid) || uid < 0 || uid > 0xffffffff) throw messageError(new Error(''), "errors.editorLayerMigration.chooseValidFigureIdentitiesForTheLayerMove", {});
    const id = layerIdForUid(report, uid); if (id !== targetLayerId) sourceIds.add(id);
  }
  const beforeAnimation = report._styk?.animation ?? null, channels = beforeAnimation?.channels ?? [];
  const removed = channels.filter(channel => isLayerPose(channel) && channel.target.id === deletedLayerId);
  const needsSampling = sourceIds.size > 0 && channels.some(channel => isLayerPose(channel) &&
    (sourceIds.has(channel.target.id) || channel.target.id === targetLayerId));
  if (!needsSampling && !removed.length) return null;
  const afterAnimation = {...beforeAnimation, version: 1, nextKeyId: beforeAnimation?.nextKeyId ?? 1,
    channels: channels.filter(channel => !removed.includes(channel))};
  const frameSources = {}, frameSourceChanges = [], affectedLayerIds = [...sourceIds, targetLayerId];
  const plan = {beforeAnimation, afterAnimation, frameSources, frameSourceChanges, affectedLayerIds,
    hadFrameSourceTable: report._styk.frameSources !== undefined, nextFrameIdentity: editor._nextFrameIdentity, sampledTicks: 0};
  if (!needsSampling) return plan;

  const entries = timeline(report), last = entries.at(-1), ticks = Math.max(1, (last?.start ?? 0) + (last?.count ?? 0));
  const limits = worker ? LAYER_MIGRATION_WORKER_LIMITS : LAYER_MIGRATION_LIMITS;
  if (!(maxSourceBytes > 0)) throw messageError(new Error(''), "errors.editorLayerMigration.layerMigrationSourceMemoryBudgetMustBePositive", {});
  checkBudget(ticks, afterAnimation.channels, limits);
  // Figure scalar channels are absolute overlays. Baking them into the poses
  // and applying them again would alter attached/rotated/scaled descendants.
  const poseReport = {...report, _styk: {...report._styk, animation: {...beforeAnimation,
    channels: channels.filter(channel => channel.property === 'pose')}}};
  const target = {kind: 'layer', id: targetLayerId}, id = animationChannelId(target, 'pose');
  const previous = afterAnimation.channels.find(channel => channel.id === id);
  const destination = {...previous, id, target, property: 'pose', source: 'authored', keys: []};
  let frameIndex = 0, nextIdentity = editor._nextFrameIdentity, objectPoses = 0, segmentValues = 0, lastYield = performance.now();
  const moving = new Set(members);
  const usedIds = new Set([...report.keyframes.map(frame => frame._styk?.frameId), ...Object.keys(report._styk.frameSources ?? {})]);
  for (let tick = 0; tick < ticks; tick++) {
    while (frameIndex < entries.length - 1 && entries[frameIndex + 1].start <= tick) frameIndex++;
    const entry = entries[frameIndex], fraction = entry.count > 0 ? Math.min(1, (tick - entry.start) / entry.count) : 0;
    const compact = compactPoseFrame(report, evaluatedFrame(poseReport, frameIndex, fraction, tick), moving, targetLayerId);
    objectPoses += compact.objects.length;
    for (const object of compact.objects) segmentValues += (object.angles?.length ?? 0) + (object.lengths?.length ?? 0) + (object.bends?.length ?? 0);
    if (objectPoses > limits.maxObjectPoses || segmentValues > limits.maxSegmentValues)
      throw messageError(new Error(''), "errors.editorLayerMigration.thisLayerMigrationExceedsTheRetainedPoseMemory", {});
    if (256 * (tick + 1) + 512 * objectPoses + 8 * segmentValues > maxSourceBytes)
      throw messageError(new Error(''), "errors.editorLayerMigration.thisLayerMigrationExceedsTheRetainedSourceMemory", {});
    const frame = structuredClone(compact);
    let frameId;
    do {
      if (!Number.isSafeInteger(nextIdentity) || nextIdentity < 1) throw messageError(new Error(''), "errors.clipboardLegacyUpgrade.frameIdentityCapacityExceeded", {});
      frameId = `frame-${nextIdentity++}`;
    } while (usedIds.has(frameId));
    usedIds.add(frameId); frame._styk = {...frame._styk, frameId}; frame.duration_raw = 1;
    // Native interpolation writes materialized pose arrays; stale renderer
    // caches must not become persisted source data.
    for (const object of frame.objects) delete object.runtime_segments;
    frameSources[frameId] = frame;
    frameSourceChanges.push({id: frameId, before: {exists: false}, after: {exists: true, value: frame}});
    if (!Number.isSafeInteger(afterAnimation.nextKeyId)) throw messageError(new Error(''), "errors.cameraBakeAuthored.animationKeyIdentityCapacityExceeded", {});
    destination.keys.push({id: `key-${afterAnimation.nextKeyId++}`, tick, value: {frameId}, interpolation: 'hold'});
    if ((tick + 1) % 8 === 0 || performance.now() - lastYield >= 8 || tick + 1 === ticks) {
      yield {phase: 'sampling', completed: tick + 1, total: ticks, sourceFrames: tick + 1, objectPoses, segmentValues}; lastYield = performance.now();
    }
  }
  const index = afterAnimation.channels.findIndex(channel => channel.id === id);
  if (index < 0) afterAnimation.channels.push(destination); else afterAnimation.channels[index] = destination;
  plan.nextFrameIdentity = nextIdentity; plan.sampledTicks = ticks; plan.sourceBytes = 256 * ticks + 512 * objectPoses + 8 * segmentValues;
  return plan;
}

export function planLayerMembershipMigration(editor, uids, targetLayerId, options) {
  const iterator = planLayerMembershipMigrationSteps(editor, uids, targetLayerId, options);
  let step; do { step = iterator.next(); } while (!step.done); return step.value;
}

function channelDelta(beforeAnimation, afterAnimation) {
  const before = new Map((beforeAnimation?.channels || []).map(channel => [channel.id, channel]));
  const after = new Map(afterAnimation.channels.map(channel => [channel.id, channel]));
  const channelUpdates = [];
  for (const channel of after.values()) if (before.get(channel.id) !== channel) channelUpdates.push({id: channel.id, channel});
  for (const id of before.keys()) if (!after.has(id)) channelUpdates.push({id, channel: null});
  return {channelUpdates, channelOrder: [...after.keys()], nextKeyId: afterAnimation.nextKeyId};
}

/** What a background planner sends the editor: preserve unchanged channel references and
 * send each new source asset once. The engine's planner answers the same plan, byte for byte
 * (engine/tools/layer-migration-fixtures.mjs records it). */
export function migrationPlanPayload(plan) {
  if (!plan) return {plan: null};
  return {plan: {version: 1, ...channelDelta(plan.beforeAnimation, plan.afterAnimation),
    frameSources: plan.frameSources, nextFrameIdentity: plan.nextFrameIdentity, sampledTicks: plan.sampledTicks,
    affectedLayerIds: plan.affectedLayerIds, hadFrameSourceTable: plan.hadFrameSourceTable,
    ...(plan.sourceBytes !== undefined ? {sourceBytes: plan.sourceBytes} : {})}};
}
