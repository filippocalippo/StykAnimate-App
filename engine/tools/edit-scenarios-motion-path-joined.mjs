// Joined pinned followers, recorded from the corrected JavaScript motion-path owner.
import {readFileSync, writeFileSync} from 'node:fs';
import {open} from './fixture-kit.mjs';
import {buildGeometry} from '../../src/pivot/geometry.mjs';
const app = {layerTimeline: true, propertyChannels: true};
const file = '../../crates/styk-eval/tests/fixtures/ik/joined.json';
const document = JSON.parse(readFileSync(new URL('../crates/styk-eval/tests/fixtures/ik/joined.json', import.meta.url), 'utf8'));
const editor = open(document, app), target = {kind: 'node', uid: 3, handleId: 33, joint: 0};
editor.beginMotionPathEdit(target, 2);
const shape = buildGeometry(editor.report, editor._drag.working).objects.get(2).segments[0];
const turn = radians => ({x: shape.start.x + (shape.end.x - shape.start.x) * Math.cos(radians) - (shape.end.y - shape.start.y) * Math.sin(radians),
  y: shape.start.y + (shape.end.x - shape.start.x) * Math.sin(radians) + (shape.end.y - shape.start.y) * Math.cos(radians)});
const begin = (tick, options) => ['beginMotionPathEdit', target, tick, ...(options ? [options] : [])];
const update = (p, options) => ['updateMotionPathEdit', p, ...(options ? [options] : [])];
const steps = [
  ['@select', 3, 0], ['@seek', 5], begin(2), update(turn(.25)), update(shape.end), ['cancelMotionPathEdit'],
  begin(2), update(turn(.25)), update(turn(.35), {isolate: true}), ['commitMotionPathEdit'], ['undo'], ['redo'],
  begin(4, {falloff: {radius: 3, shape: 'smooth'}}), update(turn(-.4)), ['setMotionPathFalloff', {radius: 2, shape: 'linear'}],
  update(turn(-.3)), ['commitMotionPathEdit'], ['undo'], ['redo'],
  ['beginMotionPathEdit', {kind: 'node', uid: 2, handleId: 22, joint: 0}, 3], update({x: 355, y: 280}), ['commitMotionPathEdit'], ['undo'], ['redo'],
  begin(5), update(turn(.5)), ['commitMotionPathEdit'], ['undo'], ['redo'],
  ['beginMotionPathEdit', {kind: 'node', uid: 3, handleId: 34, joint: 1}, 2],
  ['beginMotionPathEdit', {kind: 'node', uid: 99, handleId: 33, joint: 0}, 2], ['commitMotionPathEdit'], ['cancelMotionPathEdit'],
];
writeFileSync(new URL('../tests/edit/motion-path-joined-followers-sheet.scenario.json', import.meta.url), JSON.stringify({name: 'motion-path-joined-followers-sheet', document: file, editor: app, steps}, null, 1) + '\n');
