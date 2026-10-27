import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TelemetryService, endpoint } from '../desktop/telemetry.cjs';
import { TelemetryAccumulator } from '../src/telemetry-core.mjs';
import { validateSnapshot, sanitizeError, sanitizeEnvironment, percentile, POLICY_VERSION, emptyHistogram, observe } from '../src/telemetry-schema.mjs';
const schemaPath = path.resolve('src/telemetry-schema.mjs');
const consent = { analytics: true, diagnostics: true };
async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'styk-telemetry-'));
  const requests = [], fetchImpl = async (url, init) => { requests.push({ url, ...init }); return new Response('{}', { status: 200 }); };
  const service = await new TelemetryService({ directory, schemaPath, version: '0.3.0', siteUrl: 'https://stykanimate.example', fetchImpl, ...options }).init({ timers: false });
  return { directory, requests, service };
}
test('no identity, measurements or requests before consent, or after decline', async () => {
  const { service, requests } = await fixture();
  service.count('open'); service.error('TypeError', 'app'); await service.upload({ force: true });
  assert.equal(requests.length, 0); assert.equal(service.state.token, undefined); assert.deepEqual(service.preview().snapshots, []);
  await service.setConsent({ analytics: false, diagnostics: false }); service.count('open'); await service.upload({ force: true });
  assert.equal(requests.length, 0); assert.equal(service.getState().decided, true); assert.deepEqual(service.preview().snapshots, []);
});
test('separate consent gates survive privileged boundary and category withdrawal', async () => {
  const { service } = await fixture();
  await service.setConsent({ analytics: true, diagnostics: false });
  const acc = new TelemetryAccumulator(); acc.configure(consent); acc.count('open'); acc.timing('save_ms', 24); acc.error(new TypeError('SECRET'));
  service.record({ epoch: service.epoch, data: acc.drain() });
  let report = service.preview().snapshots[0]; assert.equal(report.counters.open, 1); assert.deepEqual(report.timings, {}); assert.deepEqual(report.errors, []);
  await service.setConsent({ analytics: false, diagnostics: true });
  acc.count('open'); acc.count('renderer_crashes'); acc.timing('save_ms', 24);
  service.record({ epoch: service.epoch, data: acc.drain(), environment: { mode: 'advanced', locale: 'it' } });
  report = service.preview().snapshots[0]; assert.equal(report.counters.open, undefined); assert.equal(report.counters.renderer_crashes, 1); assert.equal(report.timings.save_ms.count, 1); assert.deepEqual(report.milestones, {});
  assert.equal(validateSnapshot(report).environment.mode, 'unknown');
});
test('the graphics backends of the engine are reported by name', () => {
  for (const backend of ['webgpu', 'webgl2', 'unavailable']) assert.equal(sanitizeEnvironment({ backend }).backend, backend);
  assert.equal(sanitizeEnvironment({ backend: 'WebGL2' }).backend, 'unknown');
});
test('strict payload sanitization, finite histogram counts and redacted error context', async () => {
  const { service } = await fixture(); await service.setConsent(consent);
  const error = sanitizeError({ name: 'TypeError', message: 'secret document', stack: 'TypeError: secret\n at f (C:\\Users\\secret\\project\\src\\app.mjs:45:2)\n at https://private.example/secret/file.js:3:2' });
  assert.ok(!JSON.stringify(error).includes('secret')); assert.deepEqual(error.frames, [{ module: 'app.mjs', line: 45 }]);
  service.record({ epoch: service.epoch, data: { errors: [error], filename: 'secret', arbitrary: 'no' } });
  const snapshot = service.preview().snapshots[0]; assert.ok(!JSON.stringify(snapshot).includes('secret'));
  assert.throws(() => validateSnapshot({ ...snapshot, counters: { private_document_name: 1 } }));
  assert.throws(() => validateSnapshot({ ...snapshot, timings: { frame_ms: { count: 1, sum: 1, max: 1, buckets: [1] } } }));
  assert.throws(() => validateSnapshot({ ...snapshot, gauges: { js_heap_mb: Infinity } }));
  const h = emptyHistogram(); [1, 4, 12, 90].forEach(n => observe(h, n)); assert.equal(percentile(h, .5), 4); assert.equal(percentile(h, .95), 90);
});
test('uploads are cumulative, bounded and throttled; sequence survives opt-out and restart', async () => {
  let now = Date.now(); const { service, directory, requests } = await fixture({ now: () => now });
  await service.setConsent(consent); service.count('open', 2); await service.upload(); await service.upload(); assert.equal(requests.length, 1);
  const first = JSON.parse(requests[0].body); assert.equal(first.counters.open, 2);
  const oldEpoch = service.epoch; await service.setConsent({ analytics: false, diagnostics: false });
  assert.equal(service.record({ epoch: oldEpoch, data: { counters: { open: 100 } } }), false);
  await service.setConsent(consent); service.count('open'); now += 20 * 60000; await service.upload();
  const second = JSON.parse(requests[1].body); assert.equal(second.installationId, first.installationId); assert.ok(second.sequence > first.sequence);
  assert.equal(second.counters.open, 3, 'acknowledged activity is not lost after same-day re-opt-in');
  await service.close();
  const restored = await new TelemetryService({ directory, schemaPath, version: '0.3.0', siteUrl: 'https://stykanimate.example', now: () => now }).init({ timers: false });
  assert.ok(restored.preview().snapshots[0].sequence > second.sequence); assert.equal(restored.getState().consent.analytics, true); assert.equal(restored.preview().snapshots[0].counters.unclean_starts, undefined);
});
test('delete removes local data, queues an offline request, survives restart and excludes private tokens from preview', async () => {
  const { service, directory } = await fixture({ fetchImpl: async () => { throw new Error('offline'); } });
  await service.setConsent(consent); const token = service.state.token;
  assert.ok(!JSON.stringify(service.preview()).includes(token));
  await service.deleteData(); assert.equal(service.getState().deletionPending, true); assert.deepEqual(service.preview().snapshots, []); assert.equal(service.state.token, null);
  const requests = [];
  const restored = await new TelemetryService({ directory, schemaPath, version: '0.3.0', siteUrl: 'https://stykanimate.example', fetchImpl: async (url, init) => { requests.push({url, ...init}); return new Response('{}'); } }).init({ timers: false });
  await restored.upload({ force: true }); assert.equal(requests.length, 1); assert.equal(requests[0].method, 'DELETE'); assert.equal(requests[0].headers.Authorization, 'Bearer ' + token); assert.equal(restored.getState().deletionPending, false);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'telemetry-state.json'), 'utf8')).deletions.length, 0);
});
test('unchanged and idle-only reports do not use hosting requests; new activity carries deferred idle time', async () => {
  let now = Date.now(); const { service, requests } = await fixture({ now: () => now });
  await service.setConsent(consent); await service.upload();
  const sequence = service.preview().snapshots[0].sequence;
  assert.equal(service.record({ epoch: service.epoch, data: {} }), false);
  assert.equal(service.preview().snapshots[0].sequence, sequence);
  now += 20 * 60000; await service.upload(); assert.equal(requests.length, 1);
  service.count('idle_seconds', 1200); await service.upload(); assert.equal(requests.length, 1);
  service.count('edits'); await service.upload(); assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[1].body).counters.idle_seconds, 1200);
  now += 86400000;
  assert.equal(service.record({ epoch: service.epoch, data: { counters: { idle_seconds: 15 } } }), false);
  assert.equal(service.preview().snapshots.some(value => value.day === new Date(now).toISOString().slice(0, 10)), false);
});
test('local checkpoints persist only when telemetry state changed', async () => {
  const { service } = await fixture();
  assert.equal(service.unsaved, false);
  await service.setConsent(consent);
  assert.equal(service.unsaved, false, 'explicit consent persistence already covers the change');
  service.count('open');
  assert.equal(service.unsaved, true);
  await service.persist();
  assert.equal(service.unsaved, false);
  assert.equal(service.record({ epoch: service.epoch + 1, data: { counters: { open: 1 } } }), false);
  assert.equal(service.unsaved, false, 'a rejected delta leaves nothing to persist');
  service.count('open');
  const set = service.store.set.bind(service.store);
  service.store.set = () => Promise.reject(new Error('disk full'));
  await assert.rejects(service.persist());
  assert.equal(service.unsaved, true, 'a failed checkpoint is retried on the next interval');
  service.store.set = set;
  await service.persist();
  assert.equal(service.unsaved, false);
});
test('first-observed milestones survive longer than the offline queue', async () => {
  let now = Date.now(); const { service, directory } = await fixture({ now: () => now });
  await service.setConsent(consent); service.milestone('first_save');
  const firstSave = service.preview().snapshots[0].milestones.first_save; await service.close();
  now += 10 * 86400000;
  const restored = await new TelemetryService({ directory, schemaPath, version: '0.3.0', now: () => now }).init({ timers: false });
  assert.equal(restored.preview().snapshots[0].milestones.first_save, firstSave);
});
test('feedback is explicit, works without telemetry consent, keeps a deletion identity', async () => {
  const { service, requests } = await fixture(); await service.feedback({ category: 'idea', message: 'Make timeline labels larger.' });
  assert.equal(requests.length, 1); assert.match(requests[0].url, /feedback$/); assert.equal(service.getState().consent.analytics, false); assert.equal(service.preview().snapshots.length, 0); assert.ok(service.state.token);
  assert.equal(endpoint(Symbol('bad')), '');
});
test('only HTTPS or explicit local development endpoints are accepted', () => {
  assert.equal(endpoint('http://example.com'), ''); assert.equal(endpoint('http://127.0.0.1:9000', true), 'http://127.0.0.1:9000');
  assert.equal(endpoint('https://name:password@example.com'), ''); assert.equal(endpoint('https://example.com/?secret=a'), '');
});
test('retired policy versions never silently restore consent', async () => {
  const { service, directory } = await fixture(); await service.setConsent(consent); service.state.consent.policyVersion = '2000-01-01'; await service.persist();
  const restored = await new TelemetryService({ directory, schemaPath, version: '0.3.0' }).init({ timers: false });
  assert.equal(restored.getState().decided, false); assert.equal(restored.getState().consent.analytics, false); assert.deepEqual(restored.preview().snapshots, []); assert.equal(restored.getState().consent.policyVersion, POLICY_VERSION);
});
