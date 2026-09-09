/** Validate retained rig origins without rescanning their support graph per pose. */
const MAX_BONES = 100000;
const validated = new WeakMap();
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => {throw new Error(`Animation origin ${message}.`);};
const integer = (value, low, high, label) => {
  if (!Number.isInteger(value) || value < low || value > high) fail(`${label} must be an integer from ${low} to ${high}`);
};
const finite = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be finite`);
};
const float32 = (value, label) => {
  finite(value, label);
  if (!Number.isFinite(Math.fround(value))) fail(`${label} exceeds the native float32 range`);
};
function poseValues(pose, label) {
  if (!record(pose)) fail(`${label} must be a pose record`);
  finite(pose.angle_rad, `${label} angle`); finite(pose.bend_rad, `${label} bend`);
  float32(pose.length, `${label} length`);
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

export function invalidateOriginSupportValidation(figure) {validated.delete(figure);}

/** Full validation always scans the descriptor, including in-place edits. The
 * cache is published only after completion; object validation reuses it until
 * a descriptor/container changes or the topology owner invalidates it. */
export function* validateOriginSupportSteps(figure, origin = figure?._styk?.animationOrigin, {sliceMs = 4} = {}) {
  validated.delete(figure);
  if (origin === undefined) return null;
  if (!record(origin) || !Array.isArray(figure?.segments)) fail('must describe an existing figure');
  const due = checkpoint(sliceMs), handles = new Set([0]), liveHandles = new Set();
  for (const segment of figure.segments) {
    integer(segment.segment_id, 1, 65535, 'native handle');
    if (liveHandles.has(segment.segment_id)) fail('has repeated native handles');
    handles.add(segment.segment_id); liveHandles.add(segment.segment_id);
    const progress = due('handles'); if (progress) yield progress;
  }
  const support = origin.support;
  if (support === undefined) {
    if (!Number.isInteger(origin.handleId) || !handles.has(origin.handleId) ||
        !Number.isInteger(origin.rotationHandleId) || !liveHandles.has(origin.rotationHandleId) || typeof origin.reversed !== 'boolean')
      fail('must reference existing native handles');
    const metadata = Object.freeze({origin, support: null, ghostIndices: Object.freeze([]), ghostCount: 0});
    validated.set(figure, cacheEntry(figure, origin, metadata)); return metadata;
  }
  if (!record(support) || support.version !== 1 || !Array.isArray(support.bones) ||
      support.bones.length < 1 || support.bones.length > MAX_BONES) fail('support needs version 1 and 1–100,000 bones');
  const bones = support.bones, count = bones.length, bound = new Set(), ghosts = [], parents = new Int32Array(count);
  for (let index = 0; index < count; index++) {
    const bone = bones[index];
    if (!record(bone)) fail('support bone must be a record');
    integer(bone.parent, -1, count - 1, 'support parent');
    if (bone.parent === index) fail('support contains a self-parent cycle');
    parents[index] = bone.parent;
    if (typeof bone.reversed !== 'boolean') fail('support bone reversed must be boolean');
    poseValues(bone, 'support bone');
    if (bone.handleId === null) ghosts.push(index);
    else {
      if (!Number.isInteger(bone.handleId) || !liveHandles.has(bone.handleId) || bound.has(bone.handleId))
        fail('support must bind each existing segment exactly once');
      bound.add(bone.handleId);
    }
    const progress = due('bones'); if (progress) yield progress;
  }
  if (bound.size !== liveHandles.size) fail('support is missing a live segment binding');
  // Each parent edge is visited at most twice; no recursion or per-root walk.
  const state = new Uint8Array(count);
  for (let first = 0; first < count; first++) {
    let cursor = first;
    while (cursor !== -1 && state[cursor] === 0) {
      state[cursor] = 1; cursor = parents[cursor];
      const progress = due('ancestry'); if (progress) yield progress;
    }
    if (cursor !== -1 && state[cursor] === 1) fail('support contains a parent cycle');
    cursor = first;
    while (cursor !== -1 && state[cursor] === 1) {
      state[cursor] = 2; cursor = parents[cursor];
      const progress = due('ancestry'); if (progress) yield progress;
    }
    const progress = due('ancestry'); if (progress) yield progress;
  }
  if (!record(support.vertices)) fail('support vertices must be a record');
  const nodes = new Set(); let vertexCount = 0;
  for (const key in support.vertices) if (own(support.vertices, key)) {
    const id = Number(key), node = support.vertices[key];
    if (!Number.isInteger(id) || String(id) !== key || !handles.has(id)) fail('support vertex keys must be exact native handle IDs');
    integer(node, -1, count - 1, 'support vertex');
    if (nodes.has(node)) fail('support vertices must reference distinct nodes');
    nodes.add(node); vertexCount++;
    const progress = due('vertices'); if (progress) yield progress;
  }
  if (vertexCount !== handles.size) fail('support vertices must include every native handle and the origin');
  if (!Array.isArray(support.path) || support.path.length > MAX_BONES) fail('support path must contain at most 100,000 terms');
  for (const term of support.path) {
    if (!record(term)) fail('support path term must be a record');
    integer(term.bone, 0, count - 1, 'support path bone');
    if (term.sign !== 1 && term.sign !== -1) fail('support path sign must be exactly 1 or -1');
    const progress = due('path'); if (progress) yield progress;
  }
  integer(support.rotation, 0, count - 1, 'support rotation');
  if (origin.handleId !== null && (!Number.isInteger(origin.handleId) || !handles.has(origin.handleId) || support.vertices[String(origin.handleId)] !== -1))
    fail('handle must reference its original virtual root or be null');
  const rotation = bones[support.rotation];
  if (origin.rotationHandleId !== rotation.handleId || typeof origin.reversed !== 'boolean' ||
      rotation.handleId !== null && origin.reversed !== rotation.reversed)
    fail('rotation reference must match its support bone');
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
    if (figure?._styk?.animationOrigin !== undefined) fail('pose is missing its animation origin');
    return object;
  }
  if (!record(origin)) fail('pose must be a record');
  float32(origin.x, 'x'); float32(origin.y, 'y');
  for (const key of ['offsetX', 'offsetY']) if (origin[key] !== undefined) float32(origin[key], key);
  if (!metadata?.support) {
    // Orphan pose metadata is retained for compatibility. Without a figure
    // descriptor its ghost set cannot be matched, but known values still need
    // to be valid; legacy figure metadata keeps its previous unknown fields.
    if (!metadata && own(origin, 'ghosts')) {
      if (!record(origin.ghosts)) fail('orphan ghosts must be a pose record');
      const due = checkpoint(sliceMs); let count = 0;
      for (const key in origin.ghosts) if (own(origin.ghosts, key)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= MAX_BONES || String(index) !== key || ++count > MAX_BONES)
          fail('orphan ghost keys must be canonical support bone indexes');
        poseValues(origin.ghosts[key], 'ghost');
        const progress = due('ghosts'); if (progress) yield progress;
      }
    }
    return object;
  }
  if (!metadata.ghostCount) {
    if (own(origin, 'ghosts')) fail('pose must omit ghosts when the support has no ghost bones');
    return object;
  }
  if (!own(origin, 'ghosts') || !record(origin.ghosts)) fail('pose requires all retained ghost bones');
  const due = checkpoint(sliceMs), ghosts = origin.ghosts;
  for (const index of metadata.ghostIndices) {
    if (!own(ghosts, index)) fail('pose is missing a retained ghost bone');
    poseValues(ghosts[index], 'ghost');
    const progress = due('ghosts'); if (progress) yield progress;
  }
  let count = 0;
  for (const key in ghosts) if (own(ghosts, key)) {
    // Required numeric keys were checked above; equal own-key count excludes
    // extra keys, noncanonical aliases, and accidentally copied live poses.
    if (++count > metadata.ghostCount) fail('pose ghosts must contain exactly the retained bone indexes');
    const progress = due('ghosts'); if (progress) yield progress;
  }
  if (count !== metadata.ghostCount) fail('pose ghosts must contain exactly the retained bone indexes');
  return object;
}

export function validateOriginObject(object, figure) {
  const iterator = validateOriginObjectSteps(object, figure, {sliceMs: Infinity});
  for (;;) {const step = iterator.next(); if (step.done) return step.value;}
}
