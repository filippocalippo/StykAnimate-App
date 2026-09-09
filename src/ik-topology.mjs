import {ikLayout, ikChain, MAX_IK_CHAIN} from './ik.mjs';

/** Structural edits already own these pose snapshots. Repair stable IDs within
 * that existing transaction, including retained authored sources and Simple drafts.
 */
export function repairIKTopology(editor, before, figure, explicit) {
  let layout;
  for (const entry of before.frames) {
    const frame = entry.draft ? editor.report._styk.simpleFrameDraft?.baseline : entry.sourceId ? editor.report._styk.frameSources[entry.sourceId] : editor.report.keyframes[entry.index];
    for (const object of frame?.objects ?? []) {
      if (object.figure_type_id !== figure.figure_type_id || !object._stykIK) continue;
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
        for (const i of layout.children.get(handle) ?? []) {
          const child = figure.segments[i].segment_id;
          followers[child] = c.followers[child] ?? object.angles[i] - c.target.rotation;
        }
        table[handle] = {...c, chainLength: start < 0 ? Math.min(c.chainLength, chain.length) : chain.length - start, followers};
      }
      if (Object.keys(table).length) object._stykIK = table; else delete object._stykIK;
    }
  }
}
