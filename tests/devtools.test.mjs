// The developer tools' pure parts (docs/DEVTOOLS.md): the span ring's reads, summaries and Perfetto export, the log
// filter, the shipping check, and the instrumentation layer doing nothing without the developer build.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Capture, perfettoTrace, ringEvents, summarize} from '../src/devtools/capture.mjs';
import {filterLogs} from '../src/devtools/control.mjs';
import {treePage, preview} from '../src/devtools/inspector.mjs';
import {MARKERS, isDeveloperPath, scanBinary, scanCapabilities, scanWeb} from '../scripts/check-devtools-shipping.mjs';
import {selectFiles} from '../scripts/build-web.mjs';

/** A ring shaped as src/devtools/early.js makes it. */
function ring(capacity) {
  return {capacity, head: 0, total: 0, start: new Float64Array(capacity), duration: new Float64Array(capacity), value: new Float64Array(capacity),
    name: new Uint16Array(capacity), thread: new Uint8Array(capacity), depth: new Uint8Array(capacity), args: new Array(capacity).fill(null), names: [], ids: new Map(), threads: ['interface', 'display']};
}
function push(r, name, start, duration, {thread = 0, depth = 0, value = 0, args = null} = {}) {
  let id = r.ids.get(name);
  if (id === undefined) { id = r.names.push(name) - 1; r.ids.set(name, id); }
  const at = r.head;
  Object.assign(r, {head: (at + 1) % r.capacity, total: r.total + 1});
  r.start[at] = start; r.duration[at] = duration; r.value[at] = value; r.name[at] = id; r.thread[at] = thread; r.depth[at] = depth; r.args[at] = args;
}

test('the ring reads oldest first and counts what it overwrote', () => {
  const r = ring(4);
  for (let i = 0; i < 6; i++) push(r, `s${i}`, i, 1);
  const {events, dropped} = ringEvents(r, 0);
  assert.deepEqual(events.map(event => event.name), ['s2', 's3', 's4', 's5']);
  assert.equal(dropped, 2);
  assert.deepEqual(ringEvents(r, 5).events.map(event => event.name), ['s5']);
});

test('a capture takes only what was recorded while it ran', () => {
  const r = ring(16), capture = new Capture(r);
  push(r, 'before', 0, 1);
  capture.start('x');
  assert.throws(() => capture.start('again'), /already running/);
  push(r, 'during', 1, 2);
  const taken = capture.stop();
  assert.deepEqual(taken.events.map(event => event.name), ['during']);
  assert.throws(() => capture.stop(), /No capture/);
});

test('summaries group spans (edit calls by method), count late frames and keep counters', () => {
  const r = ring(64);
  for (const ms of [10, 12, 40, 16]) push(r, 'display frame', 0, ms, {thread: 1});
  push(r, 'edit session call', 1, 3, {args: {method: 'poseJoint'}});
  push(r, 'edit session call', 2, 5, {args: {method: 'poseJoint'}});
  push(r, 'edit session call', 3, 1, {args: {method: 'beginDrag'}});
  push(r, 'queue', 4, -2, {value: 3});
  push(r, 'queue', 5, -2, {value: 1});
  push(r, 'opened', 6, -1);
  const summary = summarize(ringEvents(r).events, {lateMs: 25});
  assert.deepEqual(summary.frames, {count: 4, p50: 12, p95: 40, worst: 40, late: 1, lateMs: 25});
  const pose = summary.spans.find(row => row.name === 'edit session call poseJoint');
  assert.deepEqual([pose.count, pose.totalMs, pose.worst], [2, 8, 5]);
  assert.deepEqual(summary.counters.queue, {last: 1, min: 1, max: 3, samples: 2});
  assert.equal(summary.instants.opened, 1);
  assert.equal(summary.slowest[0].name, 'edit session call poseJoint');
});

