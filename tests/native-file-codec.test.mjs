/** StykAnimate's own files through the Rust container module (src/native-file-codec.mjs): lossless
 *  round trips, what the document rules do, corruption and limits, and the cache of compressed
 *  blocks. The Rust side has its own tests (engine/crates/styk-formats/tests/); these exercise
 *  the module the workers load, from JavaScript. Needs `node scripts/engine-build.mjs`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {buildContainerV2, decodeDocument, encodeContainerV2, openDocument, liftDocument} from './support/native-files.mjs';
import {buildContainerV1} from './support/container-v1.mjs';
import {nativeFileCodec} from '../src/native-file-codec.mjs';
import {createContainerCompressionCache} from '../src/container-cache.mjs';
import {bytesToBase64} from '../src/base64.mjs';

const floats = () => Array.from({length: 64}, (_, i) => Math.sin(i) * 180);
const text = value => new TextEncoder().encode(value);
const setU64 = (bytes, at, value) => new DataView(bytes.buffer, bytes.byteOffset).setBigUint64(at, BigInt(value), true);
const sectionTable = bytes => 60 + Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(16, true));
/** A project container written from a skeleton and sections as given, however damaged. */
const forged = (skeleton, arrays = new Uint8Array(), payloads = new Uint8Array(), kind = 'styk') =>
  encodeContainerV2({skeleton, sections: [{kind: 1, bytes: arrays}, {kind: 2, bytes: payloads}]}, kind);

test('sectioned metadata has a separate bound while payload and aggregate limits remain enforced', async () => {
  const bytes = await buildContainerV2({name: 'small'}, 'styk');
  for (const [version, raw, message] of [[1, 300 * 1024 * 1024, /uncompressed size/],
    [2, 385 * 1024 * 1024, /uncompressed size/], [2, 300 * 1024 * 1024, /invalid payload length/]]) {
    const malformed = bytes.slice();
    malformed[4] = version; setU64(malformed, 8, raw);
    if (version === 1) malformed[5] = 1;
    await assert.rejects(decodeDocument(malformed, 'styk'), message);
  }
});

test('zlib payloads must be complete, exact and alone', async () => {
  const payload = 'z'.repeat(1024 * 1024), file = buildContainerV1(payload, 'styk');
  // Not JSON, but it gets as far as the JSON parser: the container itself is sound.
  await assert.rejects(decodeDocument(file, 'styk'), error => error.messageKey === 'errors.nativeContainer.projectDataMustBeAJsonObject');
  const longer = file.slice(); setU64(longer, 8, 8192);
  await assert.rejects(decodeDocument(longer, 'styk'), /uncompressed size|invalid payload length/);
  const shorter = file.slice(); setU64(shorter, 8, payload.length + 1);
  await assert.rejects(decodeDocument(shorter, 'styk'), /invalid payload length/);
  const truncated = file.slice(0, file.length - 1); setU64(truncated, 16, file.length - 57);
  await assert.rejects(decodeDocument(truncated, 'styk'), /invalid payload length/);
  const stream = deflateSync(Buffer.from(payload)), twice = new Uint8Array(56 + stream.length * 2);
  twice.set(file.subarray(0, 56)); twice.set(stream, 56); twice.set(stream, 56 + stream.length); setU64(twice, 16, stream.length * 2);
  await assert.rejects(decodeDocument(twice, 'styk'), /invalid payload length/);
});

test('v2 rejects reserved fields, section kinds, codecs and unsafe lengths', async () => {
  const bytes = await buildContainerV2({a: floats()}, 'styk'), sectionOffset = sectionTable(bytes);
  for (const relative of [2, 4, 56, 63]) {
    const damaged = bytes.slice(); damaged[sectionOffset + relative] = 1;
    await assert.rejects(decodeDocument(damaged, 'styk'), /Unsupported/);
  }
  for (const [relative, value] of [[0, 3], [1, 3]]) {
    const damaged = bytes.slice(); damaged[sectionOffset + relative] = value;
    await assert.rejects(decodeDocument(damaged, 'styk'), /section kind|Unsupported/);
  }
  for (const relative of [8, 16]) {
    const damaged = bytes.slice(); setU64(damaged, sectionOffset + relative, 2n ** 63n);
    await assert.rejects(decodeDocument(damaged, 'styk'), /section table/);
  }
  await assert.rejects(decodeDocument(bytes.subarray(0, 56), 'styk'), /truncated/);
});

