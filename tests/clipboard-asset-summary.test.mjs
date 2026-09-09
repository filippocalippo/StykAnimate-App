import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {emptyDocument, defaultFigure, createFrame, createObject} from '../src/demo.mjs';
import {createImageFigure, createImageBackground} from '../src/media-authoring.mjs';
import {runClipboardWorkerRequest} from '../src/clipboard-worker-plan.mjs';
import {equivalentClipboardAsset, equivalentClipboardAssetSteps} from '../src/clipboard-asset-plan.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {validateFrameIdentities} from '../src/editor-frames.mjs';
import {validateLayerState} from '../src/layers.mjs';

const clone = structuredClone;
const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHk8AAAAASUVORK5CYII=';
const editorFor = report => new Editor({demo: false}).load(clone(report));
const figureId = (figure, id) => ({...clone(figure), figure_type_id: id});
const backgroundId = (background, id) => ({...clone(background), background_id: id});

function sourceDocument() {
  const report = emptyDocument(), walker = report.figure_types[0];
  const sprite = createImageFigure({dataUrl, width: 1, height: 1, name: 'Copied sprite'});
  sprite.figure_type_id = 8; report.figure_types.push(sprite);
  report.backgrounds = [createImageBackground({dataUrl, width: 1, height: 1, name: 'Copied background', backgroundId: 7}),
    {background_id: 9, kind: 2, color: 0xff003399, name: 'Copied color'}];
  report.keyframes = [0, 1].map(index => {
    const parent = createObject(walker, 12, 31 + index * 17, 220);
    const child = createObject(sprite, 3, -40, 12,
      {join: {target_object_slot: 0, target_handle_id: 1, target_unique_id: 12, target_figure_type_id: 1}});
    return {...createFrame([parent, child], index + 2), background_id: 7, background_id_b: 9, background_mix: 97,
      camera: {is_default: false, x: 17, y: -9, scale: 1.25, angle_rad: .2},
      object_draw_order: [1, 0], object_draw_order_unique_ids: [3, 12], native_unknown: {sentinel: 729}};
  });
  return report;
}

function collisionDocument() {
  const report = emptyDocument();
  report.figure_types = [1, 2, 8].map(id => {
    const figure = defaultFigure(id); figure.name = `Destination ${id}`; figure.segments[0].length += id; return figure;
  });
  report.backgrounds = [7, 1, 2, 9].map(id => ({background_id: id, kind: 2, color: 0xff112200 + id, name: `Destination ${id}`}));
  report.keyframes = [createFrame([createObject(report.figure_types[0], 3, 450, 200), createObject(report.figure_types[2], 12, 40, 30)], 5)];
  return report;
}

function workerClient(sent) {
  return {lastTimings: {inputBytes: 1000, outputBytes: 2000}, async run(payload, controls) {
    controls.checkCurrent(); sent.push(clone(payload));
    const result = await runClipboardWorkerRequest(clone(payload), {onProgress: controls.onProgress});
    controls.checkCurrent(); return clone(result);
  }};
}

async function pair(source = sourceDocument(), destination) {
  const editor = editorFor(source), reference = editorFor(source), sent = [];
  editor.setFrameClipboardWorker(workerClient(sent));
  const indices = source.keyframes.map((_, index) => index);
  assert.equal(await editor.copyFramesAsync(indices), indices.length); reference.copyFrames(indices);
  if (destination) {editor.load(clone(destination)); reference.load(clone(destination));}
  return {editor, reference, sent};
}

function validate(editor) {
  validateScene(editor.report); validateLayerState(editor.report._styk.layers); validateFrameIdentities(editor.report);
}

