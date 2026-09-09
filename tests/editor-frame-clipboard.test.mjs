import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {createFrame, createObject, emptyDocument, defaultFigure} from '../src/demo.mjs';
import {createImageFigure, createImageBackground} from '../src/media-authoring.mjs';
import {buildGeometry, nativeTimeline, evaluatedFrame} from '../src/pivot/geometry.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {validateLayerState, layerVisible} from '../src/layers.mjs';
import {validateFrameIdentities} from '../src/editor-frames.mjs';

const clone = value => structuredClone(value);
const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';
const editorFor = document => new Editor({demo: false}).load(document);
function sourceDocument() {
  const report = emptyDocument(), first = report.figure_types[0], sprite = createImageFigure({dataUrl, width: 1, height: 1, name: 'Imported sprite.png'});
  sprite.figure_type_id = 8;
  report.figure_types.push(sprite, defaultFigure(99));
  report.backgrounds = [createImageBackground({dataUrl, width: 1, height: 1, name: 'Embedded scene.png', backgroundId: 7}),
    {background_id: 9, kind: 2, color: 0xff003399, name: 'Second color'}, {background_id: 99, kind: 2, color: 0xff000000, name: 'Unused'}];
  report.keyframes = [0, 100, 200].map((x, index) => {
    const parent = createObject(first, 12, x, 250), child = createObject(sprite, 3, -40, 12, {join: {target_object_slot: 0, target_handle_id: 1, target_unique_id: 12, target_figure_type_id: 1}});
    const frame = createFrame([parent, child], index + 2);
    Object.assign(frame, {background_id: 7, background_id_b: 9, background_mix: 97,
      object_draw_order: [1, 0], object_draw_order_unique_ids: [3, 12], native_unknown: {sentinel: 729}});
    return frame;
  });
  return report;
}
function destinationDocument() {
  const report = emptyDocument();
  report.figure_types[0].segments[0].length = 37;
  report.figure_types.push(defaultFigure(8));
  report.backgrounds = [{background_id: 7, kind: 2, color: 0xffddccbb, name: 'Destination'}];
  report.keyframes = [createFrame([createObject(report.figure_types[0], 3, 450, 200), createObject(report.figure_types[1], 12, 20, 30)], 5)];
  return report;
}
function validate(editor) { validateScene(editor.report); validateLayerState(editor.report._styk.layers); validateFrameIdentities(editor.report); }

test('cross-document sparse copy preserves referenced media, joins, order, duration and unrelated destination data in one undo', () => {
  const editor = editorFor(sourceDocument()), source = editor.report, snapshot = clone(source);
  assert.equal(editor.copyFrames([2, 0, 0]), 2); const clipboard = editor._frameClipboard;
  editor.load(destinationDocument()); assert.equal(editor._frameClipboard, clipboard); assert.equal(editor.clipboardFrameCount, 2);
  const before = clone(editor.report), oldFrame = editor.frame, history = editor._undo.length;
  assert.equal(editor.insertClipboardFrames(0), 2); validate(editor);
  assert.equal(editor._undo.length, history + 1); assert.equal(editor.report.keyframes[2], oldFrame);
  const frame = editor.report.keyframes[0], parent = frame.objects[0], child = frame.objects[1];
  assert.ok(![3, 12].includes(parent.unique_id)); assert.ok(![3, 12].includes(child.unique_id));
  assert.equal(editor.report.keyframes[1].objects[0].unique_id, parent.unique_id);
  assert.equal(editor.report.keyframes[1].objects[1].unique_id, child.unique_id);
  assert.equal(child.join.target_object_slot, 0); assert.equal(child.join.target_unique_id, parent.unique_id);
  assert.equal(child.join.target_figure_type_id, parent.figure_type_id);
  assert.deepEqual(frame.object_draw_order_unique_ids, [child.unique_id, parent.unique_id]);
  assert.deepEqual(editor.report.keyframes.slice(0, 2).map(value => value.duration_raw), [2, 4]);
  assert.deepEqual(frame.native_unknown, {sentinel: 729});
  const figure = editor.report.figure_types.find(value => value.figure_type_id === child.figure_type_id);
  assert.equal(figure.image_assets[0].data_url, dataUrl);
  assert.equal(editor.report.backgrounds.find(value => value.background_id === frame.background_id).data_url, dataUrl);
  assert.equal(editor.report.backgrounds.find(value => value.background_id === frame.background_id_b).color, 0xff003399);
  assert.ok(!editor.report.figure_types.some(value => value.figure_type_id === 99));
  assert.equal(editor.report.backgrounds.length, 3);
  assert.deepEqual(buildGeometry(editor.report, frame).objects.get(1).root, buildGeometry(source, source.keyframes[0]).objects.get(1).root);
  assert.deepEqual(source, snapshot);
  const after = clone(editor.report);
  editor.undo(); validate(editor); assert.deepEqual(editor.report, before);
  editor.redo(); validate(editor); assert.deepEqual(editor.report, after);
  assert.ok(editor._undo.at(-1).bytes > dataUrl.length * 2, 'Media is accounted in bounded history');
  assert.ok(!JSON.stringify(editor._undo.at(-1)).includes(dataUrl), 'Media does not enter synchronous history JSON');
});

