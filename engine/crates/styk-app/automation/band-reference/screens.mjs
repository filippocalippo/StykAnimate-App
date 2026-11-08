// The references for the band's catalogue screens (docs/native/screens/limits.toml): today's real window rows at the
// screen's size, captured as engine/crates/xtask/fonts-chromium.mjs captures (bundled Chromium, LCD text on, opaque).
import {chromium} from 'playwright';
import {serve} from './serve.mjs';
import {mkdir} from 'node:fs/promises';
import {NAMES} from './scenarios.mjs';

const rest = {names: NAMES, dirty: [false, true, false], front: 1, session: ''};
const SCREENS = [
  {id: 'band', theme: 'light', width: 1560, height: 900, ...rest},
  {id: 'band-dark', theme: 'dark', width: 1560, height: 900, ...rest},
  {id: 'band-folded', theme: 'light', width: 720, height: 900, ...rest},
  {id: 'band-build', theme: 'light', width: 1000, height: 900, ...rest, session: 'build', workspace: 'rig'},
];
const out = new URL('../../../../../docs/native/screens/band/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
await mkdir(out, {recursive: true});
const server = await serve();
const url = `http://127.0.0.1:${server.address().port}/engine/crates/styk-app/automation/band-reference/band.html`;
const browser = await chromium.launch({args: ['--allow-file-access-from-files']});
const context = await browser.newContext({viewport: {width: 1560, height: 900}, deviceScaleFactor: 1});
const page = await context.newPage();
await page.goto(url);
await page.waitForFunction(() => window.ready);
for (const screen of SCREENS) {
  await page.setViewportSize({width: screen.width, height: screen.height});
  await page.evaluate(a => window.setup(a), screen);
  await page.screenshot({path: `${out}${screen.id}.png`, clip: {x: 0, y: 0, width: screen.width, height: screen.height}});
  console.log(screen.id, screen.width, screen.height);
}
await browser.close();
server.close();
