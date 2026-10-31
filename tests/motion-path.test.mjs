import test from 'node:test';
import assert from 'node:assert/strict';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {emptyDocument, createObject, createFrame} from '../src/demo.mjs';
import {motionPathTargets, pickMotionPathPoint} from '../src/motion-path.mjs';

const clone = value => structuredClone(value);
const near = (a, b, tolerance = 1e-4) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const point = (a, b, tolerance = 1e-4) => { near(a.x, b.x, tolerance); near(a.y, b.y, tolerance); };

/** Three stored keys, x=100 → 300 → 500. Rows: 0..9, 10..19, then the v5
 * end-key row at tick 20 (nativeTimeline clamps the last row to one tick). */
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [
    createFrame([createObject(figure, 1, 100, 200)], 10),
    createFrame([createObject(figure, 1, 300, 200)], 10),
    createFrame([createObject(figure, 1, 500, 200)], 10),
  ];
  return ownedEditorFor({demo: false, layerTimeline: true, propertyChannels: true}, report);
}

const rootTarget = {kind: 'node', uid: 1, handleId: 0, joint: -1};

test('an in-window path edit previews the moved pose at the playhead', () => {
  const editor = fixture();
  editor.seek(4); editor.select(1);
  assert.ok(editor.beginMotionPathEdit(rootTarget, 4));
  editor.updateMotionPathEdit({x: 500, y: 400});
  const display = editor._drag.display;
  assert.ok(display?.frame);
  near(display.frame.objects[0].root_x, 500);
  near(display.frame.objects[0].root_y, 400);
  editor.cancelMotionPathEdit();
  near(editor.evaluatedFrame.objects[0].root_x, 180);
});

test('motionless and cancelled path gestures leave no history or document change', () => {
  const editor = fixture();
  editor.select(1);
  const before = clone(editor.report), history = editor._undo.length;
  assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
  assert.equal(editor.commitMotionPathEdit(), false);
  assert.deepEqual(editor.report, before); assert.equal(editor._undo.length, history);
  assert.ok(editor.beginMotionPathEdit(rootTarget, 15));
  editor.updateMotionPathEdit({x: 222, y: 199});
  assert.ok(editor.cancelMotionPathEdit());
  assert.deepEqual(editor.report, before); assert.equal(editor._undo.length, history);
  // Dragging back to the original point commits nothing.
  assert.ok(editor.beginMotionPathEdit(rootTarget, 10));
  editor.updateMotionPathEdit({x: 350, y: 300});
  editor.updateMotionPathEdit({x: 300, y: 200});
  assert.equal(editor.commitMotionPathEdit(), false);
  assert.deepEqual(editor.report, before); assert.equal(editor._undo.length, history);
});

test('layer-sheet path edits publish one key at the remote tick', () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [0, 10, 20].map(x => createFrame([createObject(figure, 1, x, 200), createObject(figure, 2, 100 + x, 200)], 10));
  const editor = ownedEditorFor({demo: false, propertyChannels: true, layerTimeline: true}, report);
  editor.seek(3); editor.select(1);
  const history = editor._undo.length, sheetBefore = clone(editor.report._styk.layerSheet);
  assert.ok(editor.beginMotionPathEdit(rootTarget, 15));
  editor.updateMotionPathEdit({x: 77, y: 210});
  assert.deepEqual(editor.report._styk.layerSheet, sheetBefore);
  assert.equal(editor.commitMotionPathEdit(), true);
  assert.equal(editor.tick, 3);
  assert.equal(editor._undo.length, history + 1);
  assert.doesNotThrow(() => editor.serialize());
  const track = editor.report._styk.layerSheet.tracks['layer-1'];
  const key = track.keys.find(k => k.tick === 15);
  assert.ok(key?.value?.frameId);
  editor.seek(15);
  near(editor.evaluatedFrame.objects.find(o => o.unique_id === 1).root_x, 77);
  editor.undo(); editor.seek(15);
  near(editor.evaluatedFrame.objects.find(o => o.unique_id === 1).root_x, 15);
});

/** Parent + joined child: the child attaches at the parent's first segment end. */
function joinedFixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  const make = () => {
    const child = createObject(figure, 2, 0, 0);
    child.join = {target_object_slot: 0, target_handle_id: figure.segments[0].segment_id, target_unique_id: 1};
    return child;
  };
  report.keyframes = [
    createFrame([createObject(figure, 1, 100, 200), make()], 10),
    createFrame([createObject(figure, 1, 300, 200), make()], 10),
    createFrame([createObject(figure, 1, 500, 200), make()], 10),
  ];
  return ownedEditorFor({demo: false, layerTimeline: true, propertyChannels: true}, report);
}

test('a joined figure\'s origin trail edits the parent attach joint, not the component root', () => {
  const editor = joinedFixture(), figure = editor.report.figure_types[0];
  editor.seek(10); editor.select(2);
  // The child's root trail rides on the parent's attach handle: dragging it
  // rotates that parent joint instead of translating the whole component.
  assert.ok(editor.beginMotionPathEdit({kind: 'node', uid: 2, handleId: 0, joint: -1}, 10));
  assert.equal(editor._drag.target.uid, 1);
  assert.equal(editor._drag.target.handleId, figure.segments[0].segment_id);
  const geometry = editor.geometry;
  const attach = geometry.objects.get(0).joints.get(figure.segments[0].segment_id);
  editor.updateMotionPathEdit({x: attach.x + 40, y: attach.y});
  assert.equal(editor.commitMotionPathEdit(), true);
  editor.seek(10);
  const stored = editor.evaluatedFrame;
  near(stored.objects[0].root_x, 300);
  assert.ok(Math.abs(stored.objects[0].angles[0] - (-Math.PI / 2)) > 0.01, 'parent joint rotated');
  assert.ok(stored.objects[1].join, 'child stays attached');
  const after = editor.geometry;
  assert.ok(after.objects.get(0).joints.get(figure.segments[0].segment_id).x > attach.x + 10);
  editor.undo();
});

