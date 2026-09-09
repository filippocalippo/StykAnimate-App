import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor, emptyDocument} from '../src/editor.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {frameOrder} from '../src/pivot/structure.mjs';

const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const withoutFrameId = frame => { const value = structuredClone(frame); if (value._styk) delete value._styk.frameId; return value; };
const blank = () => { const editor = new Editor({demo: false}); editor.addFigure(); editor.markSaved(); return editor; };

test('native starter project evaluates and serializes every keyframe', () => {
  const editor = new Editor();
  assert.equal(editor.name, 'First steps'); assert.equal(editor.report.keyframes.length, 24);
  assert.equal(editor.totalTicks, 47); assert.equal(editor.dirty, false);
  for (let tick = 0; tick < editor.totalTicks; tick++) {
    editor.seek(tick); assert.equal(editor.geometry.objects.size, 3); assert.equal(editor.geometry.drawables.length, 12);
    assert.deepEqual(editor.geometry.warnings, []);
  }
  assert.doesNotThrow(() => validateScene(editor.serialize()));
});

test('a drag records only touched figures, is one undo step, and preserves other frames', () => {
  const editor = new Editor(), frameBefore = structuredClone(editor.frame);
  const otherFrame = editor.report.keyframes[12], otherFigure = editor.frame.objects[1];
  editor.beginDrag('Move figure');
  for (let i = 0; i < 100; i++) { editor.object.root_x += 1; editor.touch(); }
  editor.commitDrag();
  assert.equal(editor._undo.length, 1); assert.equal(editor._undo[0].kind, 'objects');
  assert.equal(editor._undo[0].before.length, 1); assert.equal(editor._undo[0].after[0].root_x, frameBefore.objects[0].root_x + 100);
  assert.equal(editor.report.keyframes[12], otherFrame); assert.equal(editor.frame.objects[1], otherFigure);
  assert.equal(editor.dirty, true); editor.undo(); assert.equal(editor.dirty, false);
  assert.deepEqual(editor.frame, frameBefore); editor.redo(); assert.equal(editor.dirty, true);
});

test('cancelled and motionless drags preserve saved state and history', () => {
  const editor = new Editor(), initial = editor.object.root_x;
  editor.beginDrag(); editor.object.root_x = 800; editor.touch(); editor.cancelDrag();
  assert.equal(editor.object.root_x, initial); assert.equal(editor.canUndo, false); assert.equal(editor.dirty, false);
  editor.beginDrag(); editor.commitDrag(); assert.equal(editor.canUndo, false);
});

test('geometry updates retain untouched object references and refresh only changed figures', () => {
  const editor = new Editor(); editor.beginDrag();
  const baseline = editor.geometry, ground = baseline.objects.get(1), walker = baseline.objects.get(0);
  editor.object.root_x += 20; editor.touch();
  const changed = editor.geometry;
  assert.equal(changed.objects.get(1), ground); assert.notEqual(changed.objects.get(0), walker);
  near(changed.objects.get(0).root.x, walker.root.x + 20);
  assert.deepEqual(changed.drawables, buildGeometry(editor.report, editor.frame).drawables);
});

test('object UID allocation, draw order, duplicate offset and frame undo stay coherent', () => {
  const editor = new Editor(), before = editor.serialize();
  editor.select(1); const copy = editor.duplicateFigure();
  assert.equal(copy.unique_id, 4); assert.equal(copy.join, null); near(copy.root_x, before.keyframes[0].objects[0].root_x + 24);
  assert.deepEqual(frameOrder(editor.frame), [1, 2, 3, 4]);
  editor.moveLayer(-1); assert.deepEqual(frameOrder(editor.frame), [1, 2, 4, 3]);
  editor.undo(); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.equal(editor.object.unique_id, 4);
});

test('deleting joined parent detaches child at the visible world location and undo restores join', () => {
  const editor = blank(), parentUid = editor.selectedUid;
  const childUid = editor.duplicateFigure().unique_id;
  editor.joinTo(parentUid, 2); const childRoot = {...editor.geometry.objects.get(editor.selectedSlot).root};
  editor.select(parentUid); editor.deleteFigure(); editor.select(childUid);
  assert.equal(editor.object.join, null); near(editor.object.root_x, childRoot.x); near(editor.object.root_y, childRoot.y);
  assert.doesNotThrow(() => validateScene(editor.serialize()));
  editor.undo(); editor.select(childUid); assert.equal(editor.object.join.target_unique_id, parentUid);
});

