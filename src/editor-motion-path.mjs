import {validationLabel} from "./validation-labels.mjs";
import {messageError} from './localized-error.mjs';
import {captureSpatialIK} from './ik-spatial.mjs';
/** Motion-path edit sessions. A dragged trail point rewrites the pose at its own
 * display tick while the playhead stays put. The session poses a cloned
 * evaluated frame, samples through a virtual report for live feedback, and
 * commits once through the same command shapes ordinary posing already records:
 * native object snapshots, a native keyframe split, animation-channel keys, or
 * a layer-sheet plan. */
import {evaluatedFrame, timeline, buildGeometry, shortest, isStatic} from './pivot/geometry.mjs';
import {rotationEdits, resolveJoinSelection} from './pivot/structure.mjs';
import {validateObjectChanges} from './pivot/model.mjs';
import {cameraValues} from './editor-camera.mjs';
import {inverseCameraScale} from './pivot/background.mjs';
import {ikLayout, ikChain, ikFollowers, ikFollowerIndices, ikBendReference, solveObjectIK, hasPinnedIK, translateIKTargets} from './ik.mjs';
import {ikComponents, joinedIKGraph} from './ik-joined.mjs';
import {snapshotPoseFrame, snapshotPoseObject, poseObjectSignature} from './pose-snapshot.mjs';
import {animationChannels, animationChannelId, animationPropertyValue} from './animation-channels.mjs';
import {draftAnimation, putKey, recordAnimation} from './editor-animation.mjs';
import {rotateOriginSupport} from './animation-origin-support.mjs';
import {planFalloff, normalizeFalloff} from './motion-path-falloff.mjs';
import {keyTicksForTarget} from './motion-path.mjs';
import {sheetKeyAt} from './layer-sheet.mjs';

const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const finite = (value, label) => { if (!Number.isFinite(value)) throw messageError(new Error(''), "errors.editorCamera.mustBeFinite", {label: validationLabel(label)}); return value; };

function rowForTick(rows, tick) {
  let low = 0, high = rows.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (rows[mid].start <= tick) low = mid; else high = mid - 1; }
  const row = rows[low];
  return {index: low, row, t: row?.count > 0 ? Math.min(1, Math.max(0, (tick - row.start) / row.count)) : 0};
}

/** Native camera bounds are float32; validate like ordinary camera edits. */
function checkedCamera(camera) {
  for (const field of ['x', 'y', 'scale', 'angle_rad']) finite(camera[field], `Camera ${field}`);
  for (const field of ['x', 'y', 'scale']) if (!Number.isFinite(Math.fround(camera[field]))) throw messageError(new Error(''), "errors.editorCamera.cameraExceedsTheNativeRange", {field: field});
  if (camera.scale <= 0) throw messageError(new Error(''), "errors.editorCamera.cameraScaleMustBePositive", {});
  inverseCameraScale(camera);
  return {...camera, is_default: camera.x === 0 && camera.y === 0 && camera.scale === 1 && camera.angle_rad === 0};
}

/** Join-connected slots on one frame — the maximal set a pose edit can reach. */
function componentSlots(frame, slot) {
  if (slot < 0) return [];
  for (const group of ikComponents(frame)) if (group.includes(slot)) return group;
  return [slot];
}

/** Scene-space pose of `working`; rebuilt only over slots the session touched. */
function sessionGeometry(session, report, extraDirty) {
  for (const slot of extraDirty ?? []) session.dirtySlots.add(slot);
  const dirty = new Set(session.dirtySlots);
  if (!session.geometry || dirty.size) {
    session.geometry = buildGeometry(report, session.working,
      {previous: session.geometry ?? {objects: new Map()}, dirtySlots: dirty.size ? dirty : new Set(session.working.objects.keys())});
  }
  session.dirtySlots.clear();
  return session.geometry;
}

/** `_objectEdit(posed:true)` semantics: bake the displayed IK solution into
 * authoritative angles before an ordinary rotation adjusts it. */
function bakePinnedPose(session, object, geometry) {
  const g = geometry.objects.get(object.object_slot), solved = g?.solvedAngles;
  for (const [id, result] of g?.ik ?? []) {
    const c = object._stykIK?.[id];
    if (!c?.enabled || !c.pinned || !result.followers) continue;
    object._stykIK = {...object._stykIK, [id]: {...c, followers: result.followers,
      ...(result.joinedFollowers ? {joinedFollowers: result.joinedFollowers} : {})}};
  }
  if (solved) object.angles = solved.slice();
  if (g?.solvedLengths) { object.len_flag = 1; object.lengths = g.solvedLengths.slice(); }
}

/** `_applyJointRotation` + `_rotateIKFollowers` on a remote frame. */
function applyRotation(session, report, targets, delta) {
  const {working, target} = session, slot = working.objects.findIndex(o => o.unique_id === target.uid);
  const object = working.objects[slot];
  const figure = report.figure_types.find(f => f.figure_type_id === object.figure_type_id);
  const slots = componentSlots(working, slot);
  const graph = slots.length > 1 ? joinedIKGraph(report, working, slots) : null;
  const followerFigure = graph?.figure ?? figure;
  const source = graph?.object ?? object, layout = graph?.layout ?? ikLayout(followerFigure);
  const selected = new Set(targets.map(([s, i]) => `${s}:${i}`));
  const entryAt = i => graph?.entries[i] ?? {slot, index: i, handle: figure.segments[i].segment_id, uid: working.objects[slot].unique_id};
  if (delta && session.baseline.some(hasPinnedIK)) for (const [id, c] of Object.entries(source._stykIK ?? {})) {
    if (!c.enabled || !c.pinned) continue;
    const endpoint = layout.ids.get(Number(id)); if (endpoint === undefined) continue;
    const owner = entryAt(endpoint);
    if (selected.has(`${owner.slot}:${owner.index}`)) continue;
    const ownerObject = working.objects[owner.slot], current = ownerObject._stykIK?.[owner.handle];
    if (!current) continue;
    let next;
    // Follower indices and offsets belong to the same skeleton as the layout.
    const followers = ikFollowers(followerFigure, source, id, c, layout);
    for (const i of ikFollowerIndices(followerFigure, id, layout)) {
      const child = entryAt(i);
      if (child.slot === slot && child.index === target.joint) continue;
      if (!selected.has(`${child.slot}:${child.index}`)) continue;
      next ??= {...current, followers: {...current.followers}, joinedFollowers: {...current.joinedFollowers}};
      const angle = followers[followerFigure.segments[i].segment_id] + delta;
      if (child.slot === owner.slot) next.followers[child.handle] = angle;
      else next.joinedFollowers[child.uid] = {...next.joinedFollowers[child.uid], [child.handle]: angle};
    }
    if (next) { ownerObject._stykIK = {...ownerObject._stykIK, [owner.handle]: next}; session.dirtySlots.add(owner.slot); delete ownerObject.runtime_segments; }
  }
  const children = new Set();
  for (const [objectSlot, segment] of targets) {
    working.objects[objectSlot].angles[segment] += delta;
    delete working.objects[objectSlot].runtime_segments;
    session.dirtySlots.add(objectSlot);
    if (objectSlot !== slot) children.add(objectSlot);
  }
  for (const childSlot of children)
    rotateOriginSupport(report.figure_types.find(f => f.figure_type_id === working.objects[childSlot].figure_type_id), working.objects[childSlot], delta);
}

