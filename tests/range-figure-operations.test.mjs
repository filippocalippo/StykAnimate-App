import test from 'node:test';
import assert from 'node:assert/strict';
import {planFigureFrameOperation as plan} from '../src/range-figure-operations.mjs';
import {buildGeometry} from '../src/pivot/geometry.mjs';
import {createFrame, createObject, defaultFigure, emptyDocument} from '../src/demo.mjs';
import {createLayerState} from '../src/layers.mjs';
import {validateScene} from '../src/pivot/model.mjs';
import {frameOrder, setOrder} from '../src/pivot/structure.mjs';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value); for (const child of Object.values(value)) freeze(child); return value;
}

test('duplicate planner preserves reversed sparse joins, detached roots, styles and unknown fields without touching frozen sources', () => {
  const {report, frame} = fixture(), selected = [6, 17], uidMap = new Map([[6, 500], [17, 501]]);
  const result = plan(report, frame, selected, {kind: 'duplicate', uidMap, offset: 0}), byUid = geometryByUid(report, result.frame), originals = geometryByUid(report, frame);
  assert.equal(result.frame.objects.length, frame.objects.length + 2); assert.equal(result.structural, true);
  const grand = object(result.frame, 500), parent = object(result.frame, 501);
  assert.equal(grand.join.target_handle_id, 33); assert.equal(grand.join.unknown_native_join, 19);
  assert.equal(result.frame.objects[grand.join.target_object_slot], parent); assert.equal(parent.join, null);
  assert.deepEqual(parent.extra_native_fields, [1, 2, 3]); assert.equal(frame.objects[0], result.frame.objects[0]);
  for (const [original, uid] of uidMap) {
    const before = originals.get(original), after = byUid.get(uid); near(after.root.x, before.root.x); near(after.root.y, before.root.y);
    before.segments.forEach((segment, i) => { near(after.segments[i].end.x, segment.end.x); near(after.segments[i].end.y, segment.end.y); });
  }
  assert.doesNotThrow(() => validateScene({...report, keyframes: [result.frame]}));
  assert.throws(() => plan(report, frame, selected, {kind: 'duplicate', uidMap: new Map([[6, 500], [17, 500]])}), /fresh/);
});
function fixture({frozen = true} = {}) {
  const report = emptyDocument(), figure = defaultFigure(91);
  figure.segments = [figure.segments[0], figure.segments[2], figure.segments[3]].map((segment, index) => ({...segment,
    segment_id: [11, 33, 44][index], parent_id: [0, 11, 33][index], length: [31, 26, 19][index],
    angle_rad: [0.18, 0.69, -0.57][index], bend_rad: [0, 0.3, -0.8][index]}));
  figure.segment_count = figure.segments.length;
  figure.unknown_style = {untouched: [3, 5, 7]}; report.figure_types = [figure];
  const make = (uid, x, y) => createObject(figure, uid, x, y, {_styk: {name: `Figure ${uid}`}, extra_native_fields: [1, 2, 3]});
  const [grand, external, child, root, sibling] = [make(6, -900, -900), make(44, 610, 440), make(17, -999, -999), make(900, 203, 197), make(901, -880, -880)];
  grand.join = {target_object_slot: 2, target_unique_id: 17, target_handle_id: 33, unknown_native_join: 19};
  child.join = {target_object_slot: 3, target_unique_id: 900, target_handle_id: 44, unknown_native_join: 27};
  sibling.join = {target_object_slot: 3, target_unique_id: 900, target_handle_id: 11};
  const frame = createFrame([grand, external, child, root, sibling], 7);
  frame.unknown_native_frame = {data: [42]}; setOrder(frame, [900, 6, 44, 17, 901]);
  report.keyframes = [frame]; report._styk.layers = createLayerState(); validateScene(report);
  if (frozen) freeze(report);
  return {report, frame, figure};
}
const object = (frame, uid) => frame.objects.find(value => value.unique_id === uid);
const geometryByUid = (report, frame) => new Map([...buildGeometry(report, frame).objects.values()].map(value => [value.obj.unique_id, value]));
const near = (a, b, tolerance = 0.0001) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
function sameGeometry(a, b) {
  near(a.root.x, b.root.x); near(a.root.y, b.root.y);
  for (const [handle, point] of a.joints) { near(point.x, b.joints.get(handle).x); near(point.y, b.joints.get(handle).y); }
}
function canonical(report, frame) {
  for (const g of geometryByUid(report, frame).values()) if (g.obj.join) {
    assert.equal(g.obj.root_x, g.root.x); assert.equal(g.obj.root_y, g.root.y);
  }
}