test('v2 rejects corruption, truncation, the wrong kind and markers that point nowhere', async () => {
  const container = await buildContainerV2({version: 5, keyframes: [{objects: [{angles: floats()}]}]}, 'styk');
  for (const mutate of [
    c => { const b = c.slice(); b[b.length - 3] ^= 0xff; return b; },   // payload bit
    c => { const b = c.slice(); b[30] ^= 0xff; return b; },             // skeleton digest
    c => c.subarray(0, c.length - 2),                                   // truncation
    c => new Uint8Array([...c, 0, 0]),                                  // trailing data
    c => { const b = c.slice(); b[4] = 9; return b; },                  // future version
  ]) await assert.rejects(decodeDocument(mutate(container), 'styk'));
  await assert.rejects(decodeDocument(container, 'stkz'), /does not match/);
  for (const marker of ['S2B:f64:0:8:64', 'S2B:f64:3:0:1', 'S2B:u8:0:0:99999', 'S2S:1:0:5', 'S2B:bad'])
    await assert.rejects(decodeDocument(await forged({a: marker}), 'styk'), /section reference|damaged/, marker);
  const nonFinite = new Uint8Array(new Float64Array([NaN, NaN, NaN, NaN]).buffer);
  await assert.rejects(decodeDocument(await forged({a: 'S2B:f64:0:0:4'}, nonFinite), 'styk'), /non-finite/);
  // The module is still usable after refusing files.
  assert.equal((await decodeDocument(container, 'styk')).version, 2);
});

test('v2 round-trips a document losslessly and shared arrays stay shared', async () => {
  const shared = floats();
  const doc = {
    version: 5, fps: 12, canvas: {width: 640, height: 480},
    keyframes: [{duration_raw: 2, objects: [
      {figure_type_id: 1, angles: shared, lengths: Array(64).fill(12.5),
        bends: Array.from({length: 40}, (_, i) => i - 20), uids: [0, 255, 65536, 4294967295],
        neg: [-5, -3, 7, -2147483648], join: {target_object_slot: 1}},
      {figure_type_id: 2, angles: shared},
    ]}],
    figure_types: [{figure_type_id: 1, segments: [{kind: 'line'}]}],
    _stykSource: {kind: 'piv', version: 5,
      source_base64: bytesToBase64(text('source bytes '.repeat(6000)))},
    media: [{name: 'a.png', data_url: 'data:image/png;base64,' + bytesToBase64(text('PNG'.repeat(50000)))}],
    title: 'S2B:looks like a marker', alt: 'S2E:also escaped',
  };
  const container = await buildContainerV2(doc, 'styk');
  assert.equal(new TextDecoder().decode(container.subarray(0, 4)), 'STYK');
  assert.equal(container[4], 2);
  const {document: out} = await decodeDocument(container, 'styk');
  assert.deepEqual(out, doc);
  // Lifted shared arrays keep one identity through the cycle.
  assert.equal(out.keyframes[0].objects[0].angles, out.keyframes[0].objects[1].angles);
  // A project opened and saved unchanged is the same bytes.
  assert.deepEqual(await buildContainerV2(out, 'styk'), container);
});

test('values the format moves keep their exact types, and values it does not move stay inline', async () => {
  const doc = {a: Array(40).fill(200), b: Array(40).fill(70000), c: Array(40).fill(-7), d: Array(40).fill(5e9), e: Array(40).fill(1.5),
    mixed: [1, 'two', 3].concat(Array(40).fill(0)).slice(0, 43), small: [1, 2, 3], nested: {list: [[1.5, 2.5], [3.5]]},
    bools: Array(40).fill(true), objects: Array(40).fill({x: 1}), huge: Array(40).fill(2 ** 53 + 1),
    proto: JSON.parse('{"__proto__":{"x":7}}'),
    styk_tiles: 'data:application/x-styk-tiles;base64,' + bytesToBase64(new Uint8Array(80000)), literal: 'S2B:f64:0:0:3'};
  const out = (await decodeDocument(await buildContainerV2(doc, 'styk'), 'styk')).document;
  assert.deepEqual(out, doc);
  assert.equal(Object.hasOwn(out.proto, '__proto__'), true);
  const nonfinite = {values: Array(40).fill(Infinity), x: NaN, y: -Infinity, z: -0};
  assert.deepEqual((await decodeDocument(await encodeContainerV2(liftDocument(nonfinite), 'styk'), 'styk')).document,
    JSON.parse(JSON.stringify(nonfinite)));
});

