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
import {DrawingResources, drawingResourcesFor} from '../src/drawing-resources.mjs';
import {drawingEngineOperation} from '../src/engine/engine-drawing-worker.mjs';
import {DrawingStroke} from './support/sketch-stroke.mjs';
import {ownedEditorSync} from './support/owned-editor.mjs';
import './support/engine-node.mjs';

const REFUSED = 'errors.editorDrawing.aDrawingKeepsItsOneImage';
// Deleting the only segment of any figure has a refusal of its own, which a cel has too.
const LAST_SEGMENT = 'errors.editorBuilderTopology.aFigureNeedsAtLeastOneSegmentDelete';
const refusal = (gesture, error) => ['deleteSegment', 'deleteSingleSegment'].includes(gesture) ? [REFUSED, LAST_SEGMENT] : [REFUSED];
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
    assert.throws(() => editor.addSegment(), error => error.messageKey === REFUSED, 'the edit is refused');
    assert.equal(JSON.stringify(editor.report), before, 'and changes nothing');
    await opens(editor);
  } finally { s.resources.dispose(); }
});

// Seed 403 (on the sheet-movieclip and the rig fixtures) is the refused save of 132 again with other gestures first: the rig one splits a segment of the cel and
// adds one (after a copy of the drawing, so it is the second cel that is selected); the sheet-movieclip one draws on a new drawing layer and adds one. What a cel
// refuses is what breaks it: another segment, a split, a removal. What keeps it a cel (mirroring or flipping it, changing the length or the angle of its image
// segment) is allowed, as it is in the editor of every build before. Each gesture runs with the joint of the cel selected (a gesture with no joint selected
// does nothing, and tests nothing), with arguments it takes.
const BREAKS = [
  ['addSegment', []], ['addSegments', [[{}]]], ['splitSegment', [0.5]], ['splitSegmentBranch', [0.5]], ['deleteSegment', []], ['deleteSingleSegment', []],
  ['duplicateSegment', []], ['duplicateSegmentBranch', []],
];
const KEEPS = [['mirrorSegment', []], ['mirrorSegmentBranch', []]];
// These check what they are given (two joints, anchors, a parent) before they reach the figure: any refusal will do, and the cel is a cel afterwards.
const BY_ARGUMENTS = [['addConnector', []], ['addWeightedJoint', []], ['unsplitSegment', []], ['splitBuilderSegments', [{fraction: 0.5}]], ['moveBuilderSegment', []]];

const celsOf = editor => editor.report.figure_types.filter(figure => figure._styk?.drawing);
const keepsItsImage = figure => figure.segments.length === 1 && figure.segments[0].segment_type === 'image' && figure.image_assets.length === 1;
const selectCel = editor => { const uid = editor.object.unique_id; editor.select(uid, 0); assert.equal(editor.selectedJoint, 0, 'the joint of the cel is selected'); return uid; };
const ensureResources = editor => drawingResourcesFor(editor.report) ?? new DrawingResources(editor.report, {worker, onPublished: figure => editor._drawingPublished(figure)});

