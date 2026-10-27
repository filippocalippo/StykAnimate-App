// Project tabs on real projects (docs/PROJECT-TABS.md): what switching costs and what a resting project holds.
//   STYK_URL=<dev server> node tests/project-tabs-switch.benchmark.mjs <a.piv> <b.piv> [rounds]
// Reports, per switch: the time until the project in front is editable (its scene drawn), until playback is
// prepared around the playhead, the longest main-thread task, and the JS heap with one and two projects open.
import {chromium} from './support/playwright.mjs';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';

const [first, second] = process.argv.slice(2, 4), rounds = Number(process.argv[4] ?? 6);
if (!first || !second) throw new Error('Name two project files.');
const url = process.env.STYK_URL || 'http://127.0.0.1:47831', out = path.resolve('artifacts/project-tabs');
await mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-precise-memory-info', '--js-flags=--expose-gc']});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.goto(url); await page.waitForFunction(() => window.styk?.ready, null, {timeout: 120000});
await page.evaluate(() => {
  window.__tasks = [];
  new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__tasks.push(entry.duration); }).observe({type: 'longtask'});
});
const heap = () => page.evaluate(async () => { globalThis.gc?.(); await new Promise(resolve => setTimeout(resolve, 300)); globalThis.gc?.(); return performance.memory.usedJSHeapSize; });
const open = async file => {
  const bytes = await readFile(file), name = path.basename(file);
  await page.evaluate(async ({data, name}) => {
    const file = new File([new Uint8Array(data)], name);
    if (await styk.importFiles([file]) === false) throw new Error(`${name} did not open`);
  }, {data: [...bytes], name});
  await settled();
};
// Editable: the scene of the playhead is drawn. Prepared: playback has the frames around the playhead.
const settled = () => page.waitForFunction(() => !styk.state.dirtyRender && !styk.state.importing, null, {timeout: 180000});
const prepared = () => page.waitForFunction(() => { const s = styk.performance().playback; return s.pendingFrames === 0 && s.preparedFrames > 0; }, null, {timeout: 180000}).catch(() => null);

const empty = await heap();
await open(first);
const one = await heap();
await open(second);
await prepared();
const two = await heap();
const switches = [];
for (let round = 0; round < rounds; round++) {
  await page.waitForTimeout(1500);
  const target = await page.evaluate(() => styk.projects.tabs.successor().id);
  await page.evaluate(() => { window.__tasks.length = 0; });
  const started = Date.now();
  await page.evaluate(id => { window.__switch = styk.projects.activate(id); }, target);
  await page.evaluate(() => window.__switch);
  const activated = Date.now();
  await settled();
  const editable = Date.now();
  await prepared();
  const ready = Date.now();
  const tasks = await page.evaluate(() => window.__tasks.slice());
  switches.push({to: await page.evaluate(() => styk.editor.name), activateMs: activated - started, editableMs: editable - started, playbackMs: ready - started,
    longestTaskMs: Math.round(Math.max(0, ...tasks)), longTasks: tasks.length});
}
// What the second project costs while it rests: the first in front, as when it was alone, the second resting.
const firstId = await page.evaluate(name => styk.projects.tabs.items.find(item => item.name === name).id, path.basename(first).replace(/\.[^.]+$/, ''));
await page.evaluate(id => styk.projects.activate(id), firstId); await settled(); await prepared();
const resting = await heap();
const mib = bytes => +(bytes / 1048576).toFixed(1);
const report = {first: path.basename(first), second: path.basename(second),
  heapMiB: {empty: mib(empty), firstAlone: mib(one), secondInFront: mib(two), firstInFrontSecondResting: mib(resting), restingCost: mib(resting - one)},
  switches, errors, at: new Date().toISOString()};
console.log(JSON.stringify(report, null, 2));
await writeFile(path.join(out, 'switch-benchmark.json'), JSON.stringify(report, null, 2));
await browser.close();