async function pasteMatchesReference(context, index = 1) {
  const {editor, reference, sent} = context;
  const before = clone(editor.report), original = editor.report, oldFrames = editor.report.keyframes.slice();
  const clipboard = editor._frameClipboard, clipboardValue = clone(editor.frameClipboardDocument()), history = editor._undo.length;
  const count = reference.pasteFrames(index);
  assert.equal(await editor.pasteFramesAsync(index), count); validate(editor);
  assert.equal(editor.report, original); assert.deepEqual(editor.report, reference.report);
  assert.equal(editor._undo.length, history + 1); assert.equal(editor._frameClipboard, clipboard);
  assert.deepEqual(editor.frameClipboardDocument(), clipboardValue);
  for (const [slot, frame] of oldFrames.entries()) assert.equal(editor.report.keyframes[slot < index ? slot : slot + count], frame);
  const after = clone(editor.report); editor.undo(); assert.deepEqual(editor.report, before);
  oldFrames.forEach((frame, slot) => assert.equal(editor.report.keyframes[slot], frame));
  editor.redo(); assert.deepEqual(editor.report, after); validate(editor);
  return {payload: sent.findLast(value => value.request.operation === 'paste'), count, before};
}

test('same-document asset preflight appends the independent definition captured before a source edit', async () => {
  const context = await pair();
  for (const editor of [context.editor, context.reference]) {
    const definition = clone(editor.report.figure_types[0]); definition.segments[0].length = 456;
    editor.replaceFigureDefinition(definition.figure_type_id, definition);
  }
  const {payload} = await pasteMatchesReference(context);
  const {editor} = context, inserted = editor.report.keyframes[1].objects[0];
  assert.equal(payload.request.sameDocument, true); assert.ok(payload.state.destinationSummary.assets);
  assert.deepEqual(payload.state.destinationSummary.assets.figures.matches, [[8, 8]]);
  assert.equal(editor.report.figure_types[0].segments[0].length, 456);
  assert.notEqual(inserted.figure_type_id, 1);
  assert.equal(editor.report.figure_types.find(value => value.figure_type_id === inserted.figure_type_id).segments[0].length, 78);
  assert.equal(editor._frameClipboard[0].objects[0].root_x, 31);
});

test('cross-document colliding figure/background IDs remap without reallocating unused destination IDs', async () => {
  const context = await pair(sourceDocument(), collisionDocument());
  const {payload, before} = await pasteMatchesReference(context);
  const summary = payload.state.destinationSummary.assets;
  assert.equal(payload.request.sameDocument, false); assert.equal(payload.request.sparseNativePaste, true);
  assert.deepEqual(summary.figures, {count: 3, ids: [1, 2, 8], matches: []});
  assert.deepEqual(summary.backgrounds, {count: 4, ids: [7, 1, 2, 9], matches: []});
  assert.deepEqual(payload.report.figure_types, []); assert.deepEqual(payload.report.backgrounds, []);
  const inserted = context.editor.report.keyframes[1], [parent, child] = inserted.objects;
  assert.deepEqual(inserted.objects.map(value => value.figure_type_id), [3, 4]);
  assert.deepEqual([inserted.background_id, inserted.background_id_b], [3, 4]);
  assert.ok(![3, 12].includes(parent.unique_id)); assert.ok(![3, 12].includes(child.unique_id));
  assert.deepEqual(child.join, {target_object_slot: 0, target_handle_id: 1, target_unique_id: parent.unique_id, target_figure_type_id: parent.figure_type_id});
  assert.deepEqual(inserted.object_draw_order_unique_ids, [child.unique_id, parent.unique_id]);
  assert.deepEqual(context.editor.report.figure_types.slice(0, 3), before.figure_types);
  assert.deepEqual(context.editor.report.backgrounds.slice(0, 4), before.backgrounds);
});

