/** Lifting a document into its JSON skeleton and byte sections, and restoring it: the form the
 *  engine mirror stages records in and the document export worker hands to the Rust container
 *  writer (src/document-lift.mjs). The container itself is tests/native-file-codec.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {liftDocument, liftDocumentSteps, restoreLifted} from '../src/document-lift.mjs';
import {bytesToBase64} from '../src/base64.mjs';

const floats = () => Array.from({length: 64}, (_, i) => Math.sin(i) * 180);

// Canonical worker-side manifests, created before the interface owns a stream.
function liftManifest(document) {
  const manifest = new WeakMap(), seen = new WeakSet(), pending = [document];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const keys = Object.keys(value);
    if (!Array.isArray(value)) manifest.set(value, keys);
    for (const key of keys) pending.push(value[key]);
  }
  return manifest;
}

// This collector models the worker receiver, which alone assembles whole sections.
function collectLiftStream(document, options = {}) {
  const iterator = liftDocumentSteps(document, {stream: true, keyManifest: liftManifest(document), ...options});
  const text = [], fragments = [[], []];
  let checkpoints = 0, step;
  for (;;) {
    step = iterator.next();
    if (step.done) break;
    if (step.value === null) { checkpoints++; continue; }
    const chunk = step.value;
    if (chunk.kind === 'skeleton') {
      assert.ok(new TextEncoder().encode(chunk.text).byteLength <= 32768);
      text.push(chunk.text);
    } else {
      assert.ok(chunk.bytes.byteLength <= 16384);
      fragments[chunk.section].push(chunk);
    }
  }
  const sections = step.value.sectionLengths.map((length, index) => {
    const bytes = new Uint8Array(length);
    for (const chunk of fragments[index]) bytes.set(chunk.bytes, chunk.offset);
    return {kind: index + 1, bytes};
  });
  return {skeleton: JSON.parse(text.join('')), sections, metadata: step.value, checkpoints};
}

test('incremental lifting retains one exact skeleton, section alignment and shared markers', () => {
  const numbers = Array.from({length: 5000}, (_, i) => i * .125), source = bytesToBase64(new Uint8Array(100000).fill(31));
  const text = ('A\ud83d\ude42\ud800\n\\\"').repeat(10000);
  const document = {a: Array(33).fill(7), numbers, alias: numbers, text, marker: 'S2E:literal', omitted: undefined,
    holes: [, null, undefined], foreign: new Uint8Array([1, 2]), future: JSON.parse('{"__proto__":{"retained":true}}'),
    data_base64: source, nested: {source_base64: source, data_url: 'data:application/octet-stream;base64,' + source}};
  const expected = liftDocument(document), actual = collectLiftStream(document);
  assert.deepEqual(actual.skeleton, JSON.parse(JSON.stringify(expected.skeleton)));
  assert.deepEqual(actual.sections, expected.sections);
  assert.ok(actual.checkpoints > 100);
  assert.deepEqual(restoreLifted(actual.skeleton, actual.sections), JSON.parse(JSON.stringify(document)));
});

test('base64 fingerprint collisions never combine different payloads', () => {
  // These two canonical suffixes collide after the same 65536-character prefix.
  const prefix = 'A'.repeat(65536), first = prefix + 'cyMSrjhZ', second = prefix + 'j9I6GxIB';
  const document = {data_base64: first, nested: {source_base64: second}, alias: {data_base64: first}};
  const lifted = collectLiftStream(document);
  assert.notEqual(lifted.skeleton.data_base64, lifted.skeleton.nested.source_base64);
  assert.equal(lifted.skeleton.data_base64, lifted.skeleton.alias.data_base64);
  assert.deepEqual(restoreLifted(lifted.skeleton, lifted.sections), document);
});

test('unmanifested cold objects refuse before asking V8 for any own keys', () => {
  const document = Object.fromEntries(Array.from({length: 100000}, (_, index) => [`unknown-${index}`, index]));
  const keys = Object.keys;
  try {
    Object.keys = () => { throw new Error('unbounded enumeration'); };
    assert.throws(() => liftDocumentSteps(document, {stream: true}).next(), error => error.code === 'engine_keys_not_ready');
  } finally { Object.keys = keys; }
});

test('one dense native record yields inside segments, channels, strings and payloads', () => {
  const keys = Array.from({length: 100000}, (_, index) => ({id: index, tick: index, value: index * .125}));
  const document = {segments: Array.from({length: 100000}, (_, index) => ({id: index, parent: 0, angle: .5})),
    unknown: {channels: [{property: 'x', keys}], text: 'x'.repeat(100000), data_base64: bytesToBase64(new Uint8Array(100000).fill(17))}};
  const actual = collectLiftStream(document);
  assert.ok(actual.checkpoints > 200000);
  assert.equal(actual.skeleton.segments.length, 100000);
  assert.equal(actual.skeleton.unknown.channels[0].keys.length, 100000);
  assert.deepEqual(restoreLifted(actual.skeleton, actual.sections), document);
});

test('paired surrogates crossing a work boundary never skip string checkpoints', () => {
  const document = {text: 'x' + '\ud83d\ude42'.repeat(100000)};
  const lifted = collectLiftStream(document);
  assert.ok(lifted.checkpoints >= 90, 'the admission scan must yield within the astral string');
  assert.equal(lifted.skeleton.text, document.text);
});

test('a lift is refused by the limit it was given, and a stream reports the limit its receiver must admit', () => {
  // The receiver's own admission (a refusal that leaves the staged skeleton untouched) is the Rust lifted-record
  // reader's: engine/crates/styk-formats/tests/lifted_receiver.rs.
  const values = Array(33).fill(7), document = {arrays: Array(100).fill(values)};
  assert.throws(() => liftDocument(document, {maxBytes: 1024}), error => error.code === 'document_too_large');
  const lifted = collectLiftStream(document, {maxBytes: 1024});
  assert.equal(lifted.metadata.materializationLimit, 4096);
  assert.ok(lifted.metadata.materializedUpperBytes > lifted.metadata.materializationLimit);
});

test('restoring markers resolves every reference form and refuses damaged ones', () => {
  const bytes = new Uint8Array(60), marker = 'S2S:0:0:60';
  assert.equal(restoreLifted({a: marker}, [{kind: 2, bytes}]).a, bytesToBase64(bytes));
  assert.equal(restoreLifted({a: 'S2D:0:0:3:data:x;base64,'}, [{kind: 2, bytes: new Uint8Array([1, 2, 3])}]).a, 'data:x;base64,AQID');
  assert.equal(restoreLifted({a: 'S2E:S2B:literal'}, []).a, 'S2B:literal');
  assert.throws(() => restoreLifted({a: 'S2B:bad'}, []), /malformed section marker/);
  for (const damaged of ['S2B:u8:0:0:9007199254740993', 'S2B:u8:9007199254740993:0:0', 'S2S:0:9007199254740993:0'])
    assert.throws(() => restoreLifted({a: damaged}, [{kind: 1, bytes}]), /section reference/);
});

test('unaligned stored numeric ranges restore exact values and existing aliases', () => {
  const bytes = new Uint8Array(1 + 16), view = new DataView(bytes.buffer);
  view.setFloat64(1, .125, true); view.setFloat64(9, -1e300, true);
  const marker = 'S2B:f64:0:0:2';
  const out = restoreLifted({a: marker, b: marker}, [{kind: 1, bytes: bytes.subarray(1)}]);
  assert.deepEqual(out.a, [.125, -1e300]); assert.equal(out.a, out.b);
});

test('drawing payloads, literal markers and unknown metadata lift and restore losslessly', () => {
  const document = {styk_tiles: 'data:application/x-styk-tiles;base64,' + bytesToBase64(new Uint8Array(80000)),
    literal: 'S2B:f64:0:0:3', escaped: 'S2E:a', future: JSON.parse('{"__proto__":{"retained":true}}')};
  const lifted = liftDocument(document);
  assert.match(lifted.skeleton.styk_tiles, /^S2D:/);
  assert.deepEqual(restoreLifted(JSON.parse(JSON.stringify(lifted.skeleton)), lifted.sections), document);
});

test('writer rejects excess lifted data before allocating its sections', () => {
  assert.throws(() => liftDocument({a: floats()}, {maxBytes: 100}), error => error.code === 'document_too_large');
  assert.throws(() => liftDocument({}, {preBlobs: [new Uint8Array(101)], maxBytes: 100}), error => error.code === 'document_too_large');
  const encoded = bytesToBase64(new Uint8Array(50000));
  assert.throws(() => liftDocument({data_base64: encoded}, {maxBytes: 100}), error => error.code === 'document_too_large');
  // Noncanonical opaque fields remain inline; they are not decoded as blobs.
  assert.equal(liftDocument({data_base64: '=' + encoded.slice(1)}, {maxBytes: 20000}).skeleton.data_base64[0], '=');
});

test('numeric admission falls back to exact JSON costs near its limit', () => {
  // The finite-number bound exceeds 16 bytes, but the actual document fits.
  assert.doesNotThrow(() => liftDocument({x: 1.25}, {maxBytes: 4}));
  assert.throws(() => liftDocument({x: 1.1234567891234567}, {maxBytes: 4}),
    error => error.code === 'document_too_large');
  const numbers = [Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE,
    1e-7, -1e-7, 1e-6, -1e-6, 1e20, -1e20, 1e21, -1e21, Number.EPSILON, -0];
  for (const x of numbers) {
    const document = {x}, bytes = new TextEncoder().encode(JSON.stringify(document)).length;
    assert.doesNotThrow(() => liftDocument(document, {maxBytes: Math.ceil(bytes / 4)}));
    assert.throws(() => liftDocument(document, {maxBytes: Math.ceil(bytes / 4) - 1}),
      error => error.code === 'document_too_large');
  }
});

test('exact numeric fallback counts shared references and keeps allocation limits', () => {
  const shared = Array(32).fill(0);
  const document = {arr: Array(20).fill(shared)};
  assert.ok(JSON.stringify(document).length < 1600);
  const lifted = liftDocument(document, {maxBytes: 400});
  assert.equal(lifted.sections[0].bytes.length, 32);
  assert.equal(lifted.skeleton.arr[0], lifted.skeleton.arr[19]);
  assert.equal(document.arr[0], shared); assert.equal(shared[0], 0);
  const tooMany = {arr: Array(25).fill(shared)};
  assert.ok(JSON.stringify(tooMany).length > 1600);
  assert.throws(() => liftDocument(tooMany, {maxBytes: 400}), error => error.code === 'document_too_large');
  // The serialized text fits, while 48 bytes per numeric element plus the
  // unique raw section cannot fit. The estimate must not waive that limit.
  assert.throws(() => liftDocument({arr: shared}, {maxBytes: 391}), error => error.code === 'document_too_large');
});

test('numeric admission retains inline JSON null behavior', () => {
  const document = {x: NaN, y: 1};
  assert.equal(JSON.stringify(document).length, 16);
  assert.doesNotThrow(() => liftDocument(document, {maxBytes: 4}));
  assert.throws(() => liftDocument(document, {maxBytes: 3}), error => error.code === 'document_too_large');
  const nonfinite = {values: Array(40).fill(Infinity), x: NaN, y: -Infinity, z: -0};
  assert.ok(Array.isArray(liftDocument(nonfinite).skeleton.values));
});

test('reserved binary source fields admit every reference and preserve foreign typed arrays', () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const document = {_stykSource: {source_base64: bytes}, media: {data_base64: bytes}, foreign: bytes,
    literal: 'S2E:literal', zero: {source_base64: new Uint8Array()}};
  const empty = document.zero.source_base64;
  const lifted = liftDocument(document, {preBlobs: [bytes, empty]});
  assert.equal(lifted.skeleton._stykSource.source_base64, 'S2S:1:0:4');
  assert.equal(lifted.skeleton.media.data_base64, 'S2S:1:0:4');
  assert.equal(lifted.skeleton.zero.source_base64, 'S2S:1:4:0');
  assert.deepEqual(lifted.skeleton.foreign, {'0': 0, '1': 1, '2': 2, '3': 255});
  assert.deepEqual(liftDocument({source_base64: bytes}).skeleton, {source_base64: {'0': 0, '1': 1, '2': 2, '3': 255}});
  const many = new Uint8Array(100), repeated = {a: {source_base64: many}, b: {source_base64: many},
    c: {source_base64: many}, d: {source_base64: many}};
  assert.throws(() => liftDocument(repeated, {preBlobs: [many], maxBytes: 150}), error => error.code === 'document_too_large');
  assert.doesNotThrow(() => liftDocument({a: {source_base64: many}}, {preBlobs: [many], maxBytes: 150}));
});

test('integer arrays pick exact-width encodings and values the format does not move stay inline', () => {
  const doc = {a: Array(40).fill(200), b: Array(40).fill(70000),
    c: Array(40).fill(-7), d: Array(40).fill(5e9), e: Array(40).fill(1.5)};
  const {skeleton} = liftDocument(doc);
  assert.match(skeleton.a, /^S2B:u8:/);
  assert.match(skeleton.b, /^S2B:u32:/);
  assert.match(skeleton.c, /^S2B:i32:/);
  assert.match(skeleton.d, /^S2B:f64:/);  // 5e9 exceeds u32 but stays exact
  assert.match(skeleton.e, /^S2B:f32:/);  // 1.5 round-trips through f32
  const inline = {mixed: [1, 'two', 3].concat(Array(40).fill(0)).slice(0, 43), small: [1, 2, 3], nested: {list: [[1.5, 2.5], [3.5]]},
    bools: Array(40).fill(true), objects: Array(40).fill({x: 1}),
    // Integers at/above 2^53 are not all f64-exact; they must stay inline.
    huge: Array(40).fill(2 ** 53 + 1), proto: JSON.parse('{"__proto__":{"x":7}}')};
  const lifted = liftDocument(inline);
  assert.ok(Array.isArray(lifted.skeleton.huge));
  assert.deepEqual(restoreLifted(JSON.parse(JSON.stringify(lifted.skeleton)), lifted.sections), inline);
});
