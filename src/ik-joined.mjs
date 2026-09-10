/** Joins alias a child's origin to its parent's vertex. Compile connected native
 * figures into a temporary skeleton, then scatter derived poses back to slots.
 * No document topology is merged and no graph survives a mutable scene build. */
import {ikLayout, ikChain, solveObjectIK, hasPinnedIK, ikFollowers, ikAttachments, ikConstruction} from './ik.mjs';
import {resolveInstanceFigure} from './animation-style.mjs';
import {evaluateIKPose} from './ik-evaluation.mjs';

export function ikComponents(frame) {
  const neighbors = frame.objects.map(() => []);
  frame.objects.forEach((o, slot) => {
    const parent = o.join?.target_object_slot;
    if (parent !== undefined && neighbors[parent]) {neighbors[slot].push(parent); neighbors[parent].push(slot);}
  });
  const seen = new Set(), groups = [];
  for (let slot = 0; slot < neighbors.length; slot++) if (!seen.has(slot)) {
    const group = [slot]; seen.add(slot);
    for (let i = 0; i < group.length; i++) for (const next of neighbors[group[i]]) if (!seen.has(next)) {seen.add(next); group.push(next);}
    groups.push(group);
  }
  return groups;
}

export function joinedIKGraph(report, frame, slots) {
  const types = new Map(report.figure_types.map(f => [f.figure_type_id, f])), entries = [], maps = new Map(), roots = new Map();
  const figure = {segments: []}, object = {scale: 1, angles: [], len_flag: 1, lengths: [], bend_flag: 1, bends: [], _stykIK: {}};
  for (const slot of slots) {
    const source = frame.objects[slot], fig = resolveInstanceFigure(types.get(source.figure_type_id), source);
    if (!fig || fig._styk?.movieclip) return null;
    const ids = new Map(); maps.set(slot, ids);
    fig.segments.forEach((s, index) => {
      const id = entries.length + 1, scale = source.scale ?? 1, rt = source.runtime_segments?.[index];
      ids.set(s.segment_id, id); entries.push({slot, index, handle: s.segment_id, scale, uid: source.unique_id});
      figure.segments.push({segment_id: id, parent_id: 0, length: s.length * scale, angle_rad: s.angle_rad, is_static: ikConstruction(s)});
      object.angles.push(source.angles?.[index] ?? rt?.angle_rad ?? s.angle_rad ?? 0);
      object.lengths.push((source.len_flag ? source.lengths[index] : rt?.length ?? s.length) * scale);
      object.bends.push(source.bend_flag ? source.bends[index] : rt?.bend_rad ?? s.bend_rad ?? 0);
    });
  }
  function rootId(slot, seen = new Set()) {
    if (roots.has(slot)) return roots.get(slot);
    if (seen.has(slot)) throw new Error('Figures contain a cyclic join.');
    seen.add(slot);
    const join = frame.objects[slot].join;
    const id = !join ? 0 : join.target_handle_id ? maps.get(join.target_object_slot)?.get(join.target_handle_id) : rootId(join.target_object_slot, seen);
    if (id === undefined) throw new Error('IK join target is missing.');
    roots.set(slot, id); return id;
  }
  for (const slot of slots) {
    const source = frame.objects[slot], fig = resolveInstanceFigure(types.get(source.figure_type_id), source), ids = maps.get(slot);
    rootId(slot);
    fig.segments.forEach(s => {figure.segments[ids.get(s.segment_id) - 1].parent_id = s.parent_id ? ids.get(s.parent_id) ?? rootId(slot) : rootId(slot);});
    figure.polyfills ??= [];
    for (const polygon of fig.polyfills ?? []) figure.polyfills.push({segment_ids: polygon.segment_ids.map(id => id ? ids.get(id) : rootId(slot))});
  }
  const layout = ikLayout(figure);
  const owners = new Map(), byUid = new Map(slots.map(slot => [frame.objects[slot].unique_id, slot]));
  function mapController(slot, handle, c) {
    const id = maps.get(slot).get(Number(handle));
    const mappedController = {...c};
    for (const [local, joined] of [['followers','joinedFollowers'],['attachmentOffsets','joinedAttachmentOffsets']]) {
      const offsets = {};
      for (const [child, angle] of Object.entries(c[local] ?? {})) {
        const mapped = maps.get(slot).get(Number(child)); if (mapped) offsets[mapped] = angle;
      }
      for (const [uid, children] of Object.entries(c[joined] ?? {})) for (const [child, angle] of Object.entries(children)) {
        const mapped = maps.get(byUid.get(Number(uid)))?.get(Number(child)); if (mapped) offsets[mapped] = angle;
      }
      mappedController[local] = offsets;
    }
    const followers = ikFollowers(figure, object, id, mappedController, layout);
    return {...mappedController, followers, attachmentOffsets: ikAttachments(figure, object, id, mappedController, layout, followers)};
  }
  for (const slot of slots) for (const [handle, c] of Object.entries(frame.objects[slot]._stykIK ?? {})) {
    const id = maps.get(slot).get(Number(handle)); if (!id) continue;
    object._stykIK[id] = mapController(slot, handle, c); owners.set(id, {slot, handle: Number(handle)});
  }
  const rootSlot = slots.find(slot => !frame.objects[slot].join);
  if (rootSlot === undefined) throw new Error('Figures contain a cyclic join.');
  const sourceRoot = frame.objects[rootSlot], root = {x: sourceRoot.root_x ?? 0, y: sourceRoot.root_y ?? 0};
  return {figure, object, root, slots, entries, maps, roots, owners, layout, mapController,
    chain(slot, handle, length) {return ikChain(figure, maps.get(slot)?.get(handle), length, layout);},
    solve(controllers = object._stykIK) {return solveObjectIK(figure, object, root, layout, controllers);},
    scatter(solution) {
      const output = new Map();
      for (const slot of slots) output.set(slot, {angles: frame.objects[slot].angles.slice(), results: new Map()});
      entries.forEach((entry, i) => {
        const result = output.get(entry.slot); result.angles[entry.index] = solution.angles[i];
        if (solution.lengths && entry.scale !== 0) {
          result.lengths ??= [];
          result.lengths[entry.index] = solution.lengths[i] / entry.scale;
        }
      });
      for (const [id, result] of solution.results) {
        const owner = owners.get(id); if (!owner) continue;
        const offsets = {};
        for (const [local, joined] of [['followers','joinedFollowers'],['attachmentOffsets','joinedAttachmentOffsets']]) {
          offsets[local] = {}; offsets[joined] = {};
          for (const [child, angle] of Object.entries(result[local] ?? {})) {
            const entry = entries[Number(child) - 1];
            if (entry.slot === owner.slot) offsets[local][entry.handle] = angle;
            else (offsets[joined][entry.uid] ??= {})[entry.handle] = angle;
          }
        }
        output.get(owner.slot).results.set(owner.handle, {...result, ...offsets, chain: result.chain?.map(i => entries[i].index),
          chainEntries: result.chain?.map(i => entries[i])});
      }
      return output;
    }};
}

export function solveJoinedIK(report, frame, dirtySlots) {
  const output = new Map();
  if (!frame.objects.some(o => o.join) || !frame.objects.some(hasPinnedIK)) return output;
  for (const slots of ikComponents(frame)) {
    if (slots.length < 2 || !slots.some(slot => hasPinnedIK(frame.objects[slot])) || dirtySlots && !slots.some(slot => dirtySlots.has(slot))) continue;
    const graph = joinedIKGraph(report, frame, slots); if (!graph) continue;
    const key = `joined:${slots.map(slot => frame.objects[slot].unique_id).join(',')}`;
    const solved = evaluateIKPose(report, key, graph.figure, graph.object, graph.root, graph.layout); if (!solved) continue;
    for (const [slot, result] of graph.scatter(solved)) output.set(slot, result);
  }
  return output;
}
