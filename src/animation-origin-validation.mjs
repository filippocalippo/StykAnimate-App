import {messageError} from './localized-error.mjs';
/** Validate retained rig origins without rescanning their support graph per pose. */
const MAX_BONES = 100000;
const validated = new WeakMap();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (key, params = {}) => {throw messageError(new Error(''), key, params);};
const label = (messageKey, diagnosticValue) => ({messageKey, diagnosticValue});
const NATIVE_HANDLE = label('errors.animationOriginValidation.labels.nativeHandle', 'native handle');
const SUPPORT_PARENT = label('errors.animationOriginValidation.labels.supportParent', 'support parent');
const SUPPORT_VERTEX = label('errors.animationOriginValidation.labels.supportVertex', 'support vertex');
const SUPPORT_PATH_BONE = label('errors.animationOriginValidation.labels.supportPathBone', 'support path bone');
const SUPPORT_ROTATION = label('errors.animationOriginValidation.labels.supportRotation', 'support rotation');
const SUPPORT_BONE_LABELS = {
  record:label('errors.animationOriginValidation.labels.supportBone', 'support bone'),
  angle:label('errors.animationOriginValidation.labels.supportBoneAngle', 'support bone angle'),
  bend:label('errors.animationOriginValidation.labels.supportBoneBend', 'support bone bend'),
  length:label('errors.animationOriginValidation.labels.supportBoneLength', 'support bone length'),
};
const GHOST_LABELS = {
  record:label('errors.animationOriginValidation.labels.ghost', 'ghost'),
  angle:label('errors.animationOriginValidation.labels.ghostAngle', 'ghost angle'),
  bend:label('errors.animationOriginValidation.labels.ghostBend', 'ghost bend'),
  length:label('errors.animationOriginValidation.labels.ghostLength', 'ghost length'),
};
const integer = (value, low, high, label) => {
  if (!Number.isInteger(value) || value < low || value > high) fail('errors.animationOriginValidation.details.mustBeAnIntegerFromTo', {label, low, high});
};
const finite = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('errors.animationOriginValidation.details.mustBeFinite', {label});
};
const float32 = (value, label) => {
  finite(value, label);
  if (!Number.isFinite(Math.fround(value))) fail('errors.animationOriginValidation.details.exceedsNativeFloat32Range', {label});
};
function poseValues(pose, labels) {
  if (!record(pose)) fail('errors.animationOriginValidation.details.mustBeAPoseRecord', {label:labels.record});
  finite(pose.angle_rad, labels.angle); finite(pose.bend_rad, labels.bend);
  float32(pose.length, labels.length);
}
function checkpoint(sliceMs) {
  let checked = 0, lastYield = performance.now();
  return stage => {
    if (++checked % 128 !== 0 || performance.now() - lastYield < sliceMs) return null;
    lastYield = performance.now(); return {phase: 'validation', stage: `animation origin ${stage}`, checked};
  };
}
function cacheEntry(figure, origin, metadata) {
  const support = origin.support;
  return {metadata, segments: figure.segments, count: figure.segments.length, origin,
    handleId: origin.handleId, rotationHandleId: origin.rotationHandleId, reversed: origin.reversed,
    support, bones: support?.bones, boneCount: support?.bones?.length, vertices: support?.vertices,
    path: support?.path, pathCount: support?.path?.length, rotation: support?.rotation, version: support?.version};
}
function cached(figure) {
  const entry = validated.get(figure), origin = figure?._styk?.animationOrigin, support = origin?.support;
  if (!entry || entry.segments !== figure.segments || entry.count !== figure.segments.length || entry.origin !== origin ||
      entry.handleId !== origin.handleId || entry.rotationHandleId !== origin.rotationHandleId || entry.reversed !== origin.reversed ||
      entry.support !== support || entry.bones !== support?.bones || entry.boneCount !== support?.bones?.length ||
      entry.vertices !== support?.vertices || entry.path !== support?.path || entry.pathCount !== support?.path?.length ||
      entry.rotation !== support?.rotation || entry.version !== support?.version) return null;
  return entry.metadata;
}

/** Full validation always scans the descriptor, including in-place edits. The
 * cache is published only after completion; object validation reuses it until
 * a descriptor/container changes or the topology owner invalidates it. */
