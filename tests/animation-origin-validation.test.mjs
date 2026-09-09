import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOriginSupport, validateOriginSupportSteps, validateOriginObject, validateOriginObjectSteps,
  invalidateOriginSupportValidation} from '../src/animation-origin-validation.mjs';

const clone = structuredClone;
const bone = (handleId, parent = -1) => ({handleId, parent, reversed: false, angle_rad: .3, bend_rad: -.1, length: 10});
function fixture({ghost = true} = {}) {
  const bones = ghost ? [bone(null), bone(7, 0), bone(99, 1)] : [bone(7), bone(99, 0)];
  const support = {version: 1, bones, vertices: {'0': -1, '7': ghost ? 1 : 0, '99': ghost ? 2 : 1},
    path: [{bone: 1, sign: -1}, {bone: 0, sign: 1}, {bone: 1, sign: 1}], rotation: 0};
  const origin = {handleId: 0, rotationHandleId: ghost ? null : 7, reversed: false, support};
  const figure = {segments: [{segment_id: 7, parent_id: 0}, {segment_id: 99, parent_id: 7}], _styk: {animationOrigin: origin}};
  const pose = {_stykAnimationOrigin: {x: 12, y: -7, offsetX: .1, offsetY: 0}};
  if (ghost) pose._stykAnimationOrigin.ghosts = {'0': {angle_rad: .5, bend_rad: .2, length: 25}};
  return {figure, pose, origin, support};
}
function finish(iterator) {
  const progress = [];
  for (;;) {const step = iterator.next(); if (step.done) return {result: step.value, progress}; progress.push(step.value);}
}

test('valid live and ghost supports preserve unknown data, signed paths, and every pose value', () => {
  for (const ghost of [false, true]) {
    const source = fixture({ghost}); source.support.future = {keep: 'descriptor'};
    source.support.bones[0].future = [1, 2]; source.pose._stykAnimationOrigin.future = true;
    const before = clone(source), metadata = validateOriginSupport(source.figure);
    assert.equal(metadata.support, source.support); assert.equal(metadata.ghostCount, Number(ghost));
    assert.deepEqual(metadata.ghostIndices, ghost ? [0] : []);
    assert.equal(validateOriginObject(source.pose, source.figure), source.pose);
    assert.deepEqual(source, before); assert(Object.isFrozen(metadata)); assert(Object.isFrozen(metadata.ghostIndices));
  }
});

test('legacy origin references and orphan coordinate semantics remain supported', () => {
  const {figure, pose, origin} = fixture({ghost: false}); delete origin.support;
  origin.future = {unknown: true}; origin.rotationHandleId = 99; origin.reversed = true;
  assert.equal(validateOriginSupport(figure).support, null); assert.equal(validateOriginObject(pose, figure), pose);
  const orphan = {_stykAnimationOrigin: {x: -1, y: 2, offsetX: -.5, future: true}};
  assert.equal(validateOriginObject(orphan, {segments: []}), orphan);
  assert.equal(validateOriginObject({}, {segments: []})._stykAnimationOrigin, undefined);
  assert.throws(() => validateOriginObject({}, figure), /missing/);
  for (const mutate of [o => o.handleId = null, o => o.handleId = 10, o => o.rotationHandleId = 0, o => o.reversed = 1]) {
    const next = clone(figure); mutate(next._styk.animationOrigin); assert.throws(() => validateOriginSupport(next), /native handles/);
  }
});

test('support structural limits, required fields, types, and bone parent cycles are rejected', () => {
  const mutations = [
    s => s.version = 2, s => s.version = '1', s => s.bones = {}, s => s.bones = [], s => s.bones.length = 100001,
    s => s.bones[1] = null, s => delete s.bones[1].parent, s => s.bones[1].parent = 1,
    s => s.bones[0].parent = 2, s => s.bones[1].parent = 3, s => s.bones[1].parent = -2,
    s => s.bones[1].parent = .5, s => s.bones[1].reversed = 0, s => delete s.bones[1].reversed,
    s => s.bones[0].handleId = undefined, s => s.bones[1].handleId = 0,
    s => s.bones[1].handleId = 8, s => s.bones[1].handleId = '7', s => s.bones[2].handleId = 7,
    s => s.bones[2].handleId = null, s => s.rotation = -1, s => s.rotation = 3, s => s.rotation = .5,
  ];
  for (const mutate of mutations) {
    const source = fixture(); mutate(source.support); const before = clone(source);
    assert.throws(() => validateOriginSupport(source.figure)); assert.deepEqual(source, before);
  }
  const source = fixture(); source.origin.support = null; assert.throws(() => validateOriginSupport(source.figure));
});

