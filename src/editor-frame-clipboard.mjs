import {portableFigure, portableBackground} from './clipboard-assets.mjs';
import {equivalentClipboardAsset as equivalent} from './clipboard-asset-plan.mjs';
import {applyClipboardUpgrade, pasteWithLegacyUpgrade} from './clipboard-legacy-upgrade.mjs';
import {evaluatedFrame, nativeTimeline} from './pivot/geometry.mjs';
import {validateScene} from './pivot/model.mjs';
import {ensureLayerState, validateLayerState, layerIdForUid} from './layers.mjs';
import {invalidateFrameIndex} from './frame-ids.mjs';
import {planAuthoredClipboard} from './frame-clipboard-authored.mjs';
import {materializeSimpleFrameDraftForPivot} from './pivot-frame-draft.mjs';
import {editorClipboardAsyncMethods,applyAsyncClipboardCommand} from './editor-clipboard-async.mjs';
import {applySparseClipboardAssets} from './editor-clipboard-sparse.mjs';

const clone = value => structuredClone(value);
const META = '_stykClipboard';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function allocator(values, maximum = 0xffffffff) {
  const used = new Set(values); let next = 1;
  return () => {
    while (used.has(next)) next++;
    if (next > maximum) throw new Error('The animation has no unused native identities.');
    used.add(next); return next++;
  };
}

function attach(frames, metadata) {
  Object.defineProperty(frames, META, {value: metadata}); return frames;
}

function retainedBytes(value) {
  if (typeof value === 'string') return value.length * 2;
  if (!value || typeof value !== 'object') return 8;
  return Object.entries(value).reduce((size, [key, child]) => size + key.length * 2 + retainedBytes(child), 32);
}

function cleanFrame(frame) {
  for (const object of frame.objects) delete object.runtime_segments;
  if (frame._styk) { delete frame._styk.frameId; if (!Object.keys(frame._styk).length) delete frame._styk; }
  return frame;
}

function capture(editor, selected, owned = false) {
  const report = materializeSimpleFrameDraftForPivot(editor.report), rows = nativeTimeline(report), types = new Set(), backgroundIds = new Set();
  const backgroundTable = [...(report.backgrounds ?? [])], colorIds = new Map(backgroundTable.filter(bg => bg.kind === 2).map(bg => [bg.color, bg.background_id]));
  const nextBackground = allocator(backgroundTable.map(bg => bg.background_id));
  const colorId = color => {
    if (colorIds.has(color)) return colorIds.get(color);
    const id = nextBackground(); backgroundTable.push({background_id: id, kind: 2, color, name: 'Copied scene color'}); colorIds.set(color, id); return id;
  };
  const frames = selected.map(index => {
    const evaluated = evaluatedFrame(report, index, 0, rows[index].start);
    const frame = cleanFrame(owned ? evaluated : clone(evaluated));
    // Evaluation may take a different authored source. Exposure belongs to the
    // selected native row, while its pose comes from the composed scene.
    frame.duration_raw = report.keyframes[index].duration_raw;
    if (frame._stykBackgroundColor !== undefined || report._styk.layers.fixed.scene.visible === false) {
      frame.background_id = colorId(report._styk.layers.fixed.scene.visible === false ? 0 : frame._stykBackgroundColor);
      frame.background_id_b = 0; frame.background_mix = 0;
    }
    delete frame._stykBackgroundColor;
    if (report._styk.layers.fixed.camera.visible === false) frame.camera = {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0};
    for (const object of frame.objects) types.add(object.figure_type_id);
    for (const id of [frame.background_id, frame.background_id_b]) if (id) backgroundIds.add(id);
    return frame;
  });
  const layers = report._styk.layers, usedLayers = new Set(), assignments = {};
  for (const frame of frames) for (const object of frame.objects) {
    const id = layerIdForUid(report, object.unique_id); usedLayers.add(id); assignments[object.unique_id] = id;
  }
  const metadata = {
    documentToken: editor._documentToken, version: report.version,
    canvas_width: report.canvas_width, canvas_height: report.canvas_height, fps: report.fps,
    frame_delay_ms: report.frame_delay_ms,
    figures: report.figure_types.filter(figure => types.has(figure.figure_type_id)).map(value => owned ? value : clone(value)),
    backgrounds: backgroundTable.filter(background => backgroundIds.has(background.background_id)).map(value => owned ? value : clone(value)),
    layers: {order: layers.order.filter(id => usedLayers.has(id)), byId: Object.fromEntries([...usedLayers].map(id => [id, clone(layers.byId[id])])), assignments},
    authored: Boolean(report._styk?.animation?.channels?.length),
  };
  return attach(frames, metadata);
}