test('joining refuses direct and indirect cycles; unjoin preserves world root', () => {
  const editor = blank(), first = editor.selectedUid, second = editor.duplicateFigure().unique_id;
  editor.joinTo(first, 1); editor.select(first); assert.throws(() => editor.joinTo(second, 0), /cycle/);
  editor.select(second); const root = {...editor.geometry.objects.get(editor.selectedSlot).root};
  editor.unjoinFigure(); near(editor.object.root_x, root.x); near(editor.object.root_y, root.y);
});

test('joint rotation moves the full descendant limb and joined figure angles as one command', () => {
  const editor = blank(), parent = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinTo(parent, 3); const childAngles = [...editor.object.angles];
  editor.select(parent, 2); const initial = [...editor.object.angles];
  editor.updateSegment({angle_rad: initial[2] + 0.4});
  near(editor.object.angles[2], initial[2] + 0.4); near(editor.object.angles[3], initial[3] + 0.4);
  near(editor.object.angles[4], initial[4]);
  editor.select(child); editor.object.angles.forEach((angle, i) => near(angle, childAngles[i] + 0.4));
  editor.undo(); editor.select(child); assert.deepEqual(editor.object.angles, childAngles);
});

test('poseJoint reaches pointer, preserves length and stretches only when requested', () => {
  const editor = blank(); editor.select(editor.selectedUid, 3);
  const start = {...editor.geometry.objects.get(editor.selectedSlot).segments[3].start}, length = editor.figure.segments[3].length;
  editor.poseJoint(start.x + 80, start.y); let end = editor.geometry.objects.get(editor.selectedSlot).segments[3].end;
  near(end.y, start.y); near(end.x, start.x + length);
  editor.poseJoint(start.x + 80, start.y, {stretch: true}); end = editor.geometry.objects.get(editor.selectedSlot).segments[3].end;
  near(end.x, start.x + 80); near(editor.object.lengths[3], 80);
});

test('timeline edits preserve native terminal-frame and hidden-keyframe semantics', () => {
  const editor = blank(); editor.setFrameDuration(4); assert.equal(editor.totalTicks, 1);
  editor.duplicateFrame(); assert.equal(editor.totalTicks, 5); editor.setFrameDuration(0); assert.equal(editor.totalTicks, 4);
  editor.seek(2); assert.equal(editor.frameIndex, 0); near(editor.tick, 2);
  editor.selectFrame(1); assert.equal(editor.frameIndex, 1); assert.equal(editor.tick, 4);
  editor.deleteFrame(); assert.equal(editor.report.keyframes.length, 1);
  editor.undo(); assert.equal(editor.report.keyframes.length, 2); assert.equal(editor.frame.duration_raw, 0);
  editor.setFPS(30); assert.equal(editor.report.fps, 30); editor.undo(); assert.equal(editor.report.fps, 24);
});

test('segment topology applies to every native instance and survives undo/redo including detached joins', () => {
  const editor = blank(), parent = editor.selectedUid;
  const child = editor.duplicateFigure().unique_id; editor.joinTo(parent, 4);
  editor.duplicateFrame(); editor.select(parent, 2);
  const root = {...editor.geometry.objects.get(1).root};
  editor.deleteSegment();
  assert.equal(editor.figure.segments.length, 8);
  for (const frame of editor.report.keyframes) {
    assert.equal(frame.objects[0].angles.length, 8); assert.equal(frame.objects[1].join, null);
  }
  near(editor.frame.objects[1].root_x, root.x); near(editor.frame.objects[1].root_y, root.y);
  assert.doesNotThrow(() => validateScene(editor.serialize()));
  editor.undo(); assert.equal(editor.figure.segments.length, 10); assert.ok(editor.frame.objects[1].join);
  editor.redo(); assert.equal(editor.figure.segments.length, 8); assert.equal(editor.frame.objects[1].join, null);
  editor.addSegment({parentId: 1, type: 'circleFill', length: 25, angle: 0});
  assert.equal(editor.figure.segments.length, 9); assert.equal(editor.frame.objects[0].angles.length, 9);
  assert.doesNotThrow(() => validateScene(editor.serialize()));
});

test('figure import remaps IDs, copies binary asset references and poses, and is reversible', () => {
  const editor = blank(), source = emptyDocument(); source.figure_types[0].name = 'Imported rig';
  source.figure_types[0]._asset_bytes = 'BASE64-PRESERVED';
  const before = editor.serialize(); const object = editor.importFigure(source);
  assert.equal(object.figure_type_id, 2); assert.equal(editor.figure.name, 'Imported rig');
  assert.equal(editor.figure._asset_bytes, 'BASE64-PRESERVED'); assert.notEqual(editor.figure, source.figure_types[0]);
  editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.equal(editor.figure.name, 'Imported rig');
});