test('appearance clones only changed objects and preserves nested media/style/metadata references', () => {
  const {report, frame} = fixture();
  const result = plan(report, frame, [17, 17, 77777], {kind: 'appearance', patch: {color_override_raw: 0xff113355}});
  assert.deepEqual(result.changedUids, [17]); assert.equal(result.structural, false);
  assert.notEqual(result.frame, frame); assert.notEqual(result.frame.objects, frame.objects);
  for (const source of frame.objects) {
    const next = object(result.frame, source.unique_id);
    assert.equal(next._styk, source._styk); assert.equal(next.extra_native_fields, source.extra_native_fields);
    assert.equal(next.angles, source.angles); assert.equal(next.join, source.join);
    if (source.unique_id !== 17) assert.equal(next, source);
  }
  assert.equal(result.frame.camera, frame.camera); assert.equal(result.frame.unknown_native_frame, frame.unknown_native_frame);
  assert.equal(result.frame.object_draw_order, frame.object_draw_order);
  assert.equal(object(frame, 17).color_override_raw, 0); assert.equal(object(result.frame, 17).color_override_raw, 0xff113355);
});

test('absolute opacity follows native transparency bytes, and repeated values are no-ops', () => {
  const {report, frame} = fixture();
  for (const [opacity, expected] of [[0, 255], [0.5, 128], [1, 0]]) {
    const result = plan(report, frame, [17], {kind: 'appearance', opacity});
    if (expected === 0) assert.equal(result, null);
    else {
      assert.equal(object(result.frame, 17).field28, expected);
      assert.equal(plan(report, result.frame, [17], {kind: 'appearance', patch: {field28: expected}}), null);
    }
  }
  assert.equal(plan(report, frame, [17], {kind: 'appearance', patch: {}}), null);
});

test('replacing figure color retires its interpolated color cache without dropping other fields', () => {
  const {report, frame} = fixture({frozen: false});
  object(frame, 17).color_transition = {from: 0xff112233, to: 0xff223344, t: 0.5}; freeze(report);
  const result = plan(report, frame, [17], {kind: 'appearance', patch: {color_override_raw: 0}});
  assert.equal('color_transition' in object(result.frame, 17), false);
  assert.ok(object(frame, 17).color_transition);
});

test('appearance and order do not evaluate geometry or read the figure library', () => {
  const {report: original, frame} = fixture();
  const report = {...original}; Object.defineProperty(report, 'figure_types', {get() { throw new Error('Unexpected geometry evaluation.'); }});
  assert.ok(plan(report, frame, [17], {kind: 'appearance', patch: {field28: 100}}));
  assert.ok(plan(report, frame, [900], {kind: 'order', direction: 'front'}));
  assert.ok(plan(report, frame, [44], {kind: 'delete'}));
});

test('order operations stay within assigned user layers and never renumber join slots', () => {
  const {report, frame} = fixture({frozen: false});
  const state = report._styk.layers;
  state.nextId = 3; state.order.push('layer-2'); state.byId['layer-2'] = {name: 'Foreground', visible: true, locked: false};
  state.assignments = {44: 'layer-2', 901: 'layer-2'}; freeze(report);
  const result = plan(report, frame, [900, 44], {kind: 'order', direction: 'front'});
  assert.deepEqual(frameOrder(result.frame), [6, 17, 901, 900, 44]);
  assert.equal(result.frame.objects, frame.objects); assert.equal(result.structural, true);
  const back = plan(report, result.frame, [900, 44], {kind: 'order', direction: 'back'});
  assert.deepEqual(frameOrder(back.frame), [900, 6, 44, 17, 901]);
  assert.equal(plan(report, frame, [900, 44], {kind: 'order', direction: 'back'}), null);
});

