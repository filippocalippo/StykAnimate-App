// Two files the movieclip fuzz (drawings published after every gesture, starting from the sheet-movieclip fixture) found that opening refused,
// each replayed from its recorded calls, minimised: a copy of a drawing layer's key forked the figure a cel is joined to as if it were a cel
// ("Invalid drawing metadata or paint dimensions."), and another segment added to a drawing cel left a cel with two ("A drawing needs one embedded
// PNG sprite matching its pixel dimensions.").
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {snapshotDocument} from '../src/engine/engine-owner.mjs';
import {makeProjectFile} from '../src/engine/engine-document-export.mjs';
import {openBytes} from '../src/engine/engine-open.mjs';
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

/** An editor on the fixture whose drawings are published as the app publishes them. */
function session() {
  const {editor} = ownedEditorSync(options, fixture, {verify: false, recorded: false});
  const resources = new DrawingResources(editor.report, {worker, onPublished: figure => editor._drawingPublished(figure)});
  return {editor, resources};
}

/** The `draw` of the recorded calls: a stroke of two samples on the drawing cel at `world`, published. */
async function draw({editor, resources}, world, points, seed) {
  let target;
  try { target = editor.prepareDrawingCel({pixelsPerUnit: 1, world}); } catch { editor.createDrawingLayer(); target = editor.prepareDrawingCel({pixelsPerUnit: 1, world}); }
  const surface = await editor.drawingResources.surface(target.figure);
  const brush = new DrawingStroke(surface.store, {size: 8, pressureSize: false, seed});
  for (const point of points) brush.sample(point);
  editor.commitDrawingPixels(target, brush.finish());
  await resources.flush();
}

async function opens(editor) {
  const file = makeProjectFile({join: null, cancelled: () => false, request: {snapshots: [snapshotDocument(editor.report)], scopes: [], name: 'Saved'}});
  const opened = await openBytes(new Uint8Array(file.bytes), 'saved.styk', {layerTimeline: true});
  opened.dispose();
}

test('copying a key of a drawing layer forks the cels it shows and leaves the figure a cel is joined to as it is', async () => {
  const s = session(), {editor} = s;
  try {
    await draw(s, {x: 50, y: 19}, [{x: 14, y: 15}, {x: 53, y: 51}], 1);
    for (const end of [5, 6, 7]) editor.createMovieclip({start: 0, end});
    await draw(s, {x: 33, y: 41}, [{x: 49, y: 35}, {x: 17, y: 51}], 4);
    editor.joinFigure(8, 1);
    editor.sheetDuplicateFrameAfter();
    await opens(editor);
    const nonCels = editor.report.figure_types.filter(figure => figure._styk?.drawing && figure._styk.drawing.version === undefined);
    assert.deepEqual(nonCels.map(figure => figure.figure_type_id), [], 'no figure that is not a cel was given a cel identity');
  } finally { s.resources.dispose(); }
});

test('another segment cannot be added to a drawing cel, and the cel stays a file that opens', async () => {
  const s = session(), {editor} = s;
  try {
    await draw(s, {x: 38, y: 17}, [{x: 19, y: 22}, {x: 40, y: 8}], 1);
    const before = JSON.stringify(editor.report);
    assert.throws(() => editor.addSegment(), error => error.messageKey === 'errors.editorDrawing.aDrawingHasNoSegmentsToEdit', 'the edit is refused');
    assert.equal(JSON.stringify(editor.report), before, 'and changes nothing');
    await opens(editor);
  } finally { s.resources.dispose(); }
});

// Seed 403 (on the sheet-movieclip and the rig fixtures): the same refused save with other gestures first. The rig one splits a segment of the cel, then
// adds one (after a copy of the drawing, so it is the second cel that is selected); the sheet-movieclip one draws on a new drawing layer, then adds one.
const SEGMENT_GESTURES = [
  ['addSegment', []], ['addSegments', [[{}]]], ['splitSegment', [0.5]], ['splitSegmentBranch', [0.5]], ['splitBuilderSegments', []], ['deleteSegment', []],
  ['deleteSingleSegment', []], ['unsplitSegment', []], ['duplicateSegment', []], ['duplicateSegmentBranch', []], ['mirrorSegment', []],
  ['mirrorSegmentBranch', []],
];
// These two check what they are given (two joints, anchors) before they reach the figure: any refusal will do, and the document is the same.
const BY_ARGUMENTS = [['addConnector', []], ['addWeightedJoint', []]];
const REFUSED = 'errors.editorDrawing.aDrawingHasNoSegmentsToEdit';

for (const [fixtureName, prelude] of [['sheet-movieclip', async () => {}], ['rig', async ({editor}) => { editor.sheetDuplicateFrameAfter(); }]]) {
  test(`no gesture that edits the segments of a figure changes a drawing cel (${fixtureName}), and the project saves as a file that opens`, async () => {
    const document = JSON.parse(readFileSync(new URL(`../engine/tests/edit/${fixtureName}.document.json`, import.meta.url), 'utf8'));
    const {editor} = ownedEditorSync(options, document, {verify: false, recorded: false});
    const resources = new DrawingResources(editor.report, {worker, onPublished: figure => editor._drawingPublished(figure)});
    const s = {editor, resources};
    try {
      await draw(s, {x: 30, y: 1}, [{x: 22, y: 49}, {x: 6, y: 28}], 1);
      await prelude(s);
      const cel = editor.object;
      assert.ok(cel && editor.report.figure_types.find(figure => figure.figure_type_id === cel.figure_type_id)?._styk?.drawing, 'the cel is selected');
      for (const [gesture, args] of SEGMENT_GESTURES) {
        const before = JSON.stringify(editor.report);
        // Refused with the cel's own message, or (a gesture that finds nothing of the figure to work on) answering that it did nothing: the document is the same.
        try { editor[gesture](...args); } catch (error) { assert.equal(error.messageKey, REFUSED, `${gesture}: ${error.message}`); }
        assert.equal(JSON.stringify(editor.report), before, `${gesture} changes nothing`);
      }
      for (const [gesture, args] of BY_ARGUMENTS) {
        const before = JSON.stringify(editor.report);
        try { editor[gesture](...args); } catch { /* refused */ }
        assert.equal(JSON.stringify(editor.report), before, `${gesture} changes nothing`);
      }
      await opens(editor);
    } finally { resources.dispose(); }
  });
}
