// The references for the docked window's catalogue screens (docs/native/screens/limits.toml, `dock*`): today's whole window at
// the screen's size, captured as engine/crates/xtask/fonts-chromium.mjs captures (Playwright's bundled Chromium, opaque surfaces,
// device scale 1) from today's app served with its engine module (`STYK_PORT=47931 node scripts/serve.mjs` in a checkout whose
// src/engine/pkg is built). The startup project is open, its figure selected (the Properties panel shows Blue as the
// `inspector-figure` screens do), Animate is the workspace and Home is dismissed. It prints the artboard's rectangle in each
// screen: the masks of limits.toml cover it, because the stage's picture is the stage chunk's.
//
//   node engine/crates/styk-app/automation/dock-reference/screens.mjs http://127.0.0.1:47931 [screen id...]
//
// The native screens are `stykanimate --screen dock|dock-1440|dock-folded[-dark]` (`styk_ui::dock`).
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

const SCREENS = [
  {id: 'dock', width: 1560, height: 1000}, {id: 'dock-dark', width: 1560, height: 1000},
  {id: 'dock-1440', width: 1440, height: 900}, {id: 'dock-1440-dark', width: 1440, height: 900},
  {id: 'dock-folded', width: 720, height: 800}, {id: 'dock-folded-dark', width: 720, height: 800},
];
const url = process.argv[2] ?? 'http://127.0.0.1:47931';
const root = path.resolve(import.meta.dirname, '../../../../..');
const out = path.join(root, 'docs/native/screens/dock');
await mkdir(out, {recursive: true});
const browser = await chromium.launch({args: ['--allow-file-access-from-files']});
const only = process.argv.slice(3);
for (const screen of SCREENS.filter(screen => !only.length || only.includes(screen.id))) {
  const theme = screen.id.endsWith('-dark') ? 'dark' : 'light';
  const context = await browser.newContext({viewport: {width: screen.width, height: screen.height}, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: theme});
  await context.addInitScript(settings => {
    localStorage.setItem('stykanimate.editor.settings.v1', JSON.stringify(settings));
    localStorage.setItem('stykanimate.theme.v1', settings.theme);
  }, {theme, timelineMode: 'advanced', locale: 'en', uiScale: 100});
  const page = await context.newPage();
  await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 120000});
  await page.waitForFunction(() => window.styk?.ready === true, null, {timeout: 120000});
  await page.waitForTimeout(1500);
  await page.getByText('Back to Untitled animation').click();
  await page.waitForTimeout(2500);
  const artboard = await page.evaluate(() => {
    const b = document.getElementById('artboard').getBoundingClientRect();
    return [b.x, b.y, b.width, b.height].map(Math.round);
  });
  await page.screenshot({path: path.join(out, `${screen.id}.png`), animations: 'disabled', caret: 'hide'});
  console.log(screen.id, 'artboard', JSON.stringify(artboard));
  await context.close();
}
await browser.close();
