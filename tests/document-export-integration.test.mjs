import assert from 'node:assert/strict';
import test from 'node:test';
import {Worker as NodeWorker} from 'node:worker_threads';
import {randomBytes, createHash} from 'node:crypto';
import {DocumentExporter} from '../src/document-export.mjs';
import {decodeDocument, openDocument} from './support/native-files.mjs';
import {createDemo} from '../src/demo.mjs';
import {FakeCodecHost} from './support/codec-host.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';
import {snapshotDocument} from '../src/engine/engine-owner.mjs';
import {makeProjectFile} from '../src/engine/engine-document-export.mjs';

class WorkerFacade extends EventTarget {
  constructor() {
    super();
    this.worker = new NodeWorker(new URL('./document-export-node-worker.mjs', import.meta.url), {execArgv: []});
    this.worker.on('message', data => { const event = new Event('message'); event.data = data; this.dispatchEvent(event); });
    this.worker.on('error', error => { const event = new Event('error', {cancelable: true}); event.message = error.message; this.dispatchEvent(event); });
    this.worker.on('messageerror', () => this.dispatchEvent(new Event('messageerror')));
  }
  postMessage(value, transfer) { this.worker.postMessage(value, transfer); }
  terminate() { void this.worker.terminate(); }
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function environment(t, {codecHost = new FakeCodecHost(), ...options} = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', {value: WorkerFacade, configurable: true});
  const exporter = new DocumentExporter({codecHost, idleMs: 1000, ...options});
  t.after(() => {
    exporter.dispose(); codecHost.close();
    if (previous) Object.defineProperty(globalThis, 'Worker', previous); else delete globalThis.Worker;
  });
  return exporter;
}

/** The codec answering a save whose original is gone (404) or was never binary (422). */
function sourceService(sourceStatus) {
  const calls = {source: 0, export: 0};
  const codecHost = new FakeCodecHost(request => {
    const path = request.path.split('?')[0];
    if (request.method === 'GET' && path === '/api/source') {
      calls.source++;
      return {status: sourceStatus, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code: sourceStatus === 422 ? 'no_source' : 'not_found'})};
    }
    if (request.method === 'POST' && path === '/api/export') {
      calls.export++;
      return {status: 410, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code: 'source_expired', error: {message: 'The original source is unavailable.'}})};
    }
    return {status: 404};
  });
  return {codecHost, calls};
}

/** The document the engine owns, from which a `.styk` save is written. */
const project = (document = createDemo()) => ownedEditorFor({demo: false}, document);

test('a missing original source rejects native save without publishing a blob', {timeout: 15000}, async t => {
  const service = sourceService(404), exporter = environment(t, {codecHost: service.codecHost, timeoutMs: 5000});
  const editor = project(), before = structuredClone(editor.report);
  let published;
  await assert.rejects(async () => { published = await exporter.export(editor.report, {sourceId: 'missing-original'}); },
    error => error.status === 404 && error.messageKey === 'errors.documentExportWorker.theOriginalSourceIsUnavailable');
  assert.equal(published, undefined);
  assert.deepEqual(service.calls, {source: 1, export: 0}, 'the native container is written locally; the codec only supplies the original');
  assert.equal(exporter.lastTimings, null);
  assert.equal(exporter.worker, null);
  assert.deepEqual(editor.report, before, 'a failed save preserves the live editable document');
});

test('a valid no-binary-source response still saves locally without an export service fallback', {timeout: 15000}, async t => {
  const service = sourceService(422), exporter = environment(t, {codecHost: service.codecHost, timeoutMs: 5000});
  const editor = project(), before = structuredClone(editor.report);
  const output = await exporter.export(editor.report, {sourceId: 'nonbinary-import'});
  assert.ok(output instanceof Blob && output.size > 0);
  const reopened = (await decodeDocument(new Uint8Array(await output.arrayBuffer()), 'styk')).document;
  assert.equal(reopened._stykSource, undefined);
  assert.equal(reopened.keyframes[0].objects[0].root_x, editor.report.keyframes[0].objects[0].root_x);
  assert.deepEqual(service.calls, {source: 1, export: 0});
  assert.deepEqual(editor.report, before);
});