export function* validateOriginSupportSteps(figure, origin = figure?._styk?.animationOrigin, {sliceMs = 4} = {}) {
  validated.delete(figure);
  if (origin === undefined) return null;
  if (!record(origin) || !Array.isArray(figure?.segments)) fail('errors.animationOriginValidation.details.mustDescribeAnExistingFigure');
  const due = checkpoint(sliceMs), handles = new Set([0]), liveHandles = new Set();
  for (const segment of figure.segments) {
    integer(segment.segment_id, 1, 65535, NATIVE_HANDLE);
    if (liveHandles.has(segment.segment_id)) fail('errors.animationOriginValidation.details.hasRepeatedNativeHandles');
    handles.add(segment.segment_id); liveHandles.add(segment.segment_id);
    const progress = due('handles'); if (progress) yield progress;
  }
  const support = origin.support;
  if (support === undefined) {
    if (!Number.isInteger(origin.handleId) || !handles.has(origin.handleId) ||
        !Number.isInteger(origin.rotationHandleId) || !liveHandles.has(origin.rotationHandleId) || typeof origin.reversed !== 'boolean')
      fail('errors.animationOriginValidation.details.mustReferenceExistingNativeHandles');
    const metadata = Object.freeze({origin, support: null, ghostIndices: Object.freeze([]), ghostCount: 0});
    validated.set(figure, cacheEntry(figure, origin, metadata)); return metadata;
  }
  if (!record(support) || support.version !== 1 || !Array.isArray(support.bones) ||
      support.bones.length < 1 || support.bones.length > MAX_BONES) fail('errors.animationOriginValidation.details.supportNeedsVersion1And1100000');
  const bones = support.bones, count = bones.length, bound = new Set(), ghosts = [], parents = new Int32Array(count);
  for (let index = 0; index < count; index++) {
    const bone = bones[index];
    if (!record(bone)) fail('errors.animationOriginValidation.details.supportBoneMustBeARecord');
    integer(bone.parent, -1, count - 1, SUPPORT_PARENT);
    if (bone.parent === index) fail('errors.animationOriginValidation.details.supportContainsASelfParentCycle');
    parents[index] = bone.parent;
    if (typeof bone.reversed !== 'boolean') fail('errors.animationOriginValidation.details.supportBoneReversedMustBeBoolean');
    poseValues(bone, SUPPORT_BONE_LABELS);
    if (bone.handleId === null) ghosts.push(index);
    else {
      if (!Number.isInteger(bone.handleId) || !liveHandles.has(bone.handleId) || bound.has(bone.handleId))
        fail('errors.animationOriginValidation.details.supportMustBindEachExistingSegmentExactlyOnce');
      bound.add(bone.handleId);
    }
    const progress = due('bones'); if (progress) yield progress;
  }
  if (bound.size !== liveHandles.size) fail('errors.animationOriginValidation.details.supportIsMissingALiveSegmentBinding');
  // Each parent edge is visited at most twice; no recursion or per-root walk.
  const state = new Uint8Array(count);
  for (let first = 0; first < count; first++) {
    let cursor = first;
    while (cursor !== -1 && state[cursor] === 0) {
      state[cursor] = 1; cursor = parents[cursor];
      const progress = due('ancestry'); if (progress) yield progress;
    }
    if (cursor !== -1 && state[cursor] === 1) fail('errors.animationOriginValidation.details.supportContainsAParentCycle');
    cursor = first;
    while (cursor !== -1 && state[cursor] === 1) {
      state[cursor] = 2; cursor = parents[cursor];
      const progress = due('ancestry'); if (progress) yield progress;
    }
    const progress = due('ancestry'); if (progress) yield progress;
  }
  if (!record(support.vertices)) fail('errors.animationOriginValidation.details.supportVerticesMustBeARecord');
  const nodes = new Set(); let vertexCount = 0;
  for (const key in support.vertices) if (own(support.vertices, key)) {
    const id = Number(key), node = support.vertices[key];
    if (!Number.isInteger(id) || String(id) !== key || !handles.has(id)) fail('errors.animationOriginValidation.details.supportVertexKeysMustBeExactNativeHandle');
    integer(node, -1, count - 1, SUPPORT_VERTEX);
    if (nodes.has(node)) fail('errors.animationOriginValidation.details.supportVerticesMustReferenceDistinctNodes');
    nodes.add(node); vertexCount++;
    const progress = due('vertices'); if (progress) yield progress;
  }
  if (vertexCount !== handles.size) fail('errors.animationOriginValidation.details.supportVerticesMustIncludeEveryNativeHandleAnd');
  if (!Array.isArray(support.path) || support.path.length > MAX_BONES) fail('errors.animationOriginValidation.details.supportPathMustContainAtMost100000');
  for (const term of support.path) {
    if (!record(term)) fail('errors.animationOriginValidation.details.supportPathTermMustBeARecord');
    integer(term.bone, 0, count - 1, SUPPORT_PATH_BONE);
    if (term.sign !== 1 && term.sign !== -1) fail('errors.animationOriginValidation.details.supportPathSignMustBeExactly1Or');
    const progress = due('path'); if (progress) yield progress;
  }
  integer(support.rotation, 0, count - 1, SUPPORT_ROTATION);
  if (origin.handleId !== null && (!Number.isInteger(origin.handleId) || !handles.has(origin.handleId) || support.vertices[String(origin.handleId)] !== -1))
    fail('errors.animationOriginValidation.details.handleMustReferenceItsOriginalVirtualRootOr');
  const rotation = bones[support.rotation];
  if (origin.rotationHandleId !== rotation.handleId || typeof origin.reversed !== 'boolean' ||
      rotation.handleId !== null && origin.reversed !== rotation.reversed)
    fail('errors.animationOriginValidation.details.rotationReferenceMustMatchItsSupportBone');
  const metadata = Object.freeze({origin, support, ghostIndices: Object.freeze(ghosts), ghostCount: ghosts.length});
  validated.set(figure, cacheEntry(figure, origin, metadata)); return metadata;
}