test('vertices require exact own canonical native keys and distinct bounded nodes', () => {
  const mutations = [
    s => s.vertices = [], s => s.vertices = null, s => delete s.vertices['0'], s => delete s.vertices['99'],
    s => s.vertices['07'] = 0, s => s.vertices['+7'] = 0, s => s.vertices['7.0'] = 0,
    s => s.vertices['101'] = 0, s => s.vertices['-0'] = 0, s => s.vertices['x'] = 0,
    s => s.vertices['7'] = -1, s => s.vertices['7'] = 3, s => s.vertices['7'] = -2,
    s => s.vertices['7'] = 1.2, s => s.vertices['7'] = '1',
    s => {const original = s.vertices; s.vertices = Object.create(original);},
  ];
  for (const mutate of mutations) {const {figure, support} = fixture(); mutate(support); assert.throws(() => validateOriginSupport(figure), /vert/);}
  const {figure, support} = fixture(); Object.setPrototypeOf(support.vertices, {ignoredInherited: 99});
  assert.doesNotThrow(() => validateOriginSupport(figure));
});

test('path is a bounded signed-vector expression, not an inferred ancestry chain', () => {
  const {figure, support} = fixture();
  support.path = [{bone: 2, sign: -1}, {bone: 0, sign: 1}, {bone: 2, sign: 1}, {bone: 1, sign: -1}];
  assert.doesNotThrow(() => validateOriginSupport(figure));
  support.path = []; assert.doesNotThrow(() => validateOriginSupport(figure));
  for (const path of [null, {}, [null], [{bone: 3, sign: 1}], [{bone: -1, sign: 1}], [{bone: .5, sign: 1}],
    [{bone: 0, sign: 0}], [{bone: 0, sign: true}], [{bone: 0, sign: '1'}], Array(100001)]) {
    support.path = path; assert.throws(() => validateOriginSupport(figure), /path/);
  }
});

test('legacy compatibility handles agree with the virtual root and live or ghost rotation bone', () => {
  for (const mutate of [o => o.handleId = 7, o => o.handleId = 100, o => delete o.handleId,
    o => o.rotationHandleId = 7, o => delete o.rotationHandleId, o => o.reversed = 'false']) {
    const {figure, origin} = fixture(); mutate(origin); assert.throws(() => validateOriginSupport(figure));
  }
  const {figure, origin, support} = fixture(); origin.handleId = null; origin.reversed = true;
  assert.doesNotThrow(() => validateOriginSupport(figure)); // Ghost rotations have no legacy live tangent.
  support.rotation = 1; origin.rotationHandleId = 7; origin.reversed = false;
  assert.doesNotThrow(() => validateOriginSupport(figure));
  origin.rotationHandleId = null; assert.throws(() => validateOriginSupport(figure), /rotation/);
  origin.rotationHandleId = 7; origin.reversed = true; assert.throws(() => validateOriginSupport(figure), /rotation/);
});

test('support and ghost angles use finite doubles while lengths retain signed native float32 semantics', () => {
  const {figure, pose, support} = fixture();
  Object.assign(support.bones[0], {angle_rad: 1e200, bend_rad: -1e200, length: -3.4028234663852886e38});
  Object.assign(pose._stykAnimationOrigin.ghosts['0'], {angle_rad: -1e200, bend_rad: 1e200, length: -1e-46});
  assert.doesNotThrow(() => validateOriginSupport(figure)); assert.doesNotThrow(() => validateOriginObject(pose, figure));
  for (const [field, values] of [['angle_rad', [NaN, Infinity, '1', null, undefined]], ['bend_rad', [NaN, -Infinity, true]],
    ['length', [Infinity, -Infinity, 1e39, -1e39, '0', undefined]]]) for (const value of values) {
    const invalid = fixture(); invalid.support.bones[0][field] = value; assert.throws(() => validateOriginSupport(invalid.figure));
    const badPose = fixture(); validateOriginSupport(badPose.figure); badPose.pose._stykAnimationOrigin.ghosts['0'][field] = value;
    assert.throws(() => validateOriginObject(badPose.pose, badPose.figure));
  }
  for (const field of ['x', 'y', 'offsetX', 'offsetY']) {
    const invalid = fixture(); invalid.pose._stykAnimationOrigin[field] = 1e100;
    assert.throws(() => validateOriginObject(invalid.pose, invalid.figure), /float32/);
  }
});

