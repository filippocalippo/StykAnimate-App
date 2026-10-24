// Read-only in-between planning and the actual async editor publication oracles (D15).
// `planInsertInbetweens` (src/editor-inbetween.mjs) is the planner; its wire is the plan
// the editor receives from a background planner (`inbetweenPlanWire`).
import {writeFileSync, mkdirSync} from 'node:fs';
import {Editor, emptyDocument, createObject, createFrame} from './fixture-kit.mjs';
import {planInsertInbetweens} from '../../src/editor-inbetween.mjs';
import {inbetweenPlanWire} from '../../src/editor-inbetween-async.mjs';

const out = new URL('../tests/inbetween/', import.meta.url);
mkdirSync(out, {recursive: true});
const json = value => JSON.stringify(value, (key, value) => key === 'runtime_segments' ? undefined : value);

/** Four native keys of two joined figures, each pose different: media, camera, backgrounds. */
function fixture({durations = [6, 4, 3, 9], easing = false, version = 5} = {}) {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.auto_easing = easing; report.version = version;
  report.backgrounds = [{background_id: 1, kind: 2, color: 0xff112233}, {background_id: 2, kind: 2, color: 0xffddeeff}];
  figure.image_assets = [{name: 'Retained image', data_base64: 'AA=='}];
  figure.text_assets = [{text: 'Retained text'}];
  report.keyframes = durations.map((ticks, index) => {
    const parent = createObject(figure, 12, [10, 90, 140, 20][index % 4], 100 + index * 5);
    parent.angles = parent.angles.map((angle, joint) => angle + index * .1 + joint * .01);
    parent.len_flag = 1; parent.lengths = figure.segments.map(segment => segment.length * (1 + .1 * index));
    parent.bend_flag = 1; parent.bends = figure.segments.map((_, joint) => joint * .02 * index);
    parent.scale = 1 + index / 5; parent.field28 = index * 32; parent.color_override_raw = (0xff002244 + index * 0x00112211) >>> 0;
    const child = createObject(figure, 88, 0, 0, {join: {target_unique_id: 12, target_object_slot: 0, target_handle_id: 2}});
    const frame = createFrame([parent, child], ticks);
    frame.object_draw_order = [1, 0]; frame.object_draw_order_unique_ids = [88, 12];
    frame.camera = {is_default: false, x: index * 15, y: index * 6, scale: 1 + index / 10, angle_rad: index / 20};
    frame.background_id = index % 2 + 1; frame._styk = {custom: `pose-${index}`};
    return frame;
  });
  return new Editor({demo: false}).load(report);
}
const pose = (e, layer, tick, index) => ({target: layer, property: 'pose', tick, value: {frameId: e.getFrameId(index)}, interpolation: 'linear'});

