import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import backend from '../desktop/backend.cjs';
import {Editor} from '../src/editor.mjs';
import {sceneValuesAt} from '../src/editor-scene.mjs';
import {evaluatedFrame} from '../src/pivot/geometry.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';

const clone = value => structuredClone(value);
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1kAAAAASUVORK5CYII=';
const gradient = {kind: 3, name: 'Dawn', x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.7, color_a: 0xffffaa44, color_b: 0xff4488ee};
function fixture({pose = false, historyLimit = 80} = {}) {
  const editor = new Editor({demo: false, historyLimit}); editor.addFigure();
  editor.setFrameDuration(10); editor.duplicateFrame(); editor.moveSelection(30, 5); editor.duplicateFrame(); editor.moveSelection(45, -10);
  const asset = editor.importSceneBackground(gradient), second = editor.importSceneBackground({kind: 2, color: 0xff112233, name: 'Night'});
  editor.setSceneBackground(asset.background_id, {indices: [0, 1]}); editor.selectFrame(0);
  if (pose) editor.addAnimationKeys([
    {target: {kind: 'scene'}, property: 'pose', tick: 0, value: {frameId: editor.getFrameId(0)}, interpolation: 'linear'},
    {target: {kind: 'scene'}, property: 'pose', tick: 20, value: {frameId: editor.getFrameId(2)}, interpolation: 'hold'},
  ]);
  editor.markSaved(); return {editor, gradient: asset, solid: second};
}
function at(editor, tick) {
  let index = 0; while (index + 1 < editor.timeline.length && editor.timeline[index + 1].start <= tick) index++;
  return sceneValuesAt(editor, index, tick);
}
function colorOf(editor, fields) { return fields._stykBackgroundColor ?? editor.report.backgrounds.find(asset => asset.background_id === fields.background_id)?.color; }

test('native scene range color uses one tiny history command and retains unrelated media/figure arrays', () => {
  const {editor} = fixture();
  const large = {background_id: 99, kind: 1, name: 'Unused', data_url: `UNRELATED_ASSET_${'x'.repeat(2_000_000)}`}; editor.report.backgrounds.push(large);
  const objects = editor.report.keyframes.map(frame => frame.objects), before = editor.report.keyframes.map(frame => frame.background_id), count = editor._undo.length;
  assert.equal(editor.setSceneColor(0x80123456, {indices: [0, 2]}), 2);
  assert.equal(colorOf(editor, at(editor, 0)), 0x80123456); assert.equal(colorOf(editor, at(editor, 20)), 0x80123456);
  assert.equal(editor.report.keyframes[1].background_id, before[1]); assert.equal(editor._undo.length, count + 1);
  const command = editor._undo.at(-1); assert.equal(command.kind, 'scene'); assert.ok(command.bytes < 5000); assert.ok(!JSON.stringify(command).includes('UNRELATED_ASSET'));
  assert.equal(editor.report.backgrounds.find(asset => asset.background_id === 99), large);
  objects.forEach((value, index) => assert.equal(editor.report.keyframes[index].objects, value));
  editor.undo(); assert.deepEqual(editor.report.keyframes.map(frame => frame.background_id), before);
  editor.redo(); assert.equal(colorOf(editor, at(editor, 20)), 0x80123456);
});

test('ordinary Scene edits do not implicitly create scalar animation channels', () => {
  const {editor} = fixture(); editor.setSceneColor(0xff335577); editor.importSceneBackground({kind: 1, name: 'Pixel', data_url: png});
  assert.equal(editor.animationChannels.length, 0);
  editor.seek(5); editor.setSceneColor(0xff556677); assert.equal(editor.tick, 0);
  assert.equal(colorOf(editor, editor.evaluatedFrame), 0xff556677);
});