test('same-document copies retain figure continuity and definitions, but every insertion receives fresh frame identities', () => {
  const editor = editorFor(sourceDocument()), figures = editor.report.figure_types.slice(), backgrounds = editor.report.backgrounds.slice();
  editor.copyFrames([0, 1]); const ids = new Set(editor.report.keyframes.map(frame => frame._styk.frameId));
  editor.appendClipboardFrames(); validate(editor);
  assert.deepEqual(editor.report.keyframes.slice(-2).map(frame => frame.objects.map(object => object.unique_id)), [[12, 3], [12, 3]]);
  assert.deepEqual(editor.report.figure_types, figures); assert.deepEqual(editor.report.backgrounds, backgrounds);
  assert.ok(editor.report.keyframes.slice(-2).every(frame => !ids.has(frame._styk.frameId)));
  assert.equal(editor.report._styk.layers.order.length, 1);
});

test('copy snapshots stay immutable after source edits and paste merges identical assets rather than duplicating them', () => {
  const editor = editorFor(sourceDocument()); editor.copyFrames([0]);
  editor.report.figure_types[0].segments[0].length = 456;
  editor.report.figure_types[1].image_assets[0].data_url = dataUrl + 'changed';
  editor.report.keyframes[0].objects[0].root_x = 777;
  editor.load(destinationDocument()); editor.appendClipboardFrames();
  const first = editor.report.keyframes.at(-1), figure = editor.report.figure_types.find(value => value.figure_type_id === first.objects[0].figure_type_id);
  assert.equal(figure.segments[0].length, 78); assert.equal(first.objects[0].root_x, 0);
  const figures = editor.report.figure_types.length, backgrounds = editor.report.backgrounds.length;
  editor.appendClipboardFrames(); assert.equal(editor.report.figure_types.length, figures); assert.equal(editor.report.backgrounds.length, backgrounds);
  assert.equal(editor.report.figure_types.find(value => value.figure_type_id === first.objects[1].figure_type_id).image_assets[0].data_url, dataUrl);
  validate(editor);
});

test('cut, undo, document replacement and append keep the clipboard independent from history', () => {
  const editor = editorFor(sourceDocument()); assert.equal(editor.cutFrames([0, 2]), 2); assert.equal(editor._undo.length, 1);
  assert.equal(editor.report.keyframes.length, 1); editor.undo(); assert.equal(editor.report.keyframes.length, 3);
  assert.equal(editor.clipboardFrameCount, 2); editor.newDocument(); assert.equal(editor.clipboardFrameCount, 2);
  const before = editor.report.keyframes.length; editor.appendClipboardFrames(); assert.equal(editor.report.keyframes.length, before + 2); validate(editor);
});

test('cross-document copied layers retain hidden assets, visibility, order and locks without changing destination layers', () => {
  const editor = editorFor(sourceDocument()), extra = editor.createLayer('Hidden source actors');
  editor.assignFiguresToLayer([3], extra.id); editor.setLayerVisible(extra.id, false); editor.setLayerLocked(extra.id, true);
  editor.copyFrames([0]); editor.load(destinationDocument()); const before = clone(editor.report._styk.layers);
  editor.appendClipboardFrames(); const frame = editor.report.keyframes.at(-1), parent = frame.objects[0], child = frame.objects[1];
  assert.equal(layerVisible(editor.report, parent.unique_id), true); assert.equal(layerVisible(editor.report, child.unique_id), false);
  assert.equal(editor.getLayer(editor.layerForUid(child.unique_id)).locked, true);
  assert.deepEqual(editor.report._styk.layers.byId['layer-1'], before.byId['layer-1']);
  assert.equal(frame.objects.length, 2); editor.undo(); validate(editor); assert.deepEqual(editor.report._styk.layers, before);
});

test('authored source clipboard samples composed row-start figures, camera and scene colors, preserving native source and stripping caches', () => {
  const report = sourceDocument(), editor = editorFor(report);
  editor.addAnimationKeys([{target: {kind: 'figure', uid: 12}, property: 'x', tick: 0, value: 83},
    {target: {kind: 'figure', uid: 12}, property: 'x', tick: 2, value: 193},
    {target: {kind: 'camera'}, property: 'x', tick: 0, value: 50},
    {target: {kind: 'scene'}, property: 'color', tick: 0, value: 0xff772211}]);
  const rows = nativeTimeline(report), expected = [0, 1].map(index => clone(evaluatedFrame(report, index, 0, rows[index].start))), snapshot = clone(report);
  editor.copyFrames([0, 1]); editor.load(emptyDocument()); editor.appendClipboardFrames();
  for (let index = 0; index < 2; index++) {
    const frame = editor.report.keyframes[index + 1];
    assert.equal(frame.objects[0].root_x, expected[index].objects[0].root_x); assert.equal(frame.camera.x, 50);
    assert.equal(editor.report.backgrounds.find(value => value.background_id === frame.background_id).color, 0xff772211);
    assert.ok(frame.objects.every(object => !object.runtime_segments)); assert.equal(frame._stykBackgroundColor, undefined);
  }
  assert.deepEqual(report, snapshot); validate(editor);
});