/** Remote `poseIKTarget`: pinned controllers move their target; free
 * controllers bake a solved pose and persist the captured articulation. */
function poseIKRemote(session, report, slot, point) {
  const {working, target} = session, object = working.objects[slot];
  const figure = report.figure_types.find(f => f.figure_type_id === object.figure_type_id);
  const controller = object._stykIK?.[target.handleId];
  if (!controller?.enabled) return false;
  const slots = componentSlots(working, slot);
  const scene = sessionGeometry(session, report, slots);
  const geometry = scene.objects.get(slot);
  if (!geometry) return false;
  const next = {...controller, target: {...controller.target, x: point.x, y: point.y}};
  if (controller.pinned) {
    object._stykIK = {...object._stykIK, [target.handleId]: next};
    delete object.runtime_segments; session.dirtySlots.add(slot);
    return true;
  }
  const baselines = new Map(session.baseline.map(o => [o.object_slot, o]));
  const graph = slots.length > 1 ? joinedIKGraph(report, working, slots) : null;
  if (graph) {
    const chain = graph.chain(slot, target.handleId, controller.chainLength);
    if (!chain.length) return false;
    const shapes = chain.map(i => { const e = graph.entries[i]; return scene.objects.get(e.slot).segments[e.index]; });
    const rotation = controller.target?.rotation ?? 0, followers = {}, joinedFollowers = {}, spatialFollowers={},joinedSpatialFollowers={};
    const id = graph.maps.get(slot).get(target.handleId);
    for (const i of ikFollowerIndices(graph.figure, id, graph.layout)) {
      const entry = graph.entries[i], angle = scene.objects.get(entry.slot).segments[entry.index].angle - rotation;
      if (entry.slot === slot) followers[entry.handle] = angle;
      else (joinedFollowers[entry.uid] ??= {})[entry.handle] = angle;
      const g=scene.objects.get(entry.slot),q=captureSpatialIK(g.fig,g.obj,g,[],[entry.index],rotation).spatialFollowers?.[entry.handle];
      if(q){if(entry.slot===slot)spatialFollowers[entry.handle]=q;else(joinedSpatialFollowers[entry.uid]??={})[entry.handle]=q;}
    }
    const captured = {target: {...geometry.joints.get(target.handleId), rotation}, followers, joinedFollowers,spatialFollowers,joinedSpatialFollowers,
      bendDirection: controller.bendDirection,
      bendReference: ikBendReference([shapes[0].start, ...shapes.map(s => s.end)], shapes.map(s => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y)), controller.bendReference)};
    const temporary = {...next, ...captured, target: next.target, pinned: true};
    for (let i = 0; i < graph.entries.length; i++) {
      const entry = graph.entries[i], baseline = baselines.get(entry.slot), g = scene.objects.get(entry.slot);
      graph.object.lengths[i] = (baseline?.len_flag ? baseline.lengths[entry.index] : g.fig.segments[entry.index].length) * entry.scale;
    }
    const solved = graph.solve({[id]: graph.mapController(slot, target.handleId, temporary)});
    for (const [s, result] of graph.scatter(solved)) {
      const entryObject = working.objects[s], baseline = baselines.get(s);
      entryObject.angles = result.angles;
      entryObject.len_flag = result.lengths ? 1 : baseline?.len_flag ?? 0;
      entryObject.lengths = (result.lengths ?? baseline?.lengths ?? []).slice();
      delete entryObject.runtime_segments; session.dirtySlots.add(s);
    }
    Object.assign(next, {followers: temporary.followers, joinedFollowers: temporary.joinedFollowers,spatialFollowers:temporary.spatialFollowers,joinedSpatialFollowers:temporary.joinedSpatialFollowers,
      bendDirection: temporary.bendDirection, bendReference: solved.results.get(id)?.bendReference ?? captured.bendReference});
  } else {
    const index = figure.segments.findIndex(s => s.segment_id === target.handleId);
    if (index < 0) return false;
    const rotation = controller.target?.rotation ?? 0, followers = {};
    for (const i of ikFollowerIndices(figure, target.handleId)) {
      const s = geometry.segments[i]; followers[s.seg.segment_id] = s.angle - rotation;
    }
    const chain = ikChain(figure, target.handleId, controller.chainLength ?? 2);
    let bendDirection = controller.bendDirection ?? 1;
    if (chain.length >= 2) {
      const a = geometry.segments[chain[0]].start, c = geometry.segments[chain.at(-1)].end;
      let cross = 0;
      for (const i of chain.slice(0, -1)) {
        const b = geometry.segments[i].end, value = (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
        if (Math.abs(value) > Math.abs(cross)) cross = value;
      }
      if (Math.abs(cross) > 1e-8) bendDirection = cross < 0 ? -1 : 1;
    }
    const points = [geometry.segments[chain[0]].start, ...chain.map(i => geometry.segments[i].end)];
    const lengths = chain.map(i => { const s = geometry.segments[i]; return Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y); });
    const captured = {...captureSpatialIK(figure,object,geometry,chain,ikFollowerIndices(figure,target.handleId),rotation),target: {...geometry.joints.get(target.handleId), rotation}, followers,
      bendDirection: controller.bendDirection ?? bendDirection,
      bendReference: ikBendReference(points, lengths, controller.bendReference)};
    const temporary = {...next, ...captured, target: next.target, pinned: true};
    const baseline = baselines.get(slot) ?? object;
    const source = {...object, len_flag: baseline.len_flag, lengths: baseline.lengths};
    const solution = solveObjectIK(figure, source, geometry.root, ikLayout(figure), {[target.handleId]: temporary});
    object.angles = solution.angles;
    object.len_flag = solution.lengths ? 1 : baseline.len_flag;
    object.lengths = (solution.lengths ?? baseline.lengths).slice();
    delete object.runtime_segments; session.dirtySlots.add(slot);
    next.followers = temporary.followers;
    if(temporary.spatialFollowers)next.spatialFollowers=temporary.spatialFollowers;
    if(temporary.spatialTarget)next.spatialTarget=temporary.spatialTarget;
    next.bendReference = solution.results.get(target.handleId)?.bendReference ?? temporary.bendReference;
  }
  object._stykIK = {...object._stykIK, [target.handleId]: next};
  return true;
}