test('the Pivot original the codec holds is stored first and the save is written by the engine, not from the document the interface reads', {timeout: 15000}, async t => {
  const original = randomBytes(70000), digest = hash(original);
  const codecHost = new FakeCodecHost(request => {
    if (request.path.split('?')[0] !== '/api/source') return {status: 404};
    const metadata = new TextEncoder().encode(JSON.stringify({kind: 'piv', version: 5, sha256: digest, document_sha256: 'a'.repeat(64), document_digest_version: 3}));
    const record = new Uint8Array(12 + metadata.length + original.length);
    record.set(new TextEncoder().encode('STYKSRC1')); new DataView(record.buffer).setUint32(8, metadata.length, true);
    record.set(metadata, 12); record.set(original, 12 + metadata.length);
    return {status: 200, headers: {'Content-Type': 'application/octet-stream'}, body: record.buffer};
  });
  const exporter = environment(t, {codecHost}), editor = project();
  const output = await exporter.export(editor.report, {sourceId: 'a-pivot-project', name: 'From Pivot'});
  const reopened = await openDocument(new Uint8Array(await output.arrayBuffer()), 'styk');
  assert.equal(reopened._styk.name, 'From Pivot');
  assert.equal(hash(Buffer.from(reopened._stykSource.source_base64, 'base64')), digest);
  assert.equal(reopened._stykSource.kind, 'piv');
});

test('a reused worker saves the same bytes again, and edits, unknown fields and pictures reopen as they were', async t => {
  const exporter = environment(t), document = createDemo();
  document.opaque = {numeric: Array.from({length: 128}, (_, i) => i / 7), data_base64: randomBytes(70000).toString('base64'), untouched: {'__proto__': 'literal'}};
  const editor = project(document), original = structuredClone(editor.report), first = await exporter.export(editor.report);
  const firstBytes = new Uint8Array(await first.arrayBuffer());
  assert.equal(exporter.lastTimings.reused_worker, false);
  const second = await exporter.export(editor.report);
  assert.equal(hash(new Uint8Array(await second.arrayBuffer())), hash(firstBytes), 'the same document saves to the same bytes');
  assert.equal(exporter.lastTimings.reused_worker, true);
  assert.deepEqual(editor.report, original, 'saving changes nothing of the document');
  editor.setCanvasSize(editor.report.canvas_width + 5, editor.report.canvas_height);
  const edited = await exporter.export(editor.report);
  const reopened = (await decodeDocument(new Uint8Array(await edited.arrayBuffer()), 'styk')).document;
  assert.deepEqual(reopened.opaque, document.opaque);
  assert.equal(reopened.canvas_width, original.canvas_width + 5);
  assert.ok(exporter.lastTimings.container_raw_bytes > 70000);
});

test('the engine writes the document of the moment the snapshot was taken: an edit made after it is not in the file', async () => {
  const editor = project(), width = editor.report.canvas_width, token = snapshotDocument(editor.report);
  editor.setCanvasSize(width + 9, editor.report.canvas_height);
  const made = makeProjectFile({join: null, cancelled: () => false, request: {snapshots: [token], scopes: [], name: 'Moment'}});
  const reopened = (await decodeDocument(made.bytes, 'styk')).document;
  assert.equal(reopened.canvas_width, width, 'the session kept editing, and the snapshot did not follow it');
  assert.equal(editor.report.canvas_width, width + 9);
});

test('real portable movieclip worker packs keys, prunes archives, and leaves the project editable', async t => {
  const exporter = environment(t), report = createDemo();
  report._stykSource = {source_base64: randomBytes(131072).toString('base64')};
  const editor = ownedEditorFor({demo: false, layerTimeline: true}, report);
  const uid = editor.report.keyframes[0].objects[0].figure_uid;
  editor.select(uid);
  const clip = editor.createMovieclip({start: 0, end: 1, name: 'Portable clip'});
  assert.ok(clip, 'movieclip creation succeeds');
  const figure = editor.report.figure_types.find(figure => figure._styk?.movieclip);
  const before = structuredClone(editor.report);
  const output = await exporter.export(editor.report, {format: 'stykmov', figureTypeId: figure.figure_type_id, revision: editor.revision});
  const reopened = await openDocument(new Uint8Array(await output.arrayBuffer()), 'stykmov', {verifySource: false});
  assert.equal(reopened.figure_types[0]._styk.movieclip.document._stykSource, undefined);
  assert.equal(reopened.figure_types[0]._styk.movieclip.document._styk?.movieclipSource?.document?._stykSource, undefined);
  assert.deepEqual(editor.report, before);
  assert.ok(output.size < 20000);
});