test('Scene.pose edits at an inbetween create a tiny scene source and preserve other tracks/native frames', () => {
  const {editor} = fixture({pose: true});
  editor.addAnimationKeys([{target: {kind: 'camera'}, property: 'x', tick: 0, value: 100}, {target: {kind: 'figure', uid: editor.selectedUid}, property: 'x', tick: 0, value: 250}]);
  editor.seek(5); const before = editor.serialize(), nativeFrames = clone(editor.report.keyframes), count = editor._undo.length, camera = editor.animationChannel({kind: 'camera'}, 'x');
  assert.equal(editor.setSceneColor(0xff55aacc), 1); assert.equal(editor.tick, 5);
  assert.equal(colorOf(editor, at(editor, 5)), 0xff55aacc);
  const pose = editor.animationChannel({kind: 'scene'}, 'pose'), key = pose.keys.find(key => key.tick === 5), source = editor.getFrameById(key.value.frameId);
  assert.deepEqual(source.objects, []); assert.ok(JSON.stringify(source).length < 500);
  assert.equal(editor.animationChannel({kind: 'scene'}, 'color'), null); assert.equal(editor.animationChannel({kind: 'camera'}, 'x'), camera);
  assert.deepEqual(editor.report.keyframes, nativeFrames); assert.equal(editor._undo.length, count + 1);
  editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.equal(colorOf(editor, at(editor, 5)), 0xff55aacc);
  const reopened = new Editor({demo: false}); reopened.load(editor.serialize()); assert.equal(colorOf(reopened, at(reopened, 5)), 0xff55aacc);
});

