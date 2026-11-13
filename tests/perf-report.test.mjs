// The performance report (`npm run perf -- report`, perf/report/): one or more runs become one self-contained page that
// embeds its data, whose script compiles, and that no text from a result can break out of; several runs merge into
// columns with the first named as the baseline; the ranking puts the worst first; the notes are text, never markup.
// What the page looks like is checked in a browser by hand (perf/report/build.mjs says how the page is made).
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {LIMITS} from '../perf/lib/metrics.mjs';
import {SCHEMA} from '../perf/lib/result.mjs';
import {buildReport} from '../perf/report/build.mjs';
import {markdown} from '../perf/report/markdown.mjs';
import {reportModel, statusOf} from '../perf/report/model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const spread = (median, wobble = 0) => ({n: 2, median, mad: wobble, min: median - wobble, max: median + wobble});

/** A made-up scenario as the runner writes it; `duration` decides an operation, `felt` a gesture. */
function scenario(id, {title = id, area = id.split('.')[0], kind = 'operation', value = 50, limits = LIMITS.response, error = null, skipped = null, wobble = 1} = {}) {
  const metric = kind === 'gesture' ? 'frame.felt' : 'duration';
  const grade = ['good', 'fair', 'poor'][limits.findIndex(limit => value <= limit)] ?? 'bad';
  return {id, area, title, kind, description: `${title}, made up for a test.`, grade: skipped ? null : grade, passes: skipped ? 0 : 2,
    judged: skipped ? null : {grade, decided: metric, value, criteria: [{metric, limits, value, grade}]},
    metrics: skipped ? {} : {[metric]: spread(value, wobble), 'longTasks.count': spread(0)}, definitions: {}, notes: [], error, ...(skipped ? {skipped} : {}),
    detail: kind === 'gesture' ? {ms: 1500, frames: {count: 3, perSecond: 2, periodMs: 6.9, p50: 7, p95: 9, p99: 9, worst: 9, felt: value, late: 1, lateShare: .33, over16: 0, over33: 0, over100: 0, dropped: 0,
      work: {mean: 3, p50: 3, p95: 4, worst: 4, budgetShare: .6}, phases: {handlers: {mean: 1, p95: 1, worst: 1, share: .3}, script: {mean: 1, p95: 1, worst: 1, share: .3}, render: {mean: 1, p95: 1, worst: 1, share: .3}}},
    series: {bucket: 1, interval: [7, 7, 9], handlers: [1, 1, 1], script: [1, 1, 2], render: [1, 1, 1]}, spans: [], slowest: [], boundary: null, preparation: null, counters: {}} : null,
    attribution: null};
}
const pair = (environment, workload, scenarios, extra = {}) => ({environment: {id: environment, title: `${environment} title`}, workload: {id: workload, title: `${workload} title`, segmentsPerFrame: workload === 'small' ? 240 : 200000, frames: 100},
  facts: {renderer: {backend: 'WebGPU'}, display: {hz: 144, periodMs: 6.94}, engine: {threads: 2}, cpuSlowdown: 1, backgroundLoadPercent: 5}, startup: {readyMs: 2000}, memory: [{after: 'start', page: 100, total: 300}, {after: 'file.open', page: 400, total: 700}],
  error: null, scenarios, ...extra});
const run = (label, pairs) => ({schema: SCHEMA, label, at: '2026-11-13T00:00:00.000Z', suite: 'quick', passes: 2, profile: false, seconds: 60,
  build: {commit: 'abc1234', branch: 'perf/test', dirty: false, engine: {profile: 'wasm', sha256: '0123456789ab', wasmBytes: 1}, version: '1.0.0'},
  machine: {platform: 'linux', arch: 'x64', release: '6', cpu: 'Test CPU', threads: 8, memoryGB: 16, node: 'v24'}, pairs, folder: path.join(os.tmpdir(), 'a-private-folder', label)});

const page = html => ({
  data: JSON.parse(html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)[1]),
  script: html.match(/<script>([\s\S]*?)<\/script>/)[1],
});

