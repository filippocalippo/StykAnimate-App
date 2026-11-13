// The desktop statistics service (desktop/stats.cjs, docs/STATISTICS.md): the queue, the migration from the old consent,
// on and off, the checks at the boundary, the upload policy and each answer of the intake, and how sessions end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { validateBatch, MAX_REPORTS } from '../src/stats/schema.mjs';

const require = createRequire(import.meta.url);
const { StatsService, machineFacts, statsEndpoint } = require('../desktop/stats.cjs');
const schemaPath = path.resolve('src/stats/schema.mjs');
const DAY = 86400000;
const START = Date.parse('2026-11-12T10:00:00Z'); // a Thursday
const utcDay = t => new Date(t).toISOString().slice(0, 10);

const summary = (extra = {}) => ({ minutes: 5, open: 7, language: 'en', mode: { simple: 5, advanced: 0 }, features: [], reached: ['edit'], counts: { edits: 3 }, ...extra });
const problem = (extra = {}) => ({ kind: 'problem', type: 'error', message: 'x is not a function', stack: ['app.mjs:12'], doing: 'unknown', trail: ['undo'], times: 1, ...extra });
const fileReport = (extra = {}) => ({ kind: 'file', op: 'save', format: 'styk', size: 'under-1mb', stage: 'unknown', reason: 'unknown', ms: 12, ...extra });

/** A fake intake: answers in order (the last one repeats) and records each request. */
function intake(...answers) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)] ?? { status: 200, body: { ok: true } };
    if (answer.throws) throw new TypeError('network down');
    return { status: answer.status, json: async () => answer.body ?? {}, headers: { get: name => answer.headers?.[name] ?? null } };
  };
  return { calls, fetch };
}

let folders = [], services = [];
let counter = 0;
async function folder() { const dir = await mkdtemp(path.join(os.tmpdir(), 'styk-stats-')); folders.push(dir); return dir; }
test.afterEach(async () => { await Promise.all(services.map(s => s.settled())); services = []; await Promise.all(folders.map(dir => rm(dir, { recursive: true, force: true }))); folders = []; });

// A file written through desktop/preferences.cjs is synced to disk (about 0.2 s each on Windows), so most tests keep the two files in
// memory; the tests that look at the files on disk (`disk: true`) use the real store. The memory store checks a value as the real
// one does (`serialize`), so what the real store would refuse fails here too.
const { WorkspacePreferences } = require('../desktop/preferences.cjs');
const memory = new Map();
const memoryStore = (dir, options) => ({
  get: async () => JSON.parse(memory.get(path.join(dir, options.filename)) ?? '{}'),
  set: async value => { memory.set(path.join(dir, options.filename), new WorkspacePreferences(dir, options).serialize(value)); return { saved: true }; },
});
async function service(dir, { clock = { t: START }, fetch = intake().fetch, disk = false, ...options } = {}) {
  const stats = new StatsService({ directory: dir, schemaPath, version: '1.2.6', channel: 'stable', siteUrl: 'https://stats.example', env: {},
    machine: { graphics: 'integrated', vendor: 'intel', memory: '8', cores: '8' }, fetchImpl: fetch, now: () => clock.t,
    randomHex: () => (++counter).toString(16).padStart(32, '0'), timers: false, ...(disk ? {} : { openStore: memoryStore }), localDay: utcDay,
    localWeekday: t => new Date(t).getUTCDay(), localHour: t => new Date(t).getUTCHours(), ...options });
  stats.clock = clock;
  services.push(stats);
  return stats.init();
}
const sessionFile = async dir => JSON.parse(await readFile(path.join(dir, 'stats-session.json'), 'utf8'));

test('the queue keeps at most 64 reports and nothing older than seven days', async () => {
  const dir = await folder(), stats = await service(dir, { disk: true });
  for (let i = 0; i < 65; i++) assert.equal(stats.recordReport(fileReport({ ms: i })), true);
  assert.equal(stats.queue.length, 64);
  assert.equal(stats.queue[0].ms, 1, 'the oldest report went');
  stats.clock.t += 8 * DAY;
  stats.recordReport(fileReport({ ms: 999 }));
  assert.deepEqual(stats.queue.map(r => r.ms), [999]);
  await stats.settled();
  assert.equal((await sessionFile(dir)).queue.length, 1);
});

