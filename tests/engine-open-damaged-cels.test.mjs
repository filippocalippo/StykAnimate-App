// A build that let a segment be added to a drawing cel wrote projects opening refused ("A drawing needs one embedded PNG sprite matching its pixel
// dimensions"). Opening mends them now, keeping the cel's image segment and its picture and dropping what a drawing cannot hold (the other segments,
// their poses), in the project and in every movieclip it holds; the next save opens as it is. A cel from such a file is not imported or pasted into a
// project either, so no save writes one again.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {snapshotDocument} from '../src/engine/engine-owner.mjs';
import {makeProjectFile} from '../src/engine/engine-document-export.mjs';
import {openBytes, openJson} from '../src/engine/engine-open.mjs';
import {DrawingResources} from '../src/drawing-resources.mjs';
import {drawingEngineOperation} from '../src/engine/engine-drawing-worker.mjs';
import {DrawingStroke} from './support/sketch-stroke.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import './support/engine-node.mjs';

const options = {demo: false, layerTimeline: true, propertyChannels: true};
const fixture = JSON.parse(readFileSync(new URL('../engine/tests/edit/sheet-movieclip.document.json', import.meta.url), 'utf8'));
const worker = {async request(kind, data) {
  let reply;
  await drawingEngineOperation({id: 0, kind, ...structuredClone(data)}, message => { reply = message; });
  if (reply.error) throw Object.assign(new Error(reply.error), {messageKey: reply.messageKey});
  return reply;
}, dispose() {}};

/** A project with a drawn cel, and the editor it was drawn in. */
async function drawnProject() {
  const {editor} = ownedEditorSync(options, fixture, {verify: false, recorded: false});
  const resources = new DrawingResources(editor.report, {worker, onPublished: figure => editor._drawingPublished(figure)});
  editor.createDrawingLayer();
  const target = editor.prepareDrawingCel({pixelsPerUnit: 1, world: {x: 30, y: 1}});
  const surface = await editor.drawingResources.surface(target.figure);
  const brush = new DrawingStroke(surface.store, {size: 8, pressureSize: false, seed: 1});
  brush.sample({x: 22, y: 49}); brush.sample({x: 6, y: 28});
  editor.commitDrawingPixels(target, brush.finish());
  await resources.flush();
  return {editor, resources};
}

const isCel = figure => Boolean(figure._styk?.drawing);
const celsOf = editor => editor.report.figure_types.filter(isCel);
/** A second segment on every cel of `document`, as the build that wrote such files made it: appended, with an entry in the poses of every object of the cel. */
function damage(document, celTypes = new Set()) {
  for (const figure of document.figure_types ?? []) {
    if (isCel(figure) && figure.segments.length === 1) {
      figure.segments.push({...figure.segments[0], segment_id: 99, parent_id: figure.segments[0].segment_id, segment_type: 'line', segment_kind: 'line', length: 30, thickness: 4, primitive_code: 0});
      figure.segment_count = 2;
      celTypes.add(figure.figure_type_id);
    }
  }
  const frames = [...(document.keyframes ?? []), ...Object.values(document._styk?.frameSources ?? {})];
  for (const frame of frames) for (const object of frame.objects ?? []) if (celTypes.has(object.figure_type_id)) {
    for (const key of ['angles', 'lengths', 'bends']) if (Array.isArray(object[key]) && object[key].length === 1) object[key] = [...object[key], 0];
  }
  for (const figure of document.figure_types ?? []) if (figure._styk?.movieclip?.document) damage(figure._styk.movieclip.document);
  if (document._styk?.movieclipSource?.document) damage(document._styk.movieclipSource.document, celTypes);
  return document;
}

/** What a cel is in a document, and what its objects hold, in every movieclip too. */
function cels(document, where = 'project', out = []) {
  for (const figure of document.figure_types ?? []) {
    if (isCel(figure)) out.push([`${where} definition ${figure.figure_type_id}`, JSON.stringify(figure)]);
    if (figure._styk?.movieclip?.document) cels(figure._styk.movieclip.document, `${where}/clip ${figure.figure_type_id}`, out);
  }
  const types = new Set((document.figure_types ?? []).filter(isCel).map(figure => figure.figure_type_id));
  const frames = [...(document.keyframes ?? []), ...Object.entries(document._styk?.frameSources ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([, frame]) => frame)];
  frames.forEach((frame, at) => { for (const object of frame.objects ?? []) if (types.has(object.figure_type_id)) out.push([`${where} frame ${at} object ${object.unique_id}`, JSON.stringify(object.angles)]); });
  return out;
}

