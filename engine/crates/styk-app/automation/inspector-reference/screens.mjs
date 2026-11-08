// The references for the Properties panel's catalogue screens (docs/native/screens/limits.toml, `inspector-*`): today's
// panel in each context and theme, captured as engine/crates/xtask/fonts-chromium.mjs captures (Playwright's bundled
// Chromium, LCD text on, opaque surfaces, device scale 1), from today's app served with its engine module
// (`node scripts/serve.mjs` in a checkout whose src/engine/pkg is built).
//
//   node engine/crates/styk-app/automation/inspector-reference/screens.mjs http://127.0.0.1:47831 [screen id...]
//
// It also writes engine/crates/styk-core/tests/support/today_bounds.rs, the selection's bounds of the figures screen's
// document, which the native tests compare with. (Numbers and plural forms come from today's runtime itself: intl.cjs.)
import {chromium} from 'playwright';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {SCREENS, document, enter} from './contexts.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:47831';
const root = path.resolve(import.meta.dirname, '../../../../..');
const out = path.join(root, 'docs/native/screens/inspector');
await mkdir(out, {recursive: true});
const browser = await chromium.launch({args: ['--allow-file-access-from-files']});
const fixture = async name => JSON.parse(await readFile(path.join(root, 'engine/tests/edit', `${name}.document.json`), 'utf8'));

async function open(theme) {
  const context = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: theme});
  await context.addInitScript(settings => {
    localStorage.setItem('stykanimate.editor.settings.v1', JSON.stringify(settings));
    localStorage.setItem('stykanimate.theme.v1', settings.theme);
  }, {theme, timelineMode: 'advanced', locale: 'en', uiScale: 100});
  const page = await context.newPage();
  await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 120000});
  await page.waitForFunction(() => window.styk?.ready === true, null, {timeout: 120000});
  return {context, page};
}

const only = process.argv.slice(3);
for (const screen of SCREENS.filter(screen => !only.length || only.includes(screen.id))) {
  const {context, page} = await open(screen.theme);
  await page.evaluate(async ({report, screen}) => {
    const editor = window.styk.editor;
    editor.load(report, 'Reference');
    editor.markSaved();
    if (screen.many) editor.selectMany(screen.many); else editor.select(...screen.select);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await document.fonts.ready;
    for (const element of document.querySelectorAll('*')) element.style.caretColor = 'transparent';
  }, {report: document(await fixture(screen.fixture), screen), screen});
  if (screen.enter) {
    await page.evaluate(enter, screen.enter);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await page.waitForTimeout(500);
  const panel = page.locator('.shell-panel:has([data-slot=inspector-target])').first();
  const box = await panel.boundingBox();
  await page.screenshot({path: path.join(out, `${screen.id}.png`), clip: {x: box.x, y: box.y, width: screen.width, height: screen.height}, animations: 'disabled', caret: 'hide'});
  console.log(screen.id, screen.width, screen.height);
  if (screen.id === 'inspector-figures') {
    const bounds = await page.evaluate(() => {
      const editor = window.styk.editor, b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const geometry of editor.geometry.objects.values()) {
        if (!geometry || !editor.selectedUids.has(geometry.obj.unique_id)) continue;
        const one = window.styk.boundsOf(geometry);
        b[0] = Math.min(b[0], one.minX); b[1] = Math.min(b[1], one.minY); b[2] = Math.max(b[2], one.maxX); b[3] = Math.max(b[3], one.maxY);
      }
      return b;
    });
    await writeFile(path.join(root, 'engine/crates/styk-core/tests/support/today_bounds.rs'),
      `// Today's app, headless Chromium (\`window.styk.boundsOf\` over the selected figures' geometry), on\n` +
      `// \`property-sheet.document.json\` with figures 1, 2 and 3 selected at tick 0: \`[minX, minY, maxX, maxY]\`.\n` +
      `// Written by engine/crates/styk-app/automation/inspector-reference/screens.mjs.\n` +
      `const TODAY_BOUNDS: [f64; 4] = [${bounds.map(v => Number.isInteger(v) ? `${v}.0` : String(v)).join(', ')}];\n`);
  }
  await context.close();
}

await browser.close();