test('linear integer ordering matches native stable step movement for every selection mask', () => {
  const report = emptyDocument(), figure = report.figure_types[0];
  const frame = createFrame(Array.from({length: 7}, (_, index) => createObject(figure, 10 + index * 17, 0, 0)));
  for (let mask = 1; mask < 128; mask++) for (const direction of [-100000, -3, -1, 0, 1, 3, 100000]) {
    const selected = new Set(frame.objects.filter((_, index) => mask & (1 << index)).map(value => value.unique_id));
    const expected = frameOrder(frame);
    for (let step = 0; step < Math.min(Math.abs(direction), expected.length); step++) {
      if (direction > 0) for (let i = expected.length - 2; i >= 0; i--) {
        if (selected.has(expected[i]) && !selected.has(expected[i + 1])) [expected[i], expected[i + 1]] = [expected[i + 1], expected[i]];
      } else for (let i = 1; i < expected.length; i++) {
        if (selected.has(expected[i]) && !selected.has(expected[i - 1])) [expected[i], expected[i - 1]] = [expected[i - 1], expected[i]];
      }
    }
    const result = plan(report, frame, selected, {kind: 'order', direction});
    assert.deepEqual(frameOrder(result?.frame ?? frame), expected, `selection ${mask}, movement ${direction}`);
  }
});

test('deletion reindexes slots and surviving join references while preserving visible detached origins', () => {
  const {report, frame} = fixture(), before = geometryByUid(report, frame);
  const result = plan(report, frame, [900], {kind: 'delete'}), next = result.frame;
  assert.equal(next.objects.length, 4); assert.deepEqual(frameOrder(next), [6, 44, 17, 901]);
  assert.equal(object(next, 6), object(frame, 6)); assert.equal(object(next, 44), object(frame, 44));
  assert.equal(object(next, 17).join, null); assert.equal(object(next, 901).join, null);
  assert.equal(object(next, 901).object_slot, 3); assert.equal(object(next, 6).join.target_object_slot, 2);
  const after = geometryByUid(report, next);
  for (const [uid, g] of after) sameGeometry(before.get(uid), g);
  validateScene({...report, keyframes: [next]});
  assert.deepEqual(new Set(result.changedUids), new Set([900, 17, 901]));
});

test('deleting an earlier slot clones only objects whose slots or join references actually change', () => {
  const {report, frame} = fixture();
  const result = plan(report, frame, [44], {kind: 'delete'}), next = result.frame;
  assert.equal(object(next, 6).object_slot, 0); assert.equal(object(next, 6).join.target_object_slot, 1);
  assert.equal(object(next, 6).join.unknown_native_join, 19);
  assert.equal(object(next, 17).join.target_object_slot, 2);
  assert.deepEqual(next.object_draw_order, [2, 0, 1, 3]);
  for (const value of next.objects) assert.equal(value.angles, object(frame, value.unique_id).angles);
  validateScene({...report, keyframes: [next]});
});

test('deleting selected parent and child detaches a surviving grandchild once', () => {
  const {report, frame} = fixture(), original = geometryByUid(report, frame);
  const result = plan(report, frame, [900, 17], {kind: 'delete'});
  assert.equal(object(result.frame, 6).join, null); assert.equal(object(result.frame, 901).join, null);
  for (const [uid, g] of geometryByUid(report, result.frame)) sameGeometry(original.get(uid), g);
  validateScene({...report, keyframes: [result.frame]});
});

test('deleting all selected figures leaves a valid empty frame and preserves camera/background metadata', () => {
  const {report, frame} = fixture();
  const result = plan(report, frame, frame.objects.map(value => value.unique_id), {kind: 'delete'});
  assert.deepEqual(result.frame.objects, []); assert.deepEqual(result.frame.object_draw_order, []);
  assert.equal(result.frame.camera, frame.camera); assert.equal(result.frame.duration_raw, 7);
  validateScene({...report, keyframes: [result.frame]});
});