test('a project with a cel that has a second segment opens mended, keeps the image and its pixels, and saves and opens again as it is', async () => {
  const {editor, resources} = await drawnProject();
  try {
    const healthy = JSON.parse(JSON.stringify(editor.report));
    // A movieclip holds a cel of its own too (a copy of the project's, with the identity of a cel of its own).
    const clip = healthy.figure_types.find(figure => figure._styk?.movieclip), cel = healthy.figure_types.find(isCel);
    const inClip = structuredClone(cel);
    inClip.figure_type_id = 90; inClip._styk.drawing.celId = 'cel-in-the-clip';
    clip._styk.movieclip.document.figure_types.push(inClip);
    const damaged = damage(structuredClone(healthy));
    assert.equal(damaged.figure_types.find(isCel).segments.length, 2, 'the project holds a cel with two segments');
    assert.ok(damaged.figure_types.find(figure => figure._styk?.movieclip)._styk.movieclip.document.figure_types.find(isCel).segments.length === 2, 'and so does its movieclip');
    // Opening mends each cel it finds (the project's and the clip's), and the opening says so.
    const opening = await openJson(structuredClone(damaged), 'damaged.styk', {layerTimeline: true});
    try { assert.ok(opening.repairs >= 2, `repairs: ${opening.repairs}`); } finally { opening.dispose(); }
    // The editor opens it the same way: the content is kept, the cels are what they were before they were damaged, pixels (the picture) included.
    const opened = ownedEditorSync(options, structuredClone(damaged), {verify: false, recorded: false}).editor;
    assert.deepEqual(cels(JSON.parse(JSON.stringify(opened.report))), cels(healthy));
    // Saved, the project opens as it is, with nothing left to mend, and the cels are the same.
    const file = makeProjectFile({join: null, cancelled: () => false, request: {snapshots: [snapshotDocument(opened.report)], scopes: [], name: 'Saved'}});
    const again = await openBytes(new Uint8Array(file.bytes), 'saved.styk', {layerTimeline: true});
    try {
      assert.equal(again.repairs, 0, 'nothing is left to mend');
      assert.deepEqual(cels(JSON.parse(JSON.stringify((await again.read()).report))), cels(healthy));
    } finally { again.dispose(); }
  } finally { resources.dispose(); }
});

test('a cel from a damaged file is not imported into a project, and nothing changes, history included', async () => {
  const {editor, resources} = await drawnProject();
  try {
    const healthy = JSON.parse(JSON.stringify(editor.report));
    const fileOf = document => {
      const cel = document.figure_types.find(isCel);
      const frame = Object.values(document._styk.frameSources).find(each => each.objects.some(object => object.figure_type_id === cel.figure_type_id));
      return {figure_types: [cel], keyframes: [{...frame, objects: frame.objects.filter(object => object.figure_type_id === cel.figure_type_id)}]};
    };
    editor.setActiveLayer('layer-1');
    // The control: the same cel from a healthy file is imported (on a layer that takes it), so the refusal below is of the damage and of nothing else.
    editor.importFigure(structuredClone(fileOf(healthy)));
    assert.ok(celsOf(editor).length > 1, 'the healthy cel was imported');
    editor.moveSelection(3, 4);
    const before = JSON.stringify(editor.report), undo = editor._undo.length, redo = editor._redo.length;
    assert.throws(() => editor.importFigure(structuredClone(fileOf(damage(structuredClone(healthy))))), error => error.messageKey === 'errors.editorDrawing.aDrawingKeepsItsOneImage');
    assert.equal(JSON.stringify(editor.report), before, 'the project is as it was');
    assert.deepEqual([editor._undo.length, editor._redo.length], [undo, redo], 'and so is its history');
    // The history still works: the edit before undoes and redoes, and the project saves as a file that opens.
    await editor.undo();
    await editor.redo();
    const saved = makeProjectFile({join: null, cancelled: () => false, request: {snapshots: [snapshotDocument(editor.report)], scopes: [], name: 'Saved'}});
    const opened = await openBytes(new Uint8Array(saved.bytes), 'saved.styk', {layerTimeline: true});
    try { assert.equal(opened.repairs, 0); } finally { opened.dispose(); }
  } finally { resources.dispose(); }
});
