import {animationOriginLayout, animationOriginAngle, animationOriginBend, invalidateAnimationOriginLayout} from './animation-origin.mjs';
import {originSupportPose, originSupportLayout} from './animation-origin-support.mjs';

function legacySupport(figure) {
  const layout = animationOriginLayout(figure), origin = figure._styk.animationOrigin;
  return {version: 1, bones: figure.segments.map((segment, index) => ({parent: layout.parents[index], handleId: segment.segment_id,
    reversed: Boolean(layout.reversed[index]), angle_rad: animationOriginAngle(figure, null, index, Boolean(layout.reversed[index])),
    bend_rad: animationOriginBend(figure, null, index, Boolean(layout.reversed[index])), length: segment.length})),
    vertices: Object.fromEntries([[origin.handleId, -1], ...layout.endpoints]),
    path: layout.path.map(index => ({bone: index, sign: layout.reversed[index] ? -1 : 1})), rotation: layout.ids.get(origin.rotationHandleId)};
}
function compact(support) {
  const required = new Set([...support.bones.flatMap((bone, index) => bone.handleId !== null ? [index] : []),
    ...Object.values(support.vertices).filter(index => index >= 0), ...support.path.map(term => term.bone), support.rotation]);
  const queue = [...required];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const parent = support.bones[queue[cursor]].parent;
    if (parent >= 0 && !required.has(parent)) {required.add(parent); queue.push(parent);}
  }
  const retained = [...required].sort((a, b) => a - b), map = new Map(retained.map((index, next) => [index, next]));
  const pathCounts = new Map();
  for (const term of support.path) pathCounts.set(map.get(term.bone), (pathCounts.get(map.get(term.bone)) ?? 0) + term.sign);
  const path = [];
  for (const [bone, count] of pathCounts) for (let i = 0; i < Math.abs(count); i++) path.push({bone, sign: Math.sign(count)});
  if (retained.length > 100000 || path.length > 100000) throw new Error('The retained animation support capacity has been reached.');
  return {retained, value: {...support, bones: retained.map(index => ({...support.bones[index], parent: support.bones[index].parent < 0 ? -1 : map.get(support.bones[index].parent)})),
    vertices: Object.fromEntries(Object.entries(support.vertices).map(([handle, index]) => [handle, index < 0 ? -1 : map.get(index)])),
    path, rotation: map.get(support.rotation)}};
}
function frameAt(editor, entry) {return editor._sourceFrame(entry);}
/** Keep continuous angular dependencies; removed joints become numeric ghosts,
 * while every surviving segment retains native construction geometry. */
