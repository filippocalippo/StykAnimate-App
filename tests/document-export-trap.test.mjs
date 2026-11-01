// A save cut off in the middle of the engine (a trap: the `unreachable` of a panic, an out-of-bounds access) runs no destructor, so the
// memory its save had reserved stays reserved and every later save and edit is refused ("not enough memory"). The save names its
// reservation and the page gives it back, on the path a trap really takes: the worker's own catch answers `ok: false`, `error` never fires.
import assert from 'node:assert/strict';
import test from 'node:test';
import {DocumentExporter} from '../src/document-export.mjs';
import {createDemo} from '../src/demo.mjs';
import {registeredEngine} from '../src/engine/engine-open.mjs';
import {snapshotDocument} from '../src/engine/engine-owner.mjs';
import {makeProjectFile} from '../src/engine/engine-document-export.mjs';
import {FakeCodecHost} from './support/codec-host.mjs';
import {useExportWorker} from './support/export-worker.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

/** An `unreachable` instruction in a real module: the error a trap throws. */
const TRAP = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 116, 114, 97, 112, 0, 0, 10, 5, 1, 3, 0, 0, 11]);
const trap = new WebAssembly.Instance(new WebAssembly.Module(TRAP)).exports.trap;

test('a save cut off by a trap gives its memory back, and the person reads the plain message', {timeout: 30000}, async t => {
  useExportWorker(t, './trapping-export-worker.mjs');
  const engine = registeredEngine(), handle = engine.handle, released = [], real = handle.release_reservation.bind(handle);
  handle.release_reservation = token => { const bytes = real(token); released.push(bytes); return bytes; };
  t.after(() => { delete handle.release_reservation; });
  const before = engine.memory().reservedBytes;
  const exporter = new DocumentExporter({codecHost: new FakeCodecHost(), idleMs: 0});
  t.after(() => exporter.dispose());
  const editor = ownedEditorFor({demo: false}, createDemo());
  await assert.rejects(exporter.export(editor.report), error => error.messageKey === 'errors.documentExport.theDocumentExportWorkerStopped'
    && !/unreachable/.test(error.message) && error.cause instanceof Error && /unreachable/.test(error.cause.message));
  assert.equal(released.length, 1);
  assert.ok(released[0] > 0, `the save was holding ${released[0]} bytes that the trap never gave back`);
  assert.equal(engine.memory().reservedBytes, before, 'nothing stays reserved');
  // And the next save, on a worker of its own, is not refused for lack of memory.
  useExportWorker(t);
  const next = await new DocumentExporter({codecHost: new FakeCodecHost(), idleMs: 0}).export(editor.report);
  assert.ok(next.size > 0);
  assert.equal(engine.memory().reservedBytes, before);
});

test('what comes out of a call into the engine is marked as a trap unless the engine reported it', async t => {
  const editor = ownedEditorFor({demo: false}, createDemo());
  // The engine's own refusal: a snapshot that is not there. Reported, so not a trap.
  const refused = (() => { try { makeProjectFile({join: null, cancelled: () => false, request: {snapshots: [987654321], scopes: []}}); } catch (error) { return error; } })();
  assert.equal(refused?.name, 'AbortError');
  assert.notEqual(refused?.trapped, true);
  // A real RuntimeError thrown through the engine's frames (from the clock, the second time WebAssembly asks it).
  const realNow = performance.now.bind(performance);
  let fromWasm = 0;
  performance.now = () => { if (new Error().stack.includes('wasm-function') && ++fromWasm === 2) trap(); return realNow(); };
  t.after(() => { performance.now = realNow; });
  let thrown;
  try { makeProjectFile({join: null, cancelled: () => false, request: {snapshots: [snapshotDocument(editor.report)], scopes: [], reservation: 4_100_777}}); } catch (error) { thrown = error; }
  performance.now = realNow;
  assert.ok(thrown instanceof WebAssembly.RuntimeError, String(thrown));
  assert.equal(thrown.trapped, true);
  const leaked = registeredEngine().handle.release_reservation(4_100_777);
  assert.ok(leaked > 0, 'the save was cut off holding its reservation');
  assert.equal(registeredEngine().handle.release_reservation(4_100_777), 0, 'and giving it back twice gives nothing back');
});