test('per-pose ghost records contain exactly every retained index and all pose fields', () => {
  const mutations = [
    o => delete o.ghosts, o => o.ghosts = null, o => o.ghosts = [], o => o.ghosts = {},
    o => o.ghosts['1'] = clone(o.ghosts['0']), o => o.ghosts['00'] = clone(o.ghosts['0']),
    o => {o.ghosts = {'00': o.ghosts['0']};}, o => o.ghosts['0'] = null,
    o => delete o.ghosts['0'].angle_rad, o => delete o.ghosts['0'].bend_rad, o => delete o.ghosts['0'].length,
    o => {o.ghosts = Object.create(o.ghosts);},
  ];
  for (const mutate of mutations) {const {figure, pose} = fixture(); validateOriginSupport(figure); mutate(pose._stykAnimationOrigin); assert.throws(() => validateOriginObject(pose, figure), /ghost/);}
  const {figure, pose} = fixture({ghost: false}); pose._stykAnimationOrigin.ghosts = {};
  assert.throws(() => validateOriginObject(pose, figure), /omit ghosts/);
  const orphan = {_stykAnimationOrigin: {x: 0, y: 0, ghosts: {'9': {angle_rad: 1, bend_rad: 0, length: 1}}}};
  assert.equal(validateOriginObject(orphan, {segments: []}), orphan);
  orphan._stykAnimationOrigin.ghosts['9'].length = -1e39; assert.throws(() => validateOriginObject(orphan, {segments: []}), /length/);
});

test('only complete successful validation is cached and descriptor replacement revalidates', () => {
  const {figure, pose, support} = fixture(); let reads = 0, length = support.bones[0].length;
  Object.defineProperty(support.bones[0], 'length', {enumerable: true, configurable: true, get() {reads++; return length;}});
  validateOriginSupport(figure); const completeReads = reads;
  for (let i = 0; i < 20; i++) validateOriginObject(pose, figure);
  assert.equal(reads, completeReads, 'Object checks must not scan the support bone table.');
  length = -1e39; assert.throws(() => validateOriginSupport(figure), /length/); assert.throws(() => validateOriginObject(pose, figure), /length/);
  length = 10; validateOriginSupport(figure); figure._styk.animationOrigin = {...figure._styk.animationOrigin, rotationHandleId: 7};
  assert.throws(() => validateOriginObject(pose, figure), /rotation/);
  figure._styk.animationOrigin.rotationHandleId = null; validateOriginSupport(figure); invalidateOriginSupportValidation(figure);
  const before = reads; validateOriginObject(pose, figure); assert(reads > before);
});

test('100,000 support bones and ghost poses validate in linear work with bounded cooperative checkpoints', () => {
  const count = 100000, support = {version: 1, bones: [], vertices: {'0': -1, '7': count - 1}, path: [], rotation: 0};
  let reads = 0;
  for (let index = 0; index < count; index++) {
    const value = bone(index === count - 1 ? 7 : null, index - 1);
    Object.defineProperty(value, 'parent', {enumerable: true, get() {reads++; return index - 1;}});
    support.bones.push(value); support.path.push({bone: count - index - 1, sign: index % 2 ? -1 : 1});
  }
  const figure = {segments: [{segment_id: 7, parent_id: 0}], _styk: {animationOrigin: {handleId: 0, rotationHandleId: null, reversed: false, support}}};
  const {result, progress} = finish(validateOriginSupportSteps(figure, undefined, {sliceMs: 0}));
  assert.equal(result.ghostCount, count - 1); assert(progress.length > 1000);
  assert(reads <= count * 3, `Parent reads should be linear, observed ${reads}.`);
  for (let i = 1; i < progress.length; i++) assert.equal(progress[i].checked - progress[i - 1].checked, 128);
  const ghosts = Object.fromEntries(Array.from({length: count - 1}, (_, index) => [index, {angle_rad: .1, bend_rad: .2, length: 30}]));
  const pose = {_stykAnimationOrigin: {x: 0, y: 0, ghosts}}, before = reads;
  const output = finish(validateOriginObjectSteps(pose, figure, {sliceMs: 0}));
  assert.equal(output.result, pose); assert(output.progress.length > 1000); assert.equal(reads, before);
  for (let i = 1; i < output.progress.length; i++) assert.equal(output.progress[i].checked - output.progress[i - 1].checked, 128);
});

test('cancelled support iteration does not publish partial cached topology or mutate the descriptor', () => {
  const source = fixture();
  for (let i = 0; i < 500; i++) source.support.bones.push(bone(null));
  const before = clone(source), iterator = validateOriginSupportSteps(source.figure, undefined, {sliceMs: 0});
  assert.equal(iterator.next().done, false); iterator.return(); assert.deepEqual(source, before);
  source.support.bones.at(-1).parent = source.support.bones.length - 1;
  assert.throws(() => validateOriginObject(source.pose, source.figure), /cycle/);
});