test('asset preflight chooses the first equivalent destination definition in array order, even before the original source ID', async () => {
  for (const sourceIdFirst of [false, true]) {
    const source = sourceDocument(), destination = emptyDocument();
    const figureIds = sourceIdFirst ? [1, 31] : [31, 1], backgroundIds = sourceIdFirst ? [7, 77] : [77, 7];
    destination.figure_types = [...figureIds.map(id => figureId(source.figure_types[0], id)), figureId(source.figure_types[1], 81)];
    destination.backgrounds = [...backgroundIds.map(id => backgroundId(source.backgrounds[0], id)), backgroundId(source.backgrounds[1], 91)];
    // Source locators and redundant encoded aliases do not affect asset equivalence.
    destination.figure_types[0].record_offset = 1800;
    destination.figure_types[0].segments[0].source_offset = 2200;
    destination.figure_types[0].side_tables = {different: true};
    destination.backgrounds[0].record_offset = 4000;
    destination.backgrounds[0].data_base64 = 'redundant old representation';
    const context = await pair(source, destination), {payload} = await pasteMatchesReference(context);
    const summary = payload.state.destinationSummary.assets;
    assert.deepEqual(summary.figures.matches, [[1, figureIds[0]], [8, 81]]);
    assert.deepEqual(summary.backgrounds.matches, [[7, backgroundIds[0]], [9, 91]]);
    assert.deepEqual(context.editor.report.keyframes[1].objects.map(value => value.figure_type_id), [figureIds[0], 81]);
    assert.equal(context.editor.report.keyframes[1].background_id, backgroundIds[0]);
    assert.equal(context.editor.report.figure_types.length, 3); assert.equal(context.editor.report.backgrounds.length, 3);
  }
});

test('native paste payload contains only matched copied definitions while preserving the complete reserved asset summary', async () => {
  const source = sourceDocument(), destination = collisionDocument();
  destination.figure_types.push(figureId(source.figure_types[0], 31), figureId(source.figure_types[1], 81));
  destination.backgrounds.push(backgroundId(source.backgrounds[0], 77), backgroundId(source.backgrounds[1], 91));
  for (let index = 0; index < 32; index++) {
    const figure = defaultFigure(100 + index); figure.name = `Unused destination figure ${index}`;
    figure.unused_payload = 'UNUSED_DESTINATION_ASSET_SENTINEL'; destination.figure_types.push(figure);
    destination.backgrounds.push({background_id: 100 + index, kind: 2, color: 0xff000000 + index,
      name: `Unused destination background ${index}`, unused_payload: 'UNUSED_DESTINATION_ASSET_SENTINEL'});
  }
  const context = await pair(source, destination), clipboard = clone(context.editor.frameClipboardDocumentView());
  const {payload, before} = await pasteMatchesReference(context), summary = payload.state.destinationSummary.assets;
  assert.equal(summary.figures.count, before.figure_types.length); assert.equal(summary.backgrounds.count, before.backgrounds.length);
  assert.deepEqual(summary.figures.ids, before.figure_types.map(value => value.figure_type_id));
  assert.deepEqual(summary.backgrounds.ids, before.backgrounds.map(value => value.background_id));
  assert.deepEqual(payload.report.figure_types, [figureId(clipboard.figure_types[0], 31), figureId(clipboard.figure_types[1], 81)]);
  assert.deepEqual(payload.report.backgrounds, [backgroundId(clipboard.backgrounds[0], 77), backgroundId(clipboard.backgrounds[1], 91)]);
  assert.ok(!JSON.stringify(payload).includes('UNUSED_DESTINATION_ASSET_SENTINEL'));
  assert.deepEqual(payload.clipboard, clipboard);
});

test('unmatched duplicate source definitions still share one newly allocated destination asset', async () => {
  const source = sourceDocument(), walker = source.figure_types[0];
  source.figure_types[1] = figureId(walker, 8); source.backgrounds[1] = backgroundId(source.backgrounds[0], 9);
  for (const frame of source.keyframes) frame.objects[1] = createObject(source.figure_types[1], 3, -40, 12,
    {object_slot: 1, join: {target_object_slot: 0, target_handle_id: 1, target_unique_id: 12, target_figure_type_id: 1}});
  const context = await pair(source, collisionDocument()), {payload, before} = await pasteMatchesReference(context);
  assert.deepEqual(payload.state.destinationSummary.assets.figures.matches, []);
  assert.deepEqual(payload.state.destinationSummary.assets.backgrounds.matches, []);
  const frame = context.editor.report.keyframes[1];
  assert.equal(frame.objects[0].figure_type_id, frame.objects[1].figure_type_id);
  assert.equal(frame.background_id, frame.background_id_b);
  assert.equal(context.editor.report.figure_types.length, before.figure_types.length + 1);
  assert.equal(context.editor.report.backgrounds.length, before.backgrounds.length + 1);
});

