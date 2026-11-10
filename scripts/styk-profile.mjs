// The one profiling command (docs/DEVTOOLS.md "Profiling command"): opens a document in the developer build, runs a
// scenario, and writes a short summary, the measurements as JSON and the Perfetto traces.
//
//   node scripts/styk-profile.mjs <file> [scenario] [--out <new dir>] [--runs 3] [--desktop] [--budget <rule>]...
//
// scenario   open | play | scrub | drag | pan-zoom | all (default: all). Each run opens the document, then runs the steps.
// --desktop  this checkout's desktop app in a developer launch (electron . --styk-developer: it sets up the control
//            channel and, with STYK_REMOTE_DEBUGGING_PORT, the inspector's protocol port the driver attaches to). It
//            starts off-screen (STYK_BACKGROUND_WINDOW=1). --app <exe> names another developer binary instead. Without
//            either, the app runs from this checkout's sources in Chrome, with the early script injected: the same
//            tools and the same measurements, without the desktop shell.
// --user-data  the app's data folder for desktop runs (STYK_USER_DATA_DIR). By default each run gets a fresh scratch folder,
//            deleted afterwards. An agent never runs the app on the owner's data: the real folder (%APPDATA%StykAnimate)
//            and any folder that already holds files are refused.
// --budget   `<metric> <op> <value>`, e.g. "play.frames.p95 <= 25" or "open.ms < 3000": the median over the runs must
//            meet it, or the command exits 1. Metrics are the keys of profile.json's `medians`.
// Output (default artifacts/profile/<time>): summary.txt (read it first), profile.json, trace-<scenario>.json (first run,
// for ui.perfetto.dev) and stage.png. The document's path and contents are never written: it is named by its hash.
// Exit 0 success, 1 a budget missed, 2 a tool error.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '../tests/support/playwright.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIOS = ['open', 'play', 'scrub', 'drag', 'pan-zoom'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArguments(argv) {
  const options = {runs: 3, budgets: [], positional: []};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') options.out = argv[++i];
    else if (arg === '--runs') options.runs = Number(argv[++i]);
    else if (arg === '--app') options.app = argv[++i];
    else if (arg === '--desktop') options.desktop = true;
    else if (arg === '--budget') options.budgets.push(argv[++i]);
    else if (arg === '--user-data') options.userData = argv[++i];
    else if (arg.startsWith('--')) throw usage(`Unknown option ${arg}.`);
    else options.positional.push(arg);
  }
  const [file, scenario = 'all'] = options.positional;
  if (!file) throw usage('Name the document to profile.');
  if (!existsSync(file)) throw usage(`No file at ${file}.`);
  if (scenario !== 'all' && !SCENARIOS.includes(scenario)) throw usage(`Unknown scenario ${scenario}: one of ${SCENARIOS.join(', ')}, all.`);
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 32) throw usage('--runs is 1 to 32.');
  options.budgets = options.budgets.map(parseBudget);
  return {...options, file: path.resolve(file), scenarios: scenario === 'all' ? SCENARIOS : ['open', ...(scenario === 'open' ? [] : [scenario])]};
}
function usage(message) { return Object.assign(new Error(`${message}\nUsage: node scripts/styk-profile.mjs <file> [open|play|scrub|drag|pan-zoom|all] [--out <dir>] [--runs N] [--desktop] [--budget "<metric> <op> <value>"]`), {exit: 2}); }