test('the old consent decides the start: Reject starts off with the line seen, every other answer starts on', async () => {
  const cases = [
    [{ decided: true, consent: { analytics: false, diagnostics: false } }, { enabled: false, noticeSeen: true }],
    [{ decided: true, consent: { analytics: true, diagnostics: true }, milestones: { first_launch: '2026-10-01' } }, { enabled: true, noticeSeen: false }],
    [{ decided: true, consent: { analytics: false, diagnostics: true } }, { enabled: true, noticeSeen: false }],
    [{ decided: false, consent: {} }, { enabled: true, noticeSeen: false }],
    [null, { enabled: true, noticeSeen: false }],
  ];
  for (const [old, expected] of cases) {
    const dir = await folder();
    if (old) await writeFile(path.join(dir, 'telemetry-state.json'), JSON.stringify({ token: 'f'.repeat(64), ...old }));
    const stats = await service(dir);
    const state = stats.getState();
    assert.deepEqual({ enabled: state.enabled, noticeSeen: state.noticeSeen }, expected, JSON.stringify(old));
    assert.ok(!(await readdir(dir)).includes('telemetry-state.json'), 'the old file is deleted');
    assert.equal(stats.settings.firstDay, old?.milestones ? '2026-10-01' : expected.enabled ? '2026-11-12' : null);
  }
});

test('STYK_NO_STATS forces statistics off and writes nothing', async () => {
  const dir = await folder(), { calls, fetch } = intake();
  const stats = await service(dir, { env: { STYK_NO_STATS: '1' }, fetch, disk: true });
  assert.deepEqual(stats.getState(), { enabled: false, counting: false, forcedOff: true, noticeSeen: false, uploads: false });
  assert.equal(stats.recordReport(fileReport()), false);
  assert.equal(stats.recordSession(summary()), false);
  assert.deepEqual(await stats.setEnabled(true), stats.getState());
  await stats.markNoticeSeen(); await stats.upload(); await stats.close();
  assert.deepEqual(await readdir(dir), []);
  assert.equal(calls.length, 0);
});

test('turning statistics off deletes what was waiting; turning them on starts a new session', async () => {
  const dir = await folder(), stats = await service(dir, { disk: true }), changes = [];
  stats.onState = state => changes.push(state.enabled);
  stats.recordSession(summary()); stats.recordReport(fileReport());
  const sid = stats.running.sid;
  assert.equal((await stats.setEnabled(false)).enabled, false);
  assert.deepEqual(await sessionFile(dir), {});
  assert.deepEqual(stats.preview().waiting, []);
  assert.equal(stats.recordReport(fileReport()), false);
  await stats.setEnabled(true);
  assert.notEqual(stats.running.sid, sid);
  assert.deepEqual(changes, [false, true]);
  await assert.rejects(stats.setEnabled('yes'), TypeError);
});

test('everything is checked at the boundary: a refused summary or report changes nothing', async () => {
  const dir = await folder(), stats = await service(dir);
  assert.equal(stats.recordSession(summary({ name: 'my film' })), false, 'an unknown field');
  assert.equal(stats.recordSession(summary({ sid: 'b'.repeat(32) })), false, 'a field the service fills');
  assert.equal(stats.running.summary, null);
  assert.equal(stats.recordSession(summary()), true);
  assert.equal(stats.recordSession(summary({ minutes: -1 })), false);
  assert.equal(stats.running.summary.minutes, 5, 'the previous summary stays');
  assert.equal(stats.recordReport(problem({ message: 'cannot open "C:/Users/me/film.styk"' })), false, 'text the cleaning would change');
  assert.equal(stats.recordReport(fileReport({ format: 'mp3-of-my-band' })), false);
  assert.equal(stats.recordReport({ ...fileReport(), sid: 'a'.repeat(32) }), false);
  assert.equal(stats.queue.length, 0);
});

test('an upload sends batches of at most 16 that the intake accepts, with no header but the content type, never the running session', async () => {
  const dir = await folder(), { calls, fetch } = intake({ status: 200, body: { ok: true } });
  const stats = await service(dir, { fetch });
  stats.recordSession(summary());
  assert.equal(await stats.upload(), false);
  assert.equal(calls.length, 0, 'only the running session waits');
  stats.setFacts({ backend: 'webgpu', refresh: '144' });
  for (let i = 0; i < 20; i++) stats.recordReport(fileReport({ ms: i }));
  assert.equal(await stats.upload(), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://stats.example/api/v1/stats');
  assert.deepEqual(calls[0].options.headers, { 'Content-Type': 'application/json' });
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].body.reports.length, MAX_REPORTS);
  assert.deepEqual(validateBatch(calls[0].body, { today: '2026-11-12' }), calls[0].body);
  assert.deepEqual(calls[0].body.machine, { graphics: 'integrated', vendor: 'intel', backend: 'webgpu', memory: '8', cores: '8', refresh: '144' });
  assert.equal(calls[1].body.reports.length, 4);
  assert.equal(stats.queue.length, 0);
  assert.deepEqual(stats.preview().lastSent, calls[1].body);
  assert.ok(!calls.some(call => call.body.reports.some(r => r.kind === 'session')));
});