test('the page embeds its runs as data, its script compiles, and text in a result cannot end the script that holds it', async () => {
  const hostile = 'Drag </script><script>alert(1)</script> <!-- & a "quote"';
  const html = await buildReport([run('one', [pair('gpu', 'small', [scenario('pose.drag', {title: hostile, kind: 'gesture', value: 12, limits: LIMITS.frame}), scenario('file.open')])])],
    {generated: '2026-11-13T01:00:00.000Z'});
  // Two scripts, the data and the page's code, and each ends where it should.
  assert.equal((html.match(/<script/gi) ?? []).length, 2);
  assert.equal((html.match(/<\/script/gi) ?? []).length, 2);
  const {data, script} = page(html);
  assert.equal(data.schema, 'styk-perf-report/1');
  assert.equal(data.pairs[0].scenarios[0].title, hostile);
  assert.equal(data.generated, '2026-11-13T01:00:00.000Z');
  // The page parses as JavaScript (a syntax error in any of its modules would leave it blank).
  assert.doesNotThrow(() => new vm.Script(script, {filename: 'report-page.js'}));
  // The runner's own formatting is copied in, not rewritten.
  assert.match(script, /function format\(key, value, definitions = \{\}\)/);
  // Nothing loads from elsewhere, and the run's folder (a path on this machine) is not on the page.
  assert.doesNotMatch(html, /<link\b|\ssrc=/i);
  assert.ok(!html.includes('a-private-folder'));
});

test('several runs merge into one column per pair: the first named is the baseline, and a change counts by the runs\' noise', () => {
  const base = run('before', [pair('gpu', 'small', [scenario('file.open', {value: 100}), scenario('history.undo', {value: 40})])]);
  const head = run('after', [pair('gpu', 'small', [scenario('file.open', {value: 250}), scenario('history.undo', {value: 41})]),
    pair('software', 'small', [scenario('file.open', {value: 2000, limits: [1000, 3000, 10000]}), scenario('canvas.pan', {kind: 'gesture', value: 120, limits: LIMITS.frame}),
      scenario('canvas.zoom', {error: 'did not start'}), scenario('canvas.hover', {skipped: 'the document has one frame'})], {facts: {backgroundLoadPercent: 73}})]);
  const model = reportModel([base, head]);
  assert.deepEqual(model.columns.map(column => [column.key, column.pair, column.base]), [['gpu/small', 1, 0], ['software/small', 2, null]]);
  const gpu = model.columns[0];
  assert.equal(gpu.verdicts['file.open'], 'worse');
  assert.equal(gpu.verdicts['history.undo'], 'same');
  assert.deepEqual(gpu.changes['file.open'].find(row => row.metric === 'duration'), {metric: 'duration', judged: true, base: 100, head: 250, difference: 150, ratio: 1.5, threshold: 5, verdict: 'worse'});
  // The busy machine is flagged by the threshold the text summary uses; the pair's facts are kept.
  assert.equal(model.pairs[2].busy, true);
  assert.equal(model.pairs[0].busy, false);
  // Rows by area in the order measured; the failure wins over a grade; the skipped scenario is not work to do.
  assert.deepEqual(model.rows.map(row => row.id), ['file.open', 'history.undo', 'canvas.pan', 'canvas.zoom', 'canvas.hover']);
  assert.equal(statusOf({grade: 'good', error: 'profiled pass timed out'}), 'failed');
  assert.deepEqual(model.ranking.map(item => [item.scenario, model.columns[item.column].key, item.status]),
    [['canvas.zoom', 'software/small', 'failed'], ['canvas.pan', 'software/small', 'bad'], ['file.open', 'gpu/small', 'fair'], ['file.open', 'software/small', 'fair']]);
  // Within a grade, the one furthest past its good limit comes first: 250 ms is 2.5× its 100 ms, 2 s is 2× its 1 s.
  assert.deepEqual(model.ranking.slice(2).map(item => item.excess), [2.5, 2]);
  // Every distinct criterion, with the scenarios judged on it (a failure that was graded before it failed too).
  assert.deepEqual(model.limits.map(row => [row.metric, row.limits, row.scenarios]),
    [['duration', [100, 300, 1000], ['file.open', 'history.undo', 'canvas.zoom']], ['duration', [1000, 3000, 10000], ['file.open']], ['frame.felt', LIMITS.frame, ['canvas.pan']]]);
  assert.ok(!('folder' in model.runs[0]));
});

