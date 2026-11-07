// Today's band in Chromium: one PNG per scenario, the band's rows only (tmp/band-ref/out/chromium/<id>.png).
import {chromium} from 'playwright';
import {serve} from './serve.mjs';
import {mkdir} from 'node:fs/promises';
import {SCENARIOS, HEIGHT} from './scenarios.mjs';

const only = process.argv.slice(2);
// Output goes to the ignored tmp/band-ref of the repository.
const OUT = new URL('../../../../../tmp/band-ref/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const out = OUT + 'out/chromium/';
await mkdir(out, {recursive: true});
const server = await serve();
const url = `http://127.0.0.1:${server.address().port}/engine/crates/styk-app/automation/band-reference/band.html`;
const browser = await chromium.launch({args: ['--allow-file-access-from-files']});
const context = await browser.newContext({viewport: {width: 1560, height: HEIGHT}, deviceScaleFactor: 1});
const page = await context.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto(url);
await page.waitForFunction(() => window.ready);
const folds = {};
for (const scenario of SCENARIOS) {
  if (only.length && !only.includes(scenario.id)) continue;
  await page.setViewportSize({width: scenario.width, height: HEIGHT});
  const result = await page.evaluate(a => window.setup(a), {...scenario, height: HEIGHT});
  await page.screenshot({path: `${out}${scenario.id}.png`, clip: {x: 0, y: 0, width: scenario.width, height: result.height}});
  folds[scenario.id] = result.steps;
  console.log(scenario.id, 'folds:', result.steps.join(',') || 'none', 'tier', result.tier);
}
(await import("node:fs")).writeFileSync(out + "folds.json", JSON.stringify(folds));
await browser.close();
server.close();