/** The dedicated clipboard worker exclusively owns this report and terminates
 * after returning the capture. Borrowing its evaluated native frames avoids a
 * second complete clone of a large selected range. Never use on a live editor. */
export function captureOwnedNativeClipboard(editor, selected) {
  if (editor.animationChannels.length || editor._drag) throw new Error('Owned capture requires a committed native worker snapshot.');
  editor._frameClipboard = capture(editor, selected, true);
  return editor._frameClipboard.length;
}

function mergeAssets(source, target, key, summary) {
  const allocate = allocator(summary?.ids??target.map(value => value[key]));
  const matched=summary?new Map(summary.matches):null;
  const additions = [], ids = new Map();
  for (const value of source) {
    if(matched?.has(value[key])){ids.set(value[key],matched.get(value[key]));continue;}
    const existing = (summary?additions:[...target, ...additions]).find(candidate => equivalent(candidate, value, key));
    if (existing) { ids.set(value[key], existing[key]); continue; }
    const next = clone(value); next[key] = allocate(); additions.push(next); ids.set(value[key], next[key]);
  }
  return {additions, ids};
}

function layerPatch(editor, metadata, uidMap, sameDocument) {
  const state = editor.report._styk.layers, additions = [], assignments = [], ids = new Map();
  let next = state.nextId;
  for (const id of metadata.layers.order) {
    if (sameDocument && state.byId[id]) { ids.set(id, id); continue; }
    const target = `layer-${next++}`; ids.set(id, target); additions.push({id: target, value: clone(metadata.layers.byId[id])});
  }
  if (state.order.length + additions.length > 10000) throw new Error('Pasting these frames would exceed the 10,000-layer limit.');
  for (const [oldUid, newUid] of uidMap) {
    // A native figure identity can occur in many existing frames. Reassigning
    // it here would also change those frames' visibility and layer ordering.
    if (sameDocument && editor._layerUidCounts.has(newUid)) continue;
    const layer = ids.get(metadata.layers.assignments[oldUid]);
    if (!layer || (sameDocument && layerIdForUid(editor.report, newUid) === layer)) continue;
    assignments.push({uid: String(newUid), before: {exists: own(state.assignments, String(newUid)), value: state.assignments[newUid]}, after: layer});
  }
  return {additions, assignments, beforeNextId: state.nextId, afterNextId: next, orderIndex: state.order.length};
}

