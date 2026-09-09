import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDocument, createFrame, createObject} from '../src/demo.mjs';
import {createLayerState} from '../src/layers.mjs';
import {animationChannelId} from '../src/animation-channels.mjs';
import {evaluatedFrame, evaluatedNativeFrame, buildGeometry, timeline} from '../src/pivot/geometry.mjs';
import {buildVirtualPoseTrack, composePoseChannels} from '../src/animation-pose.mjs';
import {materializePivotDocument} from '../src/pivot-export-materialize.mjs';

const near = (a, b) => assert.ok(Math.abs(a - b) < .0001, `${a} != ${b}`);
const channel = (target, property, keys) => ({id: animationChannelId(target, property), target, property,
  keys: keys.map(([tick, value, interpolation = 'linear'], index) => ({id: `key-${index}`, tick, value: property === 'pose' ? {frameId: value} : value, interpolation}))});
function sample(report, tick) {
  const rows = timeline(report); let index = 0;
  while (index + 1 < rows.length && rows[index + 1].start <= tick) index++;
  return evaluatedFrame(report, index, rows[index].count ? (tick - rows[index].start) / rows[index].count : 0, tick);
}
function fixture() {
  const report = emptyDocument(), figure = report.figure_types[0]; report._styk.layers = createLayerState();
  report.backgrounds = [{background_id: 1, kind: 2, color: 0xff123456, name: 'First'}];
  report.keyframes = [0, 1].map(index => ({...createFrame([createObject(figure, 1, 100, 100), createObject(figure, 2, 200, 100)], 10),
    _styk: {frameId: `frame-${index + 1}`}, background_id: 1,
    camera: {is_default: false, x: 70 + index * 10, y: 25, scale: 2, angle_rad: .5}}));
  report._styk.animation = {version: 1, nextKeyId: 10, channels: []}; return report;
}

test('explicit blank Camera and Scene pose keys use the same defaults as an empty track', () => {
  const report = fixture(); report._styk.animation.channels = [channel({kind: 'camera'}, 'pose', [[0, null]]), channel({kind: 'scene'}, 'pose', [[0, null]])];
  const frame = sample(report, 0);
  assert.deepEqual(frame.camera, {is_default: true, x: 0, y: 0, scale: 1, angle_rad: 0});
  assert.equal(frame.background_id, 0); assert.equal(frame.background_mix, 0); assert.equal(frame._stykBackgroundColor, undefined);
});

test('a retimed layer pose retains its source paint order within the layer', () => {
  const report = fixture(); report.keyframes[1].object_draw_order = [1, 0]; report.keyframes[1].object_draw_order_unique_ids = [2, 1];
  report._styk.animation.channels = [channel({kind: 'layer', id: 'layer-1'}, 'pose', [[0, 'frame-2', 'hold']])];
  assert.deepEqual(sample(report, 0).object_draw_order_unique_ids, [2, 1]);
});

test('fixed-track pose sampling excludes unrelated figure arrays while preserving source assets', () => {
  const report = fixture(), camera = channel({kind: 'camera'}, 'pose', [[0, 'frame-1'], [10, 'frame-2']]);
  const track = buildVirtualPoseTrack(report, camera);
  assert.equal(track.frames[0].objects.length, 0); assert.equal(track.frames[1].objects.length, 0);
  near(evaluatedNativeFrame(track.report, 0, .5).camera.x, 75);
  assert.equal(report.keyframes[0].objects.length, 2);
});