test('cancellation during asset preflight preserves document, clipboard, identities, selection, Undo and Redo before dispatch', async () => {
  const destination = emptyDocument();
  destination.figure_types = Array.from({length: 512}, (_, index) => {
    const figure = defaultFigure(index + 1); figure.segments.at(-1).thickness = 20 + index; return figure;
  });
  destination.keyframes = [createFrame([createObject(destination.figure_types[0], 12, 450, 200)])];
  const {editor, sent} = await pair(sourceDocument(), destination);
  editor.select(12); editor.moveSelection(3, 0); editor.moveSelection(5, 0); editor.undo();
  const before = {report: editor.report, document: clone(editor.report), clipboard: editor._frameClipboard,
    clipboardDocument: clone(editor.frameClipboardDocument()), undo: editor._undo, redo: editor._redo,
    undoValue: clone(editor._undo), redoValue: clone(editor._redo), selection: clone(editor._selectionState()),
    identity: editor._nextFrameIdentity, uid: editor._nextUid, revision: editor.revision};
  const controller = new AbortController(); let preflightProgress = 0;
  await assert.rejects(editor.pasteFramesAsync(1, {signal: controller.signal, yieldControl: async () => {}, onProgress(value) {
    if (value.phase === 'preparing-assets') {preflightProgress++; controller.abort();}
  }}), {name: 'AbortError'});
  assert.ok(preflightProgress > 0); assert.equal(sent.filter(value => value.request.operation === 'paste').length, 0);
  assert.equal(editor.report, before.report); assert.deepEqual(editor.report, before.document);
  assert.equal(editor._frameClipboard, before.clipboard); assert.deepEqual(editor.frameClipboardDocument(), before.clipboardDocument);
  assert.equal(editor._undo, before.undo); assert.equal(editor._redo, before.redo);
  assert.deepEqual(editor._undo, before.undoValue); assert.deepEqual(editor._redo, before.redoValue);
  assert.deepEqual(editor._selectionState(), before.selection); assert.equal(editor._nextFrameIdentity, before.identity);
  assert.equal(editor._nextUid, before.uid); assert.equal(editor.revision, before.revision);
});

test('legacy-to-modern native paste retains full destination asset tables for portable conversion', async () => {
  const source = emptyDocument(); source.version = 4; source.frame_delay_ms = 40;
  source.keyframes = [createFrame([createObject(source.figure_types[0], 12, 31, 220, {color_override_raw: -1})], 3)];
  const context = await pair(source, collisionDocument()), {payload, before, count} = await pasteMatchesReference(context);
  assert.equal(count, 2, 'The legacy repeated hold retains its native modern conversion.');
  assert.equal(payload.state.destinationSummary.assets, undefined);
  assert.deepEqual(payload.report.figure_types, before.figure_types); assert.deepEqual(payload.report.backgrounds, before.backgrounds);
  assert.equal(context.editor.report.keyframes[1].objects[0].color_override_raw, 0xff000000);
});