test('each answer of the intake: stored, refused, busy, paused, unreachable', async () => {
  const run = async (answer, check) => {
    const dir = await folder(), { calls, fetch } = intake(answer);
    const stats = await service(dir, { fetch });
    stats.recordReport(fileReport());
    await stats.upload();
    await check(stats, calls);
  };
  await run({ status: 200, body: { ok: true } }, stats => assert.equal(stats.queue.length, 0));
  for (const status of [400, 413, 422]) await run({ status }, stats => assert.equal(stats.queue.length, 0, `${status} drops the batch`));
  await run({ status: 429, headers: { 'Retry-After': '120' } }, async (stats, calls) => {
    assert.equal(stats.queue.length, 1);
    stats.clock.t += 119000; await stats.upload(); assert.equal(calls.length, 1, 'not before Retry-After');
    stats.clock.t += 2000; await stats.upload(); assert.equal(calls.length, 2);
  });
  await run({ status: 503 }, async (stats, calls) => {
    assert.equal(stats.queue.length, 1);
    stats.clock.t += 29 * 60000; await stats.upload(); assert.equal(calls.length, 1, 'retried after 30 minutes');
  });
  await run({ status: 410 }, async (stats, calls) => {
    assert.equal(stats.queue.length, 0);
    stats.recordReport(fileReport());
    stats.clock.t += DAY - 1000; await stats.upload(); assert.equal(calls.length, 1, 'paused for a day');
    stats.clock.t += 2000; await stats.upload(); assert.equal(calls.length, 2);
  });
  await run({ throws: true }, stats => assert.equal(stats.queue.length, 1));
  await run({ status: 200, body: { stored: 1 } }, stats => assert.equal(stats.queue.length, 1, 'a 200 without ok is not a delivery'));
});

test('a session ends clean on quit, crashed when the window is lost, and unknown when the next start finds it open', async () => {
  const dir = await folder(), { fetch } = intake({ status: 503 });
  const first = await service(dir, { fetch });
  first.recordSession(summary());
  first.noteUnsaved(true);
  const crashedSid = first.running.sid;
  first.windowGone('crashed');
  const [gone, crashed] = first.queue;
  assert.deepEqual([gone.type, gone.message, gone.sid], ['window-gone', 'crashed', crashedSid]);
  assert.deepEqual([crashed.kind, crashed.end, crashed.unsaved, crashed.sid], ['session', 'crashed', true, crashedSid]);
  assert.notEqual(first.running.sid, crashedSid);
  first.recordSession(summary({ minutes: 9 }));
  first.noteUnsaved(false);
  first.recordSession(summary({ minutes: 9 }));
  await first.settled();
  // The process ends without close(): power loss.
  const second = await service(dir, { fetch });
  const unknown = second.queue.find(r => r.kind === 'session' && r.end === 'unknown');
  assert.deepEqual([unknown.minutes, unknown.unsaved], [9, false]);
  second.recordSession(summary({ minutes: 2 }));
  second.noteUnsaved(true);
  await second.close();
  const clean = second.queue.find(r => r.end === 'clean');
  assert.equal(clean.minutes, 2);
  assert.equal('unsaved' in clean, false);
  const third = await service(dir, { fetch });
  assert.equal(third.queue.filter(r => r.kind === 'session').length, 3, 'a closed session is not ended twice');
});

test('the first facts come from the days of use kept on this computer', async () => {
  const dir = await folder(), clock = { t: START };
  const facts = async () => { const stats = await service(dir, { clock }); await stats.settled(); return stats.running.first; };
  assert.deepEqual(await facts(), { ever: true, day: true, week: true, back: false });
  assert.deepEqual(await facts(), { ever: false, day: false, week: false, back: false });
  clock.t += DAY; // Friday, same week
  assert.deepEqual(await facts(), { ever: false, day: true, week: false, back: false });
  clock.t += 4 * DAY; // Tuesday of the next week, five days after the first run
  assert.deepEqual(await facts(), { ever: false, day: true, week: true, back: false });
  clock.t += 3 * DAY; // eight days after the first run: back in the second week
  const stats = await service(dir, { clock });
  await stats.settled();
  assert.deepEqual(stats.running.first, { ever: false, day: true, week: false, back: true });
  assert.equal(stats.running.age, 'month');
  assert.deepEqual(stats.running.when, { weekday: 5, part: 'morning' });
  clock.t += DAY;
  assert.equal((await facts()).back, false, 'back is said once');
});

