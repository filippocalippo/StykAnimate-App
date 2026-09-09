import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import backend from '../desktop/backend.cjs';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {evaluatedFrame, timeline, buildGeometry} from '../src/pivot/geometry.mjs';
import {materializePivotDocument, needsPivotMaterialization} from '../src/pivot-export-materialize.mjs';
import {synchronizeExistingDerived} from '../src/document-normalize.mjs';

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
function nativeRoundtrip(document, sourcePath) {
  synchronizeExistingDerived(document);
  const script = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
store=server.ProjectStore(server.WORKSPACE)
request={'document':json.load(sys.stdin),'format':'piv'}
if len(sys.argv)>1:
 path=Path(sys.argv[1]); imported=store.import_bytes(path.read_bytes(),path.name); request['sourceId']=imported['sourceId']
data,name=store.export(request)
print(json.dumps(store.import_bytes(data,name)['document']))
`;
  const python = backend.pythonCandidates()[0], result = spawnSync(python.command, [...python.args, '-c', script, ...(sourcePath ? [sourcePath] : [])], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify(document), encoding: 'utf8', windowsHide: true, maxBuffer: 24 * 1024 * 1024});
  assert.equal(result.status, 0, result.error?.message || result.stderr); return JSON.parse(result.stdout);
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
  const editor = new Editor({demo: false}); editor.addFigure(); const report = editor.report;
  assert.equal(needsPivotMaterialization(report), false); assert.equal(materializePivotDocument(report), report);
});

test('layer ordering alone preserves native exposures and retained opaque fields without baking', () => {
  const editor = fixture(), report = editor.report, before = structuredClone(report), output = materializePivotDocument(report);
  assert.equal(output.keyframes.length, report.keyframes.length);
  assert.deepEqual(output.keyframes.map(frame => frame.duration_raw), report.keyframes.map(frame => frame.duration_raw));
  assert.deepEqual(output.keyframes[0].object_draw_order_unique_ids, [2, 1, 3]);
  assert.deepEqual(output.keyframes[1].opaque_native, {token: 1}); assert.deepEqual(report, before);
  assert.equal(output._styk.layers, undefined); assert.equal(output._styk.animation, undefined);
});

test('independent layer/scalar/camera/scene channels bake and really roundtrip through native PIV', () => {
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
  const native = nativeRoundtrip(output); assert.equal(native.total_output_frames, 13); assert.equal(native._styk?.animation, undefined);
  for (let tick = 0; tick < 13; tick++) compareFrames(report, sample(report, tick), native, sample(native, tick));
  assert.equal(materializePivotDocument(native), native, 'Reimported output must never receive the authored overlays twice');
});

test('native and independently retimed hidden poses remain distinct zero-duration exposures', () => {
  const editor = fixture(); editor.report.keyframes[1].duration_raw = 0; editor._invalidate({timing: true});
  const target = {kind: 'layer', id: 'layer-1'}, pose = editor.nativePoseChannel(target);
  editor.moveAnimationKeys([{channelId: pose.id, keyIds: [pose.keys[1].id]}], 2);
  const report = editor.report, output = materializePivotDocument(report), rows = timeline(output);
  const hidden = output.keyframes.map((frame, index) => ({frame, tick: rows[index].start})).filter(({frame}) => frame.duration_raw === 0);
  assert.deepEqual(hidden.map(item => item.tick), [4, 6]);
  assert.equal(hidden[1].frame.objects.find(object => object.unique_id === 1).root_x, 250);
  const native = nativeRoundtrip(output); assert.equal(native.keyframes.filter(frame => frame.duration_raw === 0).length, 2);
  assert.equal(native.total_output_frames, editor.totalTicks);
  for (let tick = 0; tick < editor.totalTicks; tick++) compareFrames(report, sample(report, tick), native, sample(native, tick));
});

test('hidden layer parents are omitted while their visible joined children keep exact world poses', () => {
  const editor = fixture(), layer = editor.createLayer('Hidden parent'); editor.assignFiguresToLayer([1], layer.id); editor.setLayerVisible(layer.id, false);
  const output = materializePivotDocument(editor.report), native = nativeRoundtrip(output);
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

test('authored legacy export migrates real held poses and preserves new hidden exposure keys', () => {
  const sourcePath = fileURLToPath(new URL('../../Pivot Animator v5/Animations/Legacy/walking.piv', import.meta.url));
  const script = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
path=Path(sys.argv[1]); store=server.ProjectStore(server.WORKSPACE)
print(json.dumps(store.import_bytes(path.read_bytes(),path.name)['document']))
`;
  const python = backend.pythonCandidates()[0], decoded = spawnSync(python.command, [...python.args, '-c', script, sourcePath], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  assert.equal(decoded.status, 0, decoded.error?.message || decoded.stderr);
  const editor = new Editor({demo: false}).load(JSON.parse(decoded.stdout)); assert.ok(editor.report.version < 5);
  const camera = {kind: 'camera'}, key = editor.addAnimationKey(camera, 'pose', 2, {frameId: editor.getFrameId(0)});
  editor.setAnimationKey(editor.animationChannel(camera, 'pose').id, key.id, {hidden: true});
  editor.addAnimationKeys([{target: camera, property: 'x', tick: 0, value: 0}, {target: camera, property: 'x', tick: 6, value: 30},
    {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xff123456}]);
  const output = materializePivotDocument(editor.report), native = nativeRoundtrip(output, sourcePath);
  assert.equal(native.version, 5); assert.equal(native.total_output_frames, editor.totalTicks);
  assert.equal(native.keyframes.filter(frame => frame.duration_raw === 0).length, 1);
  for (let tick = 0; tick < editor.totalTicks; tick++) compareFrames(editor.report, sample(editor.report, tick), native, sample(native, tick));
});
