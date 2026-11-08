// The references for the stage's catalogue screens (docs/native/screens/limits.toml, `stage-*`): today's stage region
// (`#viewport`, the artboard and the scene canvas) showing the Properties screens' startup document at tick 0, fitted into a
// region of the screen's size, captured as engine/crates/xtask/fonts-chromium.mjs captures (Playwright's bundled Chromium,
// opaque surfaces, device scale 1), from today's app served with its engine module
// (`STYK_PORT=47931 node scripts/serve.mjs` in a checkout whose src/engine/pkg is built).
//
//   node engine/crates/styk-app/automation/stage-reference/screens.mjs http://127.0.0.1:47931 [screen id...]
//
// The native screen is `stykanimate --screen stage-fit` (`styk_core::screens::stage`).
import {chromium} from 'playwright';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';

const WIDTH = 900, HEIGHT = 560;
const SCREENS = [{id: 'stage-fit', theme: 'light'}, {id: 'stage-fit-dark', theme: 'dark'}];
const url = process.argv[2] ?? 'http://127.0.0.1:47931';
const root = path.resolve(import.meta.dirname, '../../../../..');
const out = path.join(root, 'docs/native/screens/stage');
await mkdir(out, {recursive: true});
const report = JSON.parse(await readFile(path.join(root, 'engine/tests/edit/startup.document.json'), 'utf8'));
const browser = await chromium.launch({args: ['--allow-file-access-from-files']});
const only = process.argv.slice(3);
for (const screen of SCREENS.filter(screen => !only.length || only.includes(screen.id))) {
  const context = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: screen.theme});
  await context.addInitScript(settings => {
    localStorage.setItem('stykanimate.editor.settings.v1', JSON.stringify(settings));
    localStorage.setItem('stykanimate.theme.v1', settings.theme);
  }, {theme: screen.theme, timelineMode: 'advanced', locale: 'en', uiScale: 100});
  const page = await context.newPage();
  await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 120000});
  await page.waitForFunction(() => window.styk?.ready === true, null, {timeout: 120000});
  await page.evaluate(async ({report, width, height}) => {
    const editor = window.styk.editor;
    editor.load(report, 'Reference');
    editor.markSaved();
    const viewport = document.getElementById('viewport');
    // Alone on the page and without what floats over it (handles, the camera outline, the rails): the stage region only.
    for (const child of viewport.children) if (child.id !== 'artboard' && child.id !== 'scene') child.style.display = 'none';
    document.body.appendChild(viewport);
    Object.assign(viewport.style, {position: 'fixed', left: '0', top: '0', zIndex: '999999', outline: 'none', flex: 'none', width: `${width}px`, height: `${height}px`});
    window.dispatchEvent(new Event('resize'));
    window.styk.fit();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, {report, width: WIDTH, height: HEIGHT});
  await page.waitForTimeout(1500);
  const box = await page.locator('#viewport').boundingBox();
  await page.screenshot({path: path.join(out, `${screen.id}.png`), clip: {x: box.x, y: box.y, width: WIDTH, height: HEIGHT}, animations: 'disabled', caret: 'hide'});
  console.log(screen.id, box);
  await context.close();
}
await browser.close();