test('the Perfetto export is Chrome trace JSON with named threads', () => {
  const r = ring(8);
  push(r, 'paint', 10, 2.5, {args: {playing: false}});
  push(r, 'display frame', 10, 16, {thread: 1});
  push(r, 'queue', 11, -2, {value: 4});
  push(r, 'opened', 12, -1);
  const trace = perfettoTrace(ringEvents(r).events, {origin: 10});
  const paint = trace.traceEvents.find(event => event.name === 'paint');
  assert.deepEqual([paint.ph, paint.ts, paint.dur, paint.args.playing], ['X', 0, 2500, false]);
  assert.equal(trace.traceEvents.find(event => event.name === 'queue').ph, 'C');
  assert.equal(trace.traceEvents.find(event => event.name === 'opened').ph, 'i');
  assert.deepEqual(trace.traceEvents.filter(event => event.name === 'thread_name').map(event => event.args.name), ['interface', 'display']);
  JSON.parse(JSON.stringify(trace));
});

test('logs filter by least level, module and text', () => {
  const levels = ['debug', 'info', 'warn', 'error'];
  const rows = [{seq: 1, level: 'info', module: 'engine', message: 'opened'}, {seq: 2, level: 'warn', module: 'engine', message: 'slow frame'},
    {seq: 3, level: 'error', module: 'save', message: 'disk full'}];
  assert.deepEqual(filterLogs(rows, {least: 2, levels}).map(row => row.seq), [2, 3]);
  assert.deepEqual(filterLogs(rows, {module: 'ENG', levels}).map(row => row.seq), [1, 2]);
  assert.deepEqual(filterLogs(rows, {text: 'disk', levels}).map(row => row.seq), [3]);
  assert.deepEqual(filterLogs(rows, {since: 2, levels}).map(row => row.seq), [3]);
});

test('the inspector pages a tree and previews values without expanding them', () => {
  const root = {name: 'doc', list: Array.from({length: 120}, (_, i) => ({i})), bytes: new Uint8Array(9)};
  const top = treePage(root);
  assert.deepEqual(top.rows.map(row => [row.key, row.preview, row.container]), [['name', '"doc"', false], ['list', 'Array(120)', true], ['bytes', 'Uint8Array(9)', false]]);
  const second = treePage(root, {path: ['list'], cursor: 50});
  assert.deepEqual([second.size, second.rows.length, second.rows[0].key, second.next], [120, 50, 50, 100]);
  assert.equal(treePage(root, {path: ['list', 3, 'i']}).value, '3');
  assert.throws(() => treePage(root, {path: ['name', 'x', 'y']}), /not inside a container/);
  assert.equal(preview('x'.repeat(300)).length, 130);
});

test('the instrumentation layer records nothing and returns defaults without the developer build', async () => {
  assert.equal(globalThis.__stykTrace, undefined);
  const trace = await import('../src/trace.mjs');
  assert.equal(trace.tracing, false);
  assert.equal(trace.traceBegin('x'), 0);
  assert.equal(trace.tuned('playback.lookaheadFrames', 48, {min: 2}), 48);
  trace.traceEnd(0); trace.traceInstant('x'); trace.traceCounter('x', 1); trace.traceComplete('x', 0, 1);
  const gate = await import('../src/devtools-gate.mjs');
  assert.equal(gate.startDevtools({}, {}), null);
});