test('background selection clears an existing held scalar color only at its new null key', () => {
  const {editor, gradient} = fixture(); editor.addAnimationKeys([
    {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xffff0000, interpolation: 'hold'},
    {target: {kind: 'scene'}, property: 'color', tick: 10, value: 0xff0000ff, interpolation: 'hold'},
  ]);
  editor.seek(5); const before = editor.serialize(), count = editor._undo.length;
  assert.equal(editor.setSceneBackground(gradient.background_id), 1);
  assert.equal(at(editor, 4)._stykBackgroundColor, 0xffff0000); assert.equal(at(editor, 5)._stykBackgroundColor, undefined);
  assert.equal(at(editor, 5).background_id, gradient.background_id); assert.equal(at(editor, 10)._stykBackgroundColor, 0xff0000ff);
  assert.equal(editor.animationChannel({kind: 'scene'}, 'color').keys.find(key => key.tick === 5).value, null);
  assert.equal(editor.animationChannel({kind: 'scene'}, 'backgroundId'), null); assert.equal(editor._undo.length, count + 1);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('Scene color respects an existing background scalar without creating a hidden new color track', () => {
  const {editor, gradient, solid} = fixture(); editor.addAnimationKeys([
    {target: {kind: 'scene'}, property: 'backgroundId', tick: 0, value: gradient.background_id},
    {target: {kind: 'scene'}, property: 'backgroundId', tick: 20, value: solid.background_id},
  ]);
  editor.seek(5); editor.setSceneColor(0xff7799cc);
  assert.equal(colorOf(editor, at(editor, 5)), 0xff7799cc); assert.equal(editor.animationChannel({kind: 'scene'}, 'color'), null);
  assert.equal(at(editor, 4).background_id, gradient.background_id); assert.equal(at(editor, 20).background_id, solid.background_id);
});

test('existing scalar color updates are absolute across sparse native key ticks and reuse the table', () => {
  const {editor} = fixture({pose: true}); editor.addAnimationKeys([{target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xffabcdef}]);
  const assets = editor.report.backgrounds, length = assets.length, before = editor.serialize();
  editor.setSceneColor(0, {indices: [0, 2]});
  assert.equal(at(editor, 0)._stykBackgroundColor, 0); assert.equal(at(editor, 20)._stykBackgroundColor, 0);
  assert.equal(editor.report.backgrounds, assets); assert.equal(assets.length, length);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('imported media plus Scene.pose/current color reset are one atomic command', () => {
  const {editor} = fixture({pose: true}); editor.addAnimationKeys([{target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xffeeddcc}]); editor.seek(6);
  const before = editor.serialize(), count = editor._undo.length;
  const imported = editor.importSceneBackground({kind: 1, name: 'Pixel', data_url: png, mime_type: 'image/png'});
  assert.equal(at(editor, 6).background_id, imported.background_id); assert.equal(at(editor, 6)._stykBackgroundColor, undefined);
  assert.equal(editor._undo.length, count + 1); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.equal(at(editor, 6).background_id, imported.background_id);
});

test('renaming an image background patches only its name, preserving media identity and bytes', () => {
  const {editor} = fixture(); const image = editor.importSceneBackground({kind: 1, data_url: `${png}${'x'.repeat(1_000_000)}`, name: 'Old name'});
  const count = editor._undo.length, bytes = image.data_url;
  assert.equal(editor.renameSceneBackground(image.background_id, '  New name  '), true);
  assert.equal(editor.report.backgrounds.find(asset => asset.background_id === image.background_id), image);
  assert.equal(image.data_url, bytes); assert.equal(image.name, 'New name'); assert.equal(editor._undo.length, count + 1); assert.ok(editor._undo.at(-1).bytes < 2000);
  editor.undo(); assert.equal(image.name, 'Old name'); editor.redo(); assert.equal(image.name, 'New name');
});

test('invalid, locked and hidden Scene edits reject before changing any document state', () => {
  const {editor} = fixture(), before = editor.serialize(), count = editor._undo.length;
  assert.throws(() => editor.setSceneBackground(999999), /existing/);
  assert.throws(() => editor.setSceneColor(-1), /ARGB/);
  assert.throws(() => editor.importSceneBackground({...gradient, x1: NaN}), /finite/);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor._undo.length, count);
  editor.setLayerLocked('scene', true); let locked = editor.serialize(); assert.throws(() => editor.setSceneColor(0), /Unlock/); assert.deepEqual(editor.serialize(), locked);
  editor.setLayerLocked('scene', false); editor.setLayerVisible('scene', false); locked = editor.serialize(); assert.throws(() => editor.setSceneColor(0), /Show/); assert.deepEqual(editor.serialize(), locked);
});

test('sparse Scene sampler agrees with the full evaluator over native blends, Scene poses and null/scalar colors', () => {
  const {editor} = fixture({pose: true}); editor.addAnimationKeys([
    {target: {kind: 'scene'}, property: 'color', tick: 4, value: 0xff123456, interpolation: 'hold'},
    {target: {kind: 'scene'}, property: 'color', tick: 8, value: null},
  ]);
  for (let tick = 0; tick < 30; tick++) {
    const index = Math.min(2, Math.floor(tick / 10)), actual = evaluatedFrame(editor.report, index, (tick - editor.timeline[index].start) / 10, tick);
    for (const key of ['background_id', 'background_id_b', 'background_mix', '_stykBackgroundColor']) assert.equal(at(editor, tick)[key], actual[key], `${tick}/${key}`);
  }
});

test('Scene source history survives pruning earlier commands and undo to the previous pose', () => {
  const {editor} = fixture({pose: true, historyLimit: 1}); editor.seek(5);
  editor.setSceneColor(0xff113355); const first = editor.animationChannel({kind: 'scene'}, 'pose').keys.find(key => key.tick === 5).value.frameId;
  editor.setSceneColor(0xff7799bb); assert.ok(editor.getFrameById(first));
  editor.undo(); assert.equal(colorOf(editor, at(editor, 5)), 0xff113355);
});

test('authored Scene colors and imported PNG backgrounds survive real native PIV export/reimport', () => {
  const {editor} = fixture({pose: true}); editor.seek(5); editor.setSceneColor(0x804466aa);
  editor.seek(12); editor.importSceneBackground({kind: 1, name: 'Pixel', data_url: png, mime_type: 'image/png'});
  const document = materializePivotDocument(editor.serialize());
  const script = String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path('backend').resolve()))
import server
store=server.ProjectStore(server.WORKSPACE)
raw,name=store.export({'document':json.load(sys.stdin),'format':'piv'})
print(json.dumps(store.import_bytes(raw,name)['document']))
`;
  const python = backend.pythonCandidates()[0], result = spawnSync(python.command, [...python.args, '-c', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify(document), encoding: 'utf8', windowsHide: true, maxBuffer: 12 * 1024 * 1024});
  assert.equal(result.status, 0, result.error?.message || result.stderr); const imported = JSON.parse(result.stdout);
  assert.equal(imported.keyframes.length, document.keyframes.length);
  const background = (report, tick) => report.backgrounds.find(asset => asset.background_id === report.keyframes[tick].background_id);
  assert.equal(background(imported, 5).color, 0x804466aa);
  assert.ok([0, 1].includes(background(imported, 12).kind));
  assert.equal(imported.keyframes[12].objects.length, document.keyframes[12].objects.length);
});