test('history is bounded and failed edits restore the current frame', () => {
  const editor = new Editor({historyLimit: 3});
  for (let i = 0; i < 10; i++) editor.updateObject({root_x: 600 + i});
  assert.equal(editor._undo.length, 3);
  const before = structuredClone(editor.frame);
  assert.throws(() => editor.transaction('Fail', frame => { frame.objects = []; throw new Error('abort'); }), /abort/);
  assert.deepEqual(editor.frame, before);
  assert.throws(() => editor.updateObject({root_x: Infinity}), /finite/);
  assert.throws(() => editor.setFrameDuration(-1), /duration/);
  assert.throws(() => editor.setFPS(0), /FPS/);
});

test('load validates before replacing the active document; serialization cannot mutate live poses', () => {
  const editor = new Editor(), original = editor.report, revision = editor.revision, undo = editor._undo;
  assert.throws(() => editor.load({...emptyDocument(), keyframes: [{duration_raw: 1, objects: null}]}));
  assert.equal(editor.report, original); assert.equal(editor.revision, revision); assert.equal(editor._undo, undo);
  const output = editor.serialize(); output.keyframes[0].objects[0].angles[0] = 42;
  assert.notEqual(editor.object.angles[0], 42);
});

test('project aliases, background swatches and dirty assignments integrate with the application', () => {
  const editor = new Editor(), before = editor.serialize();
  editor.updateProject({canvas_width: 1280}); assert.equal(editor.report.canvas_width, 1280);
  editor.undo(); assert.equal(editor.report.canvas_width, 960);
  assert.equal(editor.setAutoEasing, undefined);
  assert.throws(() => editor.updateProject({auto_easing: true}), /not editable/);
  editor.setFramesEasing([0], {interpolation: 'ease-in'}); assert.equal(editor.frame._styk.easing.interpolation, 'ease-in');
  editor.undo(); assert.equal(editor.frame._styk.easing, undefined);
  editor.setBackgroundColor(0xff223344); assert.equal(editor.frame.background_id, 1);
  assert.equal(editor.report.backgrounds[0].color, 0xff223344);
  assert.equal(editor.report.keyframes[1].background_id, 0);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.equal(editor.frame.background_id, 1);
  editor.dirty = false; assert.equal(editor.dirty, false); editor.dirty = true; assert.equal(editor.dirty, true);
  const metadata = editor.serialize()._styk;
  assert.deepEqual({format: metadata.format, format_version: metadata.format_version, name: metadata.name}, {format: 'StykAnimate', format_version: 1, name: 'First steps'});
  assert.equal(metadata.layers.version, 1);
});

test('drawing on an empty selection creates a native figure at the pointer in one undo step', () => {
  const editor = new Editor({demo: false}); editor.select(null);
  editor.addSegment({type: 'circle', length: 80, angle: 0, thickness: 6, start: {x: 120, y: 230}});
  assert.equal(editor.frame.objects.length, 1); assert.equal(editor.figure.segments.length, 1);
  assert.equal(editor.figure.segments[0].primitive_code, 1); near(editor.object.root_x, 120); near(editor.object.root_y, 230);
  const geometry = editor.geometry; near(geometry.drawables[0].end.x, 200);
  assert.throws(() => editor.deleteSegment(), /at least one/);
  editor.undo(); assert.equal(editor.frame.objects.length, 0); editor.redo(); assert.equal(editor.frame.objects.length, 1);
  assert.doesNotThrow(() => validateScene(editor.serialize()));
});

test('bend edits turn descendants without changing the bent segment baseline', () => {
  const editor = blank(); editor.select(editor.selectedUid, 2); const angles = [...editor.object.angles];
  editor.updateSegment({bend_rad: 0.7}); near(editor.object.angles[2], angles[2]); near(editor.object.angles[3], angles[3] + 0.7);
  editor.undo(); assert.deepEqual(editor.object.angles, angles);
});