test('multi-target overlay lists every selected figure', () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = [
    createFrame([createObject(figure, 1, 100, 200), createObject(figure, 2, 400, 100)], 10),
    createFrame([createObject(figure, 1, 300, 200), createObject(figure, 2, 200, 300)], 10),
    createFrame([createObject(figure, 1, 500, 200), createObject(figure, 2, 400, 300)], 10),
  ];
  const editor = ownedEditorFor({demo: false, layerTimeline: true}, report);
  editor.selectMany([1, 2]);
  const targets = motionPathTargets(editor);
  assert.deepEqual(targets.map(t => t.uid).sort(), [1, 2]);
  // The primary selection keeps its joint target; the rest get root trails.
  editor.select(2, 1);
  const withJoint = motionPathTargets(editor, {all: true});
  assert.ok(withJoint.some(t => t.uid === 2 && t.joint === 1));
  assert.ok(withJoint.some(t => t.uid === 1 && t.joint === -1));
});

test('overlapping points pick the nearest time instead of the last frame', () => {
  const entry = {ticks:[0,1,2],points:new Map([0,1,2].map(t => [t,{tick:t,x:0,y:0}]))};
  assert.equal(pickMotionPathPoint(entry, {x:0,y:0}, {project:p=>p,tick:1}).tick,1);
});

test('dense labels do not overlap and held markers collapse around the current frame', async () => {
  const {layoutMotionPath} = await import('../src/motion-path.mjs');
  const points = Array.from({length:1600}, (_,tick)=>({tick,x:tick%400,y:Math.floor(tick/400)*10,key:true}));
  const entry = {ticks:points.map(p=>p.tick), points:new Map(points.map(p=>[p.tick,p]))};
  const layout = layoutMotionPath(entry,p=>p,{tick:800,labels:true});
  assert.ok(layout.badges.length<=48);
  for (const [i,a] of layout.badges.entries()) for (const b of layout.badges.slice(i+1))
    assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y);
  const held = layoutMotionPath(entry,()=>({x:10,y:10}),{tick:800});
  assert.equal(held.markers.length,1); assert.equal(held.markers[0].tick,800);
  assert.equal(held.badges.length,0);
});

/** Two figures whose limbs swing while the bodies travel. */
function swingFixture() {
  const report = emptyDocument(), figure = report.figure_types[0];
  report.keyframes = Array.from({length: 4}, (_, k) => createFrame([1, 2].map(uid => {
    const object = createObject(figure, uid, 100 + k * 80 + uid * 300, 200);
    object.angles = object.angles.map((a, j) => j ? a + Math.sin(k + j) * .6 : a);
    return object;
  }), 6));
  return ownedEditorFor({demo: false, layerTimeline: true, propertyChannels: true}, report);
}

test('limb-tip targets follow every branch end and the origin of each figure', async () => {
  const {figureTipJoints} = await import('../src/motion-path.mjs');
  const editor = swingFixture(), figure = editor.report.figure_types[0];
  const tips = figureTipJoints(figure), parents = new Set(figure.segments.map(s => Number(s.parent_id)));
  assert.ok(tips.length >= 4, 'a stick figure has hands, feet and a head');
  for (const index of tips) assert.equal(parents.has(Number(figure.segments[index].segment_id)), false);
  editor.select(1, tips[1]);
  const targets = motionPathTargets(editor, {joints: 'tips'});
  assert.deepEqual(targets[0], {kind: 'node', uid: 1, handleId: Number(figure.segments[tips[1]].segment_id), joint: tips[1]}, 'the selected joint leads');
  assert.equal(targets.length, tips.length + 1);
  assert.equal(new Set(targets.map(t => `${t.uid}:${t.handleId}`)).size, targets.length);
  assert.equal(motionPathTargets(editor, {joints: 'tips', all: true}).length, 2 * (tips.length + 1));
  assert.equal(motionPathTargets(editor, {joints: 'tips', all: true, maxTargets: 5}).length, 5);
});

test('speed colours rank faster segments warmer and draw without errors', async () => {
  const {drawMotionPath, MOTION_PATH_SPEED_COLORS} = await import('../src/motion-path.mjs');
  const points = [0, 1, 2, 3, 4, 5].map(tick => ({tick, x: tick < 3 ? tick : 2 + (tick - 2) * 20, y: 0, key: false}));
  const entry = {ticks: points.map(p => p.tick), points: new Map(points.map(p => [p.tick, p])), version: 0};
  const strokes = [];
  const context = new Proxy({}, {get: (target, name) => name in target ? target[name] : (name === 'stroke' ? () => strokes.push(target.strokeStyle) : () => {}),
    set: (target, name, value) => { target[name] = value; return true; }});
  drawMotionPath(context, entry, p => p, {tick: 0, speed: true});
  assert.ok(strokes.includes(MOTION_PATH_SPEED_COLORS[0]) && strokes.includes(MOTION_PATH_SPEED_COLORS.at(-1)));
  assert.equal(entry.screen.speed[0] < entry.screen.speed.at(-1), true);
});

