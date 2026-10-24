import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {evaluatedFrame, timeline, buildGeometry} from '../src/pivot/geometry.mjs';
import {materializePivotDocument, needsPivotMaterialization} from '../src/pivot-export-materialize.mjs';
import {synchronizeExistingDerived} from '../src/document-normalize.mjs';
import {missingFixture} from './helpers/local-fixtures.mjs';
import {exportDocument, importBytes, nodeCodec} from './support/codec.mjs';

const near = (a, b) => assert.ok(Math.abs(a - b) < .001, `${a} != ${b}`);
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [40, 250, 80].map((x, index) => {
    const parent = createObject(figure, 1, x, 200), other = createObject(figure, 2, 350 - index * 20, 210);
    const child = createObject(figure, 3, x, 122, {join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1}});
    return {...createFrame([parent, other, child], 4), opaque_native: {token: index}};
  });
  const editor = new Editor({demo: false}).load(report), layer = editor.createLayer('Second');
  editor.assignFiguresToLayer([2], layer.id); editor.moveLayerTo(layer.id, 0);
  return editor;
}
function sample(report, tick) {
  const rows = timeline(report); let index = 0;
  while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
  return evaluatedFrame(report, index, rows[index].count ? (tick - rows[index].start) / rows[index].count : 0, tick);
}
async function nativeRoundtrip(document, sourcePath) {
  synchronizeExistingDerived(document);
  const codec = nodeCodec(), request = {document, format: 'piv'};
  if (sourcePath) request.sourceId = (await importBytes(readFileSync(sourcePath), path.basename(sourcePath), {codec})).sourceId;
  const {bytes, name} = await exportDocument(request, {codec});
  return (await importBytes(bytes, name, {codec})).document;
}
function compareFrames(original, a, exported, b) {
  const before = buildGeometry(original, a), after = buildGeometry(exported, b), byUid = new Map([...after.objects.values()].map(g => [g.obj.unique_id, g]));
  assert.deepEqual(before.orderedObjects.map(g => g.obj.unique_id), after.orderedObjects.map(g => g.obj.unique_id));
  for (const geometry of before.objects.values()) {
    const saved = byUid.get(geometry.obj.unique_id); assert.ok(saved);
    near(saved.root.x, geometry.root.x); near(saved.root.y, geometry.root.y); near(saved.obj.scale, geometry.obj.scale);
    assert.equal(saved.obj.field28, geometry.obj.field28);
    geometry.segments.forEach((segment, index) => { near(saved.segments[index].end.x, segment.end.x); near(saved.segments[index].end.y, segment.end.y); });
  }
  for (const key of ['x', 'y', 'scale', 'angle_rad']) near(a.camera[key], b.camera[key]);
  const argb = frame => frame._stykBackgroundColor ?? original.backgrounds.find(bg => bg.background_id === frame.background_id)?.color;
  if (argb(a) !== undefined) assert.equal(exported.backgrounds.find(bg => bg.background_id === b.background_id)?.color, argb(a));
}

test('untouched native documents retain the exact original export path and references', () => {
  const native = emptyDocument();
  // Native exposures have no authored per-frame easing metadata.
  native.keyframes = [createFrame([createObject(native.figure_types[0], 1, 40, 200)], 4)];
  const report = new Editor({demo: false}).load(native).report;
  assert.equal(needsPivotMaterialization(report), false); assert.equal(materializePivotDocument(report), report);
});

test('new documents retain authored Hold easing through native export materialization', () => {
  const editor = new Editor({demo: false}); editor.addFigure(); const report = editor.report;
  const before = structuredClone(report);
  assert.equal(needsPivotMaterialization(report), true);
  const output = materializePivotDocument(report);
  assert.notEqual(output, report);
  compareFrames(report, sample(report, 0), output, sample(output, 0));
  assert.deepEqual(report, before);
});

test('layer ordering alone preserves native exposures and retained opaque fields without baking', () => {
  const editor = fixture(), report = editor.report, before = structuredClone(report), output = materializePivotDocument(report);
  assert.equal(output.keyframes.length, report.keyframes.length);
  assert.deepEqual(output.keyframes.map(frame => frame.duration_raw), report.keyframes.map(frame => frame.duration_raw));
  assert.deepEqual(output.keyframes[0].object_draw_order_unique_ids, [2, 1, 3]);
  assert.deepEqual(output.keyframes[1].opaque_native, {token: 1}); assert.deepEqual(report, before);
  assert.equal(output._styk.layers, undefined); assert.equal(output._styk.animation, undefined);
});