test('independent joined layers remain correctly oriented for 101 sampled ticks and composed export', () => {
  const report = emptyDocument(), definition = report.figure_types[0];
  definition.segments = [{...definition.segments[0], length: 10, angle_rad: 0}]; definition.segment_count = 1;
  const parentAngles = [.1, .5, .9], childAngles = [-.2, .2, -.4], grandAngles = [.3, -.3, .6];
  report._styk.layers = {...createLayerState(), nextId: 4, order: ['layer-1', 'layer-2', 'layer-3'],
    byId: Object.fromEntries([1, 2, 3].map(i => [`layer-${i}`, {name: `Layer ${i}`, visible: true, locked: false}])), assignments: {2: 'layer-2', 3: 'layer-3'}};
  report.keyframes = [0, 1, 2].map(index => {
    const parent = createObject(definition, 1, 100 + index * 20, 100 + index * 3, {angles: [parentAngles[index]], scale: 1 + index * .1});
    const child = createObject(definition, 2, 0, 0, {angles: [parentAngles[index] + childAngles[index]], scale: .8 + index * .05});
    const grand = createObject(definition, 3, 0, 0, {angles: [parentAngles[index] + childAngles[index] + grandAngles[index]]});
    const objects = index % 2 ? [grand, parent, child] : [parent, child, grand], slots = new Map(objects.map((object, slot) => [object.unique_id, slot]));
    child.join = {target_object_slot: slots.get(1), target_unique_id: 1, target_handle_id: 1};
    grand.join = {target_object_slot: slots.get(2), target_unique_id: 2, target_handle_id: 1};
    return {...createFrame(objects, 50), _styk: {frameId: `frame-${index + 1}`}, camera: {is_default: false, x: index * 40, y: 0, scale: 1 + index * .2, angle_rad: 0}};
  });
  const curveA = [[0, 0], [100, 2]], curveB = [[0, 2], [40, 1], [100, 0]], curveC = [[0, 0], [70, 2], [100, 1]];
  report._styk.animation = {version: 1, nextKeyId: 50, channels: [
    ...[curveA, curveB, curveC].map((curve, index) => channel({kind: 'layer', id: `layer-${index + 1}`}, 'pose', curve.map(([tick, source]) => [tick, `frame-${source + 1}`]))),
    channel({kind: 'camera'}, 'pose', [[0, 'frame-3'], [100, 'frame-1']]), channel({kind: 'camera'}, 'x', [[0, 7], [100, 17]]),
    channel({kind: 'scene'}, 'pose', [[0, 'frame-1']]), channel({kind: 'scene'}, 'color', [[0, 0xff112233], [100, 0xffddeeff]]),
  ]};
  const scalar = (curve, values, tick) => {
    let i = 0; while (i + 1 < curve.length && curve[i + 1][0] <= tick) i++;
    const [start, source] = curve[i], next = curve[i + 1]; return !next ? values[source] : values[source] + (values[next[1]] - values[source]) * (tick - start) / (next[0] - start);
  };
  const output = materializePivotDocument(report);
  for (let tick = 0; tick <= 100; tick++) {
    const frame = sample(report, tick), geometry = buildGeometry(report, frame), byUid = new Map([...geometry.objects.values()].map(g => [g.obj.unique_id, g]));
    const parent = byUid.get(1), child = byUid.get(2), grand = byUid.get(3), a = scalar(curveA, parentAngles, tick), b = a + scalar(curveB, childAngles, tick), c = b + scalar(curveC, grandAngles, tick);
    near(parent.obj.angles[0], a); near(child.obj.angles[0], b); near(grand.obj.angles[0], c);
    near(parent.root.x, scalar(curveA, [100, 120, 140], tick)); near(parent.root.y, scalar(curveA, [100, 103, 106], tick));
    near(child.root.x, parent.root.x + 10 * parent.obj.scale * Math.cos(a)); near(child.root.y, parent.root.y + 10 * parent.obj.scale * Math.sin(a));
    near(grand.root.x, child.root.x + 10 * child.obj.scale * Math.cos(b)); near(grand.root.y, child.root.y + 10 * child.obj.scale * Math.sin(b));
    near(frame.camera.x, 7 + tick / 10); near(frame.camera.scale, 1.4 - tick * .004);
    const compiled = buildGeometry(output, sample(output, tick)), compiledUid = new Map([...compiled.objects.values()].map(g => [g.obj.unique_id, g]));
    for (const [uid, g] of byUid) { near(compiledUid.get(uid).root.x, g.root.x); near(compiledUid.get(uid).root.y, g.root.y); }
  }
});

