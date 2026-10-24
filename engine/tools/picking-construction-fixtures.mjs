#!/usr/bin/env node
// Raw segment body picking and gesture-local construction queries from their
// actual JavaScript owners. No geometry snapshots are recorded.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {here, open, documentOf} from './fixture-kit.mjs';
import {ConstructionIndex} from '../../src/builder-construction.mjs';
import {getPivotHandles, pickCanvasSegment} from '../../src/canvas-interactions.mjs';

let counter = 0;
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`});
const root = path.resolve(here, '../crates/styk-eval/tests/fixtures');
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const names = ['native-order-static', 'sheet-order-static', 'joined-ik', 'pinned-ik', 'joined-rig',
  'origin-layout', 'origin-support', 'origin-offsets', 'spatial-perspective', 'spatial-weighted',
  'pose-choice', 'connector', 'connector-curved', 'virtual-clip', 'virtual-spatial-clip', 'sticknodes', 'bent', 'body-curves'];
const projectOf = name => {
  if (name === 'sticknodes') return {document: read(path.resolve(here, '../tests/edit/sticknodes.document.json')), ticks: [0], native: false};
  if (name === 'bent') return {document: read(`${root}/ik/bent.json`), ticks: [0, 2, 5], native: false};
  if (name === 'body-curves') {
    const document = documentOf([[[11, 0, 80, .2, {bend_rad: 1.2}], [22, 11, 60, -.8, {bend_rad: -.65}],
      [33, 0, 30, -.1, {aux_code: 1}], [44, 0, 50, 1.7, {visible: false}],
      [55, 0, 60, .9, {transparency: 255}], [66, 0, 10, 0, {thickness: 0}]],
      [[71, 0, 80, .2, {bend_rad: 1.2}], [72, 71, 60, -.8, {bend_rad: -.65}]]], () => [100, 100]);
    return {document, ticks: [0], native: true};
  }
  const reference = read(`${root}/picking/${name}.reference.json`);
  return {document: read(`${root}/picking/${name}.json`), ticks: reference.frames.map(f => f.tick), native: reference.native};
};
const point = p => [p.x, p.y];
const snapResult = p => p ? {point: point(p), id: p.id ?? null, kind: p.kind ?? null} : null;
const midpoint = s => {
  const points = s.points ?? [s.start, s.end], middle = (points.length - 1) / 2;
  const a = points[Math.floor(middle)], b = points[Math.ceil(middle)];
  return {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
};
const tag = number => Number.isFinite(number) ? number : String(number);
function record(e, tick) {
  e.seek(tick);
  const frame = e.evaluatedFrame, geometry = e.geometry, objects = [...geometry.objects.values()].filter(Boolean);
  const uids = objects.map(g => g.obj.unique_id), first = uids[0];
  const body = [];
  const variants = [['ordinary', {}], ['all', {selectedUids: uids, showStatic: true, allowStaticManipulation: true}],
    ['hidden', {hiddenUids: [first]}], ['locked', {lockedUids: [first]}],
    ['rotate', {selectedUids: uids, selectedUid: first, spatialMode: 'rotate'}],
    ['builder', {selectedUid: first, selectedJoint: 0, builder: true, selectedBranch: true}]];
  for (const [name, options] of variants) {
    const input = {...options, frame};
    for (const key of ['selectedUids', 'hiddenUids', 'lockedUids']) if (input[key]) input[key] = new Set(input[key]);
    const handles = getPivotHandles(geometry, input);
    const probes = objects.flatMap(g => g.segments.slice(0, 8).flatMap(s => {
      const p = midpoint(s);
      return [p, {x: p.x + 8 + (s.thickness ?? 0) / 2, y: p.y}, {x: p.x, y: p.y + .01}, s.end];
    }));
    const picks = [];
    for (const p of probes) for (const pick of [{}, {uid: first}, {scale: 4, padding: 0}, {scale: -.25, padding: 3}, {scale: 0, padding: 0}, {padding: -2}]) {
      const hit = pickCanvasSegment(geometry, p, {...pick, handles});
      const result = hit ? {handle: handles.findIndex(h => h.uid === hit.uid && h.joint === hit.joint && h.id === hit.id), kind: hit.kind, distanceSquared: hit.distanceSquared} : null;
      picks.push({point: point(p), options: pick, result});
    }
    body.push({name, options, handles: handles.map(h => ({uid: h.uid, joint: h.joint, id: h.id})), picks});
  }
  const construction = [];
  for (const g of objects) {
    const joints = [...g.joints.values()].slice(0, 5), mids = g.segments.slice(0, 5).map(midpoint), samples = [...joints, ...mids];
    if (!samples.length) continue;
    const origin = g.root;
    samples.push({x: origin.x + 99, y: origin.y + 51}, {x: origin.x + 25, y: origin.y - 40});
    for (const excluded of [[], [0], g.segments.slice(0, 2).map(s => s.seg.segment_id)]) {
      const index = new ConstructionIndex(g, new Set(excluded));
      const nearest = [];
      for (const p of samples) for (const radius of [0, 8, -8, Infinity]) for (const jointsOnly of [false, true]) {
        nearest.push({point: point(p), radius: tag(radius), jointsOnly, result: snapResult(index.nearest(p, radius, {jointsOnly}))});
      }
      const sequence = [];
      for (const p of samples.slice(0, 4)) {
        for (const [radius, disabled, dx, dy] of [[8, false, 1, 1], [8, false, 10, 0], [8, true, 1, 1], [8, false, 10, 0], [0, false, 0, 0]]) {
          const p1 = {x: p.x + dx, y: p.y + dy}, options = {radius, disabled, origin};
          sequence.push({point: point(p1), options: {...options, origin: point(origin)}, result: snapResult(index.snap(p1, options))});
        }
      }
      for (const p of [{x: origin.x + 80, y: origin.y + 17}, {x: origin.x + 99, y: origin.y + 4}, {x: origin.x + 0.1, y: origin.y - 49}]) {
        const options = {radius: 8, origin};
        sequence.push({point: point(p), options: {radius: 8, origin: point(origin)}, result: snapResult(index.snap(p, options))});
      }
      construction.push({uid: g.obj.unique_id, excluded, nearest, sequence});
    }
  }
  return {tick, body, construction};
}
const args = process.argv.slice(2), at = args.indexOf('--out');
if (args.includes('--list')) {console.log(names.join('\n')); process.exit(0);}
const selected = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
const out = path.resolve(at < 0 ? `${root}/picking-construction` : args[at + 1]);
mkdirSync(out, {recursive: true});
for (const name of selected.length ? selected : names) {
  if (!names.includes(name)) throw new Error(`unknown picking construction fixture ${name}`);
  counter = 0;
  const {document, ticks, native} = projectOf(name);
  const e = open(document, {layerTimeline: !native, propertyChannels: true});
  writeFileSync(`${out}/${name}.json`, JSON.stringify(e.serialize()) + '\n');
  // Saving normalizes derived visibility and native fields. Record the editor
  // loaded from the exact project bytes Rust reads, as reference.mjs does.
  const recorder = open(read(`${out}/${name}.json`), {layerTimeline: !native, propertyChannels: true});
  const frames = [...new Set(ticks.map(t => Math.min(t, recorder.totalTicks - 1)))].map(t => record(recorder, t));
  writeFileSync(`${out}/${name}.reference.json`, JSON.stringify({native, frames}) + '\n');
  console.log(`${name}: ${frames.length} frames; raw picking and construction owner queries`);
}