test('non-contiguous frame copy, cut, paste and reversal are atomic and undoable', () => {
  const editor = new Editor(), initial = editor.serialize();
  assert.equal(editor.copyFrames([1, 3, 5]), 3); assert.equal(editor.clipboardFrameCount, 3);
  editor.pasteFrames(2); assert.equal(editor.report.keyframes.length, 27);
  assert.deepEqual(withoutFrameId(editor.serialize().keyframes[3]), withoutFrameId(initial.keyframes[3]));
  assert.notEqual(editor.getFrameId(3), initial.keyframes[3]._styk.frameId);
  assert.equal(new Set(editor.report.keyframes.map(frame => frame._styk.frameId)).size, 27);
  editor.undo(); assert.deepEqual(editor.serialize(), initial);
  editor.cutFrames([1, 3, 5]); assert.equal(editor.report.keyframes.length, 21);
  editor.undo(); assert.deepEqual(editor.serialize(), initial); editor.redo(); assert.equal(editor.report.keyframes.length, 21); editor.undo();
  editor.reverseFrames([0, 2, 4]); assert.deepEqual(editor.serialize().keyframes[0], initial.keyframes[4]);
  assert.deepEqual(editor.serialize().keyframes[2], initial.keyframes[2]); editor.undo(); assert.deepEqual(editor.serialize(), initial);
  editor.cutFrames(editor.report.keyframes.map((_, i) => i)); assert.equal(editor.report.keyframes.length, 1); assert.equal(editor.frame.objects.length, 0);
  editor.undo(); assert.deepEqual(editor.serialize(), initial);
});

test('figure clipboard detaches world roots, reuses same-document definitions, and pastes across documents', () => {
  const editor = blank(), parent = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinFigure(parent, 2); const world = {...editor.geometry.objects.get(editor.selectedSlot).root};
  editor.copyFigure(); assert.equal(editor.hasFigureClipboard, true); const types = editor.report.figure_types.length;
  const pasted = editor.pasteFigure(); assert.equal(editor.report.figure_types.length, types);
  assert.notEqual(pasted.unique_id, child); assert.equal(pasted.join, null); near(pasted.root_x, world.x + 24); near(pasted.root_y, world.y + 24);
  editor.undo(); assert.equal(editor.frame.objects.length, 2); editor.redo(); assert.equal(editor.frame.objects.length, 3);
  editor.load(emptyDocument()); const crossDocument = editor.pasteFigure(); assert.equal(editor.report.figure_types.length, 2);
  assert.equal(crossDocument.figure_type_id, 2); assert.equal(crossDocument.unique_id, 1);
  assert.equal(crossDocument.join, null); assert.doesNotThrow(() => validateScene(editor.serialize()));
  editor.cutFigure(); assert.equal(editor.frame.objects.length, 0); const restored = editor.pasteFigure();
  near(restored.root_x, crossDocument.root_x); near(restored.root_y, crossDocument.root_y);
});

test('clipboard pose remaps native handles when a shared definition topology changes', () => {
  const editor = blank(); editor.copyFigure(); editor.select(editor.selectedUid, 2); editor.deleteSegment();
  const pasted = editor.pasteFigure(); assert.equal(pasted.angles.length, 8);
  assert.doesNotThrow(() => validateScene(editor.serialize()));
});

test('background import clones embedded media and restores both table and current frame on undo', () => {
  const editor = new Editor(), before = editor.serialize();
  const source = {background_id: 9, name: 'Backdrop', kind: 0, data_url: 'data:image/png;base64,aGVsbG8=', image_base64: 'aGVsbG8='};
  const added = editor.importBackground(source); assert.equal(added.background_id, 1); assert.equal(editor.frame.background_id, 1);
  assert.equal(editor.report.keyframes[1].background_id, 0); assert.equal(source.background_id, 9);
  assert.equal(added.image_base64, source.image_base64); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); assert.equal(editor.frame.background_id, 1); assert.equal(editor.report.backgrounds[0].data_url, source.data_url);
  const snapshot = editor.serialize(); assert.throws(() => editor.importBackground({kind: 3, color_a: NaN}), /Background/);
  assert.deepEqual(editor.serialize(), snapshot);
});

test('multi-selection toggle/add and command undo keep the primary UID and selected set synchronized', () => {
  const editor = new Editor(); editor.select(1); editor.select(3, -1, {add: true});
  assert.deepEqual([...editor.selectedUids], [1, 3]); assert.equal(editor.selectedUid, 3); assert.equal(editor.selectedJoint, -1);
  editor.select(3, {toggle: true}); assert.deepEqual([...editor.selectedUids], [1]); assert.equal(editor.selectedUid, 1);
  editor.selectMany([1, 3, 999]); assert.deepEqual([...editor.selectedUids], [1, 3]);
  editor.deleteSelection(); assert.deepEqual([...editor.selectedUids], []); editor.undo();
  assert.deepEqual([...editor.selectedUids], [1, 3]); assert.equal(editor.selectedUid, 3);
  editor.selectedUids.clear(); assert.equal(editor.selectedUid, null);
});

