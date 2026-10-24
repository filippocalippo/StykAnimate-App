// Joined spatial targets and foot pin lifecycle, built and recorded in the editor first.
import {readFileSync, writeFileSync} from 'node:fs';
import {open, createObject, createFrame, prune} from './fixture-kit.mjs';
const out = new URL('../tests/edit/', import.meta.url);
const app = {layerTimeline: true, propertyChannels: true};
const source = name => JSON.parse(readFileSync(new URL(`../crates/styk-eval/tests/fixtures/ik/${name}.json`, import.meta.url), 'utf8'));
function make({mirror = false, free = false, parent = true} = {}) {
  const doc = source(mirror ? 'spatial-mirrored' : 'spatial');
  const line = structuredClone(doc.figure_types[0]); line.figure_type_id = 2;
  const child = structuredClone(doc.figure_types[0]); child.figure_type_id = 3;
  doc.figure_types.push(line, child);
  for (const frame of doc.keyframes) {
    const {objects, object_draw_order, object_draw_order_unique_ids} = createFrame([...frame.objects, createObject(line, 2, 370, 150), createObject(child, 3, 200, 300)]);
    Object.assign(frame, {objects, object_draw_order, object_draw_order_unique_ids});
  }
  const e = open(doc);
  for (let i = 0; i < e.report.keyframes.length; i++) {
    e.selectFrame(i); e.select(1, 9);
    if (free) e.setNodeIK({pinned: false});
    if (parent) { e.select(1, -1); e.joinTo(2, 13); }
    else { e.select(2, -1); e.joinTo(1, 13); }
    e.select(3, -1); e.joinTo(1, 10);
  }
  return prune(e.serialize());
}
function record(name, doc, options, joined = true) {
  const filename = `${name}.document.json`;
  writeFileSync(new URL(filename, out), JSON.stringify(doc) + '\n');
  const e = open(structuredClone(doc), options); e.select(1, 9);
  const p = e.geometry.objects.get(0).joints.get(10), at = (x, y) => [p.x + x, p.y + y];
  const steps = [
    ...(name.includes('negative') ? [['@select', 1, -1], ['updateObject', {scale: -1.25}], ['scaleSelection', -1.1]] : []),
    ['@select', 1, 9], ['beginDrag', 'Pose figure'], ['poseJoint', ...at(8, -6)], ['poseJoint', ...at(18, 4)], ['poseJoint', ...at(0, 0)], ['commitDrag'],
    ['beginDrag', 'Pose figure'], ['poseJoint', ...at(-12, 9)], ['cancelDrag'], ['poseJoint', ...at(5, 3)], ['undo'], ['redo'],
    ['setSpatialFeetPinned', false], ['beginDrag', 'Pose figure'], ['poseJoint', ...at(15, -10)], ['poseJoint', ...at(22, 1)], ['commitDrag'],
    ['setSpatialFeetPinned', true], ['undo'], ['redo'], ['setSpatialFeetPinned', true], ['setSpatialFeetPinned', 'invalid'],
    ['@select', 1, 3], ['setSpatialFeetPinned', false], ['setSpatialFeetPinned', true], ['@select', 1, 9],
    ['poseJoint', null, 3], ['poseJoint', 1, 2, {snapTolerance: -1}],
    ...(joined ? [['updateObject', {_stykSpatial: {camera: {strength: .8, distance: 400}}}], ['@select', 2, -1], ['setSpatialFeetPinned', false]] : []),
    ['@select', 1, 9], ['beginDrag', 'Pose figure'], ['poseJoint', ...at(20, -15)], ['cancelDrag'], ['undo'], ['redo'],
  ];
  writeFileSync(new URL(`${name}.scenario.json`, out), JSON.stringify({name, document: filename, editor: options, steps}, null, 1) + '\n');
}
for (const [suffix, params] of [['parent', {}], ['child', {parent: false}], ['free', {free: true}], ['mirrored', {mirror: true}], ['negative', {}]]) {
  record(`ik-spatial-joined-${suffix}-sheet`, make(params), app);
}
record('ik-spatial-joined-native', make(), {});
for (const [mode, options] of [['sheet', app], ['native', {}]]) {
  const doc = source('spatial');
  for (const frame of doc.keyframes) frame.objects[0]._stykSpatial = {camera: {strength: .7, distance: 400, centerX: 240, centerY: 160}};
  record(`ik-spatial-perspective-target-${mode}`, doc, options, false);
}
