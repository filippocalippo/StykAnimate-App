// The camera-motion graph plots what the engine samples of a clip (docs/camera-motion.md): the inspector asks for the clip's
// output at bounded ticks, a clip being edited included, and draws the curve. An editor the engine owns, read as the inspector reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {createCameraMotion} from './support/camera-motion.mjs';
import {motionGraphValues, motionGraphScale, motionGraphValueLabel, motionGraphTicks, plotMotionGraph} from '../src/camera-motion-graph.mjs';
import {engineBuilt} from './support/engine-node.mjs';
import {ownedEditor} from './support/owned-editor.mjs';

const options = {demo: false, layerTimeline: true};
/** A figure that walks from x = 100 to 700 over thirty ticks. */
function walker() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [100, 700].map(x => createFrame([createObject(figure, 1, x, 270)], 30));
  return report;
}
async function open() {
  const {editor, owner} = await ownedEditor(options, walker(), {recorded: false});
  return {editor, owner, plot: clip => { const ticks = motionGraphTicks(clip, 24); return plotMotionGraph(ticks, editor._shown.cameraSamples(clip, ticks.ticks)); }};
}

test('motion plots keep opposing axes separate and use actual degrees and zoom percentages', {skip: !engineBuilt}, async () => {
  const {owner, plot} = await open();
  try {
    const clip = createCameraMotion('impact', 'impact', 7, 24);
    Object.assign(clip.params, {direction: -45, moveX: 18, moveY: 18, roll: 3, zoom: .2, strength: 1.5});
    const graph = plot(clip);
    assert.ok(graph.channels.x[0] > 0 && graph.channels.y[0] < 0);
    assert.ok(Math.abs(graph.channels.x[0] + graph.channels.y[0]) < 1e-10);
    assert.equal(graph.channels.roll[0], 4.5);
    assert.ok(Math.abs(graph.channels.zoom[0] - (1.2 ** 1.5 - 1) * 100) < 1e-10);
    assert.equal(graph.channels.x.length, graph.count + 1);
  } finally { owner.release(); }
});

test('plots reflect strength, fades and mute rather than normalizing amplitude away', {skip: !engineBuilt}, async () => {
  const {owner, plot} = await open();
  try {
    const clip = createCameraMotion('wobble', 'wobble', 0, 48), before = plot(clip);
    clip.params = {...clip.params, strength: .5};
    const after = plot(clip);
    assert.equal(after.peaks.x, before.peaks.x / 2);
    assert.equal(after.channels.x[0], 0);
    clip.enabled = false;
    assert.deepEqual(plot(clip).peaks, {x: 0, y: 0, roll: 0, zoom: 0});
  } finally { owner.release(); }
});

test('graph work stays bounded for long clips and handles single-frame clips', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    const clip = createCameraMotion('shake', 'long', 0, 10000000);
    const ticks = motionGraphTicks(clip, 1);
    assert.equal(ticks.count, 2048);
    assert.equal(ticks.ticks.length, 2049);
    const graph = plotMotionGraph(ticks, editor._shown.cameraSamples(clip, ticks.ticks));
    assert.equal(graph.channels.x.length, 2049);
    const single = motionGraphTicks({...clip, duration: 1}, 24);
    assert.equal(single.span, 0);
    const one = plotMotionGraph(single, editor._shown.cameraSamples({...clip, duration: 1}, single.ticks));
    assert.ok(one.channels.x.every(n => n === one.channels.x[0]));
    for (const peak of [0, .004, .1, 1, 2.4, 12, 105, 300000]) assert.ok(Number.isFinite(motionGraphScale(peak)) && motionGraphScale(peak) >= peak);
    assert.equal(motionGraphValueLabel(.00042), '0.00042');
    assert.deepEqual(motionGraphValues({x: 1, y: 2, rotation: Math.PI, zoom: 1.5}), {x: 1, y: 2, roll: 180, zoom: 50});
  } finally { owner.release(); }
});

test('a follow clip is plotted as the camera it makes: moving with the figure, never beyond the clip', {skip: !engineBuilt}, async () => {
  const {editor, owner, plot} = await open();
  try {
    const clip = createCameraMotion('follow', 'follow', 5, 20, {targets: [{uid: 1, weight: 1}]});
    const graph = plot(clip);
    const x = graph.channels.x;
    assert.equal(x.length, 20, 'one sample for every frame of the clip');
    // It fades in and out (the clip's envelope); between, the camera is where the figure left of the frame's middle is.
    assert.ok(Math.abs(x[0]) < 1 && Math.min(...x) < -100, 'the camera goes toward the figure');
    assert.ok(Math.abs(x.at(-1)) < Math.abs(Math.min(...x)) / 4, 'and lets go of it as the clip ends');
    // Outside the clip it does nothing.
    assert.deepEqual(editor._shown.cameraSamples(clip, [0, 40]), [0, 0, 0, 1, 0, 0, 0, 1]);
  } finally { owner.release(); }
});

test('a clip that is being edited is sampled as it is given, not as it is stored', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    const clip = createCameraMotion('follow', 'follow', 5, 20, {targets: [{uid: 1, weight: 1}]});
    const stored = editor._shown.cameraSamples(clip, [15]);
    const lazier = editor._shown.cameraSamples({...clip, params: {...clip.params, lag: 40}}, [15]);
    assert.notEqual(lazier[0], stored[0], 'the camera of a slower follow is somewhere else');
    assert.deepEqual(editor._shown.cameraSamples(clip, [15]), stored, 'and the stored one is as it was');
    const shake = createCameraMotion('shake', 'shake', 0, 24);
    const loud = editor._shown.cameraSamples({...shake, params: {...shake.params, strength: 2}}, [12]);
    const quiet = editor._shown.cameraSamples(shake, [12]);
    assert.ok(Math.abs(loud[0]) > Math.abs(quiet[0]) || Math.abs(loud[1]) > Math.abs(quiet[1]));
  } finally { owner.release(); }
});

test('the framing that keeps the followed figures where they stand is read from the frame on show', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    editor.seek(0);
    const left = editor._shown.framing([{uid: 1, weight: 1}]);
    editor.seek(29);
    const right = editor._shown.framing([{uid: 1, weight: 1}]);
    assert.ok(left.x < 0 && right.x > left.x + 300, 'the figure walks from the left of the frame to the right');
    assert.equal(editor._shown.framing([{uid: 99, weight: 1}]), null, 'a figure that is not in the frame');
  } finally { owner.release(); }
});

test('the camera the frame on show is shot with includes the clips, and another frame holds its own', {skip: !engineBuilt}, async () => {
  const {editor, owner} = await open();
  try {
    editor.addCameraMotion('shake', {start: 0, duration: 24});
    editor.seek(8);
    const shot = editor._shown.shot(), authored = editor._shown.frameCamera(8);
    assert.ok(shot, 'the shake moves the camera');
    assert.notEqual(shot.x, authored?.x ?? 0);
    editor.seek(40);
    assert.equal(editor._shown.shot()?.x ?? 0, editor._shown.frameCamera(40)?.x ?? 0, 'past the clip nothing moves it');
  } finally { owner.release(); }
});
