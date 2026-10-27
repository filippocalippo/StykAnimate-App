import assert from 'node:assert/strict';
import test from 'node:test';
import {Worker as NodeWorker} from 'node:worker_threads';
import {randomBytes, createHash} from 'node:crypto';
import {DocumentExporter} from '../src/document-export.mjs';
import {decodeDocument, openDocument} from './support/native-files.mjs';
import {createDemo} from '../src/demo.mjs';
import {FakeCodecHost} from './support/codec-host.mjs';
import {ownedEditorFor} from './support/owned-editor.mjs';

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

test('a missing original source rejects native save without publishing a blob or cache', {timeout: 15000}, async t => {
  const service = sourceService(404), exporter = environment(t, {codecHost: service.codecHost, timeoutMs: 5000});
  const report = createDemo(), before = structuredClone(report);
  let published;
  await assert.rejects(async () => { published = await exporter.export(report, {sourceId: 'missing-original'}); },
    error => error.status === 404 && error.messageKey === 'errors.documentExportWorker.theOriginalSourceIsUnavailable');
  assert.equal(published, undefined);
  assert.deepEqual(service.calls, {source: 1, export: 0}, 'the native container is written locally; the codec only supplies the original');
  assert.equal(exporter.lastTimings, null);
  assert.equal(exporter.compressionCache.size, 0);
  assert.equal(exporter.worker, null);
  assert.deepEqual(report, before, 'a failed save preserves the live editable document');
});

test('a valid no-binary-source response still saves locally without an export service fallback', {timeout: 15000}, async t => {
  const service = sourceService(422), exporter = environment(t, {codecHost: service.codecHost, timeoutMs: 5000});
  const report = createDemo(), before = structuredClone(report);
  const output = await exporter.export(report, {sourceId: 'nonbinary-import'});
  assert.ok(output instanceof Blob && output.size > 0);
  const reopened = (await decodeDocument(new Uint8Array(await output.arrayBuffer()), 'styk')).document;
  assert.equal(reopened._stykSource, undefined);
  assert.equal(reopened.keyframes[0].objects[0].root_x, report.keyframes[0].objects[0].root_x);
  assert.deepEqual(service.calls, {source: 1, export: 0});
  assert.deepEqual(report, before);
});

test('real reused worker preserves bytes and detects same-identity numeric, media, and opaque edits', async t => {
  const exporter = environment(t), report = createDemo();
  report.opaque = {numeric: Array.from({length: 128}, (_, i) => i / 7), data_base64: randomBytes(70000).toString('base64'), untouched: {'__proto__': 'literal'}};
  report._stykSource = {source_base64: randomBytes(70000).toString('base64'), opaque: 'retain project provenance'};
  const original = structuredClone(report), first = await exporter.export(report);
  const firstBytes = new Uint8Array(await first.arrayBuffer());
  assert.equal(exporter.lastTimings.reused_worker, false);
  const second = await exporter.export(report);
  assert.equal(hash(new Uint8Array(await second.arrayBuffer())), hash(firstBytes));
  assert.equal(exporter.lastTimings.reused_worker, true); assert.ok(exporter.lastTimings.hits >= 3);
  assert.deepEqual(report, original, 'normalization and packing stay private to the worker');
  report.opaque.numeric[40] += .125;
  report.keyframes[0].objects[0].root_x += .25;
  const edited = await exporter.export(report);
  let reopened = (await decodeDocument(new Uint8Array(await edited.arrayBuffer()), 'styk')).document;
  assert.deepEqual(reopened.opaque, report.opaque);
  assert.deepEqual(reopened._stykSource, report._stykSource);
  assert.equal(reopened.keyframes[0].objects[0].root_x, report.keyframes[0].objects[0].root_x);
  assert.ok(exporter.lastTimings.hits >= 1, 'unchanged binary payload compression is reused after pose edits');
  report.opaque.data_base64 = randomBytes(70000).toString('base64');
  report.opaque.untouched.extra = 'selection-only metadata is still freshly snapshotted';
  const mediaEdited = await exporter.export(report);
  reopened = (await decodeDocument(new Uint8Array(await mediaEdited.arrayBuffer()), 'styk')).document;
  assert.deepEqual(reopened.opaque, report.opaque);
  assert.ok(exporter.lastTimings.misses >= 1);
  assert.ok(exporter.lastTimings.cacheBytes <= 64 * 1024 * 1024); assert.ok(exporter.lastTimings.cacheEntries <= 8);
});

test('fresh workers reuse verified compressed bytes without retaining editable snapshots', async t => {
  const exporter = environment(t, {workerByteBudget: 1}), report = createDemo();
  report.opaque = {numeric: Array.from({length: 128}, (_, i) => i / 7), data_base64: randomBytes(70000).toString('base64')};
  const first = await exporter.export(report);
  assert.equal(exporter.worker, null);
  const second = await exporter.export(report);
  assert.equal(hash(new Uint8Array(await second.arrayBuffer())), hash(new Uint8Array(await first.arrayBuffer())));
  assert.equal(exporter.lastTimings.reused_worker, false);
  assert.ok(exporter.lastTimings.hits >= 3); assert.equal(exporter.worker, null);
  report.opaque.numeric[40] += .125;
  report.keyframes[0].objects[0].root_x += .25;
  const edited = await exporter.export(report);
  const reopened = (await decodeDocument(new Uint8Array(await edited.arrayBuffer()), 'styk')).document;
  assert.deepEqual(reopened.opaque, report.opaque);
  assert.equal(reopened.keyframes[0].objects[0].root_x, report.keyframes[0].objects[0].root_x);
  assert.ok(exporter.lastTimings.misses >= 1);
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