function applyPathPoint(session, editor, point, options = {}) {
  const {working, target} = session, report = editor.report;
  if (target.kind === 'camera') {
    const current = cameraValues(working.camera);
    const next = checkedCamera({...current,
      x: point.x - report.canvas_width / 2, y: point.y - report.canvas_height / 2});
    if (same(current, next)) return false;
    working.camera = next;
    return true;
  }
  const slot = working.objects.findIndex(o => o.unique_id === target.uid);
  if (slot < 0) return false;
  const object = working.objects[slot];
  const figure = report.figure_types.find(f => f.figure_type_id === object.figure_type_id);
  if (!figure) return false;
  if (target.handleId === 0) {
    const resolved = resolveJoinSelection(working, new Set([target.uid]), true);
    const ids = new Set(resolved.affectedUids);
    session.dirtySlots = new Set(resolved.affectedSlots);
    const geometry = sessionGeometry(session, report);
    const origin = geometry.objects.get(slot)?.joints.get(0);
    if (!origin) return false;
    session.translationOrigin ??= {x: origin.x, y: origin.y};
    const dx = point.x - origin.x, dy = point.y - origin.y;
    let changed = Boolean(dx || dy);
    for (const member of working.objects) if (ids.has(member.unique_id) && member.join && !ids.has(working.objects[member.join.target_object_slot]?.unique_id)) {
      const root = geometry.objects.get(member.object_slot)?.root;
      if (root) { member.root_x = root.x; member.root_y = root.y; }
      member.join = null;
    }
    for (const member of working.objects) if (ids.has(member.unique_id) && !member.join) {
      member.root_x += dx; member.root_y += dy; delete member.runtime_segments;
    }
    for (const member of working.objects) if (ids.has(member.unique_id)) {
      const moved = translateIKTargets(member,
        options.movePins ? point.x - session.translationOrigin.x : 0,
        options.movePins ? point.y - session.translationOrigin.y : 0,
        {source: session.source.objects[member.object_slot], pinnedOnly: true});
      if (moved) {delete member.runtime_segments; changed = true;}
    }
    session.dirtySlots = new Set(resolved.affectedSlots);
    return changed;
  }
  const controller = object._stykIK?.[target.handleId];
  if (controller?.enabled) return poseIKRemote(session, report, slot, point);
  const segment = figure.segments[target.joint];
  if (!segment || isStatic(segment)) return false;
  // Pose-on-pinned semantics bake the displayed solution before rotating.
  if (session.baseline.some(hasPinnedIK)) {
    const slots = componentSlots(working, slot), scene = sessionGeometry(session, report, slots);
    for (const member of working.objects) if (hasPinnedIK(member)) { bakePinnedPose(session, member, scene); session.dirtySlots.add(member.object_slot); }
  }
  const geometry = sessionGeometry(session, report, [slot]);
  const shape = geometry.objects.get(slot)?.segments[target.joint];
  if (!shape) return false;
  const angle = Math.atan2(point.y - shape.start.y, point.x - shape.start.x) - shape.bend / 2;
  const delta = shortest(angle - shape.angle);
  if (!delta && !options.stretch) return false;
  session.rotationTargets ??= new Map();
  const key = `${slot}:${target.joint}${options.isolate ? ':isolated' : ''}`;
  let targets = session.rotationTargets.get(key);
  if (!targets) {
    targets = rotationEdits({...report, keyframes: [working]}, 0, slot, target.joint, 0, true, {isolate: options.isolate})
      .map(change => { const tokens = change.path.split('/'); return [Number(tokens[4]), Number(tokens[6])]; });
    session.rotationTargets.set(key, targets);
  }
  applyRotation(session, report, targets, delta);
  if (options.stretch && Math.abs(object.scale) > 1e-8) {
    if (!object.len_flag) object.lengths = figure.segments.map(s => s.length);
    object.len_flag = 1;
    const bend = shape.bend, chord = Math.abs(bend) < 1e-7 ? 1 : Math.abs(2 * Math.sin(bend / 2) / bend);
    if (chord < 1e-8) throw messageError(new Error(''), "errors.editorMotionPath.reduceTheFullCircleBendBeforeStretchingThis", {});
    object.lengths[target.joint] = Math.hypot(point.x - shape.start.x, point.y - shape.start.y) / (Math.abs(object.scale) * chord);
    delete object.runtime_segments; session.dirtySlots.add(slot);
  }
  return true;
}

/** Persist bend references for pinned free-bend controllers, like touch(). */
function rememberBends(session, report) {
  let geometry;
  for (const before of session.baseline) {
    const object = session.working.objects.find(o => o.unique_id === before.unique_id);
    if (!object) continue;
    for (const [id, c] of Object.entries(object._stykIK ?? {})) {
      if (!c.enabled || !c.pinned || c.bendDirection !== 0) continue;
      geometry ??= sessionGeometry(session, report);
      let reference = geometry.objects.get(object.object_slot)?.ik?.get(Number(id))?.bendReference;
      if (!reference) continue;
      const baseline = before._stykIK?.[id]?.bendReference;
      const closeAngle = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-7;
      if (baseline && reference.side === baseline.side && closeAngle(reference.angle, baseline.angle) &&
          closeAngle(reference.axis, baseline.axis) && Math.abs(reference.ratio - baseline.ratio) < 1e-7 &&
          reference.shape?.length === baseline.shape?.length && (!reference.shape || reference.shape.every((a, i) => closeAngle(a, baseline.shape[i])))) reference = baseline;
      object._stykIK = {...object._stykIK, [id]: {...c, bendReference: reference}};
    }
  }
}

/** Uids whose authoritative pose fields differ from the captured source. */
function changedUids(session) {
  const previous = new Map(session.source.objects.map(o => [o.unique_id, o])), changed = new Set();
  for (const object of session.working.objects) {
    const before = previous.get(object.unique_id);
    if (!before || poseObjectSignature(before, session.source) !== poseObjectSignature(object, session.working)) changed.add(object.unique_id);
  }
  return changed;
}

function sessionHasChanges(session) {
  if (session.target.kind === 'camera') return !same(cameraValues(session.source.camera), session.working.camera);
  return changedUids(session).size > 0;
}

/** Playhead slots whose geometry the session may have changed — the edited
 * object's join/IK component, resolved in the displayed frame. */
function previewDirtySlots(session, frame) {
  if (session.target.kind !== 'node') return new Set();
  const slot = frame.objects.findIndex(o => o.unique_id === session.target.uid);
  return new Set(componentSlots(frame, slot));
}