test('group drag unions joined descendants once and baseline translation never accumulates pointer deltas', () => {
  const editor = blank(), parent = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinTo(parent, 2); editor.selectMany([parent, child]); const before = editor.serialize();
  const originalRoot = {...editor.geometry.objects.get(1).root};
  editor.beginDrag('Move selected'); assert.equal(editor._drag.before.length, 2);
  editor.moveSelection(10, 20, {fromStart: true}); editor.moveSelection(30, 50, {fromStart: true}); editor.commitDrag();
  near(editor.frame.objects[0].root_x, before.keyframes[0].objects[0].root_x + 30);
  const root = editor.geometry.objects.get(1).root; near(root.x, originalRoot.x + 30); near(root.y, originalRoot.y + 50);
  assert.equal(editor._undo.at(-1).before.length, 2); editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('group transforms move roots and rotate/scale/mirror each joined descendant only once', () => {
  const editor = blank(), parent = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinTo(parent, 1); const other = editor.duplicateFigure().unique_id;
  editor.selectMany([parent, child, other]); const before = editor.serialize(), angles = before.keyframes[0].objects.map(o => o.angles[0]);
  editor.rotateSelection(Math.PI / 2, {center: {x: 0, y: 0}});
  near(editor.frame.objects[0].root_x, -before.keyframes[0].objects[0].root_y);
  editor.frame.objects.forEach((o, i) => near(o.angles[0], angles[i] + Math.PI / 2)); editor.undo();
  editor.scaleSelection(2, {center: {x: 0, y: 0}}); editor.frame.objects.forEach(o => near(o.scale, 2));
  near(editor.frame.objects[0].root_x, before.keyframes[0].objects[0].root_x * 2); editor.undo();
  editor.mirrorSelection('horizontal', {center: {x: 0, y: 0}});
  editor.frame.objects.forEach((o, i) => near(o.angles[0], Math.PI - angles[i])); editor.undo();
  assert.deepEqual(editor.serialize(), before);
});

test('joined child translation moves the connected root and explicit detaching preserves the world root', () => {
  const editor = blank(), parent = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinTo(parent, 2); const root = {...editor.geometry.objects.get(1).root}, before = editor.serialize();
  editor.moveSelection(1, 2); assert.equal(editor.object.join.target_unique_id, parent);
  near(editor.geometry.objects.get(1).root.x, root.x + 1); near(editor.geometry.objects.get(1).root.y, root.y + 2);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.beginDrag(); editor.moveSelection(10, 20, {fromStart: true, detachExternal: true});
  editor.moveSelection(15, 30, {fromStart: true, detachExternal: true}); editor.commitDrag();
  editor.select(child); assert.equal(editor.object.join, null); near(editor.object.root_x, root.x + 15); near(editor.object.root_y, root.y + 30);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('group clipboard preserves internal joins, detaches external anchors, remaps UIDs and definitions across documents', () => {
  const editor = blank(), parent = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinTo(parent, 2); const third = editor.duplicateFigure().unique_id; editor.joinTo(parent, 1);
  editor.selectMany([parent, child]); assert.equal(editor.copySelection(), 2);
  const pasted = editor.pasteSelection(); assert.equal(pasted.length, 2); const [newParent, newChild] = pasted;
  assert.notEqual(newParent.unique_id, parent); assert.equal(newChild.join.target_unique_id, newParent.unique_id);
  assert.equal(editor.frame.objects[newChild.join.target_object_slot].unique_id, newParent.unique_id);
  assert.doesNotThrow(() => validateScene(editor.serialize())); editor.undo(); assert.equal(editor.frame.objects.length, 3);
  editor.load(emptyDocument()); const cross = editor.pasteSelection(); assert.equal(cross.length, 2);
  assert.equal(editor.report.figure_types.length, 2); assert.equal(cross[0].figure_type_id, cross[1].figure_type_id);
  assert.equal(cross[1].join.target_unique_id, cross[0].unique_id);
  assert.doesNotThrow(() => validateScene(editor.serialize()));
});

test('multi-delete detaches surviving children and layer moves preserve selected relative order', () => {
  const editor = new Editor(); editor.selectMany([1, 3]); editor.moveSelectionLayer(1);
  assert.deepEqual(frameOrder(editor.frame), [2, 1, 3]); editor.undo();
  editor.select(3); editor.joinTo(1, 2); const world = {...editor.geometry.objects.get(2).root};
  editor.selectMany([1, 2]); editor.deleteSelection(); assert.equal(editor.frame.objects.length, 1);
  assert.equal(editor.frame.objects[0].join, null); near(editor.frame.objects[0].root_x, world.x); near(editor.frame.objects[0].root_y, world.y);
  assert.doesNotThrow(() => validateScene(editor.serialize()));
});

test('invalid frame mutations and drag commits restore the document and selected set atomically', () => {
  const editor = new Editor(); editor.selectMany([1, 3]); const before = editor.serialize();
  assert.throws(() => editor.transaction('Invalid join', frame => { frame.objects[0].join = {target_object_slot: 999, target_handle_id: 0}; editor.select(null); }), /Join/);
  assert.deepEqual(editor.serialize(), before); assert.deepEqual([...editor.selectedUids], [1, 3]);
  editor.beginDrag(); editor.object.scale = -1; editor.touch(); assert.throws(() => editor.commitDrag(), /negative/);
  assert.deepEqual(editor.serialize(), before); assert.equal(editor.dragging, false);
});

test('replacement definitions preserve animated instance transforms and can be undone', () => {
  const editor = blank(); editor.rotateFigure(0.4); editor.duplicateFrame();
  const before = editor.serialize(), replacement = structuredClone(editor.figure);
  replacement.name = 'Edited text'; replacement.segments[0].angle_rad += 0.2; replacement._styk = {textAuthoring: {text: 'Updated'}};
  editor.replaceFigureDefinition(1, replacement, {label: 'Edit text'});
  assert.equal(editor.figure.name, 'Edited text');
  for (let i = 0; i < editor.report.keyframes.length; i++) near(editor.report.keyframes[i].objects[0].angles[0], before.keyframes[i].objects[0].angles[0] + 0.2);
  editor.undo(); assert.deepEqual(editor.serialize(), before); editor.redo(); assert.equal(editor.figure.name, 'Edited text');
});

test('playback seek may update timeline state without evaluating the sampled frame', () => {
  const editor = new Editor(), revision = editor.revision;
  const frame = editor.seek(3, {evaluate: false}); assert.equal(frame, editor.frame); assert.equal(editor.tick, 3);
  assert.equal(editor._evaluated, null); assert.equal(editor.revision, revision);
});

test('splitting a curved limb preserves original endpoint handles, poses and descendant positions', () => {
  const editor = blank(); editor.select(editor.selectedUid, 2); editor.updateSegment({bend_rad: 0.8, length: 70}); editor.duplicateFrame();
  const before = editor.serialize(), old = editor.geometry.objects.get(0), endpoint = {...old.joints.get(3)}, child = {...old.joints.get(4)};
  editor.select(editor.selectedUid, 2); editor.splitSegment(0.3);
  assert.equal(editor.figure.segments.length, 11); assert.equal(editor.figure.segments[3].segment_id, 3);
  near(editor.object.bends[2], 0.24); near(editor.object.bends[3], 0.56);
  const after = editor.geometry.objects.get(0); near(after.joints.get(3).x, endpoint.x, 5e-5); near(after.joints.get(3).y, endpoint.y, 5e-5);
  near(after.joints.get(4).x, child.x, 5e-5); near(after.joints.get(4).y, child.y, 5e-5);
  assert.doesNotThrow(() => validateScene(editor.serialize())); editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('setting the origin preserves rendered geometry and retargets attached children', () => {
  const editor = new Editor(); editor.select(3); editor.joinTo(1, 2); editor.select(1, 1);
  const before = editor.serialize(), baseline = editor.geometry, oldWalker = baseline.objects.get(0), oldChildRoot = {...baseline.objects.get(2).root};
  const oldOrigin = {...oldWalker.root}, newOrigin = {...oldWalker.joints.get(2)};
  editor.setOrigin(); const geometry = editor.geometry, walker = geometry.objects.get(0);
  near(walker.root.x, newOrigin.x); near(walker.root.y, newOrigin.y);
  near(walker.joints.get(2).x, oldOrigin.x, 5e-5); near(walker.joints.get(2).y, oldOrigin.y, 5e-5);
  const child = editor.frame.objects[2]; assert.equal(child.join.target_handle_id, 0);
  near(geometry.objects.get(2).root.x, oldChildRoot.x); near(geometry.objects.get(2).root.y, oldChildRoot.y);
  for (let i = 0; i < walker.segments.length; i++) {
    const a = oldWalker.segments[i], b = walker.segments[i];
    near((a.start.x + a.end.x) / 2, (b.start.x + b.end.x) / 2, 5e-5);
    near((a.start.y + a.end.y) / 2, (b.start.y + b.end.y) / 2, 5e-5);
  }
  assert.doesNotThrow(() => validateScene(editor.serialize())); editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('relative movement across keyframes matches identities, retains selection, and commits one undo command', () => {
  const editor = blank(), parent = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinTo(parent, 2); editor.duplicateFrame(); editor.duplicateFrame(); editor.selectMany([parent, child]);
  const before = editor.serialize(), current = editor.frameIndex, history = editor._undo.length;
  const childRoots = editor.report.keyframes.map(frame => ({...buildGeometry(editor.report, frame).objects.get(1).root}));
  assert.equal(editor.moveSelectionInFrames(15, -25, [0, 2]), 2);
  assert.equal(editor.frameIndex, current); assert.deepEqual([...editor.selectedUids], [parent, child]); assert.equal(editor._undo.length, history + 1);
  for (const index of [0, 2]) { const root = buildGeometry(editor.report, editor.report.keyframes[index]).objects.get(1).root;
    near(root.x, childRoots[index].x + 15); near(root.y, childRoots[index].y - 25); }
  assert.deepEqual(editor.serialize().keyframes[1], before.keyframes[1]); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.select(child); assert.equal(editor.moveSelectionInFrames(5, 0, [0, 2]), 2);
  for (const index of [0, 2]) near(buildGeometry(editor.report, editor.report.keyframes[index]).objects.get(1).root.x, childRoots[index].x + 5);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

function nestedJoinedScene() {
  const editor = blank(), root = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinTo(root, 4); const grandchild = editor.duplicateFigure().unique_id; editor.joinTo(child, 2);
  const sibling = editor.duplicateFigure().unique_id; editor.joinTo(root, 0);
  const separate = editor.duplicateFigure().unique_id, report = editor.serialize(), frame = report.keyframes[0];
  const remapHandle = id => id ? id * 13 + 5 : 0;
  for (const figure of report.figure_types) for (const segment of figure.segments) {
    segment.segment_id = remapHandle(segment.segment_id); segment.parent_id = remapHandle(segment.parent_id);
  }
  const objects = new Map(frame.objects.map(object => [object.unique_id, object]));
  frame.objects = [grandchild, separate, sibling, root, child].map(id => objects.get(id));
  const slots = new Map(frame.objects.map((object, slot) => [object.unique_id, slot]));
  frame.objects.forEach((object, slot) => { object.object_slot = slot; if (object.join) {
    object.join.target_object_slot = slots.get(object.join.target_unique_id);
    object.join.target_handle_id = remapHandle(object.join.target_handle_id);
  } });
  editor.load(report); editor.select(grandchild); return {editor, root, child, grandchild, sibling, separate};
}

test('translation resolves a nested child to the full connected component with arbitrary slots and sparse handles', () => {
  const {editor, root, child, grandchild, sibling, separate} = nestedJoinedScene();
  const resolved = editor.resolveTranslationSelection();
  assert.deepEqual(resolved.rootUids, [root]); assert.deepEqual(resolved.rootSlots, [3]);
  assert.deepEqual(resolved.affectedUids, [grandchild, sibling, root, child]);
  assert.deepEqual([...editor.selectedUids], [grandchild]);
  const before = editor.serialize(), baseline = editor.geometry, undoCount = editor._undo.length;
  editor.beginTranslationDrag(); editor.moveSelection(9, 12, {fromStart: true});
  editor.moveSelection(31, -18, {fromStart: true}); editor.commitDrag();
  for (const [slot, g] of baseline.objects) for (const [id, point] of g.joints) {
    const now = editor.geometry.objects.get(slot).joints.get(id), moved = g.obj.unique_id !== separate;
    near(now.x, point.x + (moved ? 31 : 0), 1e-4); near(now.y, point.y - (moved ? 18 : 0), 1e-4);
  }
  assert.equal(editor._undo.length, undoCount + 1); assert.equal(editor._undo.at(-1).before.length, 4);
  for (const object of editor.frame.objects) if (object.join) {
    const origin = editor.geometry.objects.get(object.object_slot).root;
    assert.equal(object.root_x, origin.x); assert.equal(object.root_y, origin.y);
  }
  assert.deepEqual([...editor.selectedUids], [grandchild]);
  assert.doesNotThrow(() => validateScene(editor.serialize())); editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.redo(); near(editor.frame.objects[3].root_x, before.keyframes[0].objects[3].root_x + 31);
});

test('overlapping nested selection translates each component once and legacy beginDrag expands safely', () => {
  const {editor, root, child, grandchild, separate} = nestedJoinedScene();
  editor.selectMany([grandchild, root, child, separate]);
  assert.deepEqual(editor.resolveTranslationSelection().rootUids, [separate, root]);
  const before = editor.serialize(), baseline = editor.geometry;
  editor.beginDrag(); editor.moveSelection(17, 23, {fromStart: true}); editor.moveSelection(20, 25, {fromStart: true}); editor.commitDrag();
  for (const [slot, g] of baseline.objects) { near(editor.geometry.objects.get(slot).root.x, g.root.x + 20, 1e-4); near(editor.geometry.objects.get(slot).root.y, g.root.y + 25, 1e-4); }
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  const history = editor._undo.length; editor.beginTranslationDrag(); editor.commitDrag(); assert.equal(editor._undo.length, history);
  editor.beginTranslationDrag(); editor.moveSelection(99, 87); editor.cancelDrag(); assert.deepEqual(editor.serialize(), before);
  editor.beginTranslationDrag(); editor.moveSelection(30, 40); editor.object.scale = -1;
  assert.throws(() => editor.commitDrag(), /negative/); assert.deepEqual(editor.serialize(), before);
});

test('posing a nested joined child still rotates its descendants without rotating parent or siblings', () => {
  const {editor, root, child, grandchild, sibling} = nestedJoinedScene(); editor.select(child);
  const before = editor.serialize(), original = new Map(editor.frame.objects.map(o => [o.unique_id, o.angles[0]]));
  editor.rotateSelection(0.3);
  for (const object of editor.frame.objects) near(object.angles[0], original.get(object.unique_id) + ([child, grandchild].includes(object.unique_id) ? 0.3 : 0));
  assert.equal(editor.frame.objects.find(o => o.unique_id === child).join.target_unique_id, root);
  assert.equal(editor.frame.objects.find(o => o.unique_id === sibling).join.target_unique_id, root);
  editor.undo(); assert.deepEqual(editor.serialize(), before);
});

test('connected selection resolution handles a deep reverse chain with linear join reads', () => {
  const editor = new Editor({demo: false}), count = 12000; let reads = 0;
  const objects = Array.from({length: count}, (_, slot) => ({unique_id: slot + 1,
    get join() { reads++; return slot + 1 < count ? {target_object_slot: slot + 1, target_handle_id: 0} : null; }}));
  const result = editor.resolveTranslationSelection(objects.map(o => o.unique_id), {frame: {objects}});
  assert.deepEqual(result.rootUids, [count]); assert.equal(result.affectedUids.length, count);
  assert.ok(reads < count * 8, `Expected linear traversal, observed ${reads} join reads`);
});

test('numeric scale changes explicitly selected figures while attached artwork retains its own scale', () => {
  const {editor, root, child, grandchild, sibling} = nestedJoinedScene(); editor.select(root);
  const before = editor.serialize(), childScale = editor.frame.objects.find(o => o.unique_id === child).scale;
  editor.scaleSelected(2); assert.equal(editor.object.scale, 2);
  for (const uid of [child, grandchild, sibling]) assert.equal(editor.frame.objects.find(o => o.unique_id === uid).scale, childScale);
  for (const object of editor.frame.objects) if (object.join) {
    const origin = editor.geometry.objects.get(object.object_slot).root;
    assert.equal(object.root_x, origin.x); assert.equal(object.root_y, origin.y);
  }
  editor.undo(); assert.deepEqual(editor.serialize(), before);
  editor.selectMany([root, child]); editor.scaleSelected(1.5);
  for (const object of editor.frame.objects) assert.equal(object.scale, [root, child].includes(object.unique_id) ? 1.5 : 1);
});

test('repeated pointer posing reuses branch targets while each angular delta applies once', () => {
  const editor = blank(), parent = editor.selectedUid, child = editor.duplicateFigure().unique_id;
  editor.joinTo(parent, 4); editor.select(parent, 2); const before = editor.frame.objects[1].angles.slice();
  editor.beginDrag(); editor.rotateJoint(0.01); const targets = editor._drag.rotationTargets.get('0:2');
  for (let i = 0; i < 29; i++) editor.rotateJoint(0.01);
  assert.equal(editor._drag.rotationTargets.get('0:2'), targets); editor.commitDrag();
  editor.frame.objects[1].angles.forEach((angle, i) => near(angle, before[i] + 0.3));
  assert.equal(editor._undo.at(-1).kind, 'objects'); assert.ok(child);
});
