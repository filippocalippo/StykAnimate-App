import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {declaredMemoryPages} from '../src/engine/engine-memory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
const name = text => [text.length, ...Buffer.from(text)];
const section = (id, body) => [id, body.length, ...body];

test('the engine memory starts at the pages the module declares', () => {
  // (type (func)) (import "a" "f" (func)) (import "a" "g" (global i32)) (import "env" "memory" (memory 26 32768 shared))
  const module = Uint8Array.from([...HEADER,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(2, [3, ...name('a'), ...name('f'), 0, 0, ...name('a'), ...name('g'), 3, 0x7f, 0, ...name('env'), ...name('memory'), 2, 3, 26, 0x80, 0x80, 0x02])]);
  assert.equal(WebAssembly.validate(module, {}), true);
  assert.equal(declaredMemoryPages(module), 26);
  // A view into a larger buffer (a Node Buffer from a pool) and a plain ArrayBuffer read the same.
  const padded = new Uint8Array(module.length + 7);
  padded.set(module, 7);
  assert.equal(declaredMemoryPages(padded.subarray(7)), 26);
  assert.equal(declaredMemoryPages(module.buffer), 26);
});

test('a memory of more than 127 pages and a module without one', () => {
  const large = Uint8Array.from([...HEADER, ...section(2, [1, ...name('env'), ...name('memory'), 2, 0, 0xac, 0x02])]);
  assert.equal(declaredMemoryPages(large), 300);
  assert.throws(() => declaredMemoryPages(Uint8Array.from([...HEADER, ...section(1, [1, 0x60, 0, 0])])), /does not import its memory/);
});

test('the built engine module declares what its generated loader would create', {skip: !existsSync(path.join(root, 'src/engine/pkg/styk_engine_bg.wasm'))}, () => {
  const pkg = path.join(root, 'src/engine/pkg');
  const generated = /new WebAssembly\.Memory\(\{initial:(\d+),/.exec(readFileSync(path.join(pkg, 'styk_engine.js'), 'utf8'));
  assert.ok(generated, 'the generated loader names the initial size');
  assert.equal(declaredMemoryPages(readFileSync(path.join(pkg, 'styk_engine_bg.wasm'))), Number(generated[1]));
});

// A module that runs out of memory aborts and is gone for good: it refuses the work it cannot hold instead.
// The limit is the module's own (the page sets it from the memory it reserved): another handle on the module
// lowers it for a test and raises it again.
const {engineBuilt, nodeEngine, sessionFromDocument} = await import('./support/engine-node.mjs');
const {openJson, openBytes} = await import('../src/engine/engine-open.mjs');
const MIB = 1024 * 1024;
const startup = () => JSON.parse(readFileSync(path.join(root, 'engine/tests/edit/startup.document.json'), 'utf8'));
const STATE = {propertyChannels: true, layerTimeline: true, tick: 0, frameIndex: 0, layerRevision: 1, nextFrameIdentity: 2, nextUid: 2};

async function withLimit(bytes, run) {
  const {engine} = await nodeEngine();
  const Handle = engine.handle.constructor;
  new Handle(undefined, bytes).free();
  try { return await run(engine); } finally { new Handle(undefined, engine.memoryMaximumBytes).free(); }
}

test('the engine reports where its memory is', {skip: !engineBuilt}, async () => {
  const {engine} = await nodeEngine();
  const memory = engine.memory();
  assert.ok(memory.liveBytes > 0 && memory.liveBytes <= memory.heapBytes, JSON.stringify(memory));
  assert.ok(memory.peakBytes >= memory.liveBytes);
  assert.equal(memory.ceilingBytes, engine.memoryMaximumBytes - engine.memoryMaximumBytes / 16, 'large requests stop a sixteenth short of the memory the page reserved');
  assert.equal(memory.picturesRefused, 0);
});

test('an open the memory cannot hold is refused with a message, and the engine opens the next document', {skip: !engineBuilt}, async () => {
  await withLimit(64 * MIB, async engine => {
    for (const open of [() => openJson(startup(), 'Untitled', {engine}), () => openBytes(new TextEncoder().encode(JSON.stringify(startup())), 'x.styk', {engine})]) {
      const refusal = await open().then(() => null, error => error);
      assert.ok(refusal, 'the open is refused');
      assert.equal(refusal.messageKey, 'errors.engine.outOfMemory');
      assert.equal(refusal.telemetryCode, 'out_of_memory');
    }
  });
  const {engine} = await nodeEngine();
  const opening = await openJson(startup(), 'Untitled', {engine});
  assert.equal(opening.name, 'Untitled', 'once the memory is there the same document opens');
  opening.dispose();
});

test('an editing call the memory cannot hold is refused as an error, and the session edits on afterwards', {skip: !engineBuilt}, async () => {
  const session = await sessionFromDocument(startup(), STATE, 1);
  try {
    const before = session.report_json();
    await withLimit(64 * MIB, async () => {
      const answer = JSON.parse(session.call('select', JSON.stringify([1, -1]), JSON.stringify({tick: 0})));
      assert.deepEqual(answer, {status: 'error', error: 'errors.engine.outOfMemory'});
      assert.equal(session.report_json(), before, 'a refused call changes nothing');
    });
    const answer = JSON.parse(session.call('select', JSON.stringify([1, -1]), JSON.stringify({tick: 0})));
    assert.notEqual(answer.error, 'errors.engine.outOfMemory');
  } finally { session.free(); }
});

test('an undo or a redo asks the memory for more than an edit does', {skip: !engineBuilt}, async () => {
  const session = await sessionFromDocument(startup(), STATE, 1);
  try {
    const view = JSON.stringify({tick: 0});
    await withLimit(200 * MIB, async () => {
      const edit = JSON.parse(session.call('select', JSON.stringify([1, -1]), view));
      assert.equal(edit.status, 'ok', 'an edit needs 64 MiB, which 200 MiB has');
      for (const method of ['undo', 'redo']) {
        assert.deepEqual(JSON.parse(session.call(method, '[]', view)), {status: 'error', error: 'errors.engine.outOfMemory'}, `${method} needs 256 MiB, which 200 MiB lacks`);
      }
    });
    assert.notEqual(JSON.parse(session.call('undo', '[]', view)).error, 'errors.engine.outOfMemory');
  } finally { session.free(); }
});