/** Rebuild the virtual report and decide whether the playhead pose changed. */
function refreshSession(editor, session) {
  const report = editor.report;
  if (session.mode === 'key') session.report = {...report, keyframes: report.keyframes.map((f, i) => i === session.index ? session.working : f)};
  else if (session.mode === 'split') session.report = {...report, keyframes: session.frames};
  else if (session.mode === 'channels') session.report = {...report, _styk: {...report._styk,
    animation: session.draft.after, frameSources: {...report._styk.frameSources, ...session.draft.sources}}};
  else session.report = {...report, _styk: {...report._styk, layerSheet: session.sheet.plan.state, layers: session.sheet.plan.layers,
    frameSources: {...report._styk.frameSources, ...Object.fromEntries(session.sheet.plan.sources.map(s => [s.id, s.after.value]))}}};
  refreshDisplay(editor, session);
}

/** The playhead's pose while the virtual report changes it, or null outside the ticks it changes. */
function displayOf(editor, session) {
  const tick = editor.tick;
  if (tick < session.range[0] || tick >= session.range[1]) return null;
  const rows = timeline(session.report), {index, t} = rowForTick(rows, tick);
  const frame = evaluatedFrame(session.report, index, t, tick);
  const dirty = previewDirtySlots(session, frame);
  return {frame, geometry: dirty.size ? buildGeometry(session.report, frame, {previous: editor.geometry ?? {objects: new Map()}, dirtySlots: dirty}) : null};
}

function refreshDisplay(editor, session) { session.display = displayOf(editor, session); }

/** Write the working pose into animation channels at the session tick. Keys and
 * retained sources are rewritten in place across pointer moves, so one gesture
 * produces one key per owner. */
function writeChannels(editor, session, {changed = changedUids(session), forceCamera = false} = {}) {
  const {draft, working, tick} = session;
  const byOwner = new Map();
  for (const uid of changed) {
    const independent = editor.animationChannel({kind: 'figure', uid}, 'pose');
    const owner = independent ? {kind: 'figure', uid} : {kind: 'layer', id: editor.layerForUid(uid)};
    const key = animationChannelId(owner, 'pose');
    if (!byOwner.has(key)) byOwner.set(key, {target: owner});
    byOwner.get(key).uids ??= new Set();
  }
  for (const [key, {target}] of byOwner) {
    const capture = target.kind === 'figure' ? [target.uid]
      : working.objects.filter(o => editor.layerForUid(o.unique_id) === target.id).map(o => o.unique_id);
    const source = (session.snapshot ?? snapshotPoseFrame)(working, capture);
    let id = session.sourceIds.get(key);
    if (!id) {
      id = `frame-${editor._nextFrameIdentity++}`; session.sourceIds.set(key, id);
      source._styk = {...source._styk, frameId: id}; draft.sources[id] = source;
      putKey(editor, draft, {target, property: 'pose', tick, value: {frameId: id}, exactTarget: true});
      session.touched.add(animationChannelId(target, 'pose'));
    } else { source._styk = {...source._styk, frameId: id}; draft.sources[id] = source; }
  }
  if (session.target.kind === 'camera' && (session.cameraChanged || forceCamera)) {
    const base = cameraValues(session.source.camera), next = cameraValues(working.camera);
    for (const [property, field] of [['x', 'x'], ['y', 'y'], ['scale', 'scale'], ['rotation', 'angle_rad']])
      if (base[field] !== next[field] || (forceCamera && (field === 'x' || field === 'y'))) {
        putKey(editor, draft, {target: {kind: 'camera'}, property, tick, value: next[field], exactTarget: true});
        session.touched.add(animationChannelId({kind: 'camera'}, property));
      }
  }
  // A moved figure's authored scalar curves must re-key at the same tick or
  // they would pull the pose back toward the old channel value.
  let geometry;
  for (const channel of editor.animationChannels) {
    if (channel.property === 'pose' || !channel.keys.length || channel.target.kind === 'camera') continue;
    const uid = channel.target.uid;
    if (uid === undefined || !changed.has(uid)) continue;
    const value = animationPropertyValue(editor.report, working, channel.target, channel.property,
      {resolveGeometry: (r, f) => geometry ??= sessionGeometry(session, editor.report)});
    if (value !== undefined) {
      putKey(editor, draft, {target: channel.target, property: channel.property, tick, value, exactTarget: true});
      session.touched.add(channel.id);
    }
  }
  // The visible window of a path edit is bounded by the keys surrounding the
  // edited tick on every channel the gesture wrote.
  session.range = [tick, tick + 1];
  for (const id of session.touched) {
    const channel = draft.after.channels.find(c => c.id === id);
    const keys = (channel?.keys ?? []).filter(k => !k.hidden).map(k => k.tick);
    const before = keys.filter(t => t < tick), after = keys.filter(t => t > tick);
    session.range[0] = Math.min(session.range[0], before.length ? Math.max(...before) : tick);
    session.range[1] = Math.max(session.range[1], after.length ? Math.min(...after) : editor.totalTicks);
  }
}

/** Key ticks a falloff edit may move: the target's own keys, or every stored
 * pose row in a native document. */
function falloffKeys(editor, target) {
  const owned = keyTicksForTarget(editor, target);
  if (owned) return [...owned];
  return editor.timeline.filter(row => row.count > 0).map(row => row.start);
}

/** Whether a native write lands on a stored pose (edited in place) or inside a
 * tween (split there). */
const atRowStart = write => write.ratio <= 0;

/** One write of a falloff edit: its own working pose at its own tick, reusing
 * the single-frame session shape so the same pose semantics apply. */