function plan(editor, index) {
  const clipboard = editor._frameClipboard, metadata = clipboard[META];
  if (!metadata) throw new Error('Copy these keyframes again to include their figure and background assets.');
  if (editor.report.keyframes.length + clipboard.length > 100000) throw new Error('Paste fewer frames to stay within the 100,000-keyframe limit.');
  const sameDocument = metadata.documentToken === editor._documentToken;
  const modernize = metadata.version < 5 && editor.report.version >= 5;
  const sourceFigures = modernize ? metadata.figures.map(figure => portableFigure(figure, true)) : metadata.figures;
  const segmentColorTypes = new Set(sourceFigures.filter(fig => fig._styk?.colorMode === 'segments').map(fig => fig.figure_type_id));
  const sourceBackgrounds = modernize ? metadata.backgrounds.map(portableBackground) : metadata.backgrounds;
  const assetSummary=editor._clipboardDestinationSummary?.assets;
  const figures = mergeAssets(sourceFigures, editor.report.figure_types, 'figure_type_id',assetSummary?.figures);
  const backgrounds = mergeAssets(sourceBackgrounds, editor.report.backgrounds ?? [], 'background_id',assetSummary?.backgrounds);
  figures.additions = figures.additions.map(figure => portableFigure(figure, false));
  backgrounds.additions = backgrounds.additions.map(portableBackground);
  if ((assetSummary?.figures.count??editor.report.figure_types.length) + figures.additions.length > 65535 || (assetSummary?.backgrounds.count??editor.report.backgrounds?.length??0) + backgrounds.additions.length > 65535)
    throw new Error('The copied assets exceed the native figure/background table capacity.');
  const summary = editor._clipboardDestinationSummary;
  const used = summary ? summary.uidCounts.map(([uid]) => uid) : []; let objects = summary?.objectCount ?? 0;
  if (!summary) for (const frame of editor.report.keyframes) { objects += frame.objects.length; for (const object of frame.objects) used.push(object.unique_id); }
  for (const frame of clipboard) objects += frame.objects.length;
  if (objects > 2000000) throw new Error('Pasting these frames would exceed the two-million-object limit.');
  if (!summary) for (const frame of Object.values(editor.report._styk.frameSources ?? {})) for (const object of frame.objects) used.push(object.unique_id);
  const nextUid = allocator(used, 0x7ffffffe), uidMap = new Map();
  for (const frame of clipboard) for (const object of frame.objects) if (!uidMap.has(object.unique_id)) uidMap.set(object.unique_id, sameDocument ? object.unique_id : nextUid());
  const frames = clipboard.flatMap(value => {
    const frame = cleanFrame(clone(value));
    for (const object of frame.objects) {
      const usesSegmentColors = segmentColorTypes.has(object.figure_type_id);
      object.unique_id = uidMap.get(object.unique_id); object.figure_type_id = figures.ids.get(object.figure_type_id);
      if (modernize && !usesSegmentColors) object.color_override_raw = (0xff000000 | ((Number(object.color_override_raw) | 0) < 0 ? 0 : Number(object.color_override_raw))) >>> 0;
    }
    for (const object of frame.objects) if (object.join) {
      const target = frame.objects[object.join.target_object_slot];
      if (!target) throw new Error('A copied figure has an unresolved join.');
      object.join.target_unique_id = target.unique_id;
      if (own(object.join, 'target_figure_type_id')) object.join.target_figure_type_id = target.figure_type_id;
    }
    frame.object_draw_order_unique_ids = (frame.object_draw_order ?? frame.objects.map((_, slot) => slot)).map(slot => frame.objects[slot].unique_id);
    frame.background_id = backgrounds.ids.get(frame.background_id) ?? 0;
    frame.background_id_b = backgrounds.ids.get(frame.background_id_b) ?? 0;
    // Legacy durations repeat the identical pose. Pivot 5 duration is a tween
    // to the next key, so preserve a hold with an identical terminal key.
    if (modernize && frame.duration_raw > 1) {
      const terminal = clone(frame); terminal.duration_raw = 1; frame.duration_raw--;
      return [frame, terminal];
    }
    return [frame];
  });
  if (editor.report.keyframes.length + frames.length > 100000) throw new Error('Legacy hold conversion exceeds the 100,000-keyframe limit.');
  if (frames.reduce((sum, frame) => sum + frame.objects.length, 0) + (summary?.objectCount ?? editor.report.keyframes.reduce((sum, frame) => sum + frame.objects.length, 0)) > 2000000)
    throw new Error('Legacy hold conversion exceeds the two-million-object limit.');
  const assets = {figureIndex: assetSummary?.figures.count??editor.report.figure_types.length, figures: figures.additions,
    backgroundIndex: assetSummary?.backgrounds.count??editor.report.backgrounds?.length??0, backgrounds: backgrounds.additions,
    layers: layerPatch(editor, metadata, uidMap, sameDocument)};
  // Validate the planned insertion before changing any destination data or IDs.
  validateScene({...editor.report, figure_types: [...editor.report.figure_types, ...assets.figures], backgrounds: [...(editor.report.backgrounds ?? []), ...assets.backgrounds], keyframes: frames});
  return {frames, assets, index, uidMap};
}

