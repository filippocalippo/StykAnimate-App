import {messageError} from '../localized-error.mjs';
// What the interface reads of a frame's structure: a segment's branch and the figures a selection of joined figures moves.
/** Find a complete branch in linear time, retaining the document's segment order. */
export function segmentBranchIndices(segments, handleId) {
  const children = new Map();
  for (const segment of segments) {
    const list = children.get(segment.parent_id);
    if (list) list.push(segment.segment_id); else children.set(segment.parent_id, [segment.segment_id]);
  }
  const ids = new Set([handleId]), queue = [handleId];
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? []) {
    if (!ids.has(child)) { ids.add(child); queue.push(child); }
  }
  const indices = [];
  for (let i = 0; i < segments.length; i++) if (ids.has(segments[i].segment_id)) indices.push(i);
  return indices;
}
/** Joins address object slots, never UIDs or segment-array indices. */
export function resolveJoinSelection(frame, uids, ancestors = false) {
  const objects = frame.objects, requested = new Set(uids), selectedSlots = [], children = new Map();
  objects.forEach((object, slot) => {
    if (requested.has(object.unique_id)) selectedSlots.push(slot);
    if (object.join) {
      const parent = object.join.target_object_slot, list = children.get(parent);
      if (list) list.push(slot); else children.set(parent, [slot]);
    }
  });
  const rootSlots = new Set(), resolved = new Map();
  for (const selected of selectedSlots) {
    let slot = selected;
    if (ancestors) {
      const path = [], visiting = new Set();
      while (!resolved.has(slot) && objects[slot]?.join) {
        if (visiting.has(slot)) throw messageError(new Error(''), "errors.editorSelection.figuresContainACyclicJoin", {});
        visiting.add(slot); path.push(slot); slot = objects[slot].join.target_object_slot;
        if (!objects[slot]) throw messageError(new Error(''), "errors.editorSelection.joinTargetIsMissing", {});
      }
      slot = resolved.get(slot) ?? slot;
      for (const visited of path) resolved.set(visited, slot);
    }
    rootSlots.add(slot);
  }
  const affected = new Set(rootSlots), queue = [...rootSlots];
  for (let q = 0; q < queue.length; q++) for (const slot of children.get(queue[q]) ?? [])
    if (!affected.has(slot)) { affected.add(slot); queue.push(slot); }
  // Stable slot order makes motionless drags compare equal even when selection
  // order differs from native object order.
  const affectedSlots = [], orderedRoots = [];
  objects.forEach((object, slot) => {
    if (affected.has(slot)) affectedSlots.push(slot);
    if (rootSlots.has(slot)) orderedRoots.push(slot);
  });
  return {rootSlots: orderedRoots, affectedSlots,
    rootUids: orderedRoots.map(slot => objects[slot].unique_id),
    affectedUids: affectedSlots.map(slot => objects[slot].unique_id)};
}