for (const [fixtureName, prelude] of [['sheet-movieclip', async () => {}], ['rig', async ({editor}) => { editor.sheetDuplicateFrameAfter(); }]]) {
  test(`what breaks a drawing cel is refused and what keeps it one is allowed (${fixtureName}), history and the clipboard included, and the project saves as a file that opens`, async () => {
    const document = JSON.parse(readFileSync(new URL(`../engine/tests/edit/${fixtureName}.document.json`, import.meta.url), 'utf8'));
    const {editor} = ownedEditorSync(options, document, {verify: false, recorded: false});
    const resources = new DrawingResources(editor.report, {worker, onPublished: figure => editor._drawingPublished(figure)});
    const s = {editor, resources};
    try {
      await draw(s, {x: 30, y: 1}, [{x: 22, y: 49}, {x: 6, y: 28}], 1);
      await prelude(s);
      selectCel(editor);
      for (const [gesture, args] of BREAKS) {
        selectCel(editor);
        const before = JSON.stringify(editor.report);
        try { editor[gesture](...args); } catch (error) { assert.ok(refusal(gesture).includes(error.messageKey), `${gesture}: ${error.message}`); }
        assert.equal(JSON.stringify(editor.report), before, `${gesture} changes nothing`);
      }
      // The gestures that must say so: not merely do nothing.
      for (const [gesture, args] of BREAKS.filter(([name]) => ['addSegment', 'splitSegment', 'deleteSegment', 'duplicateSegment'].includes(name))) {
        selectCel(editor);
        assert.throws(() => editor[gesture](...args), error => refusal(gesture).includes(error.messageKey), `${gesture} is refused`);
      }
      for (const [gesture, args] of BY_ARGUMENTS) {
        selectCel(editor);
        const before = JSON.stringify(editor.report);
        try { editor[gesture](...args); } catch { /* refused */ }
        assert.ok(celsOf(editor).every(keepsItsImage), `${gesture} leaves the cels cels`);
        if (!celsOf(editor).every(keepsItsImage)) assert.equal(JSON.stringify(editor.report), before);
      }
      // What keeps it a cel is allowed, one step of history each, and undone and redone it still is one.
      const depth = editor._undo.length;
      for (const [gesture, args] of KEEPS) { selectCel(editor); editor[gesture](...args); assert.ok(celsOf(editor).every(keepsItsImage), `${gesture} keeps the cels`); }
      selectCel(editor);
      editor.setSegmentValues({length: 40});
      assert.ok(celsOf(editor).every(keepsItsImage), 'a length keeps the cel');
      selectCel(editor);
      editor.setSegmentValues({angle: 10});
      assert.ok(celsOf(editor).every(keepsItsImage), 'an angle keeps the cel');
      const steps = editor._undo.length - depth;
      assert.ok(steps > 0, 'the edits are in the history');
      const edited = JSON.stringify(editor.report);
      for (let step = 0; step < steps; step++) { await editor.undo(); assert.ok(celsOf(editor).every(keepsItsImage), 'undone, the cel is a cel'); }
      for (let step = 0; step < steps; step++) { await editor.redo(); assert.ok(celsOf(editor).every(keepsItsImage), 'redone, the cel is a cel'); }
      assert.equal(JSON.stringify(editor.report), edited, 'redone, the project is as it was edited');
      await opens(editor);
      // The clipboard: a cel copied and pasted is a cel of its own, and the project saves.
      selectCel(editor);
      editor.copySelection();
      editor.setActiveLayer('layer-1'); // a drawing layer takes one cel at a time
      editor.pasteSelection();
      assert.ok(celsOf(editor).every(keepsItsImage), 'a pasted cel is a cel');
      await opens(editor);
    } finally { resources.dispose(); }
  });
}

test('what breaks a drawing cel is refused inside a movieclip that is entered too, and the project saves as a file that opens', async () => {
  const s = session(), {editor} = s;
  try {
    const clip = editor.report.figure_types.find(figure => figure._styk?.movieclip);
    editor.enterMovieclip(clip.figure_type_id);
    const inside = {editor, resources: ensureResources(editor)};
    await draw(inside, {x: 30, y: 1}, [{x: 22, y: 49}, {x: 6, y: 28}], 1);
    selectCel(editor);
    for (const [gesture, args] of BREAKS.filter(([name]) => ['addSegment', 'splitSegment', 'deleteSegment'].includes(name))) {
      selectCel(editor);
      assert.throws(() => editor[gesture](...args), error => refusal(gesture).includes(error.messageKey), `${gesture} is refused in the clip`);
    }
    assert.ok(celsOf(editor).every(keepsItsImage));
    editor.leaveMovieclip();
    await opens(editor);
  } finally { s.resources.dispose(); }
});
