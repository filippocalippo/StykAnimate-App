/** StykAnimate's own files through the Rust container module (src/native-file-codec.mjs): lossless
 *  round trips, what the document rules do, and corruption and limits. The Rust side has its own tests (engine/crates/styk-formats/tests/); these exercise
 *  the module the workers load, from JavaScript. Needs `node scripts/engine-build.mjs`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {buildContainerV2, decodeDocument, openDocument} from './support/native-files.mjs';
import {buildContainerV1} from './support/container-v1.mjs';
import {forgeContainerV2} from './support/container-v2.mjs';
import {nativeFileCodec} from '../src/native-file-codec.mjs';
import {bytesToBase64} from '../src/base64.mjs';

const floats = () => Array.from({length: 64}, (_, i) => Math.sin(i) * 180);
const text = value => new TextEncoder().encode(value);
const setU64 = (bytes, at, value) => new DataView(bytes.buffer, bytes.byteOffset).setBigUint64(at, BigInt(value), true);
const sectionTable = bytes => 60 + Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(16, true));
/** A project container written from a skeleton and sections as given, however damaged. */
const forged = (skeleton, arrays = new Uint8Array(), payloads = new Uint8Array(), kind = 'styk') =>
  forgeContainerV2({skeleton, arrays, payloads, kind});

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

test('v2 round-trips a document losslessly, and an array the file names twice is read as one', async () => {
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
  // The two poses name the same list of angles: the container stores it once, whoever wrote it.
  const twice = await forged({keyframes: [{objects: [{angles: 'S2B:f64:0:0:64'}, {angles: 'S2B:f64:0:0:64'}]}]}, new Uint8Array(new Float64Array(floats()).buffer));
  const {document: pair} = await decodeDocument(twice, 'styk');
  assert.equal(pair.keyframes[0].objects[0].angles, pair.keyframes[0].objects[1].angles);
  const {document: out} = await decodeDocument(container, 'styk');
  assert.deepEqual(out, doc);
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
  assert.deepEqual((await decodeDocument(await buildContainerV2(nonfinite, 'styk'), 'styk')).document,
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
  const source = text('original'), good = {_stykSource: {sha256: '0c0f4b8eb4a1a0b5a6e1a0c1c5c8cb8eb5d4c1f3b3d9e8c9ee10c5d3b4a8e5c5', source_base64: bytesToBase64(source)}};
  await assert.rejects(openDocument(await buildContainerV2(good, 'styk'), 'styk'), /fingerprint/);
  const file = await buildContainerV2(good, 'styk');
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

test('the module the workers load opens and saves through its own instance', async () => {
  const doc = {version: 5, angles: floats(), keyframes: [{objects: [{angles: floats()}]}]};
  const file = await nativeFileCodec.save(doc, 'styk');
  const opened = await nativeFileCodec.open(file, 'styk');
  assert.deepEqual([opened.version, opened.document], [2, doc]);
  assert.ok(opened.materializedBytes > file.length);
  await assert.rejects(nativeFileCodec.open(file, 'neither'), /type does not match|Unsupported/);
  assert.deepEqual((await nativeFileCodec.open(file.buffer.slice(file.byteOffset, file.byteOffset + file.length), 'styk')).document, doc, 'an ArrayBuffer opens too');
});