test('detach preserves all world geometry and clones selected joined figures only', () => {
  const {report, frame} = fixture(), before = geometryByUid(report, frame);
  const result = plan(report, frame, [17, 900], {kind: 'detach'});
  assert.deepEqual(result.changedUids, [17]); assert.equal(result.structural, true);
  assert.equal(object(result.frame, 17).join, null); assert.equal(object(result.frame, 6), object(frame, 6));
  for (const [uid, g] of geometryByUid(report, result.frame)) sameGeometry(before.get(uid), g);
  assert.equal(plan(report, result.frame, [17, 900], {kind: 'detach'}), null);
});

test('joining a subtree targets sparse native handle IDs and recanonicalizes every moved descendant', () => {
  const {report, frame} = fixture();
  const result = plan(report, frame, [17], {kind: 'join', targetUid: 44, handleId: 33});
  const next = result.frame, g = geometryByUid(report, next);
  assert.equal(object(next, 17).join.target_object_slot, 1); assert.equal(object(next, 17).join.target_handle_id, 33);
  assert.equal(object(next, 17).join.unknown_native_join, 27);
  assert.equal(object(next, 900), object(frame, 900)); assert.equal(object(next, 901), object(frame, 901));
  assert.deepEqual(result.changedUids, [6, 17]);
  for (const uid of [6, 17]) { assert.equal(object(next, uid).root_x, g.get(uid).root.x); assert.equal(object(next, uid).root_y, g.get(uid).root.y); }
  assert.equal(plan(report, next, [17], {kind: 'join', targetUid: 44, handleId: 33}), null);
  validateScene({...report, keyframes: [next]});
});

test('join skips absent target UIDs and rejects self joins, cycles and invalid handles atomically', () => {
  const {report, frame} = fixture(), snapshot = structuredClone(report);
  assert.equal(plan(report, frame, [17], {kind: 'join', targetUid: 123456, handleId: 33}), null);
  for (const [uids, targetUid, handleId] of [[[17], 17, 0], [[900], 6, 0], [[44, 17], 44, 0], [[17], 44, 1]])
    assert.throws(() => plan(report, frame, uids, {kind: 'join', targetUid, handleId}), /cycle|joint/);
  assert.deepEqual(report, snapshot);
});

test('numeric scale resizes only selected instances and canonicalizes moving attachment origins', () => {
  const {report, frame} = fixture();
  const result = plan(report, frame, [900], {kind: 'scale', factor: 2});
  for (const value of result.frame.objects) assert.equal(value.scale, value.unique_id === 900 ? 2 : 1);
  assert.equal(object(result.frame, 44), object(frame, 44));
  assert.equal(object(result.frame, 900).angles, object(frame, 900).angles);
  assert.equal(object(result.frame, 900).root_x, 203); assert.equal(object(result.frame, 900).root_y, 197);
  canonical(report, result.frame); validateScene({...report, keyframes: [result.frame]});
  assert.equal(result.structural, false);
});

test('scaling a joined child never scales or moves its external parent or siblings', () => {
  const {report, frame} = fixture(), before = geometryByUid(report, frame);
  const result = plan(report, frame, [17], {kind: 'scale', factor: 1.8}), after = geometryByUid(report, result.frame);
  for (const uid of [900, 901, 44]) assert.equal(object(result.frame, uid), object(frame, uid));
  assert.equal(object(result.frame, 17).scale, 1.8); assert.equal(object(result.frame, 6).scale, 1);
  assert.equal(after.get(17).root.x, before.get(17).root.x); assert.equal(after.get(17).root.y, before.get(17).root.y);
  for (const uid of [17, 6]) { assert.equal(object(result.frame, uid).root_x, after.get(uid).root.x); assert.equal(object(result.frame, uid).root_y, after.get(uid).root.y); }
});