export function parseBudget(text) {
  const match = /^\s*([\w.-]+)\s*(<=|>=|==|<|>)\s*(-?[\d.]+)\s*(ms|s|MB|%)?\s*$/.exec(text ?? '');
  if (!match) throw usage(`A budget reads "<metric> <op> <value>", like "play.frames.p95 <= 25": got ${JSON.stringify(text)}.`);
  const scale = {s: 1000}[match[4]] ?? 1;
  return {text: text.trim(), metric: match[1], op: match[2], value: Number(match[3]) * scale};
}
export function judge(budget, value) {
  if (!Number.isFinite(value)) return {...budget, value, ok: false, reason: 'no such measurement'};
  const ok = {'<': value < budget.value, '<=': value <= budget.value, '==': value === budget.value, '>=': value >= budget.value, '>': value > budget.value}[budget.op];
  return {...budget, actual: value, ok};
}
export function median(values) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}
const quantiles = list => { const sorted = list.filter(Number.isFinite).sort((a, b) => a - b), at = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : null;
  return {count: sorted.length, p50: at(.5), p95: at(.95), worst: sorted.at(-1) ?? null}; };
/** Flattens nested numbers into "a.b.c" keys. */
export function flatten(object, prefix = '', into = {}) {
  for (const [key, value] of Object.entries(object ?? {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'number') into[name] = value;
    else if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, name, into);
  }
  return into;
}

// --- the app ---------------------------------------------------------------------------------------------------------
async function launchBrowser() {
  const {startDesktopHost} = require('../desktop/web-host.cjs');
  const host = await startDesktopHost({appRoot, port: 0});
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  await page.addInitScript({path: path.join(appRoot, 'src', 'devtools', 'early.js')});
  await page.goto(host.origin);
  return {page, mode: 'browser', close: async () => { await browser.close(); await host.stop(); }};
}

/** The owner's real data folders: never a profile's. */
const ownerFolders = () => [process.env.APPDATA, process.env.LOCALAPPDATA, path.join(os.homedir(), '.config'), path.join(os.homedir(), 'Library', 'Application Support')]
  .filter(Boolean).map(folder => path.resolve(folder, 'StykAnimate').toLowerCase());

/**
 * The data folder an --app run uses: the one given (empty or new, never the owner's), or a fresh scratch folder that
 * the run deletes. Returns {dir, scratch}.
 */
export function userDataFolder(given) {
  if (!given) return {dir: mkdtempSync(path.join(os.tmpdir(), 'styk-profile-data-')), scratch: true};
  const dir = path.resolve(given);
  if (ownerFolders().includes(dir.toLowerCase())) throw Object.assign(new Error(`${dir} is the owner's StykAnimate data: give a scratch folder instead.`), {exit: 2});
  if (existsSync(dir) && readdirSync(dir).length) throw Object.assign(new Error(`${dir} already holds files: give an empty or new folder.`), {exit: 2});
  mkdirSync(dir, {recursive: true});
  return {dir, scratch: false};
}

async function launchApp(executable, userData, args = []) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const data = userDataFolder(userData);
  const child = spawn(executable, args, {env: {...process.env, STYK_USER_DATA_DIR: data.dir, STYK_BACKGROUND_WINDOW: '1', STYK_REMOTE_DEBUGGING_PORT: String(port), STYK_STARTUP_VIEW: 'editor'}, stdio: 'ignore', windowsHide: true});
  child.once('exit', () => { if (data.scratch) rmSync(data.dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); });
  let browser = null;
  for (let attempt = 0; attempt < 100 && !browser; attempt++) {
    if (child.exitCode !== null) throw new Error(`The app exited (${child.exitCode}) before its inspector port opened. Is it the developer build?`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(300); }
  }
  if (!browser) { child.kill(); throw new Error('The developer build did not open its inspector port within 30 s.'); }
  let page = null;
  for (let attempt = 0; attempt < 100 && !page; attempt++) {
    for (const context of browser.contexts()) for (const candidate of context.pages()) if (await candidate.evaluate(() => Boolean(window.stykDevtools)).catch(() => false)) page = candidate;
    if (!page) await sleep(300);
  }
  if (!page) { child.kill(); throw new Error('The app\'s page never loaded its developer tools.'); }
  return {page, mode: 'app', close: async () => { await browser.close().catch(() => {}); child.kill(); }};
}

