/** Simple's Add command uses the same sparse insertion planner as the clipboard.
 * Planning reads a stored projection and publishes no partial animation state. */
import {storedFrameReport} from './pivot-frame-draft.mjs';
import {planAuthoredClipboard} from './frame-clipboard-authored.mjs';
import {animationEndTick} from './animation-channels.mjs';
import {nativeTimeline} from './pivot/geometry.mjs';

export function planDraftFrameAppend(editor, frame) {
  let report = storedFrameReport(editor.report, {validate: false});
  const view = Object.create(editor);
  Object.assign(view, {report, _timeline: null, _nativeAnimationChannels: null, _propertyChannelCache:null});
  if(editor.propertyChannels) {
    const channels=report._styk.animation?.channels ?? [],ids=new Set(channels.map(channel=>channel.id)),introduced=[];
    for(const channel of editor.animationChannels)if(channel.property!=='pose'&&!ids.has(channel.id))introduced.push(view.nativePropertyChannel(channel.target,channel.property));
    if(introduced.length) {
      report={...report,_styk:{...report._styk,animation:{version:1,...report._styk.animation,
        nextKeyId:Math.max(report._styk.animation?.nextKeyId??1,editor.report._styk.animation?.nextKeyId??1),channels:[...channels,...introduced]}}};
      view.report=report;view._propertyChannelCache=null;view._nativeAnimationChannels=null;view._timeline=null;
    }
  }
  const rows = nativeTimeline(report), at = (rows.at(-1)?.start ?? 0) + (report.keyframes.at(-1)?.duration_raw ?? 0);
  const append = animationEndTick(report) <= at && (report._styk.animation?.channels ?? []).every(channel => channel.keys.every(key => key.tick < at));
  const plan = planAuthoredClipboard(view, {frames: [frame], assets: {layers: {additions: []}},
    index: report.keyframes.length, nextFrameIdentity: editor._nextFrameIdentity, append, trustedSource: true, authoringAppend:editor.propertyChannels});
  return {before: editor.report._styk.animation ?? null, after: plan?.after ?? report._styk.animation ?? null,
    frameSourceChanges: plan?.frameSourceChanges ?? [], nextFrameIdentity: plan?.nextFrameIdentity ?? editor._nextFrameIdentity};
}

/** Reapply only working-key changes after a stored-frame command. The command
 * owns timing/structure; the draft follows its new frame without replacing
 * unaffected curves or the command's keys. */
export function rebaseDraftAnimation(before, working, after, oldTick, newTick) {
  const originals = new Map((before?.channels ?? []).map(channel => [channel.id, channel]));
  const edited = new Map((working?.channels ?? []).map(channel => [channel.id, channel]));
  const channels = new Map((after?.channels ?? []).map(channel => [channel.id, channel]));
  let nextKeyId = Math.max(before?.nextKeyId ?? 1, working?.nextKeyId ?? 1, after?.nextKeyId ?? 1);
  const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
  for (const id of new Set([...originals.keys(), ...edited.keys()])) {
    const original = originals.get(id), edit = edited.get(id);
    if (same(original, edit)) continue;
    if (!edit) { channels.delete(id); continue; }
    const oldKeys = new Map((original?.keys ?? []).map(key => [key.id, key]));
    const newKeys = new Map(edit.keys.map(key => [key.id, key]));
    const keysById = new Map((channels.get(id)?.keys ?? []).filter(key => !oldKeys.has(key.id) || newKeys.has(key.id)).map(key => [key.id,key]));
    const ticks = new Map([...keysById.values()].filter(key => !key.hidden).map(key => [key.tick,key.id]));
    const ids = new Set([...keysById.keys(), ...newKeys.keys()]);
    const remove = id => {
      const key = keysById.get(id);
      if (key && !key.hidden) ticks.delete(key.tick);
      keysById.delete(id);
    };
    for (const key of edit.keys) if (!same(oldKeys.get(key.id), key)) {
      const moved = {...key, tick: key.tick === oldTick ? newTick : key.tick};
      if (!oldKeys.has(key.id) && keysById.has(key.id)) {
        do {
          if (!Number.isSafeInteger(nextKeyId)) throw new Error('Animation key identity capacity exceeded.');
          moved.id = `key-${nextKeyId++}`;
        } while (ids.has(moved.id));
      }
      ids.add(moved.id); remove(moved.id);
      if (!moved.hidden && ticks.has(moved.tick)) remove(ticks.get(moved.tick));
      keysById.set(moved.id,moved);
      if (!moved.hidden) ticks.set(moved.tick,moved.id);
    }
    const keys = [...keysById.values()];
    keys.sort((a,b) => a.tick-b.tick || Number(Boolean(b.hidden))-Number(Boolean(a.hidden)));
    channels.set(id, {...edit, keys});
  }
  return {...after, version:1, nextKeyId, channels:[...channels.values()]};
}
