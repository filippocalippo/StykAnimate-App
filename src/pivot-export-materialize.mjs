/** Native Pivot has one shared exposure sequence. Bake authored tracks only in
 * the export worker, keeping editable STYK sources and the UI document intact. */
import {evaluatedFrame, nativeTimeline, timeline, buildGeometry} from './pivot/geometry.mjs';
import {validateScene} from './pivot/model.mjs';
import {animationChannels, animationChannelId, validateAnimationDocument} from './animation-channels.mjs';
import {applyLayerOrder, layerVisible, validateLayerState} from './layers.mjs';
import {materializeSimpleFrameDraftForPivot} from './pivot-frame-draft.mjs';
import {createNativeStyleTable, hasNativeStyleOverrides} from './pivot-style-materialize.mjs';
import {hasAnimationOrigins} from './animation-origin.mjs';

import {hasFrameEasing} from './keyframe-easing.mjs';
import {hasPinnedIK} from './ik.mjs';
const hasIK = report => report.keyframes.some(frame => frame.objects.some(hasPinnedIK));
const MAX_FRAMES = 100000, MAX_OBJECTS = 2000000, MAX_BACKGROUNDS = 65534;
const activeChannels = report => animationChannels(report).filter(channel => channel.property === 'pose' || channel.keys.length);

export function needsPivotMaterialization(report) {
  if (hasIK(report)) return true;
  if (hasFrameEasing(report)) return true;
  if (activeChannels(report).length) return true;
  if (hasAnimationOrigins(report)) return true;
  if (hasNativeStyleOverrides(report)) return true;
  if (report.keyframes.some(frame => frame.objects.some(object => object._stykZIndex !== undefined))) return true;
  const layers = report._styk?.layers;
  if (!layers) return false;
  if (layers.fixed?.camera?.visible === false || layers.fixed?.scene?.visible === false ||
      layers.order.some(id => layers.byId[id]?.visible === false)) return true;
  return layers.order.length > 1 && report.keyframes.some(frame => applyLayerOrder(report, frame) !== frame);
}

function withoutFrameIdentity(frame) {
  if (!frame._styk) return frame;
  const metadata = {...frame._styk}; delete metadata.frameId; delete metadata.easing;
  if (Object.keys(metadata).length) frame._styk = metadata; else delete frame._styk;
  return frame;
}

/** Preserve zero-duration source poses as zero-duration native keys. Authored
 * hidden poses replace only their own track; untouched tracks retain their own
 * native hidden poses. Coincident references to one source share an exposure. */
function hiddenExposures(report, rows, channels) {
  const groups = new Map(), extraSources = {}, sourceIds = new Set(Object.keys(report._styk?.frameSources ?? {}));
  for (const frame of report.keyframes) if (frame._styk?.frameId) sourceIds.add(frame._styk.frameId);
  const authored = new Set(channels.filter(channel => channel.property === 'pose').map(channel => channel.id));
  const targets = [{kind: 'scene'}, {kind: 'camera'}, ...(report._styk?.layers?.order ?? ['layer-1']).map(id => ({kind: 'layer', id}))];
  const add = (tick, sourceId, target, nativeIndex = null) => {
    const id = `${tick}:${sourceId ?? 'blank'}`;
    let group = groups.get(id);
    if (!group) groups.set(id, group = {tick, sourceId, nativeIndex, targets: new Map()});
    if (nativeIndex !== null) group.nativeIndex = nativeIndex;
    group.targets.set(animationChannelId(target, 'pose'), target);
  };
  rows.forEach((row, index) => {
    if (row.count !== 0) return;
    const frame = report.keyframes[index]; let sourceId = frame._styk?.frameId;
    if (!sourceId) {
      let suffix = index + 1; do { sourceId = `export-hidden-${suffix++}`; } while (sourceIds.has(sourceId));
      sourceIds.add(sourceId); extraSources[sourceId] = frame;
    }
    for (const target of targets) if (!authored.has(animationChannelId(target, 'pose'))) add(row.start, sourceId, target, index);
  });
  for (const channel of channels) if (channel.property === 'pose') for (const key of channel.keys)
    if (key.hidden) add(key.tick, key.value?.frameId ?? null, channel.target);
  return {events: [...groups.values()].sort((a, b) => a.tick - b.tick), extraSources};
}