export const editorFrameClipboardMethods = {
  copyFrames(indices = [this.frameIndex]) {
    const selected = this._frameIndices(indices);
    if (!selected.length) return 0;
    if (this._drag) this.commitDrag();
    this._frameClipboard = capture(this, selected);
    this._emit('clipboard', {clipboard: true}); return selected.length;
  },
  pasteFrames(index = this.frameIndex + 1) {
    if (!this.hasFrameClipboard) return 0;
    if (!Number.isInteger(index) || index < 0 || index > this.report.keyframes.length) throw new Error('Choose a valid paste position.');
    if (this.report.version < 5 && this._frameClipboard[META]?.version >= 5)
      return pasteWithLegacyUpgrade(this, index, editorFrameClipboardMethods.pasteFrames);
    const pending = plan(this, index);
    if (this._drag) this.commitDrag();
    const beforeSelection = this._selectionState(), frames = pending.frames;
    let nextFrameIdentity = this._nextFrameIdentity;
    for (const frame of frames) {
      if (!Number.isSafeInteger(nextFrameIdentity)) throw new Error('Frame identity capacity exceeded.');
      frame._styk = {...frame._styk, frameId: `frame-${nextFrameIdentity++}`};
    }
    const authored = planAuthoredClipboard(this, {...pending, frames, nextFrameIdentity});
    const command = {kind: 'splice', label: 'Paste keyframes', index, before: [], after: this._clipboardOwnedPlan ? frames : clone(frames),
      beforeSelection, structural: true, timing: true};
    if (authored) {
      command.frameSourceChanges = authored.frameSourceChanges;
      command.hadFrameSourceTable = this.report._styk.frameSources !== undefined;
      command.layerAnimationPatch = authored.patch;
      this._nextFrameIdentity = authored.nextFrameIdentity;
    } else this._nextFrameIdentity = nextFrameIdentity;
    // Media strings are immutable and retained once. Keep them out of the
    // editor's JSON-based history-size calculation; account for them directly.
    Object.defineProperty(command, 'clipboardAssets', {value: pending.assets});
    this._pendingSourceBytes = (this._pendingSourceBytes ?? 0) + retainedBytes(pending.assets);
    this._applyFrameClipboardAssets(command, 'after');
    this.report.keyframes.splice(index, 0, ...frames);
    if (authored) { this._applyFrameSourceChanges(command, 'after'); this.report._styk.animation = authored.after; }
    for (const uid of pending.uidMap.values()) this._nextUid = Math.max(this._nextUid, uid + 1);
    invalidateFrameIndex(this.report); this._invalidate({timing: true});
    this.frameIndex = index; this.tick = this.timeline[index].start; this._selectIds([]);
    this._newLayerHints = new Map([...pending.uidMap.values()].map(uid => [uid, layerIdForUid(this.report, uid)]));
    command.afterSelection = this._selectionState(); this._record(command);
    this._emit('edit', {label: command.label, structural: true, timing: true, animation: Boolean(authored)}); return frames.length;
  },
  appendClipboardFrames() { return this.pasteFrames(this.report.keyframes.length); },
  insertClipboardFrames(index = this.frameIndex) { return this.pasteFrames(index); },
  _applyFrameClipboardAssets(command, direction) {
    if (applySparseClipboardAssets(this,command,direction)) return;
    if (applyAsyncClipboardCommand(this,command,direction)) return;
    if (command.clipboardUpgrade) { applyClipboardUpgrade(this, command, direction); return; }
    const assets = command.clipboardAssets; if (!assets) return;
    const forward = direction === 'after';
    this.report.figure_types.splice(assets.figureIndex, forward ? 0 : assets.figures.length, ...(forward ? clone(assets.figures) : []));
    (this.report.backgrounds ??= []).splice(assets.backgroundIndex, forward ? 0 : assets.backgrounds.length, ...(forward ? clone(assets.backgrounds) : []));
    const patch = assets.layers, state = this.report._styk.layers;
    for (const entry of patch.additions) { if (forward) state.byId[entry.id] = clone(entry.value); else delete state.byId[entry.id]; }
    state.order.splice(patch.orderIndex, forward ? 0 : patch.additions.length, ...(forward ? patch.additions.map(entry => entry.id) : []));
    state.nextId = forward ? patch.afterNextId : patch.beforeNextId;
    for (const entry of patch.assignments) {
      if (forward) state.assignments[entry.uid] = entry.after;
      else if (entry.before.exists) state.assignments[entry.uid] = entry.before.value;
      else delete state.assignments[entry.uid];
    }
    this._layerChanged({reindex: true});
  },
  /** Serializable, self-contained clipboard for the native persistent store.
   * No document source blob or unused library definition is retained. */
  frameClipboardDocument() {
    if (!this.hasFrameClipboard) return null;
    const metadata = this._frameClipboard[META], ids = metadata.layers.order;
    const layers = {version: 1, nextId: Math.max(1, ...ids.map(id => Number(id.slice(6)))) + 1,
      order: ids.length ? [...ids] : ['layer-1'], byId: ids.length ? clone(metadata.layers.byId) : {'layer-1': {name: 'Layer 1', visible: true, locked: false}},
      assignments: clone(metadata.layers.assignments), defaultLayerId: ids[0] ?? 'layer-1', activeId: ids[0] ?? 'layer-1'};
    return {version: metadata.version, canvas_width: metadata.canvas_width, canvas_height: metadata.canvas_height, fps: metadata.fps,
      ...(metadata.frame_delay_ms ? {frame_delay_ms: metadata.frame_delay_ms} : {}), figure_types: metadata.figures, backgrounds: metadata.backgrounds,
      keyframes: this._frameClipboard, _styk: {name: 'Copied keyframes', frameClipboardVersion: 1, layers}};
  },
  restoreFrameClipboard(document) {
    if (document?._styk?.frameClipboardVersion !== 1) throw new Error('The saved frame clipboard has an unsupported format.');
    validateScene(document); validateLayerState(ensureLayerState(document));
    const view = {report: document, _documentToken: null};
    this._frameClipboard = capture(view, document.keyframes.map((_, index) => index)); return this._frameClipboard.length;
  },
};
Object.assign(editorFrameClipboardMethods,editorClipboardAsyncMethods);
