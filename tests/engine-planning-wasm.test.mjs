// The planning jobs through the real WebAssembly module (npm run engine:build), in Node:
// the request and poll boundary of styk-wasm (JSON request in, bounded packets out, errors by
// name), not only the Rust planners the cargo tests compare. Node has no engine worker threads,
// so the test pumps the engine's queue itself (the app refuses such a host: D7).
import {readFileSync, readdirSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Editor} from '../src/editor.mjs';
import {applyDocumentChunk} from '../src/document-transport.mjs';
import {engineBuilt, nodeEngine} from './support/engine-node.mjs';
import {openingSession} from '../src/engine/engine-owner.mjs';
import {planEngineInbetweens, planEngineLayerMigration, isUnported} from '../src/engine/engine-planning.mjs';

const skip = engineBuilt ? false : 'the engine is not built (npm run engine:build)';
const nativeJson = value => JSON.stringify(value, (key, item) => key === 'runtime_segments' ? undefined : item);
const read = path => JSON.parse(readFileSync(new URL(`../engine/tests/${path}.json`, import.meta.url), 'utf8'));

/** The engine holding `reference`'s document, as the app's session leaves it at `revision`. */
async function engineHolding(reference, options, revision = 5) {
  const {engine} = await nodeEngine();
  const editor = new Editor({demo: false, ...options}).load(JSON.parse(reference.document));
  const session = openingSession(editor);
  session.activate(revision);
  assert.equal(engine.handle.revision(), revision, 'the engine holds the document');
  return {engine, revision, session};
}
/** Runs a job to its end: every packet acknowledged, progress kept. */
async function drive(engine, job) {
  let payload; const progress = [];
  try {
    for (let spins = 0; spins < 200_000; spins++) {
      engine.pump();
      const text = job.take();
      if (text === undefined || text === null) { await new Promise(resolve => setTimeout(resolve, 0)); continue; }
      const packet = JSON.parse(text);
      if (packet.progress) progress.push(packet.progress);
      if (packet.chunk) { payload = applyDocumentChunk(payload, packet.chunk); assert.equal(job.ack(packet.sequence), true); }
      if (packet.done) return {payload, progress};
    }
    throw new Error('The planning job did not finish.');
  } finally { job.cancel(); engine.pump(); job.free(); engine.pump(); }
}
const failure = async action => { try { await action(); } catch (error) { return error; } assert.fail('expected a planning failure'); };

const inbetweens = readdirSync(new URL('../engine/tests/inbetween/', import.meta.url)).map(file => file.replace(/\.json$/, '')).sort();
for (const name of inbetweens) test(`the engine module plans the in-between fixture: ${name}`, {skip}, async () => {
  const reference = read(`inbetween/${name}`), {engine, revision} = await engineHolding(reference);
  const start = () => engine.handle.plan_inbetweens(revision, JSON.stringify(reference.request));
  if (reference.failure) {
    const error = await failure(async () => { const job = start(); await drive(engine, job); });
    assert.equal(error.message, reference.failure.messageKey); assert.equal(error.name, 'Error');
    return;
  }
  const {payload, progress} = await drive(engine, start());
  assert.equal(nativeJson(payload.plan), nativeJson(reference.payload.plan));
  // The mailbox keeps the latest progress: a plan that finishes before the first poll reports its last phase.
  assert.ok(progress.length >= 1);
  assert.ok(progress.every(step => Object.keys(step).sort().join() === 'completed,phase,total' && ['sampling', 'sampling animation', 'animation'].includes(step.phase)));
  const last = progress.at(-1);
  assert.equal(last.completed, last.total);
  assert.equal(last.phase, name.startsWith('authored-') ? 'animation' : 'sampling');
  if (!name.startsWith('authored-')) assert.equal(last.total, reference.request.indices.length);
});