/** Serves the document to the page under its own origin, so the page's `open` operation fetches it like any file. */
async function serveDocument(page, file) {
  const name = path.basename(file), bytes = readFileSync(file);
  await page.route('**/__styk_profile__/document', route => route.fulfill({status: 200, body: bytes, headers: {'content-type': 'application/octet-stream', 'cross-origin-resource-policy': 'same-origin'}}));
  return name;
}

// --- scenarios -------------------------------------------------------------------------------------------------------
function driver(page) {
  const request = async (op, args = {}, detail) => {
    const answer = await page.evaluate(r => window.stykDevtools.request(r), {id: 1, op, args, detail});
    if (!answer.ok) throw new Error(`${op}: ${answer.error.what}${answer.error.cause ? ` (${answer.error.cause})` : ''}`);
    return answer.result;
  };
  const traced = async (label, work) => {
    await request('trace.start', {label});
    let extra;
    try { extra = await work(); }
    finally { var stopped = await request('trace.stop', {}, 'full'); }
    let text = '';
    for (let index = 0; index < stopped.pages; index++) text += (await request('trace.read', {page: index})).text;
    return {extra, summary: stopped.summary, events: stopped.events, dropped: stopped.dropped, ms: stopped.ms, trace: text};
  };
  return {request, traced};
}

async function runScenario(name, page, {request, traced}, documentName) {
  const view = (await request('state')).view;
  if (name === 'open') {
    return traced('open', async () => ({ms: (await request('open', {url: '/__styk_profile__/document', name: documentName})).ms}));
  }
  if (name === 'play') {
    await request('seek', {tick: 0});
    const state = await request('state');
    const seconds = Math.min(6, Math.max(2, state.document.totalTicks / Math.max(1, state.document.fps)));
    const run = await traced('play', async () => { await request('play', {seconds}); return {}; });
    // Presented playback frames per second: the prepared frames the stage drew while the capture ran.
    const presented = run.summary.spans.find(row => row.name === 'stage draw prepared')?.count ?? 0;
    return {...run, extra: {seconds, fps: presented / seconds, targetFps: state.document.fps}};
  }
  if (name === 'scrub') {
    const total = (await request('state')).document.totalTicks, ticks = Math.min(60, total);
    return traced('scrub', async () => {
      const presented = [];
      for (let tick = 0; tick < ticks; tick++) presented.push((await request('seek', {tick})).presentedMs);
      return {seekMs: quantiles(presented)};
    });
  }
  if (name === 'drag') {
    await request('seek', {tick: 0});
    await request('select', {uid: (await request('target.handle', {kind: 'pose'})).uid});
    let target = await request('target.handle', {kind: 'pose'});
    for (let attempt = 0; !target.onStage && attempt < 20; attempt++) { await page.keyboard.press('Escape'); await sleep(250); target = await request('target.handle', {kind: 'pose'}); }
    if (!target.onStage) throw new Error('Something covers the stage where the joint is: the drag cannot start.');
    const run = await traced('drag', async () => {
      await page.mouse.move(target.x, target.y); await page.mouse.down();
      const started = Date.now();
      for (let i = 1; i <= 90; i++) {
        const angle = i / 90 * Math.PI * 1.5;
        await page.mouse.move(target.x + Math.sin(angle) * 70, target.y - (1 - Math.cos(angle)) * 45);
        const wait = started + i * 8.33 - Date.now(); if (wait > 1) await sleep(wait);
      }
      await page.mouse.up();
      await request('settle');
      return {};
    });
    await request('undo');
    await request('view', view);
    return run;
  }
  if (name === 'pan-zoom') {
    const box = await page.evaluate(() => { const r = document.getElementById('viewport').getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; });
    const run = await traced('pan-zoom', async () => {
      await page.mouse.move(box.x, box.y);
      await page.keyboard.down('Control');
      for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, Math.floor(i / 10) % 2 === 0 ? -60 : 60); await sleep(8); }
      await page.keyboard.up('Control');
      await sleep(400);
      await page.mouse.down({button: 'middle'});
      for (let i = 1; i <= 90; i++) { const angle = i / 90 * Math.PI * 2; await page.mouse.move(box.x + Math.sin(angle) * 160, box.y - (1 - Math.cos(angle)) * 80); await sleep(8); }
      await page.mouse.up({button: 'middle'});
      await request('settle');
      return {};
    });
    await request('view', view);
    return run;
  }
  throw new Error(`Unknown scenario ${name}.`);
}

