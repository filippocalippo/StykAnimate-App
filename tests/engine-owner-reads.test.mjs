import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {construction} from '../src/rig-examples-3d.mjs';
import {createObject, createFrame, emptyDocument} from '../src/demo.mjs';
import {Editor} from '../src/editor.mjs';
import {engineEditor} from './support/owned-editor.mjs';

const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

/** The editor's own bodies for these reads must never run: the session answers them. */
function withoutBodies(names, run) {
  const saved = names.map(name => [name, Editor.prototype[name]]);
  for (const name of names) Editor.prototype[name] = function () { throw new Error(`${name} ran in the editor`); };
  try { return run(); } finally { for (const [name, body] of saved) Editor.prototype[name] = body; }
}

function rig() {
  const q = construction(); q.add(0, 0, 0, 'Figure rotation');
  const bone = (parent, origin, tip, name, motion) => {
    const turn = q.add(0, 0, 0, name + ' turn'), pitch = q.add(0, 0, 0, name + ' tilt'), v = tip.map((n, i) => n - origin[i]);
    const id = q.add(parent, Math.hypot(...v), Math.atan2(v[1], v[0]), name, {control: true, rig: {spatial: {parent, origin, tip, turn, pitch, ...(motion ? {motion} : {})}}});
    return {id};
  };
  const wrist = bone(0, [0, 0, 0], [0, 20, 0], 'Wrist');
  const lip = bone(wrist.id, [10, 10, 0], [10, 20, 0], 'Mouth corner', {type: 'slide', min: -4, max: 4});
  const figure = {figure_type_id: 1, segments: q.segments, polyfills: [], image_assets: [], text_assets: []};
  const document = {...emptyDocument(), figure_types: [figure], keyframes: [createFrame([createObject(figure, 1, 200, 200)])]};
  return {document, wrist, lip};
}

test('the session answers the 3D pose and the travel of a mechanical joint', () => {
  const {document, wrist, lip} = rig();
  withoutBodies(['getSpatialPose', 'getSpatialMotion'], () => {
    const editor = engineEditor({demo: false, layerTimeline: true}, document);
    editor.select(1, wrist.id - 1);
    assert.equal(editor.setSpatialPose({turn: .3, pitch: -.2, bend: .1}), true);
    const pose = editor.getSpatialPose();
    near(pose.turn, .3); near(pose.pitch, -.2); near(pose.bend, .1);
    assert.equal(editor.getSpatialMotion(), null, 'a bone that is not a mechanism has no travel');
    editor.select(1, lip.id - 1);
    assert.equal(editor.setSpatialMotion(.75, {fraction: true}), true);
    const motion = editor.getSpatialMotion();
    assert.equal(motion.type, 'slide');
    near(motion.min, -4); near(motion.max, 4); near(motion.fraction, .75); near(motion.value, 2);
    editor.select(1, -1);
    assert.equal(editor.getSpatialPose(), null);
  });
});

test('the session samples an effect clip at a tick through its keys', () => {
  const report = emptyDocument(); report.keyframes = [createFrame([createObject(report.figure_types[0], 1, 100, 100)], 30)];
  withoutBodies(['sampleVfxClip'], () => {
    const editor = engineEditor({demo: false, layerTimeline: true}, report);
    const id = editor.addVfxClip({kind: 'figure', uid: 1}, 'glow', {start: 0, duration: 20}), effect = editor.getVfxClips().find(clip => clip.id === id).effects[0];
    editor.seek(0); editor.setVfxClipParameter(id, effect.id, 'radius', 10, {key: true});
    editor.seek(10); editor.setVfxClipParameter(id, effect.id, 'radius', 30, {key: true});
    const radius = tick => editor.sampleVfxClip(id, tick).find(item => item.id === effect.id).params.radius;
    near(radius(0), 10); near(radius(10), 30); near(radius(5), 20);
    near(radius(15), 30, 1e-9); // after the last key it holds
    assert.throws(() => editor.sampleVfxClip('nope', 0), error => error.messageKey === 'errors.editorVfxClips.selectAnEffectClip');
  });
});

test('a read the session refuses reaches the interface as the localized error a call\'s refusal is', () => {
  const report = emptyDocument(); report.keyframes = [createFrame([createObject(report.figure_types[0], 1, 100, 100)], 30)];
  const editor = engineEditor({demo: false, layerTimeline: true}, report);
  // The library, the rig test and the builder read the figure document of the selection from the session.
  assert.throws(() => editor._shown.figureDocument({figureUid: 999, tick: 0}),
    error => error.messageKey === 'errors.nativeFigure.selectAFigureOrMovieclipToExport' && error.message === 'Select a figure or movieclip to export.');
  assert.equal(editor._shown.figureDocument({figureUid: 1, tick: 0}).figure_types.length > 0, true, 'a figure that is there is answered');
});

test('a document with a property channel the engine cannot read is refused at open, so no read of the frame meets one', () => {
  // The records of the frame on show read the document's channels strictly; opening is where an unreadable one is told.
  const document = JSON.parse(readFileSync(new URL('../engine/tests/edit/origin-gestures-layout-sheet.document.json', import.meta.url), 'utf8'));
  document._styk.layerSheet.legacyAnimation = {channels: [null]};
  assert.throws(() => engineEditor({demo: false, layerTimeline: true, propertyChannels: true}, document), /animation channel table/);
});