test('the engine module refuses what it does not plan by name, and a stale revision as aborted', {skip}, async () => {
  const sheet = read('layer-sheet-migration/combined'), {engine, revision} = await engineHolding(sheet, {layerTimeline: true, propertyChannels: false});
  const unported = await failure(async () => { await drive(engine, engine.handle.plan_inbetweens(revision, JSON.stringify({ratio: .5, indices: [1], nextFrameIdentity: 99}))); });
  assert.equal(unported.name, 'EngineUnported'); assert.match(unported.message, /layer sheet/);
  const stale = await failure(async () => engine.handle.plan_inbetweens(revision + 1, JSON.stringify({ratio: .5, indices: [1], nextFrameIdentity: 99})));
  assert.equal(stale.name, 'AbortError');
  for (const bad of ['{}', '{"ratio":.5,"indices":[-1],"nextFrameIdentity":1}', '{"ratio":.5,"indices":[1],"nextFrameIdentity":0}'])
    assert.equal((await failure(async () => engine.handle.plan_inbetweens(revision, bad))).name, 'Error');
});

for (const name of ['native-only', 'independent', 'joined-scalars', 'delete-default', 'dense-single-figure']) test(`the engine module plans the layer move: ${name}`, {skip}, async () => {
  const reference = read(`layer-migration/${name}`), {engine, revision} = await engineHolding(reference);
  const {payload, progress} = await drive(engine, engine.handle.plan_layers(revision, JSON.stringify(reference.request)));
  assert.equal(nativeJson(payload), nativeJson(reference.payload));
  for (const step of progress) assert.deepEqual(Object.keys(step).sort(), ['completed', 'objectPoses', 'phase', 'segmentValues', 'sourceFrames', 'total']);
});
test('the engine module plans a layer move on a layer sheet and words a refusal by its key', {skip}, async () => {
  const combined = read('layer-sheet-migration/combined'), options = {layerTimeline: true, propertyChannels: false};
  const {engine, revision} = await engineHolding(combined, options);
  const {payload} = await drive(engine, engine.handle.plan_layers(revision, JSON.stringify(combined.request)));
  assert.equal(nativeJson(payload), nativeJson(combined.payload));
  const missing = read('layer-sheet-migration/missing-layer'), held = await engineHolding(missing, options);
  const error = await failure(async () => { await drive(held.engine, held.engine.handle.plan_layers(held.revision, JSON.stringify(missing.request))); });
  assert.equal(error.message, missing.failure.messageKey);
});

// The adapter the app runs, over the real module: the engine's own pump (whenProgress) stands in for the worker threads.
const driven = engine => ({...engine, threaded: true, workers: 1});
for (const name of inbetweens) test(`the adapter plans the in-between fixture through the engine module: ${name}`, {skip}, async () => {
  const reference = read(`inbetween/${name}`), {engine, revision} = await engineHolding(reference), progress = [];
  const run = planEngineInbetweens(driven(engine), revision, reference.request, {onProgress: step => progress.push(step)});
  if (reference.failure) {
    const error = await failure(() => run);
    assert.equal(error.messageKey, reference.failure.messageKey); assert.equal(error.message, reference.failure.message);
    return;
  }
  assert.equal(nativeJson(await run), nativeJson(reference.payload.plan));
  assert.ok(progress.length >= 1);
});
test('the adapter reads a plan the engine does not make as unported, and a layer move as the editor words it', {skip}, async () => {
  const sheet = read('layer-sheet-migration/combined'), options = {layerTimeline: true, propertyChannels: false};
  const {engine, revision} = await engineHolding(sheet, options);
  assert.ok(isUnported(await failure(() => planEngineInbetweens(driven(engine), revision, {ratio: .5, indices: [1], nextFrameIdentity: 99}))));
  assert.equal(nativeJson(await planEngineLayerMigration(driven(engine), revision, sheet.request)), nativeJson(sheet.payload.plan));
  const missing = read('layer-sheet-migration/missing-layer'), held = await engineHolding(missing, options);
  const error = await failure(() => planEngineLayerMigration(driven(held.engine), held.revision, missing.request));
  assert.equal(error.messageKey, missing.failure.messageKey);
  const stale = await failure(() => planEngineInbetweens(driven(engine), revision + 1, {ratio: .5, indices: [1], nextFrameIdentity: 99}));
  assert.equal(stale.name, 'AbortError'); assert.match(stale.message, /animation changed/);
});