test('cooperative asset comparison preserves synchronous equality for keys, values and conditional ignored fields', () => {
  const cases = [
    [{figure_type_id: 1, name: 'Same', nested: {a: 1, b: 2}}, {nested: {b: 2, a: 1}, name: 'Same', figure_type_id: 81}, 'figure_type_id', true],
    [-0, +0, undefined, true], [[-0, +0], [+0, -0], undefined, true],
    [null, null, undefined, true], [undefined, undefined, undefined, true], [null, undefined, undefined, false],
    [0, false, undefined, false], [{}, {missing: undefined}, undefined, false],
    [[null, undefined], [null, undefined], undefined, true], [[], {}, undefined, false],
    [new Array(2), [], undefined, true], [[undefined], new Array(1), undefined, false],
    [{nested: {length: 3, record_offset: 500}, source_size: 90}, {nested: {length: 3, source_offset: 20}}, undefined, true],
    [{figure_type_id: 1, nested: {figure_type_id: 2}}, {figure_type_id: 8, nested: {figure_type_id: 3}}, 'figure_type_id', false],
    [{data_url: dataUrl, data_base64: 'old bytes', data_uri: 'old URI'}, {data_url: dataUrl}, undefined, true],
    [{data_url: dataUrl, data_base64: 'old bytes'}, {data_base64: 'old bytes'}, undefined, false],
    [{data_url: '', data_uri: 'a'}, {data_url: '', data_uri: 'b'}, undefined, false],
    [{image_assets: [], text_assets: [], side_tables: {sentinel: 1}}, {text_assets: [], image_assets: []}, undefined, true],
    [{image_assets: [], side_tables: {sentinel: 1}}, {image_assets: [], side_tables: {sentinel: 2}}, undefined, false],
    [Object.assign(Object.create(null), {name: 'Same'}), {name: 'Same'}, undefined, true],
  ];
  const keys = Array.from({length: 384}, (_, index) => `key-${index}`);
  cases.push([Object.fromEntries(keys.map((key, index) => [key, {index}])),
    Object.fromEntries(keys.toReversed().map(key => [key, {index: Number(key.slice(4))}])), undefined, true]);
  let yields = 0;
  for (const [index, [left, right, omitted, expected]] of cases.entries()) {
    const synchronous = equivalentClipboardAsset(left, right, omitted);
    assert.equal(synchronous, expected, `Synchronous equality for case ${index}`);
    const iterator = equivalentClipboardAssetSteps(left, right, omitted); let step;
    do {step = iterator.next(); if (!step.done) yields++;} while (!step.done);
    assert.equal(step.value, synchronous, `Cooperative equality for case ${index}`);
  }
  assert.ok(yields > 0, 'The wide nested comparison traverses cooperative checkpoints.');
});

test('invalid asset reservations and matches reject before publishing a native paste', async () => {
  const mutations = [
    summary => {summary.figures.count++;},
    summary => {summary.figures.ids[1] = summary.figures.ids[0];},
    summary => {summary.figures.ids[0] = 1.5;},
    summary => {summary.backgrounds.ids[0] = 0;},
    summary => {summary.figures.matches[0][0] = 9999;},
    summary => {summary.figures.matches[0][1] = 9999;},
    summary => {summary.figures.matches.push(clone(summary.figures.matches[0]));},
    summary => {summary.backgrounds.matches[0] = {source: 7, target: 7};},
    (_summary, report) => {report.figure_types.pop();},
  ];
  for (const mutate of mutations) {
    const {editor} = await pair(), original = editor._frameClipboardWorker;
    editor.select(12); editor.moveSelection(3, 0); editor.moveSelection(5, 0); editor.undo();
    const before = {report: editor.report, document: clone(editor.report), clipboard: editor._frameClipboard,
      clipboardDocument: clone(editor.frameClipboardDocument()), undo: editor._undo, redo: editor._redo,
      undoValue: clone(editor._undo), redoValue: clone(editor._redo), selection: clone(editor._selectionState()),
      identity: editor._nextFrameIdentity, uid: editor._nextUid, revision: editor.revision};
    editor.setFrameClipboardWorker({...original, async run(payload, controls) {
      mutate(payload.state.destinationSummary.assets, payload.report); return original.run(payload, controls);
    }});
    await assert.rejects(editor.pasteFramesAsync(1), /clipboard|asset|figure|background/i);
    assert.equal(editor.report, before.report); assert.deepEqual(editor.report, before.document);
    assert.equal(editor._frameClipboard, before.clipboard); assert.deepEqual(editor.frameClipboardDocument(), before.clipboardDocument);
    assert.equal(editor._undo, before.undo); assert.equal(editor._redo, before.redo);
    assert.deepEqual(editor._undo, before.undoValue); assert.deepEqual(editor._redo, before.redoValue);
    assert.deepEqual(editor._selectionState(), before.selection); assert.equal(editor._nextFrameIdentity, before.identity);
    assert.equal(editor._nextUid, before.uid); assert.equal(editor.revision, before.revision);
  }
});
