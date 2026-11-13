import assert from 'node:assert/strict';
import test from 'node:test';
import {askAdapterEarly} from '../src/engine/engine-adapter.mjs';

/** A stand-in for `navigator.gpu`: its method lives on the prototype, as the browser's does; `answer` is what a request resolves to. */
function standInGpu(answer) {
  const asked = [];
  class GPU { requestAdapter(options) { asked.push(options); return Promise.resolve(typeof answer === 'function' ? answer() : answer); } }
  return {gpu: new GPU(), asked};
}

test('the adapter asked for at the page\'s start answers the stage\'s first request, and only that one', async () => {
  const adapter = {info: {vendor: 'nvidia', architecture: 'lovelace', device: '', description: 'card'}};
  const {gpu, asked} = standInGpu(() => ({...adapter}));
  const described = askAdapterEarly(gpu);
  assert.equal(asked.length, 1, 'asked at once');
  assert.deepEqual(await described, {vendor: 'nvidia', architecture: 'lovelace', device: '', description: 'card'});
  // The engine's request (wgpu): the early answer, without asking the browser again.
  const first = await gpu.requestAdapter({powerPreference: 'high-performance'});
  assert.equal(first.info.description, 'card');
  assert.equal(asked.length, 1);
  // The browser's own method answers from then on (a stage after a lost device gets a new adapter).
  assert.equal(Object.hasOwn(gpu, 'requestAdapter'), false);
  const second = await gpu.requestAdapter({powerPreference: 'high-performance'});
  assert.notEqual(second, first);
  assert.equal(asked.length, 2);
});

test('a first request with other options is the browser\'s own', async () => {
  const {gpu, asked} = standInGpu(() => ({info: {}}));
  askAdapterEarly(gpu);
  await gpu.requestAdapter({powerPreference: 'low-power'});
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[1], {powerPreference: 'low-power'});
});

test('no adapter, a refused request and no WebGPU at all are told apart from an adapter', async () => {
  assert.equal(askAdapterEarly(undefined), null);
  assert.equal(askAdapterEarly({}), null);
  const none = standInGpu(null);
  assert.equal(await askAdapterEarly(none.gpu), null);
  assert.equal(await none.gpu.requestAdapter({powerPreference: 'high-performance'}), null);
  // A browser that throws or rejects gives no adapter: the engine draws with WebGL2.
  const throwing = {requestAdapter() { throw new Error('blocked'); }};
  assert.equal(await askAdapterEarly(throwing), null);
  const rejecting = {requestAdapter: () => Promise.reject(new Error('lost'))};
  assert.equal(await askAdapterEarly(rejecting), null);
  assert.equal(await rejecting.requestAdapter({powerPreference: 'high-performance'}), null);
  // The method the object had of its own is put back.
  assert.equal(typeof rejecting.requestAdapter, 'function');
  await assert.rejects(rejecting.requestAdapter({powerPreference: 'high-performance'}), /lost/);
});