test('absolute multi-selection scale preserves proportions using the requested reference UID', () => {
  const {report, frame} = fixture({frozen: false}); object(frame, 44).scale = 2; freeze(report);
  const center = {x: 50, y: 75};
  const result = plan(report, frame, [900, 44], {kind: 'scale', value: 6, referenceUid: 44, center});
  assert.equal(object(result.frame, 44).scale, 6); assert.equal(object(result.frame, 900).scale, 3);
  assert.equal(object(result.frame, 900).root_x, 50 + (203 - 50) * 3);
  assert.equal(object(result.frame, 44).root_y, 75 + (440 - 75) * 3);
  canonical(report, result.frame);
  const fallback = plan(report, frame, [7777, 44, 900], {kind: 'scale', value: 6, referenceUid: 7777, center});
  assert.deepEqual(fallback.frame, result.frame);
});

test('zero-scale reference is explicit: mixed proportions reject and uniformly collapsed figures can recover', () => {
  const {report, frame} = fixture({frozen: false}); object(frame, 44).scale = 0; freeze(report);
  assert.throws(() => plan(report, frame, [44, 900], {kind: 'scale', value: 2, referenceUid: 44}), /zero-scale reference/);
  assert.equal(plan(report, frame, [44], {kind: 'scale', value: 0}), null);
  const result = plan(report, frame, [44], {kind: 'scale', value: 2});
  assert.equal(object(result.frame, 44).scale, 2); assert.equal(object(result.frame, 44).root_x, 610);
});

test('overlapping parent and child selection scales and mirrors each affected figure once', () => {
  const {report, frame} = fixture();
  const scaled = plan(report, frame, [900, 17], {kind: 'scale', factor: 2});
  for (const uid of [900, 17]) assert.equal(object(scaled.frame, uid).scale, 2);
  for (const uid of [6, 901, 44]) assert.equal(object(scaled.frame, uid).scale, 1);
  const reflected = plan(report, frame, [900, 17], {kind: 'mirror', axis: 'horizontal', center: {x: 300, y: 200}});
  for (const uid of [900, 17, 6, 901])
    assert.deepEqual(object(reflected.frame, uid).angles, object(frame, uid).angles.map(angle => Math.PI - angle));
  assert.equal(object(reflected.frame, 44), object(frame, 44)); canonical(report, reflected.frame);
});

test('mirroring a joined subtree reflects visible geometry around its own root and preserves external ancestry', () => {
  const {report, frame} = fixture(), before = geometryByUid(report, frame), pivot = before.get(17).root;
  for (const axis of ['horizontal', 'vertical']) {
    const result = plan(report, frame, [17], {kind: 'mirror', axis}), after = geometryByUid(report, result.frame);
    for (const uid of [900, 901, 44]) assert.equal(object(result.frame, uid), object(frame, uid));
    for (const uid of [17, 6]) for (const [handle, point] of before.get(uid).joints) {
      const next = after.get(uid).joints.get(handle);
      near(next.x, axis === 'horizontal' ? 2 * pivot.x - point.x : point.x);
      near(next.y, axis === 'vertical' ? 2 * pivot.y - point.y : point.y);
    }
    assert.equal(object(result.frame, 17).bend_flag, 1);
    assert.deepEqual(object(result.frame, 17).bends, report.figure_types[0].segments.map(segment => -segment.bend_rad));
    assert.equal(object(result.frame, 17).image_text_flags, 1);
    validateScene({...report, keyframes: [result.frame]});
  }
});

test('runtime lengths and bends are materialized before geometry transforms discard the tween cache', () => {
  const {report, frame, figure} = fixture({frozen: false});
  object(frame, 44).runtime_segments = figure.segments.map((segment, index) => ({length: segment.length + 10 + index, bend_rad: 0.4 + index / 10}));
  freeze(report);
  const scaled = plan(report, frame, [44], {kind: 'scale', factor: 2});
  const next = object(scaled.frame, 44);
  assert.equal('runtime_segments' in next, false); assert.equal(next.len_flag, 1); assert.equal(next.bend_flag, 1);
  assert.deepEqual(next.lengths, [41, 37, 31]); assert.deepEqual(next.bends, [0.4, 0.5, 0.6000000000000001]);
  const mirrored = plan(report, frame, [44], {kind: 'mirror', axis: 'vertical'});
  assert.deepEqual(object(mirrored.frame, 44).bends, next.bends.map(value => -value));
  assert.ok(object(frame, 44).runtime_segments);
});