function falloffWrite(editor, session, write, component) {
  const report = editor.report, rows = editor.timeline, {index, row, t} = rowForTick(rows, write.tick);
  if (!row) return null;
  const source = write.tick === editor.tick ? editor.evaluatedFrame : evaluatedFrame(report, index, t, write.tick);
  if (!source) return null;
  const native = session.mode === 'native';
  const stored = native && t <= 0 ? report.keyframes[index] : null;
  const baseline = session.target.kind !== 'node' ? []
    : (stored ?? source).objects.filter(o => component.has(o.unique_id)).map(o => snapshotPoseObject(o));
  const sub = {motionPath: true, target: session.target, tick: write.tick, weight: write.weight, kind: write.kind,
    index, row, ratio: t, mode: session.mode, source, working: snapshotPoseFrame(source), baseline,
    dirtySlots: new Set(), geometry: null, rotationTargets: null, cameraChanged: false, moved: false,
    sourceIds: new Map(), touched: session.touched, draft: session.draft, range: [write.tick, write.tick + 1]};
  if (stored) sub.working._styk = {...sub.working._styk, frameId: stored._styk?.frameId};
  if (session.target.kind === 'camera') {
    const camera = cameraValues(sub.working.camera);
    sub.origin = {x: report.canvas_width / 2 + camera.x, y: report.canvas_height / 2 + camera.y};
  } else {
    const slot = sub.working.objects.findIndex(o => o.unique_id === session.target.uid);
    sub.origin = sessionGeometry(sub, report).objects.get(slot)?.joints.get(session.target.handleId) ?? null;
    if (!sub.origin) return null;
  }
  // Only the component and pinned figures the pose rules may bake can change.
  const refresh = new Set(sub.working.objects.filter(o => component.has(o.unique_id) || hasPinnedIK(o)).map(o => o.unique_id));
  sub.snapshot = incrementalPoseSnapshot(refresh);
  if (session.mode === 'sheet') sub.sheet = {tick: write.tick, plan: session.sheet.plan, writes: new Map(), snapshot: sub.snapshot};
  return sub;
}

/** Sheet writes resolve holds to their key: two writes resolving to the same
 * key of the same track keep the stronger one, and edges never rewrite a hold. */
function sheetClaim(editor, session, sub, id) {
  const known = sub.claims?.get(id);
  if (known !== undefined) return known;
  const {key} = sheetKeyAt(session.sheet.plan.get(id), sub.tick);
  const held = key && (['constant', 'hold'].includes(key.interpolation) || key.movieclipPatches);
  const at = held ? key.tick : sub.tick, claim = `${id}:${at}`;
  const allowed = !(sub.kind === 'edge' && held) && !session.claims.has(claim);
  if (allowed) session.claims.add(claim);
  (sub.claims ??= new Map()).set(id, allowed);
  return allowed;
}

/** A pose capture for repeated writes of one falloff frame. Only `refresh`
 * uids can change between pointer moves, so later captures reuse the first
 * capture's other records and snapshot just those; the result equals a fresh
 * `snapshotPoseFrame`. Superseded captures are dropped by their owners. */
export function incrementalPoseSnapshot(refresh) {
  const bases = new Map();
  return (frame, uids) => {
    const key = uids ? [...uids].join(',') : '*', base = bases.get(key);
    if (!base) { const first = snapshotPoseFrame(frame, uids); bases.set(key, {...first}); return first; }
    const slotOf = new Map(frame.objects.map((object, slot) => [object.unique_id, slot]));
    const indexOf = new Map(base.objects.map((object, index) => [object.unique_id, index]));
    const objects = base.objects.map((record, index) => {
      if (!refresh.has(record.unique_id)) return record;
      const fresh = snapshotPoseObject(frame.objects[slotOf.get(record.unique_id)]);
      fresh.object_slot = index;
      if (fresh.join) fresh.join = {...fresh.join, target_object_slot: indexOf.get(frame.objects[fresh.join.target_object_slot]?.unique_id) ?? fresh.join.target_object_slot};
      return fresh;
    });
    return {...base, objects};
  };
}

/** Uids a falloff write changed. Only the dragged component can move, plus
 * pinned-IK figures whose displayed solution the pose rules bake, so dense
 * scenes compare a handful of objects instead of the whole frame. */
function falloffChanged(sub, component) {
  const before = new Map(sub.source.objects.map(o => [o.unique_id, o])), changed = new Set();
  for (const object of sub.working.objects) {
    if (!component.has(object.unique_id) && !hasPinnedIK(object)) continue;
    const previous = before.get(object.unique_id);
    if (!previous || poseObjectSignature(previous, sub.source) !== poseObjectSignature(object, sub.working)) changed.add(object.unique_id);
  }
  return changed;
}

/** Record the edited poses into the mode's store (channels or sheet); native
 * documents are rebuilt as a whole in `falloffNativeFrames`. Edges write the
 * unchanged component so the original pose holds there. */
function writeFalloff(editor, session, sub, component) {
  const edge = sub.kind === 'edge';
  if (!edge && !sub.moved) return;
  const changed = edge ? new Set(session.target.kind === 'node' ? component : []) : sub.changed;
  if (session.mode === 'channels') { writeChannels(editor, sub, {changed, forceCamera: edge}); return; }
  if (session.mode !== 'sheet') return;
  const owners = new Set();
  for (const uid of changed) owners.add(editor.layerForUid(uid));
  if (session.target.kind === 'camera') owners.add('camera');
  for (const id of owners) if (sheetClaim(editor, session, sub, id)) editor._sheetPoseDraftWrite(sub.sheet, id, sub.working, changed);
}

/** A stored native pose with the edited component written over it. */
function storedCandidate(stored, working, ids, camera) {
  const edited = new Map(working.objects.map(o => [o.unique_id, o]));
  return {...stored, camera: camera ? working.camera : stored.camera, objects: stored.objects.map(o =>
    ids.has(o.unique_id) && edited.has(o.unique_id) ? {...edited.get(o.unique_id), object_slot: o.object_slot} : o)};
}

/** The native keyframe list after the edit: edited stored poses in place and
 * rows split at the grabbed frame and edges. `first..last` bound the rows. */
function falloffNativeFrames(editor, session, {commit = false} = {}) {
  const frames = editor.report.keyframes, byRow = new Map();
  for (const sub of session.subs) if (sub.moved || sub.kind === 'edge') {
    if (!byRow.has(sub.index)) byRow.set(sub.index, []);
    byRow.get(sub.index).push(sub);
  }
  const indices = [...byRow.keys()].sort((a, b) => a - b);
  if (!indices.length) return null;
  const first = indices[0], last = indices.at(-1), after = [];
  for (let index = first; index <= last; index++) {
    const stored = frames[index], subs = byRow.get(index)?.sort((a, b) => a.tick - b.tick) ?? [];
    if (!subs.length) { after.push(stored); continue; }
    const row = subs[0].row, head = subs.find(atRowStart), splits = subs.filter(sub => !atRowStart(sub));
    let pose = stored;
    if (head?.moved) {
      pose = storedCandidate(stored, head.working, session.component, session.target.kind === 'camera');
      if (commit) pose = settleStoredPose(editor, stored, pose, session.component);
    }
    const bounds = [...splits.map(sub => sub.tick), row.start + row.count];
    after.push(splits.length ? {...pose, duration_raw: bounds[0] - row.start} : pose);
    splits.forEach((sub, i) => {
      const piece = commit ? clone(sub.working) : {...sub.working};
      piece.duration_raw = bounds[i + 1] - sub.tick;
      after.push(piece);
    });
  }
  return {first, last, after, timing: indices.some(index => byRow.get(index).some(sub => !atRowStart(sub)))};
}