test('a problem is one report a session: a repeat raises its count while it waits, and it is never sent twice', async () => {
  const dir = await folder(), { calls, fetch } = intake({ status: 200, body: { ok: true } });
  const stats = await service(dir, { fetch });
  stats.recordReport(problem({ times: 1, recovered: false }));
  stats.recordReport(problem({ times: 3, recovered: true }));
  assert.deepEqual(stats.queue.map(r => [r.times, r.recovered]), [[3, true]], 'the waiting report takes the count and the recovery');
  await stats.upload();
  stats.recordReport(problem({ times: 5 }));
  assert.equal(stats.queue.length, 0, 'already sent for this session');
  await stats.upload();
  assert.deepEqual(calls.map(call => call.body.reports[0].times), [3]);
  stats.unresponsive(); stats.unresponsive();
  assert.deepEqual(stats.queue.map(r => [r.type, r.times]), [['frozen', 2]]);
});

test('the preview shows the last batch sent and what waits, the running session as it would be sent', async () => {
  const dir = await folder(), stats = await service(dir);
  assert.deepEqual(stats.preview(), { lastSent: null, waiting: [] });
  stats.recordSession(summary()); stats.recordReport(fileReport());
  const { waiting } = stats.preview();
  assert.deepEqual(waiting.map(r => r.kind), ['file', 'session']);
  assert.equal(waiting[1].end, 'clean');
});

test('development runs collect but upload only to a site on this computer; the intake address is checked', async () => {
  const dir = await folder();
  assert.equal((await service(dir, { channel: 'development', siteUrl: '' })).getState().uploads, false);
  assert.equal((await service(dir, { channel: 'development', siteUrl: 'http://127.0.0.1:8787/' })).getState().uploads, true);
  assert.equal(statsEndpoint('http://127.0.0.1:8787', false), '');
  assert.equal(statsEndpoint('https://stykanimate.com/api'), '');
  assert.equal(statsEndpoint('https://user:pw@stykanimate.com/'), '');
  assert.equal(statsEndpoint('https://stykanimate.com'), 'https://stykanimate.com');
});

test('quitting waits for the upload at most the quit limit', async () => {
  const dir = await folder(), stats = await service(dir, { fetch: () => new Promise(() => {}), quitWaitMs: 50 });
  stats.recordReport(fileReport());
  const started = performance.now();
  await stats.close();
  assert.ok(performance.now() - started < 1000);
  await stats.close();
});

test('the machine is described in wide steps', () => {
  const gpu = (...gpuDevice) => ({ gpuDevice });
  assert.deepEqual(machineFacts({ gpuInfo: gpu({ vendorId: 0x8086, active: true }), totalmem: 15.8 * 2 ** 30, cores: 12 }),
    { graphics: 'integrated', vendor: 'intel', memory: '16', cores: '16' });
  assert.deepEqual(machineFacts({ gpuInfo: gpu({ vendorId: 0x8086 }, { vendorId: 0x10de, active: true }), totalmem: 64 * 2 ** 30, cores: 64 }),
    { graphics: 'discrete', vendor: 'nvidia', memory: '64', cores: '32' });
  assert.equal(machineFacts({ gpuInfo: gpu({ vendorId: 0x1002, deviceString: 'AMD Radeon RX 6600' }) }).graphics, 'discrete');
  assert.equal(machineFacts({ gpuInfo: gpu({ vendorId: 0x1002, deviceString: 'AMD Radeon(TM) Graphics' }) }).graphics, 'integrated');
  assert.deepEqual(machineFacts({ gpuInfo: gpu({ vendorId: 0x1414 }) }).graphics, 'software');
  assert.deepEqual(machineFacts({}), { graphics: 'unknown', vendor: 'unknown', memory: 'unknown', cores: 'unknown' });
});