export function validateOriginSupport(figure, origin = figure?._styk?.animationOrigin) {
  const iterator = validateOriginSupportSteps(figure, origin, {sliceMs: Infinity});
  for (;;) {const step = iterator.next(); if (step.done) return step.value;}
}

/** Pose checks use the cached support graph and visit only stored ghost poses. */
export function* validateOriginObjectSteps(object, figure, {sliceMs = 4} = {}) {
  let metadata = cached(figure);
  if (!metadata && figure?._styk?.animationOrigin !== undefined)
    metadata = yield* validateOriginSupportSteps(figure, figure._styk.animationOrigin, {sliceMs});
  const origin = object?._stykAnimationOrigin;
  if (origin === undefined) {
    if (figure?._styk?.animationOrigin !== undefined) fail('errors.animationOriginValidation.details.poseIsMissingItsAnimationOrigin');
    return object;
  }
  if (!record(origin)) fail('errors.animationOriginValidation.details.poseMustBeARecord');
  float32(origin.x, 'x'); float32(origin.y, 'y');
  for (const key of ['offsetX', 'offsetY']) if (origin[key] !== undefined) float32(origin[key], key);
  if (!metadata?.support) {
    // Orphan pose metadata is retained for compatibility. Without a figure
    // descriptor its ghost set cannot be matched, but known values still need
    // to be valid; legacy figure metadata keeps its previous unknown fields.
    if (!metadata && own(origin, 'ghosts')) {
      if (!record(origin.ghosts)) fail('errors.animationOriginValidation.details.orphanGhostsMustBeAPoseRecord');
      const due = checkpoint(sliceMs); let count = 0;
      for (const key in origin.ghosts) if (own(origin.ghosts, key)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= MAX_BONES || String(index) !== key || ++count > MAX_BONES)
          fail('errors.animationOriginValidation.details.orphanGhostKeysMustBeCanonicalSupportBone');
        poseValues(origin.ghosts[key], GHOST_LABELS);
        const progress = due('ghosts'); if (progress) yield progress;
      }
    }
    return object;
  }
  if (!metadata.ghostCount) {
    if (own(origin, 'ghosts')) fail('errors.animationOriginValidation.details.poseMustOmitGhostsWhenTheSupportHas');
    return object;
  }
  if (!own(origin, 'ghosts') || !record(origin.ghosts)) fail('errors.animationOriginValidation.details.poseRequiresAllRetainedGhostBones');
  const due = checkpoint(sliceMs), ghosts = origin.ghosts;
  for (const index of metadata.ghostIndices) {
    if (!own(ghosts, index)) fail('errors.animationOriginValidation.details.poseIsMissingARetainedGhostBone');
    poseValues(ghosts[index], GHOST_LABELS);
    const progress = due('ghosts'); if (progress) yield progress;
  }
  let count = 0;
  for (const key in ghosts) if (own(ghosts, key)) {
    // Required numeric keys were checked above; equal own-key count excludes
    // extra keys, noncanonical aliases, and accidentally copied live poses.
    if (++count > metadata.ghostCount) fail('errors.animationOriginValidation.details.poseGhostsMustContainExactlyTheRetainedBone');
    const progress = due('ghosts'); if (progress) yield progress;
  }
  if (count !== metadata.ghostCount) fail('errors.animationOriginValidation.details.poseGhostsMustContainExactlyTheRetainedBone');
  return object;
}

export function validateOriginObject(object, figure) {
  const iterator = validateOriginObjectSteps(object, figure, {sliceMs: Infinity});
  for (;;) {const step = iterator.next(); if (step.done) return step.value;}
}
