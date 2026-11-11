// The MCP server's spec compiler (mcp/src/spec.mjs): spec → native document.
import test from 'node:test';
import assert from 'node:assert/strict';
import {compileSpec, parseColor} from '../mcp/src/spec.mjs';
import {POSES, resolveAngles} from '../mcp/src/rig.mjs';

const cast = [{id: 'floor', kind: 'line', length: 540}, {id: 'bob', kind: 'stickman'}, {id: 'ball', kind: 'circle', radius: 20}];
const degrees = radians => Math.round(radians * 180 / Math.PI);

test('keyframes carry unspecified fields and keep one identity per cast member', () => {
  const {document, ticks} = compileSpec({cast, keyframes: [
    {hold: 10, figures: {floor: {x: 0, y: 700}, bob: {x: 100, ground: 700, pose: 'stand'}}},
    {hold: 5, figures: {bob: {x: 200}, ball: {x: 50, y: 50}}},
  ]});
  assert.equal(ticks, 15);
  const [first, second, closing] = document.keyframes;
  assert.equal(document.keyframes.length, 3, 'a closing key marks the end of the last hold');
  assert.deepEqual([first.duration_raw, second.duration_raw, closing.duration_raw], [10, 5, 1]);
  const bob = frame => frame.objects.find(object => object.figure_type_id === 2);
  assert.equal(bob(second).root_x, 200);
  assert.equal(bob(second).root_y, bob(first).root_y, 'ground placement carries over');
  assert.deepEqual(bob(second).angles, bob(first).angles, 'the pose carries over');
  assert.equal(bob(first).unique_id, bob(second).unique_id);
  assert.equal(first.objects.length, 2);
  assert.equal(second.objects.length, 3, 'a figure appears from the first keyframe that names it');
});

test('ground puts the lowest point of the pose on the floor', () => {
  const {document} = compileSpec({cast: [cast[1]], keyframes: [{figures: {bob: {x: 0, ground: 500, pose: 'stand', scale: 2}}}]});
  const object = document.keyframes[0].objects[0];
  // Standing legs (66 + 63 px, nearly vertical) plus half the shin thickness, doubled by scale.
  assert.ok(object.root_y < 500 - 2 * 120 && object.root_y > 500 - 2 * 135, `hip at ${object.root_y}`);
});

test('joints override a pose, joints alone adjust the previous pose, and flip mirrors', () => {
  const {document} = compileSpec({cast: [cast[1]], keyframes: [
    {figures: {bob: {pose: 'point', joints: {rightForearm: -45}}}},
    {figures: {bob: {joints: {leftThigh: 100}}}},
    {figures: {bob: {flip: true}}},
  ]});
  const angles = index => document.keyframes[index].objects[0].angles.map(degrees);
  assert.equal(angles(0)[3], -45);
  assert.equal(angles(1)[3], -45, 'the earlier override is kept');
  assert.equal(angles(1)[8], 100);
  assert.equal(angles(2)[3], 225, 'flip mirrors the adjusted pose: 180 - (-45)');
  assert.equal(angles(2)[8], 80);
});

test('hide removes a figure and camera and background apply per keyframe', () => {
  const {document} = compileSpec({width: 540, height: 960, background: '#fff', cast, keyframes: [
    {figures: {ball: {x: 10, y: 10}}, camera: {x: 370, y: 480, zoom: 2}},
    {figures: {ball: {hide: true}}, background: '#000'},
  ]});
  const [first, second] = document.keyframes;
  assert.deepEqual(first.camera, {is_default: false, x: 100, y: 0, scale: 0.5, angle_rad: 0});
  assert.deepEqual(second.camera, first.camera, 'the camera carries over');
  assert.equal(second.objects.length, 0);
  assert.notEqual(first.background_id, second.background_id);
  assert.equal(document.backgrounds.find(b => b.background_id === second.background_id).color, 0xff000000);
});

test('the circle is placed by its centre', () => {
  const {document} = compileSpec({cast: [cast[2]], keyframes: [{figures: {ball: {x: 50, y: 100}}}]});
  assert.equal(document.keyframes[0].objects[0].root_y, 120);
});

test('invalid specs explain the problem', () => {
  assert.throws(() => compileSpec({cast, keyframes: [{figures: {nobody: {}}}]}), /not in the cast/);
  assert.throws(() => compileSpec({cast, keyframes: [{figures: {bob: {pose: 'moonwalk'}}}]}), /Unknown pose/);
  assert.throws(() => compileSpec({cast, keyframes: [{hold: 0}]}), /hold/);
  assert.throws(() => compileSpec({cast: [...cast, {id: 'bob', kind: 'line'}], keyframes: [{}]}), /unique/);
  assert.throws(() => parseColor('red'), /hex colour/);
  assert.deepEqual(parseColor('#f80'), [255, 136, 0]);
});

test('every library pose resolves every joint', () => {
  for (const name of Object.keys(POSES)) assert.equal(Object.values(resolveAngles({pose: name})).filter(Number.isFinite).length, 10, name);
});