test('version 1 and plain JSON projects stay readable, and a marker-like string in them is only a string', async () => {
  const doc = {version: 5, keyframes: [{objects: []}], marker: 'S2B:0:0:0:5', escaped: 'S2E:x'};
  const v1 = buildContainerV1(JSON.stringify(doc), 'styk');
  const out = await decodeDocument(v1, 'styk');
  assert.equal(out.version, 1);
  assert.deepEqual(out.document, doc); // v1 never scans markers
  const legacy = await decodeDocument(text('  {"version":5,"keyframes":[]}'), 'styk');
  assert.deepEqual([legacy.version, legacy.document.version], [0, 5]);
  const bom = await decodeDocument(new Uint8Array([0xef, 0xbb, 0xbf, ...text('{"version":6}')]), 'styk');
  assert.equal(bom.document.version, 6);
  // JavaScript keeps a surrogate without its pair, and so does opening a file.
  const lone = await decodeDocument(text('{"name":"a\\ud800b"}'), 'styk');
  assert.equal(lone.document.name, 'a\ud800b');
});

test('opening applies the document rules like the file service: wrapper, figure shape, browser fields, source', async () => {
  const inner = {version: 5, keyframes: [], editable_paths: {}, _codec: {}, _stykWeb: {}};
  const wrapped = text(JSON.stringify({format: 'stykanimate', version: 1, document: inner}));
  assert.deepEqual(await openDocument(wrapped, 'styk'), {version: 5, keyframes: []});
  assert.equal((await decodeDocument(wrapped, 'styk')).document.format, 'stykanimate', 'the container as stored is not normalized');
  const unchanged = {version: 5, keyframes: [], editable_paths: {}};
  assert.deepEqual(await openDocument(text(JSON.stringify(unchanged)), 'styk'), {version: 5, keyframes: []});
  await assert.rejects(openDocument(text(JSON.stringify({format: 'stykanimate', version: 2, document: {}})), 'styk'), /project version/);
  await assert.rejects(openDocument(buildContainerV1('[1,2]', 'styk'), 'styk'), /JSON object/);
  const figure = {figure_types: [{figure_type_id: 1}], keyframes: [{objects: [{figure_type_id: 1, join: {target_object_slot: 0}}]}]};
  // Figure files that no writer would produce are opened from version 1 containers.
  const legacyFigure = (document, kind) => buildContainerV1(JSON.stringify(document), kind);
  assert.equal((await openDocument(await buildContainerV2(figure, 'stkz'), 'stkz')).figure_types.length, 1);
  await assert.rejects(openDocument(legacyFigure({figure_types: [], keyframes: []}, 'stkz'), 'stkz'), /reusable figures/);
  await assert.rejects(openDocument(legacyFigure({...figure, keyframes: [{objects: [{figure_type_id: 9}]}]}, 'stkz'), 'stkz'), /self-contained/);
  await assert.rejects(openDocument(legacyFigure(figure, 'stykmov'), 'stykmov'), /one movieclip/);
  assert.equal((await decodeDocument(legacyFigure({figure_types: [], keyframes: []}, 'stkz'), 'stkz')).version, 1, 'the container as stored is not checked');
  // The embedded original source is checked against its fingerprint.
  const source = text('original'), good = {_stykSource: {sha256: '0c0f4b8eb4a1a0b5a6e1a0c1c5c8cb8eb5d4c1f3b3d9e8c9ee10c5d3b4a8e5c5', source_base64: source}};
  await assert.rejects(openDocument(await buildContainerV2(good, 'styk', {preBlobs: [source]}), 'styk'), /fingerprint/);
  const file = await buildContainerV2(good, 'styk', {preBlobs: [source]});
  assert.equal((await openDocument(file, 'styk', {verifySource: false}))._stykSource.source_base64, bytesToBase64(source));
});

