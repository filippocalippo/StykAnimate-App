// The developer tools in a browser (docs/DEVTOOLS.md): the early script injected as the developer build injects it,
// the panels, the overlay and every control operation, on the app served from source.
//   node tests/devtools.browser.mjs            (serves the app itself; STYK_URL=<origin> to use a running server)
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from './support/playwright.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(appRoot, 'artifacts', 'devtools');
await mkdir(out, {recursive: true});
let host = null, url = process.env.STYK_URL;
if (!url) { const {startDesktopHost} = require('../desktop/web-host.cjs'); host = await startDesktopHost({appRoot, port: 0}); url = host.origin; }
const browser = await chromium.launch({channel: 'chrome', headless: true});
const errors = [];
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  page.on('pageerror', error => errors.push(error.stack));
  await page.addInitScript({path: path.join(appRoot, 'src', 'devtools', 'early.js')});
  await page.goto(url);
  await page.waitForFunction(() => window.styk?.ready && window.stykDevtools, null, {timeout: 60000});
  const request = (op, args = {}, detail) => page.evaluate(r => window.stykDevtools.request(r), {id: 1, op, args, detail});
  const ok = async (op, args, detail) => { const answer = await request(op, args, detail); assert.ok(answer.ok, `${op}: ${JSON.stringify(answer.error)}`); return answer.result; };

  const hello = await ok('hello');
  assert.equal(hello.version, 1);
  console.log('PASS hello', hello.ops.length, 'operations');
  const state = await ok('state');
  assert.ok(state.document.totalTicks > 0 && state.window.crossOriginIsolated, JSON.stringify(state.window));
  console.log('PASS state', JSON.stringify(state.document).slice(0, 160));
  const bad = await request('nope');
  assert.ok(!bad.ok && bad.error.what && bad.error.hint, 'unknown operations fail with what and hint');
  console.log('PASS structured error');

  await ok('trace.start', {label: 'browser'});
  for (let tick = 0; tick < Math.min(8, state.document.totalTicks); tick++) await ok('seek', {tick});
  // Startup prompts may cover the stage for a moment: press only where the stage takes the press.
  let target = await ok('target.handle', {kind: 'pose'});
  for (let attempt = 0; !target.onStage && attempt < 20; attempt++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); target = await ok('target.handle', {kind: 'pose'}); }
  assert.ok(target.onStage, `the handle is on the stage: ${JSON.stringify(target)}`);
  // A press on an unselected figure can land as a click; the figure is selected first, and a press that still did not
  // start a drag is tried once more (what the log of edit calls shows decides).
  await ok('select', {uid: target.uid});
  target = await ok('target.handle', {kind: 'pose'});
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = (await ok('doc.commands', {limit: 1})).rows[0]?.at ?? 0;
    await page.mouse.move(target.x, target.y); await page.mouse.down();
    for (let i = 1; i <= 30; i++) { await page.mouse.move(target.x + i * 2, target.y - i); await page.waitForTimeout(8); }
    await page.mouse.up();
    await ok('settle');
    const after = (await ok('doc.commands', {limit: 1})).rows[0]?.at ?? 0;
    if (after > before) break;
    console.log('retrying the drag: the press made no edit call');
  }
  await ok('settle');
  // The full summary: the short one keeps only the ten heaviest span groups, and edit calls are light.
  const stopped = await ok('trace.stop', {}, 'full');
  assert.ok(stopped.events > 0 && stopped.summary.spans.some(row => row.name === 'paint'), JSON.stringify(stopped.summary.spans.slice(0, 5)));
  assert.ok(stopped.summary.spans.some(row => row.name.startsWith('edit session call')), `the drag reaches the edit session: ${JSON.stringify(stopped.summary.spans.map(row => row.name))} ${JSON.stringify(target)}`);
  console.log('PASS capture', stopped.events, 'events,', stopped.summary.spans.slice(0, 4).map(row => row.name).join(', '));
  let text = '';
  for (let pageIndex = 0; pageIndex < stopped.pages; pageIndex++) text += (await ok('trace.read', {page: pageIndex})).text;
  const perfetto = JSON.parse(text);
  assert.ok(perfetto.traceEvents.some(event => event.ph === 'X' && event.name === 'paint'));
  await writeFile(path.join(out, 'browser-trace.json'), text);
  console.log('PASS perfetto', perfetto.traceEvents.length, 'trace events');

  const undo = await ok('undo');
  assert.ok(undo.revision >= 0);
  const metrics = await ok('metrics');
  assert.ok(metrics.jobs.engine && metrics.memory.engine, JSON.stringify(metrics).slice(0, 300));
  console.log('PASS metrics', JSON.stringify(metrics.jobs.engine));
  const params = await ok('params.list');
  assert.ok(params.rows.some(row => row.name === 'playback.lookaheadFrames'), params.rows.map(row => row.name).join());
  assert.equal((await ok('params.set', {name: 'playback.lookaheadFrames', value: 1000})).value, 240, 'values clamp to their range');
  await ok('params.reset');
  console.log('PASS parameters', params.rows.map(row => row.name).join(', '));
  const tree = await ok('doc.tree', {path: []});
  assert.ok(tree.rows.length > 0);
  const keyframes = await ok('doc.tree', {path: ['keyframes']});
  assert.ok(keyframes.size > 0);
  const frameRows = await ok('doc.frame');
  const history = await ok('doc.history');
  const commands = await ok('doc.commands');
  assert.ok(commands.rows.length > 0, 'the command log holds the drag');
  console.log('PASS inspector', tree.size, 'top-level keys,', keyframes.size, 'keyframes,', frameRows.size, 'figures,', history.size, 'history,', commands.rows.length, 'calls');
  const logs = await ok('logs', {module: 'devtools'});
  assert.ok(logs.rows.length > 0);
  await page.evaluate(() => console.warn('[probe] a filtered warning'));
  const warnings = await ok('logs', {level: 'warn', module: 'probe'});
  assert.equal(warnings.rows.length, 1);
  console.log('PASS logs');
  const commandList = await ok('command.list', {limit: 5});
  assert.ok(commandList.rows.length > 0);
  const threads = await ok('threads');
  assert.ok(threads.rows.some(row => row.name === 'styk-engine'), JSON.stringify(threads.rows.map(row => row.name)));
  console.log('PASS threads', threads.rows.length);
  const shot = await ok('screenshot');
  assert.ok(shot.png.startsWith('data:image/png'));
  await writeFile(path.join(out, 'stage.png'), Buffer.from(shot.png.split(',')[1], 'base64'));
  const recent = await ok('trace.recent', {ms: 10000});
  assert.ok(recent.spans.length > 0);

  // Panels and overlay, by their shortcuts.
  await page.keyboard.press('Control+Shift+O');
  await page.keyboard.press('Control+Shift+D');
  // A dock panel: placed in an island of the workspace, not a window over it.
  await page.waitForFunction(() => document.getElementById('styk-devtools')?.closest('.shell-island') && !document.getElementById('styk-devtools').hidden, null, {timeout: 5000});
  assert.ok(await page.evaluate(() => window.styk.shell.canPlace('developer')), 'the developer build defines the panel');
  await page.waitForTimeout(700);
  for (const tab of ['Profiler', 'Logs', 'Parameters', 'Inspector', 'Jobs']) {
    await page.locator('#styk-devtools header button', {hasText: tab}).click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#styk-devtools .dt-error').count(), 0, `${tab} renders without an error`);
    await page.screenshot({path: path.join(out, `panel-${tab.toLowerCase()}.png`)});
  }
  assert.ok(await page.locator('#styk-devtools-overlay').isVisible());
  console.log('PASS panels and overlay');
  // Closed from its own button, the dock takes it away and it stops refreshing.
  await page.locator('#styk-devtools .dt-close').click();
  await page.waitForFunction(() => document.getElementById('styk-devtools').hidden);
  assert.deepEqual(errors, []);

  // The shipping page (no early script) knows no developer panel, and a developer layout stored in it opens cleanly.
  const plain = await browser.newPage({viewport: {width: 1440, height: 900}});
  plain.on('pageerror', error => errors.push(error.stack));
  await plain.goto(url);
  await plain.waitForFunction(() => window.styk?.ready, null, {timeout: 60000});
  assert.equal(await plain.evaluate(() => window.styk.shell.canPlace('developer') || Boolean(globalThis.stykDevtools)), false, 'no developer panel without the developer build');
  assert.deepEqual(errors, []);
  await plain.close();
  console.log('PASS docked panel; none without the developer build');
  console.log('devtools browser checks passed');
} finally {
  await browser.close();
  await host?.stop();
}
