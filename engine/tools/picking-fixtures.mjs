#!/usr/bin/env node
// Numeric handle/selection queries recorded from the actual editor and canvas
// owners. References contain descriptors and results, never cloned geometry.
// node engine/tools/picking-fixtures.mjs [name ...] [--out folder] [--list]
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {here, documentOf, limb, open, joint, nextKey, prune} from './fixture-kit.mjs';
import {getPivotHandles, pickCanvasHandle, figureIntersectsMarquee} from '../../src/canvas-interactions.mjs';
import {rigExampleDocument} from '../../src/rig-examples.mjs';

let counter = 0;
Object.defineProperty(globalThis.crypto, 'randomUUID', {configurable: true, value: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`});
const fixturesRoot = path.resolve(here, '../crates/styk-eval/tests/fixtures');
const read = relative => JSON.parse(readFileSync(`${fixturesRoot}/${relative}`, 'utf8'));
const prior = (relative, ticks = [0, 2, 5], native = false) => () => ({document: read(relative), ticks, native});
const fixtures = {
  'native-order-static': () => {
    const segments = [[11, 0, 7, 0, {thickness: 1, z_order: 8}],
      [22, 11, 4, .7, {aux_code: 1, z_order: 2}],
      [33, 22, 5, -.4, {visible: false, z_order: 2, _stykControl: {level: 'detail'}}],
      [44, 0, 0, 0, {thickness: 0, visible: false, z_order: 1}],
      [55, 11, 3, 1.4, {thickness: 9, z_order: 5}]];
    const document = documentOf([segments, segments, limb()], () => [100, 100]);
    document.keyframes[0].object_draw_order = [2, 0, 1];
    document.keyframes[0].objects[1].scale = 1.25;
    document.keyframes[0].objects[1].image_text_flags = 1;
    document.keyframes[0].objects[2].scale = 0;
    const e = open(document, {layerTimeline: false, propertyChannels: true});
    nextKey(e, 6); joint(e, 11, 1); e.rotateJoint(.45); e.select(2); e.moveSelection(3, -2);
    return {document: e.serialize(), ticks: [0, 2, 6], native: true};
  },
  'sheet-order-static': () => {
    const document = documentOf([limb(true), limb()], () => [100, 100]);
    document.figure_types[0].segments[1].aux_code = 1;
    document.figure_types[0].segments[2]._stykControl = {level: 'detail'};
    const e = open(document, {layerTimeline: true, propertyChannels: true});
    e.sheetSetDuration(10); e.seek(5); joint(e, 11, 1); e.rotateJoint(.35); e.select(2); e.moveSelection(4, 1);
    return {document: e.serialize(), ticks: [0, 2, 5, 9]};
  },
  'joined-ik': prior('ik/joined-stretch.json'),
  'pinned-ik': prior('ik/two-bone-pinned.json'),
  'joined-rig': prior('ik/rig-joined.json'),
  'origin-layout': prior('origin/origin-layout.json', [0, 3, 8, 12]),
  'origin-support': prior('origin/origin-support.json', [0, 3, 8, 12]),
  'origin-offsets': prior('origin/origin-offsets.json', [0, 3, 8, 12]),
  'spatial-perspective': prior('spatial/mesh-perspective.json', [0, 2, 5]),
  'spatial-weighted': prior('spatial/mesh-skinned.json', [0, 2, 5]),
  'pose-choice': prior('records/edit-pose-choices/report.json', [0, 2, 5]),
  'connector': () => ({document: rigExampleDocument('sliding-carriage'), ticks: [0], native: true}),
  'connector-curved': () => ({document: rigExampleDocument('nested-curve-controls'), ticks: [0], native: true}),
  'virtual-clip': prior('ik/movieclip.json', [0, 2, 5]),
  'virtual-spatial-clip': prior('spatial/clip-mesh.json', [0, 2, 5]),
};

const setKeys = ['selectedUids', 'selectedHandleIds', 'hiddenUids', 'lockedUids', 'joinTargetUids'];
const optionsOf = (value, frame) => ({...value, frame, ...Object.fromEntries(setKeys.filter(key => value[key]).map(key => [key, new Set(value[key])]))});
const descriptor = handle => {
  if (!handle) return null;
  const {g, point, ...rest} = handle;
  return {...rest, point: [point.x, point.y]};
};
const projectOf = m => p => ({x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5]});
const projections = [[1, 0, 0, 1, 0, 0], [0, 2, -2, 0, 17, -23], [-.4, .3, .3, .4, -9, 11]];

function record(e, tick) {
  e.seek(tick);
  const frame = e.evaluatedFrame, geometry = e.geometry;
  const uids = [...geometry.objects.values()].filter(Boolean).map(g => g.obj.unique_id);
  const first = uids[0], second = uids[1] ?? first;
  const firstGeometry = [...geometry.objects.values()].find(g => g?.obj.unique_id === first);
  const ids = firstGeometry?.segments.map(s => s.seg.segment_id) ?? [];
  const variants = [
    ['default', {}], ['selected', {selectedUid: first, selectedJoint: 1}],
    ['multi', {selectedUid: first, selectedUids: uids, selectedJoint: 1}],
    ['selected-only', {selectedUid: first, showUnselected: false}],
    ['static-selection', {showStatic: true, selectedUid: first, selectedJoint: 1}],
    ['static-targets', {selectStatic: true, showUnselected: false}],
    ['static-move', {showStatic: true, allowStaticManipulation: true}],
    ['attach', {attaching: true, joinTargetUids: [first], showUnselected: false}],
    ['branch', {builder: true, selectedUid: first, selectedJoint: 1, selectedBranch: true}],
    ['builder-multi', {builder: true, showStatic: true, selectedUid: first, selectedJoint: 0, selectedHandleIds: ids.slice(0, 2)}],
    ['detail', {showDetailed: true}],
    ['rotate', {selectedUid: first, selectedUids: uids, showStatic: true, spatialMode: 'rotate'}],
    ['figure', {selectedUid: first, selectedUids: uids, spatialMode: 'figure'}],
    ['builder-rotate', {selectedUid: first, builder: true, spatialMode: 'rotate'}],
    ['hidden', {hiddenUids: [first], selectedUid: second}],
    ['locked', {lockedUids: [second]}],
    ['small', {viewScale: .25, minDiameter: 3, maxDiameter: 13}],
    ['negative', {viewScale: -3, autoSize: false, showStatic: true}],
    ['zero-view', {viewScale: 0, showStatic: true}],
  ];
  const queries = variants.map(([name, options]) => {
    const handles = getPivotHandles(geometry, optionsOf(options, frame));
    const picks = [];
    const hitOf = hit => hit ? {handle: handles.findIndex(handle => handle.uid === hit.uid && handle.joint === hit.joint && handle.id === hit.id), distanceSquared: hit.distanceSquared} : null;
    for (const handle of handles.slice(0, 12)) {
      const point = handle.point;
      for (const pick of [{}, {nearest: true, minRadius: 8}, {nearest: true, minRadius: 8, preferredUid: first}, {radius: 0}, {radius: 12, preferredUid: first}]) {
        const result = pickCanvasHandle(geometry, point, {...pick, handles});
        picks.push({point: [point.x, point.y], options: pick, result: hitOf(result)});
      }
      // Strict edge/outside and square-vs-circle semantics are observable at the
      // endpoint. Use explicit binary-exact radii so projection rounding cannot
      // accidentally decide the expected boundary.
      for (const offset of [[8, 0], [7.999, 0], [6, 6], [-8, 0]]) {
        for (const nearest of [false, true]) {
          const p = {x: point.x + offset[0], y: point.y + offset[1]}, options = {nearest, radius: 8};
          picks.push({point: [p.x, p.y], options, result: hitOf(pickCanvasHandle(geometry, p, {...options, handles}))});
        }
      }
      const matrix = projections[(handle.joint + 2) % projections.length], pick = {nearest: true, minRadius: 8, preferredUid: first};
      picks.push({point: [point.x + 1, point.y - .5], matrix, options: pick,
        result: hitOf(pickCanvasHandle(geometry, {x: point.x + 1, y: point.y - .5}, {...pick, handles, project: projectOf(matrix)}))});
    }
    picks.push({point: [1e6, -1e6], options: {nearest: true}, result: hitOf(pickCanvasHandle(geometry, {x: 1e6, y: -1e6}, {nearest: true, handles}))});
    return {name, options, handles: handles.map(descriptor), groups: handles.groups.map(group => ({uid: group.uid, offset: group.offset, count: group.handles.length})), picks};
  });
  const marquees = [];
  for (const g of geometry.objects.values()) if (g) {
    for (const matrix of projections) {
      const p = projectOf(matrix)(g.root);
      for (const rect of [{left: p.x, right: p.x, top: p.y, bottom: p.y},
        {left: p.x + .001, right: p.x + 10, top: p.y, bottom: p.y + 10},
        {left: p.x - 10, right: p.x + 10, top: p.y - 10, bottom: p.y + 10}]) {
        marquees.push({uid: g.obj.unique_id, matrix, rect,
          result: figureIntersectsMarquee(g, rect, {mode: 'origins', project: projectOf(matrix)})});
      }
    }
  }
  // JSON tags retain the invalid values instead of silently turning them into
  // null. The owner's early finite-point rejection also runs with huge radius.
  const invalidPicks = [[NaN, 0], [0, Infinity], [-Infinity, 0]].map(([x, y]) => ({
    point: [x, y].map(value => Number.isFinite(value) ? value : String(value)),
    result: pickCanvasHandle(geometry, {x, y}, {frame, radius: Infinity}),
  }));
  return {tick, queries, marquees, invalidPicks};
}

const args = process.argv.slice(2), outAt = args.indexOf('--out');
if (args.includes('--list')) {console.log(Object.keys(fixtures).join('\n')); process.exit(0);}
const names = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
const out = path.resolve(outAt < 0 ? `${fixturesRoot}/picking` : args[outAt + 1]);
mkdirSync(out, {recursive: true});
for (const name of names.length ? names : Object.keys(fixtures)) {
  if (!fixtures[name]) throw new Error(`unknown picking fixture ${name}`);
  counter = 0;
  const {document, ticks, native = false} = fixtures[name]();
  const e = open(document, {layerTimeline: !native, propertyChannels: true});
  const project = prune(e.serialize());
  writeFileSync(`${out}/${name}.json`, JSON.stringify(project) + '\n');
  const frames = [...new Set(ticks.map(tick => Math.min(tick, e.totalTicks - 1)))].map(tick => record(e, tick));
  const reference = {owner: 'canvas-interactions.mjs', native, frames};
  writeFileSync(`${out}/${name}.reference.json`, JSON.stringify(reference) + '\n');
  console.log(`${name}: ${frames.length} frames, ${frames.reduce((n, frame) => n + frame.queries.length, 0)} handle queries`);
}