test('blanking one parent layer resolves many detached children with linear source lookups', () => {
  const report = emptyDocument(), definition = report.figure_types[0], count = 1200;
  definition.segments = [{...definition.segments[0], length: 10, angle_rad: 0}]; definition.segment_count = 1;
  const objects = Array.from({length: count}, (_, index) => createObject(definition, index + 1, 100, 100,
    index ? {join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: 1}} : {}));
  const frame = createFrame(objects, 1); frame._styk = {frameId: 'frame-1'}; report.keyframes = [frame];
  report._styk.layers = {...createLayerState(), nextId: 3, order: ['layer-1', 'layer-2'],
    byId: {'layer-1': {name: 'Parent', visible: true, locked: false}, 'layer-2': {name: 'Children', visible: true, locked: false}},
    assignments: Object.fromEntries(objects.slice(1).map(object => [object.unique_id, 'layer-2']))};
  report._styk.animation = {version: 1, nextKeyId: 2, channels: [channel({kind: 'layer', id: 'layer-1'}, 'pose', [[0, null]])]};
  const roots = new Map(objects.map((object, slot) => [slot, {root: {x: slot ? 110 : 100, y: 100}}]));
  let reads = 0, geometryCalls = 0;
  frame.objects = new Proxy(objects, {get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  }});
  const output = composePoseChannels(report, frame, 0, {
    sampleNative: (virtual, index) => virtual.keyframes[index],
    resolveGeometry: () => { geometryCalls++; return {objects: roots}; },
  });
  assert.equal(geometryCalls, 1); assert.equal(output.objects.length, count - 1);
  assert.ok(output.objects.every(object => object.join === null && object.root_x === 110 && object.root_y === 100));
  assert.ok(reads < count * 20, `${reads} source-object reads for ${count} figures`);
});

test('many joined figures share indexed handle lookups on a large reusable definition', () => {
  const report = emptyDocument(), childDefinition = report.figure_types[0], segmentCount = 800, childCount = 1200;
  childDefinition.segments = [{...childDefinition.segments[0], length: 10, angle_rad: 0}]; childDefinition.segment_count = 1;
  const parentDefinition = {...childDefinition, figure_type_id: 2,
    segments: Array.from({length: segmentCount}, (_, index) => ({...childDefinition.segments[0], segment_id: index + 1, parent_id: 0}))};
  parentDefinition.segment_count = segmentCount; report.figure_types.push(parentDefinition);
  const objects = [createObject(parentDefinition, 1, 100, 100), ...Array.from({length: childCount}, (_, index) => createObject(childDefinition, index + 2, 0, 0,
    {join: {target_object_slot: 0, target_unique_id: 1, target_handle_id: segmentCount}}))];
  const frame = createFrame(objects, 1); frame._styk = {frameId: 'frame-1'}; report.keyframes = [frame];
  report._styk.layers = {...createLayerState(), nextId: 3, order: ['layer-1', 'layer-2'],
    byId: {'layer-1': {name: 'Parent', visible: true, locked: false}, 'layer-2': {name: 'Children', visible: true, locked: false}},
    assignments: Object.fromEntries(objects.slice(1).map(object => [object.unique_id, 'layer-2']))};
  report._styk.animation = {version: 1, nextKeyId: 2, channels: [channel({kind: 'layer', id: 'layer-1'}, 'pose', [[0, 'frame-1']])]};
  let reads = 0;
  parentDefinition.segments = new Proxy(parentDefinition.segments, {get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  }});
  const output = composePoseChannels(report, frame, 0, {sampleNative: (virtual, index) => virtual.keyframes[index]});
  assert.equal(output.objects.length, childCount + 1);
  assert.ok(output.objects.filter(object => object.unique_id !== 1).every(object => output.objects[object.join.target_object_slot].unique_id === 1));
  assert.ok(reads < (childCount + segmentCount) * 10, `${reads} definition segment reads for ${childCount} joins and ${segmentCount} segments`);
});