function sampleAt(report, rows, tick, hidden) {
  let low = 0, high = rows.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (rows[mid].start <= tick) low = mid; else high = mid - 1; }
  const row = rows[low], index = hidden?.nativeIndex ?? low;
  return evaluatedFrame(report, index, hidden?.nativeIndex !== null && hidden?.nativeIndex !== undefined ? 0 :
    row.count > 0 ? Math.max(0, Math.min(1, (tick - row.start) / row.count)) : 0, tick);
}

export function materializePivotDocument(report) {
  report = materializeSimpleFrameDraftForPivot(report);
  if (report.keyframes.length === 0) {
    // The working placeholder is absent from native stored-frame export. Its
    // authored overlays cannot create stored exposures after Delete All.
    validateScene({...report,keyframes:[{objects:[],duration_raw:0}]});
    const output={...report,total_output_frames:0,duration_seconds:0};
    if (report._styk) {
      output._styk={...report._styk};delete output._styk.animation;delete output._styk.layers;delete output._styk.frameSources;
    }
    return output;
  }
  if (!needsPivotMaterialization(report)) return report;
  validateAnimationDocument(report);
  if (report._styk?.layers) validateLayerState(report._styk.layers);
  const channels = activeChannels(report), layers = report._styk?.layers;
  const authored = hasIK(report) || hasFrameEasing(report) || channels.length > 0 || hasAnimationOrigins(report) || hasNativeStyleOverrides(report) || layers?.order.some(id => layers.byId[id]?.visible === false), rows = nativeTimeline(report), outputRows = timeline(report);
  const totalTicks = outputRows.at(-1).start + outputRows.at(-1).count;
  const {events: hidden, extraSources} = authored ? hiddenExposures(report, rows, channels) : {events: [], extraSources: {}};
  const outputCount = authored ? totalTicks + hidden.length : report.keyframes.length;
  if (outputCount < 1 || outputCount > MAX_FRAMES) throw new Error(`Native Pivot export needs ${outputCount.toLocaleString()} keys; the supported limit is ${MAX_FRAMES.toLocaleString()}. Reduce the authored duration before exporting.`);
  const output = {...report, backgrounds: [...(report.backgrounds ?? [])], keyframes: []};
  const styleTypeId = createNativeStyleTable(output);
  if (output._styk) {
    output._styk = {...output._styk}; delete output._styk.animation; delete output._styk.layers; delete output._styk.frameSources;
  }
  if (authored) { output.auto_easing = false; output.auto_easing_disabled_raw = 1; output.auto_easing_source = 'file'; }
  const colorIds = new Map(output.backgrounds.filter(bg => bg.kind === 2).map(bg => [bg.color, bg.background_id]));
  const usedBackgroundIds = new Set(output.backgrounds.map(bg => bg.background_id)); let nextBackgroundId = 1, objectCount = 0;
  const colorId = color => {
    if (colorIds.has(color)) return colorIds.get(color);
    if (output.backgrounds.length >= MAX_BACKGROUNDS) throw new Error('Animated scene colors exceed the native Pivot background table capacity.');
    while (usedBackgroundIds.has(nextBackgroundId)) nextBackgroundId++;
    const id = nextBackgroundId++; usedBackgroundIds.add(id); colorIds.set(color, id);
    output.backgrounds.push({background_id: id, kind: 2, color, name: `Color #${(color & 0xffffff).toString(16).padStart(6, '0')}`}); return id;
  };
  const append = (frame, duration) => {
    const geometry = frame.objects.some(object => object.join || hasPinnedIK(object)) ? buildGeometry(report, frame) : null;
    const oldToNew = new Map(), objects = [];
    frame.objects.forEach((object, slot) => {
      if (!layerVisible(report, object.unique_id)) return;
      oldToNew.set(slot, objects.length);
      const next = {...object, object_slot: objects.length}; delete next.runtime_segments;
      if (geometry?.objects.get(slot)?.solvedAngles) next.angles = geometry.objects.get(slot).solvedAngles.slice();
      if (geometry?.objects.get(slot)?.solvedLengths) {next.len_flag = 1; next.lengths = geometry.objects.get(slot).solvedLengths.slice();}
      delete next._stykIK;
      delete next._stykAnimationOrigin;
      delete next._stykZIndex;
      next.figure_type_id = styleTypeId(object); delete next._stykStyle;
      if (object.join) {
        const root = geometry.objects.get(slot)?.root;
        if (!root) throw new Error('An exported figure has unresolved joined geometry.');
        next.root_x = root.x; next.root_y = root.y;
      }
      objects.push(next);
    });
    for (const object of objects) if (object.join) {
      const parent = oldToNew.get(object.join.target_object_slot);
      object.join = parent === undefined ? null : {...object.join, target_object_slot: parent, target_unique_id: objects[parent].unique_id};
    }
    objectCount += objects.length;
    if (objectCount > MAX_OBJECTS) throw new Error('The composed Pivot export exceeds the two-million-object limit. Reduce the authored duration or scene size.');
    const order = (frame.object_draw_order ?? frame.objects.map((_, slot) => slot)).filter(slot => oldToNew.has(slot)).map(slot => oldToNew.get(slot));
    const next = withoutFrameIdentity({...frame, duration_raw: duration, objects, object_count: objects.length,
      keyframe_index: output.keyframes.length, object_draw_order: order, object_draw_order_unique_ids: order.map(slot => objects[slot].unique_id)});
    const sceneHidden = report._styk?.layers?.fixed?.scene?.visible === false;
    if (sceneHidden || next._stykBackgroundColor !== undefined) {
      next.background_id = colorId(sceneHidden ? 0 : next._stykBackgroundColor); next.background_id_b = 0; next.background_mix = 0;
    }
    delete next._stykBackgroundColor;
    if (report._styk?.layers?.fixed?.camera?.visible === false) next.camera = {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0};
    // Existing aliases must agree with the authoritative native exposure.
    next.hidden = duration === 0; next.inbetweens = duration - 1; next.duration_frames = duration;
    output.keyframes.push(next);
  };
  if (!authored) {
    for (let index = 0; index < report.keyframes.length; index++) append(evaluatedFrame(report, index, 0, rows[index].start), report.keyframes[index].duration_raw);
  } else {
    let hiddenIndex = 0;
    const sourceMetadata = Object.keys(extraSources).length ? {...report._styk, frameSources: {...report._styk?.frameSources, ...extraSources}} : report._styk;
    for (let tick = 0; tick <= totalTicks; tick++) {
      while (hiddenIndex < hidden.length && hidden[hiddenIndex].tick === tick) {
        const exposure = hidden[hiddenIndex++], replacements = exposure.targets;
        const temporary = {...report, _styk: {...sourceMetadata, animation: {...report._styk?.animation,
          channels: [...channels.filter(channel => !replacements.has(channel.id)), ...[...replacements].map(([id, target]) =>
            ({id, target, property: 'pose', keys: [{id: 'export-hidden-pose', tick, value: {frameId: exposure.sourceId}, interpolation: 'hold'}]}))]}}};
        append(sampleAt(temporary, rows, tick, exposure), 0);
      }
      if (tick < totalTicks) append(sampleAt(report, rows, tick), 1);
    }
  }
  output.total_output_frames = totalTicks; output.duration_seconds = totalTicks / output.fps;
  output.figure_types = output.figure_types.map(figure => {
    if (!figure._styk?.animationOrigin) return figure;
    const metadata = {...figure._styk}; delete metadata.animationOrigin;
    return {...figure, _styk: metadata};
  });
  validateScene(output);
  return output;
}
