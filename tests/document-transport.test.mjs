import assert from 'node:assert/strict';
import test from 'node:test';
import { documentChunks, applyDocumentChunk } from '../src/document-transport.mjs';
import { createDemo } from '../src/demo.mjs';

test('batched transport retains every native and opaque field without numeric conversion', () => {
  const original = createDemo(); original._stykSource = { source_base64: 'opaque encoded original bytes', untouched: [1, 'x', { flags: 0xffffffff }] };
  original.figure_types[0].segments[0].record_offset = 123456; original.figure_types[0].segments[0].extra_unknown = { nested: ['preserve', 1 / 3] };
  original.keyframes[0].objects[0].angles[0] = 1 / 7;
  const chunks = [...documentChunks(original, 2)]; let result;
  for (const chunk of chunks) result = applyDocumentChunk(result, structuredClone(chunk));
  assert.deepEqual(result, original); assert.equal(JSON.stringify(result), JSON.stringify(original));
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) if (chunk.operations) assert.ok(chunk.operations.length <= 2);
});

test('large strings, embedded source, opaque nested fields and figure arrays obey a byte budget', () => {
  const document = createDemo(); document._stykSource = { source_base64: 'abcdef0123456789'.repeat(50000) };
  document.figure_types[0].side_tables = [{ nested: { data_url: 'opaque glyph and bitmap'.repeat(40000), extra: [1 / 3, -0, 0xffffffff] } }];
  const chunks = [...documentChunks(document, { maxBytes: 32 * 1024, maxRecords: 30 })]; let result;
  for (const chunk of chunks) { assert.ok(!chunk.estimatedBytes || chunk.estimatedBytes <= 32 * 1024); result = applyDocumentChunk(result, structuredClone(chunk)); }
  assert.deepEqual(result, document); assert.ok(chunks.some(chunk => chunk.operations?.some(operation => Object.hasOwn(operation, 'append'))));
});

test('opaque __proto__ keys stay own data properties without changing prototypes', () => {
  const original = JSON.parse('{"version":5,"nested":{"__proto__":{"untouched":true}},"__proto__":"native field"}');
  let result; for (const chunk of documentChunks(original)) result = applyDocumentChunk(result, structuredClone(chunk));
  assert.deepEqual(result, original); assert.equal(Object.getPrototypeOf(result), Object.prototype); assert.equal({}.untouched, undefined);
});

test('optional native fields stay absent and malformed/out-of-order batches fail', () => {
  const original = { version: 5, figure_types: [], keyframes: [], opaque: null };
  let result; for (const chunk of documentChunks(original)) result = applyDocumentChunk(result, structuredClone(chunk));
  assert.deepEqual(result, original); assert.equal(Object.hasOwn(result, 'backgrounds'), false);
  assert.throws(() => applyDocumentChunk(result, { table: '__proto__', values: [], offset: 0 }), /Invalid/);
  assert.throws(() => applyDocumentChunk(result, { table: 'keyframes', values: [], offset: 1 }), /out of order/);
  assert.throws(() => [...documentChunks(original, 0)], /positive integer/);
});

test('long numeric arrays travel in bounded slices instead of one operation per value', () => {
  const original = createDemo(), positions = Array.from({length: 60000}, (_, i) => i / 7 - 3000);
  original.figure_types[0]._styk = {spatialMesh: {positions, weights: positions.map(v => v > 0 ? 1 : 0)}};
  let result, operations = 0;
  for (const chunk of documentChunks(original, {maxBytes: 64 * 1024})) {
    operations += chunk.operations?.length ?? 0;
    assert.ok((chunk.estimatedBytes ?? 0) <= 64 * 1024);
    result = applyDocumentChunk(result, structuredClone(chunk));
  }
  assert.deepEqual(result, original);
  assert.ok(operations < 200, `${operations} operations`);
  assert.throws(() => applyDocumentChunk({}, {operations: [{path: ['missing'], extend: [1]}]}), /out of order/);
});