/** Commit-time checks for an edited stored pose, as a single-frame key edit
 * performs them: validation, clean runtime fields and joined roots. */
function settleStoredPose(editor, stored, candidate, component) {
  const storedByUid = new Map(stored.objects.map(o => [o.unique_id, o])), ids = new Set();
  const objects = candidate.objects.map(object => {
    if (!component.has(object.unique_id)) return object;
    if (poseObjectSignature(storedByUid.get(object.unique_id), stored) === poseObjectSignature(object, candidate)) return storedByUid.get(object.unique_id);
    ids.add(object.unique_id);
    const clean = clone(object); delete clean.runtime_segments; delete clean._movieclipSample;
    return clean;
  });
  const settled = {...candidate, objects};
  if (!ids.size) return settled;
  validateObjectChanges(editor.report, settled, ids);
  if (objects.some(object => object.join && ids.has(object.unique_id))) {
    const geometry = buildGeometry(editor.report, settled);
    for (const object of objects) if (object.join && ids.has(object.unique_id)) {
      const root = geometry.objects.get(object.object_slot)?.root;
      if (root) { object.root_x = root.x; object.root_y = root.y; }
    }
  }
  return settled;
}

/** Rebuild the virtual report and the frames a live trail must resample. */
function refreshFalloff(editor, session) {
  const report = editor.report;
  if (session.mode === 'native') {
    const plan = falloffNativeFrames(editor, session);
    session.report = plan ? {...report, keyframes: [...report.keyframes.slice(0, plan.first), ...plan.after, ...report.keyframes.slice(plan.last + 1)]} : report;
  } else if (session.mode === 'channels') session.report = {...report, _styk: {...report._styk,
    animation: session.draft.after, frameSources: {...report._styk?.frameSources, ...session.draft.sources}}};
  else {
    const plan = session.sheet.plan;
    session.report = {...report, _styk: {...report._styk, layerSheet: plan.state, layers: plan.layers,
      frameSources: {...report._styk.frameSources, ...Object.fromEntries(plan.sources.map(s => [s.id, s.after.value]))}}};
  }
  // Frames between the keys around the written ticks follow the new keys.
  const ticks = session.subs.map(sub => sub.tick), keys = session.keys;
  const low = Math.min(...ticks), high = Math.max(...ticks);
  session.range = [Math.max(0, ...keys.filter(k => k < low)), Math.min(editor.totalTicks, ...keys.filter(k => k > high).map(k => k + 1), editor.totalTicks)];
  refreshDisplay(editor, session);
}

/** Start a falloff session: plan the writes and capture each one's pose. */
function beginFalloff(editor, session, component) {
  const keys = falloffKeys(editor, session.target);
  session.keys = keys.sort((a, b) => a - b);
  session.component = component;
  session.touched = new Set();
  session.claims = new Set();
  if (session.mode === 'channels') session.draft = draftAnimation(editor);
  if (session.mode === 'sheet') {
    const owners = new Set(session.target.kind === 'camera' ? ['camera'] : []);
    for (const uid of component) owners.add(editor.layerForUid(uid));
    session.sheet = editor._sheetPoseDraftBegin(session.tick, [...owners]);
  }
  const writes = planFalloff({tick: session.tick, radius: session.falloff.radius, shape: session.falloff.shape,
    keys: session.keys, totalTicks: editor.totalTicks});
  // Stronger writes claim shared hold keys first.
  const priority = write => write.kind === 'grab' ? 3 : write.kind === 'key' ? 1 + write.weight : 0;
  session.subs = [];
  for (const write of [...writes].sort((a, b) => priority(b) - priority(a))) {
    const sub = falloffWrite(editor, session, write, component);
    if (sub) session.subs.push(sub);
    else if (write.kind === 'grab') return false;
  }
  session.grab = session.subs[0];
  session.writes = writes.filter(write => session.subs.some(sub => sub.tick === write.tick));
  session.report = editor.report;
  return true;
}

function updateFalloff(editor, session, point, options) {
  const delta = {x: point.x - session.grab.origin.x, y: point.y - session.grab.origin.y};
  for (const sub of session.subs) {
    if (!sub.weight) continue;
    const target = sub === session.grab ? point : {x: sub.origin.x + delta.x * sub.weight, y: sub.origin.y + delta.y * sub.weight};
    if (!applyPathPoint(sub, editor, target, options)) continue;
    sub.moved = true;
    editor._synchronizeAnimationOrigins(sub.working, sub.baseline.length ? sub.baseline : sub.source.objects);
    if (sub.target.kind === 'camera') sub.cameraChanged = true;
    sub.changed = falloffChanged(sub, session.component);
  }
  session.moved = session.subs.some(sub => sub.moved);
  if (!session.moved) return;
  // Edges are written once they have something to hold against.
  for (const sub of session.subs) if (sub.kind !== 'edge' || !sub.written) { writeFalloff(editor, session, sub, session.component); sub.written = true; }
  refreshFalloff(editor, session);
}

function commitFalloff(editor, session) {
  const changed = session.subs.filter(sub => sub.moved && (sub.cameraChanged ? sessionHasChanges(sub) : sub.changed.size));
  if (!session.moved || !changed.length) {
    editor._drag = null;
    editor._emit('edit', {motionPath: true});
    return false;
  }
  for (const sub of session.subs) if (sub.moved) { rememberBends(sub, editor.report); sub.changed = falloffChanged(sub, session.component); }
  if (session.mode === 'native') {
    let plan;
    try { plan = falloffNativeFrames(editor, session, {commit: true}); }
    catch (error) { editor.cancelMotionPathEdit(); throw error; }
    const before = editor.report.keyframes.slice(plan.first, plan.last + 1).map(frame => clone(frame));
    const previous = new Map(editor.report.keyframes.map(frame => [frame._styk?.frameId, frame]));
    const inserted = plan.after.map(frame => clone(frame));
    editor.report.keyframes.splice(plan.first, before.length, ...inserted);
    editor._reconcileFrameIds(previous);
    const command = {kind: 'ranges', label: session.label,
      changes: [{index: plan.first, before, after: clone(editor.report.keyframes.slice(plan.first, plan.first + inserted.length))}],
      beforeSelection: session.beforeSelection, structural: false, timing: plan.timing};
    editor._captureRemovedFrameSources(command);
    editor._invalidate({timing: plan.timing});
    editor.frameIndex = rowForTick(editor.timeline, editor.tick).index;
    command.afterSelection = editor._selectionState();
    editor._drag = null;
    editor._record(command);
    editor._emit('edit', {label: session.label, structural: false, timing: plan.timing,
      frameIndices: Array.from({length: inserted.length}, (_, i) => plan.first + i)});
    return true;
  }
  // Recapture after bend references settle so the stored sources include them.
  for (const sub of session.subs) if (sub.moved) writeFalloff(editor, session, sub, session.component);
  editor._drag = null;
  if (session.mode === 'channels') { recordAnimation(editor, session.label, session.draft, session.beforeSelection); return true; }
  if (!session.subs.some(sub => sub.sheet.writes.size)) { editor._emit('edit', {motionPath: true}); return false; }
  editor._sheetPoseDraftPublish(session.sheet, session.label, session.beforeSelection);
  return true;
}