test('independent layer/scalar/camera/scene channels bake and really roundtrip through native PIV', async () => {
  const editor = fixture(), layer = {kind: 'layer', id: 'layer-1'}, pose = editor.nativePoseChannel(layer);
  editor.deleteAnimationKeys([{channelId: pose.id, keyIds: [pose.keys[1].id]}]);
  editor.addAnimationKeys([
    {target: {kind: 'figure', uid: 1}, property: 'rotation', tick: 0, value: 0}, {target: {kind: 'figure', uid: 1}, property: 'rotation', tick: 12, value: .8},
    {target: {kind: 'figure', uid: 3}, property: 'opacity', tick: 0, value: 1}, {target: {kind: 'figure', uid: 3}, property: 'opacity', tick: 12, value: .2},
    {target: {kind: 'camera'}, property: 'x', tick: 0, value: 0}, {target: {kind: 'camera'}, property: 'x', tick: 12, value: 60},
    {target: {kind: 'camera'}, property: 'scale', tick: 0, value: 1}, {target: {kind: 'camera'}, property: 'scale', tick: 12, value: 1.6},
    {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xff112233}, {target: {kind: 'scene'}, property: 'color', tick: 12, value: 0xffaaccdd},
  ]);
  const report = editor.report, before = structuredClone(report), output = materializePivotDocument(report);
  assert.equal(output.keyframes.length, 13); assert.ok(output.keyframes.every(frame => frame.duration_raw === 1));
  assert.equal(output._styk.animation, undefined); assert.equal(output._styk.frameSources, undefined); assert.equal(output.auto_easing, false);
  assert.deepEqual(report, before);
  const native = await nativeRoundtrip(output); assert.equal(native.total_output_frames, 13); assert.equal(native._styk?.animation, undefined);
  for (let tick = 0; tick < 13; tick++) compareFrames(report, sample(report, tick), native, sample(native, tick));
  assert.equal(materializePivotDocument(native), native, 'Reimported output must never receive the authored overlays twice');
});

test('native and independently retimed hidden poses remain distinct zero-duration exposures', async () => {
  const editor = fixture(); editor.report.keyframes[1].duration_raw = 0; editor._invalidate({timing: true});
  const target = {kind: 'layer', id: 'layer-1'}, pose = editor.nativePoseChannel(target);
  editor.moveAnimationKeys([{channelId: pose.id, keyIds: [pose.keys[1].id]}], 2);
  const report = editor.report, output = materializePivotDocument(report), rows = timeline(output);
  const hidden = output.keyframes.map((frame, index) => ({frame, tick: rows[index].start})).filter(({frame}) => frame.duration_raw === 0);
  assert.deepEqual(hidden.map(item => item.tick), [4, 6]);
  assert.equal(hidden[1].frame.objects.find(object => object.unique_id === 1).root_x, 250);
  const native = await nativeRoundtrip(output); assert.equal(native.keyframes.filter(frame => frame.duration_raw === 0).length, 2);
  assert.equal(native.total_output_frames, editor.totalTicks);
  for (let tick = 0; tick < editor.totalTicks; tick++) compareFrames(report, sample(report, tick), native, sample(native, tick));
});

test('hidden layer parents are omitted while their visible joined children keep exact world poses', async () => {
  const editor = fixture(), layer = editor.createLayer('Hidden parent'); editor.assignFiguresToLayer([1], layer.id); editor.setLayerVisible(layer.id, false);
  const output = materializePivotDocument(editor.report), native = await nativeRoundtrip(output);
  for (let tick = 0; tick < editor.totalTicks; tick++) {
    const before = buildGeometry(editor.report, sample(editor.report, tick)), after = buildGeometry(native, sample(native, tick));
    const saved = [...after.objects.values()].find(g => g.obj.unique_id === 3), source = [...before.objects.values()].find(g => g.obj.unique_id === 3);
    assert.ok(![...after.objects.values()].some(g => g.obj.unique_id === 1)); assert.equal(saved.obj.join, null);
    near(saved.root.x, source.root.x); near(saved.root.y, source.root.y);
  }
});

test('unsupported baked durations reject before modifying the authoring document', () => {
  const editor = fixture(); editor.addAnimationKey({kind: 'camera'}, 'x', 100000, 4); const before = editor.report.keyframes;
  assert.throws(() => materializePivotDocument(editor.report), /supported limit/); assert.equal(editor.report.keyframes, before);
});

test('authored legacy export migrates real held poses and preserves new hidden exposure keys',
  {skip: missingFixture('../Pivot Animator v5/Animations/Legacy/walking.piv')}, async () => {
  const sourcePath = fileURLToPath(new URL('../../Pivot Animator v5/Animations/Legacy/walking.piv', import.meta.url));
  const decoded = (await importBytes(readFileSync(sourcePath), path.basename(sourcePath))).document;
  const editor = new Editor({demo: false}).load(decoded); assert.ok(editor.report.version < 5);
  const camera = {kind: 'camera'}, key = editor.addAnimationKey(camera, 'pose', 2, {frameId: editor.getFrameId(0)});
  editor.setAnimationKey(editor.animationChannel(camera, 'pose').id, key.id, {hidden: true});
  editor.addAnimationKeys([{target: camera, property: 'x', tick: 0, value: 0}, {target: camera, property: 'x', tick: 6, value: 30},
    {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xff123456}]);
  const output = materializePivotDocument(editor.report), native = await nativeRoundtrip(output, sourcePath);
  assert.equal(native.version, 5); assert.equal(native.total_output_frames, editor.totalTicks);
  assert.equal(native.keyframes.filter(frame => frame.duration_raw === 0).length, 1);
  for (let tick = 0; tick < editor.totalTicks; tick++) compareFrames(editor.report, sample(editor.report, tick), native, sample(native, tick));
});