const cases = {
  'native-linear': {build: () => fixture(), ratio: .37, indices: [2]},
  'native-auto': {build: () => fixture({easing: true}), ratio: .37, indices: [2]},
  'multiple-hidden': {build: () => fixture({durations: [5, 0, 7, 1], easing: true}), ratio: .5, indices: [3, 2, 1, 2]},
  'endpoint-start': {build: () => birth(fixture()), ratio: 0, indices: [1]},
  'endpoint-end': {build: () => birth(fixture()), ratio: 1, indices: [1]},
  'first-key': {build: () => fixture(), ratio: .5, indices: [0]},
  'legacy-version': {build: () => fixture({version: 4}), ratio: .5, indices: [1]},
  'authored-independent': {build() {
    const e = fixture(), layer = e.createLayer('Second').id; e.assignFiguresToLayer([88], layer);
    for (const target of [{kind: 'layer', id: 'layer-1'}, {kind: 'layer', id: layer}, {kind: 'scene'}, {kind: 'camera'}])
      e.addAnimationKeys([pose(e, target, 0, 0), pose(e, target, 12, 3)]);
    for (const [target, property, first, last] of [
      [{kind: 'figure', uid: 12}, 'x', 100, 220], [{kind: 'figure', uid: 12}, 'rotation', .2, 1],
      [{kind: 'figure', uid: 12}, 'scale', 1.1, 1.8], [{kind: 'figure', uid: 88}, 'opacity', 1, .2],
      [{kind: 'camera'}, 'x', 90, 20], [{kind: 'camera'}, 'rotation', -.2, .3],
      [{kind: 'scene'}, 'color', 0xff123456, 0xff987654],
    ]) e.addAnimationKeys([{target, property, tick: 0, value: first}, {target, property, tick: 14, value: last}]);
    return e;
  }, ratio: .5, indices: [1]},
  'authored-late-scalar': {build() {
    const e = fixture();
    e.addAnimationKeys([{target: {kind: 'figure', uid: 12}, property: 'x', tick: 4, value: 500}, {target: {kind: 'figure', uid: 12}, property: 'x', tick: 12, value: 800}]);
    return e;
  }, ratio: .25, indices: [1]},
  'authored-zero-exposure': {build() {
    const e = fixture({durations: [6, 0, 4, 1]});
    e.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
    e.addAnimationKeys([{target: {kind: 'figure', uid: 12}, property: 'x', tick: 0, value: 100}, {target: {kind: 'figure', uid: 12}, property: 'x', tick: 6, value: 180}]);
    return e;
  }, ratio: .4, indices: [1]},
  'authored-hidden-keys': {build() {
    const e = fixture({durations: [6, 0, 4, 1]}), channel = e.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
    e.setAnimationKey(channel.id, channel.keys[0].id, {interpolation: 'hold'});
    return e;
  }, ratio: .4, indices: [1, 2]},
  'authored-rotation': {build() {
    const e = fixture(); e.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
    e.addAnimationKeys([{target: {kind: 'figure', uid: 12}, property: 'rotation', tick: 0, value: .2}, {target: {kind: 'figure', uid: 12}, property: 'rotation', tick: 12, value: 1}]);
    return e;
  }, ratio: .375, indices: [1, 3]},
  'authored-easing': {build() {
    const e = fixture(); e.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
    const keys = (target, property, values) => e.addAnimationKeys(values.map(([tick, value, interpolation, bezier]) => ({target, property, tick, value, interpolation, ...(bezier ? {bezier} : {})})));
    keys({kind: 'figure', uid: 12}, 'x', [[0, 100, 'ease-in'], [5, 180, 'bezier', [.25, .1, .75, .9]], [10, 140, 'ease-out'], [16, 300, 'hold']]);
    keys({kind: 'camera'}, 'scale', [[0, 1, 'bezier', [.1, .6, .9, .4]], [14, 2, 'linear']]);
    keys({kind: 'figure', uid: 88}, 'rotation', [[0, -.4, 'auto'], [7, 2.5, 'auto'], [14, -2.9, 'auto']]);
    return e;
  }, ratio: .6, indices: [1, 2]},
  'authored-scene': {build() {
    const e = fixture(); e.adoptNativePoseTrack({kind: 'scene'});
    e.addAnimationKeys([{target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xff204060, interpolation: 'linear'}, {target: {kind: 'scene'}, property: 'color', tick: 12, value: null, interpolation: 'hold'},
      {target: {kind: 'scene'}, property: 'backgroundId', tick: 0, value: 1, interpolation: 'hold'}, {target: {kind: 'scene'}, property: 'backgroundId', tick: 9, value: 2, interpolation: 'hold'},
      {target: {kind: 'figure', uid: 12}, property: 'opacity', tick: 3, value: .5, interpolation: 'linear'}, {target: {kind: 'figure', uid: 12}, property: 'opacity', tick: 13, value: .1, interpolation: 'linear'}]);
    return e;
  }, ratio: .5, indices: [1, 3]},
  'authored-absent-figure': {build() {
    const e = birth(fixture());
    e.addAnimationKeys([{target: {kind: 'figure', uid: 111}, property: 'x', tick: 20, value: 300}, {target: {kind: 'figure', uid: 111}, property: 'x', tick: 30, value: 400}]);
    return e;
  }, ratio: .5, indices: [1]},
  'authored-joined-late': {build() {
    const e = fixture();
    e.addAnimationKeys([{target: {kind: 'figure', uid: 88}, property: 'x', tick: 9, value: 40}, {target: {kind: 'figure', uid: 88}, property: 'x', tick: 15, value: 90},
      {target: {kind: 'figure', uid: 88}, property: 'y', tick: 9, value: 20}, {target: {kind: 'figure', uid: 88}, property: 'y', tick: 15, value: 70}]);
    return e;
  }, ratio: .75, indices: [1, 2]},
  // A Scene pose track across a hidden (zero-exposure) key, with a figure curve.
  'authored-scene-pose': {build() {
    const e = fixture({durations: [3, 0, 3]});
    e.addAnimationKeys([pose(e, {kind: 'scene'}, 0, 0), pose(e, {kind: 'scene'}, 6, 2),
      {target: {kind: 'figure', uid: 12}, property: 'x', tick: 0, value: 0, interpolation: 'linear'}, {target: {kind: 'figure', uid: 12}, property: 'x', tick: 6, value: 20, interpolation: 'linear'}]);
    return e;
  }, ratio: .5, indices: [1, 2]},
  // Files from before the editor wrote Constant keep the legacy Hold name; a new key continues it.
  'authored-legacy-hold': {build() {
    const e = fixture({durations: [6, 0, 4, 1]}), channel = e.adoptNativePoseTrack({kind: 'layer', id: 'layer-1'});
    e.addAnimationKeys([{target: {kind: 'figure', uid: 12}, property: 'x', tick: 0, value: 100, interpolation: 'linear'}, {target: {kind: 'figure', uid: 12}, property: 'x', tick: 9, value: 160, interpolation: 'linear'}]);
    e.report._styk.animation.channels.find(entry => entry.id === channel.id).keys[0].interpolation = 'hold';
    e.report._styk.animation.channels.find(entry => entry.property === 'x').keys[0].interpolation = 'hold';
    return e;
  }, ratio: .4, indices: [1, 2]},
  // Refusals, as the editor words them.
  'bad-ratio': {build: () => fixture(), ratio: 1.01, indices: [1]},
  'three-backgrounds': {build() {
    const e = fixture(), report = e.report;
    report.backgrounds.push({background_id: 3, kind: 2, color: 0xffabcdef});
    report.keyframes[1].background_id = 1; report.keyframes[1].background_id_b = 2; report.keyframes[1].background_mix = 96;
    report.keyframes[2].background_id = 3;
    return e;
  }, ratio: .5, indices: [1, 2]},
  'identity-capacity': {build() { const e = fixture(); e._nextFrameIdentity = Number.MAX_SAFE_INTEGER; return e; }, ratio: 1, indices: [1]},
  'authored-overflow': {build() { const e = fixture(); e.addAnimationKey({kind: 'camera'}, 'x', 10000000, 3); return e; }, ratio: .5, indices: [1]},
};
/** A figure that is born in key 1, so that endpoint ratios copy topology (an editor that loaded it). */
function birth(e) {
  const report = structuredClone(e.report);
  report.keyframes[1].objects.push(createObject(report.figure_types[0], 111, 35, 70, {object_slot: 2}));
  report.keyframes[1].object_draw_order.push(2); report.keyframes[1].object_draw_order_unique_ids.push(111);
  return new Editor({demo: false}).load(report);
}

