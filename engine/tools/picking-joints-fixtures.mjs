#!/usr/bin/env node
// All-joint picking uses the exact private app owner, including its live cache
// order. No handle/KD/painter-order substitute supplies reference answers.
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {here, repo, open, documentOf, limb, joint} from './fixture-kit.mjs';
import {snapshotPoseFrame} from '../../src/pose-snapshot.mjs';

const root = path.resolve(here, '../crates/styk-eval/tests/fixtures');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const source = readFileSync(`${repo}/src/app.mjs`, 'utf8');
const owner = source.slice(source.indexOf('function closestHandle('), source.indexOf('function cancelPolygonDraft()'));
assert.ok(owner.startsWith('function closestHandle(') && owner.endsWith('}\n'));
const names = ['native-order-static', 'sheet-order-static', 'joined-ik', 'pinned-ik', 'joined-rig',
  'origin-layout', 'origin-support', 'origin-offsets', 'spatial-perspective', 'spatial-weighted', 'pose-choice',
  'connector', 'connector-curved', 'virtual-clip', 'virtual-spatial-clip', 'sticknodes', 'bent', 'body-curves',
  'incremental-order-native', 'incremental-order-sheet'];
const inputOf = name => {
  if (name.startsWith('incremental-order')) {
    const document = documentOf([limb(), limb(), limb()], () => [100, 100]);
    document.keyframes[0].objects[0].join = {target_object_slot: 2, target_unique_id: 3, target_handle_id: 0};
    return {document, ticks: [0], native: name.endsWith('native')};
  }
  const reference = read(`${root}/picking-construction/${name}.reference.json`);
  return {document: read(`${root}/picking-construction/${name}.json`), ticks: reference.frames.map(frame => frame.tick), native: reference.native};
};
const tag = value => Number.isFinite(value) ? value : String(value);
function record(editor, tick, stage) {
  // A seek invalidates the live insertion order. Incremental stages deliberately
  // stay at their actual current playhead; ordinary multi-tick cases seek.
  if (stage === null) editor.seek(tick);
  const frame = editor.evaluatedFrame, geometry = editor.geometry;
  const objects = [...geometry.objects.values()].filter(Boolean);
  const order = objects.map(g => g.slot), first = objects[0]?.obj.unique_id, second = objects[1]?.obj.unique_id;
  const hidden = new Set(), locked = new Set(), state = {view: {scale: 1}};
  const query = vm.runInNewContext(`(${owner})`, {editor, state, isHidden: uid => hidden.has(uid), isLocked: uid => locked.has(uid)});
  const resultOf = hit => hit ? {slot: hit.g.slot, uid: hit.g.obj.unique_id, id: hit.id,
    joint: hit.id === 0 ? -1 : hit.g.fig.segments.findIndex(segment => segment.segment_id === hit.id), point: [hit.point.x, hit.point.y]} : null;
  const points = [{x: 100, y: 100}, {x: 110, y: 100}, {x: 110.000001, y: 100}, {x: 110, y: 110}];
  for (const g of objects) for (const p of [...g.joints.values()].slice(0, 5))
    points.push(p, {x: p.x + 10, y: p.y}, {x: p.x + 9.999, y: p.y}, {x: p.x + 6, y: p.y + 6});
  points.push({x: Infinity, y: 0}, {x: NaN, y: 1}, {x: 0, y: -Infinity});
  const calls = [];
  for (const scale of [1, .25, 4, -1, 0, NaN]) {
    state.view.scale = scale;
    for (const [hide, lock] of [[[], []], [[first], []], [[], [second]], [[first], [second]]]) {
      hidden.clear(); locked.clear(); hide.forEach(uid => hidden.add(uid)); lock.forEach(uid => locked.add(uid));
      for (const point of points) for (const [excludedUid, uid] of [[null, undefined], [first, undefined], [null, first], [null, second]]) {
        const result = resultOf(query(point, excludedUid, uid === undefined ? {} : {uid}));
        calls.push({point: [point.x, point.y].map(tag), scale: tag(scale), hidden: hide, locked: lock,
          excludedUid, uid: uid ?? null, result});
      }
    }
  }
  hidden.clear(); locked.clear(); state.view.scale = 1;
  return {tick, stage, order, frameUids: frame.objects.map(o => o.unique_id),
    // Publication may reorder native stored records while a retained gesture
    // pose remains on show. This existing owner captures that exact frame as
    // offline INPUT, not a new query result or app geometry transport.
    pose: stage === null ? undefined : snapshotPoseFrame(frame),
    rootHit: resultOf(query({x: 100, y: 100})), calls};
}

const args = process.argv.slice(2), outAt = args.indexOf('--out');
if (args.includes('--list')) {console.log(names.join('\n')); process.exit(0);}
const selected = args.filter((arg, i) => !arg.startsWith('--') && (outAt < 0 || i !== outAt + 1));
const out = path.resolve(outAt < 0 ? `${root}/picking-joints` : args[outAt + 1]);
mkdirSync(out, {recursive: true});
for (const name of selected.length ? selected : names) {
  assert.ok(names.includes(name), `unknown closest joint fixture ${name}`);
  const {document, ticks, native} = inputOf(name);
  const e = open(document, {layerTimeline: !native, propertyChannels: true});
  if (name.startsWith('incremental-order')) {
    // Store exact editor-owned reports at each step. Queries run on the live
    // editor FIRST, keeping insertion order across edits; no reopen supplies
    // the incremental oracle. The final reopened case records that distinction.
    const snapshots = [];
    snapshots.push(record(e, 0, 'initial'));
    writeFileSync(`${out}/${name}-initial.json`, JSON.stringify(e.report) + '\n');
    joint(e, 11, 2); e.rotateJoint(.17);
    snapshots.push(record(e, 0, 'edited'));
    writeFileSync(`${out}/${name}-edited.json`, JSON.stringify(e.report) + '\n');
    const reopened = open(e.serialize(), {layerTimeline: !native, propertyChannels: true});
    snapshots.push(record(reopened, 0, 'reopened'));
    writeFileSync(`${out}/${name}-reopened.json`, JSON.stringify(reopened.report) + '\n');
    writeFileSync(`${out}/${name}.reference.json`, JSON.stringify({owner: 'exact app.mjs closestHandle', native, frames: snapshots}) + '\n');
    console.log(`${name}: ${snapshots.map(frame => `${frame.stage} order${frame.order.join(',')} hit${frame.rootHit.uid}`).join('; ')}`);
  } else {
    const project = e.serialize(), actual = open(project, {layerTimeline: !native, propertyChannels: true});
    const frames = [...new Set(ticks.map(tick => Math.min(tick, actual.totalTicks - 1)))].map(tick => record(actual, tick, null));
    writeFileSync(`${out}/${name}.json`, JSON.stringify(project) + '\n');
    writeFileSync(`${out}/${name}.reference.json`, JSON.stringify({owner: 'exact app.mjs closestHandle', native, frames}) + '\n');
    console.log(`${name}: ${frames.length} frames, ${frames.reduce((n, frame) => n + frame.calls.length, 0)} closest queries`);
  }
}