export function repairOriginSupport(editor, before, figure, {originReRoot, originSplit, originSplits, originFreezeHandles} = {}) {
  const oldFigure = before.figure, oldOrigin = oldFigure._styk?.animationOrigin;
  if (!oldOrigin) return;
  if (!figure._styk?.animationOrigin) figure._styk = {...figure._styk, animationOrigin: structuredClone(oldOrigin)};
  const splits = originSplits ?? (originSplit ? [originSplit] : []);
  if (!oldOrigin.support && !oldOrigin.reversed) {
    const reference = splits.find(split => split.handleId === oldOrigin.rotationHandleId);
    if (reference) figure._styk = {...figure._styk, animationOrigin: {...figure._styk.animationOrigin, rotationHandleId: reference.newId}};
  }
  const native = new Map(figure.segments.map((segment, index) => [segment.segment_id, index]));
  if (!oldOrigin.support && (originReRoot || splits.length || oldFigure.segments.every(segment => native.has(segment.segment_id)))) return;
  const source = oldOrigin.support ?? legacySupport(oldFigure), support = structuredClone(source);
  const oldView = oldOrigin.support ? oldFigure : {...oldFigure, _styk: {...oldFigure._styk, animationOrigin: {...oldOrigin, support: source}}};
  const oldLayout = originSupportLayout(oldView), previousCount = support.bones.length;
  // Ctrl+Delete can reshape a surviving reference edge. Preserve its old
  // animation dependency independently from the newly fitted visible edge.
  if (originFreezeHandles?.size) {
    for (let index = 0; index < previousCount; index++) {
      const bone = support.bones[index]; if (!originFreezeHandles.has(bone.handleId)) continue;
      const replacement = support.bones.length; support.bones.push({...bone}); bone.handleId = null;
      for (const handle of Object.keys(support.vertices)) if (support.vertices[handle] === index) support.vertices[handle] = replacement;
    }
  }
  if (originReRoot) {
    const {handleId, mappings} = originReRoot, byHandle = new Map(support.bones.map((bone, index) => [bone.handleId, index]));
    const oldSegments = new Map(oldFigure.segments.map(segment => [segment.segment_id, segment]));
    const path = []; let current = handleId;
    while (current !== 0) {
      const segment = oldSegments.get(current), index = byHandle.get(current);
      if (!segment || index === undefined || path.length >= oldFigure.segments.length) throw new Error('The new origin is disconnected from its figure.');
      path.push({bone: index, sign: support.bones[index].reversed ? 1 : -1}); current = segment.parent_id;
    }
    support.path = [...path, ...support.path];
    const remap = id => id === 0 ? handleId : id === handleId ? 0 : id;
    support.vertices = Object.fromEntries(Object.entries(support.vertices).map(([handle, node]) => [remap(Number(handle)), node]));
    for (const bone of support.bones) if (bone.handleId !== null) {const mapping = mappings.get(bone.handleId); bone.handleId = mapping.id; bone.reversed = bone.reversed !== mapping.reverse;}
  }
  if (splits.length) {
    // Split an entire branch in linear time. Preserve the old virtual start
    // tangent, and let its second piece retain the old endpoint identity.
    const byHandle = new Map(support.bones.map((bone, index) => [bone.handleId, index]));
    const lastPieces = new Map(), firstCount = support.bones.length;
    const entries = splits.map((split, offset) => {
      const index = byHandle.get(split.handleId);
      if (index === undefined) throw new Error('The split segment has no animation support.');
      const next = firstCount + offset; lastPieces.set(index, next); return {split, index, next};
    });
    for (const bone of support.bones) bone.parent = lastPieces.get(bone.parent) ?? bone.parent;
    for (const {split, index} of entries) {
      const first = support.bones[index], oldHandle = first.handleId, reversed = first.reversed;
      support.bones.push({...first, parent: index, handleId: reversed ? split.newId : oldHandle});
      first.handleId = reversed ? oldHandle : split.newId;
    }
    for (const handle of Object.keys(support.vertices)) support.vertices[handle] = lastPieces.get(support.vertices[handle]) ?? support.vertices[handle];
    for (const {split, index} of entries) support.vertices[split.newId] = index;
    support.path = support.path.flatMap(term => lastPieces.has(term.bone) ? [term, {bone: lastPieces.get(term.bone), sign: term.sign}] : [term]);
  }
  const live = new Set();
  for (const bone of support.bones) {
    const index = bone.handleId === null ? undefined : native.get(bone.handleId);
    if (index === undefined) {bone.handleId = null; continue;}
    live.add(bone.handleId);
    const segment = figure.segments[index], bend = segment.bend_rad ?? 0;
    bone.angle_rad = segment.angle_rad + (bone.reversed ? bend + Math.PI : 0); bone.bend_rad = bone.reversed ? -bend : bend; bone.length = segment.length;
  }
  for (const key of Object.keys(support.vertices)) if (Number(key) !== 0 && !native.has(Number(key))) delete support.vertices[key];
  // Additions use their actual parent vertex's retained angular basis.
  const pending = figure.segments.filter(segment => !live.has(segment.segment_id)); let count = 0;
  const children = new Map();
  for (const segment of pending) {const list = children.get(segment.parent_id) ?? []; list.push(segment); children.set(segment.parent_id, list);}
  const ready = pending.filter(segment => Object.hasOwn(support.vertices, segment.parent_id));
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const segment = ready[cursor], index = support.bones.length; count++;
    support.bones.push({parent: support.vertices[segment.parent_id], handleId: segment.segment_id, reversed: false,
      angle_rad: segment.angle_rad, bend_rad: segment.bend_rad ?? 0, length: segment.length});
    support.vertices[segment.segment_id] = index;
    for (const child of children.get(segment.segment_id) ?? []) ready.push(child);
  }
  if (count !== pending.length) throw new Error('An added segment is disconnected from its animation support.');
  const packed = compact(support), value = packed.value, reference = value.bones[value.rotation];
  const pivotEntry = Object.entries(value.vertices).find(([, index]) => index === -1);
  figure._styk = {...figure._styk, animationOrigin: {...figure._styk.animationOrigin, handleId: pivotEntry ? Number(pivotEntry[0]) : null,
    rotationHandleId: reference.handleId, reversed: reference.reversed, support: value}};
  for (const entry of before.frames) {
    const oldObjects = new Map(entry.objects.map(object => [object.unique_id, object]));
    for (const object of frameAt(editor, entry).objects) {
      if (object.figure_type_id !== figure.figure_type_id) continue;
      const old = oldObjects.get(object.unique_id), ghosts = {};
      value.bones.forEach((bone, index) => {
        if (bone.handleId !== null) return;
        const previous = packed.retained[index];
        const pose = previous < previousCount && old ? originSupportPose(oldView, old, previous, oldLayout) : bone;
        ghosts[index] = {angle_rad: pose.angle_rad, bend_rad: pose.bend_rad, length: pose.length};
      });
      const origin = {...object._stykAnimationOrigin};
      if (Object.keys(ghosts).length) origin.ghosts = ghosts; else delete origin.ghosts;
      object._stykAnimationOrigin = origin;
    }
  }
  invalidateAnimationOriginLayout(figure);
}