export const editorMotionPathMethods = {
  /** Begin a remote-time pose edit for a motion-path point. Never seeks.
   * `falloff: {radius, shape}` reshapes the arc: nearby keys follow by weight. */
  beginMotionPathEdit(target, tick, {label, falloff} = {}) {
    if (!Number.isInteger(tick) || tick < 0 || tick >= this.totalTicks) return false;
    const request = {target: {...target}, tick, label};
    falloff = normalizeFalloff(falloff);
    label ??= falloff ? 'Reshape motion path' : 'Edit motion path';
    if (this._drag) this.commitDrag();
    if (this._animationEdit) this.commitAnimationEdit();
    if (this.report._styk?.movieclipSource || this.report._styk?.simpleFrameDraft) return false;
    const rows = this.timeline, {index, row, t} = rowForTick(rows, tick);
    if (!row) return false;
    const source = tick === this.tick ? this.evaluatedFrame : evaluatedFrame(this.report, index, t, tick);
    if (!source) return false;
    // A joined figure's origin is its parent's attach point: retarget the edit
    // to that parent joint so dragging the trail rotates it instead of
    // translating the whole component.
    if (target.kind === 'node' && target.handleId === 0) {
      const slot = source.objects.findIndex(o => o.unique_id === target.uid);
      const join = source.objects[slot]?.join;
      if (join) {
        const parent = source.objects.find(o => o.unique_id === join.target_unique_id)
          ?? source.objects[join.target_object_slot];
        const parentFigure = parent && this.report.figure_types.find(f => f.figure_type_id === parent.figure_type_id);
        const joint = parentFigure?.segments.findIndex(s => s.segment_id === join.target_handle_id) ?? -1;
        if (parent && joint >= 0)
          target = {...target, uid: parent.unique_id, handleId: Number(join.target_handle_id), joint};
      }
    }
    const sheet = this.report._styk?.layerSheet, authored = animationChannels(this.report).length > 0;
    const mode = sheet ? 'sheet' : authored ? 'channels' : t <= 0 ? 'key' : 'split';
    if (target.kind === 'node') {
      const slot = source.objects.findIndex(o => o.unique_id === target.uid);
      if (slot < 0) return false;
      const object = source.objects[slot];
      const figure = this.report.figure_types.find(f => f.figure_type_id === object.figure_type_id);
      const segment = target.joint >= 0 ? figure?.segments[target.joint] : null;
      if (target.handleId && (!segment || Number(segment.segment_id) !== target.handleId)) return false;
      if (segment && isStatic(segment) && !object._stykIK?.[target.handleId]?.enabled) return false;
    }
    const working = snapshotPoseFrame(source);
    const session = {
      motionPath: true, label, scope: 'motion-path', documentToken: this._documentToken,
      target: {...target}, tick, index, row, ratio: t, mode, source, working,
      beforeSelection: this._selectionState(), moved: false, cameraChanged: false,
      baseline: [], dirtySlots: new Set(), geometry: null, display: null,
      sourceIds: new Map(), touched: new Set(), rotationTargets: null,
      report: this.report, range: [tick, tick + 1],
    };
    const component = target.kind === 'node'
      ? new Set(componentSlots(source, source.objects.findIndex(o => o.unique_id === target.uid)).map(s => source.objects[s]?.unique_id))
      : new Set();
    session.request = request;
    if (falloff) {
      Object.assign(session, {falloff, mode: sheet ? 'sheet' : authored ? 'channels' : 'native'});
      if (!beginFalloff(this, session, component)) return false;
      this._drag = session;
      return true;
    }
    if (mode === 'key' || mode === 'split') {
      const stored = this.report.keyframes[index];
      if (target.kind === 'node')
        session.baseline = stored.objects.filter(o => component.has(o.unique_id)).map(o => snapshotPoseObject(o));
      session.commandBefore = clone(stored);
      session.beforeCamera = clone(stored.camera ?? null);
      const low = rows[Math.max(0, index - 2)].start,
        last = rows[Math.min(rows.length - 1, index + 2)] ?? row;
      session.range = [low, last.start + last.count];
      if (mode === 'key') session.working._styk = {...session.working._styk, frameId: stored._styk?.frameId};
      else {
        session.frames = this.report.keyframes.slice();
        session.working.duration_raw = row.start + row.count - tick;
        session.frames.splice(index, 1, {...stored, duration_raw: tick - row.start}, session.working);
      }
    } else {
      session.baseline = target.kind === 'node'
        ? source.objects.filter(o => component.has(o.unique_id)).map(o => snapshotPoseObject(o))
        : [];
      if (mode === 'channels') session.draft = draftAnimation(this);
      else {
        const owners = new Set(target.kind === 'camera' ? ['camera'] : []);
        if (target.kind === 'node') for (const uid of component) owners.add(this.layerForUid(uid));
        session.sheet = this._sheetPoseDraftBegin(tick, [...owners]);
        session.sheetRange = () => {
          let low = tick, high = tick + 1;
          for (const {writeTick, nextTick} of session.sheet.writes.values()) {
            low = Math.min(low, writeTick); high = Math.max(high, nextTick ?? writeTick + 1);
          }
          return [low, high];
        };
      }
    }
    this._drag = session;
    return true;
  },

  updateMotionPathEdit(point, options = {}) {
    const session = this._drag;
    if (!session?.motionPath) return false;
    if (session.documentToken !== this._documentToken) { this.cancelMotionPathEdit(); throw messageError(new Error(''), "errors.editorMotionPath.theDocumentChangedDuringTheMotionPathGesture", {}); }
    finite(point.x, 'Motion-path X'); finite(point.y, 'Motion-path Y');
    session.lastPoint = point; session.lastOptions = options;
    if (session.falloff) {
      updateFalloff(this, session, point, options);
      const changed = new Set();
      for (const sub of session.subs) if (sub.moved) for (const uid of sub.changed) changed.add(uid);
      this._emit('edit', {live: true, motionPath: true, changedUids: [...changed]});
      return true;
    }
    if (!applyPathPoint(session, this, point, options)) return true;
    session.moved = true;
    this._synchronizeAnimationOrigins(session.working, session.baseline.length ? session.baseline : session.source.objects);
    if (session.target.kind === 'camera') session.cameraChanged = true;
    if (session.mode === 'channels') writeChannels(this, session);
    else if (session.mode === 'sheet') {
      const changed = changedUids(session), owners = new Set();
      for (const uid of changed) owners.add(this.layerForUid(uid));
      if (session.cameraChanged) owners.add('camera');
      for (const id of owners) this._sheetPoseDraftWrite(session.sheet, id, session.working, changed);
      session.range = session.sheetRange();
    }
    refreshSession(this, session);
    this._emit('edit', {live: true, motionPath: true, changedUids: [...changedUids(session)]});
    return true;
  },

  commitMotionPathEdit() {
    const session = this._drag;
    if (!session?.motionPath) return false;
    if (session.falloff) return commitFalloff(this, session);
    if (!session.moved || !sessionHasChanges(session)) {
      this._drag = null;
      this._emit('edit', {motionPath: true});
      return false;
    }
    rememberBends(session, this.report);
    if (session.mode === 'key') {
      const index = session.index, stored = this.report.keyframes[index];
      if (session.target.kind === 'camera') {
        const afterCamera = clone(session.working.camera), beforeCamera = session.beforeCamera;
        this._drag = null;
        this._applyCameraSnapshot([{index, camera: afterCamera}]);
        this._invalidate();
        this._record({kind: 'camera', label: session.label, before: [{index, camera: beforeCamera}], after: [{index, camera: afterCamera}],
          beforeSelection: session.beforeSelection, afterSelection: this._selectionState(), structural: false, timing: false});
        this._emit('edit', {label: session.label, camera: true, changedFrames: [index]});
        return true;
      }
      const ids = new Set(session.baseline.map(o => o.unique_id));
      const storedByUid = new Map(stored.objects.map(o => [o.unique_id, o]));
      const candidate = {...stored, objects: stored.objects.map(o => {
        const edited = session.working.objects.find(w => w.unique_id === o.unique_id);
        return ids.has(o.unique_id) && edited ? {...edited, object_slot: o.object_slot} : o;
      })};
      const after = [];
      for (const object of candidate.objects) {
        if (!ids.has(object.unique_id)) continue;
        if (poseObjectSignature(storedByUid.get(object.unique_id), stored) === poseObjectSignature(object, candidate)) continue;
        const clean = clone(object); delete clean.runtime_segments; delete clean._movieclipSample;
        after.push(clean);
      }
      if (!after.length) { this._drag = null; this._emit('edit', {motionPath: true}); return false; }
      try { validateObjectChanges(this.report, candidate, new Set(after.map(o => o.unique_id))); }
      catch (error) { this.cancelMotionPathEdit(); throw error; }
      if (after.some(object => object.join)) {
        const geometry = buildGeometry(this.report, candidate);
        for (const object of candidate.objects) {
          if (!object.join || !ids.has(object.unique_id)) continue;
          const root = geometry.objects.get(object.object_slot)?.root;
          if (root) { object.root_x = root.x; object.root_y = root.y; }
        }
      }
      const before = session.baseline;
      this._replaceObjects(index, after);
      this._drag = null;
      this._invalidateObjects([...ids]);
      this._record({kind: 'objects', label: session.label, index, before, after,
        beforeSelection: session.beforeSelection, afterSelection: this._selectionState(), structural: false, timing: false});
      this._emit('edit', {label: session.label, changedUids: [...ids], frameIndices: [index]});
      return true;
    }
    if (session.mode === 'split') {
      const index = session.index;
      const before = session.commandBefore,
        head = {...before, duration_raw: session.tick - session.row.start},
        tail = clone(session.working);
      tail.duration_raw = session.row.start + session.row.count - session.tick;
      const previous = new Map(this.report.keyframes.map(frame => [frame._styk?.frameId, frame]));
      const inserted = [clone(head), clone(tail)];
      this.report.keyframes.splice(index, 1, ...inserted);
      this._reconcileFrameIds(previous);
      const command = {kind: 'ranges', label: session.label,
        changes: [{index, before: [before], after: clone(inserted)}],
        beforeSelection: session.beforeSelection, structural: false, timing: true};
      this._captureRemovedFrameSources(command);
      this._invalidate({timing: true});
      this.frameIndex = rowForTick(this.timeline, this.tick).index;
      command.afterSelection = this._selectionState();
      this._drag = null;
      this._record(command);
      this._emit('edit', {label: session.label, structural: false, timing: true, frameIndices: [index, index + 1]});
      return true;
    }
    if (session.mode === 'channels') {
      const draft = session.draft;
      this._drag = null;
      recordAnimation(this, session.label, draft, session.beforeSelection);
      return true;
    }
    const sheet = session.sheet;
    this._drag = null;
    if (!sheet.writes.size) { this._emit('edit', {motionPath: true}); return false; }
    this._sheetPoseDraftPublish(sheet, session.label, session.beforeSelection);
    return true;
  },

  cancelMotionPathEdit() {
    const session = this._drag;
    if (!session?.motionPath) return false;
    this._drag = null;
    this._emit('edit', {label: 'Cancel pose', motionPath: true});
    return true;
  },

  /** Switch the open gesture between one-frame and falloff editing, or change
   * its influence, replaying the current pointer position. Null ends falloff. */
  setMotionPathFalloff(falloff) {
    const session = this._drag;
    if (!session?.motionPath) return false;
    const next = normalizeFalloff(falloff);
    if (same(next, session.falloff ?? null)) return true;
    const {request, lastPoint, lastOptions} = session;
    this._drag = null;
    if (!this.beginMotionPathEdit(request.target, request.tick, {label: request.label, falloff: next})) { this._drag = session; return false; }
    if (lastPoint) this.updateMotionPathEdit(lastPoint, lastOptions);
    else this._emit('edit', {live: true, motionPath: true, changedUids: []});
    return true;
  },

  /** The open motion-path gesture's falloff plan for the overlay, or null. */
  motionPathFalloff() {
    const session = this._drag;
    if (!session?.motionPath || !session.falloff) return null;
    return {tick: session.tick, ...session.falloff, writes: session.writes,
      changed: new Set(session.subs.filter(sub => sub.moved || (sub.kind === 'edge' && session.moved)).map(sub => sub.tick))};
  },

  /** The live document for trail sampling while a session is open. */
  motionPathReport() { return this._drag?.motionPath ? this._drag.report : this.report; },

  /** The playhead's pose under the report of a gesture the engine session holds, which the owner mirrors
   * without building it (`display` is read from the mirror when the stage draws). */
  _motionPathDisplay(session) { return displayOf(this, session); },
};