/** The numbers a run reports per scenario: display frames, the heaviest spans, edit calls and the scenario's own. */
function measures(name, result) {
  const s = result.summary, paint = s.spans.find(row => row.name === 'paint');
  const edits = s.spans.filter(row => row.name.startsWith('edit session call'));
  return {ms: result.extra?.ms ?? result.ms, frames: {p50: s.frames.p50, p95: s.frames.p95, worst: s.frames.worst, late: s.frames.late},
    paint: paint ? {p50: paint.p50, p95: paint.p95, worst: paint.worst} : undefined,
    edit: edits.length ? {calls: edits.reduce((n, row) => n + row.count, 0), worst: Math.max(...edits.map(row => row.worst))} : undefined,
    longTasks: s.spans.find(row => row.name === 'long task')?.count ?? 0,
    ...(result.extra?.seekMs ? {seek: result.extra.seekMs} : {}), ...(result.extra?.fps !== undefined ? {fps: result.extra.fps, targetFps: result.extra.targetFps} : {})};
}

function writeSummary({input, mode, runs, medians, slowest, judged, unusual}) {
  const lines = [`StykAnimate profile: ${input.name} (${input.sha256.slice(0, 12)}, ${(input.bytes / 1048576).toFixed(1)} MB), ${runs} run${runs === 1 ? '' : 's'}, ${mode}`, ''];
  const scenarios = [...new Set(Object.keys(medians).map(key => key.split('.')[0]))];
  for (const scenario of scenarios) {
    const get = key => medians[`${scenario}.${key}`];
    const parts = [`${scenario.padEnd(8)} ${fmt(get('ms'))} ms`, `frames p50 ${fmt(get('frames.p50'))} p95 ${fmt(get('frames.p95'))} worst ${fmt(get('frames.worst'))}, late ${fmt(get('frames.late'), 0)}`];
    if (get('paint.p95') !== undefined) parts.push(`paint p95 ${fmt(get('paint.p95'))}`);
    if (get('edit.calls') !== undefined) parts.push(`${fmt(get('edit.calls'), 0)} edit calls, worst ${fmt(get('edit.worst'))}`);
    if (get('seek.p95') !== undefined) parts.push(`seek p95 ${fmt(get('seek.p95'))}`);
    if (get('fps') !== undefined) parts.push(`${fmt(get('fps'), 1)} of ${fmt(get('targetFps'), 0)} fps`);
    lines.push(parts.join(' · '));
  }
  lines.push('', 'Slowest spans (first run):', ...slowest.map(row => `  ${fmt(row.ms)} ms  ${row.name} (${row.scenario})`));
  if (unusual.length) lines.push('', 'Unusual:', ...unusual.map(text => `  ${text}`));
  if (judged.length) lines.push('', 'Budgets:', ...judged.map(b => `  ${b.ok ? 'met   ' : 'MISSED'} ${b.text} (median ${fmt(b.actual ?? b.value)})${b.reason ? `: ${b.reason}` : ''}`));
  lines.push('', 'profile.json has every number; trace-<scenario>.json opens at https://ui.perfetto.dev.');
  return `${lines.join('\n')}\n`;
}
const fmt = (value, digits = 2) => (value === null || value === undefined || !Number.isFinite(value) ? '–' : Number(value).toFixed(digits));