for (const [name, {build, ratio, indices}] of Object.entries(cases)) {
  const e = build();
  const document = json(e.report), initialState = {selection: e._selectionState(), revision: e.revision, layerRevision: e.layerRevision};
  // The editor orders and deduplicates before it asks a planner (`_frameIndices`).
  const ordered = [...new Set(indices)].sort((a, b) => a - b);
  const request = {ratio, indices: ordered, nextFrameIdentity: e._nextFrameIdentity};
  let plan, failure;
  try { plan = inbetweenPlanWire(planInsertInbetweens(e, ratio, ordered)); }
  catch (error) { failure = {name: error.name, message: error.message, messageKey: error.messageKey}; }
  if (failure) { writeFileSync(new URL(`${name}.json`, out), json({name, document, initialState, request, failure}) + '\n'); continue; }
  const events = [];
  e.addEventListener('change', event => events.push(event.detail));
  const result = await e.insertInbetweenFramesAsync(ratio, indices, {planInbetweens: async () => structuredClone(plan)});
  const after = json(e.report), state = {revision: e.revision, nextFrameIdentity: e._nextFrameIdentity, undoLabel: e.undoLabel, canUndo: e.canUndo}, editEvents = events.slice();
  e.undo(); const undone = json(e.report); e.redo(); const redone = json(e.report);
  writeFileSync(new URL(`${name}.json`, out), json({name, document, initialState, request, payload: {plan},
    command: {name: 'insertInbetweenFramesAsync', args: {ratio, indices}, result, after, state, events: editEvents, undone, redone}}) + '\n');
}
