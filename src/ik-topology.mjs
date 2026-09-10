import {ikLayout, ikChain, ikFollowerIndices, MAX_IK_CHAIN} from './ik.mjs';
import {ikComponents, joinedIKGraph} from './ik-joined.mjs';

function repairJoined(editor, frame, entry, before, figure, explicit) {
  const handled = new Set();
  if (!frame?.objects.some(o => o.join)) return handled;
  const previous = new Map(entry.objects.map(o => [o.unique_id,o]));
  const oldFrame = {...frame, objects: frame.objects.map(o => previous.get(o.unique_id) ?? o)};
  const oldReport = {...editor.report, figure_types: editor.report.figure_types.map(f => f.figure_type_id === figure.figure_type_id ? before.figure : f)};
  for (const slots of ikComponents(frame)) {
    if (slots.length < 2 || !slots.some(slot => frame.objects[slot].figure_type_id === figure.figure_type_id) || !slots.some(slot => frame.objects[slot]._stykIK)) continue;
    const old = joinedIKGraph(oldReport,oldFrame,slots), next = joinedIKGraph(editor.report,frame,slots);
    if (!old || !next) continue;
    const remap = (slot, handle) => frame.objects[slot].figure_type_id === figure.figure_type_id ? explicit.get(handle) ?? [handle] : [handle];
    for (const slot of slots) {
      const object = frame.objects[slot], table = {};
      for (const [key,c] of Object.entries(oldFrame.objects[slot]._stykIK ?? {})) {
        const id = Number(key), target = remap(slot,id).find(h => h === id && next.maps.get(slot).has(h)) ?? remap(slot,id).at(-1);
        if (!next.maps.get(slot).has(target)) continue;
        const chain = old.chain(slot,id,c.chainLength), parent = old.figure.segments[chain[0]]?.parent_id;
        const anchor = parent ? old.entries[parent-1] : null;
        const base = anchor ? next.maps.get(anchor.slot)?.get(remap(anchor.slot,anchor.handle).at(-1)) : 0;
        const full = next.chain(slot,target,MAX_IK_CHAIN), start = full.findIndex(i => next.figure.segments[i].parent_id === base);
        const virtual = next.maps.get(slot).get(target), children = new Set(ikFollowerIndices(next.figure, virtual, next.layout)), candidates = {};
        const mappedController = old.mapController(slot,id,c);
        for (const [child,angle] of Object.entries(mappedController.followers)) {
          const prior = old.entries[Number(child)-1];
          for (const handle of remap(prior.slot,prior.handle)) {
            const mapped = next.maps.get(prior.slot)?.get(handle);
            if (mapped && children.has(mapped-1)) candidates[mapped] = handle === prior.handle ? angle : next.object.angles[mapped-1]-c.target.rotation;
          }
        }
        const followers = {}, joinedFollowers = {};
        for (const i of children) {
          const child = next.entries[i], angle = candidates[i+1] ?? next.object.angles[i]-c.target.rotation;
          if (child.slot === slot) followers[child.handle] = angle;
          else (joinedFollowers[child.uid] ??= {})[child.handle] = angle;
        }
        table[target] = {...c, chainLength: start < 0 ? Math.min(c.chainLength,full.length) : full.length-start, followers, joinedFollowers};
      }
      if (Object.keys(table).length) object._stykIK = table; else delete object._stykIK;
      handled.add(slot);
    }
  }
  return handled;
}

/** Structural edits already own these pose snapshots. Repair stable IDs within
 * that existing transaction, including retained authored sources and Simple drafts.
 */
export function repairIKTopology(editor, before, figure, explicit) {
  let layout;
  for (const entry of before.frames) {
    const frame = editor._sourceFrame(entry);
    const handled = repairJoined(editor,frame,entry,before,figure,explicit);
    for (const object of frame?.objects ?? []) {
      if (handled.has(object.object_slot) || object.figure_type_id !== figure.figure_type_id || !object._stykIK) continue;
      layout ??= ikLayout(figure);
      const table = {};
      for (const [key, c] of Object.entries(object._stykIK)) {
        const id = Number(key), replacements = explicit.get(id);
        const handle = replacements ? replacements.includes(id) ? id : replacements.at(-1) : id;
        if (!layout.ids.has(handle)) continue;
        const chain = ikChain(figure, handle, MAX_IK_CHAIN, layout);
        const oldChain = ikChain(before.figure, id, c.chainLength);
        const base = before.figure.segments[oldChain[0]]?.parent_id;
        const start = chain.findIndex(i => figure.segments[i].parent_id === base);
        const followers = {};
        for (const i of ikFollowerIndices(figure, handle, layout)) {
          const child = figure.segments[i].segment_id;
          followers[child] = c.followers[child] ?? object.angles[i] - c.target.rotation;
        }
        table[handle] = {...c, chainLength: start < 0 ? Math.min(c.chainLength, chain.length) : chain.length - start, followers};
      }
      if (Object.keys(table).length) object._stykIK = table; else delete object._stykIK;
    }
  }
}