test('saving a figure file refuses what is not a self-contained figure, naming its kind', async () => {
  await assert.rejects(buildContainerV2({figure_types: [], keyframes: []}, 'stkz'), error =>
    error.code === 'invalid_native_figure' && error.messageParams.kind === 'stkz' && /reusable figures/.test(error.message));
  const figure = {figure_types: [{figure_type_id: 1}], keyframes: [{objects: [{figure_type_id: 1}]}]};
  await assert.rejects(buildContainerV2(figure, 'stykmov'), error => error.code === 'invalid_movieclip');
  await assert.rejects(buildContainerV2({...figure, backgrounds: [{}]}, 'stkz'), error => error.code === 'invalid_native_figure' && /self-contained/.test(error.message));
  assert.ok((await buildContainerV2(figure, 'stkz')).length > 56);
  assert.ok((await buildContainerV2({figure_types: [], keyframes: []}, 'styk')).length > 56, 'a project is not a figure file');
});

test('reserved binary source fields round trip, and an edited source is compressed again', async () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const document = {_stykSource: {source_base64: bytes}, media: {data_base64: bytes}, foreign: bytes,
    literal: 'S2E:literal', zero: {source_base64: new Uint8Array()}};
  const empty = document.zero.source_base64;
  const lifted = liftDocument(document, {preBlobs: [bytes, empty]});
  const cache = createContainerCompressionCache();
  const first = (await decodeDocument(await encodeContainerV2(lifted, 'styk', {cache}), 'styk')).document;
  assert.equal(first._stykSource.source_base64, bytesToBase64(bytes));
  assert.equal(first.media.data_base64, first._stykSource.source_base64);
  assert.equal(first.zero.source_base64, ''); assert.equal(first.literal, document.literal);
  assert.deepEqual(first.foreign, {'0': 0, '1': 1, '2': 2, '3': 255});
  bytes[0] = 77;
  const stats = {}, updated = await encodeContainerV2(liftDocument(document, {preBlobs: [bytes, empty]}), 'styk', {cache, stats});
  assert.equal((await decodeDocument(updated, 'styk')).document._stykSource.source_base64, bytesToBase64(bytes));
  assert.ok(stats.misses > 0);
});

test('compressed blocks are reused for the same bytes, bounded, and never alias a caller', async () => {
  const a = floats(), document = {a, alias: a, independent: a.slice(), data_base64: bytesToBase64(new Uint8Array(80000))};
  const cache = createContainerCompressionCache({maxBytes: 1024 * 1024, maxEntries: 8});
  const firstStats = {}, first = await encodeContainerV2(liftDocument(document), 'styk', {cache, stats: firstStats});
  const firstBytes = first.slice();
  assert.equal(firstStats.misses, 3); assert.equal(firstStats.hits, 0);
  const lifted = liftDocument(document);
  assert.equal(firstStats.container_raw_bytes, text(JSON.stringify(lifted.skeleton)).length +
    lifted.sections.reduce((sum, section) => sum + section.bytes.length, 0));
  assert.equal(firstStats.cacheEntries, 3); assert.equal(firstStats.cacheBytes, cache.byteLength);
  // A caller owns what it is given; changing it cannot corrupt the cache.
  first.fill(0);
  const secondStats = {}, second = await encodeContainerV2(liftDocument(document), 'styk', {cache, stats: secondStats});
  assert.equal(secondStats.hits, 3); assert.equal(secondStats.misses, 0);
  assert.equal(secondStats.rawBytesReused, secondStats.container_raw_bytes);
  assert.deepEqual(second, firstBytes);
  assert.deepEqual(await encodeContainerV2(liftDocument(document), 'styk', {cache}), firstBytes);
  // Blocks move to a new cache, as a retiring worker hands them over.
  const held = cache.byteLength, restored = createContainerCompressionCache({maxBytes: 1024 * 1024, maxEntries: 8});
  const taken = cache.take();
  assert.equal(cache.size, 0); assert.equal(cache.byteLength, 0);
  restored.restore(structuredClone(taken));
  taken.length = 0; // Caller-owned metadata cannot alter retained blocks.
  const restoredStats = {};
  assert.deepEqual(await encodeContainerV2(liftDocument(document), 'styk', {cache: restored, stats: restoredStats}), firstBytes);
  assert.equal(restoredStats.hits, 3); assert.equal(restored.byteLength, held);
  const decoded = (await decodeDocument(firstBytes, 'styk')).document;
  assert.equal(decoded.a, decoded.alias); assert.notEqual(decoded.a, decoded.independent);
  decoded.a[0] = 999; assert.notEqual(decoded.independent[0], 999);
  document.a[0] = 1.25;
  const changedStats = {}, changed = await encodeContainerV2(liftDocument(document), 'styk', {cache: restored, stats: changedStats});
  assert.equal(changedStats.hits, 2); assert.equal(changedStats.misses, 1);
  assert.deepEqual((await decodeDocument(changed, 'styk')).document, document);
  // A cache that holds nothing still writes the file.
  const tiny = createContainerCompressionCache({maxBytes: 20, maxEntries: 1});
  assert.deepEqual(await encodeContainerV2(liftDocument({...document, a, alias: a}), 'styk', {cache: tiny}),
    await encodeContainerV2(liftDocument({...document, a, alias: a}), 'styk'));
  assert.ok(tiny.byteLength <= 20); assert.ok(tiny.size <= 1);
});

