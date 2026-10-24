#!/usr/bin/env node
// Bounds are measured by the app's actual boundsOf/objectBounds owner. Only
// numeric input and predicate results are recorded; no geometry is transported.
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {here, repo, open, prune} from './fixture-kit.mjs';
import {figureIntersectsMarquee} from '../../src/canvas-interactions.mjs';
import {objectBounds} from '../../src/renderer-geometry.mjs';

const root = path.resolve(here, '../crates/styk-eval/tests/fixtures');
const read = name => JSON.parse(readFileSync(name, 'utf8'));
const source = readFileSync(`${repo}/src/app.mjs`, 'utf8');
const boundsSource = source.slice(source.indexOf('function boundsOf(g) {'), source.indexOf('// Keep one surface alive'));
assert.ok(boundsSource.startsWith('function boundsOf(g) {') && boundsSource.endsWith('}\n'));
const selectionAt = source.indexOf('const uids = new Set(), rect = {left, right, top, bottom};');
const selectionEnd = source.indexOf('editor.selectMarquee([...uids], { mode: drag.mode, initial: drag.initial });', selectionAt);
assert.ok(selectionAt >= 0 && selectionEnd > selectionAt);
const selectionSource = source.slice(selectionAt, selectionEnd);

const names = ['native-order-static', 'sheet-order-static', 'joined-ik', 'origin-layout', 'origin-support',
  'spatial-perspective', 'pose-choice', 'connector-curved', 'virtual-clip', 'media', 'drawing'];
const fixture = name => {
  if (name === 'media') return {document: read(path.resolve(here, '../tests/edit/measured-bounds-media.document.json')), ticks: [0, 3, 6], native: false};
  if (name === 'drawing') return {document: read(`${root}/drawlist/drawing-cel.json`), ticks: [0], native: false};
  const reference = read(`${root}/picking/${name}.reference.json`);
  return {document: read(`${root}/picking/${name}.json`), ticks: reference.frames.map(frame => frame.tick), native: reference.native};
};
const projections = [[1, 0, 0, 1, 0, 0], [0, 2, -2, 0, 17, -23], [-.4, .3, .3, .4, -9, 11],
  [.8, .6, -.6, .8, 19, -7], [-2, 0, 0, 2, 3, 4]];
const projectOf = m => p => ({x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5]});
const box = b => [b.minX, b.minY, b.maxX, b.maxY];
const tag = value => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;

function record(e, tick) {
  e.seek(tick);
  const geometry = e.geometry;
  const objects = [...geometry.objects.values()].filter(Boolean);
  const first = objects[0]?.obj.unique_id, second = objects[1]?.obj.unique_id;
  const measurements = [], selections = [];
  const resourceVariants = [['published', {}], ['no-effect-padding', {vfxBounds: false}],
    ['ready-live-drawing-bounds', {drawing: figure => figure._styk?.drawing ? {store: {bounds: {x: -13, y: 7, width: 52, height: 81}}} : null}]];
  for (const [resource, resources] of resourceVariants) {
    const boundsOf = vm.runInNewContext(`(${boundsSource})`, {boundsCache: new WeakMap(), objectBounds, resources});
    for (const g of objects) {
      const bounds = boundsOf(g), predicates = [];
      for (const matrix of projections) {
        const project = projectOf(matrix);
        const corners = [{x: bounds.minX, y: bounds.minY}, {x: bounds.maxX, y: bounds.minY},
          {x: bounds.maxX, y: bounds.maxY}, {x: bounds.minX, y: bounds.maxY}].map(project);
        const left = Math.min(...corners.map(p => p.x)), right = Math.max(...corners.map(p => p.x));
        const top = Math.min(...corners.map(p => p.y)), bottom = Math.max(...corners.map(p => p.y));
        const rects = [{left, right, top, bottom}, {left: right, right, top, bottom}, {left, right, top: bottom, bottom},
          {left: right + .001, right: right + 20, top, bottom},
          {left, right: left - .001, top, bottom}, {left: left - 20, right: right + 20, top: top - 20, bottom: bottom + 20}];
        for (const rect of rects) predicates.push({matrix, rect, result: figureIntersectsMarquee(g, rect, {project, boundsOf})});
        // Run the actual app's outer hidden/locked filter and 3 CSS pixel slop.
        // Input order is recorded rather than inventing a new selection order.
        for (const [hidden, locked] of [[[], []], [[first], []], [[], [second]], [[first], [second]]]) {
          const called = [];
          const rect = rects.at(-1);
          const context = {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            drag: {selectionMode: 'bounds'}, screenPoint: project, boundsOf,
            editor: {geometry}, isHidden: uid => hidden.includes(uid), isLocked: uid => locked.includes(uid),
            figureIntersectsMarquee(g, rect, options) {
              const result = figureIntersectsMarquee(g, rect, options);
              called.push({slot: g.slot, uid: g.obj.unique_id, bounds: box(boundsOf(g)), result});
              return result;
            }};
          const selected = vm.runInNewContext(`${selectionSource}\n[...uids]`, context);
          selections.push({resource, matrix, rect, hidden, locked, called, selected});
        }
      }
      measurements.push({resource, slot: g.slot, uid: g.obj.unique_id, bounds: box(bounds), predicates});
    }
  }
  const invalid = [];
  if (objects.length) {
    const g = objects[0], project = projectOf(projections[0]);
    const rect = {left: -1000, right: 1000, top: -1000, bottom: 1000};
    for (const bounds of [null, undefined, {}, {minX: NaN, minY: 0, maxX: 3, maxY: 4},
      {minX: -Infinity, minY: 0, maxX: Infinity, maxY: 4}, {minX: 3, minY: 4, maxX: 1, maxY: 2}]) {
      let result, error = null;
      try { result = figureIntersectsMarquee(g, rect, {project, boundsOf: () => bounds}); } catch (e) { error = e.name; }
      invalid.push({bounds: bounds == null ? String(bounds) : Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, tag(value)])), rect, matrix: projections[0], result, error});
    }
  }
  return {tick, measurements, selections, invalid};
}

const args = process.argv.slice(2), outAt = args.indexOf('--out');
if (args.includes('--list')) {console.log(names.join('\n')); process.exit(0);}
const selected = args.filter((arg, i) => !arg.startsWith('--') && (outAt < 0 || i !== outAt + 1));
const out = path.resolve(outAt < 0 ? `${root}/picking-bounds` : args[outAt + 1]);
mkdirSync(out, {recursive: true});
for (const name of selected.length ? selected : names) {
  assert.ok(names.includes(name), `unknown bounds fixture ${name}`);
  const {document, ticks, native} = fixture(name);
  const initial = open(document, {layerTimeline: !native, propertyChannels: true});
  const project = prune(initial.serialize());
  // Reopen the exact recorded project, including canonical file normalization.
  const e = open(project, {layerTimeline: !native, propertyChannels: true});
  const frames = [...new Set(ticks.map(tick => Math.min(tick, e.totalTicks - 1)))].map(tick => record(e, tick));
  writeFileSync(`${out}/${name}.json`, JSON.stringify(project) + '\n');
  writeFileSync(`${out}/${name}.reference.json`, JSON.stringify({owner: 'app.mjs boundsOf/marquee + renderer-geometry.mjs objectBounds + canvas-interactions.mjs figureIntersectsMarquee', native, frames}) + '\n');
  console.log(`${name}: ${frames.length} frames, ${frames.reduce((n, frame) => n + frame.measurements.reduce((n, measurement) => n + measurement.predicates.length, 0), 0)} predicates`);
}