test('serializable clipboard survives a new editor process shape with just required assets and no original source payload', () => {
  const first = editorFor(sourceDocument()); first.report._stykSource = {data: 'private full project'}; first.copyFrames([1]);
  const payload = JSON.parse(JSON.stringify(first.frameClipboardDocument()));
  assert.equal(payload.figure_types.length, 2); assert.equal(payload.backgrounds.length, 2); assert.equal(payload._stykSource, undefined);
  const second = editorFor(destinationDocument()); assert.equal(second.restoreFrameClipboard(payload), 1);
  assert.equal(second.appendClipboardFrames(), 1); validate(second);
  const third = editorFor(JSON.parse(JSON.stringify(second.serialize()))); validate(third);
  assert.equal(third.report.figure_types.find(value => value.figure_type_id === third.report.keyframes.at(-1).objects[1].figure_type_id).image_assets[0].data_url, dataUrl);
  const clipboard = second._frameClipboard;
  assert.throws(() => second.restoreFrameClipboard({...payload, keyframes: [{duration_raw: 1, objects: [{unique_id: 4}]}]}), /Unknown/);
  assert.equal(second._frameClipboard, clipboard);
});

test('invalid positions reject before mutation and a legacy destination upgrades atomically for modern paste', () => {
  const editor = editorFor(sourceDocument()); editor.copyFrames([0]); editor.load(destinationDocument());
  let snapshot = clone(editor.report), history = editor._undo.length;
  assert.throws(() => editor.pasteFrames(-1), /position/); assert.deepEqual(editor.report, snapshot);
  editor.load({...emptyDocument(), version: 4, frame_delay_ms: 40}); snapshot = clone(editor.report);
  assert.equal(editor.pasteFrames(),1);assert.equal(editor.report.version,5);
  editor.undo();assert.deepEqual(editor.report,snapshot);
});

test('legacy source figure colors survive transfer into a modern document', () => {
  const source = emptyDocument(); source.version = 4; source.frame_delay_ms = 40;
  source.keyframes = [createFrame([createObject(source.figure_types[0], 1, 20, 30, {color_override_raw: -1}),
    createObject(source.figure_types[0], 2, 80, 30, {color_override_raw: 0x0033cc})], 1)];
  const expected = buildGeometry(source, source.keyframes[0]).drawables.map(shape => shape.rgb), editor = editorFor(source);
  editor.copyFrames(); editor.load(emptyDocument()); editor.appendClipboardFrames();
  assert.deepEqual(buildGeometry(editor.report, editor.report.keyframes.at(-1)).drawables.map(shape => shape.rgb), expected); validate(editor);
});

test('legacy repeated holds stay motionless and preserve output exposure when copied into modern tween timing', () => {
  const report = emptyDocument(); report.version = 4; report.frame_delay_ms = 40;
  report.keyframes = [createFrame([createObject(report.figure_types[0], 1, 0, 20)], 5), createFrame([createObject(report.figure_types[0], 1, 100, 20)], 1)];
  const editor = editorFor(report); editor.copyFrames([0, 1]); editor.load(emptyDocument());
  assert.equal(editor.appendClipboardFrames(), 3); assert.deepEqual(editor.report.keyframes.slice(1).map(frame => frame.duration_raw), [4, 1, 1]);
  for (let tick = 0; tick < 4; tick++) assert.equal(evaluatedFrame(editor.report, 1, tick / 4).objects[0].root_x, 0);
  assert.equal(editor.report.keyframes[2].objects[0].root_x, 0); assert.equal(editor.report.keyframes[3].objects[0].root_x, 100); validate(editor);
});

test('merged native asset aliases and source offsets do not create duplicate figure/background tables on repeated pastes', () => {
  const report = sourceDocument(), figure = report.figure_types[1], asset = figure.image_assets[0];
  asset.data_base64 = dataUrl.split(',')[1]; asset.source_start = 999; asset.source_end = 123456;
  figure.side_tables = [asset]; figure.segment_decode = {records_start: 600, records_end: 700};
  report.backgrounds[0].record_offset = 5000; report.backgrounds[0].data_base64 = dataUrl.split(',')[1];
  const editor = editorFor(report); editor.copyFrames([0]); editor.load(emptyDocument()); editor.appendClipboardFrames();
  const figures = editor.report.figure_types.length, backgrounds = editor.report.backgrounds.length;
  editor.appendClipboardFrames(); assert.equal(editor.report.figure_types.length, figures); assert.equal(editor.report.backgrounds.length, backgrounds); validate(editor);
  const clipboard = editor._frameClipboard; assert.equal(editor.copyFrames([]), 0); assert.equal(editor._frameClipboard, clipboard);
});