export async function profile(options) {
  const out = path.resolve(options.out ?? path.join(appRoot, 'artifacts', 'profile', new Date().toISOString().replace(/[:.]/g, '-')));
  if (existsSync(out)) throw Object.assign(new Error(`${out} exists: profiles go into a new folder.`), {exit: 2});
  const bytes = readFileSync(options.file);
  const input = {name: path.extname(options.file).toLowerCase() || '(no extension)', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
  const perRun = [], slowest = [], unusual = [];
  for (let run = 0; run < options.runs; run++) {
    const userData = options.userData && options.runs > 1 ? path.join(options.userData, `run${run + 1}`) : options.userData;
    // `require('electron')` from Node is the path of this checkout's Electron binary.
    const app = options.desktop ? await launchApp(require('electron'), userData, [appRoot, '--styk-developer']) : options.app ? await launchApp(path.resolve(options.app), userData) : await launchBrowser();
    try {
      await app.page.waitForFunction(() => window.styk?.ready && window.stykDevtools, null, {timeout: 120000});
      const documentName = await serveDocument(app.page, options.file);
      const tools = driver(app.page), results = {};
      for (const scenario of options.scenarios) {
        const result = await runScenario(scenario, app.page, tools, `document${path.extname(options.file)}`);
        results[scenario] = measures(scenario, result);
        if (result.dropped) unusual.push(`${scenario}, run ${run + 1}: ${result.dropped} events dropped (the ring filled)`);
        if (scenario === 'drag' && !results.drag.edit) unusual.push(`drag, run ${run + 1}: the press did not start a drag (no edit call): its numbers measure no edit`);
        if (run === 0) {
          if (!existsSync(out)) mkdirSync(out, {recursive: true});
          writeFileSync(path.join(out, `trace-${scenario}.json`), result.trace);
          for (const row of result.summary.slowest.slice(0, 5)) slowest.push({...row, scenario});
        }
      }
      if (run === 0) {
        const shot = await tools.request('screenshot');
        writeFileSync(path.join(out, 'stage.png'), Buffer.from(shot.png.split(',')[1], 'base64'));
        const errors = await tools.request('logs', {level: 'error', limit: 20});
        for (const row of errors.rows) unusual.push(`error logged [${row.module}]: ${row.message.split('\n')[0].slice(0, 200)}`);
      }
      perRun.push({run: run + 1, mode: app.mode, documentName, results});
    } finally { await app.close(); }
  }
  const keys = new Set(perRun.flatMap(run => Object.keys(flatten(run.results))));
  const medians = Object.fromEntries([...keys].sort().map(key => [key, median(perRun.map(run => flatten(run.results)[key]))]));
  slowest.sort((a, b) => b.ms - a.ms);
  const judged = options.budgets.map(budget => judge(budget, medians[budget.metric]));
  const mode = perRun[0]?.mode === 'app' ? 'developer desktop build' : 'browser (sources, developer early script)';
  const report = {version: 1, producer: 'styk-profile', at: new Date().toISOString(), mode, input, scenarios: options.scenarios, runs: options.runs,
    machine: {platform: process.platform, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memoryGB: Math.round(os.totalmem() / 2 ** 30)},
    medians, perRun, slowest: slowest.slice(0, 10), budgets: judged, unusual};
  writeFileSync(path.join(out, 'profile.json'), `${JSON.stringify(report, null, 1)}\n`);
  const summary = writeSummary({input, mode, runs: options.runs, medians, slowest: slowest.slice(0, 8), judged, unusual});
  writeFileSync(path.join(out, 'summary.txt'), summary);
  return {out, summary, failed: judged.some(budget => !budget.ok)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await profile(parseArguments(process.argv.slice(2)));
    process.stdout.write(result.summary);
    console.log(`Written to ${result.out}`);
    process.exit(result.failed ? 1 : 0);
  } catch (error) {
    console.error(error.exit === 2 ? error.message : error.stack ?? error);
    process.exit(2);
  }
}