test('the shipping check finds developer files, markers, binaries and capabilities, and passes clean inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'styk-devtools-'));
  try {
    const clean = path.join(root, 'clean'), dirty = path.join(root, 'dirty'), caps = path.join(root, 'caps');
    await mkdir(path.join(clean, 'src'), {recursive: true});
    await writeFile(path.join(clean, 'src', 'app.mjs'), 'const sink = globalThis.__stykTrace ?? null; if (globalThis.__STYK_DEVTOOLS__) import(new URL("./devtools/devtools.mjs", location.href));');
    assert.deepEqual(await scanWeb(clean), []);
    await mkdir(path.join(dirty, 'src', 'devtools'), {recursive: true});
    await writeFile(path.join(dirty, 'src', 'devtools', 'early.js'), '');
    await writeFile(path.join(dirty, 'chunk.mjs'), 'const DEVELOPER = "styk-devtools";');
    assert.deepEqual((await scanWeb(dirty)).sort(), ['chunk.mjs: contains "styk-devtools"', 'src/devtools/early.js: a developer tools file']);
    await writeFile(path.join(root, 'app.exe'), Buffer.concat([Buffer.from('MZ\0\0'), Buffer.from('__stykDevtoolsReceive', 'utf16le')]));
    assert.deepEqual(await scanBinary(path.join(root, 'app.exe')), ['app.exe: contains "__stykDevtoolsReceive" (UTF-16)']);
    await mkdir(caps);
    await writeFile(path.join(caps, 'main.json'), JSON.stringify({permissions: ['core:default', 'allow-file-write-begin']}));
    assert.deepEqual(await scanCapabilities(caps), []);
    await writeFile(path.join(caps, 'dev.json'), JSON.stringify({permissions: ['styk-devtools:default']}));
    assert.deepEqual(await scanCapabilities(caps), ['dev.json: allows styk-devtools:default']);
    assert.ok(isDeveloperPath('src/devtools/panels.mjs') && isDeveloperPath(path.join('src', 'devtools', 'x.mjs')) && !isDeveloperPath('src/trace.mjs'));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('the shipped web file set leaves the developer tools out', async () => {
  const files = await selectFiles(path.resolve('.'), ['src/**/*']);
  assert.ok(files.length > 100);
  assert.ok(!files.some(file => isDeveloperPath(file)), 'no src/devtools file is selected');
  assert.ok(files.some(file => file.replace(/\\/g, '/') === 'src/trace.mjs'));
});

test('shipping code builds no tracing objects: span arguments are guarded and live parameters\' specs are constants', async () => {
  const {readdir, readFile} = await import('node:fs/promises');
  const files = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!['devtools', 'pkg', 'locales'].includes(entry.name)) await walk(full); }
      else if (/\.mjs$/.test(entry.name) && entry.name !== 'trace.mjs') files.push(full);
    }
  };
  await walk('src');
  let calls = 0;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (!text.includes('trace.mjs')) continue;
    for (const [index, line] of text.split('\n').entries()) {
      const where = `${file}:${index + 1}`;
      if (/\btrace(End|Complete|Instant|Begin)\([^)]*\{/.test(line)) {
        calls++;
        assert.match(line, /if \((tracing|span !== 0)\)/, `${where}: a span's argument object is built only when tracing`);
      }
      if (/\btuned\(/.test(line)) { calls++; assert.doesNotMatch(line, /\btuned\([^)]*,\s*\{/, `${where}: a live parameter's spec is a module constant`); }
    }
  }
  assert.ok(calls >= 8, `the scan found the instrumented call sites (${calls})`);
});

test('the packaged desktop app leaves the developer launch out: its module and the tools are not in the file lists, and the shipped desktop code names none of it', async () => {
  const {readdir, readFile} = await import('node:fs/promises');
  const build = JSON.parse(await readFile('package.json', 'utf8')).build;
  assert.ok(build.files.includes('!desktop/devtools.cjs'), 'the desktop file list leaves desktop/devtools.cjs out');
  const web = build.extraResources.find(resource => resource.to === 'web');
  assert.ok(web.filter.includes('!src/devtools/**'), 'the web resources leave src/devtools out');
  for (const name of await readdir('desktop')) {
    if (!/\.cjs$/.test(name) || name === 'devtools.cjs') continue;
    const text = await readFile(path.join('desktop', name), 'utf8');
    for (const marker of MARKERS) assert.ok(!text.includes(marker), `desktop/${name} carries no developer marker (${marker})`);
  }
  const main = await readFile('desktop/main.cjs', 'utf8');
  assert.match(main, /!app\.isPackaged && \(process\.argv\.includes\('--styk-developer'\)/, 'only a source checkout that asks loads the developer module');
});
