import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import backend from '../desktop/backend.cjs';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {layerVisible} from '../src/layers.mjs';

const clone = value => structuredClone(value);
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [4, 6, 1].map((duration, index) => {
    const objects = [createObject(figure, 1, 100 + index * 45, 220), createObject(figure, 2, 360, 220)];
    for (const object of objects) {
      object.angles = object.angles.map((angle, joint) => angle + index * .12 + joint * .004);
      object.len_flag = 1; object.lengths = figure.segments.map(segment => segment.length * (1 + index * .1));
      object.bend_flag = 1; object.bends = figure.segments.map((_, joint) => joint * .005);
    }
    const frame = createFrame(objects, duration); frame._styk = {unknown: {source: `pose-${index}`}}; return frame;
  });
  const editor = new Editor({demo: false}).load(report);
  return editor.load(editor.serialize(), 'Authored persistence');
}

function nativeStykRoundtrip(document) {
  const script = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
store=server.ProjectStore(server.WORKSPACE)
data,name=store.export({'document':json.load(sys.stdin),'format':'styk'})
result=store.import_bytes(data,name)
print(json.dumps({'name':name,'byteLength':len(data),'document':result['document']}))
`;
  const python = backend.pythonCandidates()[0], result = spawnSync(python.command, [...python.args, '-c', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify(document), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr); return JSON.parse(result.stdout);
}

function samples(editor, ticks = [0, 1, 2, 5, 8, 9, 12]) {
  return ticks.map(tick => {
    editor.seek(tick); const frame = editor.evaluatedFrame, geometry = editor.geometry;
    return {tick: editor.tick, camera: clone(frame.camera), background: [frame.background_id, frame._stykBackgroundColor],
      order: clone(frame.object_draw_order_unique_ids), visible: frame.objects.map(object => [object.unique_id, layerVisible(editor.report, object.unique_id)]),
      objects: [...geometry.objects.values()].map(object => ({uid: object.obj.unique_id, root: clone(object.root),
        segments: object.segments.map(segment => ({start: clone(segment.start), end: clone(segment.end)}))})), drawables: clone(geometry.drawables)};
  });
}

test('the Python STYK exporter and importer preserve real layers, independent pose sources, scalar curves and playback', () => {
  const editor = fixture(), originalIds = editor.report.keyframes.map((_, index) => editor.getFrameId(index));
  editor.renameLayer('layer-1', 'Backdrop');
  const actors = editor.createLayer('Actors').id, temporary = editor.createLayer('Temporary').id;
  editor.renameLayer(temporary, 'Remove this layer'); editor.deleteLayer(temporary);
  editor.assignFiguresToLayer([1], actors); editor.moveLayerTo(actors, 0);
  editor.setLayerVisible('layer-1', false); editor.setLayerLocked('layer-1', true); editor.setLayerLocked('camera', true);
  editor.setActiveLayer(actors);
  const target = {kind: 'layer', id: actors};
  editor.seek(2); const captured = editor.addAnimationKey(target, 'pose', 2);
  assert.equal(editor.frameIndexForId(captured.value.frameId), -1, 'An interpolated key must own a retained pose snapshot.');
  editor.addAnimationKeys([
    {target, property: 'pose', tick: 9, value: {frameId: originalIds[1]}},
    {target: {kind: 'figure', uid: 1}, property: 'x', tick: 0, value: 110},
    {target: {kind: 'figure', uid: 1}, property: 'x', tick: 12, value: 290},
    {target: {kind: 'figure', uid: 1}, property: 'opacity', tick: 0, value: 1},
    {target: {kind: 'figure', uid: 1}, property: 'opacity', tick: 12, value: .4},
    {target: {kind: 'camera'}, property: 'x', tick: 0, value: 0},
    {target: {kind: 'camera'}, property: 'x', tick: 12, value: 30},
    {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xffabcdef},
    {target: {kind: 'scene'}, property: 'color', tick: 12, value: 0xff123456},
  ]);
  editor.selectFrame(1); editor.deleteFrame();
  assert.equal(editor.frameIndexForId(originalIds[1]), -1); assert.ok(editor.getFrameById(originalIds[1]));
  assert.equal(Object.keys(editor.report._styk.frameSources).length, 2);
  const expected = samples(editor), output = editor.serialize(), result = nativeStykRoundtrip(output);
  assert.match(result.name, /\.styk$/i); assert.ok(result.byteLength > 0);
  assert.deepEqual(result.document._styk, output._styk);
  assert.deepEqual(result.document.keyframes.map(frame => frame._styk), output.keyframes.map(frame => frame._styk));
  const reopened = new Editor({demo: false}).load(result.document);
  assert.deepEqual(reopened.layers, editor.layers); assert.equal(reopened.activeLayerId, actors);
  assert.deepEqual(reopened.animationChannels, editor.animationChannels);
  assert.deepEqual(samples(reopened), expected);
  assert.notEqual(expected.find(sample => sample.tick === 2).objects.find(object => object.uid === 1).root.x, expected.at(-1).objects.find(object => object.uid === 1).root.x,
    'Scalar keys must cause actual animated movement.');
  assert.notEqual(expected[0].camera.x, expected.at(-1).camera.x);
});

for (const [name, edit] of [
  ['add a segment', editor => editor.addSegment({parentId: editor.figure.segments[2].segment_id, length: 24, angle: .4, thickness: 3})],
  ['duplicate a segment branch', editor => editor.duplicateSegmentBranch({angleOffset: .2})],
  ['split a segment', editor => editor.splitSegment(.35)],
]) test(`reusable topology edits ${name} in every retained pose source and undo exactly`, () => {
  const editor = fixture(), first = editor.captureFrameSource(editor.report.keyframes[0]), second = editor.captureFrameSource(editor.report.keyframes[1]);
  editor.selectFrame(0); editor.select(1, 2);
  const before = editor.serialize(), originalCount = editor.figure.segments.length;
  edit(editor);
  const count = editor.figure.segments.length; assert.ok(count > originalCount);
  for (const frame of [...editor.report.keyframes, editor.getFrameById(first), editor.getFrameById(second)]) {
    for (const object of frame.objects) {
      assert.equal(object.angles.length, count); assert.equal(object.lengths.length, count); assert.equal(object.bends.length, count);
    }
    assert.deepEqual(buildGeometry(editor.report, frame).warnings, []);
  }
  const command = editor._undo.at(-1);
  assert.equal(command.kind, 'topology'); assert.equal(command.after.frames.filter(frame => frame.sourceId).length, 2);
  assert.doesNotThrow(() => validateScene({...editor.report, keyframes: Object.values(editor.report._styk.frameSources)}));
  const after = editor.serialize(); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.deepEqual(editor.serialize(), after);
  const result = nativeStykRoundtrip(after), reopened = new Editor({demo: false}).load(result.document);
  assert.deepEqual(reopened.report._styk.frameSources, after._styk.frameSources);
  assert.equal(reopened.getFrameById(first).objects[0].angles.length, count);
});