test('the cache of compressed blocks keeps the most recent within its bounds and checks what it is given', () => {
  const bounded = createContainerCompressionCache({maxBytes: 20, maxEntries: 2});
  const block = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  bounded.put('a', block); block[0] = 9;
  assert.equal(bounded.get('a')[0], 1, 'put keeps a copy');
  bounded.put('b', new Uint8Array(8));
  bounded.get('a'); bounded.put('c', new Uint8Array(8));
  assert.equal(bounded.get('b'), undefined); assert.ok(bounded.get('a')); assert.ok(bounded.get('c'));
  bounded.put('oversized', new Uint8Array(21)); assert.equal(bounded.get('oversized'), undefined);
  assert.equal(bounded.byteLength, 16); assert.equal(bounded.size, 2);
  bounded.clear(); assert.equal(bounded.byteLength, 0); assert.equal(bounded.size, 0);
  const key = length => `2:3:${length}:${'0'.repeat(64)}`;
  bounded.restore([{key: key(3), bytes: new Uint8Array(8)}, {key: key(4), bytes: new Uint8Array(8)}, {key: key(5), bytes: new Uint8Array(8)}]);
  assert.equal(bounded.size, 2); assert.equal(bounded.byteLength, 16); assert.equal(bounded.get(key(3)), undefined);
  for (const invalid of [null, {}, {key: 'wrong', bytes: new Uint8Array()}, {key: key(1), bytes: new Blob()},
    {key: `1:default:1:${'0'.repeat(64)}`, bytes: new Uint8Array()}, {key: key(500000000), bytes: new Uint8Array()},
    {key: 'x'.repeat(200), bytes: new Uint8Array()}, {key: key(1), bytes: new Uint8Array(21)}]) {
    bounded.restore([invalid]); assert.equal(bounded.size, 0); assert.equal(bounded.byteLength, 0);
  }
  bounded.restore({}); assert.equal(bounded.size, 0);
  assert.throws(() => createContainerCompressionCache({maxBytes: -1}), RangeError);
});

test('the module the workers load opens and saves through its own instance', async () => {
  const doc = {version: 5, angles: floats(), keyframes: [{objects: [{angles: floats()}]}]};
  const file = await nativeFileCodec.save(liftDocument(doc), 'styk');
  const opened = await nativeFileCodec.open(file, 'styk');
  assert.deepEqual([opened.version, opened.document], [2, doc]);
  assert.ok(opened.materializedBytes > file.length);
  await assert.rejects(nativeFileCodec.open(file, 'neither'), /type does not match|Unsupported/);
  assert.deepEqual((await nativeFileCodec.open(file.buffer.slice(file.byteOffset, file.byteOffset + file.length), 'styk')).document, doc, 'an ArrayBuffer opens too');
});