test('the bridge is the table in docs/STATISTICS.md and nothing more, each call has its handler, and no telemetry channel is left', async () => {
  const preload = await readFile('desktop/preload.cjs', 'utf8'), main = await readFile('desktop/main.cjs', 'utf8'), doc = await readFile('docs/STATISTICS.md', 'utf8');
  const exposed = [...preload.matchAll(/^\s+(\w*Stats\w*):/gm)].map(match => match[1]).sort();
  const documented = [...doc.matchAll(/^\| `(\w+)\(/gm)].map(match => match[1]).sort();
  assert.deepEqual(exposed, documented);
  assert.deepEqual(exposed, ['getStatsState', 'markStatsNoticeSeen', 'onStatsState', 'previewStats', 'sendStatsReport', 'sendStatsSession', 'setStatsEnabled']);
  for (const channel of [...preload.matchAll(/'(styk:stats-[a-z-]+)'/g)].map(match => match[1]).filter(channel => channel !== 'styk:stats-state-changed'))
    assert.ok(main.includes(`handle('${channel}'`), `${channel} has a handler`);
  for (const text of [preload, main]) assert.doesNotMatch(text, /telemetry|contentTracing|performance-trace/i);
});

test('the packaged app carries the service, src/stats and the schema the service loads', async () => {
  const build = JSON.parse(await readFile('package.json', 'utf8')).build;
  assert.ok(build.files.includes('desktop/**/*'), 'desktop/stats.cjs is packaged with the desktop files');
  const web = build.extraResources.find(resource => resource.to === 'web');
  assert.ok(web.filter.includes('src/**/*') && !web.filter.some(filter => /^!src\/stats/.test(filter)), 'src/stats is in the web resources');
  const main = await readFile('desktop/main.cjs', 'utf8');
  assert.match(main, /path\.join\(app\.isPackaged \? path\.join\(process\.resourcesPath, 'web'\) : APP_ROOT, 'src', 'stats', 'schema\.mjs'\)/);
  for (const file of ['collector', 'frames', 'session', 'problems', 'stack', 'files', 'schema']) await readFile(`src/stats/${file}.mjs`);
});

test('the running summary reaches the disk as the schema checked it, even when the page sent fields without a value', async () => {
  const dir = await folder(), stats = await service(dir, { disk: true });
  // A page's summary crosses the bridge by structured clone, which keeps a field whose value is undefined; the store refuses those.
  assert.equal(stats.recordSession(summary({ smooth: undefined, slow: undefined, unsaved: true })), true);
  await stats.settled();
  const { running } = await sessionFile(dir);
  assert.deepEqual(running.summary, summary());
  assert.equal(running.unsaved, true);
});

test('the intake sets the share of sessions; a session that is not chosen records and sends nothing but counts its day', async () => {
  const dir = await folder(), { calls, fetch } = intake({ status: 200, body: { ok: true, sample: 25 } });
  const clock = { t: START };
  let roll = 99;
  const start = () => service(dir, { clock, fetch, randomPercent: () => roll });

  // No answer yet: every session is reported, whatever the draw.
  const first = await start();
  assert.equal(first.getState().counting, true);
  first.recordSession(summary()); first.recordReport(fileReport());
  assert.deepEqual(first.preview().waiting.map(r => r.sample), [100, 100]);
  await first.close();
  assert.deepEqual(calls.flatMap(call => call.body.reports.map(r => [r.kind, r.sample])), [['file', 100], ['session', 100]]);
  assert.equal(first.settings.sample, 25, 'the answer asked for a quarter of the sessions');

  // The next day's session draws 60: not one of the quarter.
  clock.t += DAY; roll = 60;
  const second = await start();
  assert.deepEqual({ enabled: second.getState().enabled, counting: second.getState().counting }, { enabled: true, counting: false });
  assert.equal(second.recordSession(summary()), false);
  assert.equal(second.recordReport(fileReport()), false);
  second.windowGone('crashed'); second.unresponsive();
  assert.deepEqual(second.preview().waiting, []);
  await second.close();
  assert.equal(calls.length, 1, 'nothing was uploaded for it');
  assert.ok(second.settings.days.includes(utcDay(clock.t)), 'its day still counts for the first facts');

  // The same day, a session that draws 10 is chosen: it carries the share, and is not the first of its day.
  roll = 10;
  const third = await start();
  assert.equal(third.getState().counting, true);
  third.recordSession(summary());
  const [waiting] = third.preview().waiting;
  assert.equal(waiting.sample, 25);
  assert.equal(waiting.first.day, false);
  await third.close();
  assert.equal(calls.at(-1).body.reports[0].sample, 25);

  // An answer without a share, or with one that is not a step, changes nothing.
  const other = await service(await folder(), { fetch: intake({ status: 200, body: { ok: true, sample: 30 } }).fetch });
  other.recordReport(fileReport()); await other.upload();
  assert.equal(other.settings.sample, 100);
});