test('missing figure UIDs and geometrically motionless scale/order controls create no plan', () => {
  const {report, frame} = fixture();
  for (const operation of [{kind: 'delete'}, {kind: 'detach'}, {kind: 'appearance', opacity: 0.3},
    {kind: 'mirror', axis: 'horizontal'}, {kind: 'scale', factor: 2}, {kind: 'join', targetUid: 44}, {kind: 'order', direction: 'front'}])
    assert.equal(plan(report, frame, [777777], operation), null);
  assert.equal(plan(report, frame, [900], {kind: 'scale', factor: 1}), null);
  assert.equal(plan(report, frame, [900], {kind: 'scale', value: 1}), null);
  assert.equal(plan(report, frame, [900], {kind: 'order', direction: 0}), null);
});

test('invalid scalar options and overflow reject without mutating frozen source frames', () => {
  const {report, frame} = fixture(), before = structuredClone(report);
  for (const operation of [{kind: 'scale', factor: NaN}, {kind: 'scale', factor: -1}, {kind: 'scale', value: 2, factor: 2},
    {kind: 'scale'}, {kind: 'scale', factor: 1e40}, {kind: 'mirror', axis: 'diagonal'}, {kind: 'mirror', center: {x: Infinity, y: 0}},
    {kind: 'appearance', opacity: 1.1}, {kind: 'appearance', patch: {opacity: 0.5, field28: 0}},
    {kind: 'appearance', patch: {field28: 256}}, {kind: 'appearance', patch: {root_x: 23}},
    {kind: 'appearance', patch: {color_override_raw: -1}}, {kind: 'order', direction: 0.5}, {kind: 'join', targetUid: 44, handleId: -1}])
    assert.throws(() => plan(report, frame, [900], operation));
  assert.deepEqual(report, before);
});

test('geometric operations compile only selected subtrees and necessary ancestry', () => {
  const {report, frame} = fixture({frozen: false});
  const unneeded = {figure_type_id: 999};
  Object.defineProperty(unneeded, 'segments', {get() { throw new Error('Unrelated figure geometry must remain untouched.'); }});
  report.figure_types.push(unneeded); object(frame, 44).figure_type_id = 999;
  for (const operation of [{kind: 'scale', factor: 1.4}, {kind: 'mirror', axis: 'vertical'},
    {kind: 'detach'}, {kind: 'join', targetUid: 900, handleId: 11}, {kind: 'delete'}]) {
    const result = plan(report, frame, [17], operation);
    assert.ok(result); assert.equal(object(result.frame, 44), object(frame, 44));
  }
});

test('endpoint-only canonicalization exactly follows the renderer for long curved segment chains', () => {
  const report = emptyDocument(), figure = defaultFigure(77), base = figure.segments[0];
  figure.segments = Array.from({length: 50}, (_, index) => ({...base, segment_id: index * 13 + 1,
    parent_id: index ? (index - 1) * 13 + 1 : 0, length: 3.771 + index / 7,
    angle_rad: 0.317 + index / 13, bend_rad: ((index * 91) % 17 - 8) * 0.19137}));
  figure.segment_count = 50; report.figure_types = [figure];
  const root = createObject(figure, 123, 12537.73, -42089.127), child = createObject(figure, 46, -1, -1), leaf = createObject(figure, 9001, -2, -2);
  child.join = {target_object_slot: 2, target_unique_id: 123, target_handle_id: 49 * 13 + 1};
  leaf.join = {target_object_slot: 1, target_unique_id: 46, target_handle_id: 43 * 13 + 1};
  report.keyframes = [createFrame([leaf, child, root])]; freeze(report);
  for (const operation of [{kind: 'scale', factor: 2.735}, {kind: 'mirror', axis: 'horizontal'}, {kind: 'mirror', axis: 'vertical'}]) {
    const result = plan(report, report.keyframes[0], [123], operation);
    canonical(report, result.frame); validateScene({...report, keyframes: [result.frame]});
  }
});
