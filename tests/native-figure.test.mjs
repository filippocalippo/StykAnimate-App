import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeFigureDocument} from '../src/native-figure.mjs';
import {createDemo} from '../src/demo.mjs';
import {Editor} from '../src/editor.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {evaluatedFrame} from '../src/pivot/geometry.mjs';

test('native figure keeps the evaluated pose, precise style and assets without the project', () => {
  const report = createDemo();
  report.figure_types[0].custom = {opaque: '日本語', fraction: .123456789};
  report.keyframes[0].objects[0]._stykStyle = {outlineOpacity: .123456789};
  report._stykSource = {source_base64: 'unrelated original animation'};
  const before = structuredClone(report), tick = 1;
  const output = nativeFigureDocument(report, {figureUid: 1, tick});
  validateScene(output);
  assert.equal(output.figure_types.length, 1);
  assert.equal(output.keyframes.length, 1);
  assert.deepEqual(output.figure_types[0].custom, report.figure_types[0].custom);
  assert.equal(output.keyframes[0].objects[0]._stykStyle.outlineOpacity, .123456789);
  assert.deepEqual(output.keyframes[0].objects[0].angles, evaluatedFrame(report, 0, .5, tick).objects[0].angles);
  assert.equal(output._stykSource, undefined);
  assert.deepEqual(output.backgrounds, []);
  assert.deepEqual(report, before);
  const editor = new Editor({demo: false});
  const name = editor.name, count = editor.frame.objects.length;
  editor.importFigure(output);
  assert.equal(editor.name, name);
  assert.equal(editor.frame.objects.length, count + 1);
  assert.deepEqual(editor.object.angles, output.keyframes[0].objects[0].angles);
  assert.equal(editor.object._stykStyle.outlineOpacity, .123456789);
});

test('missing selection fails rather than exporting a different figure', () => {
  assert.throws(() => nativeFigureDocument(createDemo(), {figureUid: 999}), /Select a figure/);
});

test('authored channels are captured at the selected tick without retaining the animation', () => {
  const editor = new Editor().load(createDemo());
  editor.addAnimationKeys([
    {target: {kind: 'figure', uid: 1}, property: 'x', tick: 0, value: 110},
    {target: {kind: 'figure', uid: 1}, property: 'x', tick: 12, value: 290},
  ]);
  editor.seek(6);
  const output = nativeFigureDocument(editor.report, {figureUid: 1, tick: editor.tick});
  assert.equal(output.keyframes[0].objects[0].root_x, editor.evaluatedFrame.objects.find(o => o.unique_id === 1).root_x);
  assert.equal(output._styk.animation, undefined);
  validateScene(output);
});