test('a result recorded before the runner kept its judgement is judged again with the runner\'s function', () => {
  const old = scenario('canvas.pan', {kind: 'gesture', value: 40, limits: LIMITS.frame});
  delete old.judged;
  old.judge = {metric: 'frame.felt', limits: LIMITS.frame};
  const model = reportModel([run('old', [pair('gpu', 'small', [old])])]);
  assert.deepEqual(model.pairs[0].scenarios[0].judged, {grade: 'poor', decided: 'frame.felt', value: 40, criteria: [{metric: 'frame.felt', limits: LIMITS.frame, value: 40, grade: 'poor'}]});
  assert.equal(model.ranking[0].status, 'poor');
});

test('notes render as a small Markdown subset, and their text is never markup', () => {
  const html = markdown([
    '# Findings', '', 'The **stress** scene, `<canvas>` and *italics*; [a scenario](#env=gpu&scenario=pose.drag-joint), [a page](https://example.org/x), [not a link](javascript:alert(1)).',
    '', '1. First', '   - nested', '2. Second', '', '| Pair | Grade |', '| --- | ---: |', '| gpu / small | bad |', '', '<script>alert(1)</script>', '', '```', 'if (a < b) {}', '```',
  ].join('\n'));
  assert.match(html, /^<h3>Findings<\/h3>/);
  assert.match(html, /<strong>stress<\/strong> scene, <code>&lt;canvas&gt;<\/code> and <em>italics<\/em>/);
  assert.match(html, /<a href="#env=gpu&amp;scenario=pose.drag-joint">a scenario<\/a>/);
  assert.match(html, /<a href="https:\/\/example.org\/x" rel="noreferrer">a page<\/a>/);
  assert.match(html, /, not a link\./);
  assert.match(html, /<ol><li>First<ul><li>nested<\/li><\/ul><\/li><li>Second<\/li><\/ol>/);
  assert.match(html, /<th>Pair<\/th><th style="text-align:right">Grade<\/th>/);
  assert.match(html, /<td>gpu \/ small<\/td><td style="text-align:right">bad<\/td>/);
  assert.match(html, /<p>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
  assert.match(html, /<pre><code>if \(a &lt; b\) \{\}<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script|javascript:/i);
});

test('the report command writes report.html beside the run, with the notes at the top', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'styk-perf-report-'));
  try {
    const runFolder = path.join(folder, 'run');
    mkdirSync(runFolder);
    const {folder: _folder, ...stored} = run('made-up', [pair('gpu', 'small', [scenario('file.open')])]);
    writeFileSync(path.join(runFolder, 'result.json'), JSON.stringify(stored));
    writeFileSync(path.join(folder, 'notes.md'), '# What to do\n\nNothing, it is **made up**.\n');
    const output = execFileSync(process.execPath, ['perf/cli.mjs', 'report', runFolder, '--notes', path.join(folder, 'notes.md')], {cwd: ROOT, encoding: 'utf8', windowsHide: true});
    assert.match(output, /Written to .*report\.html/);
    const html = readFileSync(path.join(runFolder, 'report.html'), 'utf8');
    assert.match(html, /<h2 id="conclusions-title">Conclusions<\/h2>.*notes\.md/s);
    assert.match(html, /<h3>What to do<\/h3>\n<p>Nothing, it is <strong>made up<\/strong>\.<\/p>/);
    assert.equal(page(html).data.runs[0].label, 'made-up');
    const missing = spawnSync(process.execPath, ['perf/cli.mjs', 'report', runFolder, '--notes', path.join(folder, 'absent.md')], {cwd: ROOT, encoding: 'utf8', windowsHide: true});
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--notes: no file at/);
  } finally { rmSync(folder, {recursive: true, force: true}); }
});
